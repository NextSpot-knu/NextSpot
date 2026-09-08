"""주차 파생 혼잡 추정 라우터 — 인증 가드·오류 번역·응답 계약.

 · main.py 는 소유 파일 밖(배선은 별도 작업)이라, 이 라우터만 얹은 로컬 FastAPI 앱으로
   테스트한다(tests/routers/test_impact.py 와 같은 패턴·같은 이유).
 · 관리자 판정은 실제 JWT 경로를 그대로 태운다(conftest 의 admin_headers).
 · DB·외부 호출은 서비스 함수를 패치해 차단한다 — PostgREST 호출이 발생하지 않는다.
"""
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tests.conftest import admin_headers, make_test_jwt
from app.routers import congestion_estimates
from app.services.parking_derived_congestion_service import ParkingDerivedError

PREVIEW = "/api/v1/admin/congestion-estimates/parking-derived/preview"
RECORD = "/api/v1/admin/congestion-estimates/parking-derived"

_SUMMARY = {
    "source": "parking_derived",
    "evidence_tier": "synthetic",
    "is_estimate": True,
    "estimated_facilities": 806,
    "skipped_no_parking": 847,
    "status": "recorded",
    "inserted": 806,
}


@pytest.fixture
def client():
    test_app = FastAPI()
    test_app.include_router(congestion_estimates.router)
    with TestClient(test_app) as c:
        yield c


# =========================================================================
# 인증 가드
# =========================================================================

def test_record_requires_authentication(client):
    assert client.post(RECORD).status_code == 401


def test_preview_requires_authentication(client):
    assert client.get(PREVIEW).status_code == 401


def test_record_rejects_non_admin(client):
    """일반 사용자 토큰으로는 적재할 수 없다 — 이 표에 행을 넣는 경로다."""
    headers = {"Authorization": f"Bearer {make_test_jwt('11111111-0000-4000-8000-000000000001')}"}
    assert client.post(RECORD, headers=headers).status_code == 403


# =========================================================================
# 정상 경로
# =========================================================================

def test_record_returns_the_summary(client):
    with patch.object(
        congestion_estimates, "record_parking_derived_estimates",
        new=AsyncMock(return_value=dict(_SUMMARY)),
    ):
        res = client.post(RECORD, headers=admin_headers())
    assert res.status_code == 200
    body = res.json()
    # 응답만 보고도 이 값이 추정임을 알 수 있어야 한다.
    assert body["is_estimate"] is True
    assert body["source"] == "parking_derived"
    assert body["evidence_tier"] == "synthetic"
    assert body["inserted"] == 806


def test_preview_does_not_write(client):
    """미리보기는 계산만 한다 — 적재 함수가 불리면 안 된다."""
    record = AsyncMock()
    with patch.object(
        congestion_estimates, "preview_parking_derived_estimates",
        new=AsyncMock(return_value={**_SUMMARY, "stale": False}),
    ), patch.object(congestion_estimates, "record_parking_derived_estimates", new=record):
        res = client.get(PREVIEW, headers=admin_headers())
    assert res.status_code == 200
    assert res.json()["stale"] is False
    record.assert_not_awaited()


def test_preview_shows_stale_snapshot_instead_of_refusing(client):
    """수집이 죽어 있다는 사실을 확인하는 것이 이 화면의 용도다 — 거절하면 알 수 없다."""
    with patch.object(
        congestion_estimates, "preview_parking_derived_estimates",
        new=AsyncMock(return_value={**_SUMMARY, "stale": True}),
    ):
        res = client.get(PREVIEW, headers=admin_headers())
    assert res.status_code == 200
    assert res.json()["stale"] is True


# =========================================================================
# 오류 번역 — 전부 500 으로 뭉개면 관리자가 원인을 구분할 수 없다
# =========================================================================

@pytest.mark.parametrize(("code", "status"), [
    ("migration_not_applied", 409),
    ("parking_snapshot_stale", 503),
    ("no_parking_snapshot", 503),
    ("no_parking_lots", 503),
    ("duplicate_check_failed", 503),
])
def test_error_codes_map_to_distinct_statuses(client, code, status):
    with patch.object(
        congestion_estimates, "record_parking_derived_estimates",
        new=AsyncMock(side_effect=ParkingDerivedError(code)),
    ):
        res = client.post(RECORD, headers=admin_headers())
    assert res.status_code == status
    assert res.json()["detail"] == code


def test_migration_not_applied_is_not_a_server_error(client):
    """마이그레이션은 사람이 SQL Editor 에 붙여넣는다 — 적용 전에도 500 이 나면 안 된다."""
    with patch.object(
        congestion_estimates, "record_parking_derived_estimates",
        new=AsyncMock(side_effect=ParkingDerivedError("migration_not_applied")),
    ):
        res = client.post(RECORD, headers=admin_headers())
    assert res.status_code < 500


def test_unexpected_failure_does_not_leak_db_text(client):
    with patch.object(
        congestion_estimates, "record_parking_derived_estimates",
        new=AsyncMock(side_effect=RuntimeError("relation \"congestion_logs\" does not exist")),
    ):
        res = client.post(RECORD, headers=admin_headers())
    assert res.status_code == 500
    assert res.json()["detail"] == "parking_derived_record_failed"
    assert "congestion_logs" not in res.json()["detail"]
