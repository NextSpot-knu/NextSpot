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
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core import authz
from app.routers import dev
from app.services.localdata import capacity_for
from tests.conftest import make_test_jwt

DEVELOPER_ID = "d0000000-0000-4000-8000-000000000001"
TARGET_ID = "d0000000-0000-4000-8000-000000000002"
OTHER_DEV_ID = "d0000000-0000-4000-8000-000000000003"
GUEST_ID = "d0000000-0000-4000-8000-000000000004"
FACILITY_ID = "f0000000-0000-4000-8000-000000000001"
OTHER_FACILITY_ID = "f0000000-0000-4000-8000-000000000002"
CLOSED_FACILITY_ID = "f0000000-0000-4000-8000-000000000003"
MISSING_FACILITY_ID = "f0000000-0000-4000-8000-00000000dead"
OWNER_ROW_ID = "a0000000-0000-4000-8000-000000000001"


# =========================================================================
# 최소 Supabase 대역 — 필터·갱신·카운트를 실제로 수행한다
# =========================================================================
class _Result:
    def __init__(self, data, count=None):
        self.data = data
        self.count = count


class _Query:
    def __init__(
        self,
        rows: list,
        insert_error: Exception | None = None,
        *,
        table: str = "",
        journal: list | None = None,
        update_error: Exception | None = None,
        missing_columns: set | None = None,
    ):
        # 아직 마이그레이션이 안 된 DB. PostgREST 는 없는 컬럼으로 필터하면 조회 전체를
        # 거절한다(PGRST204) — 폴백 경로는 그 거절을 실제로 재현해야만 검증된다.
        self._missing_columns = missing_columns or set()
        self._rows = rows
        self._insert_error = insert_error
        self._update_error = update_error
        # 어떤 테이블에 어떤 순서로 썼는지. 이 라우터의 계약 중 하나가 **쓰기 순서**라
        # (가게 생성 → 신청서 연결 → 소유권) 결과 상태만으로는 검증할 수 없다.
        self._table = table
        self._journal = journal if journal is not None else []
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
        # 실패한 쓰기도 기록한다 — "어디까지 갔다가 멈췄나" 가 곧 복구 가능성이라, 시도 자체가
        # 검증 대상이다.
        self._journal.append((self._table, self._op))
        for col, _op, _val in self._filters:
            if col in self._missing_columns:
                raise RuntimeError(
                    "{'code': 'PGRST204', 'message': \"column "
                    f"{self._table}.{col} does not exist\"}}"
                )
        hits = [r for r in self._rows if self._matches(r)]
        if self._op == "insert":
            if self._insert_error is not None:
                raise self._insert_error
            payload = self._payload if isinstance(self._payload, list) else [self._payload]
            stored = []
            for p in payload:
                row = dict(p)
                # id 는 DB 기본값(gen_random_uuid)이 채운다. 라우터가 새로 만든 가게의 id 를
                # 응답에서 읽어 쓰기 때문에, 그걸 흉내 내지 않으면 실제와 다른 경로를 탄다.
                row.setdefault("id", str(uuid.uuid4()))
                self._rows.append(row)
                stored.append(row)
            return _Result([dict(r) for r in stored])
        if self._op == "update":
            if self._update_error is not None:
                raise self._update_error
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


class _Bucket:
    """서명 URL 생성만 흉내 낸다. 실패를 주입할 수 있어야 폴백 경로를 검사할 수 있다."""

    def __init__(self):
        self.error: Exception | None = None
        self.result: dict | None = {"signedURL": "https://example.test/signed"}
        self.signed: list[tuple] = []

    def create_signed_url(self, path, ttl):
        self.signed.append((path, ttl))
        if self.error is not None:
            raise self.error
        return self.result

    def remove(self, paths):
        return None


class _Storage:
    def __init__(self):
        self.buckets: dict[str, _Bucket] = {}

    def from_(self, name: str) -> _Bucket:
        return self.buckets.setdefault(name, _Bucket())


class _MiniSupabase:
    def __init__(self, tables: dict, auth_users: list | None = None):
        self.tables = tables
        self.storage = _Storage()
        # {테이블명: 예외} — insert/update 를 실패시켜 부분 실패 경로를 검사한다.
        self.insert_errors: dict[str, Exception] = {}
        self.update_errors: dict[str, Exception] = {}
        # {테이블명: {컬럼명}} — 마이그레이션 미적용 DB 를 흉내 낸다.
        self.missing_columns: dict[str, set] = {}
        # (테이블, 연산) 실행 순서. 결과 상태로는 못 보는 계약(쓰기 순서)을 여기서 본다.
        self.calls: list[tuple[str, str]] = []
        # public.users 에는 이메일이 없다 — auth.users 쪽을 따로 들고 있는다.
        self.auth = _Auth(auth_users or [])

    def table(self, name: str) -> _Query:
        return _Query(
            self.tables.setdefault(name, []),
            self.insert_errors.get(name),
            table=name,
            journal=self.calls,
            update_error=self.update_errors.get(name),
            missing_columns=self.missing_columns.get(name),
        )

    def writes(self, *tables: str) -> list[tuple[str, str]]:
        """select 를 걷어낸 쓰기 순서(원하면 특정 테이블만)."""
        return [
            (t, op) for t, op in self.calls
            if op != "select" and (not tables or t in tables)
        ]


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
            # 승인 본문으로 온 facility_id 는 실존·표출 여부를 검사한다 — 없는 가게에
            # 소유권을 붙이면 관리할 대상이 없는 사장님이 만들어진다.
            "facilities": [
                {"id": FACILITY_ID, "name": "이풍녀 구로쌈밥", "type": "restaurant", "is_active": True},
                {"id": OTHER_FACILITY_ID, "name": "한옥카페 다랑", "type": "cafe", "is_active": True},
                {"id": CLOSED_FACILITY_ID, "name": "폐업한 가게", "type": "cafe", "is_active": False},
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


def test_the_queue_shows_the_facility_name_not_just_a_uuid(client, db):
    """facility_id 는 신청자가 본문에 적어 보낸 값이다. uuid 만 보고 승인하면 남의 가게
    소유권을 줄 수 있어서, 심사자가 신청서의 가게 이름과 눈으로 맞출 수 있어야 한다."""
    db.tables["business_verification_requests"] = [
        {
            "id": REQUEST_ID, "user_id": TARGET_ID, "status": "pending",
            "requested_role": "merchant", "facility_id": FACILITY_ID,
            "facilities": {"name": "이풍녀 구로쌈밥", "type": "restaurant"},
        },
    ]
    with _as("developer"):
        res = client.get("/api/v1/dev/verification-requests", headers=_headers())
    row = res.json()["items"][0]
    assert row["facility_name"] == "이풍녀 구로쌈밥"
    assert row["facility_type"] == "restaurant"
    assert "facilities" not in row, "임베드 원형이 그대로 새어 나갔다"


def test_an_admin_request_survives_the_missing_embed(client, db):
    """관리자 신청은 facility_id 가 NULL 이라 임베드 자체가 없다 — 그 때문에 관리자 하위
    메뉴가 통째로 깨지면 안 된다."""
    db.tables["business_verification_requests"] = [
        {"id": "b2", "user_id": OTHER_DEV_ID, "status": "pending", "requested_role": "admin"},
    ]
    with _as("developer"):
        res = client.get("/api/v1/dev/verification-requests", headers=_headers())
    assert res.status_code == 200
    assert res.json()["items"][0]["facility_name"] is None


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
    """가게가 연결되지 않은 요청을 승인하면 소유권 없는 merchant 가 생긴다.

    다만 문구는 존재하는 동선을 가리켜야 한다. 예전 문구("먼저 시설을 매핑하세요")가 가리킨
    매핑 화면은 **없었고**, 신청 화면의 가게 검색도 없어서 모든 신청이 facility_id NULL 로
    들어왔다 — 즉 사업자 승인이 앱 전체에서 한 건도 불가능했다."""
    pending_request["facility_id"] = None
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        res = client.post(
            f"/api/v1/dev/verification-requests/{REQUEST_ID}/approve", json={}, headers=_headers()
        )
    assert res.status_code == 409
    detail = res.json()["detail"]
    assert "매핑" not in detail, f"없는 화면을 가리키는 옛 문구가 남았다: {detail}"
    assert "새 가게로 등록" in detail, f"두 번째 길(신규 등록)을 안내하지 않는다: {detail}"
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


# ── 미등록 가게 승인 — 권한이 아니라 '관리할 POI' 를 만들어 준다 ─────────────
# 카카오맵/TourAPI 어디에도 없는 가게의 사장님이 신청하는 경우가 있다. 역할만 주면 콘솔에는
# 들어가지는데 모든 요청이 403 인 막다른 계정이 된다. 그래서 승인 시점에 가게를 만든다.
# 여기서 잠그는 건 그 경로의 **쓰기 순서**다 — 순서가 곧 재시도 안전성이다.

NEW_FACILITY = {
    "name": "황리단길 이름없는 커피",
    "type": "cafe",
    "latitude": 35.8355,
    "longitude": 129.2115,
    "address": "경북 경주시 포석로 1080",
    "phone": "054-000-0000",
}


def _approve(client, body):
    return client.post(
        f"/api/v1/dev/verification-requests/{REQUEST_ID}/approve", json=body, headers=_headers()
    )


def test_two_ways_to_link_a_facility_is_refused_before_any_write(client, db, pending_request):
    """둘 다 주면 어느 쪽이 쓰였는지 심사자가 알 수 없다. 조용히 우선순위를 정하면
    '새로 만든 줄 알았는데 기존 가게에 소유권이 붙었다' 가 된다 — 되돌릴 수도 없다."""
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        res = _approve(client, {"facility_id": FACILITY_ID, "new_facility": NEW_FACILITY})
    assert res.status_code == 422
    assert db.writes() == [], f"거절해 놓고 쓰기가 일어났다: {db.writes()}"
    assert len(db.tables["facilities"]) == 3, "가게가 새로 만들어졌다"
    assert pending_request["status"] == "pending"


@pytest.mark.parametrize(
    "body",
    [{"facility_id": FACILITY_ID}, {"new_facility": NEW_FACILITY}],
    ids=["existing", "new"],
)
def test_an_admin_request_refuses_a_facility(client, db, pending_request, body):
    """관리자에게는 다루는 가게가 없다. 조용히 무시하면 심사자는 자기가 연결했다고 믿는다."""
    pending_request["requested_role"] = "admin"
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        res = _approve(client, body)
    assert res.status_code == 422
    assert db.writes() == []
    assert db.tables["users"][1]["role"] == "tourist"


def test_a_new_facility_is_linked_to_the_request_before_ownership(client, db, pending_request):
    """이 테스트가 지키는 건 결과가 아니라 **순서**다.

    가게 생성 → 신청서 연결 → 소유권. 연결이 소유권 뒤로 밀리면, 소유권 부여가 실패해
    요청이 pending 으로 남았을 때 재승인이 같은 이름의 가게를 한 번 더 만든다."""
    pending_request["facility_id"] = None
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        res = _approve(client, {"reason": "전화 확인", "new_facility": NEW_FACILITY})
    assert res.status_code == 200, res.text

    created = [f for f in db.tables["facilities"] if f["name"] == NEW_FACILITY["name"]]
    assert len(created) == 1, f"가게가 {len(created)}개 만들어졌다"
    new_id = created[0]["id"]

    order = db.writes("facilities", "business_verification_requests", "facility_owners")
    assert order[:3] == [
        ("facilities", "insert"),
        ("business_verification_requests", "update"),
        ("facility_owners", "insert"),
    ], f"쓰기 순서가 계약을 어겼다: {order}"

    assert pending_request["facility_id"] == new_id, "신청서에 새 가게가 적히지 않았다"
    grants = [r for r in db.tables["facility_owners"] if r.get("verification_request_id") == REQUEST_ID]
    assert [g["facility_id"] for g in grants] == [new_id]
    body = res.json()
    assert body["created_facility"] is True
    assert body["facility_id"] == new_id
    assert body["requested_role"] == "merchant"


def test_a_created_facility_records_that_it_was_never_verified(client, db, pending_request):
    """이 행은 TourAPI/LocalData 대조를 거치지 않았다 — 사람이 신청서만 보고 만든 POI다.
    적재 파이프라인이 만든 행과 구분되지 않으면 나중에 데이터 품질을 따질 수 없다."""
    pending_request["facility_id"] = None
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        assert _approve(client, {"new_facility": NEW_FACILITY}).status_code == 200

    row = [f for f in db.tables["facilities"] if f["name"] == NEW_FACILITY["name"]][0]
    assert row["features"]["origin"] == "merchant_request"
    assert row["features"]["verification_request_id"] == REQUEST_ID
    assert row["features"]["capacity_evidence"] == "synthetic_type_default"
    assert row["is_active"] is True
    assert row["address"] == NEW_FACILITY["address"]
    assert row["phone"] == NEW_FACILITY["phone"]
    # 외부 출처가 없다 — 비워 두는 게 사실이다(빈 문자열은 '있다'로 읽힌다).
    assert "contentid" not in row and "external_id" not in row
    # 수용 인원은 적재 파이프라인과 같은 함수로 정한다(cafe → 24, restaurant → 30).
    assert row["capacity"] == capacity_for("cafe")


def test_a_reviewer_supplied_capacity_is_not_labelled_a_default(client, db, pending_request):
    """심사자가 직접 적어 넣은 좌석 수를 '업종 기본값' 이라고 기록하면 그 자체가 거짓된
    품질 표시가 된다 — 나중에 근거로 되짚을 수 없다."""
    pending_request["facility_id"] = None
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        assert _approve(client, {"new_facility": {**NEW_FACILITY, "capacity": 12}}).status_code == 200
    row = [f for f in db.tables["facilities"] if f["name"] == NEW_FACILITY["name"]][0]
    assert row["capacity"] == 12
    assert row["features"]["capacity_evidence"] != "synthetic_type_default"


def test_a_failed_owner_grant_keeps_the_new_facility_linked(client, db, pending_request):
    """재시도 안전성 — 이 코드의 유일한 회복 수단이다.

    소유권 부여가 실패하면 요청은 pending 으로 남고 심사자는 다시 승인을 누른다. 그때
    신청서에 새 가게 id 가 이미 적혀 있어야 같은 가게가 또 만들어지지 않는다."""
    pending_request["facility_id"] = None
    db.insert_errors["facility_owners"] = RuntimeError(
        "server disconnected without sending a response"
    )
    clear = AsyncMock()
    with _as("developer"), patch.object(dev, "_clear_evidence", new=clear):
        res = _approve(client, {"new_facility": NEW_FACILITY})
    assert res.status_code == 503
    assert pending_request["status"] == "pending", "승인이 되돌릴 수 없는 상태로 굳었다"
    created = [f for f in db.tables["facilities"] if f["name"] == NEW_FACILITY["name"]]
    assert len(created) == 1
    assert pending_request["facility_id"] == created[0]["id"], "재승인이 유령 POI 를 또 만든다"
    assert pending_request["document_path"], "증빙이 지워져 다시 심사할 근거가 사라졌다"
    clear.assert_not_awaited()

    # 실제로 다시 승인해 본다 — 이번엔 가게를 새로 만들지 않고 신청서의 값을 쓴다.
    db.insert_errors.pop("facility_owners")
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        retry = _approve(client, {})
    assert retry.status_code == 200
    assert retry.json()["created_facility"] is False
    assert len([f for f in db.tables["facilities"] if f["name"] == NEW_FACILITY["name"]]) == 1
    assert retry.json()["facility_id"] == created[0]["id"]


def test_a_failed_facility_insert_leaves_the_request_pending(client, db, pending_request):
    """가게를 못 만든 건 '가게가 없다'가 아니라 우리 쪽 장애다 — 503 으로 끊고 상태는 둔다."""
    pending_request["facility_id"] = None
    db.insert_errors["facilities"] = RuntimeError("server disconnected")
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        res = _approve(client, {"new_facility": NEW_FACILITY})
    assert res.status_code == 503
    assert pending_request["status"] == "pending"
    assert db.tables["users"][1]["role"] == "tourist", "가게 없이 역할만 올라갔다"
    assert db.writes("facility_owners") == []


def test_a_failed_link_stops_before_ownership(client, db, pending_request):
    """연결이 실패했는데 소유권을 붙이면, 신청서는 여전히 비어 있는 채로 소유권만 남는다 —
    재승인이 두 번째 가게를 만들고 어느 쪽이 진짜인지 알 수 없게 된다."""
    pending_request["facility_id"] = None
    db.update_errors["business_verification_requests"] = RuntimeError("server disconnected")
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        res = _approve(client, {"new_facility": NEW_FACILITY})
    assert res.status_code == 503
    assert db.writes("facility_owners") == [], "연결도 못 했는데 소유권이 붙었다"
    assert pending_request["status"] == "pending"


def test_a_body_facility_id_wins_over_the_request(client, db, pending_request):
    """신청서의 facility_id 는 **신청자가 적어 보낸 값**이다. 심사자가 이번 승인에서 고른
    쪽이 뒤로 밀리면, 화면에서 바로잡은 내용이 조용히 무시된다."""
    pending_request["facility_id"] = FACILITY_ID
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        res = _approve(client, {"facility_id": OTHER_FACILITY_ID})
    assert res.status_code == 200
    assert res.json()["facility_id"] == OTHER_FACILITY_ID
    assert res.json()["created_facility"] is False
    grants = [r for r in db.tables["facility_owners"] if r.get("verification_request_id") == REQUEST_ID]
    assert [g["facility_id"] for g in grants] == [OTHER_FACILITY_ID]
    assert db.writes("facilities") == [], "기존 가게를 고르면 새로 만들지 않는다"


@pytest.mark.parametrize(
    "facility_id", [MISSING_FACILITY_ID, CLOSED_FACILITY_ID], ids=["missing", "closed"]
)
def test_an_unusable_facility_id_is_refused(client, db, pending_request, facility_id):
    """없는(또는 폐업 처리된) 가게에 소유권을 붙이면 관리할 대상이 없는 사장님이 생긴다."""
    with _as("developer"), patch.object(dev, "_clear_evidence", new=AsyncMock()):
        res = _approve(client, {"facility_id": facility_id})
    assert res.status_code == 422
    assert db.writes() == []
    assert pending_request["status"] == "pending"


# ── 심사 큐 — requested_role 컬럼이 없는 DB 에서도 살아 있어야 한다 ──────────
# 마이그레이션(20260902130000)은 사람이 원격 SQL Editor 에 붙여넣는다. 백엔드 배포가 먼저
# 나가는 순서가 실제로 가능하고, 그때 큐가 500 이면 **사업자 승인도 같이 막힌다**.


def test_the_queue_survives_a_missing_requested_role_column(client, db):
    db.missing_columns["business_verification_requests"] = {"requested_role"}
    db.tables["business_verification_requests"] = [
        {"id": REQUEST_ID, "user_id": TARGET_ID, "status": "pending", "facility_id": FACILITY_ID},
    ]
    with _as("developer"):
        res = client.get(
            "/api/v1/dev/verification-requests?requested_role=merchant", headers=_headers()
        )
    assert res.status_code == 200, res.text
    assert [r["id"] for r in res.json()["items"]] == [REQUEST_ID]


def test_the_admin_queue_is_empty_on_a_legacy_schema(client, db):
    """컬럼이 없으면 관리자 신청은 애초에 접수될 수 없다(account.py 가 503 으로 막는다).
    그러니 빈 목록이 사실이다 — 사업자 신청을 관리자 큐에 섞어 보여 주면 안 된다."""
    db.missing_columns["business_verification_requests"] = {"requested_role"}
    db.tables["business_verification_requests"] = [
        {"id": REQUEST_ID, "user_id": TARGET_ID, "status": "pending", "facility_id": FACILITY_ID},
    ]
    with _as("developer"):
        res = client.get(
            "/api/v1/dev/verification-requests?requested_role=admin", headers=_headers()
        )
    assert res.status_code == 200
    assert res.json()["items"] == []


# ── 증빙 서명 URL — 심사자가 서류를 볼 수 있어야 대조가 성립한다 ────────────
# 버킷은 비공개이고 신청자 본인만 자기 폴더를 읽는다. 심사자는 그 정책으로 못 보므로
# 백엔드가 service_role 로 서명해 준다. 이 경로가 막히면 심사자는 신청자가 적어 보낸
# facility_id 를 대조할 근거가 없어진다.

DOC_URL = "/api/v1/dev/verification-requests/{}/document"


def test_developer_gets_a_short_lived_signed_url(client, db):
    db.tables["business_verification_requests"] = [
        {"id": REQUEST_ID, "user_id": TARGET_ID, "status": "pending", "document_path": "u1/proof.jpg"},
    ]
    with _as("developer"):
        res = client.get(DOC_URL.format(REQUEST_ID), headers=_headers())
    assert res.status_code == 200
    assert res.json()["url"] == "https://example.test/signed"
    # 서명은 그 경로에 대해, 짧은 수명으로 이뤄져야 한다.
    path, ttl = db.storage.from_("business-documents").signed[0]
    assert path == "u1/proof.jpg"
    assert 0 < ttl <= 600, f"서명 URL 수명이 너무 길다: {ttl}s"


@pytest.mark.parametrize("role", ["tourist", "merchant", "admin"])
def test_only_developers_can_open_evidence(client, db, role):
    """증빙은 사업자등록증이다 — 심사 권한이 없는 역할에게 열리면 안 된다."""
    db.tables["business_verification_requests"] = [
        {"id": REQUEST_ID, "user_id": TARGET_ID, "status": "pending", "document_path": "u1/proof.jpg"},
    ]
    with _as(role):
        res = client.get(DOC_URL.format(REQUEST_ID), headers=_headers())
    assert res.status_code == 403


def test_a_reviewed_request_has_no_evidence_left(client, db):
    """심사가 끝나면 서버가 파일과 경로를 지운다(보관하지 않는다는 결정).
    그때 404 는 오류가 아니라 정상 상태다 — 500 으로 새어 나가면 안 된다."""
    db.tables["business_verification_requests"] = [
        {"id": REQUEST_ID, "user_id": TARGET_ID, "status": "approved", "document_path": None},
    ]
    with _as("developer"):
        res = client.get(DOC_URL.format(REQUEST_ID), headers=_headers())
    assert res.status_code == 404


def test_a_signing_failure_is_a_503_not_a_500(client, db):
    db.tables["business_verification_requests"] = [
        {"id": REQUEST_ID, "user_id": TARGET_ID, "status": "pending", "document_path": "u1/proof.jpg"},
    ]
    db.storage.from_("business-documents").error = RuntimeError("storage down")
    with _as("developer"):
        res = client.get(DOC_URL.format(REQUEST_ID), headers=_headers())
    assert res.status_code == 503
