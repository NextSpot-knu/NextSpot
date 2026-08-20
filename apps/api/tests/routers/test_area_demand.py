from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.config import settings
from app.routers import area_demand
from app.services.area_demand_snapshot_service import SnapshotPersistenceError
from app.services.parking_demand_service import ParkingUpstreamError


def _client():
    app = FastAPI()
    app.include_router(area_demand.router)
    return TestClient(app)


def test_snapshot_collection_requires_admin_header():
    response = _client().post("/api/v1/area-demand/snapshots/collect")
    assert response.status_code == 401


def test_snapshot_collection_returns_only_factual_counts(monkeypatch):
    async def collect():
        return {
            "snapshot_id": "snapshot-1",
            "source": "gyeongju_its",
            "observed_at": "2026-08-20T12:29:59+00:00",
            "bucket_at": "2026-08-20T12:15:00+00:00",
            "total_spaces": 150,
            "available_spaces": 50,
            "live_lot_count": 2,
            "stored": True,
        }

    monkeypatch.setattr(area_demand, "collect_area_demand_snapshot", collect)
    response = _client().post(
        "/api/v1/area-demand/snapshots/collect",
        headers={"X-Admin-Authorization": f"Bearer {settings.ADMIN_API_TOKEN}"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "state": "collected",
        "snapshot_id": "snapshot-1",
        "source": "gyeongju_its",
        "observed_at": "2026-08-20T12:29:59+00:00",
        "bucket_at": "2026-08-20T12:15:00+00:00",
        "total_spaces": 150,
        "available_spaces": 50,
        "live_lot_count": 2,
        "stored": True,
    }


def test_snapshot_collection_reports_upstream_failure_without_fake_row(monkeypatch):
    async def fail():
        raise ParkingUpstreamError("city_its_unavailable")

    monkeypatch.setattr(area_demand, "collect_area_demand_snapshot", fail)
    response = _client().post(
        "/api/v1/area-demand/snapshots/collect",
        headers={"X-Admin-Authorization": f"Bearer {settings.ADMIN_API_TOKEN}"},
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "city_its_unavailable"}


def test_snapshot_collection_reports_persistence_failure(monkeypatch):
    async def fail():
        raise SnapshotPersistenceError("snapshot_persistence_failed")

    monkeypatch.setattr(area_demand, "collect_area_demand_snapshot", fail)
    response = _client().post(
        "/api/v1/area-demand/snapshots/collect",
        headers={"X-Admin-Authorization": f"Bearer {settings.ADMIN_API_TOKEN}"},
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "snapshot_persistence_failed"}
