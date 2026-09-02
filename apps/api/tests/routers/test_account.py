"""계정 데이터 승계·탈퇴 라우터 테스트. 실DB·실네트워크를 사용하지 않는다."""
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.core.authz import get_current_profile
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
# /account/me 응답 키 — API 규약(snake_case) 유지
# =========================================================================
# 이 레포의 API 는 전부 snake_case 로 내려준다(FastAPI 기본). 웹 프런트는
# lib/api-client.ts 가 응답을 camelCase 로 정규화해서 쓰므로 **여기서 별칭을 붙여도
# 웹은 안 깨진다** — 그래서 이 테스트는 프런트 보호 장치가 아니라 규약 고정 장치다.
# 한 라우터만 camelCase 로 튀면 API 를 직접 읽는 쪽(스크립트·다른 클라이언트)이 헷갈린다.
def test_account_me_response_keys_follow_the_snake_case_convention():
    fields = set(account.AccountMeResponse.model_fields)
    assert fields == {
        "id",
        "role",
        "is_anonymous",
        "nickname",
        "owned_facilities",
        "pending_verification",
    }, f"API 규약(snake_case)에서 벗어났다: {sorted(fields)}"

    dumped = account.AccountMeResponse(
        id="u1", role="merchant", is_anonymous=False
    ).model_dump()
    assert "isAnonymous" not in dumped
    assert dumped["owned_facilities"] == []
    assert dumped["pending_verification"] is False


# =========================================================================
# 역할 변경 신청 — 마이그레이션이 늦게 적용돼도 안전해야 한다
# =========================================================================
# requested_role 컬럼은 원격 SQL Editor 에서 사람이 적용한다. 백엔드 배포가 먼저 나가는
# 순서가 실제로 가능하고, 그때 두 가지가 동시에 참이어야 한다:
#   · 사업자 신청은 **그대로 성공한다** (컬럼 없이 한 번 더 시도)
#   · 관리자 신청은 **절대 사업자 신청으로 둔갑하지 않는다** (역할을 잃고 저장되면
#     심사자가 신청서만 보고 엉뚱한 권한을 준다) → 503 으로 정직하게 실패한다
MISSING_COLUMN_ERROR = (
    "{'code': 'PGRST204', 'message': \"Could not find the 'requested_role' column "
    "of 'business_verification_requests' in the schema cache\"}"
)


class FakeInsert:
    def __init__(self, table, payload):
        self.table, self.payload = table, payload

    def execute(self):
        self.table.inserts.append(dict(self.payload))
        if self.table.missing_column and "requested_role" in self.payload:
            raise RuntimeError(MISSING_COLUMN_ERROR)
        if self.table.duplicate:
            raise RuntimeError("duplicate key value violates unique constraint")
        if self.table.transient:
            raise RuntimeError("server disconnected without sending a response")
        return SimpleNamespace(data=[{"id": "req-1", "status": "pending", **self.payload}])


class FakeTable:
    """insert 만 실제로 흉내 내는 최소 대역(다른 호출은 이 테스트에서 쓰지 않는다)."""

    def __init__(self):
        self.inserts = []
        self.missing_column = False
        self.duplicate = False
        self.transient = False

    def insert(self, payload):
        return FakeInsert(self, payload)


@pytest.fixture
def request_client(monkeypatch):
    app = FastAPI()
    app.include_router(account.router)
    app.dependency_overrides[get_current_profile] = lambda: {
        "id": "u1",
        "role": "tourist",
        "is_anonymous": False,
    }
    table = FakeTable()
    monkeypatch.setattr(
        account, "supabase_admin", SimpleNamespace(table=lambda _name: table)
    )
    with TestClient(app) as test_client:
        yield test_client, table


def _submit(http, role=None):
    body = {"store_name": "이풍녀 구로쌈밥", "contact": "010-0000-0000"}
    if role is not None:
        body["requested_role"] = role
    return http.post("/api/v1/account/verification-requests", json=body)


def test_role_is_recorded_on_the_request(request_client):
    http, table = request_client
    assert _submit(http, "admin").status_code == 200
    assert table.inserts[-1]["requested_role"] == "admin"


def test_missing_role_defaults_to_merchant(request_client):
    """구 번들이 보내는 요청(필드 없음)은 사업자 신청과 같은 뜻이어야 한다."""
    http, table = request_client
    assert _submit(http).status_code == 200
    assert table.inserts[-1]["requested_role"] == "merchant"


def test_developer_cannot_be_requested(request_client):
    """신청으로 개발자가 될 수 있으면 심사 실수 한 번이 곧 전체 권한 위임이다."""
    http, table = request_client
    assert _submit(http, "developer").status_code == 422
    assert table.inserts == []


def test_merchant_request_survives_a_missing_column(request_client):
    """컬럼이 없는 DB — 사업자 신청은 컬럼 없이 다시 시도해 성공해야 한다."""
    http, table = request_client
    table.missing_column = True
    assert _submit(http, "merchant").status_code == 200
    assert len(table.inserts) == 2, "재시도가 없었다"
    assert "requested_role" not in table.inserts[-1]


def test_admin_request_fails_loudly_when_the_column_is_missing(request_client):
    """관리자 신청은 사업자 신청으로 바꿔 저장하느니 실패하는 게 낫다."""
    http, table = request_client
    table.missing_column = True
    res = _submit(http, "admin")
    assert res.status_code == 503
    # 두 번째(역할을 뗀) 시도가 있으면 안 된다 — 그게 곧 둔갑이다.
    assert len(table.inserts) == 1
    assert table.inserts[0]["requested_role"] == "admin"


def test_duplicate_request_is_a_conflict(request_client):
    """진짜 중복만 409 다."""
    http, table = request_client
    table.duplicate = True
    assert _submit(http, "merchant").status_code == 409


def test_a_transient_failure_is_not_reported_as_a_duplicate(request_client):
    """커넥션 장애를 409 로 답하면 "이미 신청이 있습니다" 가 되어, 사용자는 접수된 줄 알고
    기다리는데 심사 큐에는 아무것도 없다. 양쪽 다 이상을 못 느끼는 게 최악이라 잠근다."""
    http, table = request_client
    table.transient = True
    res = _submit(http, "merchant")
    assert res.status_code == 503, "일시적 장애가 중복 신청으로 둔갑했다"
    assert "이미" not in res.json()["detail"]


@pytest.mark.parametrize(
    "message,expected",
    [
        ("duplicate key value violates unique constraint bvr_pending_freeform_uq", True),
        ("duplicate key value violates unique constraint bvr_pending_facility_uq", True),
        ('violates unique constraint "x" (SQLSTATE 23505)', True),
        # 아래를 True 로 잡으면 장애가 다시 "이미 신청이 있습니다" 로 돌아간다.
        ("server disconnected without sending a response", False),
        ("new row violates row-level security policy", False),
        (MISSING_COLUMN_ERROR, False),
    ],
)
def test_duplicate_detector_is_narrow(message, expected):
    assert account._is_duplicate_pending(RuntimeError(message)) is expected


@pytest.mark.parametrize(
    "message,expected",
    [
        (MISSING_COLUMN_ERROR, True),
        ("column business_verification_requests.requested_role does not exist", True),
        # 아래 둘을 True 로 잡으면 진짜 오류를 컬럼 문제로 오인해 조용히 재시도한다.
        ("duplicate key value violates unique constraint bvr_pending_freeform_uq", False),
        ("connection reset by peer", False),
    ],
)
def test_missing_column_detector_is_narrow(message, expected):
    assert account._is_missing_requested_role(RuntimeError(message)) is expected
