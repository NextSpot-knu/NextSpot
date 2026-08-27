from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.config import settings
from app.routers import area_demand_admin
from app.services.area_demand_reliability_service import AreaDemandReliabilityError


def _client():
    app = FastAPI()
    app.include_router(area_demand_admin.router)
    return TestClient(app)


def _headers():
    return {"X-Admin-Authorization": f"Bearer {settings.ADMIN_API_TOKEN}"}


def test_area_demand_reliability_requires_admin_header():
    assert _client().get("/api/v1/admin/area-demand-reliability").status_code == 401


def test_area_demand_reliability_returns_service_contract(monkeypatch):
    expected = {
        "source": "gyeongju_its",
        "history_state": "no_data",
        "first_bucket_at": None,
        "window": {"expected_bucket_count": 96},
        "latest": None,
        "lots": [],
    }

    async def get_reliability(*, source, hours):
        assert source == "gyeongju_its"
        assert hours == 24
        return expected

    monkeypatch.setattr(area_demand_admin, "get_area_demand_reliability", get_reliability)
    response = _client().get(
        "/api/v1/admin/area-demand-reliability",
        headers=_headers(),
    )

    assert response.status_code == 200
    assert response.json() == expected


def test_area_demand_reliability_bounds_window():
    response = _client().get(
        "/api/v1/admin/area-demand-reliability?hours=169",
        headers=_headers(),
    )
    assert response.status_code == 422


def test_area_demand_reliability_query_failure_is_safe_503(monkeypatch):
    async def fail(**_kwargs):
        raise AreaDemandReliabilityError("snapshot_query_failed")

    monkeypatch.setattr(area_demand_admin, "get_area_demand_reliability", fail)
    response = _client().get(
        "/api/v1/admin/area-demand-reliability",
        headers=_headers(),
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "area_demand_reliability_unavailable"}
