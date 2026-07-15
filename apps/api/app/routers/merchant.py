"""소상공인 '내 가게 대시보드'(머천트 콘솔) 전용 라우터.

배경: 관광객 앱/관리자 관제와 별개로, 개별 가맹점 사장님이 자기 시설 하나만 보고 다루는
  전용 콘솔이 없었다. 이 라우터가 그 백엔드다 — apps/web/app/merchant/* 프런트가 소비한다.

- 모든 엔드포인트는 require_merchant(X-Merchant-Token 공유 토큰) 가드로 보호된다.
  (admin 라우터의 require_admin 패턴을 미러하되, 헤더/토큰 체계는 별도다 — 사장님 계정은
  관리자 권한이 아니므로 서로 다른 신뢰 경로를 쓴다.)
- DB 접근은 service_role(supabase_admin) — RLS 우회는 이 신뢰 경로 안에서만 일어난다.
- 예외 원문은 서버 로그로만 남기고 클라이언트에는 일반 메시지를 준다(admin 라우터와 동일 관례).

⚠️ MVP 스코프: 이번 라우터의 어떤 엔드포인트도 추천 랭킹(app/services/spot/score.py)에 영향을
  주지 않는다. 셀프 타임세일 발행·좌석 상태 방송 모두 "인센티브/추천 반영은 2단계 연동 예정"인
  정직한 표시 라벨과 함께 프런트에 노출된다 — score.py 는 이 스코프에서 건드리지 않는다.
"""
import asyncio
import hmac
import os
from datetime import datetime, timedelta, timezone
from typing import Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.supabase import supabase_admin

logger = structlog.get_logger()

# 백엔드 apps/api MERCHANT_API_TOKEN 과 프런트 apps/web NEXT_PUBLIC_MERCHANT_PASSWORD 세션 토큰이
# 동일 기본값('nextspot-merchant-local')을 공유한다(로컬 데모 전제). app/core/config.py 의
# Settings 는 이번 스코프의 소유 파일이 아니라 건드리지 않고, 여기서 직접 os.environ 을 읽는다
# (require_admin 의 settings.ADMIN_API_TOKEN 필수-값 패턴과 달리, 이 토큰은 기본값이 있어
# 미설정 배포에서도 부팅이 막히지 않는다 — 데모 우선 설계).
_MERCHANT_API_TOKEN = os.environ.get("MERCHANT_API_TOKEN", "nextspot-merchant-local")


def require_merchant(request: Request) -> dict:
    """사장님 콘솔 전용 가드 — 공유 토큰 검증(admin require_admin 미러, 헤더/체계는 별도).

    프런트(apps/web/app/merchant/*)는 세션 토큰을 X-Merchant-Token 헤더에 원문 그대로 보낸다
    (admin 의 `Bearer ` 접두 체계와 달리 접두어 없음 — 콘솔 간 신뢰 경로 혼선 방지 목적으로 헤더명 자체를 분리).
    토큰 비교는 hmac.compare_digest(상수시간)로 타이밍 공격을 방지한다.
    """
    token = (request.headers.get("x-merchant-token") or "").strip()
    if not token or not hmac.compare_digest(token, _MERCHANT_API_TOKEN):
        raise HTTPException(status_code=401, detail="유효하지 않은 사장님 인증 토큰입니다.")
    return {"role": "merchant"}


router = APIRouter(prefix="/api/v1/merchant", tags=["merchant"], dependencies=[Depends(require_merchant)])

_STATS_WINDOW_DAYS = 7
# 타임세일 UI 는 15/20/30% × 1/2/3시간의 고정 3×3 그리드다 — 서버도 동일 값만 허용해
# 임의 값(남용/오입력) 발행을 원천 차단한다.
_RATE_OPTIONS = (0.15, 0.20, 0.30)
_DURATION_MINUTES_OPTIONS = (60, 120, 180)
_SEAT_LEVELS = ("low", "mid", "full")


# =========================================================================
# 성적표 — GET /api/v1/merchant/stats?facility_id=
# 최근 7일 쿠폰 발급/사용(user_coupons) · 혼잡 제보(congestion_logs source='user_report') ·
# 추천 노출 대비 수락(recommendations recommended_facility_id 기준) 집계.
# ⚠️ '방문확인 수'는 apps/web/lib/visits.ts 가 클라이언트 로컬(localStorage)로만 관리해 서버에
#   시설별로 집계할 원천 데이터가 없다 — 지어내지 않고 null + 안내 문구로 정직하게 표시한다.
# =========================================================================


@router.get("/stats")
async def get_stats(facility_id: str):
    since = (datetime.now(timezone.utc) - timedelta(days=_STATS_WINDOW_DAYS)).isoformat()
    try:
        coupons_res, reports_res, recs_res = await asyncio.gather(
            asyncio.to_thread(
                supabase_admin.table("user_coupons")
                .select("status, issued_at")
                .eq("facility_id", facility_id)
                .gte("issued_at", since)
                .limit(5000)
                .execute
            ),
            asyncio.to_thread(
                supabase_admin.table("congestion_logs")
                .select("id, timestamp")
                .eq("facility_id", facility_id)
                .eq("source", "user_report")
                .gte("timestamp", since)
                .limit(5000)
                .execute
            ),
            asyncio.to_thread(
                supabase_admin.table("recommendations")
                .select("accepted, created_at")
                .eq("recommended_facility_id", facility_id)
                .gte("created_at", since)
                .limit(5000)
                .execute
            ),
        )
    except Exception as e:
        logger.error("merchant_stats_fetch_failed", facility_id=facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="성적표 집계에 실패했습니다.")

    coupons = coupons_res.data or []
    reports = reports_res.data or []
    recs = recs_res.data or []

    return {
        "facility_id": facility_id,
        "since": since,
        "window_days": _STATS_WINDOW_DAYS,
        "coupons_issued": len(coupons),
        "coupons_used": sum(1 for c in coupons if c.get("status") == "used"),
        "congestion_reports": len(reports),
        "recommendations_exposed": len(recs),
        "recommendations_accepted": sum(1 for r in recs if r.get("accepted")),
        # 서버 미집계 항목 — 지어내지 않고 정직하게 null + 사유를 함께 준다(프런트가 문구로 노출).
        "visit_confirmations": None,
        "visit_confirmations_note": (
            "방문확인은 현재 관광객 단말 로컬 기록(localStorage)이라 매장별 서버 집계가 불가합니다. "
            "서버 적재 연동은 2단계 예정입니다."
        ),
    }


# =========================================================================
# 셀프 타임세일 — POST /timesale(발행) · GET /timesale(활성 목록) · POST /timesale/cancel(취소)
# ⚠️ 발행/취소는 merchant_timesales 테이블에만 반영된다 — 추천 랭킹(score.py) 인센티브 가중치에는
#   아직 연결되지 않는다(2단계 연동 예정). 프런트가 이 사실을 라벨로 안내한다.
# =========================================================================


class TimesaleCreate(BaseModel):
    facility_id: str
    rate: Literal[0.15, 0.20, 0.30] = Field(description="타임세일 할인율(15/20/30% 중 하나)")
    duration_minutes: Literal[60, 120, 180] = Field(description="지속 시간(분) — 1/2/3시간 중 하나")


class TimesaleCancel(BaseModel):
    id: str
    facility_id: str


async def _facility_exists(facility_id: str) -> bool:
    res = await asyncio.to_thread(
        supabase_admin.table("facilities").select("id").eq("id", facility_id).limit(1).execute
    )
    return bool(res.data)


@router.post("/timesale")
async def create_timesale(req: TimesaleCreate):
    """타임세일 발행 — 유령 세일 방지를 위해 시설 존재를 먼저 검증한다(admin 혼잡 override 패턴 미러)."""
    try:
        exists = await _facility_exists(req.facility_id)
    except Exception as e:
        logger.error("merchant_timesale_facility_lookup_failed", error=str(e))
        raise HTTPException(status_code=500, detail="타임세일 발행에 실패했습니다.")
    if not exists:
        raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.")

    now = datetime.now(timezone.utc)
    ends_at = now + timedelta(minutes=req.duration_minutes)
    row = {
        "facility_id": req.facility_id,
        "rate": req.rate,
        "starts_at": now.isoformat(),
        "ends_at": ends_at.isoformat(),
    }
    try:
        ins = await asyncio.to_thread(supabase_admin.table("merchant_timesales").insert(row).execute)
        if not ins.data:
            raise HTTPException(status_code=500, detail="타임세일 발행에 실패했습니다.")
    except HTTPException:
        raise
    except Exception as e:
        # 마이그레이션 미적용 환경(테이블 부재)도 여기로 흡수된다 — 프런트는 일반 실패로 취급한다.
        logger.error("merchant_timesale_create_failed", facility_id=req.facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="타임세일 발행에 실패했습니다.")

    logger.info(
        "merchant_timesale_created", facility_id=req.facility_id,
        rate=req.rate, duration_minutes=req.duration_minutes,
    )
    return ins.data[0]


@router.get("/timesale")
async def list_active_timesales(facility_id: str):
    """활성(미취소·미만료) 타임세일 목록 — created_at 최신순."""
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("merchant_timesales")
            .select("*")
            .eq("facility_id", facility_id)
            .is_("canceled_at", "null")
            .gt("ends_at", now_iso)
            .order("created_at", desc=True)
            .execute
        )
    except Exception as e:
        logger.error("merchant_timesale_list_failed", facility_id=facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="타임세일 목록 조회에 실패했습니다.")
    return res.data or []


@router.post("/timesale/cancel")
async def cancel_timesale(req: TimesaleCancel):
    """타임세일 취소 — id+facility_id 일치 행만 canceled_at 을 채운다(타 시설 세일 오취소 방지)."""
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("merchant_timesales")
            .update({"canceled_at": datetime.now(timezone.utc).isoformat()})
            .eq("id", req.id)
            .eq("facility_id", req.facility_id)
            .execute
        )
    except Exception as e:
        logger.error("merchant_timesale_cancel_failed", timesale_id=req.id, error=str(e))
        raise HTTPException(status_code=500, detail="타임세일 취소에 실패했습니다.")
    if not res.data:
        raise HTTPException(status_code=404, detail="해당 타임세일을 찾을 수 없습니다.")
    logger.info("merchant_timesale_canceled", timesale_id=req.id, facility_id=req.facility_id)
    return res.data[0]


# =========================================================================
# 좌석 상태 방송 — POST /seat-status
# facilities.features(jsonb) 에 seat_status:{level, updated_at} 을 병합 저장한다(신규 컬럼/마이그레이션 불필요).
# ⚠️ 추천 랭킹 반영은 2단계 예정 — 이 엔드포인트는 현재 상태 표시 용도로만 쓰인다.
# =========================================================================


class SeatStatusUpdate(BaseModel):
    facility_id: str
    level: Literal["low", "mid", "full"] = Field(description="여유(low)/보통(mid)/만석(full)")


@router.post("/seat-status")
async def update_seat_status(req: SeatStatusUpdate):
    try:
        fac_res = await asyncio.to_thread(
            supabase_admin.table("facilities").select("id, features").eq("id", req.facility_id).limit(1).execute
        )
    except Exception as e:
        logger.error("merchant_seat_status_lookup_failed", facility_id=req.facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="좌석 상태 갱신에 실패했습니다.")
    if not fac_res.data:
        raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.")

    current_features = fac_res.data[0].get("features") or {}
    if not isinstance(current_features, dict):
        current_features = {}
    updated_at = datetime.now(timezone.utc).isoformat()
    new_features = {**current_features, "seat_status": {"level": req.level, "updated_at": updated_at}}

    try:
        upd = await asyncio.to_thread(
            supabase_admin.table("facilities").update({"features": new_features}).eq("id", req.facility_id).execute
        )
        if not upd.data:
            raise HTTPException(status_code=500, detail="좌석 상태 갱신에 실패했습니다.")
    except HTTPException:
        raise
    except Exception as e:
        logger.error("merchant_seat_status_update_failed", facility_id=req.facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="좌석 상태 갱신에 실패했습니다.")

    logger.info("merchant_seat_status_updated", facility_id=req.facility_id, level=req.level)
    return {"facility_id": req.facility_id, "level": req.level, "updated_at": updated_at}
