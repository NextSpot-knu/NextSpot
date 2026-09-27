"""프로세스 안의 쓰기가 지도 참조 스냅샷에 알리는지(mark_dirty) — 도입 전엔 다음 지도 요청이 DB 를 곧바로
읽었으므로, 알림이 빠진 쓰기는 '방금 쓴 값이 지도에 안 보인다' 는 회귀가 된다(최대 60초 탐침까지).
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from tests.conftest import admin_headers
from tests.routers.test_routers import FakeSupabase, FakeTable, _FakeResult

from app.core.supabase import get_current_user
from app.routers import admin, infrastructures, merchant, recommendations, reports
from app.services import reference_snapshot


@pytest.fixture
def marks(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(reference_snapshot, "mark_dirty", calls.append)
    return calls


def _app(*routers) -> TestClient:
    app = FastAPI()
    for router in routers:
        app.include_router(router)
    return TestClient(app)


_FACILITY = {"id": "f-1", "name": "시설", "type": "cafe", "latitude": 35.83, "longitude": 129.21,
             "capacity": 50, "coupon_rate": 0.0, "features": {}}


def test_admin_facility_crud_marks_facilities(marks):
    client = _app(admin.router)
    with patch.object(admin, "supabase_admin", new=FakeSupabase({"facilities": [_FACILITY]})):
        assert client.post("/api/v1/admin/facilities", headers=admin_headers(), json={
            "name": "새 시설", "type": "cafe", "latitude": 35.83, "longitude": 129.21, "capacity": 10,
        }).status_code == 200
        assert client.patch(
            "/api/v1/admin/facilities/f-1", headers=admin_headers(), json={"name": "바뀜"}
        ).status_code == 200
        assert client.delete("/api/v1/admin/facilities/f-1", headers=admin_headers()).status_code == 200
    assert marks == ["facilities", "facilities", "facilities"]


def test_admin_facility_write_failure_does_not_mark(marks):
    client = _app(admin.router)
    with patch.object(admin, "supabase_admin", new=FakeSupabase({"facilities": []})):
        res = client.patch("/api/v1/admin/facilities/ghost", headers=admin_headers(), json={"name": "x"})
    assert res.status_code == 404
    assert marks == []


def test_admin_congestion_override_marks_congestion(marks):
    client = _app(admin.router)
    inserted = {"id": "log-1", "facility_id": "f-1", "congestion_level": 0.8}
    with patch.object(admin, "supabase_admin",
                      new=FakeSupabase({"facilities": [_FACILITY], "congestion_logs": [inserted]})):
        res = client.post("/api/v1/admin/facilities/f-1/congestion", headers=admin_headers(), json={"level": 0.8})
    assert res.status_code == 200
    assert marks == ["congestion"]


def test_simulate_peak_marks_congestion_once_after_all_chunks(marks):
    class _Admin:
        def table(self, _name):
            return self

        def insert(self, rows):
            self._rows = rows
            return self

        def execute(self):
            return _FakeResult(self._rows)

    facilities = [{"id": f"s-{i}", "name": "n", "type": "cafe", "capacity": 10} for i in range(1200)]
    client = _app(infrastructures.router)
    with patch.object(infrastructures, "supabase_client", new=FakeSupabase({"facilities": facilities})), \
         patch.object(infrastructures, "supabase_admin", new=_Admin()):
        res = client.post("/api/v1/admin/simulate-peak", headers=admin_headers())
    assert res.status_code == 200
    assert marks == ["congestion"]


@pytest.fixture
def user_client():
    app = FastAPI()
    app.include_router(reports.router)
    app.dependency_overrides[get_current_user] = lambda: {"id": "u-1", "email": None, "role": "authenticated"}
    reports._last_report_at.clear()
    reports._last_availability_report_at.clear()
    yield TestClient(app)
    reports._last_report_at.clear()
    reports._last_availability_report_at.clear()


def test_congestion_report_marks_congestion(marks, user_client):
    with patch.object(reports, "supabase_admin",
                      new=FakeSupabase({"facilities": [_FACILITY], "congestion_logs": [{"id": "log-1"}],
                                        "users": [{"report_count": 0}]})), \
         patch.object(reports, "_bump_report_count", new=AsyncMock(return_value=1)):
        res = user_client.post("/api/v1/reports/congestion", json={"facility_id": "f-1", "level": "혼잡"})
    assert res.status_code == 200
    assert marks == ["congestion"]


def test_availability_report_marks_availability(marks, user_client):
    class _Availability(FakeSupabase):
        def rpc(self, _name, _params):
            return FakeTable([{
                "facility_id": "f-1", "status": "open", "evidence_tier": "single_report",
                "corroborating_count": 1, "reported_at": "2026-09-27T03:00:00+00:00",
                "expires_at": "2026-09-27T03:30:00+00:00",
            }])

    with patch.object(reports, "supabase_admin", new=_Availability({"facilities": [{"id": "f-1"}]})):
        res = user_client.post("/api/v1/reports/availability", json={"facility_id": "f-1", "status": "open"})
    assert res.status_code == 200
    assert marks == ["availability"]


def test_merchant_seat_broadcast_marks_facilities(marks):
    profile = {"id": "00000000-0000-0000-0000-0000000000f1", "email": "o@example.com", "is_anonymous": False,
               "role": "merchant", "facility_ids": frozenset({"f-1"})}
    client = _app(merchant.router)
    with patch.object(merchant, "load_profile_from_request", new=AsyncMock(return_value=profile)), \
         patch.object(merchant, "require_merchant_console_enabled", new=AsyncMock(return_value=None)), \
         patch.object(merchant, "supabase_admin", new=FakeSupabase({"facilities": [{"id": "f-1", "features": {}}]})):
        res = client.post("/api/v1/merchant/seat-status", headers={"Authorization": "Bearer t"},
                          json={"facility_id": "f-1", "level": None})
    assert res.status_code == 200
    assert marks == ["facilities"]            # 해제는 관측 로그를 남기지 않는다


@pytest.mark.parametrize("observed, expected", [("busy", ["congestion"]), (None, [])])
def test_outcome_with_observed_congestion_marks_congestion(marks, monkeypatch, observed, expected):
    class _Rpc:
        def rpc(self, _name, _payload):
            return self

        def execute(self):
            return SimpleNamespace(data={"ok": True})

    app = FastAPI()
    app.include_router(recommendations.router)
    app.dependency_overrides[get_current_user] = lambda: {"id": "11111111-1111-4111-8111-111111111111"}
    monkeypatch.setattr(recommendations, "supabase_client", _Rpc())
    monkeypatch.setattr(recommendations, "resolve_feedback_target", AsyncMock(return_value=({}, {})))
    body = {"stage": "rated", "rating": "up"}
    if observed:
        body["observed_congestion"] = observed
    res = TestClient(app).patch("/api/v1/recommendations/22222222-2222-4222-8222-222222222222/outcome", json=body)
    assert res.status_code == 200
    assert marks == expected
