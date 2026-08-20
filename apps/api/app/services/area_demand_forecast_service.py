"""15분 주차 실측 이력으로 주변 권역 수요를 보수적으로 전망한다.

장소 내부 좌석이나 대기시간을 예측하지 않는다. 동일한 반경 2km 안의 주차장 원본을
시점별로 다시 집계하고, 과거의 같은 요일군·시간대 표본이 충분할 때만 상대 수요 수준을
반환한다. 모든 학습 표본은 전망 시점보다 과거여야 하므로 시간 순서 누수를 허용하지 않는다.
"""

from __future__ import annotations

import asyncio
import statistics
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from app.core.supabase import fetch_all_rows, supabase_admin
from app.services.spot.travel import calculate_haversine_distance
from app.services.travel_context import KST

_RADIUS_M = 2_000.0
_LOOKBACK_DAYS = 56
_CACHE_TTL_SECONDS = 5 * 60.0
_MIN_SAMPLES = 6
_MIN_DISTINCT_DATES = 3
_MIN_COVERAGE_DAYS = 7
_TIME_WINDOW_MINUTES = 30
_MAX_RECENT_ADJUSTMENT = 0.08


@dataclass(frozen=True)
class AreaDemandPoint:
    observed_at: datetime
    level: float
    lot_count: int


_raw_cache: tuple[float, list[dict[str, Any]], list[dict[str, Any]]] | None = None
_raw_cache_lock = asyncio.Lock()
_quality_cache: dict[tuple[float, float, int, str], tuple[float, dict[str, Any]]] = {}
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
    """저장된 주차장 원본을 현재 실시간 계산과 같은 거리·규모 가중으로 재집계한다."""
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
    if len(recent_all) >= 6:
        latest = recent_all[-1]
        freshness = cutoff - latest.observed_at.astimezone(timezone.utc)
        if timedelta(0) <= freshness <= timedelta(minutes=45):
            recent = statistics.median(point.level for point in recent_all[-2:])
            previous = statistics.median(point.level for point in recent_all[-6:-2])
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
        "observed_at": max(point.observed_at for point in eligible).isoformat(),
        "forecast_for": arrival.isoformat(),
        "baseline_level": round(baseline, 4),
        "recent_adjustment": round(recent_adjustment, 4),
        "radius_m": round(_RADIUS_M),
    }


async def _load_raw_history(now: datetime) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
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
            lambda query: query.eq("source", "gyeongju_its").gte("observed_at", cutoff),
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
        parents, lots = await _load_raw_history(now)
    except Exception:
        return None
    points = aggregate_nearby_points(parents, lots, latitude, longitude)
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
    parents, lots = await _load_raw_history(now)
    points = aggregate_nearby_points(parents, lots, latitude, longitude)
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
    # 15분 단위 56일 전체를 매번 O(n²)로 평가하면 추천 후보 수만큼 첫 응답이 느려진다.
    # 최근 28일에서 2시간 간격의 시간순 홀드아웃만 뽑아도 요일·시간대를 모두 포함하며,
    # 각 예측은 여전히 해당 시점 이전의 전체 관측만 사용한다.
    first_eval_index = max(0, len(ordered) - 28 * 24 * 4)
    for index in range(first_eval_index, len(ordered), 8):
        actual = ordered[index]
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
    _quality_cache.clear()
    _quality_cache[key] = (now, quality)
    return quality
