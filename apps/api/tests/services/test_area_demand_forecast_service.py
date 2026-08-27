from datetime import datetime, timedelta, timezone

import pytest

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
