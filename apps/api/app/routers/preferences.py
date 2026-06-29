"""자연어 선호 입력 → 추천 알고리즘 반영 엔드포인트 (로컬 키워드 파싱).

POST /api/v1/preferences/parse
  body: { "text": "조용한 한옥카페랑 무장애 되는 관광지가 좋아요" }

흐름:
  1) preference_nlp_service(키워드 규칙)로 자연어를 구조화(선호 카테고리/속성/요약/8차원 벡터)
  2) 그 8차원 벡터를 Supabase 사용자 선호 벡터로 upsert
     → 이후 /recommendations 의 calculate_preference_similarity 가 즉시 이 벡터를 사용
  3) users.preferred_categories 갱신(콜드스타트/재계산 경로와도 정합)
  4) (선택) users.preference_note 에 원문+요약 저장(컬럼 없으면 조용히 건너뜀)

DB 쓰기는 전부 실패해도 추천 자체는 막지 않도록 best-effort(예외 격리)로 처리한다.
"""

import asyncio

import structlog
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

# 자기 자신의 users 행 갱신이지만 RLS 영향 없이 안정 동작하도록 service_role 클라이언트를 사용
from app.core.supabase import supabase_admin, get_current_user
from app.services.preference_vector_service import preference_vector_service
from app.services.preference_nlp_service import parse_preference

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/preferences", tags=["preferences"])


class ParsePreferenceRequest(BaseModel):
    text: str = Field(..., description="사용자가 자연어로 말한 선호(예: '조용한 한옥카페 선호')")


class ParsePreferenceResponse(BaseModel):
    preferred_categories: list[str]
    attributes: list[str]
    summary: str            # 사용자에게 보여줄 'AI가 이렇게 이해했어요' 문장
    is_fallback: bool       # 키워드 규칙 사용 여부(로컬 파싱은 항상 True)
    vector_updated: bool    # Supabase 선호 벡터 반영 성공 여부
    categories_saved: bool  # users.preferred_categories 저장 성공 여부


@router.post("/parse", response_model=ParsePreferenceResponse)
async def parse_and_apply_preference(
    req: ParsePreferenceRequest,
    current_user: dict = Depends(get_current_user),
):
    user_id = current_user["id"]
    parsed = await parse_preference(req.text)

    # 1) Supabase 선호 벡터 반영 (추천 점수에 즉시 사용됨)
    vector_updated = False
    try:
        await preference_vector_service.upsert_user_vector(user_id, parsed["vector"])
        # upsert_user_vector 는 저장소 미가용 시 조용히 no-op → 성공 여부를 available 로 판단
        vector_updated = preference_vector_service.available
    except Exception as e:
        logger.warning("preference_vector_upsert_failed", user_id=user_id, error=str(e))

    # 2) users.preferred_categories 갱신 (콜드스타트/재계산 경로와 정합)
    categories_saved = False
    if parsed["preferred_categories"]:
        try:
            await asyncio.to_thread(
                supabase_admin.table("users")
                .update({"preferred_categories": parsed["preferred_categories"]})
                .eq("id", user_id)
                .execute
            )
            categories_saved = True
        except Exception as e:
            logger.warning("preference_categories_save_failed", user_id=user_id, error=str(e))

    # 3) (선택) 원문+요약 저장 — preference_note 컬럼이 있으면 기록, 없으면 무시
    try:
        await asyncio.to_thread(
            supabase_admin.table("users")
            .update({"preference_note": {"text": req.text, "summary": parsed["summary"]}})
            .eq("id", user_id)
            .execute
        )
    except Exception:
        pass  # 컬럼 미존재 등은 비치명적

    logger.info(
        "preference_applied",
        user_id=user_id,
        categories=parsed["preferred_categories"],
        vector_updated=vector_updated,
    )
    return ParsePreferenceResponse(
        preferred_categories=parsed["preferred_categories"],
        attributes=parsed["attributes"],
        summary=parsed["summary"],
        is_fallback=parsed["is_fallback"],
        vector_updated=vector_updated,
        categories_saved=categories_saved,
    )
