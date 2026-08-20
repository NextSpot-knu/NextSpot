from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import area_demand


def test_area_demand_status_exposes_coverage_not_secret(monkeypatch):
    async def status(_lat: float, _lng: float):
        return {
            "configured": True,
            "national_api_configured": True,
            "source": "gyeongju_its",
            "state": "available",
            "available": True,
            "gyeongju_facility_count": 8,
            "gyeongju_realtime_count": 5,
            "nearby_realtime_count": 2,
            "total_spaces": 180,
            "available_spaces": 42,
            "facility_checked_at": "2026-08-20T00:00:00+00:00",
            "realtime_checked_at": "2026-08-20T00:05:00+00:00",
            "facility_error_code": None,
            "realtime_error_code": None,
        }

    monkeypatch.setattr(area_demand, "get_parking_coverage_status", status)
    app = FastAPI()
    app.include_router(area_demand.router)
    response = TestClient(app).get("/api/v1/area-demand/status?lat=35.84&lng=129.21")

    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "surrounding_area_demand"
    assert body["venue_congestion"] is False
    assert body["parking"]["nearby_realtime_count"] == 2
    assert "key" not in response.text.lower()


def test_area_demand_status_rejects_invalid_coordinates():
    app = FastAPI()
    app.include_router(area_demand.router)
    response = TestClient(app).get("/api/v1/area-demand/status?lat=91&lng=129.21")
    assert response.status_code == 422
