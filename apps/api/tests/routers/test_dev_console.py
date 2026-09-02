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
GUEST_ID = "d0000000-0000-4000-8000-000000000004"
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
    def __init__(self, rows: list, insert_error: Exception | None = None):
        self._rows = rows
        self._insert_error = insert_error
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

    def in_(self, col, values):
        self._filters.append((col, "in", [str(v) for v in values]))
        return self

    def or_(self, expr: str):
        """PostgREST or() 의 최소 해석 — `nickname.ilike.*x*,id.in.(a,b)` 형태만 다룬다.

        괄호 깊이를 세어 나눈다. in.(...) 안의 쉼표는 구분자가 아니다."""
        parts, depth, cur = [], 0, ""
        for ch in expr:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            if ch == "," and depth == 0:
                parts.append(cur)
                cur = ""
            else:
                cur += ch
        if cur:
            parts.append(cur)

        clauses = []
        for part in parts:
            col, op, val = part.split(".", 2)
            if op == "ilike":
                clauses.append((col, "ilike", val.strip("*")))
            elif op == "in":
                clauses.append((col, "in", [v for v in val.strip("()").split(",") if v]))
            else:  # pragma: no cover - 테스트가 쓰지 않는 연산자
                raise AssertionError(f"or_ 에 처음 보는 연산자: {op}")
        self._filters.append((None, "or", clauses))
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
    @staticmethod
    def _match_one(row, col, op, val) -> bool:
        cur = row.get(col)
        if op == "eq":
            return str(cur) == str(val)
        if op == "neq":
            return str(cur) != str(val)
        if op == "is":
            return (cur is None) if val == "null" else cur == val
        if op == "ilike":
            return val.strip("%").strip("*").lower() in str(cur or "").lower()
        if op == "in":
            return str(cur) in [str(v) for v in val]
        raise AssertionError(f"처음 보는 연산자: {op}")

    def _matches(self, row) -> bool:
        for col, op, val in self._filters:
            if op == "or":
                if not any(self._match_one(row, c, o, v) for c, o, v in val):
                    return False
                continue
            if not self._match_one(row, col, op, val):
                return False
        return True

    def execute(self):
        hits = [r for r in self._rows if self._matches(r)]
        if self._op == "insert":
            if self._insert_error is not None:
                raise self._insert_error
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


class _AuthUser:
    """GoTrue Admin 이 돌려주는 사용자(필요한 세 필드만).

    is_anonymous 는 실제 gotrue User 모델에 항상 있는 필드다 — 게스트(익명 세션)와
    실계정을 가르는 유일하게 믿을 만한 신호이고, public.users 에는 없다."""

    def __init__(self, id: str, email: str | None, is_anonymous: bool = False):
        self.id = id
        self.email = email
        self.is_anonymous = is_anonymous


class _AdminAuth:
    def __init__(self, users: list):
        self._users = users

    def list_users(self, page=None, per_page=None):
        # 한 페이지에 다 담기는 크기만 쓴다 — 페이지네이션 자체는 여기서 검증하지 않는다.
        return list(self._users) if (page or 1) == 1 else []


class _Auth:
    def __init__(self, users: list):
        self.admin = _AdminAuth(users)


class _MiniSupabase:
    def __init__(self, tables: dict, auth_users: list | None = None):
        self.tables = tables
        # {테이블명: 예외} — insert 를 실패시켜 부분 실패 경로를 검사한다.
        self.insert_errors: dict[str, Exception] = {}
        # public.users 에는 이메일이 없다 — auth.users 쪽을 따로 들고 있는다.
        self.auth = _Auth(auth_users or [])

    def table(self, name: str) -> _Query:
        return _Query(self.tables.setdefault(name, []), self.insert_errors.get(name))


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
                # 익명 세션. 실제 운영 DB 는 619명 중 611명이 이것이라, 목록의 기본값이
                # 사실상 전부 게스트였다(2026-09-02). 최근 가입순 정렬에서 맨 앞에 온다.
                {"id": GUEST_ID, "nickname": None, "role": "tourist", "created_at": "2026-09-01"},
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
        },
        auth_users=[
            _AuthUser(DEVELOPER_ID, "dev@example.com"),
            # 심사용 사업자 계정을 본뜬 행 — **닉네임이 없다.** 이 조합(이메일만 있고
            # 닉네임 NULL)이 실제로 검색 불가를 만든 형태다(openapi@naver.com, 2026-09-02).
            _AuthUser(TARGET_ID, "openapi@naver.com"),
            _AuthUser(OTHER_DEV_ID, None),
            _AuthUser(GUEST_ID, None, is_anonymous=True),
        ],
    )


@pytest.fixture(autouse=True)
def _reset_auth_index():
    """인증 인덱스는 모듈 전역 캐시다 — 테스트끼리 새면 앞 테스트의 db 를 본다."""
    dev._auth_index_cache = None
    yield
    dev._auth_index_cache = None


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


def test_user_search_never_returns_raw_email(client):
    """검색 결과의 이메일은 **항상 마스킹**돼 있어야 한다.

    원래 이 화면은 이메일을 아예 조회하지 않았다(마스킹 이전에 안 읽는 게 안전하다는 판단).
    그런데 자체 이메일 계정은 닉네임이 NULL 이라 **닉네임으로도 uid 로도 찾을 수 없어**
    개발자가 아는 유일한 식별자로는 계정에 영영 닿지 못했다. 그래서 조회는 하되 마스킹해서
    내려주는 쪽으로 바꿨다 — 이 테스트가 그 경계를 지킨다."""
    with _as("developer"):
        res = client.get("/api/v1/dev/users", headers=_headers())
    assert res.status_code == 200
    items = res.json()["items"]
    assert items
    for item in items:
        assert "email" in item, "이메일 칼럼이 사라졌다 — 계정 구분이 다시 불가능해진다"
        if item["email"]:
            assert "***" in item["email"], f"원문 이메일이 그대로 나갔다: {item['email']}"


def test_user_search_finds_account_by_email(client):
    """닉네임이 없는 이메일 계정을 이메일로 찾을 수 있어야 한다.

    회귀 대상: 심사용 사업자 계정 openapi@naver.com 이 개발자 콘솔에서 검색되지 않았다
    (닉네임 NULL + 최근 가입자 20건 밖 → 어떤 경로로도 안 나옴)."""
    with _as("developer"):
        res = client.get("/api/v1/dev/users?q=openapi@naver.com", headers=_headers())
    assert res.status_code == 200
    ids = [i["id"] for i in res.json()["items"]]
    assert ids == [TARGET_ID], "이메일로 계정을 못 찾았다"

    # 부분일치도 된다 — 도메인만 기억나는 경우가 실제로 많다.
    with _as("developer"):
        res = client.get("/api/v1/dev/users?q=naver", headers=_headers())
    assert TARGET_ID in [i["id"] for i in res.json()["items"]]


def test_user_search_filters_by_role(client, db):
    """역할 하위 메뉴 — 관광객 600명에 묻히지 않고 사업자/관리자/개발자만 본다."""
    with _as("developer"):
        res = client.get("/api/v1/dev/users?role=developer", headers=_headers())
    body = res.json()
    assert [i["id"] for i in body["items"]] == [DEVELOPER_ID]
    # 칩에 붙는 건수 — 화면이 따로 세지 않는다. 관광객은 세지 않는다(하위 메뉴가 없다).
    assert body["counts"] == {"merchant": 0, "admin": 0, "developer": 1}

    with _as("developer"):
        res = client.get("/api/v1/dev/users?role=bogus", headers=_headers())
    assert res.status_code == 422, "알 수 없는 역할이 그대로 통과했다"


def test_user_search_survives_auth_admin_failure(client, db):
    """이메일 인덱스가 죽어도 닉네임 검색은 살아 있어야 한다(부가 정보일 뿐이다)."""

    def _boom(*_a, **_kw):
        raise RuntimeError("gotrue down")

    db.auth.admin.list_users = _boom
    with _as("developer"):
        res = client.get("/api/v1/dev/users?q=가게", headers=_headers())
    assert res.status_code == 200
    items = res.json()["items"]
    assert [i["id"] for i in items] == [TARGET_ID]
    assert items[0]["email"] is None


# ── 게스트(익명 세션) 숨기기 ────────────────────────────────────────────────
# 운영 DB 는 619명 중 611명이 익명 세션이라, 최근순 20건이 통째로 "(이름·이메일 없음)" 이었다.
# 걸러 내되 **실계정을 같이 지우면 안 된다** — 여기서 잠그는 건 그 경계다.


def test_guest_sessions_are_hidden_from_the_default_listing(client):
    with _as("developer"):
        res = client.get("/api/v1/dev/users", headers=_headers())
    assert res.status_code == 200
    ids = [i["id"] for i in res.json()["items"]]
    assert GUEST_ID not in ids, "익명 세션이 목록에 남았다"
    assert TARGET_ID in ids and DEVELOPER_ID in ids


def test_hidden_guest_count_is_reported(client):
    """조용히 줄인 목록을 '전부'로 오해하지 않게, 몇 명을 뺐는지 같이 준다."""
    with _as("developer"):
        res = client.get("/api/v1/dev/users", headers=_headers())
    assert res.json()["hidden_guests"] == 1


def test_a_real_account_without_a_nickname_is_still_listed(client, db):
    """openapi@naver.com 형태 — 이메일만 있고 닉네임이 NULL 인 실계정.

    '이름도 이메일도 없으면 게스트' 같은 휴리스틱으로 거르면 이 계정이 같이 사라진다.
    실제로 이 계정을 못 찾아 한 번 헤맸다(2026-09-02). 판정 근거는 is_anonymous 뿐이다."""
    db.tables["users"] = [
        {"id": TARGET_ID, "nickname": None, "role": "merchant", "created_at": "2026-02-01"},
        {"id": GUEST_ID, "nickname": None, "role": "tourist", "created_at": "2026-09-01"},
    ]
    with _as("developer"):
        res = client.get("/api/v1/dev/users", headers=_headers())
    ids = [i["id"] for i in res.json()["items"]]
    assert ids == [TARGET_ID]


def test_a_guest_is_still_reachable_by_exact_uid(client):
    """목록에서 감추는 것과 못 찾게 하는 것은 다르다 — 신고 추적에는 uid 지목이 필요하다."""
    with _as("developer"):
        res = client.get(f"/api/v1/dev/users?q={GUEST_ID}", headers=_headers())
    assert [i["id"] for i in res.json()["items"]] == [GUEST_ID]


def test_listing_is_not_emptied_when_the_auth_index_dies(client, db):
    """페일 오픈. 인덱스가 죽었을 때 필터를 그대로 적용하면 화면이 통째로 빈다 —
    표시용 필터 때문에 콘솔을 못 쓰는 것보다 게스트가 섞여 보이는 편이 낫다."""

    def _boom(*_a, **_kw):
        raise RuntimeError("gotrue down")

    db.auth.admin.list_users = _boom
    with _as("developer"):
        res = client.get("/api/v1/dev/users", headers=_headers())
    assert res.status_code == 200
    assert len(res.json()["items"]) == 3


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


# ── 심사 큐 하위 메뉴(사업자 / 관리자) ──────────────────────────────────────


def test_review_queue_filters_by_requested_role(client, db):
    db.tables["business_verification_requests"] = [
        {"id": REQUEST_ID, "user_id": TARGET_ID, "status": "pending", "requested_role": "merchant"},
        {"id": "b2", "user_id": OTHER_DEV_ID, "status": "pending", "requested_role": "admin"},
    ]
    with _as("developer"):
        res = client.get(
            "/api/v1/dev/verification-requests?requested_role=admin", headers=_headers()
        )
    assert [r["id"] for r in res.json()["items"]] == ["b2"]


# ── 승인 중간 실패 — 소유권 부여가 깨지면 어디서 멈추는가 ────────────────────


def test_a_duplicate_owner_still_approves(client, db, pending_request):
    """이미 소유자인 재심사·중복 신청은 그대로 승인된다(원하던 상태가 이미 성립해 있다)."""
    db.insert_errors["facility_owners"] = RuntimeError(
        "duplicate key value violates unique constraint facility_owners_active_uq"
    )
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        res = client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/approve",
            json={"reason": "재심사"}, headers=_headers(),
        )
    assert res.status_code == 200
    assert db.tables["business_verification_requests"][0]["status"] == "approved"


def test_a_failed_owner_grant_leaves_the_request_reviewable(client, db, pending_request):
    """소유권 부여가 진짜로 실패했는데 승인을 계속하면 **소유권 없는 사업자**가 생긴다 —
    콘솔에는 들어가지는데 모든 요청이 403 이고, approved 라 다시 심사할 수도 없다.
    증빙까지 지워지면 되돌릴 근거도 없다. 그래서 상태를 바꾸기 전에 멈춘다."""
    db.insert_errors["facility_owners"] = RuntimeError(
        "server disconnected without sending a response"
    )
    clear = AsyncMock()
    with _as("developer"), patch.object(dev, "_clear_evidence", new=clear):
        res = client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/approve",
            json={"reason": "서류 확인"}, headers=_headers(),
        )
    assert res.status_code == 503
    row = db.tables["business_verification_requests"][0]
    assert row["status"] == "pending", "승인이 되돌릴 수 없는 상태로 굳었다"
    assert row["document_path"], "증빙이 지워져 다시 심사할 근거가 사라졌다"
    clear.assert_not_awaited()


def test_review_queue_refuses_a_developer_filter(client):
    """개발자 심사 큐는 존재하지 않는다 — 신청이 만들어질 수 없기 때문이다.

    빈 목록을 돌려주면 '아직 신청이 없구나' 로 읽혀, 없는 동선이 있는 것처럼 보인다.
    승격은 /dev 콘솔에서 사용자를 직접 지목하는 경로 하나뿐이다."""
    with _as("developer"):
        res = client.get(
            "/api/v1/dev/verification-requests?requested_role=developer", headers=_headers()
        )
    assert res.status_code == 422


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
    seen: list[tuple[str, str | None]] = []

    async def _spy(_request_id, path):
        seen.append((pending_request["status"], path))

    with _as("developer"), patch.object(dev, "_clear_evidence", new=_spy):
        client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/approve",
            json={"reason": "서류 확인"},
            headers=_headers(),
        )
    assert [s for s, _ in seen] == ["approved"], f"증빙 삭제 시점의 상태가 {seen} — 상태 갱신보다 먼저 지웠다"
    # 순서만 보고 경로를 안 보면 이 버그를 놓친다: 갱신이 document_path 를 NULL 로 만든 뒤에
    # 다시 읽고 있어서 삭제 대상이 언제나 None 이었고, 파일은 한 번도 지워지지 않았다.
    assert seen[0][1] == "docs/proof.jpg", "지울 파일 경로가 전달되지 않았다 — 증빙이 남는다"


def test_reject_clears_evidence_only_after_the_status_is_written(client, db, pending_request):
    seen: list[tuple[str, str | None]] = []

    async def _spy(_request_id, path):
        seen.append((pending_request["status"], path))

    with _as("developer"), patch.object(dev, "_clear_evidence", new=_spy):
        client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/reject",
            json={"reason": "서류 불충분"},
            headers=_headers(),
        )
    assert [s for s, _ in seen] == ["rejected"]
    assert seen[0][1] == "docs/proof.jpg", "지울 파일 경로가 전달되지 않았다 — 증빙이 남는다"


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


def test_admin_request_needs_no_facility_and_grants_admin(client, db, pending_request):
    """관리자 신청은 다루는 가게가 없다 — 가게 매핑을 요구하면 영원히 승인할 수 없다."""
    pending_request["requested_role"] = "admin"
    pending_request["facility_id"] = None
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        res = client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/approve", json={}, headers=_headers()
        )
    assert res.status_code == 200
    assert db.tables["users"][1]["role"] == "admin"
    # 소유권은 붙지 않는다 — 소유권이 곧 verified 학습 데이터를 만들 권리다.
    assert not [r for r in db.tables["facility_owners"] if r.get("verification_request_id") == REQUEST_ID]


def test_approving_an_admin_request_never_grants_merchant(client, db, pending_request):
    """신청 역할을 무시하고 merchant 를 주면, 관리자에게 남의 가게 방송 권한이 생긴다."""
    pending_request["requested_role"] = "admin"
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/approve", json={}, headers=_headers()
        )
    assert db.tables["users"][1]["role"] == "admin"


def test_legacy_request_without_a_role_is_still_a_merchant_request(client, db, pending_request):
    """컬럼이 없는 DB의 기존 행(필드 없음)은 예전과 똑같이 사업자 승인으로 동작해야 한다."""
    pending_request.pop("requested_role", None)
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        res = client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/approve", json={}, headers=_headers()
        )
    assert res.status_code == 200
    assert db.tables["users"][1]["role"] == "merchant"


def test_developer_is_never_demoted_by_an_approval(client, db, pending_request):
    """개발자가 사업자 인증을 내면 승인 시 developer 를 잃는다 — 그러면 안 된다."""
    db.tables["users"][1]["role"] = "developer"
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/approve", json={}, headers=_headers()
        )
    assert db.tables["users"][1]["role"] == "developer"


def test_approve_invalidates_profile_cache(client, pending_request):
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()), patch.object(
        dev, "invalidate_profile_cache"
    ) as spy:
        client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/approve", json={}, headers=_headers()
        )
    spy.assert_called_once_with(TARGET_ID)
