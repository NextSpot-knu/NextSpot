from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.services import area_demand_snapshot_service as snapshots


class FakeRpc:
    def __init__(self, owner, name, params):
        self.owner = owner
        self.name = name
        self.params = params

    def execute(self):
        self.owner.calls.append(self)
        return SimpleNamespace(data={
            "id": "snapshot-1",
            "source": self.params["p_source"],
            "observed_at": self.params["p_observed_at"],
            "bucket_at": "2026-08-20T12:15:00+00:00",
            "total_spaces": 150,
            "available_spaces": 50,
            "occupancy": 2 / 3,
            "live_lot_count": 2,
            "stored": True,
        })


class FakeSupabase:
    def __init__(self):
        self.calls = []

    def rpc(self, name, params):
        return FakeRpc(self, name, params)


def _observation():
    return {
        "source": "gyeongju_its",
        "observed_at": datetime(2026, 8, 20, 12, 29, 59, tzinfo=timezone.utc),
        "lots": [
            {
                "source_lot_id": "gyeongju-its:87",
                "name": "봉황대공영주차장",
                "latitude": 35.84,
                "longitude": 129.21,
                "total_spaces": 100,
                "available_spaces": 40,
            },
            {
                "source_lot_id": "gyeongju-its:88",
                "name": "중심상가주차장",
                "latitude": 35.842,
                "longitude": 129.213,
                "total_spaces": 50,
                "available_spaces": 10,
            },
        ],
    }


def test_persist_snapshot_uses_transactional_rpc_and_omits_derived_values(monkeypatch):
    fake = FakeSupabase()
    monkeypatch.setattr(snapshots, "supabase_admin", fake)

    result = snapshots._persist_snapshot(_observation())

    assert len(fake.calls) == 1
    call = fake.calls[0]
    assert call.name == "record_area_demand_snapshot"
    assert call.params["p_source"] == "gyeongju_its"
    assert call.params["p_observed_at"] == "2026-08-20T12:29:59+00:00"
    assert "bucket_at" not in call.params
    assert "occupancy" not in call.params
    assert "total_spaces" not in call.params
    assert all("occupancy" not in row for row in call.params["p_lots"])
    assert result["snapshot_id"] == "snapshot-1"
    assert result["stored"] is True


def test_same_quarter_retries_delegate_idempotency_to_single_rpc(monkeypatch):
    fake = FakeSupabase()
    monkeypatch.setattr(snapshots, "supabase_admin", fake)
    first = _observation()
    second = _observation()
    second["observed_at"] = datetime(2026, 8, 20, 12, 16, 1, tzinfo=timezone.utc)

    snapshots._persist_snapshot(first)
    snapshots._persist_snapshot(second)

    assert len(fake.calls) == 2
    assert all(call.name == "record_area_demand_snapshot" for call in fake.calls)
    assert all(set(call.params) == {"p_source", "p_observed_at", "p_lots"} for call in fake.calls)


@pytest.mark.parametrize(
    "observation",
    [
        {"source": "synthetic", "observed_at": datetime.now(timezone.utc), "lots": [{}]},
        {"source": "gyeongju_its", "observed_at": None, "lots": [{}]},
        {"source": "gyeongju_its", "observed_at": datetime.now(timezone.utc), "lots": []},
        {
            "source": "gyeongju_its",
            "observed_at": datetime.now(timezone.utc),
            "lots": [{
                "source_lot_id": "bad",
                "name": "bad",
                "latitude": 35.8,
                "longitude": 129.2,
                "total_spaces": 10,
                "available_spaces": 11,
            }],
        },
    ],
)
def test_persist_snapshot_rejects_non_factual_or_incomplete_observation(monkeypatch, observation):
    fake = FakeSupabase()
    monkeypatch.setattr(snapshots, "supabase_admin", fake)

    with pytest.raises(snapshots.SnapshotPersistenceError, match="invalid_snapshot_observation"):
        snapshots._persist_snapshot(observation)

    assert fake.calls == []
