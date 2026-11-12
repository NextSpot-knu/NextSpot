"""내부 지역(서울) API — developer 계정 전용.

`docs/SEOUL_TESTBED_PLAN.md` S3. 서울 시설·구역·지역 경계는 이 라우터로만 나간다:
  · 브라우저 역할은 DB 에서 서울 행을 읽을 수 없다(RESTRICTIVE 정책 `facilities_public_region_only`).
  · 정적 웹 번들에는 서울 이름·좌표가 없다 — 웹은 내부 계정일 때만 여기서 받아 간다.

공통 규칙
  · 가드 `require_internal_region_viewer` — JWT 없음 401, developer 가 아니면 403(관리자·심사 계정 포함).
  · 응답 `Cache-Control: private, no-store` — 공유 캐시·브라우저 디스크에 남기지 않는다.
  · 접근마다 `internal_region_access` 로그(user_id·경로).
  · `{region}` 이 내부 지역이 아니면 404(경주는 공개 경로 /infrastructures 를 쓴다).
  · 서울 혼잡은 `congestion_logs` 를 읽지 않는다 — 구역 관측(zone_crowd_snapshots)만 쓴다.

응답 모양은 **고정**이다(tests/routers/test_internal_region_shapes.py 가 칸 이름을 잠근다 — 웹이 같은 이름을 쓴다).
"""

from __future__ import annotations

import asyncio
import math
import time
from datetime import datetime, timezone
from typing import Any, Literal, Mapping

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from app.core.region import (
    INTERNAL_REGIONS,
    REGION_SEOUL,
    facility_region,
    normalize_region,
    require_internal_region_viewer,
)
from app.core.supabase import supabase_admin
from app.routers.infrastructures import (
    CongestionInfo,
    InfrastructureItem,
    _infrastructure_item,
    fetch_active_facilities,
)
from app.services.crowd import zone_evidence
from app.services.crowd.seoul_provider import SEOUL_ZONES

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/internal", tags=["internal-regions"])

_CACHE_CONTROL = "private, no-store"
# 지역 시설 목록 캐시(지역별 60초). 지도 이동마다 전량을 다시 읽지 않는다.
_FACILITY_TTL_SECONDS = 60.0
# 지역 경계 = 구역 둘레 + 이만큼의 여유(m).
_BOUNDS_BUFFER_M = 300.0
_METERS_PER_DEG_LAT = 111_320.0

LevelBand = Literal["relaxed", "normal", "slightly_busy", "busy"]
UsualComparison = Literal["busier", "usual", "quieter"]


# ── 응답 모델(고정) ────────────────────────────────────────────────────────────


class RegionNames(BaseModel):
    ko: str
    en: str
    ja: str
    zh: str


class LatLng(BaseModel):
    lat: float
    lng: float


class RegionBounds(BaseModel):
    min_lat: float
    max_lat: float
    min_lng: float
    max_lng: float


class RegionPreset(BaseModel):
    id: str
    name: str
    lat: float
    lng: float


class InternalRegionView(BaseModel):
    id: str
    names: RegionNames
    center: LatLng
    bounds: RegionBounds
    presets: list[RegionPreset]
    address_token: str
    facility_count: int
    mapped_facility_count: int
    zone_count: int
    latest_observed_at: str | None


class InternalRegionsResponse(BaseModel):
    regions: list[InternalRegionView]


class ZoneForecastPoint(BaseModel):
    target_at: str
    level: float | None
    level_band: str | None


class ZoneCrowdView(BaseModel):
    zone_id: str
    zone_name: str
    cluster: str
    level: float | None
    level_band: LevelBand | None
    observed_at: str | None
    is_current: bool
    usual_comparison: UsualComparison | None
    forecast: list[ZoneForecastPoint]


class InternalZoneView(ZoneCrowdView):
    centroid: LatLng
    radius_m: float


class InternalZonesResponse(BaseModel):
    region: str
    zones: list[InternalZoneView]


class InternalZoneCongestion(CongestionInfo):
    """구역 관측으로 만든 혼잡 칸 — 공개 CongestionInfo 와 같은 칸 + 근거 등급(zone_measured).

    ``level`` 은 None 일 수 있다 — 매핑된 구역 일부에 관측이 없는 시설(엔진 근거와 같은 규칙). 이때 화면은 단계 없이
    ``timestamp`` 로 '마지막 관측' 만 그린다.
    """

    level: float | None  # type: ignore[assignment]
    evidence_tier: str | None = None


class InternalRegionInfrastructureItem(InfrastructureItem):
    """공개 지도 항목과 같은 칸 + 시설이 속한 구역의 혼잡(`zone`)."""

    congestion: InternalZoneCongestion | None
    zone: ZoneCrowdView | None = None


class InternalRegionInfrastructuresResponse(BaseModel):
    region: str
    generated_at: str
    items: list[InternalRegionInfrastructureItem]


# ── 지역 요약(서버에서 만든다 — 번들에 싣지 않는다) ─────────────────────────────


_REGION_NAMES: Mapping[str, RegionNames] = {
    REGION_SEOUL: RegionNames(ko="서울", en="Seoul", ja="ソウル", zh="首尔"),
}
_ADDRESS_TOKENS: Mapping[str, str] = {REGION_SEOUL: "서울"}
# 지도 첫 중심 — 인사동(POI078).
_CENTER_ZONE_ID: Mapping[str, str] = {REGION_SEOUL: "seoul:POI078"}


def _static_zones(region: str):
    if region == REGION_SEOUL:
        return SEOUL_ZONES
    return ()


def _bounds_for(zones) -> RegionBounds:
    lats: list[float] = []
    lngs: list[float] = []
    for zone in zones:
        reach = float(zone.radius_m or 0) + _BOUNDS_BUFFER_M
        d_lat = reach / _METERS_PER_DEG_LAT
        d_lng = reach / (_METERS_PER_DEG_LAT * math.cos(math.radians(zone.centroid_lat)))
        lats += [zone.centroid_lat - d_lat, zone.centroid_lat + d_lat]
        lngs += [zone.centroid_lng - d_lng, zone.centroid_lng + d_lng]
    return RegionBounds(
        min_lat=round(min(lats), 6), max_lat=round(max(lats), 6),
        min_lng=round(min(lngs), 6), max_lng=round(max(lngs), 6),
    )


def region_pack_geometry(region: str) -> dict[str, Any]:
    """지역의 중심·경계·바로가기(구역 중심) — 정적 구역 정의(SEOUL_ZONES = 마이그레이션 시드)에서."""
    zones = _static_zones(region)
    center_zone = next((z for z in zones if z.zone_id == _CENTER_ZONE_ID.get(region)), zones[0])
    return {
        "names": _REGION_NAMES[region],
        "center": LatLng(lat=center_zone.centroid_lat, lng=center_zone.centroid_lng),
        "bounds": _bounds_for(zones),
        "presets": [
            RegionPreset(id=z.zone_id, name=z.name, lat=z.centroid_lat, lng=z.centroid_lng) for z in zones
        ],
        "address_token": _ADDRESS_TOKENS[region],
    }


# ── 시설 목록(지역별 60초 캐시) ────────────────────────────────────────────────

_facility_cache: dict[str, tuple[float, list[dict]]] = {}
_facility_locks: dict[str, asyncio.Lock] = {}


def reset_cache_for_tests() -> None:
    _facility_cache.clear()
    _facility_locks.clear()


async def region_facilities(region: str) -> list[dict]:
    """지역의 활성 시설 전량(비활성·숨김 제외 — fetch_active_facilities 의 is_active 필터).

    읽기는 **쿼리 안에서** region 을 건다. 캐시된 행은 바꾸지 않는다(호출부는 복사해서 쓴다).
    """
    hit = _facility_cache.get(region)
    if hit is not None and time.monotonic() - hit[0] < _FACILITY_TTL_SECONDS:
        return hit[1]
    lock = _facility_locks.setdefault(region, asyncio.Lock())
    async with lock:
        hit = _facility_cache.get(region)
        if hit is not None and time.monotonic() - hit[0] < _FACILITY_TTL_SECONDS:
            return hit[1]
        rows = await fetch_active_facilities(supabase_admin, "*", region=region)
        # 두 번째 겹 — 쿼리가 거른 결과에서도 다른 지역 행(키 없음 포함)은 버린다.
        rows = [row for row in rows if facility_region(row) == region]
        _facility_cache[region] = (time.monotonic(), rows)
        return rows


# ── 공통 ───────────────────────────────────────────────────────────────────────


def _internal_region_or_404(region: str) -> str:
    normalized = normalize_region(region)
    if normalized not in INTERNAL_REGIONS:
        raise HTTPException(status_code=404, detail="지역을 찾을 수 없습니다.")
    return normalized


def _private(response: Response, request: Request, profile: Mapping[str, Any]) -> None:
    response.headers["Cache-Control"] = _CACHE_CONTROL
    logger.info("internal_region_access", user_id=profile.get("id"), path=request.url.path)


def zone_crowd_view(reading: zone_evidence.ZoneReading, *, wall_now: datetime) -> ZoneCrowdView:
    return ZoneCrowdView(**_zone_view_fields(reading, wall_now=wall_now))


def _zone_view_fields(reading: zone_evidence.ZoneReading, *, wall_now: datetime) -> dict[str, Any]:
    return {
        "zone_id": reading.zone_id,
        "zone_name": reading.zone_name,
        "cluster": reading.cluster or "",
        "level": reading.level,
        "level_band": reading.level_band,
        "observed_at": zone_evidence.iso(reading.observed_at),
        "is_current": zone_evidence.zone_reading_is_current(reading.observed_at, wall_now=wall_now),
        "usual_comparison": reading.usual_comparison,
        "forecast": [
            ZoneForecastPoint(target_at=zone_evidence.iso(target), level=level, level_band=band)
            for target, level, band in reading.forecast
        ],
    }


def _zone_congestion(
    readings: tuple[zone_evidence.ZoneReading, ...], *, wall_now: datetime
) -> InternalZoneCongestion | None:
    """시설의 구역 관측 **전부** → 혼잡 칸. 근거 dict(엔진과 같은 규칙)를 그대로 따른다.

    매핑된 구역 일부에 관측이 없으면(``facility_zones_partial``) level 은 None 이다 — 관측된 조용한 구역 하나로
    시설 단계를 말하지 않는다. 관측 시각(timestamp)은 남긴다(카드는 '마지막 관측' 만 그린다).
    """
    evidence = zone_evidence.zone_evidence_dict(readings, wall_now=wall_now)
    if evidence["source"] == "none":
        return None
    return InternalZoneCongestion(
        level=evidence["level"],
        current_count=None,
        timestamp=evidence["timestamp"],
        source=evidence["log_source"],
        is_stale=bool(evidence["is_stale"]),
        is_current=bool(evidence["is_current"]),
        evidence_tier=zone_evidence.ZONE_EVIDENCE_TIER,
    )


def _in_box(row: Mapping[str, Any], type_, min_lat, max_lat, min_lng, max_lng) -> bool:
    if type_ and row.get("type") != type_:
        return False
    try:
        lat, lng = float(row.get("latitude")), float(row.get("longitude"))
    except (TypeError, ValueError):
        return False
    if min_lat is not None and lat < min_lat:
        return False
    if max_lat is not None and lat > max_lat:
        return False
    if min_lng is not None and lng < min_lng:
        return False
    if max_lng is not None and lng > max_lng:
        return False
    return True


# ── 라우트 ─────────────────────────────────────────────────────────────────────


@router.get("/regions", response_model=InternalRegionsResponse)
async def list_internal_regions(
    request: Request,
    response: Response,
    profile: dict = Depends(require_internal_region_viewer),
):
    _private(response, request, profile)
    regions: list[InternalRegionView] = []
    for region in sorted(INTERNAL_REGIONS):
        try:
            facilities = await region_facilities(region)
        except Exception as exc:  # noqa: BLE001 — 요약 숫자만 0 으로 둔다(지역 자체는 보여 준다)
            logger.warning("internal_region_facilities_unavailable", region=region, error_type=type(exc).__name__)
            facilities = []
        ids = [str(row["id"]) for row in facilities if row.get("id")]
        mapped, states = await asyncio.gather(
            zone_evidence.load_facility_zone_ids(ids, region=region),
            zone_evidence.load_zone_states(region),
        )
        observed = [s.reading.observed_at for s in states if s.reading is not None]
        regions.append(
            InternalRegionView(
                id=region,
                **region_pack_geometry(region),
                facility_count=len(ids),
                mapped_facility_count=len(mapped),
                zone_count=len(states),
                latest_observed_at=zone_evidence.iso(max(observed)) if observed else None,
            )
        )
    return InternalRegionsResponse(regions=regions)


@router.get("/regions/{region}/infrastructures", response_model=InternalRegionInfrastructuresResponse)
async def get_internal_region_infrastructures(
    region: str,
    request: Request,
    response: Response,
    type: str | None = None,
    min_lat: float | None = None,
    max_lat: float | None = None,
    min_lng: float | None = None,
    max_lng: float | None = None,
    profile: dict = Depends(require_internal_region_viewer),
):
    _private(response, request, profile)
    region = _internal_region_or_404(region)
    try:
        facilities = await region_facilities(region)
    except Exception as exc:  # noqa: BLE001
        logger.error("internal_region_infrastructures_failed", region=region, error_type=type_name(exc))
        raise HTTPException(status_code=500, detail="시설 데이터 조회에 실패했습니다.")
    selected = [f for f in facilities if _in_box(f, type, min_lat, max_lat, min_lng, max_lng)]
    wall_now = datetime.now(timezone.utc)
    readings = await zone_evidence.load_zone_readings(
        [f["id"] for f in selected], region=region, wall_now=wall_now
    )
    items: list[InternalRegionInfrastructureItem] = []
    for facility in selected:
        facility_readings = readings.get(str(facility["id"]), ())
        chosen = zone_evidence.choose_zone_reading(facility_readings, wall_now=wall_now)
        base = _infrastructure_item(facility, None, None).model_dump()
        # is_current 는 근거 dict 가 이미 facility_zones_current(매핑 구역 전부 '지금')로 정한다.
        base["congestion"] = _zone_congestion(facility_readings, wall_now=wall_now) if chosen else None
        base["zone"] = zone_crowd_view(chosen, wall_now=wall_now) if chosen else None
        if chosen and not zone_evidence.facility_zones_current(facility_readings, wall_now=wall_now):
            # 매핑된 구역 일부가 비었거나 30분을 넘겼다 — '지금' 구역 하나로 이 시설의 '지금' 을 말하지 않는다(엔진과 같은 규칙).
            base["zone"] = base["zone"].model_copy(update={"is_current": False})
        if chosen and zone_evidence.facility_zones_partial(facility_readings):
            # 매핑된 구역 일부에 관측이 없다 — 관측된 구역 하나의 단계·평소 대비·예보로 시설을 말하지 않는다.
            # 구역 이름과 관측 시각은 남긴다(카드는 '마지막 관측' 만 그린다).
            base["zone"] = base["zone"].model_copy(
                update={"level": None, "level_band": None, "usual_comparison": None, "forecast": []}
            )
        items.append(InternalRegionInfrastructureItem(**base))
    return InternalRegionInfrastructuresResponse(
        region=region, generated_at=wall_now.isoformat(), items=items
    )


@router.get("/regions/{region}/zones", response_model=InternalZonesResponse)
async def get_internal_region_zones(
    region: str,
    request: Request,
    response: Response,
    profile: dict = Depends(require_internal_region_viewer),
):
    _private(response, request, profile)
    region = _internal_region_or_404(region)
    wall_now = datetime.now(timezone.utc)
    states = await zone_evidence.load_zone_states(region, wall_now=wall_now)
    zones: list[InternalZoneView] = []
    for state in states:
        zone = state.zone
        if state.reading is not None:
            fields = _zone_view_fields(state.reading, wall_now=wall_now)
        else:
            fields = {
                "zone_id": zone.zone_id, "zone_name": zone.name, "cluster": zone.cluster or "",
                "level": None, "level_band": None, "observed_at": None, "is_current": False,
                "usual_comparison": None, "forecast": [],
            }
        zones.append(
            InternalZoneView(
                **fields,
                centroid=LatLng(lat=zone.centroid_lat, lng=zone.centroid_lng),
                radius_m=float(zone.radius_m or 0.0),
            )
        )
    return InternalZonesResponse(region=region, zones=zones)


def type_name(exc: BaseException) -> str:
    return type(exc).__name__
