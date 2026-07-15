"""거절 실험실(Rejection Lab) 라우터 테스트 — GET /pending, /pending/count, POST /{id}/reason|skip|hide.

실DB·실네트워크는 쓰지 않는다(감사 '테스트 공백' 항). user_feedback 을 흉내 내는 인메모리 가짜
Supabase 를 라우터의 supabase_admin 자리에 끼워 넣고, 선호 벡터는 preference_vector_service 를
patch.object 로 가로채 **호출 횟수**를 센다 — '학습 정확히 1회' 계약은 호출 횟수로만 검증 가능하다.
"""
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.core.supabase import get_current_user
from app.services import feedback_service as fs
from app.services.preference_vector_service import preference_vector_service

NOW = datetime(2026, 7, 15, 12, 0, 0, tzinfo=timezone.utc)
USER = "11111111-1111-1111-1111-111111111111"
OTHER_USER = "22222222-2222-2222-2222-222222222222"
FEEDBACK_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff"
REC_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
FACILITY = {"id": "fac-1", "name": "황리단길 카페", "type": "cafe"}
RECOMMENDATION = {
    "id": REC_ID,
    "user_id": USER,
    "recommended_facility_id": FACILITY["id"],
    "recommended_facility": FACILITY,
}


# --- 가짜 Supabase: 라우터가 실제로 거는 필터/정렬만 구현한다 ---------------------


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, rows: list[dict]):
        self._rows = rows  # 라이브 참조 — update 가 원본에 반영돼야 한다.
        self._op = None
        self._patch = None
        self._filters = []
        self._order = None
        self._desc = False

    def select(self, *_a, **_k):
        self._op = "select"
        return self

    def insert(self, payload):
        self._op = "insert"
        self._patch = payload
        return self

    def update(self, patch):
        self._op = "update"
        self._patch = patch
        return self

    def eq(self, col, val):
        self._filters.append(("eq", col, val))
        return self

    def in_(self, col, vals):
        self._filters.append(("in", col, list(vals)))
        return self

    def is_(self, col, val):
        self._filters.append(("is", col, val))
        return self

    def gte(self, col, val):
        self._filters.append(("gte", col, val))
        return self

    def order(self, col, desc=False):
        self._order, self._desc = col, desc
        return self

    def limit(self, _n):
        return self

    def _matches(self, row: dict) -> bool:
        for kind, col, val in self._filters:
            actual = row.get(col)
            if kind == "eq" and actual != val:
                return False
            if kind == "in" and actual not in val:
                return False
            if kind == "is" and not (val == "null" and actual is None):
                return False
            if kind == "gte" and not (actual is not None and str(actual) >= str(val)):
                return False
        return True

    def execute(self):
        if self._op == "insert":
            row = dict(self._patch)
            row.setdefault("id", FEEDBACK_ID)
            self._rows.append(row)
            return _Result([row])
        hits = [r for r in self._rows if self._matches(r)]
        if self._op == "update":
            for row in hits:
                row.update(self._patch)
            return _Result([dict(r) for r in hits])
        if self._order:
            hits = sorted(hits, key=lambda r: str(r.get(self._order) or ""), reverse=self._desc)
        return _Result([dict(r) for r in hits])


class FakeSupabase:
    def __init__(self, tables: dict[str, list[dict]]):
        self._tables = tables

    def table(self, name: str) -> _Query:
        return _Query(self._tables.setdefault(name, []))


# --- 픽스처 ---------------------------------------------------------------------


@pytest.fixture
def auth_client():
    app.dependency_overrides[get_current_user] = lambda: {
        "id": USER,
        "email": "tourist@example.com",
        "role": "authenticated",
    }
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture(autouse=True)
def frozen_now(monkeypatch):
    """서비스·라우터가 공유하는 단일 시계(feedback_service._utcnow)를 고정한다."""
    monkeypatch.setattr(fs, "_utcnow", lambda: NOW)


def _pending_row(idx: int, *, age_days: float = 0.0, user_id: str = USER, **overrides) -> dict:
    row = {
        "id": f"fb-{idx}",
        "user_id": user_id,
        "recommendation_id": REC_ID,
        "action": fs.ACTION_REJECTED,
        "reason_status": fs.STATUS_PENDING,
        "reason_code": None,
        "reason_note": None,
        "hidden_at": None,
        "learning_scope": fs.SCOPE_NONE,
        "learning_applied_at": None,
        "learning_version": 0,
        fs.CREATED_COLUMN: (NOW - timedelta(days=age_days)).isoformat(),
        "recommendation": {
            "id": REC_ID,
            "recommended_facility_id": FACILITY["id"],
            "recommended_facility": FACILITY,
        },
    }
    row.update(overrides)
    return row


def _lab_db(feedback_rows: list[dict]) -> FakeSupabase:
    return FakeSupabase({"user_feedback": feedback_rows, "recommendations": [dict(RECOMMENDATION)]})


# =========================================================================
# 1. pending 목록 — 최신순 10건 상한 + 30일 만료 경계 + 숨김/비-pending 제외
# =========================================================================


def test_pending_returns_latest_ten_newest_first(auth_client):
    # 12건(0.0~5.5일 전)을 넣고 최신순 10건만 오는지 + 정렬이 최신순인지 검증한다.
    rows = [_pending_row(i, age_days=i * 0.5) for i in range(12)]
    with patch("app.routers.lab.supabase_admin", new=_lab_db(rows)):
        res = auth_client.get("/api/v1/lab/pending")

    assert res.status_code == 200
    items = res.json()
    assert len(items) == fs.PENDING_PAGE_LIMIT == 10
    # 최신순: 가장 최근(age 0일)인 fb-0 부터 fb-9 까지. fb-10/fb-11 은 상한에서 잘린다.
    assert [i["id"] for i in items] == [f"fb-{i}" for i in range(10)]
    created = [i["created_at"] for i in items]
    assert created == sorted(created, reverse=True)
    # 시설명이 붙어야 사용자가 "어디를 거절했는지" 알고 답할 수 있다.
    assert items[0]["facility_name"] == FACILITY["name"]
    assert items[0]["facility_id"] == FACILITY["id"]


def test_pending_30day_boundary(auth_client):
    # 경계 계약: 정확히 30일 된 행은 아직 '30일 이내'(포함), 30일을 넘긴 행만 만료.
    rows = [
        _pending_row(1, age_days=29.9),  # 이내
        _pending_row(2, age_days=30.0),  # 정확히 30일 — 포함(경계값 미포함 규칙)
        _pending_row(3, age_days=30.1),  # 만료 — 제외
    ]
    with patch("app.routers.lab.supabase_admin", new=_lab_db(rows)):
        res = auth_client.get("/api/v1/lab/pending")

    assert res.status_code == 200
    assert [i["id"] for i in res.json()] == ["fb-1", "fb-2"]


def test_pending_excludes_hidden_answered_and_other_users(auth_client):
    rows = [
        _pending_row(1),
        _pending_row(2, hidden_at=NOW.isoformat()),  # 숨김
        _pending_row(3, reason_status=fs.STATUS_ANSWERED),  # 이미 응답
        _pending_row(4, reason_status=fs.STATUS_SKIPPED),  # 건너뜀
        _pending_row(5, user_id=OTHER_USER),  # 타인 것 — 절대 새어나오면 안 된다
    ]
    with patch("app.routers.lab.supabase_admin", new=_lab_db(rows)):
        res = auth_client.get("/api/v1/lab/pending")

    assert res.status_code == 200
    assert [i["id"] for i in res.json()] == ["fb-1"]


def test_pending_count_ignores_page_limit(auth_client):
    # 배지 숫자는 목록 상한(10)이 아니라 실제 개수를 센다. 만료·타인 것은 제외.
    rows = [_pending_row(i, age_days=i * 0.1) for i in range(14)]
    rows.append(_pending_row(99, age_days=40))  # 만료
    rows.append(_pending_row(98, user_id=OTHER_USER))  # 타인
    with patch("app.routers.lab.supabase_admin", new=_lab_db(rows)):
        res = auth_client.get("/api/v1/lab/pending/count")

    assert res.status_code == 200
    assert res.json() == {"count": 14}


# =========================================================================
# 2. 사유 확정 — 학습 정확히 1회 / 스코프별 학습 금지
# =========================================================================


def _answer(client, db, reason_code: str, note: str | None = None):
    body = {"reason_code": reason_code}
    if note is not None:
        body["reason_note"] = note
    with patch("app.routers.lab.supabase_admin", new=db), \
         patch("app.routers.recommendations.supabase_client", new=db):
        return client.post(f"/api/v1/lab/{FEEDBACK_ID}/reason", json=body)


def test_reason_long_term_learns_exactly_once(auth_client):
    db = _lab_db([_pending_row(1, id=FEEDBACK_ID)])
    adjust = AsyncMock()
    with patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=adjust):
        first = _answer(auth_client, db, "not_my_taste")
        # 같은 행에 사유를 다시 확정해도(중복 탭/재시도) 재학습은 없어야 한다.
        second = _answer(auth_client, db, "not_my_taste")

    assert first.status_code == 200
    body = first.json()
    assert body["reason_status"] == fs.STATUS_ANSWERED
    assert body["learning_scope"] == fs.SCOPE_LONG_TERM
    assert body["updated_vector"] is True

    assert second.status_code == 200
    assert second.json()["updated_vector"] is False

    # 핵심 계약: 벡터 학습은 정확히 1회, 그리고 감점 방향(-5%)이다.
    assert adjust.await_count == 1
    assert adjust.await_args.kwargs["action"] == "rejected"
    assert adjust.await_args.kwargs["user_id"] == USER

    # 학습 슬롯이 찍혀 재학습이 구조적으로 불가능해진다.
    stored = db._tables["user_feedback"][0]
    assert stored["learning_applied_at"] is not None
    assert stored["learning_version"] == fs.LEARNING_VERSION


@pytest.mark.parametrize(
    "reason_code, expected_scope",
    [
        ("closed", fs.SCOPE_DATA_QUALITY),      # 휴업 — 가게 사정이지 취향이 아니다
        ("inaccurate", fs.SCOPE_DATA_QUALITY),  # 정보 오류 — 데이터 품질 문제
        ("already_visited", fs.SCOPE_NONE),     # 이미 방문 — 재추천 억제만
        ("bad_timing", fs.SCOPE_SESSION),       # 상황 불일치 — 이번 세션 한정
        ("other", fs.SCOPE_NONE),
    ],
)
def test_reason_non_long_term_never_penalizes_taste(auth_client, reason_code, expected_scope):
    db = _lab_db([_pending_row(1, id=FEEDBACK_ID)])
    adjust = AsyncMock()
    with patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=adjust):
        res = _answer(auth_client, db, reason_code)

    assert res.status_code == 200
    body = res.json()
    assert body["learning_scope"] == expected_scope
    assert body["updated_vector"] is False
    # 취향 감점이 단 한 번도 일어나선 안 된다 — 이 기능의 존재 이유다.
    adjust.assert_not_awaited()
    assert db._tables["user_feedback"][0]["learning_applied_at"] is None


def test_reason_note_is_stored_and_length_capped(auth_client):
    db = _lab_db([_pending_row(1, id=FEEDBACK_ID)])
    with patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=AsyncMock()):
        ok = _answer(auth_client, db, "too_far", note="주차장이 없어서요")
        too_long = _answer(auth_client, db, "too_far", note="가" * (fs.REASON_NOTE_MAX_LEN + 1))

    assert ok.status_code == 200
    assert db._tables["user_feedback"][0]["reason_note"] == "주차장이 없어서요"
    # 서버측 길이 검증(DB CHECK 200자와 동일) — pydantic 이 라우터 진입 전에 거른다.
    assert too_long.status_code == 422


def test_reason_invalid_code_422(auth_client):
    db = _lab_db([_pending_row(1, id=FEEDBACK_ID)])
    res = _answer(auth_client, db, "i_just_hate_it")
    assert res.status_code == 422


def test_reason_expired_rejected_409(auth_client):
    # 30일이 지난 pending 은 기억이 흐려져 답을 학습에 쓰지 않는다.
    db = _lab_db([_pending_row(1, id=FEEDBACK_ID, age_days=31)])
    adjust = AsyncMock()
    with patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=adjust):
        res = _answer(auth_client, db, "not_my_taste")
    assert res.status_code == 409
    adjust.assert_not_awaited()


def test_reason_on_never_asked_row_409(auth_client):
    # reason_status='none'(사유를 물은 적 없는 행)에 사유를 밀어 넣어 학습을 유발할 수 없다.
    db = _lab_db([_pending_row(1, id=FEEDBACK_ID, reason_status=fs.STATUS_NONE)])
    adjust = AsyncMock()
    with patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=adjust):
        res = _answer(auth_client, db, "not_my_taste")
    assert res.status_code == 409
    adjust.assert_not_awaited()


# =========================================================================
# 3. 소유권 — 타인 것 조회/수정 차단
# =========================================================================


def test_reason_on_other_users_feedback_403(auth_client):
    db = _lab_db([_pending_row(1, id=FEEDBACK_ID, user_id=OTHER_USER)])
    adjust = AsyncMock()
    with patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=adjust):
        res = _answer(auth_client, db, "not_my_taste")

    assert res.status_code == 403
    # 타인의 취향 벡터가 조작되지 않았고, 행도 그대로여야 한다.
    adjust.assert_not_awaited()
    assert db._tables["user_feedback"][0]["reason_status"] == fs.STATUS_PENDING


def test_skip_and_hide_on_other_users_feedback_403(auth_client):
    for path in ("skip", "hide"):
        db = _lab_db([_pending_row(1, id=FEEDBACK_ID, user_id=OTHER_USER)])
        with patch("app.routers.lab.supabase_admin", new=db):
            res = auth_client.post(f"/api/v1/lab/{FEEDBACK_ID}/{path}")
        assert res.status_code == 403, path
        assert db._tables["user_feedback"][0]["hidden_at"] is None
        assert db._tables["user_feedback"][0]["reason_status"] == fs.STATUS_PENDING


def test_missing_feedback_404(auth_client):
    db = _lab_db([])
    with patch("app.routers.lab.supabase_admin", new=db):
        res = auth_client.post(f"/api/v1/lab/{FEEDBACK_ID}/skip")
    assert res.status_code == 404


def test_non_uuid_feedback_id_404(auth_client):
    # uuid 컬럼 캐스팅 오류로 500 이 나기 전에 깔끔한 404.
    db = _lab_db([])
    with patch("app.routers.lab.supabase_admin", new=db):
        res = auth_client.post("/api/v1/lab/not-a-uuid/skip")
    assert res.status_code == 404


def test_lab_requires_auth():
    with TestClient(app) as c:
        assert c.get("/api/v1/lab/pending").status_code == 401
        assert c.get("/api/v1/lab/pending/count").status_code == 401
        assert c.post(f"/api/v1/lab/{FEEDBACK_ID}/skip").status_code == 401


# =========================================================================
# 4. skip / hide — 학습 없이 목록에서만 내린다
# =========================================================================


def test_skip_sets_status_without_learning(auth_client):
    db = _lab_db([_pending_row(1, id=FEEDBACK_ID)])
    adjust = AsyncMock()
    with patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=adjust), \
         patch("app.routers.lab.supabase_admin", new=db):
        res = auth_client.post(f"/api/v1/lab/{FEEDBACK_ID}/skip")

    assert res.status_code == 200
    assert res.json()["reason_status"] == fs.STATUS_SKIPPED
    row = db._tables["user_feedback"][0]
    assert row["reason_status"] == fs.STATUS_SKIPPED
    assert row["learning_applied_at"] is None
    adjust.assert_not_awaited()


def test_hide_sets_hidden_at_and_drops_from_list(auth_client):
    db = _lab_db([_pending_row(1, id=FEEDBACK_ID)])
    with patch("app.routers.lab.supabase_admin", new=db):
        hidden = auth_client.post(f"/api/v1/lab/{FEEDBACK_ID}/hide")
        listed = auth_client.get("/api/v1/lab/pending")
        count = auth_client.get("/api/v1/lab/pending/count")

    assert hidden.status_code == 200
    assert hidden.json()["hidden_at"] == NOW.isoformat()
    # 숨긴 항목은 목록·배지 양쪽에서 즉시 사라진다.
    assert listed.json() == []
    assert count.json() == {"count": 0}


# =========================================================================
# 5. 계약 패리티 — 라우터 Literal 이 서비스/DB 어휘와 어긋나면 즉시 실패
# =========================================================================


def test_reason_code_literal_matches_service_whitelist():
    from typing import get_args

    from app.routers.lab import ReasonRequest

    literal = set(get_args(ReasonRequest.model_fields["reason_code"].annotation))
    assert literal == set(fs.REASON_CODES)
