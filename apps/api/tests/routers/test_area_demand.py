from fastapi import FastAPI
from fastapi.testclient import TestClient

# 관리자 판정은 JWT + users.role 이다(공유 토큰 가드 폐지).
from tests.conftest import admin_headers as conftest_admin_headers

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


# ── 스케줄러(기계) 경로 ──────────────────────────────────────────────────────
# 이 엔드포인트의 실제 주 호출자는 사람이 아니라 GitHub Actions 스케줄러와 Supabase
# pg_cron 이다. RBAC 전환 때 require_role 만 남기는 바람에 둘 다 401 을 받고 **수집이
# 조용히 멈췄다**(응답을 보는 사람이 없어 알림도 없었다). 아래 세 테스트가 그 회귀를 막는다.

def test_snapshot_collection_accepts_service_token(monkeypatch):
    async def collect():
        return {
            "snapshot_id": "snapshot-cron",
            "source": "gyeongju_its",
            "observed_at": "2026-08-28T00:00:00+00:00",
            "bucket_at": "2026-08-28T00:00:00+00:00",
            "total_spaces": 150,
            "available_spaces": 50,
            "live_lot_count": 2,
            "stored": True,
        }

    monkeypatch.setattr(area_demand, "collect_area_demand_snapshot", collect)
    response = _client().post(
        "/api/v1/area-demand/snapshots/collect",
        headers={"X-Service-Token": settings.MACHINE_API_TOKEN},
    )
    assert response.status_code == 200


def test_snapshot_collection_accepts_legacy_scheduler_header(monkeypatch):
    """이미 배포된 호출자(워크플로·pg_cron)가 쓰는 헤더 — 재배포 없이 살아나야 한다."""

    async def collect():
        return {
            "snapshot_id": "snapshot-cron",
            "source": "gyeongju_its",
            "observed_at": "2026-08-28T00:00:00+00:00",
            "bucket_at": "2026-08-28T00:00:00+00:00",
            "total_spaces": 150,
            "available_spaces": 50,
            "live_lot_count": 2,
            "stored": True,
        }

    monkeypatch.setattr(area_demand, "collect_area_demand_snapshot", collect)
    response = _client().post(
        "/api/v1/area-demand/snapshots/collect",
        headers={"X-Admin-Authorization": f"Bearer {settings.MACHINE_API_TOKEN}"},
    )
    assert response.status_code == 200


def test_snapshot_collection_rejects_wrong_service_token():
    response = _client().post(
        "/api/v1/area-demand/snapshots/collect",
        headers={"X-Service-Token": "not-the-token"},
    )
    assert response.status_code == 401


def test_service_token_does_not_open_other_admin_routes():
    """기계 토큰은 이 한 경로 전용이다 — 관리자 API 전체를 열어주면 폐지한 구멍이 되돌아온다."""
    from app.routers import area_demand_admin

    app = FastAPI()
    app.include_router(area_demand_admin.router)
    client = TestClient(app)
    routes = [r for r in area_demand_admin.router.routes if getattr(r, "methods", None)]
    assert routes, "area_demand_admin 라우터에 검사할 경로가 없다"
    path = sorted(r.path for r in routes)[0]
    response = client.get(path, headers={"X-Service-Token": settings.MACHINE_API_TOKEN})
    assert response.status_code in (401, 403)


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
