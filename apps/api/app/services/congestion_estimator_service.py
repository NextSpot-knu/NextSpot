"""경주 **추정 모드** — 주차 실측 + 관광 통계로 시설별 혼잡을 추정한다. 실측이 아니다.

## 무엇을 하는가

`docs/CONGESTION_ENGINE_PLAN.md` §5.1·§5.2 의 공통 추정기다. 한 산식을 두 지역이 쓴다:

    parking(z, t) = 격자 z 중심 반경 2km 공영주차 가중 점유율     (parking_derived 와 같은 식)
    tourism(f, d) = 시설 f 의 관광공사 집중률 지역 기준선 / 100    (SPOT 이 이미 붙이는 값)
    level(f, t)   = 0.7 · parking + 0.3 · tourism                   (area_demand_service 와 같은 가중치)

주차 성분이 없으면 **값을 만들지 않는다** — 관광 통계만으로는 하루 한 숫자라 '지금' 을 말할
수 없고, 주차장 반경 밖 847곳에 값을 지어내면 이 모드가 피하려던 것이 된다(§5.2 '값 없음').

## 왜 congestion_logs 에 적재하지 않고 **읽을 때 계산**하는가

원본(`area_demand_snapshots`)이 이미 10분마다 적재되고 있고 30일치 이력이 있다. 추정치는
그 원본의 **결정적 함수**다 — 같은 스냅샷에서 언제 계산해도 같은 값이 나온다. 그러니 따로
쌓을 이유가 없고, 쌓으면 잃는 것만 있다:

  · 10분마다 추정 대상 약 800곳 → 하루 11만 행. 대시보드 집계 상한(12,000행)을 한 시간
    반 만에 넘고, 무료 DB 용량을 몇 주 안에 채운다.
  · `congestion_logs` 의 다수가 추정치가 되면 실측과 섞인다. 되돌리려면 행을 다시 세야 한다.
  · 쌓기 시작한 날부터만 이력이 생긴다. 읽을 때 계산하면 **원본 이력 전체가 곧 추정 이력**이다.

그래서 추정치는 학습 데이터에도(`congestion_logs` 에 없으니) 실측 배지에도 들어가지 않는다.
화면은 이 값을 반드시 '추정' 라벨과 함께 그린다.

## 서울 실측 보정 f (2026-09-20 추가 — §5.3-5·6, 결정 D5)

주차는 임시 방편이다(경주에는 실시간 유동인구를 살 방법이 없다). 서울 명동·동대문에는 주차 신호와
**통신사 기반 실측 인파**가 같이 있어서, "주차가 이만큼 찼을 때 실제 인파는 이만큼이었다" 를 배울 수
있다. 그 단조 곡선을 `congestion_calibration_service` 가 적합하고, 여기서 혼합값 위에 한 번 얹는다:

    level = f(0.7 · parking + 0.3 · tourism)

f 는 **관문(3일 · 300버킷 · 홀드아웃 MAE 개선)을 통과하기 전에는 항등**이다. 즉 서울 수집이 시작되기
전인 오늘은 값이 하나도 바뀌지 않는다. 원값(`raw_level`)은 절대 버리지 않고 보정 여부·근거 문자열과
함께 응답에 실어, 화면이 "무엇이 보정된 값인지" 를 말할 수 있게 한다.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog

from app.core.supabase import fetch_all_rows, supabase_admin
from app.services import congestion_calibration_service as calibration
from app.services.area_demand_service import _PARKING_WEIGHT, _TOURISM_WEIGHT
from app.services.parking_derived_congestion_service import (
    MAX_SNAPSHOT_AGE,
    RADIUS_M,
    SNAPSHOT_SOURCE,
    ParkingLot,
    cell_demand_level,
    grid_cell,
    grid_center,
)
from app.services.tourism_area_prior_service import attach_tourism_area_priors
from app.services.tourism_name_matching import match_tourism_forecasts_to_facilities

logger = structlog.get_logger()

# 화면·API 가 이 값을 가리킬 때 쓰는 이름. congestion_logs.source 가 아니다(적재하지 않는다).
ESTIMATE_SOURCE = "estimated"

# 가중치는 새로 정하지 않는다 — SPOT 의 주변 수요 신호(area_demand_service)와 같은 값이다.
# 서울 검증(§5.3)이 다른 값을 권하면 **거기서** 바꾸고 여기는 따라간다.
PARKING_WEIGHT = _PARKING_WEIGHT
TOURISM_WEIGHT = _TOURISM_WEIGHT

# 대시보드 '이상 혼잡' 선. 관리자 화면의 기존 기준(admin._aggregate_congestion_day)과 같다.
ANOMALY_LEVEL = 0.9

# 하루를 집계로 인정하는 최소 표본(대표 장소 × 10분 버킷). 실측 집계와 같은 기준.
MIN_DAY_SAMPLES = 5

# 히트맵에 올리는 대표 장소 상한. 화면 세로 공간이 정한 값이다.
HEATMAP_PLACE_CAP = 12

_KST = timezone(timedelta(hours=9))
_CURRENT_TTL_SECONDS = 300.0
# 추정을 못 만든 결과는 짧게만 캐시한다. 5분을 들고 있으면 DB 순단 한 번이 지도·추천에서
# 추정을 5분 동안 지운다. 반대로 0 이면 장애 동안 요청마다 전체 계산을 다시 두드린다.
_CURRENT_FAILURE_TTL_SECONDS = 60.0
_FACILITY_TTL_SECONDS = 600.0
_SNAPSHOT_ID_BATCH = 200


@dataclass(frozen=True)
class Snapshot:
    """10분 버킷 하나의 주차 원본."""

    snapshot_id: str
    bucket_at: datetime
    observed_at: datetime
    lots: tuple[ParkingLot, ...]


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _aware(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


# ── 순수 함수 ────────────────────────────────────────────────────────────────


def blend_level(parking_level: float | None, tourism_level: float | None) -> float | None:
    """§5.1 산식. 주차 성분이 없으면 ``None`` — 관광 통계만으로 '지금' 을 만들지 않는다."""
    if parking_level is None:
        return None
    if tourism_level is None:
        return round(_clamp(parking_level), 4)
    return round(_clamp(PARKING_WEIGHT * parking_level + TOURISM_WEIGHT * tourism_level), 4)


def facility_tourism_level(facility: dict[str, Any]) -> float | None:
    """`attach_tourism_area_priors` 가 붙인 지역 기준선(0~100)을 0~1 로."""
    try:
        return _clamp(float(facility["tourapi_concentration_rate"]) / 100.0)
    except (KeyError, TypeError, ValueError):
        return None


def estimate_facilities(
    lots: list[ParkingLot] | tuple[ParkingLot, ...],
    facilities: list[dict[str, Any]],
    *,
    radius_m: float = RADIUS_M,
    calibration_state: calibration.CalibrationState | None = None,
) -> dict[str, dict[str, Any]]:
    """스냅샷 하나 → {facility_id: 추정}. 주차 반경 밖 시설은 **키 자체가 없다.**

    주차 성분은 격자 중심에서 잰다(parking_derived 와 같은 이유 — 원본 4곳에 없는 해상도를
    주장하지 않는다). 관광 성분은 시설별 기준선이라 같은 격자 안에서도 조금 다를 수 있다.

    ``calibration_state`` 가 없거나 관문을 못 넘었으면 f 는 항등이다 — 그때 ``level`` 과
    ``raw_level`` 은 같은 값이고 ``calibrated`` 는 False 다. 원값은 어느 경우에도 버리지 않는다.
    f 는 혼합값이 아니라 **주차 성분**에 적용한다(아래 주석 — 서울에서 배운 관계가 그것이다).
    """
    lots = list(lots)
    applied = bool(calibration_state is not None and calibration_state.applied)
    cells: dict[tuple[int, int], dict[str, Any] | None] = {}
    out: dict[str, dict[str, Any]] = {}
    for facility in facilities:
        facility_id = str(facility.get("id") or "").strip()
        try:
            latitude = float(facility["latitude"])
            longitude = float(facility["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        if not facility_id:
            continue
        cell = grid_cell(latitude, longitude)
        if cell not in cells:
            center_lat, center_lng = grid_center(cell)
            cells[cell] = cell_demand_level(lots, center_lat, center_lng, radius_m=radius_m)
        demand = cells[cell]
        if demand is None:
            continue
        tourism = facility_tourism_level(facility)
        raw_level = blend_level(demand["level"], tourism)
        if raw_level is None:
            continue
        # 보정 곡선은 **주차 성분에만** 얹는다.
        #
        # 곡선이 서울에서 배운 관계는 "주차 점유율 → 실제 인파" 하나다(서울 대상지에는 관광
        # 집중률 앵커가 없어 `tourism_level` 이 비어 있고, 서울의 level_est 는 주차 단독이다 —
        # 2026-09-20 첫 수집으로 확인). 그 곡선을 관광 성분이 섞인 혼합값에 통째로 적용하면
        # **배운 적 없는 입력**에 곡선을 쓰는 것이 되고, 경주에서만 0.3 만큼 계통 오차가 생긴다.
        # 그래서 f 를 주차에 적용한 뒤 같은 가중치로 다시 섞는다 — 서울에서 관광 성분까지
        # 붙게 되면(대상지에 앵커가 생기면) 그때 적합 입력을 혼합값으로 올리고 여기도 되돌린다.
        calibrated_level = blend_level(calibration_state.apply(demand["level"]), tourism) if applied else raw_level
        level = calibrated_level if calibrated_level is not None else raw_level
        out[facility_id] = {
            "level": level,
            "raw_level": raw_level,
            "calibrated": applied,
            "parking_level": demand["level"],
            "tourism_level": round(tourism, 4) if tourism is not None else None,
            "zone": f"{cell[0]}:{cell[1]}",
            "lot_count": demand["lot_count"],
            "nearest_lot_m": demand["nearest_lot_m"],
        }
    return out


def representative_places(
    facilities: list[dict[str, Any]], forecasts: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """히트맵·이상 알림의 행이 될 **대표 장소** — 관광공사 통계와 이름이 1:1 로 맞은 관광지.

    왜 전 시설이 아닌가: 추정 대상 800곳 × 24시간을 그리면 같은 격자의 시설 수십 곳이 같은
    줄을 반복한다(주차 성분이 격자 단위다). 운영자가 알아보는 이름(첨성대·대릉원·월정교…)이
    실제로 구분되는 단위이고, 그 장소들은 관광 성분도 자기 값(거리 0)을 쓴다.
    """
    places: list[dict[str, Any]] = []
    for match in match_tourism_forecasts_to_facilities(facilities, forecasts):
        try:
            rate = float(match.forecast["concentration_rate"])
        except (KeyError, TypeError, ValueError):
            rate = 0.0
        places.append({**match.facility, "_rate": rate})
    places.sort(key=lambda place: (-place["_rate"], str(place.get("name") or "")))
    return places


def _hourly_heatmap(
    places: list[dict[str, Any]], per_snapshot: list[tuple[Snapshot, dict[str, dict[str, Any]]]]
) -> list[dict[str, Any]]:
    cells: dict[tuple[str, int], list[float]] = {}
    for snapshot, estimates in per_snapshot:
        hour = snapshot.bucket_at.astimezone(_KST).hour
        for place in places:
            estimate = estimates.get(str(place["id"]))
            if estimate is not None:
                cells.setdefault((str(place["id"]), hour), []).append(estimate["level"])
    heatmap: list[dict[str, Any]] = []
    for place in places:
        for hour in range(24):
            values = cells.get((str(place["id"]), hour))
            heatmap.append({
                "facility": place.get("name"),
                "facilityType": place.get("type") or "unknown",
                "hour": hour,
                "value": round(sum(values) / len(values), 2) if values else None,
            })
    return heatmap


def aggregate_estimated_day(
    snapshots: list[Snapshot],
    facilities: list[dict[str, Any]],
    forecasts: list[dict[str, Any]],
    *,
    prev_avg: float | None = None,
    prev_samples: int = 0,
    calibration_state: calibration.CalibrationState | None = None,
) -> dict[str, Any]:
    """하루치 스냅샷 → 관리자 대시보드 집계와 **같은 모양**. 순수 함수.

    ``facilities`` 에는 그 날짜의 관광 기준선이 이미 붙어 있어야 한다.
    표본 단위는 (대표 장소 × 10분 버킷)이다 — 실측 집계의 '로그 1행' 에 해당한다.

    보정은 '지금' 과 같은 곡선을 하루 전체에 건다. 날짜별로 다른 곡선을 쓰면 히트맵의 어제와
    오늘이 다른 눈금이 되어 비교가 무의미해진다.
    """
    places = representative_places(facilities, forecasts)
    per_snapshot = [
        (snapshot, estimate_facilities(snapshot.lots, facilities, calibration_state=calibration_state))
        for snapshot in snapshots
    ]
    # 히트맵에 한 칸이라도 값이 있는 장소만 남긴다(주차 반경 밖 관광지는 줄 자체를 그리지 않는다).
    covered = [
        place for place in places
        if any(str(place["id"]) in estimates for _, estimates in per_snapshot)
    ][:HEATMAP_PLACE_CAP]

    samples: list[tuple[Snapshot, dict[str, Any], float]] = []
    for snapshot, estimates in per_snapshot:
        for place in covered:
            estimate = estimates.get(str(place["id"]))
            if estimate is not None:
                samples.append((snapshot, place, estimate["level"]))

    covered_facility_ids = {fid for _, estimates in per_snapshot for fid in estimates}
    latest = max((snapshot.observed_at for snapshot in snapshots), default=None)
    lot_counts = [len(snapshot.lots) for snapshot in snapshots]
    basis = {
        "method": "parking_its+tourism_concentration",
        "weights": {"parking": PARKING_WEIGHT, "tourism": TOURISM_WEIGHT},
        "radiusM": round(RADIUS_M),
        "snapshotCount": len(snapshots),
        "lotCountMax": max(lot_counts) if lot_counts else 0,
        "placeCount": len(covered),
        "estimatedFacilityCount": len(covered_facility_ids),
        "facilityCount": len(facilities),
        "latestObservedAt": latest.isoformat() if latest else None,
        "calibration": (calibration_state or calibration.IDENTITY).to_dict(),
    }

    if len(samples) < MIN_DAY_SAMPLES:
        return {
            "hasLogs": False,
            "avgCongestion": None,
            "anomalyCount": None,
            "heatmap": None,
            "anomalies": None,
            "sampleCount": len(samples),
            "sourceComposition": {ESTIMATE_SOURCE: len(samples)} if samples else {},
            "basis": basis,
        }

    avg = round(sum(level for _, _, level in samples) / len(samples), 2)
    change: float | None = None
    if prev_avg is not None and prev_avg > 0:
        change = round((avg - prev_avg) / prev_avg * 100, 1)

    peaks: dict[str, dict[str, Any]] = {}
    anomaly_count = 0
    for snapshot, place, level in samples:
        if level < ANOMALY_LEVEL:
            continue
        anomaly_count += 1
        name = str(place.get("name") or "")
        if name not in peaks or level > peaks[name]["congestionLevel"]:
            peaks[name] = {
                "id": f"{name}-{snapshot.bucket_at.isoformat()}",
                "facilityName": name,
                "timestamp": snapshot.bucket_at.isoformat(),
                "congestionLevel": level,
                # 버킷 하나가 10분이다. 실측 알림(30분 고정)과 달리 원본 단위를 그대로 쓴다.
                "durationMinutes": 10,
            }
    anomalies = sorted(peaks.values(), key=lambda a: a["congestionLevel"], reverse=True)[:6]

    return {
        "hasLogs": True,
        "avgCongestion": {
            "value": avg,
            "changePercent": change if change is not None else 0.0,
            "changePercentOrNull": change,
            "prevSampleCount": prev_samples,
        },
        "anomalyCount": anomaly_count,
        "heatmap": _hourly_heatmap(covered, per_snapshot),
        "anomalies": anomalies,
        "sampleCount": len(samples),
        "sourceComposition": {ESTIMATE_SOURCE: len(samples)},
        "basis": basis,
    }


# ── DB 읽기(쓰기 없음) ───────────────────────────────────────────────────────

_facility_cache: tuple[float, list[dict[str, Any]]] | None = None


def _load_base_facilities() -> list[dict[str, Any]]:
    """활성 시설의 좌표·이름·유형. fetch_all_rows — 단발 select 는 1000행에서 조용히 잘린다."""
    global _facility_cache
    now = time.monotonic()
    if _facility_cache and now - _facility_cache[0] < _FACILITY_TTL_SECONDS:
        return _facility_cache[1]
    rows = fetch_all_rows(
        supabase_admin,
        "facilities",
        "id,name,type,latitude,longitude,is_active",
        apply_filters=lambda query: query.order("id"),
    )
    active = [row for row in rows if row.get("is_active", True)]
    _facility_cache = (now, active)
    return active


def _load_forecasts(date_iso: str) -> list[dict[str, Any]]:
    response = (
        supabase_admin.table("tourism_concentration_forecasts")
        .select("tourist_attraction_name,concentration_rate,forecast_date")
        .eq("forecast_date", date_iso)
        .execute()
    )
    return response.data or []


def _facilities_for_date(date_iso: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """그 날짜의 관광 기준선을 붙인 시설 **사본**과 그 날의 통계 행."""
    facilities = [dict(row) for row in _load_base_facilities()]
    try:
        forecasts = _load_forecasts(date_iso)
    except Exception as exc:  # noqa: BLE001 — 통계가 없으면 주차 성분만으로 간다
        logger.warning("estimator_forecasts_unavailable", error=str(exc), date=date_iso)
        forecasts = []
    attach_tourism_area_priors(facilities, forecasts)
    return facilities, forecasts


def _snapshots_from_rows(parents: list[dict[str, Any]], lot_rows: list[dict[str, Any]]) -> list[Snapshot]:
    lots_by_snapshot: dict[str, list[ParkingLot]] = {}
    for row in lot_rows:
        try:
            total = int(row["total_spaces"])
            available = int(row["available_spaces"])
            lot = ParkingLot(
                lot_id=str(row["source_lot_id"]),
                name=str(row.get("name") or ""),
                latitude=float(row["latitude"]),
                longitude=float(row["longitude"]),
                total_spaces=total,
                available_spaces=available,
            )
        except (KeyError, TypeError, ValueError):
            continue
        if total <= 0 or not 0 <= available <= total:
            continue
        lots_by_snapshot.setdefault(str(row["snapshot_id"]), []).append(lot)

    snapshots: list[Snapshot] = []
    for parent in parents:
        snapshot_id = str(parent.get("id") or "")
        bucket_at = _aware(parent.get("bucket_at"))
        observed_at = _aware(parent.get("observed_at"))
        lots = lots_by_snapshot.get(snapshot_id)
        if not snapshot_id or bucket_at is None or observed_at is None or not lots:
            continue
        snapshots.append(Snapshot(snapshot_id, bucket_at, observed_at, tuple(lots)))
    snapshots.sort(key=lambda snapshot: snapshot.bucket_at)
    return snapshots


def _load_lot_rows(snapshot_ids: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for offset in range(0, len(snapshot_ids), _SNAPSHOT_ID_BATCH):
        batch = snapshot_ids[offset:offset + _SNAPSHOT_ID_BATCH]
        rows.extend(fetch_all_rows(
            supabase_admin,
            "area_demand_snapshot_lots",
            "snapshot_id,source_lot_id,name,latitude,longitude,total_spaces,available_spaces",
            apply_filters=lambda query, ids=batch: query.in_("snapshot_id", ids),
        ))
    return rows


def _load_snapshots(start_iso: str, end_iso: str) -> list[Snapshot]:
    parents = fetch_all_rows(
        supabase_admin,
        "area_demand_snapshots",
        "id,observed_at,bucket_at",
        apply_filters=lambda query: query.eq("source", SNAPSHOT_SOURCE)
        .gte("bucket_at", start_iso)
        .lte("bucket_at", end_iso)
        .order("bucket_at"),
    )
    ids = [str(row["id"]) for row in parents if row.get("id")]
    return _snapshots_from_rows(parents, _load_lot_rows(ids))


def _load_latest_snapshot() -> Snapshot | None:
    response = (
        supabase_admin.table("area_demand_snapshots")
        .select("id,observed_at,bucket_at")
        .eq("source", SNAPSHOT_SOURCE)
        .order("observed_at", desc=True)
        .limit(1)
        .execute()
    )
    parents = response.data or []
    if not parents:
        return None
    snapshots = _snapshots_from_rows(parents, _load_lot_rows([str(parents[0]["id"])]))
    return snapshots[0] if snapshots else None


# ── 공개 API ─────────────────────────────────────────────────────────────────

_current_cache: tuple[float, dict[str, Any]] | None = None
_current_lock = asyncio.Lock()


def reset_caches() -> None:
    """테스트용. 보정 캐시까지 비운다 — 이 캐시들이 들고 있는 값이 보정된 값이라 따로 비우면 섞인다."""
    global _current_cache, _facility_cache
    _current_cache = None
    _facility_cache = None
    _day_cache.clear()
    calibration.reset_caches()


def _empty_current(reason: str, observed_at: datetime | None = None) -> dict[str, Any]:
    return {
        "available": False,
        "reason": reason,
        "observed_at": observed_at.isoformat() if observed_at else None,
        "bucket_at": None,
        "lot_count": 0,
        "estimates": {},
        "calibration": calibration.IDENTITY.to_dict(),
    }


async def current_estimates(*, now: datetime | None = None) -> dict[str, Any]:
    """지금 시점의 시설별 추정. 5분 캐시(원본이 10분 버킷이라 더 자주 계산할 이유가 없다).

    반환: {available, reason, observed_at, bucket_at, lot_count, estimates: {facility_id: {...}}}
    원본이 60분보다 낡았으면 ``available=False`` — 한 시간 전 주차를 '지금' 으로 팔지 않는다.
    실패해도 예외를 올리지 않는다(추정은 부가 정보다 — 추천·지도를 죽이지 않는다).
    """
    global _current_cache
    if _current_fresh(time.monotonic()):
        return _current_cache[1]
    async with _current_lock:
        monotonic_now = time.monotonic()
        if _current_fresh(monotonic_now):
            return _current_cache[1]
        try:
            result = await _compute_current(now or datetime.now(timezone.utc))
        except Exception as exc:  # noqa: BLE001 — 계산 중 어디서 터져도 추천·지도를 죽이지 않는다
            logger.warning("estimator_compute_failed", error=str(exc))
            result = _empty_current("compute_failed")
        _current_cache = (monotonic_now, result)
        return result


def _current_fresh(monotonic_now: float) -> bool:
    if not _current_cache:
        return False
    ttl = _CURRENT_TTL_SECONDS if _current_cache[1].get("available") else _CURRENT_FAILURE_TTL_SECONDS
    return monotonic_now - _current_cache[0] < ttl


async def _compute_current(now: datetime) -> dict[str, Any]:
    try:
        snapshot = await asyncio.to_thread(_load_latest_snapshot)
    except Exception as exc:  # noqa: BLE001
        logger.warning("estimator_snapshot_unavailable", error=str(exc))
        return _empty_current("snapshot_unavailable")
    if snapshot is None:
        return _empty_current("no_parking_snapshot")
    age = now.astimezone(timezone.utc) - snapshot.observed_at
    if age > MAX_SNAPSHOT_AGE:
        return _empty_current("parking_snapshot_stale", snapshot.observed_at)
    date_iso = snapshot.bucket_at.astimezone(_KST).date().isoformat()
    try:
        facilities, _forecasts = await asyncio.to_thread(_facilities_for_date, date_iso)
    except Exception as exc:  # noqa: BLE001
        logger.warning("estimator_facilities_unavailable", error=str(exc))
        return _empty_current("facilities_unavailable", snapshot.observed_at)
    # active_calibration 은 예외를 올리지 않는다(실패 = 항등). 그래도 여기서 한 번 더 감싸는 이유는
    # 이 경로가 지도·추천의 앞단이기 때문이다 — 보정 때문에 추정 전체가 사라지면 안 된다.
    try:
        state = await asyncio.to_thread(calibration.active_calibration)
    except Exception as exc:  # noqa: BLE001
        logger.warning("estimator_calibration_unavailable", error=str(exc))
        state = calibration.IDENTITY
    estimates = await asyncio.to_thread(
        estimate_facilities, snapshot.lots, facilities, calibration_state=state
    )
    return {
        "available": True,
        "reason": None,
        "observed_at": snapshot.observed_at.isoformat(),
        "bucket_at": snapshot.bucket_at.isoformat(),
        "lot_count": len(snapshot.lots),
        "estimates": estimates,
        "calibration": state.to_dict(),
    }


def estimate_evidence(current: dict[str, Any], facility_id: str) -> dict[str, Any] | None:
    """추천·지도 응답에 싣는 근거 한 건. 추정이 없으면 ``None``.

    보정 흔적(``raw_level`` · ``calibrated`` · ``calibration_basis``)을 **항상** 함께 싣는다 —
    보정이 꺼져 있으면 raw_level == level 이고 basis 는 '보정 전(서울 표본 부족)' 이다.
    기존 키는 그대로 둔다(지도·추천·코스가 이미 읽고 있다 — 추가만).
    """
    if not current.get("available"):
        return None
    estimate = (current.get("estimates") or {}).get(str(facility_id))
    if estimate is None:
        return None
    state = current.get("calibration") or {}
    return {
        "level": estimate["level"],
        "source": ESTIMATE_SOURCE,
        "observed_at": current.get("observed_at"),
        "parking_level": estimate["parking_level"],
        "tourism_level": estimate["tourism_level"],
        "lot_count": estimate["lot_count"],
        "nearest_lot_m": estimate["nearest_lot_m"],
        "radius_m": round(RADIUS_M),
        # 원값은 절대 버리지 않는다. 보정된 숫자만 남기면 "무엇을 얼마나 고쳤는가" 를 사후에
        # 확인할 수 없고, 서울 표본이 바뀌면 같은 주차 관측이 다른 값으로 보이는 이유를 말할 수 없다.
        "raw_level": estimate.get("raw_level", estimate["level"]),
        "calibrated": bool(estimate.get("calibrated", False)),
        "calibration_basis": str(state.get("basis") or calibration.BASIS_NOT_APPLIED),
    }


def _day_bounds_kst(date_kst: str) -> tuple[str, str]:
    day = datetime.fromisoformat(date_kst).replace(tzinfo=_KST)
    start = day.astimezone(timezone.utc)
    end = (day + timedelta(days=1) - timedelta(milliseconds=1)).astimezone(timezone.utc)
    return start.isoformat(), end.isoformat()


def _estimated_day_sync(date_kst: str, *, with_prev: bool) -> dict[str, Any]:
    start, end = _day_bounds_kst(date_kst)
    snapshots = _load_snapshots(start, end)
    facilities, forecasts = _facilities_for_date(date_kst)
    state = calibration.active_calibration()
    prev_avg: float | None = None
    prev_samples = 0
    if with_prev:
        prev_date = (datetime.fromisoformat(date_kst) - timedelta(days=1)).date().isoformat()
        prev = _estimated_day_sync(prev_date, with_prev=False)
        if prev.get("hasLogs") and prev.get("avgCongestion"):
            prev_avg = prev["avgCongestion"]["value"]
            prev_samples = prev["sampleCount"]
    result = aggregate_estimated_day(
        snapshots, facilities, forecasts,
        prev_avg=prev_avg, prev_samples=prev_samples, calibration_state=state,
    )
    return {"dateKst": date_kst, **result}


# 날짜별 집계 캐시. 지난 날은 원본이 더 바뀌지 않으므로 길게, 오늘은 버킷(10분)보다 짧게.
_DAY_TTL_TODAY_SECONDS = 300.0
_DAY_TTL_PAST_SECONDS = 6 * 3600.0
_day_cache: dict[str, tuple[float, dict[str, Any]]] = {}


async def estimated_day_aggregate(date_kst: str, *, now: datetime | None = None) -> dict[str, Any]:
    """KST 하루의 추정 집계(관리자 대시보드 모양 + ``basis``). 실패는 호출부가 판단한다.

    계산에 1~2초(스냅샷 144개 × 시설 1,600곳)가 들어 날짜별로 캐시한다.
    """
    today_kst = (now or datetime.now(timezone.utc)).astimezone(_KST).date().isoformat()
    ttl = _DAY_TTL_TODAY_SECONDS if date_kst >= today_kst else _DAY_TTL_PAST_SECONDS
    cached = _day_cache.get(date_kst)
    monotonic_now = time.monotonic()
    if cached and monotonic_now - cached[0] < ttl:
        return cached[1]
    result = await asyncio.to_thread(_estimated_day_sync, date_kst, with_prev=True)
    _day_cache[date_kst] = (monotonic_now, result)
    # 캐시가 날짜 수만큼 자라지 않게 최근 며칠만 남긴다.
    for stale in sorted(_day_cache)[:-8]:
        _day_cache.pop(stale, None)
    return result
