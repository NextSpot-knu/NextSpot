from datetime import datetime, timezone

import pytest

from app.services import area_demand_reliability_service as reliability


NOW = datetime(2026, 8, 20, 12, 37, tzinfo=timezone.utc)


def _latest():
    return {
        "id": "snapshot-latest",
        "source": "gyeongju_its",
        "observed_at": "2026-08-20T12:31:00+00:00",
        "bucket_at": "2026-08-20T12:30:00+00:00",
        "total_spaces": 300,
        "available_spaces": 120,
        "occupancy": 0.6,
        "live_lot_count": 1,
    }


def _lot():
    return {
        "source_lot_id": "its:1",
        "name": "공영주차장",
        "latitude": 35.84,
        "longitude": 129.21,
        "total_spaces": 300,
        "available_spaces": 120,
        "occupancy": 0.6,
    }


def _patch_queries(monkeypatch, *, rows, earliest, latest, lots=None):
    monkeypatch.setattr(reliability, "_query_window", lambda *_args: rows)
    monkeypatch.setattr(
        reliability,
        "_query_boundary",
        lambda _source, *, latest: latest_value if latest else earliest,
    )
    latest_value = latest
    monkeypatch.setattr(reliability, "_query_lots", lambda _snapshot_id: lots or [])


@pytest.mark.asyncio
async def test_reliability_uses_only_completed_buckets_and_reports_real_gap(monkeypatch):
    rows = [
        {"id": "1", "bucket_at": "2026-08-20T11:30:00+00:00"},
        {"id": "2", "bucket_at": "2026-08-20T11:45:00+00:00"},
        {"id": "3", "bucket_at": "2026-08-20T12:15:00+00:00"},
        # 현재 진행 중 12:30 버킷은 최신값에는 쓰지만 수집률 분모에는 아직 넣지 않는다.
    ]
    _patch_queries(
        monkeypatch,
        rows=rows,
        earliest={"id": "0", "bucket_at": "2026-08-20T11:15:00+00:00"},
        latest=_latest(),
        lots=[_lot()],
    )

    result = await reliability.get_area_demand_reliability(hours=1, now=NOW)

    assert result["history_state"] == "sufficient_history"
    assert result["window"] == {
        "hours": 1,
        "bucket_minutes": 15,
        "start_at": "2026-08-20T11:30:00+00:00",
        "end_at": "2026-08-20T12:30:00+00:00",
        "end_exclusive": True,
        "expected_bucket_count": 4,
        "received_bucket_count": 3,
        "missing_bucket_count": 1,
        "missing_rate": 0.25,
        "missing_buckets": ["2026-08-20T12:00:00+00:00"],
        "longest_gap_buckets": 1,
        "longest_gap_minutes": 15,
        "complete": False,
    }
    assert result["latest"] == {
        "snapshot_id": "snapshot-latest",
        "observed_at": "2026-08-20T12:31:00+00:00",
        "bucket_at": "2026-08-20T12:30:00+00:00",
        "age_minutes": 6.0,
        "freshness_state": "fresh",
        "live_lot_count": 1,
        "total_spaces": 300,
        "available_spaces": 120,
        "occupancy": 0.6,
        "lot_detail_count": 1,
        "lot_details_complete": True,
    }
    assert result["lots"] == [_lot()]


@pytest.mark.asyncio
async def test_reliability_truthfully_marks_short_history(monkeypatch):
    _patch_queries(
        monkeypatch,
        rows=[
            {"id": "1", "bucket_at": "2026-08-20T12:00:00+00:00"},
            {"id": "2", "bucket_at": "2026-08-20T12:15:00+00:00"},
        ],
        earliest={"id": "1", "bucket_at": "2026-08-20T12:00:00+00:00"},
        latest=_latest(),
        lots=[],
    )

    result = await reliability.get_area_demand_reliability(hours=1, now=NOW)

    assert result["history_state"] == "insufficient_history"
    assert result["first_bucket_at"] == "2026-08-20T12:00:00+00:00"
    assert result["window"]["missing_bucket_count"] == 2
    assert result["window"]["longest_gap_minutes"] == 30
    assert result["latest"]["lot_details_complete"] is False


@pytest.mark.asyncio
async def test_reliability_empty_table_returns_no_data_without_values(monkeypatch):
    _patch_queries(monkeypatch, rows=[], earliest=None, latest=None)

    result = await reliability.get_area_demand_reliability(hours=1, now=NOW)

    assert result["history_state"] == "no_data"
    assert result["first_bucket_at"] is None
    assert result["latest"] is None
    assert result["lots"] == []
    assert result["window"]["received_bucket_count"] == 0
    assert result["window"]["missing_bucket_count"] == 4


@pytest.mark.asyncio
async def test_reliability_wraps_missing_table_or_query_failure(monkeypatch):
    def fail(*_args, **_kwargs):
        raise RuntimeError("relation does not exist")

    monkeypatch.setattr(reliability, "_query_window", fail)

    with pytest.raises(reliability.AreaDemandReliabilityError, match="snapshot_query_failed"):
        await reliability.get_area_demand_reliability(hours=24, now=NOW)


@pytest.mark.asyncio
async def test_reliability_rejects_unbounded_window_before_query():
    with pytest.raises(ValueError, match="invalid_reliability_window"):
        await reliability.get_area_demand_reliability(hours=169, now=NOW)
