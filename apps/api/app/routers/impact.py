"""여행 임팩트 카드 라우터 — 사용자 본인의 여행 기록(출발·도착·혼잡회피·쿠폰·대기 차이)을 요약한다.

배경: 마이페이지에 공유용 '여행 임팩트 카드'를 추가하면서, 과장 없이 실제로 DB에서
파생 가능한 지표만 노출한다(레포 전반의 '지어내지 않기' 관용구를 따른다).

⚠️ 스키마 조사 결과 — 'visit_history' 테이블은 Supabase 스키마(supabase/RESET_AND_SETUP.sql)에
   존재하지 않는다. '방문' 이력은 apps/web/lib/visits.ts 가 브라우저 localStorage
   ('nextspot_visit_history')에만 적재하는 클라이언트 전용 데이터라 백엔드가 볼 수 없다.
   서버가 아는 도착은 recommendation_outcomes.arrival_confirmed_at(사용자가 '도착했어요'를 누른 기록)뿐이다.

- 인증: recommendations.py 의 사용자 인증 패턴(get_current_user, Supabase JWT)을 그대로 미러.
  익명 로그인 세션(handle_new_user 트리거로 프로비저닝된 사용자)도 동일하게 통과한다.
- DB: coupons.py 와 동일하게 service_role(supabase_admin) 클라이언트로 조회하되, 조회 조건을
  현재 사용자(user_id=토큰 주체)로만 좁혀 IDOR 을 방지한다(타인 데이터 접근 불가).

**같은 날 같은 곳은 한 번으로 센다(P0-5 b).** 예전 /main 의 '바로 갈래요'는 누를 때마다(도보·자동차 길안내,
영업시간 확인 뒤 다시) 수락 행을 새로 넣었고, 그 행들이 그대로 '대안으로 이동 N번' 으로 쌓였다. 한 번의 결정이
여러 번으로 세어지면 개인 기록이 부풀려진다. 그래서 (추천된 시설, KST 날짜)를 한 번의 출발로 묶는다.
둘 중 하나라도 모르는 행만 행 하나로 센다(묶을 근거가 없다).

반환 지표와 근거(컬럼):
  - accepted: recommendations.accepted = true 행을 위 규칙으로 묶은 수(길안내로 출발한 횟수).
  - arrivals_confirmed: recommendation_outcomes.arrival_confirmed_at 이 있는 추천을 같은 규칙으로 묶은 수.
    조회에 실패하면 None — 0 으로 지어내지 않는다(화면은 그 타일을 그리지 않는다).
  - congestion_avoided: 묶음 안에 score_breakdown.incentive_relief > 0 인 수락 행이 있는 수.
    incentive_relief = max(0, 원본혼잡 − 후보 도착시점 예측혼잡)(services/spot/score.py 에서
    산정 후 DB 에 스냅샷으로 저장됨) — '실제로 더 한산한 곳으로 옮겨간' 순간을 나타내는
    이미 저장된 파생값이라 새로 지어내지 않고 그대로 재사용한다.
  - coupons_issued / coupons_used: user_coupons 테이블 행 수 / status='used' 행 수.
  - wait_saved_minutes: score_breakdown 에 wait_time(후보 예상대기)과 original_wait_time(원본 예상대기,
    recommendations.py 가 저장)이 둘 다 있는 수락만, (original_wait_time − wait_time)의 양수분을 묶음마다
    한 번(가장 큰 값) 분 단위로 합산한다. 두 필드가 없는 행(예: /recommendations/accept 직접수락·by-type
    브라우즈 경로는 score_breakdown 이 비어있거나 원본 대기가 없다)은 집계에서 제외한다 — 추정치를 지어내지 않는다.
    모델 예측 사이의 차이라 화면은 '줄인 예상 대기' 로 부르고, 0 이면 타일을 그리지 않는다.

신규 사용자(데이터 없음)는 모든 지표 0을 반환한다(빈 상태 렌더는 프런트가 CTA로 안내).
"""
import asyncio
from datetime import datetime, timedelta, timezone

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.supabase import supabase_admin, get_current_user, fetch_all_rows

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/impact", tags=["impact"])

KST = timezone(timedelta(hours=9))


class ImpactSummaryResponse(BaseModel):
    accepted: int
    # 도착 확인 — 조회 실패면 None(모르는 값을 0 으로 말하지 않는다). 구 웹은 모르는 키라 무시한다.
    arrivals_confirmed: int | None = None
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


def _parse_ts(value) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _trip_key(row: dict, index: int) -> str:
    """한 번의 출발을 가리키는 열쇠 — (추천된 시설, KST 날짜). 둘 중 하나라도 모르면 행 하나가 한 번이다."""
    facility_id = row.get("recommended_facility_id")
    created = _parse_ts(row.get("created_at"))
    if facility_id and created is not None:
        return f"{facility_id}|{created.astimezone(KST).date().isoformat()}"
    row_id = row.get("id")
    return f"row|{row_id}" if row_id else f"index|{index}"


@router.get("/summary", response_model=ImpactSummaryResponse)
async def get_impact_summary(current_user: dict = Depends(get_current_user)):
    """본인의 여행 임팩트 요약 — 실제 DB 에서 파생 가능한 지표만 집계해 반환한다."""
    user_id = current_user["id"]

    # 전량이어야 한다. 이 화면이 내는 것은 **누적 합계**(출발 횟수·대기 차이 분)라, 한 페이지에서
    # 잘리면 사용자의 기여가 조용히 축소 보고된다 — 0 이 되는 게 아니라 '그럴듯하게 작은 값' 이
    # 되므로 화면만 봐서는 알 수 없다. 사용자 한 명당 상한이 없는 표라 실제로 넘는다:
    # 2026-09-07 프로덕션에서 가장 많이 쓴 계정이 이미 1,123건이다(캡 1,000).
    try:
        reco_rows = await asyncio.to_thread(
            fetch_all_rows,
            supabase_admin,
            "recommendations",
            "id, accepted, score_breakdown, recommended_facility_id, created_at",
            apply_filters=lambda q: q.eq("user_id", user_id).order("id"),
        )
    except Exception as e:
        logger.error("impact_summary_recommendations_fetch_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="여행 임팩트 데이터를 불러오지 못했습니다.")

    try:
        coupon_rows = await asyncio.to_thread(
            fetch_all_rows,
            supabase_admin,
            "user_coupons",
            "status",
            apply_filters=lambda q: q.eq("user_id", user_id).order("id"),
        )
    except Exception as e:
        logger.error("impact_summary_coupons_fetch_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="여행 임팩트 데이터를 불러오지 못했습니다.")

    # 도착 확인은 덧붙는 지표다 — 이 조회만 실패하면 화면 전체를 실패시키지 않고 None 으로 둔다.
    outcome_rows: list[dict] | None
    try:
        outcome_rows = await asyncio.to_thread(
            fetch_all_rows,
            supabase_admin,
            "recommendation_outcomes",
            "recommendation_id, arrival_confirmed_at",
            apply_filters=lambda q: q.eq("user_id", user_id).order("recommendation_id"),
        )
    except Exception as e:
        logger.warning("impact_summary_outcomes_fetch_failed", user_id=user_id, error=str(e))
        outcome_rows = None

    # 행마다 한 번의 출발 열쇠. 수락 묶음과 도착 묶음이 같은 열쇠를 써야 둘을 나란히 읽을 수 있다.
    keys = [_trip_key(row, index) for index, row in enumerate(reco_rows)]

    trips: dict[str, dict[str, float | None]] = {}
    for key, row in zip(keys, reco_rows):
        if row.get("accepted") is not True:
            continue
        trip = trips.setdefault(key, {"relief": None, "saved": None})
        bd = row.get("score_breakdown") or {}
        if not isinstance(bd, dict):
            continue
        relief = _to_float(bd.get("incentive_relief"))
        if relief is not None:
            trip["relief"] = relief if trip["relief"] is None else max(trip["relief"], relief)
        original_wait = _to_float(bd.get("original_wait_time"))
        wait = _to_float(bd.get("wait_time"))
        if original_wait is not None and wait is not None:
            saved = original_wait - wait
            trip["saved"] = saved if trip["saved"] is None else max(trip["saved"], saved)

    accepted = len(trips)
    congestion_avoided = sum(1 for trip in trips.values() if (trip["relief"] or 0.0) > 0)
    wait_saved_total = sum(max(0.0, trip["saved"] or 0.0) for trip in trips.values())

    arrivals_confirmed: int | None = None
    if outcome_rows is not None:
        key_by_id = {str(row["id"]): key for key, row in zip(keys, reco_rows) if row.get("id")}
        arrived: set[str] = set()
        for outcome in outcome_rows:
            if not outcome.get("arrival_confirmed_at"):
                continue
            recommendation_id = str(outcome.get("recommendation_id") or "")
            if not recommendation_id:
                continue
            # 추천 행을 못 찾으면(다른 경로로 지워짐 등) 그 추천 하나를 한 번으로 센다.
            arrived.add(key_by_id.get(recommendation_id, f"outcome|{recommendation_id}"))
        arrivals_confirmed = len(arrived)

    coupons_issued = len(coupon_rows)
    coupons_used = sum(1 for r in coupon_rows if r.get("status") == "used")

    logger.info(
        "impact_summary_computed",
        user_id=user_id,
        accepted=accepted,
        arrivals_confirmed=arrivals_confirmed,
        congestion_avoided=congestion_avoided,
        coupons_issued=coupons_issued,
        coupons_used=coupons_used,
        wait_saved_minutes=round(wait_saved_total),
    )

    return ImpactSummaryResponse(
        accepted=accepted,
        arrivals_confirmed=arrivals_confirmed,
        congestion_avoided=congestion_avoided,
        coupons_issued=coupons_issued,
        coupons_used=coupons_used,
        wait_saved_minutes=round(wait_saved_total),
    )
