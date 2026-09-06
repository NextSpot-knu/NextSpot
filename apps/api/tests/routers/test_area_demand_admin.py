from fastapi import FastAPI
from fastapi.testclient import TestClient

# 관리자 판정은 JWT + users.role 이다(공유 토큰 가드 폐지).
from tests.conftest import admin_headers as conftest_admin_headers

from app.routers import area_demand_admin
from app.services.area_demand_reliability_service import AreaDemandReliabilityError


def _client():
    app = FastAPI()
    app.include_router(area_demand_admin.router)
    return TestClient(app)


def _headers():
    return conftest_admin_headers()


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


# =============================================================================
# 수집이 죽었을 때 알 수 있는가
# =============================================================================
# pg_cron 은 net.http_post 로 발사 후 잊는다 — API 가 401 을 줘도 cron.job_run_details 에는
# succeeded 로 남는다. 그래서 '스케줄러가 돌았는가' 는 수집이 살아 있다는 증거가 못 되고,
# 유일하게 믿을 수 있는 신호는 **새 스냅샷이 실제로 쌓였는가** 다.


def _latest(age_minutes: float) -> dict:
    return {"age_minutes": age_minutes, "freshness_state": "fresh"}


def test_alert_is_down_when_snapshots_stopped():
    from app.services.area_demand_reliability_service import _alert

    verdict = _alert(latest_payload=_latest(120.0), missing_rate=0.0, history_state="sufficient_history")
    assert verdict["state"] == "down", verdict
    assert verdict["reason"] == "stale_snapshot"
    assert verdict["age_minutes"] == 120.0


def test_alert_tolerates_one_missed_bucket():
    """재시도 cron 이 :06/:16/… 에 한 번 더 두드리므로 일시적 실패는 다음 버킷에서 메워진다.

    한 번 놓칠 때마다 울리면 사람이 경보를 끄는 법부터 배운다.
    """
    from app.services.area_demand_reliability_service import _alert

    verdict = _alert(latest_payload=_latest(12.0), missing_rate=0.0, history_state="sufficient_history")
    assert verdict["state"] == "ok", verdict


def test_alert_flags_intermittent_failure_even_while_alive():
    """지금은 살아 있어도 창 전체에서 자주 빠지면 사람이 봐야 한다."""
    from app.services.area_demand_reliability_service import _alert

    verdict = _alert(latest_payload=_latest(5.0), missing_rate=0.5, history_state="sufficient_history")
    assert verdict["state"] == "degraded", verdict
    assert verdict["reason"] == "missing_buckets"


def test_alert_does_not_cry_on_a_fresh_deployment():
    """표가 비어 있는 것과 수집이 죽은 것은 다르다."""
    from app.services.area_demand_reliability_service import _alert

    verdict = _alert(latest_payload=None, missing_rate=0.0, history_state="no_data")
    assert verdict["state"] == "unknown", verdict
    # 반대로 이력이 있는데 최신 스냅샷이 없으면 그건 죽은 것이다.
    lost = _alert(latest_payload=None, missing_rate=0.0, history_state="sufficient_history")
    assert lost["state"] == "down", lost


def test_reliability_accepts_the_scheduler_token(monkeypatch):
    """경보 스케줄러가 폴링할 수 있어야 한다 — 사람이 안 보고 있을 때 알아야 의미가 있다."""
    from app.core.config import settings

    async def _fake(**_kwargs):
        return {"source": "gyeongju_its", "alert": {"state": "ok", "reason": None, "age_minutes": 3.0}}

    monkeypatch.setattr(area_demand_admin, "get_area_demand_reliability", _fake)
    res = _client().get(
        "/api/v1/admin/area-demand-reliability",
        headers={"X-Service-Token": settings.MACHINE_API_TOKEN},
    )
    assert res.status_code == 200, res.text
    assert res.json()["alert"]["state"] == "ok"


def test_forecast_quality_stays_human_only():
    """경보에 쓰지 않는 엔드포인트까지 기계에 열지 않는다."""
    from app.core.config import settings

    res = _client().get(
        "/api/v1/admin/area-demand-forecast-quality",
        headers={"X-Service-Token": settings.MACHINE_API_TOKEN},
    )
    assert res.status_code == 401, res.text
