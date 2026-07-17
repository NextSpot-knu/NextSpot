"""거절 실험실(Rejection Lab) 라우터 — "왜 거절했는지"를 나중에 되묻고, 답한 만큼만 학습한다.

배경: POST /api/v1/feedback 의 `rejected` 는 거절을 **즉시 학습하지 않는다**. reason_status='pending'
으로만 적재하고 세션 후보에서만 빼둔다. 이 라우터가 그 pending 을 사용자에게 되물어(사유 확정)
learning_scope 가 long_term 일 때만 취향 벡터를 -5% **정확히 1회** 움직인다.
(정본: docs/REJECTION_LAB_AUDIT.md — '왜 싫었는지'를 모른 채 깎던 오학습을 제거하는 것이 이 기능의 목적.)

신뢰 경계
--------
- 인증: get_current_user(Supabase JWT). **body/path 의 user_id 는 절대 신뢰하지 않는다** — current_user['id'] 만 쓴다.
- DB: service_role(supabase_admin). RLS 를 우회하므로 소유권은 이 라우터가 **명시적으로** 검사한다
  (행을 읽어 user_id 를 대조: 미존재 404 / 타인 403).
- 개인정보: reason_note(사용자 자유 서술)는 **서버 로그에 원문을 남기지 않는다**. 코드·길이만 남긴다.

멱등·학습 1회 보장은 services/feedback_service 가 소유한다(학습 슬롯 = learning_applied_at).
이 라우터는 그 서비스가 should_learn_vector=True 를 준 경우에만 벡터를 움직인다.
"""
import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.supabase import supabase_admin, get_current_user
from app.routers.recommendations import (
    VECTOR_ACTION_PENALIZE,
    apply_feedback_vector_learning,
    resolve_feedback_target,
)
from app.services import feedback_service as fs
from app.services import llm_client

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/lab", tags=["lab"])

_TABLE = "user_feedback"

#: 타임스탬프가 없는/깨진 행의 정렬 폴백(항상 맨 뒤로).
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

# pending 목록에 시설명을 붙이기 위한 조인 — 사용자는 "어디를 거절했는지" 없이는 사유를 답할 수 없다.
_PENDING_SELECT = (
    "*, recommendation:recommendations!recommendation_id("
    "id, recommended_facility_id, recommended_facility:facilities!recommended_facility_id(id, name, type)"
    ")"
)


class ReasonRequest(BaseModel):
    # DB CHECK / feedback_service.REASON_CODES 와 동일 집합(패리티 테스트로 강제).
    # 목록 밖의 값은 라우터 진입 전 422 로 거부된다.
    reason_code: Literal[
        "too_far",
        "too_crowded",
        "not_my_taste",
        "too_expensive",
        "closed",
        "already_visited",
        "bad_timing",
        "inaccurate",
        "other",
    ]
    # DB CHECK(char_length <= 200)와 동일. pydantic 이 먼저 422 로 거르고, feedback_service 가 2차 방어한다.
    reason_note: str | None = Field(None, max_length=fs.REASON_NOTE_MAX_LEN)


class ClassifyReasonRequest(BaseModel):
    # 자유 서술 원문 — 최대 200자(reason_note DB CHECK 와 동일 상한). 서버 로그에 원문을 남기지 않는다.
    text: str = Field(..., min_length=1, max_length=fs.REASON_NOTE_MAX_LEN)


# 자유 텍스트 → 기존 reason_code 분류용 프롬프트. 설명(description)은 사람 읽기용이고,
# **분류 결과의 정본 화이트리스트는 fs.REASON_CODES 다** — keys 는 그 집합과 1:1이어야 한다
# (test_classify_descriptions_match_whitelist 가 패리티를 강제). 목록 밖 category 는 환각으로 폴백.
_REASON_DESCRIPTIONS: dict[str, str] = {
    "too_far": "거리가 멀어서 가기 부담된다",
    "too_crowded": "사람이 많고 붐빌 것 같다",
    "not_my_taste": "분위기·취향이 내 스타일이 아니다",
    "too_expensive": "가격이 비싸서 부담된다",
    "closed": "영업을 하지 않거나 문을 닫았다",
    "already_visited": "이미 가본 곳이다",
    "bad_timing": "지금 시간대·상황에 맞지 않는다",
    "inaccurate": "추천 정보가 부정확하거나 사실과 다르다",
    "other": "위 어느 것에도 해당하지 않는 기타 사유",
}

_CLASSIFY_SYSTEM = (
    "너는 여행지 추천을 거절한 사용자의 짧은 이유 문장을 정해진 카테고리 하나로 분류하는 분류기다.\n"
    "아래 카테고리 중 사용자의 문장에 가장 잘 맞는 코드 하나를 고른다. "
    "어디에도 확실히 맞지 않으면 category 를 null 로 둔다(억지로 고르지 말 것).\n\n"
    "카테고리:\n"
    + "\n".join(f"- {code}: {desc}" for code, desc in _REASON_DESCRIPTIONS.items())
    + "\n\n"
    "반드시 JSON 객체 하나만 출력한다: "
    '{"category": <위 코드 중 하나 또는 null>, "note": <사용자 이유를 20자 이내로 요약한 한국어 문자열>}'
)


def _embedded(value):
    """PostgREST 임베딩은 dict/list 어느 형태로도 올 수 있다 — 단일 dict 로 정규화."""
    if isinstance(value, list):
        value = value[0] if value else None
    return value if isinstance(value, dict) else {}


def _serialize_pending(row: dict) -> dict:
    """pending 항목을 프런트 카드용으로 축약한다. reason_note 는 pending 단계에 존재하지 않으므로 뺀다."""
    rec = _embedded(row.get("recommendation"))
    facility = _embedded(rec.get("recommended_facility"))
    return {
        "id": row.get("id"),
        "recommendation_id": row.get("recommendation_id"),
        "action": row.get("action"),
        "reason_status": row.get("reason_status"),
        "created_at": row.get(fs.CREATED_COLUMN),
        "facility_id": facility.get("id") or rec.get("recommended_facility_id"),
        "facility_name": facility.get("name"),
        "facility_type": facility.get("type"),
    }


def _is_visible_pending(row: dict, now) -> bool:
    """목록 노출 조건 — DB 필터와 **동일한 의미**를 애플리케이션에서도 강제한다(이중 방어).

    30일 경계는 feedback_service.is_expired 가 단일 정본이다(정확히 30일 되는 순간은 아직 만료 아님).
    """
    return (
        row.get("reason_status") == fs.STATUS_PENDING
        and row.get("hidden_at") is None
        and not fs.is_expired(row, now)
    )


async def _fetch_pending_rows(user_id: str, *, select: str, limit: int | None) -> list[dict]:
    """본인 pending 행을 최신순으로 조회한다(미숨김·30일 이내).

    DB 쪽 필터/정렬(idx_user_feedback_lab_pending 이 커버)과 애플리케이션 쪽 재검증을 모두 건다.
    정렬·슬라이스를 애플리케이션에서 한 번 더 하는 이유는 이 목록의 계약(최신순 최대 10건, 30일 경계)이
    PostgREST 동작에 의존하지 않고 결정적이어야 하기 때문이다.
    """
    now = fs._utcnow()
    cutoff = now - timedelta(days=fs.PENDING_WINDOW_DAYS)
    query = (
        supabase_admin.table(_TABLE)
        .select(select)
        .eq("user_id", user_id)
        .eq("reason_status", fs.STATUS_PENDING)
        .is_("hidden_at", "null")
        .gte(fs.CREATED_COLUMN, cutoff.isoformat())
        .order(fs.CREATED_COLUMN, desc=True)
    )
    try:
        res = await asyncio.to_thread(query.execute)
    except Exception as e:
        logger.error("lab_pending_fetch_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="실험실 목록 조회에 실패했습니다.")

    rows = [r for r in (res.data or []) if _is_visible_pending(r, now)]
    # 최신순 — 타임스탬프가 없거나 비정형인 행은 맨 뒤로 밀어 정렬 자체가 깨지지 않게 한다.
    rows.sort(key=lambda r: fs._parse_ts(r.get(fs.CREATED_COLUMN)) or _EPOCH, reverse=True)
    return rows if limit is None else rows[:limit]


async def _fetch_own_feedback(feedback_id: str, user_id: str) -> dict:
    """본인 소유의 피드백 행을 읽는다.

    Raises:
        HTTPException: 404(비-UUID·미존재) / 403(타인 소유) / 500(조회 실패).
    """
    try:
        uuid.UUID(str(feedback_id))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=404, detail="해당 피드백 기록을 찾을 수 없습니다.")

    try:
        res = await asyncio.to_thread(
            supabase_admin.table(_TABLE).select("*").eq("id", feedback_id).limit(1).execute
        )
    except Exception as e:
        logger.error("lab_feedback_fetch_failed", feedback_id=feedback_id, error=str(e))
        raise HTTPException(status_code=500, detail="피드백 기록 조회에 실패했습니다.")

    if not res.data:
        raise HTTPException(status_code=404, detail="해당 피드백 기록을 찾을 수 없습니다.")
    row = res.data[0]
    # 소유권 가드: service_role 은 RLS 를 우회하므로 여기서 막지 않으면 타인의 거절 사유를
    # 읽고/바꾸고(=그 사람의 취향 벡터를 조작하고) 만다.
    if row.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="해당 피드백 기록에 대한 권한이 없습니다.")
    return row


async def _patch_own_feedback(feedback_id: str, user_id: str, patch: dict) -> dict:
    """본인 행에 부분 갱신을 적용한다(user_id 조건으로 이중 방어)."""
    try:
        res = await asyncio.to_thread(
            supabase_admin.table(_TABLE)
            .update(patch)
            .eq("id", feedback_id)
            .eq("user_id", user_id)
            .execute
        )
    except Exception as e:
        logger.error("lab_feedback_update_failed", feedback_id=feedback_id, error=str(e))
        raise HTTPException(status_code=500, detail="피드백 기록 갱신에 실패했습니다.")
    data = res.data or []
    return data[0] if data else {}


async def _classify_free_text(text: str) -> tuple[str | None, str | None]:
    """자유 텍스트를 기존 reason_code 하나로 분류한다(LLM). (reason_code, note) 반환.

    분류 실패는 전부 (None, None) — 호출자는 무해 폴백한다:
      - LLM None(비활성/타임아웃/오류) 또는 비-dict 출력
      - category 가 문자열이 아니거나 **화이트리스트(fs.REASON_CODES) 밖**(환각 방어)
      - category 가 null(모델이 확신하지 못함)
    note 는 20자 요약(있으면) — 200자 상한으로 방어적 절단, 없거나 공백이면 None.
    """
    parsed = await llm_client.chat_json(_CLASSIFY_SYSTEM, text, max_tokens=120)
    if not isinstance(parsed, dict):
        return None, None
    category = parsed.get("category")
    if not isinstance(category, str) or category not in fs.REASON_CODES:
        return None, None
    note = parsed.get("note")
    if isinstance(note, str) and note.strip():
        note = note.strip()[: fs.REASON_NOTE_MAX_LEN]
    else:
        note = None
    return category, note


@router.get("/pending")
async def list_pending(current_user: dict = Depends(get_current_user)):
    """사유 미응답(pending) 거절 목록 — 본인·미숨김·30일 이내, 최신순 최대 10건."""
    user_id = current_user["id"]
    rows = await _fetch_pending_rows(user_id, select=_PENDING_SELECT, limit=fs.PENDING_PAGE_LIMIT)
    return [_serialize_pending(r) for r in rows]


@router.get("/pending/count")
async def count_pending(current_user: dict = Depends(get_current_user)):
    """pending 개수 — 목록의 10건 상한과 달리 실제 전체 개수를 센다(배지 표시용)."""
    user_id = current_user["id"]
    rows = await _fetch_pending_rows(
        user_id, select=f"id, {fs.CREATED_COLUMN}, reason_status, hidden_at", limit=None
    )
    return {"count": len(rows)}


@router.post("/{feedback_id}/reason")
async def answer_reason(
    feedback_id: str,
    req: ReasonRequest,
    current_user: dict = Depends(get_current_user),
):
    """거절 사유를 확정한다 — answered 로 전환하고, long_term 사유일 때만 벡터를 -5% 정확히 1회.

    학습 스코프는 reason_code 가 결정한다(feedback_service.REASON_LEARNING_SCOPE):
      - too_far/too_crowded/not_my_taste/too_expensive → long_term(감점)
      - closed/inaccurate → data_quality(취향 학습 금지 — 가게 사정이지 취향이 아니다)
      - already_visited/other → none, bad_timing → session
    재호출해도 학습 슬롯(learning_applied_at)이 이미 차 있어 재학습하지 않는다(멱등).
    """
    user_id = current_user["id"]
    row = await _fetch_own_feedback(feedback_id, user_id)

    # 30일이 지난 pending 은 기억이 흐려져 답이 신뢰할 수 없다 — 학습 대상에서 제외한다.
    if fs.is_expired(row, fs._utcnow()):
        raise HTTPException(status_code=409, detail="응답 기간(30일)이 지난 피드백입니다.")

    try:
        result = await fs.apply_reason(
            supabase_admin, feedback_row=row, reason_code=req.reason_code, reason_note=req.reason_note
        )
    except ValueError as e:
        # 사유를 물은 적 없는 행(reason_status='none') 등 상태 충돌. 원문 note 는 담기지 않는다.
        raise HTTPException(status_code=409, detail=str(e))

    updated_vector = False
    if result["should_learn_vector"]:
        # 학습 슬롯은 이미 선점됐다 — 여기서 실제로 벡터를 움직인다(행당 생애 1회).
        # 시설 카테고리 벡터가 필요해 추천 이력을 다시 읽는다(소유권도 함께 재확인).
        _rec, facility = await resolve_feedback_target(row["recommendation_id"], current_user)
        updated_vector = await apply_feedback_vector_learning(
            user_id=user_id, facility=facility, vector_action=VECTOR_ACTION_PENALIZE
        )

    # 로그에는 reason_code/길이만 — reason_note 원문은 절대 남기지 않는다(개인정보).
    logger.info(
        "lab_reason_answered",
        feedback_id=feedback_id,
        user_id=user_id,
        reason_code=req.reason_code,
        learning_scope=result["learning_scope"],
        note_length=len(req.reason_note) if req.reason_note else 0,
        updated_vector=updated_vector,
    )
    return {
        "success": True,
        "id": result["id"],
        "reason_status": result["reason_status"],
        "reason_code": result["reason_code"],
        "learning_scope": result["learning_scope"],
        "updated_vector": updated_vector,
    }


@router.post("/{feedback_id}/reason/classify")
async def classify_reason(
    feedback_id: str,
    req: ClassifyReasonRequest,
    current_user: dict = Depends(get_current_user),
):
    """자유 텍스트 거절 사유를 LLM 으로 기존 카테고리에 매핑하고, 성공하면 **기존 사유 적용 경로를 그대로** 탄다.

    설계(학습 경로 재사용): 분류가 화이트리스트를 통과하면 answer_reason 과 **동일하게** fs.apply_reason
    (학습 슬롯 = learning_applied_at) → should_learn_vector 일 때만 라우터가 벡터 -5%. 즉 자유 텍스트도
    선택지 버튼과 **완전히 같은 '정확히 1회' 계약**을 공유한다. 새 학습 경로를 만들지 않는다.

    무해 폴백(422 아님, 200 + {"resolved": false}):
      - LLM 비활성/실패, 또는 분류 결과가 null·화이트리스트 밖(환각) → resolved=false.
        프런트가 "선택지에서 골라주세요"로 유도하고 기존 이유 칩을 그대로 유지한다.
    개인정보: 자유 텍스트 원문·LLM 요약 원문은 서버 로그에 남기지 않는다(길이·코드만).
    """
    user_id = current_user["id"]
    row = await _fetch_own_feedback(feedback_id, user_id)

    # answer_reason 과 동일 — 30일 지난 pending 은 학습 대상에서 제외.
    if fs.is_expired(row, fs._utcnow()):
        raise HTTPException(status_code=409, detail="응답 기간(30일)이 지난 피드백입니다.")

    text = req.text.strip()
    # LLM 이 없으면 네트워크 없이 즉시 폴백 — 데모에서 죽은 UI 대신 프런트 안내로 이어진다.
    if not text or not llm_client.is_enabled():
        logger.info(
            "lab_reason_classify_skipped",
            feedback_id=feedback_id,
            user_id=user_id,
            llm_enabled=llm_client.is_enabled(),
        )
        return {"resolved": False}

    reason_code, note = await _classify_free_text(text)
    if reason_code is None:
        # 분류 실패(화이트리스트 밖/null/LLM 오류) — 무해 폴백. 원문은 로그에 없다(길이만).
        logger.info(
            "lab_reason_classify_unresolved",
            feedback_id=feedback_id,
            user_id=user_id,
            text_length=len(text),
        )
        return {"resolved": False}

    # --- 여기부터 answer_reason 과 동일한 기존 적용 경로(재사용) ---
    try:
        result = await fs.apply_reason(
            supabase_admin, feedback_row=row, reason_code=reason_code, reason_note=note
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))

    updated_vector = False
    if result["should_learn_vector"]:
        _rec, facility = await resolve_feedback_target(row["recommendation_id"], current_user)
        updated_vector = await apply_feedback_vector_learning(
            user_id=user_id, facility=facility, vector_action=VECTOR_ACTION_PENALIZE
        )

    # 로그: reason_code/길이만 — 자유 텍스트·요약 원문은 절대 남기지 않는다(개인정보).
    logger.info(
        "lab_reason_classified",
        feedback_id=feedback_id,
        user_id=user_id,
        reason_code=reason_code,
        learning_scope=result["learning_scope"],
        text_length=len(text),
        updated_vector=updated_vector,
    )
    return {
        "resolved": True,
        "id": result["id"],
        "reason_status": result["reason_status"],
        "reason_code": result["reason_code"],
        "learning_scope": result["learning_scope"],
        "updated_vector": updated_vector,
    }


@router.post("/{feedback_id}/skip")
async def skip_reason(feedback_id: str, current_user: dict = Depends(get_current_user)):
    """사유 응답을 건너뛴다 — 목록에서 내려가되 나중에 답할 수 있게 행은 남긴다. 학습 없음."""
    user_id = current_user["id"]
    await _fetch_own_feedback(feedback_id, user_id)
    row = await _patch_own_feedback(feedback_id, user_id, {"reason_status": fs.STATUS_SKIPPED})
    logger.info("lab_reason_skipped", feedback_id=feedback_id, user_id=user_id)
    return {"success": True, "id": feedback_id, "reason_status": row.get("reason_status", fs.STATUS_SKIPPED)}


@router.post("/{feedback_id}/hide")
async def hide_pending(feedback_id: str, current_user: dict = Depends(get_current_user)):
    """실험실 목록에서 영구히 숨긴다(reason_status 는 보존 — 왜 숨겼는지 분석 가능하게)."""
    user_id = current_user["id"]
    await _fetch_own_feedback(feedback_id, user_id)
    hidden_at = fs._utcnow().isoformat()
    row = await _patch_own_feedback(feedback_id, user_id, {"hidden_at": hidden_at})
    logger.info("lab_pending_hidden", feedback_id=feedback_id, user_id=user_id)
    return {"success": True, "id": feedback_id, "hidden_at": row.get("hidden_at", hidden_at)}
