from datetime import datetime, timedelta, timezone

import pytest

from app.services import area_demand_forecast_service as forecast_svc
from app.services.area_demand_forecast_service import (
    AreaDemandPoint,
    aggregate_nearby_points,
    backtest_forecast_points,
    forecast_from_points,
)


def test_snapshot_lots_are_reaggregated_for_each_candidate_radius():
    parents = [{"id": "s1", "observed_at": "2026-08-01T01:00:00+00:00"}]
    lots = [
        {
            "snapshot_id": "s1", "latitude": 35.8361, "longitude": 129.2105,
            "total_spaces": 100, "available_spaces": 20,
        },
        {
            "snapshot_id": "s1", "latitude": 36.0, "longitude": 129.4,
            "total_spaces": 500, "available_spaces": 500,
        },
    ]
    points = aggregate_nearby_points(parents, lots, 35.8361, 129.2105)
    assert len(points) == 1
    assert points[0].level == pytest.approx(0.8)
    assert points[0].lot_count == 1


def _weekly_points(count: int = 10) -> list[AreaDemandPoint]:
    start = datetime(2026, 5, 4, 1, tzinfo=timezone.utc)  # 월요일 10:00 KST
    return [
        AreaDemandPoint(start + timedelta(days=7 * index), 0.35 + (index % 3) * 0.02, 2)
        for index in range(count)
    ]


def test_forecast_requires_enough_dates_and_never_reads_future_points():
    points = _weekly_points(7)
    now = datetime(2026, 6, 20, tzinfo=timezone.utc)
    future_outlier = AreaDemandPoint(datetime(2026, 6, 29, 1, tzinfo=timezone.utc), 1.0, 2)
    arrival = datetime(2026, 6, 22, 1, tzinfo=timezone.utc)
    forecast = forecast_from_points([*points, future_outlier], arrival, now=now)
    assert forecast is not None
    assert forecast["sample_count"] == 7
    assert forecast["bucket_minutes"] == 10
    assert forecast["level"] < 0.5
    assert forecast["mode"] == "forecast"


def test_forecast_fails_closed_when_history_is_too_short():
    points = _weekly_points(2)
    arrival = datetime(2026, 6, 22, 1, tzinfo=timezone.utc)
    assert forecast_from_points(points, arrival, now=arrival - timedelta(days=1)) is None


def test_backtest_is_time_ordered_and_reports_real_mae_only_when_available():
    quality = backtest_forecast_points(_weekly_points(16))
    assert quality["sample_count"] > 0
    assert quality["mae"] is not None
    assert quality["baseline_mae"] is not None


# ── 백테스트 캐시 — 후보마다 빗나가면 캐시가 아니다 ────────────────────────
# 예전에는 삽입 직전에 _quality_cache.clear() 를 해서 항목이 항상 하나뿐이었다.
# 키에 좌표가 들어가므로 한 번의 추천 안에서도 후보마다 키가 달라, TTL 30분짜리 캐시가
# 사실상 없는 것과 같았고 비싼 백테스트가 후보 수만큼 돌았다.


def _points(n: int = 8) -> list:
    base = datetime(2026, 8, 1, tzinfo=timezone.utc)
    return [
        AreaDemandPoint(observed_at=base + timedelta(hours=i), level=0.4 + 0.01 * i, lot_count=3)
        for i in range(n)
    ]


def test_the_backtest_cache_keeps_more_than_one_candidate():
    forecast_svc._quality_cache.clear()
    pts = _points()
    # 한 번의 추천이 훑는 서로 다른 후보 좌표들.
    for lat, lng in [(35.836, 129.210), (35.840, 129.215), (35.845, 129.220)]:
        forecast_svc._cached_backtest(pts, lat, lng)
    assert len(forecast_svc._quality_cache) == 3, (
        f"후보마다 캐시가 비워진다 — 항목 {len(forecast_svc._quality_cache)}개"
    )


def test_the_same_candidate_hits_the_cache():
    forecast_svc._quality_cache.clear()
    pts = _points()
    first = forecast_svc._cached_backtest(pts, 35.836, 129.210)
    second = forecast_svc._cached_backtest(pts, 35.836, 129.210)
    assert first is second, "같은 후보를 두 번 물었는데 백테스트가 다시 돌았다"


def test_the_cache_stays_bounded():
    """상한이 없으면 좌표마다 항목이 쌓여 무한히 자란다(Render 무료 인스턴스)."""
    forecast_svc._quality_cache.clear()
    pts = _points()
    cap = forecast_svc._QUALITY_CACHE_MAX_ENTRIES
    for i in range(cap + 20):
        forecast_svc._cached_backtest(pts, 35.0 + i * 0.01, 129.0 + i * 0.01)
    assert len(forecast_svc._quality_cache) <= cap
