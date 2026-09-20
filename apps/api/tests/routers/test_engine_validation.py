"""서울 검증 수집 라우터 — 가드(기계/관리자)·오류 코드·키 비노출.

main.py 등록은 이 파일의 범위 밖이라 라우터만 올린 로컬 FastAPI 앱으로 검사한다.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from tests.conftest import admin_headers, make_test_jwt

from app.core.config import settings
from app.routers import engine_validation
from app.services import seoul_citydata_service as seoul

COLLECT = "/api/v1/engine-validation/seoul/collect"
STATUS = "/api/v1/engine-validation/seoul/status"
FAKE_KEY = "SEOULKEY0123456789abcdef"


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(engine_validation.router)
    return TestClient(app)


def _machine() -> dict:
    return {"X-Admin-Authorization": f"Bearer {settings.MACHINE_API_TOKEN}"}


def _ok_result(state: str = "ok") -> dict:
    stored = {
        "area_nm": "홍대 관광특구", "state": "stored", "error_code": None, "upstream_code": None,
        "area_cd": "POI055", "bucket_at": "2026-09-20T05:40:00+00:00",
        "observed_at": "2026-09-20T14:30:00+09:00", "congest_lvl": "보통",
        "live_lot_count": 2, "stale_lot_count": 0,
        "parking_level": 0.61, "tourism_level": None, "level_est": 0.61,
    }
    targets = [stored]
    if state == "partial":
        targets.append({"area_nm": "광화문·덕수궁", "state": "failed", "error_code": "seoul_timeout", "upstream_code": None})
    return {
        "state": state, "run_at": "2026-09-20T05:44:00+00:00", "bucket_at": "2026-09-20T05:40:00+00:00",
        "estimator_version": seoul.ESTIMATOR_VERSION,
        "stored_count": 1, "failed_count": len(targets) - 1, "targets": targets,
    }


def test_collect_requires_auth():
    assert _client().post(COLLECT).status_code == 401


def test_collect_rejects_tourist():
    headers = {"Authorization": f"Bearer {make_test_jwt('bbbbbbbb-0000-4000-8000-0000000tour1')}"}
    assert _client().post(COLLECT, headers=headers).status_code == 403


def test_collect_accepts_pg_cron_header_service_token_and_admin(monkeypatch):
    async def collect():
        return _ok_result()

    monkeypatch.setattr(seoul, "collect_seoul_citydata", collect)
    client = _client()
    for headers in (_machine(), {"X-Service-Token": settings.MACHINE_API_TOKEN}, admin_headers()):
        response = client.post(COLLECT, headers=headers)
        assert response.status_code == 200, headers
        assert response.json()["targets"][0]["area_cd"] == "POI055"


def test_collect_rejects_wrong_service_token():
    assert _client().post(COLLECT, headers={"X-Service-Token": "not-the-token"}).status_code == 401


def test_collect_without_key_is_503_seoul_key_missing(monkeypatch):
    monkeypatch.setattr(settings, "SEOUL_OPENDATA_KEY", "")
    seoul.reset_state()
    response = _client().post(COLLECT, headers=_machine())
    assert response.status_code == 503
    assert response.json()["detail"] == "seoul_key_missing"


def test_collect_missing_table_is_409(monkeypatch):
    async def collect():
        raise seoul.SeoulSnapshotPersistenceError("migration_not_applied")

    monkeypatch.setattr(seoul, "collect_seoul_citydata", collect)
    response = _client().post(COLLECT, headers=_machine())
    assert response.status_code == 409
    assert response.json()["detail"] == "migration_not_applied"


def test_collect_all_targets_failed_is_503_with_the_target_code(monkeypatch):
    async def collect():
        return {
            "state": "failed", "run_at": "x", "bucket_at": "x", "estimator_version": "v",
            "stored_count": 0, "failed_count": 1,
            "targets": [{"area_nm": "홍대 관광특구", "state": "failed",
                         "error_code": "seoul_key_invalid", "upstream_code": "INFO-100"}],
        }

    monkeypatch.setattr(seoul, "collect_seoul_citydata", collect)
    response = _client().post(COLLECT, headers=_machine())
    assert response.status_code == 503
    assert response.json()["detail"] == "seoul_key_invalid"


def test_collect_partial_is_200(monkeypatch):
    async def collect():
        return _ok_result("partial")

    monkeypatch.setattr(seoul, "collect_seoul_citydata", collect)
    response = _client().post(COLLECT, headers=_machine())
    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "partial"
    assert body["targets"][1]["error_code"] == "seoul_timeout"


def test_status_is_admin_only():
    client = _client()
    assert client.get(STATUS).status_code == 401
    # 상태 화면은 사람 전용이다 — 기계 토큰은 수집만 연다.
    assert client.get(STATUS, headers=_machine()).status_code == 401


def test_status_reports_key_presence_only(monkeypatch):
    monkeypatch.setattr(settings, "SEOUL_OPENDATA_KEY", FAKE_KEY)
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", "홍대 관광특구")
    seoul.reset_state()

    async def latest(targets):
        return {name: {"area_nm": name, "area_cd": "POI055", "bucket_at": "2026-09-20T05:40:00+00:00"} for name in targets}

    monkeypatch.setattr(seoul, "latest_rows", latest)
    response = _client().get(STATUS, headers=admin_headers())
    assert response.status_code == 200
    body = response.json()
    assert body["key_configured"] is True
    assert body["targets"] == ["홍대 관광특구"]
    assert body["latest"]["홍대 관광특구"]["area_cd"] == "POI055"
    assert body["last_run"]["state"] == "not_run"
    assert FAKE_KEY not in response.text


def test_status_missing_table_is_409(monkeypatch):
    async def latest(_targets):
        raise seoul.SeoulSnapshotPersistenceError("migration_not_applied")

    monkeypatch.setattr(seoul, "latest_rows", latest)
    response = _client().get(STATUS, headers=admin_headers())
    assert response.status_code == 409
    assert response.json()["detail"] == "migration_not_applied"
