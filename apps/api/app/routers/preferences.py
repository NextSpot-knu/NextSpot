"""자연어 선호 입력 → 추천 알고리즘 반영 엔드포인트 (키워드 파싱 + Solar LLM 백스톱).

POST /api/v1/preferences/parse
  body: { "text": "조용한 한옥카페랑 무장애 되는 관광지가 좋아요" }

흐름:
  1) preference_nlp_service(키워드 규칙 주 경로, 전량 미스 시 LLM 백스톱)로 자연어를
     구조화(선호 카테고리/속성/요약/8차원 벡터)
  2) 그 8차원 벡터를 Supabase 사용자 선호 벡터로 upsert
     → 이후 /recommendations 의 calculate_preference_similarity 가 즉시 이 벡터를 사용
  3) users.preferred_categories 갱신(콜드스타트/재계산 경로와도 정합)
  4) (선택) users.preference_note 에 원문+요약 저장(컬럼 없으면 조용히 건너뜀)

DB 쓰기는 전부 실패해도 추천 자체는 막지 않도록 best-effort(예외 격리)로 처리한다.

⚠️ 선호를 하나도 인식하지 못한 턴은 **아무것도 쓰지 않는다**(applied=False).
빈 파싱 결과로도 벡터를 저장하면 build_preference_vector([], []) 가 '전 카테고리 평균'이라
사용자가 그동안 피드백으로 쌓은 학습이 말 한마디에 기본값으로 초기화된다. 실패를 '없음과 같은
값'으로 표현하지 않는다는 저장소 원칙에 따라, 못 알아들었으면 저장 없이 그 사실을 응답에 싣는다.
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


# applied=False 사유 코드. 표시 문구는 프런트가 t() 로 조립한다(백엔드 summary 는 ko 폴백 전용).
REASON_NO_PREFERENCE = "no_preference_detected"  # 키워드·LLM 어느 쪽도 선호를 못 뽑음 → 저장 0건
REASON_STORAGE_UNAVAILABLE = "storage_unavailable"  # 선호는 인식했으나 저장이 전부 실패


class ParsePreferenceResponse(BaseModel):
    preferred_categories: list[str]
    attributes: list[str]
    summary: str            # 'AI가 이렇게 이해했어요' 한국어 폴백 문장(로케일 표시는 프런트가 코드로 조립)
    is_fallback: bool       # True=키워드/폴백 경로, False=LLM 백스톱이 실제 기여(프런트 토스트 분기)
    vector_updated: bool    # Supabase 선호 벡터 반영 성공 여부
    categories_saved: bool  # users.preferred_categories 저장 성공 여부
    llm_status: str         # 개발 디버그용(음성 경로와 동일 명명): keyword|llm|llm_failed|disabled
    # 아래 두 필드는 기존 봉투에 **추가만** 한 것이라 구버전 프런트는 무시해도 무해하다.
    applied: bool = True    # 선호가 실제로 저장됐는지. False 면 사용자 데이터는 한 글자도 안 바뀌었다.
    reason: str | None = None  # applied=False 사유 코드(REASON_* 상수)


@router.post("/parse", response_model=ParsePreferenceResponse)
async def parse_and_apply_preference(
    req: ParsePreferenceRequest,
    current_user: dict = Depends(get_current_user),
):
    user_id = current_user["id"]
    parsed = await parse_preference(req.text)

    # 0) 인식 실패 조기 반환 — 카테고리·속성이 **둘 다** 비면 저장 경로에 진입하지 않는다.
    #    (여기서 계속 진행하면 전 카테고리 평균 벡터가 학습된 벡터를 덮어쓰고, preference_note 에도
    #     '못 알아들었다'는 요약이 사용자 행에 기록된다.) 422 가 아니라 200 + applied=False 인 이유:
    #    응답 봉투(요약·llm_status 등)를 그대로 유지해 프런트가 '무엇을 못 알아들었는지'를
    #    같은 화면에 표시할 수 있게 하고, 프런트의 오프라인 폴백('AI 서버에 연결하지 못해…')이
    #    서버가 멀쩡한데도 뜨는 거짓 안내를 만들지 않게 하기 위해서다.
    if not parsed["preferred_categories"] and not parsed["attributes"]:
        logger.info(
            "preference_not_applied",
            user_id=user_id,
            reason=REASON_NO_PREFERENCE,
            mode=parsed["llm_status"],
            text_length=len(req.text or ""),  # 원문 본문은 로그 금지(길이만)
        )
        return ParsePreferenceResponse(
            preferred_categories=[],
            attributes=[],
            summary=parsed["summary"],
            is_fallback=parsed["is_fallback"],
            vector_updated=False,
            categories_saved=False,
            llm_status=parsed["llm_status"],
            applied=False,
            reason=REASON_NO_PREFERENCE,
        )

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

    # 선호는 인식했는데 벡터·카테고리 저장이 **둘 다** 실패했으면 반영된 것이 없다 —
    # 그 턴을 applied=True 로 보고하면 화면이 '반영했어요'라고 거짓말한다.
    applied = vector_updated or categories_saved
    logger.info(
        "preference_applied",
        user_id=user_id,
        categories=parsed["preferred_categories"],
        vector_updated=vector_updated,
        applied=applied,
    )
    return ParsePreferenceResponse(
        preferred_categories=parsed["preferred_categories"],
        attributes=parsed["attributes"],
        summary=parsed["summary"],
        is_fallback=parsed["is_fallback"],
        vector_updated=vector_updated,
        categories_saved=categories_saved,
        llm_status=parsed["llm_status"],
        applied=applied,
        reason=None if applied else REASON_STORAGE_UNAVAILABLE,
    )
