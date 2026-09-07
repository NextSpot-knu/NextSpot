"""10분 주차 실측 이력으로 주변 권역 수요를 보수적으로 전망한다.

장소 내부 좌석이나 대기시간을 예측하지 않는다. 동일한 반경 2km 안의 주차장 원본을
시점별로 다시 집계하고, 과거의 같은 요일군·시간대 표본이 충분할 때만 상대 수요 수준을
반환한다. 모든 학습 표본은 전망 시점보다 과거여야 하므로 시간 순서 누수를 허용하지 않는다.

집계는 Postgres RPC(``area_demand_points_near``, 마이그레이션 20260904120000)가 한다.
예전에는 56일치 주차장 원본을 프로세스에 통째로(≈52MB) 올려 두고 **후보 한 곳마다**
파이썬 루프로 다시 훑었다 — 후보당 0.28~6.4초라 후보가 몇만 되어도 프런트 10초 타임아웃
안에 추천이 끝나지 않았다. 지금은 후보당 왕복 한 번이고 상주 캐시가 없다.
"""

from __future__ import annotations

import asyncio
import statistics
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog

from app.core.supabase import fetch_all_rows, supabase_admin
from app.services.spot.travel import calculate_haversine_distance
from app.services.travel_context import KST

logger = structlog.get_logger()

_RADIUS_M = 2_000.0
_BUCKET_MINUTES = 10
_LOOKBACK_DAYS = 56
_CACHE_TTL_SECONDS = 5 * 60.0
_MIN_SAMPLES = 6
_MIN_DISTINCT_DATES = 3
_MIN_COVERAGE_DAYS = 7
_TIME_WINDOW_MINUTES = 30
_MAX_RECENT_ADJUSTMENT = 0.08
_SOURCE = "gyeongju_its"
_POINTS_RPC = "area_demand_points_near"


@dataclass(frozen=True)
class AreaDemandPoint:
    observed_at: datetime
    level: float
    lot_count: int


# ── 폴백 전용 상태 ────────────────────────────────────────────────────────────
# 아래 원본 캐시는 **RPC 가 없는 DB** 를 만났을 때만 채워진다(마이그레이션 적용 전 배포
# 창). RPC 가 한 번이라도 성공하면 즉시 비워지고 다시는 채워지지 않는다.
_raw_cache: tuple[float, list[dict[str, Any]], list[dict[str, Any]]] | None = None
_raw_cache_lock = asyncio.Lock()
# RPC 부재를 감지하면 이 시각(monotonic)까지는 RPC 를 건너뛰고 폴백만 쓴다. 후보마다
# 실패하는 왕복을 한 번씩 더 하면 배포 창 동안 지연이 두 배가 된다.
_RPC_MISSING_RETRY_SECONDS = 60.0
_rpc_missing_until: float = 0.0

# ── 좌표 격자별 시계열 캐시 ───────────────────────────────────────────────────
#
# 왜 필요한가: `_load_points` 는 **후보 좌표마다 RPC 왕복 1회**다. 코스 한 요청은 자리마다
# 후보를 현재 위치 기준으로 다시 추리므로 이 함수가 수십 번 불린다(2026-09-06 실측: 서로 다른
# 좌표 12 → 36). 왕복 하나하나는 싸지만 **직렬로 수십 번**이면 Render 무료 인스턴스에서
# 프런트 타임아웃(20초)에 실제로 가까워진다.
#
# 키를 백테스트 캐시(`_cached_backtest`)와 **같은 격자**(round 3자리 ≈ 100m)로 잡는다.
# 그래야 같은 격자의 후보가 RPC 와 백테스트를 함께 재사용한다 — 한쪽만 격자로 묶으면
# 나머지 한쪽이 그대로 비용을 낸다.
#
# ⚠️ 격자를 더 넓히지 않는다. 키에서 좌표를 빼거나 자리수를 줄이면 다른 지점의 시계열을
# 서로 주고받게 되어 "지점별 품질" 계약이 "격자별 품질" 로 바뀐다. 그건 값의 의미를 바꾸는
# 결정이라 여기서 하지 않는다(검토목록 2번 — 사용자가 '캐시 키는 건드리지 말고 선계산으로'
# 를 골랐다).
#
# `now` 는 키에 넣지 않고 TTL 로만 다룬다. 넣으면 초 단위로 키가 갈려 캐시가 무의미해진다.
_POINTS_CACHE_TTL_SECONDS = 5 * 60.0
_POINTS_CACHE_MAX_ENTRIES = 256
_points_cache: dict[tuple[float, float], tuple[float, list["AreaDemandPoint"]]] = {}
# 같은 격자를 동시에 요청하면 RPC 도 동시에 나간다. 격자마다 락을 하나 두어 **첫 요청만**
# 왕복하고 나머지는 그 결과를 기다리게 한다(예열과 채점이 겹칠 때 실제로 일어난다).
_points_locks: dict[tuple[float, float], asyncio.Lock] = {}


def _grid_key(latitude: float, longitude: float) -> tuple[float, float]:
    """백테스트 캐시와 **동일한** 격자. 두 캐시가 어긋나면 한쪽이 늘 빗나간다."""
    return (round(latitude, 3), round(longitude, 3))


def _points_cache_get(key: tuple[float, float]) -> list["AreaDemandPoint"] | None:
    hit = _points_cache.get(key)
    if hit is None:
        return None
    if time.monotonic() - hit[0] >= _POINTS_CACHE_TTL_SECONDS:
        _points_cache.pop(key, None)
        return None
    return hit[1]


def _points_cache_put(key: tuple[float, float], points: list["AreaDemandPoint"]) -> None:
    now = time.monotonic()
    if len(_points_cache) >= _POINTS_CACHE_MAX_ENTRIES:
        for stale in [k for k, (at, _) in _points_cache.items()
                      if now - at >= _POINTS_CACHE_TTL_SECONDS]:
            _points_cache.pop(stale, None)
        while len(_points_cache) >= _POINTS_CACHE_MAX_ENTRIES:
            _points_cache.pop(min(_points_cache, key=lambda k: _points_cache[k][0]), None)
    _points_cache[key] = (now, points)


def reset_points_cache() -> None:
    """테스트 전용 — 모듈 전역 캐시가 테스트 간에 새지 않게 한다."""
    _points_cache.clear()
    _points_locks.clear()

# ── 지점별 백테스트 캐시 ──────────────────────────────────────────────────────
_quality_cache: dict[tuple[float, float, int, str], tuple[float, dict[str, Any]]] = {}
# 캐시 상한. 한 번의 추천이 훑는 후보 수보다 넉넉해야 의미가 있고, 항목이 작아
# 메모리 부담은 없다. 넘으면 만료분 → 오래된 순으로 버린다.
#
# 64 였을 때의 근거는 "한 번의 추천이 수십 개" 였는데, courses.py 가 자리마다 '지금 서 있는
# 자리' 기준으로 후보를 다시 추리게 되면서 전제가 깨졌다: 2·3번 자리는 누적 도착(도착 +
# COURSE_DWELL_MIN 40~60분)이 항상 live 지평 30분 밖이라 **반드시** 이 이력 경로로 오고,
# 자리당 MAX_COURSE_CANDIDATES(12)씩 → 코스 요청 하나가 24개 안팎의 **새 키**를 밀어 넣는다.
# 64 면 세 번째 요청이 첫 요청의 항목을 밀어내 TTL 30분이 사실상 몇 분으로 줄어든다.
# 256 = 코스 요청 약 10회분. 항목은 (float,float,int,str) 키와 숫자 4개짜리 dict 라
# 256개라도 수십 KB 수준이다(Render 무료 인스턴스에서도 무시할 만하다).
_QUALITY_CACHE_MAX_ENTRIES = 256
_QUALITY_CACHE_TTL_SECONDS = 30 * 60.0


def _aware(value: Any) -> datetime | None:
    try:
        parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def aggregate_nearby_points(
    parents: list[dict[str, Any]],
    lots: list[dict[str, Any]],
    latitude: float,
    longitude: float,
) -> list[AreaDemandPoint]:
    """저장된 주차장 원본을 현재 실시간 계산과 같은 거리·규모 가중으로 재집계한다.

    ⚠️ 이 수식은 이제 **정본이 아니라 대조본**이다. 운영 경로는 같은 계산을 Postgres 에서
    하는 ``area_demand_points_near`` RPC 다(마이그레이션 20260904120000). 여기는
    (1) RPC 가 아직 없는 DB 를 위한 폴백, (2) RPC 가 같은 값을 내는지 잠그는 테스트의
    기준값 두 가지로만 남는다. 한쪽을 바꾸면 반드시 다른 쪽과 대조 테스트도 같이 바꿀 것.
    """
    parent_times: dict[str, datetime] = {}
    for parent in parents:
        observed_at = _aware(parent.get("observed_at"))
        snapshot_id = str(parent.get("id") or "")
        if snapshot_id and observed_at is not None:
            parent_times[snapshot_id] = observed_at

    grouped: dict[str, tuple[float, float, int]] = {}
    for lot in lots:
        snapshot_id = str(lot.get("snapshot_id") or "")
        if snapshot_id not in parent_times:
            continue
        try:
            lot_lat = float(lot["latitude"])
            lot_lng = float(lot["longitude"])
            total = int(lot["total_spaces"])
            available = int(lot["available_spaces"])
        except (KeyError, TypeError, ValueError):
            continue
        if total <= 0 or available < 0 or available > total:
            continue
        distance_m = calculate_haversine_distance(latitude, longitude, lot_lat, lot_lng)
        if distance_m > _RADIUS_M:
            continue
        occupancy = 1.0 - available / total
        weight = min(total, 500) / (1.0 + distance_m / 500.0)
        weighted, weight_total, count = grouped.get(snapshot_id, (0.0, 0.0, 0))
        grouped[snapshot_id] = (
            weighted + occupancy * weight,
            weight_total + weight,
            count + 1,
        )

    points = [
        AreaDemandPoint(parent_times[snapshot_id], _clamp(weighted / weight_total), count)
        for snapshot_id, (weighted, weight_total, count) in grouped.items()
        if weight_total > 0 and count > 0
    ]
    return sorted(points, key=lambda point: point.observed_at)


def _is_weekend(value: datetime) -> bool:
    return value.astimezone(KST).weekday() >= 5


def _clock_minutes(value: datetime) -> int:
    local = value.astimezone(KST)
    return local.hour * 60 + local.minute


def _circular_minutes(a: int, b: int) -> int:
    direct = abs(a - b)
    return min(direct, 24 * 60 - direct)


def forecast_from_points(
    points: list[AreaDemandPoint],
    arrival: datetime,
    *,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """과거 자료만으로 동일 요일군·시간대 중앙값과 제한된 최근 추세를 계산한다."""
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    if arrival.tzinfo is None:
        arrival = arrival.replace(tzinfo=timezone.utc)

    cutoff = now.astimezone(timezone.utc)
    target_clock = _clock_minutes(arrival)
    target_weekend = _is_weekend(arrival)
    eligible = [
        point for point in points
        if point.observed_at.astimezone(timezone.utc) < cutoff
        and _is_weekend(point.observed_at) == target_weekend
        and _circular_minutes(_clock_minutes(point.observed_at), target_clock)
        <= _TIME_WINDOW_MINUTES
    ]
    distinct_dates = {
        point.observed_at.astimezone(KST).date() for point in eligible
    }
    if len(eligible) < _MIN_SAMPLES or len(distinct_dates) < _MIN_DISTINCT_DATES:
        return None
    coverage_days = (
        max(point.observed_at for point in eligible)
        - min(point.observed_at for point in eligible)
    ).total_seconds() / 86_400.0
    if coverage_days < _MIN_COVERAGE_DAYS:
        return None

    baseline = statistics.median(point.level for point in eligible)
    recent_all = [point for point in points if point.observed_at.astimezone(timezone.utc) < cutoff]
    recent_all.sort(key=lambda point: point.observed_at)
    recent_adjustment = 0.0
    # 10분 버킷 3개(최근 30분)와 직전 6개(60분)를 비교한다. 호출 지연이나
    # 전환 전 15분 자료가 섞여도 observed_at 순서를 사용하므로 시간 누수는 없다.
    if len(recent_all) >= 9:
        latest = recent_all[-1]
        freshness = cutoff - latest.observed_at.astimezone(timezone.utc)
        if timedelta(0) <= freshness <= timedelta(minutes=45):
            recent = statistics.median(point.level for point in recent_all[-3:])
            previous = statistics.median(point.level for point in recent_all[-9:-3])
            horizon_minutes = max(0.0, (arrival - now).total_seconds() / 60.0)
            decay = max(0.0, 1.0 - horizon_minutes / 180.0)
            recent_adjustment = max(
                -_MAX_RECENT_ADJUSTMENT,
                min(_MAX_RECENT_ADJUSTMENT, (recent - previous) * decay),
            )

    level = _clamp(baseline + recent_adjustment)
    confidence = "high" if len(eligible) >= 12 and coverage_days >= 21 else "medium"
    return {
        "level": round(level, 4),
        "mode": "forecast",
        "source": "parking_history",
        "sources": ["parking_history"],
        "confidence": confidence,
        "sample_count": len(eligible),
        "distinct_dates": len(distinct_dates),
        "coverage_days": round(coverage_days, 1),
        "bucket_minutes": _BUCKET_MINUTES,
        "observed_at": max(point.observed_at for point in eligible).isoformat(),
        "forecast_for": arrival.isoformat(),
        "baseline_level": round(baseline, 4),
        "recent_adjustment": round(recent_adjustment, 4),
        "radius_m": round(_RADIUS_M),
    }


def _is_missing_points_rpc(exc: BaseException) -> bool:
    """``area_demand_points_near`` 가 아직 없는 DB인가.

    마이그레이션(20260904120000)은 원격 SQL Editor 에서 사람이 적용한다 — 백엔드 배포가
    먼저 나가는 순서가 실제로 가능하다(account.py 의 ``_is_missing_requested_role`` 과 같은
    상황). 그때 이 신호가 통째로 죽으면 **조용히** 나빠진다: 추천 경로는 예외를 삼켜
    ``None`` 을 돌려주므로 권역 수요 근거만 사라진 채 추천이 그대로 나가고, 관리자
    품질 엔드포인트는 503 이 된다. 어느 쪽도 화면에 "지금 데이터가 없다"고 말하지 않는다.
    그래서 이 오류 **하나만** 골라내 기존 파이썬 집계로 폴백한다.
    마이그레이션 적용을 확인하면 폴백 경로(_load_raw_history / aggregate_nearby_points
    호출부)를 지워도 된다.
    """
    text = str(exc).lower()
    if _POINTS_RPC not in text:
        return False
    return (
        "pgrst202" in text
        or "could not find the function" in text
        or "does not exist" in text
        or "schema cache" in text
    )


def _points_from_payload(payload: Any) -> list[AreaDemandPoint]:
    """RPC 의 JSONB 응답을 시계열로 옮긴다. 형식이 깨지면 조용히 비우지 않고 던진다."""
    if isinstance(payload, list):
        payload = payload[0] if payload else None
    if not isinstance(payload, dict):
        raise ValueError(f"{_POINTS_RPC} returned an unexpected payload")
    rows = payload.get("points")
    if not isinstance(rows, list):
        raise ValueError(f"{_POINTS_RPC} returned no points array")
    points: list[AreaDemandPoint] = []
    for row in rows:
        # [관측시각(UTC ISO-8601), 수요 수준, 주차장 수] — 마이그레이션의 jsonb_build_array 순서.
        if not isinstance(row, (list, tuple)) or len(row) < 3:
            raise ValueError(f"{_POINTS_RPC} returned a malformed point")
        observed_at = _aware(row[0])
        if observed_at is None:
            raise ValueError(f"{_POINTS_RPC} returned an unparsable observed_at")
        points.append(AreaDemandPoint(observed_at, _clamp(float(row[1])), int(row[2])))
    # RPC 가 이미 정렬해 주지만, 뒤의 백테스트·최근추세가 순서를 전제하므로 계약으로 고정한다.
    points.sort(key=lambda point: point.observed_at)
    return points


async def _fetch_points_via_rpc(
    latitude: float, longitude: float, now: datetime
) -> list[AreaDemandPoint]:
    since = (now - timedelta(days=_LOOKBACK_DAYS)).astimezone(timezone.utc).isoformat()

    def _call() -> Any:
        return supabase_admin.rpc(_POINTS_RPC, {
            "p_latitude": float(latitude),
            "p_longitude": float(longitude),
            "p_since": since,
            "p_radius_m": _RADIUS_M,
            "p_source": _SOURCE,
        }).execute()

    response = await asyncio.to_thread(_call)
    return _points_from_payload(getattr(response, "data", None))


async def _load_points(
    latitude: float, longitude: float, now: datetime
) -> list[AreaDemandPoint]:
    """이 좌표 기준 시계열을 얻는다(격자 캐시 경유). 미스일 때만 RPC 한 번, 예외적으로 폴백.

    캐시를 여기 두는 이유: 호출부가 여럿이다(코스 슬롯 루프·추천 두 경로). 어느 한 호출부에
    메모를 두면 나머지는 그대로 왕복한다. 그리고 실패는 캐시하지 않는다 — 일시적 장애를
    5분 동안 '데이터 없음' 으로 굳히면 그게 곧 이 저장소가 계속 지적해 온 '실패를 사실로
    파는' 모양이 된다.
    """
    key = _grid_key(latitude, longitude)
    cached = _points_cache_get(key)
    if cached is not None:
        return cached

    lock = _points_locks.setdefault(key, asyncio.Lock())
    async with lock:
        # 락을 기다리는 동안 다른 코루틴이 채웠을 수 있다.
        cached = _points_cache_get(key)
        if cached is not None:
            return cached
        points = await _load_points_uncached(latitude, longitude, now)
        _points_cache_put(key, points)
        return points


async def _load_points_uncached(
    latitude: float, longitude: float, now: datetime
) -> list[AreaDemandPoint]:
    global _rpc_missing_until, _raw_cache
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    if time.monotonic() >= _rpc_missing_until:
        try:
            points = await _fetch_points_via_rpc(latitude, longitude, now)
        except Exception as exc:
            if not _is_missing_points_rpc(exc):
                raise
            _rpc_missing_until = time.monotonic() + _RPC_MISSING_RETRY_SECONDS
            logger.warning("area_demand_points_rpc_missing", error=str(exc))
        else:
            _rpc_missing_until = 0.0
            if _raw_cache is not None:
                # RPC 가 살아 있으면 폴백용 원본(수십 MB)을 붙들고 있을 이유가 없다.
                _raw_cache = None
            return points
    parents, lots = await _load_raw_history(now)
    return aggregate_nearby_points(parents, lots, latitude, longitude)


async def _load_raw_history(now: datetime) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """폴백 전용 — RPC 가 없는 DB 에서만 호출된다.

    5분 TTL 에 stale-while-revalidate 가 없어 만료 직후 한 요청이 갱신 비용을 전부
    뒤집어쓴다. RPC 경로에는 TTL 캐시 자체가 없어 그 문제가 구조적으로 사라지므로,
    여기는 배포 창 한정 임시 경로로 두고 고치지 않는다(마이그레이션 적용 후 삭제 대상).
    """
    global _raw_cache
    monotonic_now = time.monotonic()
    if _raw_cache and monotonic_now - _raw_cache[0] < _CACHE_TTL_SECONDS:
        return _raw_cache[1], _raw_cache[2]
    async with _raw_cache_lock:
        monotonic_now = time.monotonic()
        if _raw_cache and monotonic_now - _raw_cache[0] < _CACHE_TTL_SECONDS:
            return _raw_cache[1], _raw_cache[2]
        cutoff = (now - timedelta(days=_LOOKBACK_DAYS)).isoformat()
        parents = await asyncio.to_thread(
            fetch_all_rows,
            supabase_admin,
            "area_demand_snapshots",
            "id,source,observed_at,bucket_at",
            1000,
            lambda query: query.eq("source", _SOURCE).gte("observed_at", cutoff),
        )
        parent_ids = [str(row["id"]) for row in parents if row.get("id")]
        lots: list[dict[str, Any]] = []
        for offset in range(0, len(parent_ids), 200):
            batch = parent_ids[offset:offset + 200]
            if not batch:
                continue
            lots.extend(await asyncio.to_thread(
                fetch_all_rows,
                supabase_admin,
                "area_demand_snapshot_lots",
                "snapshot_id,source_lot_id,latitude,longitude,total_spaces,available_spaces",
                1000,
                lambda query, ids=batch: query.in_("snapshot_id", ids),
            ))
        _raw_cache = (monotonic_now, parents, lots)
        return parents, lots


async def prefetch_area_demand_points(
    coordinates: list[tuple[float, float]],
    *,
    now: datetime | None = None,
    max_concurrency: int = 6,
) -> int:
    """후보들의 시계열을 **격자 단위로 한 번에** 미리 받아 둔다. 채운 격자 수를 돌려준다.

    왜 필요한가: 캐시만 두면 왕복 수는 격자 수로 줄지만 **여전히 직렬**이다 — 채점이
    후보를 하나씩 돌며 미스마다 한 번씩 기다린다. 슬롯 루프에 들어가기 전에 여기서 한 번에
    병렬로 채워 두면, 채점 경로는 전부 캐시 히트가 되어 왕복 지연이 겹쳐 사라진다.
    (보행 경로를 슬롯당 1회로 묶은 것과 같은 패턴이다.)

    실패는 삼킨다. 예열은 **최적화이지 계약이 아니다** — 여기서 실패해도 채점 경로가 각자
    다시 시도하고, 거기서 실패하면 그때 정직하게 `None`(신호 없음)으로 닫힌다. 예열 실패를
    이유로 코스를 통째로 실패시키면 최적화가 장애 지점이 된다.

    max_concurrency: Render 무료 인스턴스의 단일 워커를 고려한 상한. 격자가 수십 개여도
    동시 왕복은 이 수를 넘지 않는다.
    """
    now = now or datetime.now(timezone.utc)
    unique: list[tuple[float, float]] = []
    seen: set[tuple[float, float]] = set()
    for lat, lng in coordinates:
        key = _grid_key(lat, lng)
        if key in seen or _points_cache_get(key) is not None:
            continue
        seen.add(key)
        unique.append((lat, lng))
    if not unique:
        return 0

    semaphore = asyncio.Semaphore(max(1, max_concurrency))

    async def _one(lat: float, lng: float) -> None:
        async with semaphore:
            try:
                await _load_points(lat, lng, now)
            except Exception as exc:  # noqa: BLE001 — 위 독스트링 참조
                logger.warning("area_demand_prefetch_failed", error=str(exc))

    await asyncio.gather(*(_one(lat, lng) for lat, lng in unique))
    logger.info("area_demand_prefetch", grids=len(unique), requested=len(coordinates))
    return len(unique)


async def get_historical_area_demand_forecast(
    latitude: float,
    longitude: float,
    arrival: datetime,
    *,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """DB 오류나 부족한 표본은 숫자를 만들지 않고 ``None``으로 닫는다."""
    now = now or datetime.now(timezone.utc)
    try:
        points = await _load_points(latitude, longitude, now)
    except Exception as exc:
        # 예전에는 통째로 삼켰다. 실패해도 추천은 나가므로(신호 하나가 빠질 뿐) 계속
        # 닫되, 조용히 사라지지는 않게 남긴다.
        logger.warning("area_demand_points_unavailable", error=str(exc))
        return None
    forecast = forecast_from_points(points, arrival, now=now)
    if forecast is None:
        return None
    # ⚠️ 반드시 스레드로 내보낸다 — 캐시 미스 1건이 이벤트 루프를 **초 단위**로 막는다.
    # (미스 = 56일치 최대 ~8,000점을 2시간 간격으로 슬라이스하며 매번 forecast+median+sort:
    #  이 파일 docstring 의 실측으로 후보당 0.28~6.4초.)
    #
    # 코스 추천이 자리마다 '지금 서 있는 자리' 기준으로 후보를 다시 추리게 되면서 한 요청이
    # 훑는 **서로 다른 좌표**가 3배가 됐고, 캐시 키에 좌표가 들어가는 이상 미스도 그만큼
    # 늘었다. 게다가 2·3번 자리는 누적 도착이 항상 live 지평(30분) 밖이라 **반드시** 이
    # 이력 경로로 온다. Render 무료 플랜은 워커가 하나라 여기서 루프를 잡으면 같은
    # 프로세스의 다른 요청까지 함께 멈춘다(프런트 타임아웃 20초).
    # 결과값은 그대로다 — 바뀌는 것은 '어느 스레드에서 도느냐' 뿐이다.
    quality = await asyncio.to_thread(_cached_backtest, points, latitude, longitude)
    usable = bool(
        quality["sample_count"] >= 30
        and quality["mae"] is not None
        and quality["mae"] <= 0.15
        and quality["improvement_rate"] is not None
        and quality["improvement_rate"] >= 0.20
    )
    if not usable:
        return None
    forecast["validation"] = quality
    return forecast


async def get_area_demand_forecast_quality(
    latitude: float,
    longitude: float,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """해당 권역의 시간 순서 백테스트와 현재 데이터 범위를 반환한다."""
    now = now or datetime.now(timezone.utc)
    points = await _load_points(latitude, longitude, now)
    # 위 get_historical_area_demand_forecast 와 같은 이유로 오프로드한다(같은 비용).
    quality = await asyncio.to_thread(_cached_backtest, points, latitude, longitude)
    if not points:
        return {
            **quality, "usable": False, "point_count": 0,
            "data_from": None, "data_to": None,
        }
    # 공식 모델 승격 기준과 같은 MAE 0.15를 넘으면 사용자 행동 근거로 승격하지 않는다.
    usable = bool(
        quality["sample_count"] >= 30
        and quality["mae"] is not None
        and quality["mae"] <= 0.15
        and quality["improvement_rate"] is not None
        and quality["improvement_rate"] >= 0.20
    )
    return {
        **quality,
        "usable": usable,
        "point_count": len(points),
        "data_from": points[0].observed_at.isoformat(),
        "data_to": points[-1].observed_at.isoformat(),
    }


def backtest_forecast_points(points: list[AreaDemandPoint]) -> dict[str, Any]:
    """시간 순서 홀드아웃 MAE. 각 실제값은 그 시점 이전 관측만 사용한다."""
    predictions: list[tuple[float, float, float]] = []
    ordered = sorted(points, key=lambda point: point.observed_at)
    # 10분 자료와 전환 전 15분 자료가 섞여도 최근 28일을 시간으로 자르고, 실제
    # observed_at 기준 2시간 간격으로만 평가한다. 각 예측은 해당 시점 이전 자료만 사용한다.
    if not ordered:
        return {"sample_count": 0, "mae": None, "baseline_mae": None, "improvement_rate": None}
    eval_cutoff = ordered[-1].observed_at - timedelta(days=28)
    first_eval_index = next(
        (index for index, point in enumerate(ordered) if point.observed_at >= eval_cutoff),
        len(ordered),
    )
    last_eval_at: datetime | None = None
    for index in range(first_eval_index, len(ordered)):
        actual = ordered[index]
        if last_eval_at is not None and actual.observed_at - last_eval_at < timedelta(hours=2):
            continue
        last_eval_at = actual.observed_at
        prior = ordered[:index]
        forecast = forecast_from_points(prior, actual.observed_at, now=actual.observed_at)
        if forecast is None:
            continue
        same_slot = [
            point.level for point in prior
            if _is_weekend(point.observed_at) == _is_weekend(actual.observed_at)
        ]
        if not same_slot:
            continue
        naive = statistics.median(same_slot)
        predictions.append((float(forecast["level"]), actual.level, naive))
    if not predictions:
        return {"sample_count": 0, "mae": None, "baseline_mae": None, "improvement_rate": None}
    mae = sum(abs(predicted - actual) for predicted, actual, _ in predictions) / len(predictions)
    baseline_mae = sum(abs(naive - actual) for _, actual, naive in predictions) / len(predictions)
    improvement = (baseline_mae - mae) / baseline_mae if baseline_mae > 0 else None
    return {
        "sample_count": len(predictions),
        "mae": round(mae, 4),
        "baseline_mae": round(baseline_mae, 4),
        "improvement_rate": round(improvement, 4) if improvement is not None else None,
    }


def _cached_backtest(
    points: list[AreaDemandPoint], latitude: float, longitude: float
) -> dict[str, Any]:
    if not points:
        return backtest_forecast_points(points)
    key = (
        round(latitude, 3),
        round(longitude, 3),
        len(points),
        points[-1].observed_at.isoformat(),
    )
    now = time.monotonic()
    cached = _quality_cache.get(key)
    if cached and now - cached[0] < _QUALITY_CACHE_TTL_SECONDS:
        return cached[1]
    quality = backtest_forecast_points(points)

    # 예전에는 여기서 _quality_cache.clear() 를 했다. 그런데 키에 좌표가 들어가므로
    # (round(lat,3), round(lng,3), ...) 한 번의 추천 안에서도 후보마다 키가 다르고,
    # 항목을 하나만 남기면 **모든 후보가 반드시 빗나간다** — TTL 30분짜리 캐시가 사실상
    # 없는 것과 같았고 비싼 백테스트가 후보 수만큼 돌았다.
    #
    # 키는 그대로 둔다(좌표를 빼면 다른 지점의 결과를 서로 주고받게 된다). 대신 크기만
    # 묶는다: 만료된 항목을 먼저 걷어내고, 그래도 넘치면 오래된 것부터 버린다.
    if len(_quality_cache) >= _QUALITY_CACHE_MAX_ENTRIES:
        for stale_key in [k for k, (at, _) in _quality_cache.items()
                          if now - at >= _QUALITY_CACHE_TTL_SECONDS]:
            _quality_cache.pop(stale_key, None)
        while len(_quality_cache) >= _QUALITY_CACHE_MAX_ENTRIES:
            oldest = min(_quality_cache, key=lambda k: _quality_cache[k][0])
            _quality_cache.pop(oldest, None)

    _quality_cache[key] = (now, quality)
    return quality
