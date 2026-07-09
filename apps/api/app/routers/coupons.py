"""내 쿠폰함(인센티브 지갑) 라우터 — SPOT w3 인센티브(facilities.coupon_rate)를 고객에게 노출.

배경: SPOT 점수는 이미 제휴 할인율(coupon_rate)을 w3 인센티브 항으로 소비하지만
(services/spot/score.py), 그 값이 고객에게는 보이지 않았다. 분산 추천을 '수락'하면 실제
쿠폰이 지갑에 발급되도록 이 라우터가 user_coupons 를 읽고/발급한다.

- 인증: get_current_user(Supabase JWT) — 본인 쿠폰만 접근(IDOR 는 user_id = 토큰 주체로 강제).
- DB: service_role(supabase_admin) — user_coupons RLS 는 사용자에게 SELECT 만 허용하고
  발급(INSERT/UPDATE)은 이 신뢰 경로 전용이다(20260710130000_add_user_coupons.sql).
- 예외 원문은 서버 로그로만 남기고 클라이언트에는 일반 메시지를 준다.
"""
import asyncio
from datetime import datetime, timezone

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.supabase import supabase_admin, get_current_user

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/coupons", tags=["coupons"])


class IssueCouponRequest(BaseModel):
    facility_id: str = Field(..., description="쿠폰을 발급할 시설(제휴 가맹점) id")


@router.get("/mine")
async def list_my_coupons(current_user: dict = Depends(get_current_user)):
    """현재 사용자의 쿠폰 목록 — 시설명/유형을 조인해 반환(발급 최신순)."""
    user_id = current_user["id"]
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("user_coupons")
            .select("*, facility:facilities(name, type)")
            .eq("user_id", user_id)
            .order("issued_at", desc=True)
            .execute
        )
    except Exception as e:
        logger.error("coupons_list_failed", user_id=user_id, error=str(e))
        raise HTTPException(status_code=500, detail="쿠폰 목록 조회에 실패했습니다.")

    coupons = []
    for row in res.data or []:
        # 조인된 facility 는 dict/list 어느 형태로 와도 안전 추출(PostgREST 임베딩 편차 대비).
        f = row.get("facility")
        if isinstance(f, list):
            f = f[0] if f else None
        f = f if isinstance(f, dict) else {}
        coupons.append({
            "id": row.get("id"),
            "facility_id": row.get("facility_id"),
            "facility_name": f.get("name"),
            "facility_type": f.get("type"),
            "coupon_rate": row.get("coupon_rate"),
            "status": row.get("status"),
            "issued_at": row.get("issued_at"),
            "used_at": row.get("used_at"),
        })
    return coupons


@router.post("/issue")
async def issue_coupon(
    req: IssueCouponRequest,
    current_user: dict = Depends(get_current_user),
):
    """제휴 시설의 현재 coupon_rate 로 쿠폰을 발급(upsert on user_id+facility_id).

    coupon_rate <= 0(제휴 없음)인 시설은 발급을 거부한다(422).
    """
    user_id = current_user["id"]

    # 1) 시설의 현재 제휴 할인율 조회 — 발급 시점 값을 스냅샷으로 굳힌다.
    try:
        fac_res = await asyncio.to_thread(
            supabase_admin.table("facilities")
            .select("id, name, coupon_rate")
            .eq("id", req.facility_id)
            .execute
        )
    except Exception as e:
        logger.error("coupon_issue_facility_fetch_failed", facility_id=req.facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="시설 정보 조회에 실패했습니다.")

    if not fac_res.data:
        raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.")
    facility = fac_res.data[0]
    coupon_rate = facility.get("coupon_rate") or 0
    if coupon_rate <= 0:
        raise HTTPException(status_code=422, detail="제휴 할인이 없는 시설이라 쿠폰을 발급할 수 없습니다.")

    # 2) 발급 — 이미 보유 시 무시(ignore_duplicates)해 사용/발급 상태를 되돌리지 않는다(리뷰 P2#8).
    #    issued_at/used_at 은 신규 INSERT 에만 적용(DB 기본값 대비 명시). 기존 행은 손대지 않는다.
    payload = {
        "user_id": user_id,
        "facility_id": req.facility_id,
        "coupon_rate": coupon_rate,
        "status": "issued",
        "issued_at": datetime.now(timezone.utc).isoformat(),
        "used_at": None,
    }
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("user_coupons")
            .upsert(payload, on_conflict="user_id,facility_id", ignore_duplicates=True)
            .execute
        )
    except Exception as e:
        logger.error("coupon_issue_failed", user_id=user_id, facility_id=req.facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="쿠폰 발급에 실패했습니다.")

    row = res.data[0] if res.data else None
    if row is None:
        # 이미 보유(중복 무시로 INSERT 안 됨) → 기존 쿠폰을 조회해 그대로 반환한다(되돌리지 않음).
        try:
            ex = await asyncio.to_thread(
                supabase_admin.table("user_coupons")
                .select("*")
                .eq("user_id", user_id)
                .eq("facility_id", req.facility_id)
                .execute
            )
        except Exception as e:
            logger.error("coupon_issue_lookup_failed", user_id=user_id, facility_id=req.facility_id, error=str(e))
            raise HTTPException(status_code=500, detail="쿠폰 발급에 실패했습니다.")
        row = ex.data[0] if ex.data else None
    if row is None:
        raise HTTPException(status_code=500, detail="쿠폰 발급에 실패했습니다.")
    logger.info("coupon_issued", user_id=user_id, facility_id=req.facility_id, coupon_rate=coupon_rate)
    return {
        "id": row.get("id"),
        "facility_id": row.get("facility_id"),
        "facility_name": facility.get("name"),
        "coupon_rate": row.get("coupon_rate"),
        "status": row.get("status"),
        "issued_at": row.get("issued_at"),
    }
