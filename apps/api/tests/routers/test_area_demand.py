from fastapi import FastAPI
from fastapi.testclient import TestClient

# 관리자 판정은 JWT + users.role 이다(공유 토큰 가드 폐지).
from tests.conftest import admin_headers as conftest_admin_headers

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
        headers=conftest_admin_headers(),
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
        headers=conftest_admin_headers(),
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "city_its_unavailable"}


def test_snapshot_collection_reports_persistence_failure(monkeypatch):
    async def fail():
        raise SnapshotPersistenceError("snapshot_persistence_failed")

    monkeypatch.setattr(area_demand, "collect_area_demand_snapshot", fail)
    response = _client().post(
        "/api/v1/area-demand/snapshots/collect",
        headers=conftest_admin_headers(),
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "snapshot_persistence_failed"}


def test_parking_lots_returns_official_positions_and_nullable_live_counts(monkeypatch):
    async def lots(lat, lng, *, radius_m):
        assert (lat, lng, radius_m) == (35.8361, 129.2105, 3000.0)
        return {
            "available": True,
            "state": "available",
            "source": "gyeongju_its",
            "radius_m": 3000,
            "observed_at": "2026-08-21T01:00:00+00:00",
            "lots": [{
                "id": "gyeongju-its:1",
                "name": "공영주차장",
                "latitude": 35.836,
                "longitude": 129.21,
                "distance_m": 52,
                "total_spaces": 100,
                "available_spaces": 23,
                "occupancy": 0.77,
                "live": True,
                "observed_at": "2026-08-21T01:00:00+00:00",
                "source": "gyeongju_its",
            }],
        }

    monkeypatch.setattr(area_demand, "get_nearby_parking_lots", lots)
    response = _client().get("/api/v1/area-demand/parking-lots")
    assert response.status_code == 200
    body = response.json()
    assert body["radius_m"] == 3000
    assert body["lots"][0]["available_spaces"] == 23
    assert body["lots"][0]["source"] == "gyeongju_its"
