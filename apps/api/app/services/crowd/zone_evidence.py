"""구역 혼잡 근거 — 시설 → 구역 → 최신 구역 관측(엔진·내부 지도가 함께 쓰는 데이터 접근).

`docs/SEOUL_TESTBED_PLAN.md` S3. 서울 시설은 자기 혼잡 로그가 없다(공개 congestion_logs 는 경주 전용 —
DB 트리거). 대신 시설이 속한 **구역**(`facility_zones` → `zones`)의 최신 관측(`zone_crowd_snapshots`)을
근거로 쓴다.

## 경주 불변
``load_zone_readings`` 는 ``region`` 이 ``ZONE_EVIDENCE_REGIONS`` 에 없으면 **클라이언트 호출 0회로** ``{}`` 를
돌려준다. 경주 경로는 이 모듈이 생기기 전과 같은 일만 한다.

## 무엇을 버리나
  · 대체값(quality.replaced) · 단계 없음(level null) · 절대 눈금이 아닌 관측(ABSOLUTE_LEVEL_SCALES 밖 —
    통신사 기준선 대비 상대값 등). 상대값은 서로 비교할 수 없어 순위에 넣지 않는다.
  · 표가 없거나(마이그레이션 전) 시간 초과·오류면 ``{}`` + 경고. 근거가 없을 뿐 추천은 돈다.

## 여러 구역
한 시설이 여러 구역에 걸치면 **전부** 들고 간다(튜플). 어느 구역 값을 쓸지는 도착 시각에 정한다
(엔진의 `zone_arrival_level` — 도착 시점의 최댓값). 여기서 미리 하나로 줄이지 않는다.
매핑된 구역 가운데 쓸 관측이 없는 구역이 있으면(공급 실패 · 대체값 · 2시간보다 오래됨) 그 구역은 튜플에 없지만
``mapped_zone_count`` 가 매핑 수를 기억한다 — 근거 dict 의 같은 칸을 보고 엔진은 그 시설을 순위 근거로 쓰지 않는다
(관측된 조용한 구역 하나로 최댓값을 내면 보수적이지 않다).

## '평소보다'
``usual_comparison`` 은 `zone_population_baseline` RPC(같은 KST 시각·평일/주말, 28일)와 비교한 **화면 문구용**
값이다. 점수·순위에는 절대 쓰지 않는다 — 순위는 절대 혼잡 단계로만 정한다(사용자 결정 2026-10-31).
기준선은 (구역, KST 시, 평일/주말) 키로 1시간 캐시하고, 캐시가 비면 그 응답은 ``None`` 으로 두고 백그라운드에서
채운다 — 화면 문구용 RPC 가 순위용 관측 읽기의 시간 예산을 쓰지 않는다(``_baseline_for``).
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Sequence

import structlog

from app.core.region import ZONE_EVIDENCE_REGIONS
from app.core.supabase import supabase_admin
from app.services.crowd.store import is_missing_table

logger = structlog.get_logger()

ZONE_EVIDENCE_TIER = "zone_measured"
# 관측이 '지금' 을 말할 수 있는 나이(벽시계 기준).
ZONE_NOW_WINDOW = timedelta(minutes=30)
# 공급원 예측을 쓸 수 있는 발행 나이(벽시계 기준 — 관측 시각이 곧 발행 시각이다).
ZONE_FORECAST_MAX_ISSUE_AGE = timedelta(minutes=90)
# 도착 시각과 예측 대상 시각의 최대 간격.
ZONE_FORECAST_MATCH_WINDOW = timedelta(minutes=30)
# 이 눈금의 관측만 순위 근거가 된다(0~1 절대 단계). 통신사 상대값은 빠진다.
ABSOLUTE_LEVEL_SCALES: frozenset[str] = frozenset({"seoul_congest_4"})
# 공급원 등급 문자열 → 지역 무관 단계 이름. 화면은 이 이름만 받는다(공급원 표기를 번들에 싣지 않는다).
BAND_BY_LABEL: Mapping[str, str] = {
    "여유": "relaxed",
    "보통": "normal",
    "약간 붐빔": "slightly_busy",
    "붐빔": "busy",
}
LEVEL_BANDS: tuple[str, ...] = ("relaxed", "normal", "slightly_busy", "busy")
# 눈금별 가장 붐비는 단계 — 엔진은 이 단계의 도착 혼잡을 '혼잡' 컷오프로 내린다.
TOP_BAND: Mapping[str, str] = {"seoul_congest_4": "busy"}
USUAL_COMPARISONS: tuple[str, ...] = ("busier", "usual", "quieter")

# 최신 관측을 찾을 때 뒤돌아보는 범위(이보다 오래된 버킷은 읽지 않는다).
_SNAPSHOT_LOOKBACK = timedelta(hours=2)
# 24시간이 넘은 관측은 '몹시 낡음'(infrastructures._STALE_AFTER_HOURS 와 같은 선).
_STALE_AFTER = timedelta(hours=24)
_FACILITY_CHUNK = 200
_CACHE_TTL = timedelta(seconds=60)
_BASELINE_TTL = timedelta(hours=1)
_BASELINE_RPC = "zone_population_baseline"
_BASELINE_DAYS = 28
# 기준선 표본이 이보다 적으면 '평소' 를 말하지 않는다.
_BASELINE_MIN_SAMPLES = 4
_DEFAULT_TIMEOUT = 2.0

# seoul_congest_4 는 등급 구간 중앙값(0.125·0.375·0.625·0.875)이다 — 경계는 0.25 단위.
_BAND_EDGES: Mapping[str, tuple[float, float, float]] = {"seoul_congest_4": (0.25, 0.5, 0.75)}

_SNAPSHOT_COLUMNS = (
    "zone_id,source,bucket_at,observed_at,fetched_at,population_min,population_max,"
    "level,level_label,level_scale,forecast,quality"
)
_ZONE_COLUMNS = "zone_id,region,name,provider,cluster,centroid_lat,centroid_lng,radius_m"


@dataclass(frozen=True)
class ZoneDefinition:
    """`zones` 한 행(이 모듈이 쓰는 칸만)."""

    zone_id: str
    region: str
    name: str
    provider: str
    cluster: str | None
    centroid_lat: float
    centroid_lng: float
    radius_m: float | None


@dataclass(frozen=True)
class ZoneReading:
    """구역 하나의 최신 유효 관측(시설 매핑 가중치 포함).

    ``forecast`` 는 (대상 시각, 단계 0~1 또는 None, 단계 이름 또는 None) 을 대상 시각 순으로 담는다.
    """

    zone_id: str
    zone_name: str
    cluster: str | None
    provider: str
    level: float
    level_band: str | None
    level_scale: str
    observed_at: datetime
    fetched_at: datetime | None
    population_min: int | None
    population_max: int | None
    forecast: tuple[tuple[datetime, float | None, str | None], ...]
    usual_comparison: str | None
    weight: float = 1.0
    # 이 시설에 매핑된 구역 수(관측이 없는 구역 포함). 0 = 모름(관측 수와 같다고 본다).
    mapped_zone_count: int = 0


@dataclass(frozen=True)
class ZoneState:
    """내부 지도·구역 목록용 — 구역 정의 + 최신 유효 관측(없으면 None)."""

    zone: ZoneDefinition
    reading: ZoneReading | None


# ── 순수 함수 ──────────────────────────────────────────────────────────────────


def _utc(moment: datetime) -> datetime:
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def _now(wall_now: datetime | None) -> datetime:
    return _utc(wall_now) if wall_now is not None else datetime.now(timezone.utc)


def parse_ts(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return _utc(value)
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return _utc(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return None


def iso(moment: datetime | None) -> str | None:
    return _utc(moment).isoformat() if moment is not None else None


def band_for_label(label: Any) -> str | None:
    text = " ".join(str(label or "").split())
    return BAND_BY_LABEL.get(text)


def band_for_level(level: float | None, scale: str | None) -> str | None:
    if level is None:
        return None
    edges = _BAND_EDGES.get(str(scale or ""))
    if edges is None:
        return None
    for band, edge in zip(LEVEL_BANDS, edges):
        if level < edge:
            return band
    return LEVEL_BANDS[-1]


def level_band(label: Any, level: float | None, scale: str | None) -> str | None:
    """공급원 라벨 → 단계 이름. 라벨이 없거나 모르면 단계 값과 눈금으로 정한다."""
    return band_for_label(label) or band_for_level(level, scale)


def zone_reading_is_current(observed_at: datetime | None, *, wall_now: datetime) -> bool:
    """관측이 '지금' 인가 — 0 ≤ 벽시계 − 관측 ≤ 30분. 미래 관측(시계 어긋남)은 지금이 아니다."""
    if observed_at is None:
        return False
    age = _utc(wall_now) - _utc(observed_at)
    return timedelta(0) <= age <= ZONE_NOW_WINDOW


def usual_comparison_for(
    population_min: int | None, population_max: int | None, baseline: Mapping[str, Any] | None
) -> str | None:
    """현재 인원 범위 중앙값을 기준선 사분위와 비교한다(화면 문구 전용)."""
    if population_min is None or population_max is None or not baseline:
        return None
    try:
        samples = int(baseline.get("samples") or 0)
        p25 = float(baseline["p25"])
        p75 = float(baseline["p75"])
    except (KeyError, TypeError, ValueError):
        return None
    if samples < _BASELINE_MIN_SAMPLES:
        return None
    mid = (population_min + population_max) / 2.0
    if mid > p75:
        return "busier"
    if mid < p25:
        return "quieter"
    return "usual"


def _as_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None  # NaN 제외


def _as_int(value: Any) -> int | None:
    number = _as_float(value)
    return int(number) if number is not None else None


def _forecast_points(raw: Any, scale: str) -> tuple[tuple[datetime, float | None, str | None], ...]:
    points: list[tuple[datetime, float | None, str | None]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, Mapping):
            continue
        target = parse_ts(item.get("target_at"))
        if target is None:
            continue
        level = _as_float(item.get("level"))
        if level is not None and not 0.0 <= level <= 1.0:
            level = None
        points.append((target, level, level_band(item.get("level_label"), level, scale)))
    points.sort(key=lambda point: point[0])
    return tuple(points)


def reading_from_snapshot(
    row: Mapping[str, Any], zone: ZoneDefinition, *, usual_comparison: str | None = None
) -> ZoneReading | None:
    """`zone_crowd_snapshots` 한 행 → 관측. 순위 근거가 될 수 없는 행은 None."""
    quality = row.get("quality") if isinstance(row.get("quality"), Mapping) else {}
    if quality.get("replaced") is True:
        return None
    scale = str(row.get("level_scale") or "")
    if scale not in ABSOLUTE_LEVEL_SCALES:
        return None
    level = _as_float(row.get("level"))
    if level is None or not 0.0 <= level <= 1.0:
        return None
    observed_at = parse_ts(row.get("observed_at"))
    if observed_at is None:
        return None
    return ZoneReading(
        zone_id=zone.zone_id,
        zone_name=zone.name,
        cluster=zone.cluster,
        provider=str(row.get("source") or zone.provider),
        level=level,
        level_band=level_band(row.get("level_label"), level, scale),
        level_scale=scale,
        observed_at=observed_at,
        fetched_at=parse_ts(row.get("fetched_at")),
        population_min=_as_int(row.get("population_min")),
        population_max=_as_int(row.get("population_max")),
        forecast=_forecast_points(row.get("forecast"), scale),
        usual_comparison=usual_comparison,
    )


def zone_reading_dict(reading: ZoneReading, *, wall_now: datetime) -> dict[str, Any]:
    """관측 → JSON 친화 dict(점수 근거의 ``zones`` 항목 · 내부 지도의 구역 칸)."""
    return {
        "id": reading.zone_id,
        "name": reading.zone_name,
        "cluster": reading.cluster,
        "level": reading.level,
        "level_band": reading.level_band,
        "level_scale": reading.level_scale,
        "observed_at": iso(reading.observed_at),
        "is_current": zone_reading_is_current(reading.observed_at, wall_now=wall_now),
        "forecast": [
            {"target_at": iso(target), "level": level, "level_band": band}
            for target, level, band in reading.forecast
        ],
        "usual_comparison": reading.usual_comparison,
        "weight": reading.weight,
    }


def facility_zones_current(readings: Sequence[ZoneReading], *, wall_now: datetime) -> bool:
    """시설이 '지금' 을 말할 수 있는가 — 매핑된 구역이 **전부** 관측되었고 **전부** 30분 안이다.

    한 구역이라도 비었거나(``mapped_zone_count`` > 관측 수) 30분을 넘긴 관측이면(2시간 조회 범위 안이라도)
    조용한 '지금' 구역 하나로 시설의 지금을 말하지 않는다 — 비어 있는 구역과 낡은 구역을 같은 규칙으로 다룬다.
    """
    if not readings:
        return False
    if facility_zones_partial(readings):
        return False
    return all(zone_reading_is_current(r.observed_at, wall_now=wall_now) for r in readings)


def choose_zone_reading(readings: Sequence[ZoneReading], *, wall_now: datetime) -> ZoneReading | None:
    """관측된 구역 **전부** 가운데 가장 붐비는 것(보수적).

    '지금' 인 구역만 골라 보지 않는다 — 5분 전 '여유' 구역과 50분 전 '붐빔' 구역이 섞인 시설을 '여유' 로 말하게 된다
    (그 시설은 어차피 '지금' 이 아니다: ``facility_zones_current``). 전부 '지금' 이면 결과는 예전과 같다.
    ``wall_now`` 는 호출 모양을 지키려고 남긴다.
    """
    del wall_now
    if not readings:
        return None
    return max(readings, key=lambda r: (r.level, r.observed_at, r.zone_id))


def facility_zones_partial(readings: Sequence[ZoneReading]) -> bool:
    """매핑된 구역 가운데 쓸 관측이 없는 구역이 있는가(``mapped_zone_count`` > 관측 수)."""
    if not readings:
        return False
    return max(len(readings), *(r.mapped_zone_count for r in readings)) > len(readings)


def zone_evidence_dict(readings: Sequence[ZoneReading], *, wall_now: datetime | None = None) -> dict[str, Any]:
    """시설의 구역 관측들 → 혼잡 근거 dict(`build_candidate_evidence` 와 같은 키 + ``zones``).

    level 은 관측된 구역 전부의 최댓값(``choose_zone_reading``), timestamp 는 고른 구역의 관측 시각.
    매핑된 구역 일부에 쓸 관측이 없으면(``facility_zones_partial``) level 은 None 이다 — 관측된 조용한 구역 하나로
    시설 단계를 말하지 않는다(카드는 단계 없이 '마지막 관측' 만 그린다. 순위는 ``zone_arrival_level`` 이 이미 막는다).
    ``is_current`` 는 매핑된 구역이 전부 '지금' 일 때만 참이다(``facility_zones_current``).
    """
    now = _now(wall_now)
    chosen = choose_zone_reading(readings, wall_now=now)
    if chosen is None:
        return {
            "level": None, "source": "none", "log_source": None, "current_count": None,
            "evidence_tier": None, "is_stale": None, "timestamp": None, "estimate": None,
            "is_current": False,
        }
    # 매핑된 구역이 전부 '지금' 이어야 시설의 '지금' 이다(facility_zones_current).
    is_current = facility_zones_current(readings, wall_now=now)
    return {
        "level": None if facility_zones_partial(readings) else chosen.level,
        "source": "measured",
        "log_source": chosen.provider,
        "current_count": None,
        "evidence_tier": ZONE_EVIDENCE_TIER,
        "is_stale": (now - chosen.observed_at) > _STALE_AFTER,
        "timestamp": iso(chosen.observed_at),
        "estimate": None,
        "is_current": is_current,
        "zone_id": chosen.zone_id,
        "zones": [zone_reading_dict(r, wall_now=now) for r in readings],
        # 매핑된 구역 수(관측 없는 구역 포함). len(zones) 보다 크면 일부 구역이 비어 있다(congestion_evidence 가 읽는다).
        "mapped_zone_count": max(len(readings), *(r.mapped_zone_count for r in readings)),
    }


# ── DB 읽기(service_role · 동기 — 워커 스레드에서 돈다) ───────────────────────


def _client():
    return supabase_admin


def _zone_definition(row: Mapping[str, Any]) -> ZoneDefinition | None:
    zone_id = str(row.get("zone_id") or "").strip()
    lat, lng = _as_float(row.get("centroid_lat")), _as_float(row.get("centroid_lng"))
    if not zone_id or lat is None or lng is None:
        return None
    return ZoneDefinition(
        zone_id=zone_id,
        region=str(row.get("region") or ""),
        name=str(row.get("name") or zone_id),
        provider=str(row.get("provider") or ""),
        cluster=(str(row["cluster"]) if row.get("cluster") else None),
        centroid_lat=lat,
        centroid_lng=lng,
        radius_m=_as_float(row.get("radius_m")),
    )


def _read_zones(client, region: str) -> dict[str, ZoneDefinition]:
    res = client.table("zones").select(_ZONE_COLUMNS).eq("region", region).order("zone_id").execute()
    zones: dict[str, ZoneDefinition] = {}
    for row in res.data or []:
        zone = _zone_definition(row)
        # 요청한 지역의 구역만 — 응답이 어긋나도 다른 지역 구역이 섞이지 않게 한 번 더 본다.
        if zone is not None and zone.region == region:
            zones[zone.zone_id] = zone
    return zones


def _read_latest_rows(client, zone_ids: Sequence[str], wall_now: datetime) -> dict[str, list[dict]]:
    """구역별 최근 2시간 관측(최신순)."""
    if not zone_ids:
        return {}
    since = (wall_now - _SNAPSHOT_LOOKBACK).isoformat()
    res = (
        client.table("zone_crowd_snapshots")
        .select(_SNAPSHOT_COLUMNS)
        .in_("zone_id", list(zone_ids))
        .gte("bucket_at", since)
        .order("bucket_at", desc=True)
        .order("observed_at", desc=True)
        .limit(1000)
        .execute()
    )
    by_zone: dict[str, list[dict]] = {}
    for row in res.data or []:
        zone_id = str(row.get("zone_id") or "")
        if zone_id in zone_ids:
            by_zone.setdefault(zone_id, []).append(row)
    return by_zone


# ── '평소' 기준선 — 화면 문구 전용이라 순위용 관측의 시간 예산 밖에서 채운다 ─────────────────
#
# 캐시 키 = (구역들, KST 시, 주말 여부). RPC 가 같은 KST 시·평일/주말 분포를 돌려주므로 시가 바뀌면 다른 값이다
# (14:40 에 읽은 14시 분포를 15:25 에 쓰지 않는다). 캐시가 비면 그 요청은 usual_comparison=None 으로 관측을 먼저
# 돌려주고, 기준선은 백그라운드 스레드가 따로 채운다 — 느린 RPC 가 load_zone_readings 를 시간 초과({})로 만들 수 없다.
# 같은 키의 갱신은 하나만 돈다. 실패도 TTL 동안 {} 로 기억한다(요청마다 RPC 를 두드리지 않는다).

_KST = timezone(timedelta(hours=9))
BaselineKey = tuple[tuple[str, ...], int, bool]
_baseline_cache: dict[BaselineKey, tuple[datetime, dict[str, dict]]] = {}
# 진행 중인 갱신 — 키 → 그 갱신을 띄운 세대. 옛 세대 스레드가 끝나며 새 세대의 표시를 지우지 않게 세대를 함께 둔다.
_baseline_inflight: dict[BaselineKey, int] = {}
# reset_cache 마다 오른다 — 비운 뒤에 끝난 갱신이 캐시를 다시 채우지 않게 한다.
_baseline_generation = 0


def _baseline_key(zone_ids: Iterable[str], wall_now: datetime) -> BaselineKey:
    local = _utc(wall_now).astimezone(_KST)
    return tuple(sorted(zone_ids)), local.hour, local.isoweekday() in (6, 7)


def _baseline_cached(key: BaselineKey, wall_now: datetime) -> dict[str, dict] | None:
    """캐시 적중이면 기준선, 아니면 None(RPC 를 부르지 않는다)."""
    with _lock:
        hit = _baseline_cache.get(key)
    if hit is not None and timedelta(0) <= wall_now - hit[0] <= _BASELINE_TTL:
        return hit[1]
    return None


def _fetch_baseline(client, key: BaselineKey, wall_now: datetime) -> dict[str, dict]:
    try:
        res = client.rpc(
            _BASELINE_RPC, {"p_zone_ids": list(key[0]), "p_at": wall_now.isoformat(), "p_days": _BASELINE_DAYS}
        ).execute()
        return {str(row.get("zone_id")): dict(row) for row in (res.data or []) if row.get("zone_id")}
    except Exception as exc:  # noqa: BLE001 — 화면 문구용이다. 근거 자체를 막지 않는다.
        logger.info("zone_baseline_unavailable", error_type=type(exc).__name__)
        return {}


def _start_background_thread(fn) -> None:
    """데몬 스레드로 돌린다(운영 경로). 테스트에서 진짜 스레드가 필요하면 ``_start_background`` 를 이것으로 되돌린다."""
    threading.Thread(target=fn, name="zone-baseline-refresh", daemon=True).start()


def _start_background(fn) -> None:
    """기준선 갱신을 요청 경로 밖에서 돌린다(tests/conftest 는 기본으로 이 함수를 바꿔 그 자리에서 돌린다)."""
    _start_background_thread(fn)


def _schedule_baseline_refresh(client, key: BaselineKey, wall_now: datetime) -> None:
    with _lock:
        if _baseline_inflight.get(key) == _baseline_generation:
            return
        generation = _baseline_generation
        _baseline_inflight[key] = generation

    def _refresh() -> None:
        try:
            baseline = _fetch_baseline(client, key, wall_now)
            with _lock:
                if generation == _baseline_generation:
                    _baseline_cache[key] = (wall_now, baseline)
        finally:
            _clear_inflight(key, generation)

    try:
        _start_background(_refresh)
    except Exception as exc:  # noqa: BLE001 — 스레드를 못 띄우면 이번엔 문구만 빠진다
        logger.info("zone_baseline_refresh_not_started", error_type=type(exc).__name__)
        _clear_inflight(key, generation)


def _clear_inflight(key: BaselineKey, generation: int) -> None:
    """그 세대가 띄운 갱신의 '진행 중' 표시만 지운다(reset 뒤 새 세대 갱신의 표시는 남긴다)."""
    with _lock:
        if _baseline_inflight.get(key) == generation:
            del _baseline_inflight[key]


def _baseline_for(client, zone_ids: Sequence[str], wall_now: datetime) -> dict[str, dict]:
    """'평소' 기준선 — 캐시 적중만 돌려준다. 비어 있으면 갱신을 띄우고 {}(이번 응답은 usual_comparison=None)."""
    if not zone_ids:
        return {}
    key = _baseline_key(zone_ids, wall_now)
    hit = _baseline_cached(key, wall_now)
    if hit is not None:
        return hit
    _schedule_baseline_refresh(client, key, wall_now)
    # 갱신이 그 자리에서 끝났으면(테스트의 동기 실행) 바로 쓴다.
    return _baseline_cached(key, wall_now) or {}


def _apply_usual(state: _RegionState, wall_now: datetime) -> Mapping[str, ZoneReading]:
    """구역 상태의 관측에 '평소보다' 를 붙인다(읽을 때마다 — 기준선이 채워지면 구역 상태 캐시 안에서도 바로 반영)."""
    if not state.readings:
        return state.readings
    baseline = _baseline_for(_client(), tuple(state.zones), wall_now)
    return {
        zone_id: replace(
            reading,
            usual_comparison=usual_comparison_for(reading.population_min, reading.population_max, baseline.get(zone_id)),
        )
        for zone_id, reading in state.readings.items()
    }


@dataclass(frozen=True)
class _RegionState:
    zones: Mapping[str, ZoneDefinition]
    readings: Mapping[str, ZoneReading]


_lock = threading.Lock()
# region → (적재 벽시계, 상태)
_region_cache: dict[str, tuple[datetime, _RegionState]] = {}
# (region, facility_id) → (적재 벽시계, ((zone_id, weight), ...))
_mapping_cache: dict[tuple[str, str], tuple[datetime, tuple[tuple[str, float], ...]]] = {}


def reset_cache() -> None:
    """테스트·운영 도구용 — 구역 상태·매핑·기준선 캐시를 비운다."""
    global _baseline_generation
    with _lock:
        _region_cache.clear()
        _mapping_cache.clear()
        _baseline_cache.clear()
        _baseline_inflight.clear()
        _baseline_generation += 1


def _fresh(loaded_at: datetime, wall_now: datetime, ttl: timedelta) -> bool:
    return timedelta(0) <= wall_now - loaded_at <= ttl


def _load_region_state_sync(region: str, wall_now: datetime) -> _RegionState:
    with _lock:
        hit = _region_cache.get(region)
    if hit is not None and _fresh(hit[0], wall_now, _CACHE_TTL):
        return hit[1]
    client = _client()
    zones = _read_zones(client, region)
    rows_by_zone = _read_latest_rows(client, tuple(zones), wall_now)
    # '평소보다'(usual_comparison)는 여기서 붙이지 않는다 — 읽을 때 _apply_usual 이 캐시에서만 붙인다
    # (기준선 RPC 가 이 순위용 경로의 시간 예산을 쓰지 않게).
    readings: dict[str, ZoneReading] = {}
    for zone_id, rows in rows_by_zone.items():
        zone = zones[zone_id]
        for row in rows:  # 최신순 — 처음 통과한 행이 이 구역의 최신 유효 관측
            reading = reading_from_snapshot(row, zone)
            if reading is None:
                continue
            readings[zone_id] = reading
            break
    state = _RegionState(zones=zones, readings=readings)
    with _lock:
        _region_cache[region] = (wall_now, state)
    return state


def _load_mapping_sync(
    region: str, facility_ids: Sequence[str], zone_ids: Iterable[str], wall_now: datetime
) -> dict[str, tuple[tuple[str, float], ...]]:
    """시설 → ((구역, 가중치), ...). 요청 지역의 구역으로만 거른다(쿼리 안에서)."""
    allowed = sorted(set(zone_ids))
    out: dict[str, tuple[tuple[str, float], ...]] = {}
    missing: list[str] = []
    with _lock:
        for fid in facility_ids:
            hit = _mapping_cache.get((region, fid))
            if hit is not None and _fresh(hit[0], wall_now, _CACHE_TTL):
                out[fid] = hit[1]
            else:
                missing.append(fid)
    if not missing or not allowed:
        for fid in missing:
            out[fid] = ()
        return out
    client = _client()
    found: dict[str, list[tuple[str, float]]] = {fid: [] for fid in missing}
    for start in range(0, len(missing), _FACILITY_CHUNK):
        chunk = missing[start:start + _FACILITY_CHUNK]
        res = (
            client.table("facility_zones")
            .select("facility_id,zone_id,weight")
            .in_("facility_id", chunk)
            .in_("zone_id", allowed)
            .execute()
        )
        for row in res.data or []:
            fid, zone_id = str(row.get("facility_id") or ""), str(row.get("zone_id") or "")
            if fid in found and zone_id in allowed:
                weight = _as_float(row.get("weight"))
                found[fid].append((zone_id, weight if weight and weight > 0 else 1.0))
    with _lock:
        for fid, pairs in found.items():
            value = tuple(sorted(pairs))
            _mapping_cache[(region, fid)] = (wall_now, value)
            out[fid] = value
    return out


def _readings_sync(region: str, facility_ids: Sequence[str], wall_now: datetime) -> dict[str, tuple[ZoneReading, ...]]:
    state = _load_region_state_sync(region, wall_now)
    if not state.zones:
        return {}
    mapping = _load_mapping_sync(region, facility_ids, state.zones, wall_now)
    current = _apply_usual(state, wall_now)
    out: dict[str, tuple[ZoneReading, ...]] = {}
    for fid, pairs in mapping.items():
        # 관측이 없는 매핑 구역은 튜플에 들지 않지만, 매핑 수(len(pairs))는 각 관측에 실어 둔다.
        readings = tuple(
            replace(current[zone_id], weight=weight, mapped_zone_count=len(pairs))
            for zone_id, weight in pairs
            if zone_id in current
        )
        if readings:
            out[fid] = readings
    return out


def _log_failure(event: str, exc: BaseException, region: str) -> None:
    if any(is_missing_table(exc, table) for table in ("zones", "zone_crowd_snapshots", "facility_zones")):
        logger.warning(event, region=region, reason="migration_not_applied")
    else:
        logger.warning(event, region=region, reason="error", error_type=type(exc).__name__)


async def load_zone_readings(
    facility_ids: Iterable[Any],
    *,
    region: str,
    wall_now: datetime | None = None,
    timeout: float = _DEFAULT_TIMEOUT,
) -> dict[str, tuple[ZoneReading, ...]]:
    """시설별 구역 관측 {facility_id: (관측, ...)}. 관측이 하나도 없는 시설은 키가 없다.

    ``region`` 이 구역 근거 지역이 아니면 **호출 0회로** ``{}``(경주 불변). 표 없음·시간 초과·오류도 ``{}``.
    """
    if region not in ZONE_EVIDENCE_REGIONS:
        return {}
    ids = sorted({str(fid) for fid in facility_ids if fid})
    if not ids:
        return {}
    now = _now(wall_now)
    try:
        return await asyncio.wait_for(asyncio.to_thread(_readings_sync, region, ids, now), timeout=timeout)
    except asyncio.TimeoutError:
        logger.warning("zone_readings_timeout", region=region, facility_count=len(ids))
        return {}
    except Exception as exc:  # noqa: BLE001 — 근거가 없을 뿐 추천은 돈다
        _log_failure("zone_readings_unavailable", exc, region)
        return {}


async def load_zone_states(
    region: str, *, wall_now: datetime | None = None, timeout: float = _DEFAULT_TIMEOUT
) -> list[ZoneState]:
    """지역의 구역 전부 + 최신 유효 관측(내부 구역 목록·지역 요약용). 구역 근거 지역이 아니면 []."""
    if region not in ZONE_EVIDENCE_REGIONS:
        return []
    now = _now(wall_now)

    def _run() -> tuple[_RegionState, Mapping[str, ZoneReading]]:
        state = _load_region_state_sync(region, now)
        return state, _apply_usual(state, now)

    try:
        state, readings = await asyncio.wait_for(asyncio.to_thread(_run), timeout=timeout)
    except asyncio.TimeoutError:
        logger.warning("zone_states_timeout", region=region)
        return []
    except Exception as exc:  # noqa: BLE001
        _log_failure("zone_states_unavailable", exc, region)
        return []
    return [ZoneState(zone=zone, reading=readings.get(zone_id)) for zone_id, zone in state.zones.items()]


async def load_facility_zone_ids(
    facility_ids: Iterable[Any],
    *,
    region: str,
    wall_now: datetime | None = None,
    timeout: float = _DEFAULT_TIMEOUT,
) -> dict[str, tuple[str, ...]]:
    """시설 → 매핑된 구역 ID(관측 유무와 무관). 매핑이 없는 시설은 키가 없다. 실패는 {}."""
    if region not in ZONE_EVIDENCE_REGIONS:
        return {}
    ids = sorted({str(fid) for fid in facility_ids if fid})
    if not ids:
        return {}
    now = _now(wall_now)

    def _run() -> dict[str, tuple[str, ...]]:
        state = _load_region_state_sync(region, now)
        mapping = _load_mapping_sync(region, ids, state.zones, now)
        return {fid: tuple(zone_id for zone_id, _ in pairs) for fid, pairs in mapping.items() if pairs}

    try:
        return await asyncio.wait_for(asyncio.to_thread(_run), timeout=timeout)
    except asyncio.TimeoutError:
        logger.warning("facility_zone_ids_timeout", region=region)
        return {}
    except Exception as exc:  # noqa: BLE001
        _log_failure("facility_zone_ids_unavailable", exc, region)
        return {}
