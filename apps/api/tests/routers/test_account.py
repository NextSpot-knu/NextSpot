"""계정 데이터 승계·탈퇴 라우터 테스트. 실DB·실네트워크를 사용하지 않는다."""
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.core.supabase import get_current_user
from app.routers import account


EMPTY_MERGE = {
    "recommendations": 0,
    "user_feedback": 0,
    "recommendation_outcomes": 0,
    "saved_facilities": 0,
    "user_coupons": 0,
    "congestion_reports": 0,
    "inquiries": 0,
    "availability_reports": 0,
    "preference_vector_moved": False,
}


class FakeRpc:
    def __init__(self, payload):
        self.payload = payload

    def execute(self):
        return SimpleNamespace(data=self.payload)


class FakeAdminAuth:
    def __init__(self):
        self.deleted = []
        self.error = None

    def delete_user(self, user_id):
        if self.error:
            raise self.error
        self.deleted.append(user_id)


class FakeDB:
    def __init__(self):
        self.calls = []
        self.merge_payload = {
            **EMPTY_MERGE,
            "recommendations": 1,
            "user_feedback": 2,
            "recommendation_outcomes": 1,
            "saved_facilities": 3,
            "user_coupons": 1,
            "congestion_reports": 4,
            "inquiries": 1,
            "preference_vector_moved": True,
        }
        self.auth_admin = FakeAdminAuth()
        self.auth = SimpleNamespace(admin=self.auth_admin)

    def rpc(self, name, params):
        self.calls.append((name, params))
        return FakeRpc(dict(self.merge_payload))


@pytest.fixture
def client(monkeypatch):
    app = FastAPI()
    app.include_router(account.router)
    app.dependency_overrides[get_current_user] = lambda: {"id": "target"}
    db = FakeDB()
    monkeypatch.setattr(account, "supabase_admin", db)
    monkeypatch.setattr(account, "verify_supabase_token", lambda token: {"sub": token, "is_anonymous": True})
    with TestClient(app) as test_client:
        yield test_client, db


def test_anonymous_token_uses_atomic_merge_rpc(client):
    http, db = client
    response = http.post("/api/v1/account/merge-guest", json={"guest_token": "guest"})
    assert response.status_code == 200
    assert response.json() == db.merge_payload
    assert db.calls == [(
        "merge_guest_account_data",
        {"p_guest_user_id": "guest", "p_target_user_id": "target"},
    )]


def test_non_anonymous_token_is_forbidden(client, monkeypatch):
    http, db = client
    monkeypatch.setattr(account, "verify_supabase_token", lambda _: {"sub": "victim", "is_anonymous": False})
    assert http.post("/api/v1/account/merge-guest", json={"guest_token": "real"}).status_code == 403
    assert db.calls == []


@pytest.mark.parametrize("detail", ["expired", "forged"])
def test_invalid_guest_token_is_unauthorized(client, monkeypatch, detail):
    http, db = client

    def reject(_):
        raise HTTPException(status_code=401, detail=detail)

    monkeypatch.setattr(account, "verify_supabase_token", reject)
    assert http.post("/api/v1/account/merge-guest", json={"guest_token": detail}).status_code == 401
    assert db.calls == []


def test_same_uid_is_noop_without_rpc(client):
    http, db = client
    response = http.post("/api/v1/account/merge-guest", json={"guest_token": "target"})
    assert response.json() == EMPTY_MERGE
    assert db.calls == []


def test_invalid_rpc_payload_is_reported_as_merge_failure(client):
    http, db = client
    db.merge_payload = []
    response = http.post("/api/v1/account/merge-guest", json={"guest_token": "guest"})
    assert response.status_code == 500


def test_delete_account_uses_only_authenticated_user(client):
    http, db = client
    response = http.delete("/api/v1/account/me")
    assert response.status_code == 200
    assert response.json() == {"deleted": True}
    assert db.auth_admin.deleted == ["target"]


def test_delete_account_failure_is_not_reported_as_success(client):
    http, db = client
    db.auth_admin.error = RuntimeError("auth unavailable")
    response = http.delete("/api/v1/account/me")
    assert response.status_code == 500
    assert db.auth_admin.deleted == []


# =========================================================================
# /account/me 응답 키 — 프런트와의 계약
# =========================================================================
# 프런트(apps/web/lib/accountRoles.ts `parseAccount`)가 이 키 이름을 그대로 읽는다.
# 한쪽만 바꾸면 **타입 검사도 통과하고 테스트도 통과하는데 화면만 조용히 망가진다** —
# 실제로 그런 적이 있다: 프런트가 camelCase 로 읽는 바람에 owned_facilities 가 항상
# 빈 배열이 되어 모든 사장님이 "인증 대기" 화면에 갇혔다.
#
# 이 프로젝트의 API 규약은 snake_case 다(FastAPI 기본). camelCase 로 바꾸려면
# 프런트 parseAccount 와 그쪽 테스트를 같이 고쳐야 한다.
def test_account_me_response_keys_are_snake_case():
    fields = set(account.AccountMeResponse.model_fields)
    assert fields == {
        "id",
        "role",
        "is_anonymous",
        "nickname",
        "owned_facilities",
        "pending_verification",
    }, f"프런트 parseAccount 가 읽는 키와 어긋났다: {sorted(fields)}"

    # 직렬화 결과에도 별칭(camelCase)이 끼지 않아야 한다.
    dumped = account.AccountMeResponse(
        id="u1", role="merchant", is_anonymous=False
    ).model_dump()
    assert "isAnonymous" not in dumped
    assert "ownedFacilities" not in dumped
    assert dumped["owned_facilities"] == []
    assert dumped["pending_verification"] is False
