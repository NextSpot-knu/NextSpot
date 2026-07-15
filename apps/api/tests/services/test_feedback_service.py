"""피드백 의미 모델/멱등 학습 서비스 테스트.

실DB·실네트워크는 쓰지 않는다 — user_feedback 테이블의 관련 제약(부분 UNIQUE 인덱스 포함)만
흉내 내는 인메모리 가짜 Supabase 클라이언트를 주입한다(서비스가 client 를 인자로 받는 이유).
"""
import asyncio
import itertools
from datetime import datetime, timedelta, timezone

import pytest

from app.services import feedback_service as fs

NOW = datetime(2026, 7, 15, 12, 0, 0, tzinfo=timezone.utc)
USER = "11111111-1111-1111-1111-111111111111"
OTHER_USER = "22222222-2222-2222-2222-222222222222"
REC = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


# --- 가짜 Supabase --------------------------------------------------------------


class FakeAPIError(Exception):
    """supabase-py 가 부분 UNIQUE 위반 시 올리는 APIError(code='23505') 흉내."""

    def __init__(self, message="duplicate key value violates unique constraint"):
        super().__init__(message)
        self.code = "23505"


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, store, table):
        self._store = store
        self._table = table
        self._op = None
        self._payload = None
        self._filters = []
        self._limit = None

    # --- 빌더 ---
    def select(self, *_cols):
        self._op = "select"
        return self

    def insert(self, payload):
        self._op = "insert"
        self._payload = payload
        return self

    def update(self, patch):
        self._op = "update"
        self._payload = patch
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

    def limit(self, n):
        self._limit = n
        return self

    # --- 실행 ---
    def _matches(self, row):
        for kind, col, val in self._filters:
            if kind == "eq" and row.get(col) != val:
                return False
            if kind == "in" and row.get(col) not in val:
                return False
            if kind == "is" and val in (None, "null") and row.get(col) is not None:
                return False
        return True

    def execute(self):
        rows = self._store.rows(self._table)
        if self._op == "select":
            hits = [dict(r) for r in rows if self._matches(r)]
            if self._limit is not None:
                hits = hits[: self._limit]
            return _Result(hits)
        if self._op == "insert":
            return _Result([self._store.insert(self._table, self._payload)])
        if self._op == "update":
            updated = [
                self._store.update(self._table, r, self._payload) for r in rows if self._matches(r)
            ]
            return _Result(updated)
        raise AssertionError(f"지원하지 않는 op: {self._op}")


class FakeSupabase:
    """user_feedback 최소 스키마 + 부분 UNIQUE 인덱스를 흉내 내는 인메모리 저장소."""

    def __init__(self):
        self._tables: dict[str, list[dict]] = {}
        self._ids = itertools.count(1)
        self.select_calls = 0

    def table(self, name):
        return _Query(self, name)

    def rows(self, name):
        return self._tables.setdefault(name, [])

    def _enforce_partial_unique(self, name, candidate, exclude_id=None):
        """UNIQUE(recommendation_id) WHERE action IN DECISION_ACTIONS."""
        if name != "user_feedback" or candidate.get("action") not in fs.DECISION_ACTIONS:
            return
        for r in self.rows(name):
            if r.get("id") == exclude_id:
                continue
            if (
                r.get("recommendation_id") == candidate.get("recommendation_id")
                and r.get("action") in fs.DECISION_ACTIONS
            ):
                raise FakeAPIError()

    def insert(self, name, payload):
        row = {
            "id": None,
            "reason_code": None,
            "reason_note": None,
            "reason_status": "none",
            "reason_answered_at": None,
            "hidden_at": None,
            "learning_scope": "none",
            "learning_applied_at": None,
            "learning_version": 0,
            fs.CREATED_COLUMN: NOW.isoformat(),
            **payload,
        }
        self._enforce_partial_unique(name, row)
        row["id"] = f"fb-{next(self._ids)}"
        self.rows(name).append(row)
        return dict(row)

    def update(self, name, row, patch):
        self._enforce_partial_unique(name, {**row, **patch}, exclude_id=row.get("id"))
        row.update(patch)
        return dict(row)


@pytest.fixture
def client():
    return FakeSupabase()


@pytest.fixture(autouse=True)
def _freeze_time(monkeypatch):
    monkeypatch.setattr(fs, "_utcnow", lambda: NOW)


def _decision_rows(client, rec=REC):
    return [
        r
        for r in client.rows("user_feedback")
        if r["recommendation_id"] == rec and r["action"] in fs.DECISION_ACTIONS
    ]


# --- 어휘/매핑 계약 ---------------------------------------------------------------


def test_action_vocabulary_matches_contract():
    assert fs.DECISION_ACTIONS == {
        "accepted_visit_intent",
        "rejected",
        "skipped",
        "dismissed_batch",
        "unsaved",
        "accepted",
        "ignored",
    }
    assert fs.QUALITY_ACTIONS == {"helpful", "not_helpful"}
    # legacy 는 API 입력 어휘에서 제외된다.
    assert not (fs.API_ACTIONS & {"accepted", "ignored"})
    # 즉시 학습은 수락 계열뿐 — rejected 는 사유 확정까지 보류다.
    assert fs.LEARNING_ACTIONS == {"accepted_visit_intent", "accepted"}
    assert "rejected" not in fs.LEARNING_ACTIONS


@pytest.mark.parametrize(
    "code,scope",
    [
        ("too_far", "long_term"),
        ("too_crowded", "long_term"),
        ("not_my_taste", "long_term"),
        ("too_expensive", "long_term"),
        ("closed", "data_quality"),
        ("inaccurate", "data_quality"),
        ("already_visited", "none"),
        ("bad_timing", "session"),
        ("other", "none"),
    ],
)
def test_resolve_learning_scope_mapping(code, scope):
    assert fs.resolve_learning_scope(code) == scope
    assert fs.REASON_LEARNING_SCOPE[code] == scope


def test_resolve_learning_scope_rejects_unknown_code():
    with pytest.raises(ValueError):
        fs.resolve_learning_scope("made_up_reason")


# --- record_decision: 멱등성 -----------------------------------------------------


@pytest.mark.asyncio
async def test_same_action_twice_is_idempotent_single_row_single_learning(client):
    first = await fs.record_decision(
        client, user_id=USER, recommendation_id=REC, action="accepted_visit_intent"
    )
    assert first["created"] is True
    assert first["should_learn_vector"] is True  # 학습 1회

    second = await fs.record_decision(
        client, user_id=USER, recommendation_id=REC, action="accepted_visit_intent"
    )
    assert second["created"] is False
    assert second["should_learn_vector"] is False  # 재학습 없음
    assert second["id"] == first["id"]

    assert len(_decision_rows(client)) == 1  # 행 1개


@pytest.mark.asyncio
async def test_rejected_is_pending_and_defers_long_term_learning(client):
    res = await fs.record_decision(client, user_id=USER, recommendation_id=REC, action="rejected")

    assert res["reason_status"] == "pending"
    assert res["learning_scope"] == "none"
    assert res["should_learn_vector"] is False  # 장기 학습 보류
    assert client.rows("user_feedback")[0]["learning_applied_at"] is None


@pytest.mark.parametrize("action", ["skipped", "dismissed_batch", "unsaved"])
@pytest.mark.asyncio
async def test_non_learning_decisions_never_learn(client, action):
    res = await fs.record_decision(client, user_id=USER, recommendation_id=REC, action=action)
    assert res["should_learn_vector"] is False
    assert res["reason_status"] == "none"
    assert res["learning_scope"] == "none"


@pytest.mark.asyncio
async def test_changing_action_updates_row_in_place(client):
    await fs.record_decision(client, user_id=USER, recommendation_id=REC, action="skipped")
    res = await fs.record_decision(
        client, user_id=USER, recommendation_id=REC, action="accepted_visit_intent"
    )

    assert res["created"] is False
    assert res["action_changed"] is True
    assert res["should_learn_vector"] is True  # skipped 는 학습 슬롯을 쓰지 않았다
    assert len(_decision_rows(client)) == 1


@pytest.mark.asyncio
async def test_action_change_after_reason_learning_does_not_learn_again(client):
    """거절→사유(-5% 학습)→수락 으로 바뀌어도 추천당 학습은 최대 1회(불변식 2)."""
    rejected = await fs.record_decision(
        client, user_id=USER, recommendation_id=REC, action="rejected"
    )
    answered = await fs.apply_reason(
        client, feedback_row=rejected["row"], reason_code="too_far", reason_note=None
    )
    assert answered["should_learn_vector"] is True

    accepted = await fs.record_decision(
        client, user_id=USER, recommendation_id=REC, action="accepted_visit_intent"
    )
    assert accepted["action_changed"] is True
    assert accepted["should_learn_vector"] is False
    # 새 액션에 무의미해진 사유 컨텍스트는 리셋된다.
    assert accepted["row"]["reason_code"] is None
    assert accepted["row"]["reason_status"] == "none"


@pytest.mark.asyncio
async def test_record_decision_rejects_quality_action(client):
    with pytest.raises(ValueError):
        await fs.record_decision(client, user_id=USER, recommendation_id=REC, action="helpful")


@pytest.mark.asyncio
async def test_record_decision_never_overwrites_owner_of_existing_row(client):
    """body 의 user_id 를 신뢰하지 않는다 — 기존 행의 소유자는 유지된다(라우터가 소유권 가드)."""
    await fs.record_decision(client, user_id=USER, recommendation_id=REC, action="rejected")
    await fs.record_decision(
        client, user_id=OTHER_USER, recommendation_id=REC, action="accepted_visit_intent"
    )
    assert client.rows("user_feedback")[0]["user_id"] == USER


@pytest.mark.asyncio
async def test_concurrent_insert_race_resolves_to_single_row(client, monkeypatch):
    """동시 요청으로 결정 행이 먼저 만들어진 경우 23505 를 흡수하고 승자 행에 합류한다."""
    real_insert = client.insert
    tripped = {"done": False}

    def _racing_insert(name, payload):
        if not tripped["done"] and name == "user_feedback":
            tripped["done"] = True
            # 우리 insert 직전에 다른 요청이 같은 추천의 결정 행을 만들어 둔 상황.
            real_insert(name, {**payload, "action": "skipped", "reason_status": "none"})
        return real_insert(name, payload)

    monkeypatch.setattr(client, "insert", _racing_insert)

    res = await fs.record_decision(
        client, user_id=USER, recommendation_id=REC, action="accepted_visit_intent"
    )
    assert res["created"] is False
    assert res["action"] == "accepted_visit_intent"
    assert len(_decision_rows(client)) == 1


@pytest.mark.asyncio
async def test_concurrent_action_change_claim_learns_exactly_once(client):
    skipped = await fs.record_decision(
        client, user_id=USER, recommendation_id=REC, action="skipped"
    )

    first, second = await asyncio.gather(
        fs.record_decision(
            client, user_id=USER, recommendation_id=REC, action="accepted_visit_intent"
        ),
        fs.record_decision(
            client, user_id=USER, recommendation_id=REC, action="accepted_visit_intent"
        ),
    )

    assert sum(result["should_learn_vector"] for result in (first, second)) == 1
    assert client.rows("user_feedback")[0]["id"] == skipped["id"]


# --- record_quality_signal --------------------------------------------------------


@pytest.mark.asyncio
async def test_quality_signal_never_learns_and_coexists_with_decision(client):
    await fs.record_decision(client, user_id=USER, recommendation_id=REC, action="rejected")
    res = await fs.record_quality_signal(
        client, user_id=USER, recommendation_id=REC, action="not_helpful"
    )

    assert res["should_learn_vector"] is False
    assert len(_decision_rows(client)) == 1  # 결정 행 UNIQUE 를 건드리지 않는다
    assert len(client.rows("user_feedback")) == 2


@pytest.mark.asyncio
async def test_record_quality_signal_rejects_decision_action(client):
    with pytest.raises(ValueError):
        await fs.record_quality_signal(client, user_id=USER, recommendation_id=REC, action="skipped")


# --- apply_reason -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_long_term_reason_learns_exactly_once(client):
    rejected = await fs.record_decision(
        client, user_id=USER, recommendation_id=REC, action="rejected"
    )

    first = await fs.apply_reason(
        client, feedback_row=rejected["row"], reason_code="not_my_taste", reason_note="  취향 아님  "
    )
    assert first["should_learn_vector"] is True
    assert first["reason_status"] == "answered"
    assert first["learning_scope"] == "long_term"
    assert first["row"]["reason_answered_at"] == NOW.isoformat()
    assert first["row"]["learning_applied_at"] == NOW.isoformat()
    assert first["row"]["learning_version"] == fs.LEARNING_VERSION
    assert first["row"]["reason_note"] == "취향 아님"  # 공백 정규화

    # 재호출(중복 제출/재시도) — 학습 슬롯이 이미 찼으므로 재학습 없음.
    second = await fs.apply_reason(
        client, feedback_row=first["row"], reason_code="not_my_taste", reason_note=None
    )
    assert second["should_learn_vector"] is False
    assert second["reason_status"] == "answered"


@pytest.mark.asyncio
async def test_concurrent_reason_claim_learns_exactly_once(client):
    rejected = await fs.record_decision(
        client, user_id=USER, recommendation_id=REC, action="rejected"
    )
    stale_row = dict(rejected["row"])

    first, second = await asyncio.gather(
        fs.apply_reason(
            client, feedback_row=dict(stale_row), reason_code="too_far", reason_note=None
        ),
        fs.apply_reason(
            client, feedback_row=dict(stale_row), reason_code="too_far", reason_note=None
        ),
    )

    assert sum(result["should_learn_vector"] for result in (first, second)) == 1
    assert client.rows("user_feedback")[0]["learning_applied_at"] == NOW.isoformat()


@pytest.mark.parametrize(
    "code,scope",
    [("closed", "data_quality"), ("inaccurate", "data_quality"), ("already_visited", "none"), ("bad_timing", "session"), ("other", "none")],
)
@pytest.mark.asyncio
async def test_non_long_term_reasons_answer_without_learning(client, code, scope):
    rejected = await fs.record_decision(
        client, user_id=USER, recommendation_id=REC, action="rejected"
    )
    res = await fs.apply_reason(
        client, feedback_row=rejected["row"], reason_code=code, reason_note=None
    )

    assert res["learning_scope"] == scope
    assert res["should_learn_vector"] is False  # 취향 학습 금지
    assert res["reason_status"] == "answered"
    assert res["row"]["learning_applied_at"] is None


@pytest.mark.asyncio
async def test_apply_reason_rejects_unanswerable_row(client):
    """사유를 물은 적 없는 행(reason_status='none')에는 사유를 붙일 수 없다."""
    skipped = await fs.record_decision(client, user_id=USER, recommendation_id=REC, action="skipped")
    with pytest.raises(ValueError):
        await fs.apply_reason(
            client, feedback_row=skipped["row"], reason_code="too_far", reason_note=None
        )


@pytest.mark.asyncio
async def test_apply_reason_rejects_unknown_code_and_overlong_note(client):
    rejected = await fs.record_decision(
        client, user_id=USER, recommendation_id=REC, action="rejected"
    )
    with pytest.raises(ValueError):
        await fs.apply_reason(
            client, feedback_row=rejected["row"], reason_code="nope", reason_note=None
        )
    with pytest.raises(ValueError):
        await fs.apply_reason(
            client,
            feedback_row=rejected["row"],
            reason_code="too_far",
            reason_note="가" * (fs.REASON_NOTE_MAX_LEN + 1),
        )
    # 경계값(정확히 200자)은 통과한다.
    ok = await fs.apply_reason(
        client,
        feedback_row=rejected["row"],
        reason_code="too_far",
        reason_note="가" * fs.REASON_NOTE_MAX_LEN,
    )
    assert ok["reason_status"] == "answered"


# --- is_expired: 30일 경계 ---------------------------------------------------------


def test_is_expired_boundary_is_inclusive_of_exactly_30_days():
    created = NOW - timedelta(days=fs.PENDING_WINDOW_DAYS)
    row = {fs.CREATED_COLUMN: created.isoformat()}
    # 정확히 30일 → 아직 만료 아님(경계값 미포함).
    assert fs.is_expired(row, NOW) is False
    # 30일 + 1초 → 만료.
    assert fs.is_expired(row, NOW + timedelta(seconds=1)) is True
    # 30일 - 1초 → 만료 아님.
    assert fs.is_expired(row, NOW - timedelta(seconds=1)) is False


def test_is_expired_parses_z_suffix_and_datetime_objects():
    created = NOW - timedelta(days=40)
    assert fs.is_expired({fs.CREATED_COLUMN: created.isoformat().replace("+00:00", "Z")}, NOW) is True
    assert fs.is_expired({fs.CREATED_COLUMN: created}, NOW) is True


def test_is_expired_falls_back_to_not_expired_when_timestamp_unusable():
    assert fs.is_expired({}, NOW) is False
    assert fs.is_expired({fs.CREATED_COLUMN: None}, NOW) is False
    assert fs.is_expired({fs.CREATED_COLUMN: "not-a-timestamp"}, NOW) is False
