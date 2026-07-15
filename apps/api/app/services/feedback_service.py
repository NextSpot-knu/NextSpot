"""피드백 의미 모델 + 멱등 학습 로직 — 순수 서비스 계층(Rejection Lab).

이 모듈은 라우터를 임포트하지 않는다. 라우터(app/routers/*)가 이 모듈을 임포트해서 쓴다.
supabase 클라이언트는 **인자로 주입**받는다 — 호출자(라우터)의 service_role 클라이언트를 그대로 넘겨,
테스트가 라우터의 패치 지점을 그대로 재사용하고 이 모듈은 실DB 의존 없이 검증된다.

핵심 불변식(설계 결정)
---------------------
1. **한 추천(recommendation_id)당 결정 행은 최대 1개.** DB 의 부분 UNIQUE 인덱스
   (recommendation_id WHERE action IN DECISION_ACTIONS)와 동일한 의미를 서비스에서도 강제한다.
2. **한 추천당 선호 벡터 학습은 최대 1회.** `learning_applied_at` 이 그 '학습 슬롯'이다.
   NULL 이면 미학습, 값이 있으면 이미 학습됨 → 무슨 경로로 다시 들어와도 재학습하지 않는다.
   (거절→사유확정으로 -5% 를 받은 추천이 나중에 수락으로 바뀌어도 +10% 를 추가로 주지 않는다.
    '중복 학습 금지' 를 '보정 기회 최대화' 보다 우선한 MVP 선택.)

벡터 호출 주체 (task 요구: 선택한 쪽을 명시)
-------------------------------------------
**실제 preference_vector_service 호출은 라우터가 한다. 이 서비스는 호출하지 않는다.**
이유: 벡터 학습에는 facility 의 카테고리 벡터(CATEGORY_VECTORS)가 필요한데 그 조회는 라우터의
recommendations 조인 결과에 있다. 대신 '한 번만' 보장은 여기서 책임진다 —
record_decision/apply_reason 이 DB 에 `learning_applied_at` 을 먼저 찍어 **학습 슬롯을 선점**한 뒤에만
`should_learn_vector=True` 를 돌려준다. 즉 라우터는 이 플래그가 True 일 때만 벡터를 움직이면 되고,
같은 행에 대해 True 는 생애 최대 1회만 반환된다(at-most-once). 선점 후 벡터 호출이 실패하면 그 학습은
유실되는데, 이는 '재시도로 인한 이중 학습' 보다 나은 트레이드오프라 의도적으로 택했다.

멱등 쓰기 방식 (upsert 를 쓰지 않는 이유)
----------------------------------------
DB 의 UNIQUE 는 **부분(partial) 인덱스**다. Postgres 의 ON CONFLICT 는 부분 인덱스를 추론하려면
`ON CONFLICT (col) WHERE <predicate>` 처럼 인덱스 술어를 함께 줘야 하는데, PostgREST/supabase-py 의
`on_conflict=` 파라미터는 컬럼만 받고 술어를 실을 수 없다 → 부분 인덱스에는 매칭이 안 된다.
그래서 select → insert(경합 시 23505 흡수 후 재조회 → update) 로 같은 멱등성을 만든다.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import structlog

logger = structlog.get_logger()

_TABLE = "user_feedback"

# 피드백 행 생성 시각 컬럼(기존 스키마 이름 그대로 — created_at 이 아니다).
CREATED_COLUMN = "timestamp"

# --- 액션 어휘 -------------------------------------------------------------------

ACTION_ACCEPTED_VISIT_INTENT = "accepted_visit_intent"
ACTION_REJECTED = "rejected"
ACTION_SKIPPED = "skipped"
ACTION_DISMISSED_BATCH = "dismissed_batch"
ACTION_UNSAVED = "unsaved"
ACTION_HELPFUL = "helpful"
ACTION_NOT_HELPFUL = "not_helpful"

# legacy: 기존 행 보존용으로 DB CHECK 에는 남지만 **API 입력에서는 제외**한다.
LEGACY_ACTIONS: frozenset[str] = frozenset({"accepted", "rejected", "ignored"})

#: 결정 액션 — 추천 1건당 하나만 존재해야 하는(=멱등 upsert 대상) 액션.
#: 부분 UNIQUE 인덱스의 술어와 정확히 같은 집합이어야 한다.
DECISION_ACTIONS: frozenset[str] = frozenset(
    {
        ACTION_ACCEPTED_VISIT_INTENT,
        ACTION_REJECTED,
        ACTION_SKIPPED,
        ACTION_DISMISSED_BATCH,
        ACTION_UNSAVED,
        "accepted",  # legacy
        "ignored",  # legacy
    }
)

#: 품질 신호 — 벡터 학습 없음. 결정 행과 공존하므로 UNIQUE 대상이 아니다.
QUALITY_ACTIONS: frozenset[str] = frozenset({ACTION_HELPFUL, ACTION_NOT_HELPFUL})

#: 즉시(=행 기록 시점에) 장기 벡터 학습을 유발하는 액션. 그 외는 학습하지 않는다.
#: rejected 는 여기 없다 — 사유 확정(apply_reason) 전까지 장기 학습을 **보류**한다.
LEARNING_ACTIONS: frozenset[str] = frozenset({ACTION_ACCEPTED_VISIT_INTENT, "accepted"})

#: API 가 받아들이는 액션 전체(legacy 제외). 라우터의 Literal 과 일치해야 한다.
API_ACTIONS: frozenset[str] = frozenset(
    {
        ACTION_ACCEPTED_VISIT_INTENT,
        ACTION_REJECTED,
        ACTION_SKIPPED,
        ACTION_DISMISSED_BATCH,
        ACTION_UNSAVED,
        ACTION_HELPFUL,
        ACTION_NOT_HELPFUL,
    }
)

# --- reason_code / learning_scope ------------------------------------------------

SCOPE_NONE = "none"
SCOPE_SESSION = "session"
SCOPE_LONG_TERM = "long_term"
SCOPE_DATA_QUALITY = "data_quality"

STATUS_NONE = "none"
STATUS_PENDING = "pending"
STATUS_ANSWERED = "answered"
STATUS_SKIPPED = "skipped"
STATUS_EXPIRED = "expired"

#: reason_code → learning_scope (정본: docs/REJECTION_LAB_AUDIT.md 계약)
#: - too_far/too_crowded/not_my_taste/too_expensive → 취향 신호 → long_term(벡터 -5% 정확히 1회)
#: - closed/inaccurate → 데이터 품질 문제지 취향이 아니다 → 취향 학습 금지
#: - already_visited → 재추천 억제만
#: - bad_timing → 이번 세션 한정
REASON_LEARNING_SCOPE: dict[str, str] = {
    "too_far": SCOPE_LONG_TERM,
    "too_crowded": SCOPE_LONG_TERM,
    "not_my_taste": SCOPE_LONG_TERM,
    "too_expensive": SCOPE_LONG_TERM,
    "closed": SCOPE_DATA_QUALITY,
    "inaccurate": SCOPE_DATA_QUALITY,
    "already_visited": SCOPE_NONE,
    "bad_timing": SCOPE_SESSION,
    "other": SCOPE_NONE,
}

#: DB CHECK 와 동일한 reason_code 화이트리스트.
REASON_CODES: frozenset[str] = frozenset(REASON_LEARNING_SCOPE)

#: reason_note 최대 길이(DB CHECK 와 동일).
REASON_NOTE_MAX_LEN = 200

#: 사유를 확정할 수 있는 reason_status. 'none'(사유를 물은 적 없는 행)은 대상이 아니다.
REASON_ANSWERABLE_STATUSES: frozenset[str] = frozenset({STATUS_PENDING, STATUS_ANSWERED, STATUS_SKIPPED})

#: Lab pending 노출 기준.
PENDING_WINDOW_DAYS = 30
PENDING_PAGE_LIMIT = 10

#: 학습을 적용할 때 기록하는 스키마 버전(learning_version). 학습 규칙이 바뀌면 올린다.
LEARNING_VERSION = 1


def _utcnow() -> datetime:
    """현재 UTC 시각. 테스트는 이 함수를 monkeypatch 해서 시간을 고정한다."""
    return datetime.now(timezone.utc)


def resolve_learning_scope(reason_code: str) -> str:
    """reason_code 를 learning_scope 로 변환한다.

    Raises:
        ValueError: 화이트리스트 밖의 reason_code. 라우터가 Literal 로 먼저 걸러야 하며,
            여기까지 온 미지 코드는 조용히 'none' 으로 뭉개지 않고 크게 실패시킨다
            (잘못된 코드가 학습 금지로 위장되는 것이 더 위험하다).
    """
    try:
        return REASON_LEARNING_SCOPE[reason_code]
    except KeyError:
        raise ValueError(f"알 수 없는 reason_code: {reason_code!r}") from None


def _parse_ts(value) -> datetime | None:
    """DB 의 timestamptz 값을 tz-aware datetime 으로. 파싱 불가면 None."""
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    # naive 값(타임존 없는 문자열)은 UTC 로 해석한다 — DB 는 timestamptz 라 정상 경로에선 나오지 않는다.
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def is_expired(row: dict, now) -> bool:
    """피드백 행이 30일 만료 창을 벗어났는지.

    경계 정의: 생성 시각(`timestamp`) + 30일을 **정확히** 맞춘 순간은 아직 **만료가 아니다**.
    즉 `now - timestamp > 30일` 일 때만 True(경계값 미포함, '30일 이내'에 30일 정각을 포함).
    Lab pending 목록의 '30일 이내' 조건과 정확히 상보 관계다.

    타임스탬프가 없거나 파싱 불가면 False(만료 아님)로 폴백한다 — 판단 근거가 없을 때
    사용자의 pending 질문을 임의로 지워버리는 쪽보다 남겨두는 쪽이 안전하다.
    """
    created = _parse_ts(row.get(CREATED_COLUMN))
    if created is None:
        return False
    now_dt = _parse_ts(now)
    if now_dt is None:
        return False
    return (now_dt - created) > timedelta(days=PENDING_WINDOW_DAYS)


def _is_unique_violation(exc: Exception) -> bool:
    """부분 UNIQUE 인덱스 충돌(23505) 여부 — 동시 요청 경합 감지용."""
    code = getattr(exc, "code", None)
    if code in ("23505", 23505):
        return True
    text = str(exc)
    return "23505" in text or "duplicate key value" in text


async def _fetch_decision_row(client, recommendation_id: str) -> dict | None:
    """해당 추천의 결정 행(있다면 유일)을 조회한다."""
    res = await asyncio.to_thread(
        client.table(_TABLE)
        .select("*")
        .eq("recommendation_id", recommendation_id)
        .in_("action", sorted(DECISION_ACTIONS))
        .limit(1)
        .execute
    )
    data = getattr(res, "data", None) or []
    return data[0] if data else None


def _initial_state_for(action: str) -> tuple[str, str]:
    """새 결정 행의 (reason_status, learning_scope) 초기값.

    - rejected: 사유를 물어야 하므로 pending. 장기 학습은 **보류**라 scope 는 none 으로 시작하고
      apply_reason 이 사유에 따라 다시 계산한다.
    - accepted_visit_intent(및 legacy accepted): 즉시 장기 학습 → long_term.
    - 그 외(skipped/dismissed_batch/unsaved/ignored): 학습 없음.
    """
    if action == ACTION_REJECTED:
        return STATUS_PENDING, SCOPE_NONE
    if action in LEARNING_ACTIONS:
        return STATUS_NONE, SCOPE_LONG_TERM
    return STATUS_NONE, SCOPE_NONE


def _result(row: dict, *, created: bool, action_changed: bool, should_learn: bool) -> dict:
    return {
        "id": row.get("id"),
        "action": row.get("action"),
        "reason_status": row.get("reason_status"),
        "learning_scope": row.get("learning_scope"),
        "created": created,
        "action_changed": action_changed,
        # 라우터는 이 플래그가 True 일 때만 preference_vector_service 를 호출한다(행당 최대 1회).
        "should_learn_vector": should_learn,
        "row": row,
    }


async def record_decision(client, *, user_id: str, recommendation_id: str, action: str) -> dict:
    """결정 액션을 멱등하게 기록한다(추천 1건당 결정 행 1개).

    같은 (recommendation_id, action) 이 다시 들어오면 **행을 만들지도 학습하지도 않고** 기존 행을 그대로
    반환한다(created=False, should_learn_vector=False). 액션이 바뀌면(예: skipped → accepted_visit_intent)
    기존 행을 갱신하고, 사유 컨텍스트(reason_code/note/status)는 새 액션 기준으로 리셋한다.

    소유권 검사는 **라우터 책임**이다(current_user['id'] 로 recommendation 소유 확인). 여기서는 body 의
    user_id 를 그대로 신뢰하지 않도록, 이미 존재하는 행의 user_id 는 절대 덮어쓰지 않는다.

    Args:
        client: service_role Supabase 클라이언트(호출자 주입 — 테스트 패치 지점 일원화).
        user_id: 소유자. 라우터가 검증한 current_user['id'] 여야 한다.
        recommendation_id: recommendations 테이블의 실제 UUID.
            (`bytype-…` 합성 ID 는 DB 행이 없으므로 라우터가 진입 전에 404 로 거른다.)
        action: DECISION_ACTIONS 중 하나.

    Returns:
        {'id', 'action', 'reason_status', 'learning_scope', 'created', 'action_changed',
         'should_learn_vector', 'row'}

    Raises:
        ValueError: 결정 액션이 아닌 값(품질 신호는 record_quality_signal 을 쓴다).
    """
    if action not in DECISION_ACTIONS:
        raise ValueError(f"결정 액션이 아닙니다: {action!r}")

    existing = await _fetch_decision_row(client, recommendation_id)
    if existing is None:
        reason_status, learning_scope = _initial_state_for(action)
        # 학습 슬롯 선점: 학습 대상 액션이면 행 생성과 동시에 learning_applied_at 을 찍는다.
        should_learn = action in LEARNING_ACTIONS
        now = _utcnow()
        payload = {
            "user_id": user_id,
            "recommendation_id": recommendation_id,
            "action": action,
            "reason_status": reason_status,
            "learning_scope": learning_scope,
        }
        if should_learn:
            payload["learning_applied_at"] = now.isoformat()
            payload["learning_version"] = LEARNING_VERSION
        try:
            res = await asyncio.to_thread(client.table(_TABLE).insert(payload).execute)
        except Exception as e:
            if not _is_unique_violation(e):
                raise
            # 경합: 같은 추천에 대한 결정 행이 방금 다른 요청으로 만들어졌다.
            # 승자의 행을 다시 읽어 아래 갱신 경로로 합류한다(이중 학습 방지).
            logger.info(
                "feedback_decision_race", recommendation_id=recommendation_id, action=action
            )
            existing = await _fetch_decision_row(client, recommendation_id)
            if existing is None:
                raise
        else:
            data = getattr(res, "data", None) or []
            row = data[0] if data else {**payload, "id": None}
            logger.info(
                "feedback_decision_created",
                recommendation_id=recommendation_id,
                action=action,
                learned=should_learn,
            )
            return _result(row, created=True, action_changed=True, should_learn=should_learn)

    # --- 기존 행이 있다 ---
    if existing.get("action") == action:
        # 완전 멱등: 재학습도, 사유 상태 리셋도 없다.
        return _result(existing, created=False, action_changed=False, should_learn=False)

    reason_status, learning_scope = _initial_state_for(action)
    # 학습 슬롯이 비어 있을 때만 학습한다 — 이미 학습된(거절 사유로 -5% 를 받은 등) 추천은
    # 액션이 바뀌어도 추가 학습하지 않는다(불변식 2).
    should_learn = action in LEARNING_ACTIONS and existing.get("learning_applied_at") is None

    now = _utcnow()
    patch: dict = {
        "action": action,
        "reason_status": reason_status,
        "learning_scope": learning_scope,
        # 이전 액션에 달려 있던 사유는 새 액션에서 의미가 없다.
        "reason_code": None,
        "reason_note": None,
        "reason_answered_at": None,
    }
    if should_learn:
        patch["learning_applied_at"] = now.isoformat()
        patch["learning_version"] = LEARNING_VERSION

    res = await asyncio.to_thread(
        client.table(_TABLE).update(patch).eq("id", existing["id"]).execute
    )
    data = getattr(res, "data", None) or []
    row = data[0] if data else {**existing, **patch}
    logger.info(
        "feedback_decision_updated",
        recommendation_id=recommendation_id,
        action=action,
        learned=should_learn,
    )
    return _result(row, created=False, action_changed=True, should_learn=should_learn)


async def record_quality_signal(client, *, user_id: str, recommendation_id: str, action: str) -> dict:
    """만족도 신호(helpful/not_helpful)를 기록한다. **벡터 학습 없음**(품질 신호 전용).

    결정 행과 별개의 행이며 부분 UNIQUE 인덱스 대상이 아니므로 단순 insert 다.
    소유권 검사는 라우터 책임.

    Raises:
        ValueError: QUALITY_ACTIONS 밖의 값.
    """
    if action not in QUALITY_ACTIONS:
        raise ValueError(f"품질 신호 액션이 아닙니다: {action!r}")

    payload = {
        "user_id": user_id,
        "recommendation_id": recommendation_id,
        "action": action,
        "reason_status": STATUS_NONE,
        "learning_scope": SCOPE_NONE,
    }
    res = await asyncio.to_thread(client.table(_TABLE).insert(payload).execute)
    data = getattr(res, "data", None) or []
    row = data[0] if data else {**payload, "id": None}
    return {
        "id": row.get("id"),
        "action": row.get("action"),
        "reason_status": row.get("reason_status"),
        "created": True,
        "should_learn_vector": False,
        "row": row,
    }


async def apply_reason(client, *, feedback_row: dict, reason_code: str, reason_note: str | None) -> dict:
    """거절 사유를 확정한다 — reason_status='answered' + 학습 슬롯 1회 선점.

    소유권/만료 판정은 **라우터 책임**이다(라우터가 본인 행을 읽어 is_expired 로 거른 뒤 넘긴다).

    학습은 `learning_scope == 'long_term'` 이고 `learning_applied_at` 이 비어 있을 때만 True 로 알린다.
    같은 행에 대해 apply_reason 을 몇 번 부르든 두 번째부터는 learning_applied_at 이 채워져 있으므로
    should_learn_vector=False 다(정확히 1회). 실제 벡터 -5% 호출은 라우터가 한다(모듈 docstring 참조).

    Args:
        client: service_role Supabase 클라이언트.
        feedback_row: 라우터가 소유권 확인 후 읽어온 user_feedback 행(최소 id/reason_status/learning_applied_at).
        reason_code: REASON_CODES 중 하나.
        reason_note: 자유 서술(<=200자) 또는 None. 공백만 있으면 None 으로 정규화한다.

    Returns:
        {'id', 'reason_status', 'reason_code', 'learning_scope', 'should_learn_vector', 'row'}

    Raises:
        ValueError: 미지 reason_code / 200자 초과 note / 사유를 물은 적 없는 행(reason_status='none').
    """
    scope = resolve_learning_scope(reason_code)

    status = feedback_row.get("reason_status")
    if status not in REASON_ANSWERABLE_STATUSES:
        raise ValueError(f"사유를 확정할 수 없는 상태입니다: reason_status={status!r}")

    note = reason_note.strip() if isinstance(reason_note, str) else reason_note
    if not note:
        note = None
    if note is not None and len(note) > REASON_NOTE_MAX_LEN:
        raise ValueError(f"reason_note 는 {REASON_NOTE_MAX_LEN}자를 넘을 수 없습니다.")

    already_learned = feedback_row.get("learning_applied_at") is not None
    should_learn = scope == SCOPE_LONG_TERM and not already_learned

    now = _utcnow()
    patch: dict = {
        "reason_code": reason_code,
        "reason_note": note,
        "reason_status": STATUS_ANSWERED,
        "reason_answered_at": now.isoformat(),
        "learning_scope": scope,
    }
    if should_learn:
        # 벡터를 실제로 움직이기 **전에** 슬롯을 선점한다(at-most-once — 모듈 docstring 참조).
        patch["learning_applied_at"] = now.isoformat()
        patch["learning_version"] = LEARNING_VERSION

    res = await asyncio.to_thread(
        client.table(_TABLE).update(patch).eq("id", feedback_row["id"]).execute
    )
    data = getattr(res, "data", None) or []
    row = data[0] if data else {**feedback_row, **patch}
    logger.info(
        "feedback_reason_answered",
        feedback_id=feedback_row.get("id"),
        reason_code=reason_code,
        learning_scope=scope,
        learned=should_learn,
    )
    return {
        "id": row.get("id"),
        "reason_status": row.get("reason_status"),
        "reason_code": row.get("reason_code"),
        "learning_scope": row.get("learning_scope"),
        "should_learn_vector": should_learn,
        "row": row,
    }
