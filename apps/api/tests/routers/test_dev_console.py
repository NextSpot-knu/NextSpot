# 개발자 콘솔(/api/v1/dev) — 앱에서 **가장 강한 권한**을 가진 표면이다.
# 여기서 역할을 임명하고 가게 소유권을 주며, 그 소유권이 곧 "verified 학습 데이터를
# 만들 수 있는 권리"다(CONGESTION_TRUST_SPEC). 그래서 다음을 잠근다:
#
#   · developer 외에는 아무도 못 들어온다 — tourist/merchant/admin 전부 403, 무인증 401
#   · 마지막 developer 는 강등할 수 없다(아무도 권한을 줄 수 없는 잠김 방지)
#   · 소유권 회수는 DELETE 가 아니라 revoked_at — 감사 이력이 남아야 한다
#   · 권한이 바뀌면 프로필 캐시를 즉시 비운다(안 그러면 최대 30초간 구 권한이 통한다)
#   · 개발자 화면에도 이메일 원문을 뿌리지 않는다
#
# 인증은 실제 경로를 그대로 탄다(진짜 서명된 JWT → get_current_user → get_current_profile).
# 역할만 _load_profile 패치로 정하고, DB 는 아래 _MiniSupabase 로 대체한다.
#
# test_routers.FakeSupabase 를 쓰지 않는 이유: 그 fake 는 체이닝을 전부 흡수해 canned
# 데이터를 돌려줄 뿐 **필터링도 변경도 하지 않는다**. 이 라우터의 핵심은 상태 전이
# (역할 변경·회수 표시)라서, 그걸 못 보는 fake 로는 아무것도 검증하지 못한다.
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core import authz
from app.routers import dev
from tests.conftest import make_test_jwt

DEVELOPER_ID = "d0000000-0000-4000-8000-000000000001"
TARGET_ID = "d0000000-0000-4000-8000-000000000002"
OTHER_DEV_ID = "d0000000-0000-4000-8000-000000000003"
FACILITY_ID = "f0000000-0000-4000-8000-000000000001"
OWNER_ROW_ID = "a0000000-0000-4000-8000-000000000001"


# =========================================================================
# 최소 Supabase 대역 — 필터·갱신·카운트를 실제로 수행한다
# =========================================================================
class _Result:
    def __init__(self, data, count=None):
        self.data = data
        self.count = count


class _Query:
    def __init__(self, rows: list):
        self._rows = rows
        self._filters: list[tuple] = []
        self._limit: int | None = None
        self._want_count = False
        self._op = "select"
        self._payload = None

    # --- 빌더 ---
    def select(self, *_cols, **kwargs):
        self._op = "select"
        self._want_count = kwargs.get("count") == "exact"
        return self

    def insert(self, payload):
        self._op, self._payload = "insert", payload
        return self

    def update(self, payload):
        self._op, self._payload = "update", payload
        return self

    def delete(self):
        self._op = "delete"
        return self

    def eq(self, col, val):
        self._filters.append((col, "eq", val))
        return self

    def neq(self, col, val):
        self._filters.append((col, "neq", val))
        return self

    def is_(self, col, val):
        self._filters.append((col, "is", val))
        return self

    def ilike(self, col, pattern):
        self._filters.append((col, "ilike", pattern))
        return self

    def order(self, *_a, **_kw):
        return self

    def limit(self, n):
        self._limit = n
        return self

    def single(self):
        self._limit = 1
        return self

    # --- 실행 ---
    def _matches(self, row) -> bool:
        for col, op, val in self._filters:
            cur = row.get(col)
            if op == "eq" and str(cur) != str(val):
                return False
            if op == "neq" and str(cur) == str(val):
                return False
            if op == "is" and not (cur is None if val == "null" else cur == val):
                return False
            if op == "ilike" and val.strip("%").lower() not in str(cur or "").lower():
                return False
        return True

    def execute(self):
        hits = [r for r in self._rows if self._matches(r)]
        if self._op == "insert":
            payload = self._payload if isinstance(self._payload, list) else [self._payload]
            for p in payload:
                self._rows.append(dict(p))
            return _Result(list(payload))
        if self._op == "update":
            for r in hits:
                r.update(self._payload)
            return _Result(hits)
        if self._op == "delete":
            for r in hits:
                self._rows.remove(r)
            return _Result(hits)
        out = hits[: self._limit] if self._limit else hits
        return _Result(out, count=len(hits) if self._want_count else None)


class _MiniSupabase:
    def __init__(self, tables: dict):
        self.tables = tables

    def table(self, name: str) -> _Query:
        return _Query(self.tables.setdefault(name, []))


# =========================================================================
# 픽스처
# =========================================================================
@pytest.fixture
def db():
    return _MiniSupabase(
        {
            "users": [
                {"id": DEVELOPER_ID, "nickname": "dev", "role": "developer", "created_at": "2026-01-01"},
                {"id": TARGET_ID, "nickname": "가게주인", "role": "tourist", "created_at": "2026-02-01"},
            ],
            "facility_owners": [
                {
                    "id": OWNER_ROW_ID,
                    "user_id": TARGET_ID,
                    "facility_id": FACILITY_ID,
                    "revoked_at": None,
                    "granted_at": "2026-03-01",
                }
            ],
            "business_verification_requests": [],
            "role_audit_log": [],
        }
    )


@pytest.fixture
def client(db):
    test_app = FastAPI()
    test_app.include_router(dev.router)
    with patch.object(dev, "supabase_admin", db), patch.object(authz, "supabase_admin", db):
        with TestClient(test_app) as c:
            yield c


def _headers(uid: str = DEVELOPER_ID) -> dict:
    """실제로 서명된 토큰 — 인증 경로를 우회하지 않는다."""
    return {"Authorization": f"Bearer {make_test_jwt(uid)}"}


def _as(role: str, *, facilities=()):
    """이 사용자의 역할만 갈아끼운다(conftest 의 autouse 패치 위에 덧씌운다)."""
    return patch.object(
        authz,
        "_load_profile",
        new=AsyncMock(return_value={"role": role, "facility_ids": frozenset(facilities)}),
    )


DEV_READ_ROUTES = [
    "/api/v1/dev/users",
    "/api/v1/dev/facility-owners",
    "/api/v1/dev/verification-requests",
    "/api/v1/dev/audit-log",
]


# =========================================================================
# 1. 접근 차단 — developer 외에는 전부 막힌다
# =========================================================================
@pytest.mark.parametrize("path", DEV_READ_ROUTES)
@pytest.mark.parametrize("role", ["tourist", "merchant", "admin"])
def test_non_developer_is_denied_on_every_route(client, path, role):
    """admin 도 막힌다 — 관제 권한과 임명 권한은 다른 축이다."""
    with _as(role):
        res = client.get(path, headers=_headers())
    assert res.status_code == 403, f"{role} 이 {path} 에 들어왔다"


@pytest.mark.parametrize("path", DEV_READ_ROUTES)
def test_unauthenticated_is_denied(client, path):
    assert client.get(path).status_code == 401


@pytest.mark.parametrize("path", DEV_READ_ROUTES)
def test_developer_is_allowed(client, path):
    with _as("developer"):
        assert client.get(path, headers=_headers()).status_code == 200


# =========================================================================
# 2. 역할 임명
# =========================================================================
def test_developer_can_promote_a_user(client, db):
    with _as("developer"):
        res = client.patch(
            f"/api/v1/dev/users/{TARGET_ID}/role",
            json={"role": "merchant", "reason": "사업자 확인 완료"},
            headers=_headers(),
        )
    assert res.status_code == 200
    assert res.json()["changed"] is True
    assert db.tables["users"][1]["role"] == "merchant"


def test_promotion_is_written_to_the_audit_log(client, db):
    """누가 누구에게 무슨 권한을 줬는지 남지 않으면 오염을 되짚을 수 없다."""
    with _as("developer"):
        client.patch(
            f"/api/v1/dev/users/{TARGET_ID}/role", json={"role": "merchant"}, headers=_headers()
        )
    log = db.tables["role_audit_log"]
    assert len(log) == 1
    assert log[0]["target_id"] == TARGET_ID
    assert log[0]["from_value"] == "tourist"
    assert log[0]["to_value"] == "merchant"


def test_last_developer_cannot_be_demoted(client, db):
    """혼자 남은 developer 를 강등하면 아무도 권한을 줄 수 없는 잠김 상태가 된다."""
    with _as("developer"):
        res = client.patch(
            f"/api/v1/dev/users/{DEVELOPER_ID}/role", json={"role": "tourist"}, headers=_headers()
        )
    assert res.status_code == 409
    assert db.tables["users"][0]["role"] == "developer"


def test_developer_can_be_demoted_when_another_exists(client, db):
    db.tables["users"].append(
        {"id": OTHER_DEV_ID, "nickname": "dev2", "role": "developer", "created_at": "2026-01-02"}
    )
    with _as("developer"):
        res = client.patch(
            f"/api/v1/dev/users/{DEVELOPER_ID}/role", json={"role": "tourist"}, headers=_headers()
        )
    assert res.status_code == 200


def test_unknown_role_is_rejected(client):
    with _as("developer"):
        res = client.patch(
            f"/api/v1/dev/users/{TARGET_ID}/role", json={"role": "superuser"}, headers=_headers()
        )
    assert res.status_code == 422


def test_role_change_on_missing_user_is_404(client):
    with _as("developer"):
        res = client.patch(
            "/api/v1/dev/users/00000000-0000-4000-8000-000000000000/role",
            json={"role": "merchant"},
            headers=_headers(),
        )
    assert res.status_code == 404


def test_role_change_invalidates_profile_cache(client):
    """캐시를 안 비우면 강등된 계정이 최대 30초 동안 구 권한으로 계속 쓴다."""
    with _as("developer"), patch.object(dev, "invalidate_profile_cache") as spy:
        client.patch(
            f"/api/v1/dev/users/{TARGET_ID}/role", json={"role": "merchant"}, headers=_headers()
        )
    spy.assert_called_once_with(TARGET_ID)


# =========================================================================
# 3. 소유권 — 회수는 삭제가 아니다
# =========================================================================
def test_revoke_marks_revoked_at_instead_of_deleting(client, db):
    with _as("developer"):
        res = client.delete(f"/api/v1/dev/facility-owners/{OWNER_ROW_ID}", headers=_headers())
    assert res.status_code == 200
    assert res.json()["revoked"] is True
    rows = db.tables["facility_owners"]
    assert len(rows) == 1, "행이 삭제됐다 — 감사 이력이 사라진다"
    assert rows[0]["revoked_at"] is not None


def test_revoke_invalidates_the_owner_cache(client):
    """소유권을 뺏겼는데 캐시가 남으면 그 동안 남의 가게에 계속 방송할 수 있다."""
    with _as("developer"), patch.object(dev, "invalidate_profile_cache") as spy:
        client.delete(f"/api/v1/dev/facility-owners/{OWNER_ROW_ID}", headers=_headers())
    spy.assert_called_once_with(TARGET_ID)


def test_revoking_twice_is_a_noop(client, db):
    db.tables["facility_owners"][0]["revoked_at"] = "2026-04-01"
    with _as("developer"):
        res = client.delete(f"/api/v1/dev/facility-owners/{OWNER_ROW_ID}", headers=_headers())
    assert res.status_code == 200
    assert res.json()["revoked"] is False


def test_revoke_unknown_row_is_404(client):
    with _as("developer"):
        res = client.delete(
            "/api/v1/dev/facility-owners/00000000-0000-4000-8000-000000000000",
            headers=_headers(),
        )
    assert res.status_code == 404


def test_owner_list_hides_revoked_rows(client, db):
    db.tables["facility_owners"].append(
        {
            "id": "a0000000-0000-4000-8000-000000000002",
            "user_id": OTHER_DEV_ID,
            "facility_id": FACILITY_ID,
            "revoked_at": "2026-04-01",
            "granted_at": "2026-03-01",
        }
    )
    with _as("developer"):
        res = client.get("/api/v1/dev/facility-owners", headers=_headers())
    ids = [r["id"] for r in res.json()["items"]]
    assert ids == [OWNER_ROW_ID], "회수된 소유권이 현재 소유자 목록에 섞였다"


# =========================================================================
# 4. 개인정보
# =========================================================================
@pytest.mark.parametrize(
    "raw,masked",
    [
        ("openapi@naver.com", "op***@naver.com"),
        ("ab@x.com", "a***@x.com"),
        ("no-at-sign", "no-at-sign"),
        (None, None),
    ],
)
def test_email_is_masked(raw, masked):
    assert dev._mask_email(raw) == masked


def test_user_search_does_not_return_email(client):
    """검색 결과에 이메일 칼럼 자체가 없어야 한다 — 마스킹 이전에 조회하지 않는다."""
    with _as("developer"):
        res = client.get("/api/v1/dev/users?q=가게", headers=_headers())
    assert res.status_code == 200
    items = res.json()["items"]
    assert items, "닉네임 부분일치 검색이 아무것도 못 찾았다"
    for item in items:
        assert "email" not in item


# =========================================================================
# 5. 사업자 인증 심사 — 순서가 곧 복구 가능성이다
# =========================================================================
REQUEST_ID = "b0000000-0000-4000-8000-000000000001"


@pytest.fixture
def pending_request(db):
    db.tables["business_verification_requests"].append(
        {
            "id": REQUEST_ID,
            "user_id": TARGET_ID,
            "facility_id": FACILITY_ID,
            "status": "pending",
            "document_path": "docs/proof.jpg",
            "business_number_last4": "1234",
            "contact": "owner@example.com",
        }
    )
    return db.tables["business_verification_requests"][0]


def test_approve_promotes_and_grants_ownership(client, db, pending_request):
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        res = client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/approve",
            json={"reason": "서류 확인"},
            headers=_headers(),
        )
    assert res.status_code == 200
    assert db.tables["users"][1]["role"] == "merchant"
    grants = [r for r in db.tables["facility_owners"] if r.get("verification_request_id") == REQUEST_ID]
    assert len(grants) == 1
    assert pending_request["status"] == "approved"


def test_approve_clears_evidence_only_after_the_status_is_written(client, db, pending_request):
    """증빙을 먼저 지우면, 상태 갱신이 실패했을 때 pending 인 채로 증빙만 사라진다 —
    다시 심사할 수도, 신청자에게 돌려줄 수도 없는 상태가 된다."""
    seen: list[str] = []

    async def _spy(_request_id):
        seen.append(pending_request["status"])

    with _as("developer"), patch.object(dev, "_clear_evidence", new=_spy):
        client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/approve",
            json={"reason": "서류 확인"},
            headers=_headers(),
        )
    assert seen == ["approved"], f"증빙 삭제 시점의 상태가 {seen} — 상태 갱신보다 먼저 지웠다"


def test_reject_clears_evidence_only_after_the_status_is_written(client, db, pending_request):
    seen: list[str] = []

    async def _spy(_request_id):
        seen.append(pending_request["status"])

    with _as("developer"), patch.object(dev, "_clear_evidence", new=_spy):
        client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/reject",
            json={"reason": "서류 불충분"},
            headers=_headers(),
        )
    assert seen == ["rejected"]


def test_reject_does_not_promote_or_grant(client, db, pending_request):
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        res = client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/reject",
            json={"reason": "서류 불충분"},
            headers=_headers(),
        )
    assert res.status_code == 200
    assert db.tables["users"][1]["role"] == "tourist"
    assert not [r for r in db.tables["facility_owners"] if r.get("verification_request_id")]


def test_reject_requires_a_reason(client, pending_request):
    """반려 사유가 없으면 신청자가 무엇을 고쳐야 하는지 알 수 없다."""
    with _as("developer"):
        res = client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/reject", json={}, headers=_headers()
        )
    assert res.status_code == 422


def test_second_review_is_rejected(client, db, pending_request):
    pending_request["status"] = "approved"
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        res = client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/approve", json={}, headers=_headers()
        )
    assert res.status_code == 409


def test_approve_without_a_mapped_facility_is_refused(client, db, pending_request):
    """가게가 연결되지 않은 요청을 승인하면 소유권 없는 merchant 가 생긴다."""
    pending_request["facility_id"] = None
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        res = client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/approve", json={}, headers=_headers()
        )
    assert res.status_code == 409
    assert db.tables["users"][1]["role"] == "tourist"


def test_approve_invalidates_profile_cache(client, pending_request):
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()), patch.object(
        dev, "invalidate_profile_cache"
    ) as spy:
        client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/approve", json={}, headers=_headers()
        )
    spy.assert_called_once_with(TARGET_ID)
