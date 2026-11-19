"""실시간 데이터 리허설(서울 검증) 화면·API 는 developer 전용이다(2026-10-31 사용자 결정 1).

admin 은 외부 기관 관제 역할이고, 심사위원이 함께 쓰는 공용 데모 계정(authz.JUDGE_ADMIN_EMAIL)도 admin 이다 —
서울 대상지 이름·측정 단계·인원 범위·대안 추천·구역 관측 어느 것도 admin 에게 내보내지 않는다.
pg_cron 수집(기계 토큰)은 그대로 열린다.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core import authz
from app.core.config import settings
from app.routers import engine_validation, engine_validation_admin, engine_validation_calibration
from app.services import seoul_citydata_service as seoul
from tests.conftest import role_headers

SEOUL_READS = (
    ("GET", "/api/v1/admin/engine-validation/seoul/summary"),
    ("GET", "/api/v1/admin/engine-validation/seoul/alternatives"),
    ("GET", "/api/v1/admin/engine-validation/seoul/calibration"),
    ("GET", "/api/v1/engine-validation/seoul/status"),
    ("POST", "/api/v1/engine-validation/seoul/collect"),
)


def _client() -> TestClient:
    app = FastAPI()
    for module in (engine_validation, engine_validation_admin, engine_validation_calibration):
        app.include_router(module.router)
    return TestClient(app)


@pytest.mark.parametrize("method,path", SEOUL_READS)
@pytest.mark.parametrize(
    "headers",
    [
        pytest.param(lambda: role_headers("admin"), id="admin"),
        pytest.param(lambda: role_headers("admin", email=authz.JUDGE_ADMIN_EMAIL), id="judge-admin"),
        pytest.param(lambda: role_headers("merchant"), id="merchant"),
        pytest.param(lambda: role_headers("tourist"), id="tourist"),
        pytest.param(lambda: role_headers("developer", is_anonymous=True), id="anonymous-developer"),
    ],
)
def test_non_developers_get_403(method, path, headers):
    response = _client().request(method, path, headers=headers())
    assert response.status_code == 403, response.text
    assert "홍대" not in response.text and "seoul" not in response.text.lower()


def test_developer_reaches_status(monkeypatch):
    async def latest(targets):
        return {name: None for name in targets}

    monkeypatch.setattr(seoul, "latest_rows", latest)
    response = _client().get("/api/v1/engine-validation/seoul/status", headers=role_headers("developer"))
    assert response.status_code == 200


def test_machine_token_still_collects(monkeypatch):
    async def collect():
        return {
            "state": "ok", "run_at": "x", "bucket_at": "x", "estimator_version": "v",
            "stored_count": 0, "failed_count": 0, "targets": [],
        }

    monkeypatch.setattr(seoul, "collect_seoul_citydata", collect)
    response = _client().post(
        "/api/v1/engine-validation/seoul/collect",
        headers={"X-Admin-Authorization": f"Bearer {settings.MACHINE_API_TOKEN}"},
    )
    assert response.status_code == 200
