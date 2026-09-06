"""계정 데이터 승계·탈퇴 라우터 테스트. 실DB·실네트워크를 사용하지 않는다."""
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.core import verification_evidence
from app.core.authz import get_current_profile
from app.core.supabase import get_current_user
from app.core.verification_evidence import clear_verification_evidence
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


class FakeEmptyQuery:
    """신청이 한 건도 없는 계정. 체이닝을 흡수하고 빈 결과를 돌려준다.

    탈퇴가 증빙 경로를 읽으려고 이 표를 조회한다. 대역에 table() 이 아예 없으면 그 조회가
    AttributeError 로 실패하고, 라우터가 조회 실패를 삼키는 바람에 **아래 두 테스트가 정리
    경로를 한 번도 지나지 않은 채 통과한다** — 그러면 순서가 깨져도 알 수 없다.
    """

    def select(self, *_columns, **_kwargs):
        return self

    def eq(self, *_args):
        return self

    def limit(self, *_args):
        return self

    def execute(self):
        return SimpleNamespace(data=[])


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

    def table(self, _name):
        return FakeEmptyQuery()


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
    # 증빙 삭제는 core 모듈의 **자기 supabase_admin** 을 쓴다 — 여기서 안 막으면 저장 실패
    # 경로가 실제 Storage 로 나간다(이 대역은 그 왕복을 흉내 내지 않는다).
    table.cleared = []

    async def _record_clear(request_id, path):
        table.cleared.append((request_id, path))

    monkeypatch.setattr(account, "clear_verification_evidence", _record_clear)
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


@pytest.mark.parametrize(
    "role,transient,status",
    [
        ("admin", False, 503),   # 컬럼이 없어 관리자 신청을 접수하지 못한 경우
        ("merchant", True, 503),  # 컬럼 없이 다시 시도했는데 그 시도도 실패한 경우
    ],
    ids=["admin-blocked", "retry-failed"],
)
def test_every_legacy_schema_dead_end_discards_the_uploaded_evidence(
    request_client, role, transient, status
):
    """폴백 갈래도 '행은 없는데 파일은 있는' 상태로 끝난다 — 한 갈래만 빠뜨리면 그 갈래가
    곧 사업자등록증이 쌓이는 통로가 된다."""
    http, table = request_client
    table.missing_column = True
    table.transient = transient
    res = http.post("/api/v1/account/verification-requests", json={
        "store_name": "가게", "contact": "010-0000-0000",
        "requested_role": role, "document_path": "u1/proof.jpg",
    })
    assert res.status_code == status
    assert table.cleared == [(None, "u1/proof.jpg")], "버킷에 사업자등록증이 남았다"


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


# ── 증빙 경로 — 남의 서류를 자기 신청서에 붙일 수 없어야 한다 ───────────────
# 스토리지 정책은 남의 uid 폴더에 **올리는** 것만 막는다. 이미 있는 남의 경로를 본문에 적어
# 보내는 것은 서버가 막아야 한다 — 안 그러면 심사자 화면에 남의 사업자등록증이 이 신청서의
# 증빙으로 붙어 보인다.


def test_a_document_path_in_someone_elses_folder_is_rejected(request_client):
    http, table = request_client
    res = http.post("/api/v1/account/verification-requests", json={
        "store_name": "가게", "contact": "010-0000-0000",
        "requested_role": "merchant",
        "document_path": "00000000-0000-4000-8000-999999999999/proof.jpg",
    })
    assert res.status_code == 422, f"남의 경로가 {res.status_code} 로 통과했다"
    assert table.inserts == [], "거부했는데 신청서가 저장됐다"


def test_own_document_path_is_accepted(request_client):
    http, table = request_client
    res = http.post("/api/v1/account/verification-requests", json={
        "store_name": "가게", "contact": "010-0000-0000",
        "requested_role": "merchant",
        "document_path": "u1/proof.jpg",
    })
    assert res.status_code == 200
    assert table.inserts[0]["document_path"] == "u1/proof.jpg"


def test_no_document_is_still_allowed(request_client):
    """관리자 신청에는 사업자등록증이 없다 — 증빙 없이도 접수돼야 한다."""
    http, table = request_client
    res = http.post("/api/v1/account/verification-requests", json={
        "store_name": "소속", "contact": "010-0000-0000", "requested_role": "admin",
    })
    assert res.status_code == 200
    assert table.inserts[0]["document_path"] is None


# =========================================================================
# 본인 신청 철회·수정 — 신청자가 자기 신청을 되돌릴 수 있어야 한다
# =========================================================================
# 마이페이지의 "역할 변경 심사중" 은 여태 막다른 길이었다(무엇을 냈는지도, 취소할 방법도
# 없었다). RLS 는 이미 준비돼 있었고(bvr_withdraw_own: pending → withdrawn) API 만 없었다.
#
# 이 대역은 update 를 **실제로 행에 반영한다.** '증빙은 상태 갱신 뒤에 지운다' 같은 순서
# 판단은 갱신이 반영되는 대역이라야 검증할 수 있다 — 호출만 세는 대역으로는 순서가 뒤집혀도
# 테스트가 통과한다(이 코드에서 실제로 한 번 깨졌던 지점이다).

FACILITY_ID = "11111111-1111-4111-8111-111111111111"
UNKNOWN_FACILITY_ID = "22222222-2222-4222-8222-222222222222"


class FakeQuery:
    """PostgREST 체이닝 대역 — 필터를 모아 두었다가 execute() 에서 FakeStore 가 해석한다."""

    def __init__(self, store, table, op, columns=None, payload=None):
        self.store, self.table, self.op = store, table, op
        self.columns, self.payload = columns, payload
        self.filters = {}
        self.in_filter = None

    def eq(self, column, value):
        self.filters[column] = value
        return self

    def in_(self, column, values):
        self.in_filter = (column, list(values))
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def execute(self):
        return self.store.run(self)


class FakeTableProxy:
    def __init__(self, store, table):
        self.store, self.table = store, table

    def select(self, columns):
        return FakeQuery(self.store, self.table, "select", columns=columns)

    def update(self, payload):
        return FakeQuery(self.store, self.table, "update", payload=dict(payload))

    def insert(self, payload):
        return FakeQuery(self.store, self.table, "insert", payload=dict(payload))


class FakeStore:
    """business_verification_requests + facilities 두 표를 흉내 내는 대역."""

    def __init__(self):
        self.rows = []
        self.facilities = []
        self.updates = []  # 실제로 DB 까지 간 update payload 만 쌓인다
        self.inserts = []
        self.select_error = None
        self.update_error = None
        # 삽입 실패는 흔한 경로다(409 중복 · 503 콜드 스타트). 그때 방금 올린 증빙이
        # 어떻게 되는지가 검증 대상이라, 이 대역도 실패를 주입할 수 있어야 한다.
        self.insert_error = None
        self.facility_error = None

    def table(self, name):
        return FakeTableProxy(self, name)

    def row(self, request_id):
        return next(r for r in self.rows if r["id"] == request_id)

    def run(self, query):
        if query.table == "facilities":
            return self._facilities(query)
        return self._requests(query)

    def _facilities(self, query):
        if self.facility_error:
            raise self.facility_error
        rows = list(self.facilities)
        if query.in_filter:
            column, values = query.in_filter
            rows = [r for r in rows if r.get(column) in values]
        for column, value in query.filters.items():
            rows = [r for r in rows if r.get(column) == value]
        return SimpleNamespace(data=[dict(r) for r in rows])

    def _match(self, query):
        rows = self.rows
        for column, value in query.filters.items():
            rows = [r for r in rows if str(r.get(column)) == str(value)]
        return rows

    def _requests(self, query):
        if query.op == "select":
            if self.select_error:
                raise self.select_error
            rows = self._match(query)
            if query.columns == "*":
                return SimpleNamespace(data=[dict(r) for r in rows])
            keys = [c.strip() for c in query.columns.split(",")]
            return SimpleNamespace(data=[{k: r[k] for k in keys if k in r} for r in rows])
        if query.op == "update":
            if self.update_error:
                raise self.update_error
            self.updates.append(dict(query.payload))
            touched = self._match(query)
            for row in touched:
                row.update(query.payload)
            return SimpleNamespace(data=[dict(r) for r in touched])
        if query.op == "insert":
            if self.insert_error:
                # 행은 남지 않는다 — 실패한 삽입은 시도조차 기록하지 않는다(실 DB 와 같다).
                raise self.insert_error
            self.inserts.append(dict(query.payload))
            row = {"id": "req-new", "review_note": None, **query.payload}
            self.rows.append(row)
            return SimpleNamespace(data=[dict(row)])
        raise AssertionError(f"예상하지 않은 호출: {query.op}")


@pytest.fixture
def owner_client(monkeypatch):
    """신청자 본인(u1) 세션. 남의 신청(u2)도 한 건 심어 둔다 — id 만 알면 건드려지는지 본다."""
    app = FastAPI()
    app.include_router(account.router)
    app.dependency_overrides[get_current_profile] = lambda: {
        "id": "u1",
        "role": "tourist",
        "is_anonymous": False,
    }
    store = FakeStore()
    store.rows.append({
        "id": "req-1", "user_id": "u1", "store_name": "이풍녀 구로쌈밥",
        "contact": "010-0000-0000", "facility_id": FACILITY_ID,
        "business_number_last4": "1234", "document_path": "u1/proof.jpg",
        "status": "pending", "review_note": None, "reviewed_at": None,
        "created_at": "2026-09-01T00:00:00+00:00", "requested_role": "merchant",
    })
    store.rows.append({
        "id": "req-other", "user_id": "u2", "store_name": "남의 가게",
        "contact": "010-9999-9999", "facility_id": None,
        "business_number_last4": None, "document_path": "u2/proof.jpg",
        "status": "pending", "review_note": None, "reviewed_at": None,
        "created_at": "2026-09-01T00:00:00+00:00", "requested_role": "merchant",
    })
    store.facilities.append({"id": FACILITY_ID, "name": "황남빵 본점", "is_active": True})
    monkeypatch.setattr(account, "supabase_admin", store)

    cleared = []

    async def _record_clear(request_id, path):
        # 삭제 시점의 **행 상태**까지 함께 붙잡는다. 경로만 보면 '갱신 전에 지웠는지'를
        # 구분할 수 없다 — 순서가 이 코드에서 가장 깨지기 쉬운 지점이다.
        # 행이 없을 수도 있다: 저장에 실패해 신청이 아예 만들어지지 않은 업로드를 치우는
        # 경로에서는 request_id 가 None 이다(그래서 next 에 기본값을 준다).
        row = next((r for r in store.rows if r["id"] == request_id), None)
        cleared.append({
            "request_id": request_id,
            "path": path,
            "row_at_delete": dict(row) if row else None,
        })

    monkeypatch.setattr(account, "clear_verification_evidence", _record_clear)
    with TestClient(app) as http:
        yield http, store, cleared


def _as_guest(http):
    http.app.dependency_overrides[get_current_profile] = lambda: {
        "id": "guest", "role": "tourist", "is_anonymous": True,
    }


# ── 철회 ──────────────────────────────────────────────────────────────────


def test_withdrawing_someone_elses_request_is_a_not_found(owner_client):
    """403 이면 그 응답 자체가 '그 id 의 신청은 존재한다' 는 확인이 된다 — 404 로 합친다."""
    http, store, _ = owner_client
    res = http.post("/api/v1/account/verification-requests/req-other/withdraw")
    assert res.status_code == 404, f"남의 신청이 {res.status_code} 로 열렸다"
    assert store.updates == [], "거부했는데 남의 신청이 갱신됐다"
    assert store.row("req-other")["status"] == "pending"


def test_withdrawing_a_reviewed_request_is_a_conflict(owner_client):
    """심사가 끝난 뒤의 철회는 결과를 지우는 일이 된다 — 409."""
    http, store, _ = owner_client
    store.row("req-1")["status"] = "approved"
    res = http.post("/api/v1/account/verification-requests/req-1/withdraw")
    assert res.status_code == 409
    assert store.updates == []


def test_withdraw_updates_the_row_and_then_clears_the_evidence(owner_client):
    """갱신이 먼저, 삭제가 나중. 그리고 삭제에는 **갱신 전** 경로가 넘어가야 한다.

    순서가 뒤집히면 갱신 실패 시 pending 인 채로 증빙만 사라지고, 경로를 갱신 뒤에 읽으면
    이미 NULL 이라 파일이 영영 안 지워진다(dev.py 에서 실제로 겪은 두 가지 실패다).
    """
    http, store, cleared = owner_client
    res = http.post("/api/v1/account/verification-requests/req-1/withdraw")
    assert res.status_code == 200
    assert res.json() == {"withdrawn": True, "id": "req-1"}

    row = store.row("req-1")
    assert row["status"] == "withdrawn"
    assert row["reviewed_at"] == "now()"
    assert row["document_path"] is None
    assert row["business_number_last4"] is None
    # 철회는 심사가 아니다 — 심사자를 본인으로 적어 두면 감사 이력이 거짓말을 한다.
    assert "reviewed_by" not in store.updates[0]

    assert len(cleared) == 1
    assert cleared[0]["path"] == "u1/proof.jpg", "갱신 뒤에 읽은 NULL 이 넘어갔다"
    assert cleared[0]["row_at_delete"]["status"] == "withdrawn", "갱신보다 삭제가 먼저였다"


def test_withdraw_without_evidence_still_succeeds(owner_client):
    """증빙 없는 신청(관리자 신청)도 철회된다 — 지울 파일이 없을 뿐이다."""
    http, store, cleared = owner_client
    store.row("req-1")["document_path"] = None
    assert http.post("/api/v1/account/verification-requests/req-1/withdraw").status_code == 200
    assert cleared[0]["path"] is None


def test_guests_cannot_withdraw(owner_client):
    http, store, _ = owner_client
    _as_guest(http)
    assert http.post("/api/v1/account/verification-requests/req-1/withdraw").status_code == 403
    assert store.updates == []


def test_a_lookup_failure_is_not_reported_as_a_missing_request(owner_client):
    """404 로 답하면 사용자는 신청서를 다시 쓰고, 남아 있는 pending 때문에 409 를 맞는다."""
    http, store, _ = owner_client
    store.select_error = RuntimeError("server disconnected without sending a response")
    res = http.post("/api/v1/account/verification-requests/req-1/withdraw")
    assert res.status_code == 503
    assert store.updates == []


# ── 수정 ──────────────────────────────────────────────────────────────────


def test_patch_sends_only_the_fields_that_were_present_in_the_body(owner_client):
    """exclude_unset 이 실제로 동작하는가. model_dump() 를 그대로 쓰면 연락처만 고치려던
    요청이 store_name·facility_id 까지 덮어쓴다."""
    http, store, _ = owner_client
    res = http.patch(
        "/api/v1/account/verification-requests/req-1", json={"contact": "010-1111-2222"}
    )
    assert res.status_code == 200
    assert store.updates == [{"contact": "010-1111-2222"}], "안 보낸 필드가 갱신에 섞였다"
    assert store.row("req-1")["store_name"] == "이풍녀 구로쌈밥"
    assert res.json()["store_name"] == "이풍녀 구로쌈밥"


def test_patch_distinguishes_an_explicit_null_from_an_omitted_field(owner_client):
    """명시적 null 은 '지움' 이다 — 안 보낸 것과 같은 뜻이 되면 지울 방법이 없다.

    예전에는 facility_id 로 이 경계를 확인했다. 이제 그 필드는 수정 대상이 아니라
    (아래 '가게 바꿔치기' 절) 지울 수 있는 다른 선택 칼럼으로 같은 계약을 잠근다 —
    검증하려는 것은 exclude_unset 의 동작이지 어느 칼럼이냐가 아니다.
    """
    http, store, _ = owner_client
    res = http.patch(
        "/api/v1/account/verification-requests/req-1", json={"business_number_last4": None}
    )
    assert res.status_code == 200
    assert "business_number_last4" in store.updates[0], "명시적 null 이 '미지정' 으로 삼켜졌다"
    assert store.updates[0]["business_number_last4"] is None
    assert store.row("req-1")["business_number_last4"] is None


def test_patch_rejects_a_document_path_in_someone_elses_folder(owner_client):
    """수정 경로가 열리면 그게 곧 신규 신청 검사의 우회로가 된다."""
    http, store, _ = owner_client
    res = http.patch(
        "/api/v1/account/verification-requests/req-1",
        json={"document_path": "00000000-0000-4000-8000-999999999999/proof.jpg"},
    )
    assert res.status_code == 422, f"남의 경로가 {res.status_code} 로 통과했다"
    assert store.updates == []
    assert store.row("req-1")["document_path"] == "u1/proof.jpg"


def test_patch_replaces_the_evidence_after_the_update(owner_client):
    """증빙 교체도 순서가 같다 — 갱신에 성공한 **뒤** 옛 파일을 지운다."""
    http, store, cleared = owner_client
    res = http.patch(
        "/api/v1/account/verification-requests/req-1", json={"document_path": "u1/new.jpg"}
    )
    assert res.status_code == 200
    assert store.row("req-1")["document_path"] == "u1/new.jpg"
    assert [c["path"] for c in cleared] == ["u1/proof.jpg"], "옛 경로가 아닌 값이 지워졌다"
    assert cleared[0]["row_at_delete"]["document_path"] == "u1/new.jpg"


def test_patch_does_not_delete_a_reuploaded_path(owner_client):
    """같은 경로로 다시 올린 경우까지 지우면 방금 올린 파일을 지우는 꼴이 된다."""
    http, store, cleared = owner_client
    res = http.patch(
        "/api/v1/account/verification-requests/req-1", json={"document_path": "u1/proof.jpg"}
    )
    assert res.status_code == 200
    assert cleared == []


def test_patch_with_no_fields_is_unprocessable(owner_client):
    http, store, _ = owner_client
    res = http.patch("/api/v1/account/verification-requests/req-1", json={})
    assert res.status_code == 422
    assert store.updates == []


@pytest.mark.parametrize("body", [{"store_name": "   "}, {"contact": ""}, {"contact": None}])
def test_patch_cannot_blank_out_a_required_field(owner_client, body):
    """빈 연락처로 바꿔 두면 심사자가 연락할 곳이 없는 신청서가 큐에 남는다."""
    http, store, _ = owner_client
    assert http.patch("/api/v1/account/verification-requests/req-1", json=body).status_code == 422
    assert store.updates == []


def test_patching_someone_elses_request_is_a_not_found(owner_client):
    http, store, _ = owner_client
    res = http.patch(
        "/api/v1/account/verification-requests/req-other", json={"contact": "010-1111-2222"}
    )
    assert res.status_code == 404
    assert store.updates == []


def test_patching_a_reviewed_request_is_a_conflict(owner_client):
    http, store, _ = owner_client
    store.row("req-1")["status"] = "rejected"
    res = http.patch(
        "/api/v1/account/verification-requests/req-1", json={"contact": "010-1111-2222"}
    )
    assert res.status_code == 409
    assert store.updates == []


def test_patch_conflicting_with_another_pending_request_is_a_conflict(owner_client):
    """같은 사람의 다른 pending 과 겹치면 부분 유니크 인덱스가 막는다 — 그것만 409."""
    http, store, _ = owner_client
    store.update_error = RuntimeError(
        "duplicate key value violates unique constraint bvr_pending_freeform_uq"
    )
    res = http.patch("/api/v1/account/verification-requests/req-1", json={"store_name": "다른 가게"})
    assert res.status_code == 409


def test_a_transient_update_failure_is_not_reported_as_a_duplicate(owner_client):
    http, store, _ = owner_client
    store.update_error = RuntimeError("server disconnected without sending a response")
    res = http.patch("/api/v1/account/verification-requests/req-1", json={"store_name": "다른 가게"})
    assert res.status_code == 503, "일시적 장애가 중복으로 둔갑했다"
    assert "이미" not in res.json()["detail"]


# ── 가게 선택 검증 ────────────────────────────────────────────────────────
# 없는 uuid 는 FK 위반으로 터져 503 "저장하지 못했어요" 가 된다 — 사용자가 고칠 수 있는
# 문제(가게를 다시 고르면 된다)가 우리 쪽 장애처럼 보이면 같은 요청만 계속 반복된다.


def test_creating_with_an_unknown_facility_is_unprocessable(owner_client):
    http, store, _ = owner_client
    res = http.post("/api/v1/account/verification-requests", json={
        "store_name": "가게", "contact": "010-0000-0000",
        "facility_id": UNKNOWN_FACILITY_ID,
    })
    assert res.status_code == 422
    assert res.json()["detail"] == "선택한 가게를 찾을 수 없습니다."
    assert store.inserts == []


def test_creating_with_a_real_facility_stores_the_link(owner_client):
    http, store, _ = owner_client
    res = http.post("/api/v1/account/verification-requests", json={
        "store_name": "가게", "contact": "010-0000-0000", "facility_id": FACILITY_ID,
    })
    assert res.status_code == 200
    assert store.inserts[-1]["facility_id"] == FACILITY_ID


def test_a_facility_lookup_failure_is_not_blamed_on_the_user(owner_client):
    """조회 실패를 422 로 답하면 멀쩡한 가게를 '없는 가게' 라고 말하게 된다.

    (수정이 아니라 신규 신청으로 확인한다 — 가게 검증이 남아 있는 곳이 거기뿐이다.)
    """
    http, store, _ = owner_client
    store.facility_error = RuntimeError("server disconnected without sending a response")
    res = http.post("/api/v1/account/verification-requests", json={
        "store_name": "가게", "contact": "010-0000-0000", "facility_id": FACILITY_ID,
    })
    assert res.status_code == 503
    assert store.inserts == []


# ── 가게 바꿔치기 — 심사 중에는 facility_id 가 얼어 있어야 한다 ──────────────
# 승인은 신청서의 facility_id 에 소유권(facility_owners)을 붙인다. 심사자가 보는 큐는 정적
# 스냅샷이라, 신청자가 심사 중에 이 값을 바꿀 수 있으면 다음이 성립한다: 자기 가게 A 로
# 신청하고 A 의 증빙을 붙인다 → 심사자가 A 를 확인한다 → 승인 직전에 B(남의 유명 가게)로
# 바꾼다 → 승인이 B 의 소유권을 준다. 경쟁 상태가 아니라 몇 분이면 되는 일이고, 소유권은
# 좌석 방송 권한이라 그 방송이 congestion_logs 에 verified 로 들어간다.
#
# 그래서 수정으로는 못 바꾼다. 바꾸려면 철회하고 다시 낸다.


@pytest.mark.parametrize(
    "value",
    [UNKNOWN_FACILITY_ID, FACILITY_ID, None],
    ids=["unknown", "real", "unlink"],
)
def test_patch_refuses_to_change_the_linked_facility(owner_client, value):
    """어떤 값이든 거절이다 — 실존하는 가게로 바꾸는 것이 정확히 이 공격이다.

    null(연결 해제)도 같은 변경이다. 연결을 끊어 두면 심사자가 본 가게가 사라지고,
    승인은 심사자가 그 자리에서 고른 가게에 소유권을 붙이게 된다.
    """
    http, store, _ = owner_client
    res = http.patch(
        "/api/v1/account/verification-requests/req-1", json={"facility_id": value}
    )
    assert res.status_code == 422, f"가게가 {res.status_code} 로 바뀌었다"
    assert store.updates == [], "거절해 놓고 갱신이 일어났다"
    assert store.row("req-1")["facility_id"] == FACILITY_ID, "신청서의 가게가 바뀌었다"
    # 문구가 다음 동선을 가리켜야 한다 — 막기만 하면 사용자는 잘못 고른 가게에 갇힌다.
    detail = res.json()["detail"]
    assert "취소" in detail and "다시 신청" in detail, f"할 일을 알려 주지 않는다: {detail}"


def test_the_facility_change_is_refused_before_anything_is_read(owner_client):
    """검사가 조회·갱신보다 뒤로 밀리면 '거절했는데 쓰기는 일어난' 창이 생긴다.

    조회 자체를 통째로 실패시켜 둔다 — 그래도 422 가 나오면 그 사이 아무것도 읽지 않았다는
    뜻이다(읽었다면 503 이 됐을 것이다)."""
    http, store, _ = owner_client
    store.select_error = RuntimeError("server disconnected without sending a response")
    store.facility_error = RuntimeError("server disconnected without sending a response")
    res = http.patch(
        "/api/v1/account/verification-requests/req-1", json={"facility_id": UNKNOWN_FACILITY_ID}
    )
    assert res.status_code == 422
    assert store.updates == []


def test_other_fields_are_still_editable(owner_client):
    """가게만 잠긴다 — 연락처 오타 하나 고치려고 사업자등록증을 다시 찍게 만들면 안 된다."""
    http, store, _ = owner_client
    res = http.patch(
        "/api/v1/account/verification-requests/req-1",
        json={"contact": "010-1111-2222", "store_name": "이풍녀 구로쌈밥 본점"},
    )
    assert res.status_code == 200
    assert store.row("req-1")["contact"] == "010-1111-2222"
    assert store.row("req-1")["facility_id"] == FACILITY_ID


def test_the_patch_model_never_carries_a_facility_id_into_the_update(owner_client):
    """모델에서 필드를 지우면 pydantic 이 값을 **조용히** 버리고 200 을 돌려준다 — 프런트는
    가게가 바뀐 줄 알고 화면에 반영하고, 서버 상태와 어긋난다. 거절이지 무시가 아니다."""
    assert "facility_id" in account.VerificationRequestPatch.model_fields, (
        "필드를 지우면 잘못된 요청이 200 으로 통과한다"
    )


# ── 내 신청 목록 ──────────────────────────────────────────────────────────


def test_mine_reports_document_presence_without_the_path(owner_client):
    """경로를 내려 주면 비공개 버킷 정책을 뚫어 볼 실마리를 함께 넘겨 주는 셈이다."""
    http, store, _ = owner_client
    res = http.get("/api/v1/account/verification-requests/mine")
    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 1, "남의 신청까지 섞여 나왔다"
    item = items[0]
    assert "document_path" not in item, "증빙 경로가 응답에 실렸다"
    assert item["has_document"] is True
    assert item["contact"] == "010-0000-0000"
    assert item["reviewed_at"] is None
    assert item["facility_name"] == "황남빵 본점"


def test_mine_reports_a_missing_document_as_false(owner_client):
    http, store, _ = owner_client
    store.row("req-1")["document_path"] = None
    item = http.get("/api/v1/account/verification-requests/mine").json()["items"][0]
    assert item["has_document"] is False


def test_mine_survives_a_facility_name_lookup_failure(owner_client):
    """가게 이름은 부가 정보다 — 그것 때문에 신청 이력 자체를 못 보게 되면 안 된다."""
    http, store, _ = owner_client
    store.facility_error = RuntimeError("could not find a relationship")
    res = http.get("/api/v1/account/verification-requests/mine")
    assert res.status_code == 200
    items = res.json()["items"]
    assert len(items) == 1, "이름 조회 실패가 목록 전체를 죽였다"
    assert items[0]["facility_name"] is None
    assert items[0]["has_document"] is True


# ── 저장에 실패한 신청의 증빙 — 버킷에 남기지 않는다 ────────────────────────
# 프런트는 신청서를 만들기 **전에** 증빙을 올린다(반대로 하면 근거 없는 신청이 큐에 남으므로
# 그 순서 자체는 옳다). 문제는 그 다음이다: 저장이 실패하면 그 파일을 지울 주체가 없다.
# clear_verification_evidence 는 신청 행에 적힌 경로를 지우는데 그 행이 없고, 스토리지
# 정책(20260904200000)에는 DELETE 정책이 **일부러 없어** 브라우저도 자기 파일을 못 지운다.
# 업로드 경로에 타임스탬프가 들어가 재시도마다 새 파일이 쌓이고, 남는 물건은 사업자등록증이다.
# 가장 흔한 실패(409 중복 · 503 콜드 스타트)가 정확히 이 경로다.

NEW_DOC = "u1/1757000000-proof.jpg"


def _submit_with_document(http, path=NEW_DOC):
    return http.post("/api/v1/account/verification-requests", json={
        "store_name": "가게", "contact": "010-0000-0000", "document_path": path,
    })


@pytest.mark.parametrize(
    "error,status",
    [
        (RuntimeError("duplicate key value violates unique constraint bvr_pending_freeform_uq"), 409),
        (RuntimeError("server disconnected without sending a response"), 503),
    ],
    ids=["duplicate", "transient"],
)
def test_a_failed_insert_deletes_the_evidence_it_orphaned(owner_client, error, status):
    http, store, cleared = owner_client
    store.insert_error = error
    res = _submit_with_document(http)
    assert res.status_code == status, "오류 응답이 정리 때문에 바뀌었다"
    assert [c["path"] for c in cleared] == [NEW_DOC], "버킷에 사업자등록증이 남았다"
    # 행이 없으니 request_id 도 없다 — 있는 척하면 로그가 거짓말을 한다.
    assert cleared[0]["request_id"] is None
    assert store.inserts == []


def test_a_successful_request_keeps_its_evidence(owner_client):
    """정리가 성공 경로까지 번지면 심사자가 볼 서류가 사라진다."""
    http, store, cleared = owner_client
    assert _submit_with_document(http).status_code == 200
    assert cleared == [], "접수된 신청의 증빙을 지웠다"


def test_a_failed_insert_without_evidence_deletes_nothing(owner_client):
    """관리자 신청에는 서류가 없다 — 지울 것이 없을 때 삭제를 부르면 로그만 더럽힌다."""
    http, store, cleared = owner_client
    store.insert_error = RuntimeError("server disconnected without sending a response")
    res = http.post("/api/v1/account/verification-requests", json={
        "store_name": "소속", "contact": "010-0000-0000", "requested_role": "admin",
    })
    assert res.status_code == 503
    assert cleared == []


def test_a_failed_update_deletes_only_the_path_that_was_just_uploaded(owner_client):
    """수정도 같다 — 다만 지울 것은 **이번에 보낸** 경로다.

    옛 경로는 신청서가 여전히 가리키고 있다. 그걸 지우면 살아 있는 pending 신청의 증빙이
    사라져, 심사자는 서류 없는 신청을 받고 신청자는 낸 줄 안다."""
    http, store, cleared = owner_client
    store.update_error = RuntimeError("server disconnected without sending a response")
    res = http.patch(
        "/api/v1/account/verification-requests/req-1", json={"document_path": NEW_DOC}
    )
    assert res.status_code == 503
    assert [c["path"] for c in cleared] == [NEW_DOC]
    assert store.row("req-1")["document_path"] == "u1/proof.jpg", "옛 경로가 지워졌다"


def test_a_failed_update_does_not_delete_a_reuploaded_path(owner_client):
    """같은 경로로 다시 올린 경우 그 파일은 **여전히 유효한 신청**의 증빙이다."""
    http, store, cleared = owner_client
    store.update_error = RuntimeError("server disconnected without sending a response")
    res = http.patch(
        "/api/v1/account/verification-requests/req-1", json={"document_path": "u1/proof.jpg"}
    )
    assert res.status_code == 503
    assert cleared == [], "살아 있는 신청의 증빙을 지웠다"


# ── 탈퇴 — CASCADE 가 닿지 않는 파일 ────────────────────────────────────────
# auth 사용자를 지우면 FK CASCADE 가 business_verification_requests 행을 함께 지운다.
# 그런데 Storage 의 사업자등록증은 CASCADE 대상이 **아니다.** 심사 대기 중에 탈퇴하면 행은
# 사라지고 파일만 버킷에 남는데, 경로를 아는 유일한 곳이 그 행이었으므로 아무도 그 파일을
# 지울 수 없다. 마이그레이션 20260904200000 은 '심사가 끝나면 보관하지 않는다' 고 단언한다.
#
# 그래서 순서가 계약이다: **증빙 먼저, 계정 나중.** 그리고 증빙 정리 실패가 탈퇴를 막아서는
# 안 된다 — 탈퇴는 사용자의 권리이고 뒷정리는 우리 사정이다.


@pytest.fixture
def delete_client(monkeypatch):
    """탈퇴하는 본인(u1) 세션. 심사 대기 신청 한 건과 남의 신청 한 건을 심어 둔다."""
    app = FastAPI()
    app.include_router(account.router)
    app.dependency_overrides[get_current_user] = lambda: {"id": "u1"}
    store = FakeStore()
    store.rows.append({
        "id": "req-1", "user_id": "u1", "status": "pending", "document_path": "u1/proof.jpg",
    })
    store.rows.append({
        "id": "req-other", "user_id": "u2", "status": "pending", "document_path": "u2/proof.jpg",
    })
    store.auth_admin = FakeAdminAuth()
    store.auth = SimpleNamespace(admin=store.auth_admin)
    monkeypatch.setattr(account, "supabase_admin", store)

    cleared = []

    async def _record_clear(request_id, path):
        # 삭제 시점에 계정이 아직 살아 있는지 함께 붙잡는다. 경로만 보면 순서를 알 수 없는데,
        # 순서가 뒤집히면(계정 먼저) 경로를 읽을 방법 자체가 사라져 파일이 영영 남는다.
        cleared.append(
            {"request_id": request_id, "path": path, "deleted_so_far": list(store.auth_admin.deleted)}
        )

    monkeypatch.setattr(account, "clear_verification_evidence", _record_clear)
    with TestClient(app) as http:
        yield http, store, cleared


def test_delete_clears_pending_evidence_before_deleting_the_account(delete_client):
    http, store, cleared = delete_client
    res = http.delete("/api/v1/account/me")
    assert res.status_code == 200
    assert [c["path"] for c in cleared] == ["u1/proof.jpg"], "버킷에 사업자등록증이 남았다"
    assert cleared[0]["request_id"] == "req-1"
    assert cleared[0]["deleted_so_far"] == [], "계정을 먼저 지웠다 — 경로를 읽을 방법이 사라진다"
    assert store.auth_admin.deleted == ["u1"]


def test_delete_never_touches_someone_elses_evidence(delete_client):
    """경로는 신청 행에서 오고, 그 행은 user_id 로 걸러진다."""
    http, store, cleared = delete_client
    http.delete("/api/v1/account/me")
    assert [c["path"] for c in cleared] == ["u1/proof.jpg"]
    assert store.row("req-other")["document_path"] == "u2/proof.jpg"


def test_delete_without_evidence_clears_nothing(delete_client):
    """결정이 끝난 신청은 document_path 가 이미 NULL 이다 — 지울 것이 없다."""
    http, store, cleared = delete_client
    store.row("req-1")["document_path"] = None
    assert http.delete("/api/v1/account/me").status_code == 200
    assert cleared == []
    assert store.auth_admin.deleted == ["u1"]


def test_the_account_is_deleted_even_when_the_evidence_lookup_fails(delete_client):
    """신청을 못 읽었다고 탈퇴를 막으면, 우리 쪽 장애가 사용자의 권리를 볼모로 잡는다."""
    http, store, cleared = delete_client
    store.select_error = RuntimeError("server disconnected without sending a response")
    res = http.delete("/api/v1/account/me")
    assert res.status_code == 200, "증빙 조회 실패가 탈퇴를 막았다"
    assert cleared == []
    assert store.auth_admin.deleted == ["u1"]


def test_the_account_is_deleted_even_when_the_file_removal_fails(monkeypatch, delete_client):
    """스토리지가 죽어도 탈퇴는 끝난다.

    여기서는 대역이 아니라 **진짜 clear_verification_evidence** 를 태운다 — 그 함수가
    예외를 삼킨다는 약속에 이 엔드포인트가 기대고 있어서, 대역으로 바꾸면 그 약속이
    깨지는 날을 이 테스트가 못 잡는다."""
    http, store, _ = delete_client
    monkeypatch.setattr(account, "clear_verification_evidence", clear_verification_evidence)

    class _DeadBucket:
        def remove(self, _paths):
            raise RuntimeError("storage unavailable")

    monkeypatch.setattr(
        verification_evidence,
        "supabase_admin",
        SimpleNamespace(storage=SimpleNamespace(from_=lambda _bucket: _DeadBucket())),
    )
    res = http.delete("/api/v1/account/me")
    assert res.status_code == 200, "증빙 삭제 실패가 탈퇴를 막았다"
    assert store.auth_admin.deleted == ["u1"]
