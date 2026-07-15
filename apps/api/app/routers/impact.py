"""여행 임팩트 카드 라우터 — 사용자 본인의 여행 성과(수락·혼잡회피·쿠폰·대기절감)를 요약한다.

배경: 마이페이지에 공유용 '여행 임팩트 카드'를 추가하면서, 과장 없이 실제로 DB에서
파생 가능한 지표만 노출한다(정직성 원칙 — 레포 전반의 '지어내지 않기' 관용구를 따른다).

⚠️ 스키마 조사 결과 — 'visit_history' 테이블은 Supabase 스키마(supabase/RESET_AND_SETUP.sql)에
   존재하지 않는다. '방문' 이력은 apps/web/lib/visits.ts 가 브라우저 localStorage
   ('nextspot_visit_history')에만 적재하는 클라이언트 전용 데이터라 백엔드가 볼 수 없다.
   따라서 이 엔드포인트는 '방문 n곳' 지표를 반환하지 않는다(추정 금지 — 프런트도 이 키가
   없으면 해당 타일을 렌더하지 않는다).

- 인증: recommendations.py 의 사용자 인증 패턴(get_current_user, Supabase JWT)을 그대로 미러.
  익명 로그인 세션(handle_new_user 트리거로 프로비저닝된 사용자)도 동일하게 통과한다.
- DB: coupons.py 와 동일하게 service_role(supabase_admin) 클라이언트로 조회하되, 조회 조건을
  현재 사용자(user_id=토큰 주체)로만 좁혀 IDOR 을 방지한다(타인 데이터 접근 불가).

반환 지표와 근거(컬럼):
  - accepted: recommendations.accepted = true 행 수(수락 확정한 대안 추천 수).
  - congestionAvoided: accepted 행 중 score_breakdown.incentive_relief > 0 인 건수.
    incentive_relief = max(0, 원본혼잡 − 후보 도착시점 예측혼잡)(services/spot/score.py 에서
    산정 후 DB 에 스냅샷으로 저장됨) — '실제로 더 한산한 곳으로 옮겨간' 순간을 나타내는
    이미 저장된 파생값이라 새로 지어내지 않고 그대로 재사용한다.
  - couponsIssued / couponsUsed: user_coupons 테이블 행 수 / status='used' 행 수.
  - waitSavedMinutes: accepted 행 중 score_breakdown 에 wait_time(후보 예상대기)과
    original_wait_time(원본 예상대기, recommendations.py 가 저장)이 둘 다 있으면
    (original_wait_time − wait_time)의 양수분만 분 단위로 합산한다. 두 필드가 없는 행
    (예: /recommendations/accept 직접수락·by-type 브라우즈 경로는 score_breakdown 이
    비어있거나 DB 미저장)은 집계에서 제외한다 — 추정치를 지어내지 않는다.

신규 사용자(데이터 없음)는 모든 지표 0을 반환한다(빈 상태 렌더는 프런트가 CTA로 안내).
"""
import asyncio

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.supabase import supabase_admin, get_current_user

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/impact", tags=["impact"])


class ImpactSummaryResponse(BaseModel):
    accepted: int
    congestion_avoided: int
    coupons_issued: int
    coupons_used: int
    wait_saved_minutes: int


def _to_float(value) -> float | None:
    """score_breakdown(JSONB) 값의 방어적 float 변환 — 없거나 숫자가 아니면 None."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


@router.get("/summary", response_model=ImpactSummaryResponse)
async def get_impact_summary(current_user: dict = Depends(get_current_user)):
    """본인의 여행 임팩트 요약 — 실제 DB 에서 파생 가능한 지표만 집계해 반환한다."""
    user_id = current_user["id"]

    try:
        reco_res = await asyncio.to_thread(
            supabase_admin.table("recommendations")
            .select("accepted, score_breakdown")
            .eq("user_id", user_id)
            .execute
        )
    except Exception as e:
        logger.error("impact_summary_recommendations_fetch_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="여행 임팩트 데이터를 불러오지 못했습니다.")

    try:
        coupon_res = await asyncio.to_thread(
            supabase_admin.table("user_coupons")
            .select("status")
            .eq("user_id", user_id)
            .execute
        )
    except Exception as e:
        logger.error("impact_summary_coupons_fetch_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="여행 임팩트 데이터를 불러오지 못했습니다.")

    reco_rows = reco_res.data or []
    coupon_rows = coupon_res.data or []

    accepted_rows = [r for r in reco_rows if r.get("accepted") is True]
    accepted = len(accepted_rows)

    congestion_avoided = 0
    wait_saved_total = 0.0
    for row in accepted_rows:
        bd = row.get("score_breakdown") or {}
        if not isinstance(bd, dict):
            continue

        relief = _to_float(bd.get("incentive_relief"))
        if relief is not None and relief > 0:
            congestion_avoided += 1

        original_wait = _to_float(bd.get("original_wait_time"))
        wait = _to_float(bd.get("wait_time"))
        if original_wait is not None and wait is not None:
            saved = original_wait - wait
            if saved > 0:
                wait_saved_total += saved

    coupons_issued = len(coupon_rows)
    coupons_used = sum(1 for r in coupon_rows if r.get("status") == "used")

    logger.info(
        "impact_summary_computed",
        user_id=user_id,
        accepted=accepted,
        congestion_avoided=congestion_avoided,
        coupons_issued=coupons_issued,
        coupons_used=coupons_used,
        wait_saved_minutes=round(wait_saved_total),
    )

    return ImpactSummaryResponse(
        accepted=accepted,
        congestion_avoided=congestion_avoided,
        coupons_issued=coupons_issued,
        coupons_used=coupons_used,
        wait_saved_minutes=round(wait_saved_total),
    )
