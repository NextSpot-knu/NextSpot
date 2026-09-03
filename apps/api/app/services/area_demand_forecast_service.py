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

# ── 지점별 백테스트 캐시 ──────────────────────────────────────────────────────
_quality_cache: dict[tuple[float, float, int, str], tuple[float, dict[str, Any]]] = {}
# 캐시 상한. 한 번의 추천이 훑는 후보 수(수십)보다 넉넉해야 의미가 있고, 항목이 작아
# 메모리 부담은 없다. 넘으면 만료분 → 오래된 순으로 버린다.
_QUALITY_CACHE_MAX_ENTRIES = 64
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
    """이 좌표 기준 시계열을 얻는다. 기본은 RPC 한 번, 예외적으로 파이썬 폴백."""
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
    quality = _cached_backtest(points, latitude, longitude)
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
    quality = _cached_backtest(points, latitude, longitude)
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
