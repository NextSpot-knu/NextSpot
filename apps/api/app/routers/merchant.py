"""소상공인 '내 가게 대시보드'(머천트 콘솔) 전용 라우터.

배경: 관광객 앱/관리자 관제와 별개로, 개별 가맹점 사장님이 자기 시설 하나만 보고 다루는
  전용 콘솔이 없었다. 이 라우터가 그 백엔드다 — apps/web/app/merchant/* 프런트가 소비한다.

- 모든 엔드포인트는 require_merchant(X-Merchant-Token 공유 토큰) 가드로 보호된다.
  (admin 라우터의 require_admin 패턴을 미러하되, 헤더/토큰 체계는 별도다 — 사장님 계정은
  관리자 권한이 아니므로 서로 다른 신뢰 경로를 쓴다.)
- DB 접근은 service_role(supabase_admin) — RLS 우회는 이 신뢰 경로 안에서만 일어난다.
- 예외 원문은 서버 로그로만 남기고 클라이언트에는 일반 메시지를 준다(admin 라우터와 동일 관례).

추천 랭킹 반영 범위(2026-07 코드 확인 — 도입 당시 "미연동" 주석은 사실과 달라 정정):
  이 라우터가 쓰는 두 값은 app/services/merchant_boost.py 의 데이터 레이어 오버레이를 거쳐
  추천 랭킹에 **실제로 반영된다**. score.py(산식·가중치)는 무변경 — 오버레이는 score.py 가
  이미 읽는 입력값을 스코어링 직전에 바꿔치기하는 방식이다.
  - 셀프 타임세일(merchant_timesales): merchant_boost._apply_timesale_boost 가 활성 세일 중
    **최댓값 rate** 로 facility["coupon_rate"] 를 max() 갱신 → score.py 의 인센티브 항에 반영.
  - 좌석 상태(facilities.features.seat_status): **30분 이내로 신선할 때만**
    merchant_boost._apply_seat_status_boost 가 '현재 혼잡'을 대체(low=0.15/mid=0.5/full=0.9).
    30분을 넘긴 값은 무시된다.
  적용 호출부(확인된 3곳): recommendations.py:370 · courses.py:245 · coupon_service.py:55
  (쿠폰 발급 시점의 유효 쿠폰율 재확인). 그 외 경로에는 적용되지 않는다.
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
                .neq("source", "browse")
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
# 발행/취소는 merchant_timesales 테이블에 반영되고, merchant_boost 오버레이를 통해 추천 랭킹의
# 인센티브 항에 실반영된다(모듈 상단 '추천 랭킹 반영 범위' 참조 — score.py 자체는 무변경).
# ⚠️ 동시 활성 세일: 발행을 막지 않는다(기존 동작 유지). 다만 오버레이가 활성 세일 중 **최댓값**
#   rate 만 쓰므로, 방금 발행한 세일이 곧바로 적용되지 않을 수 있다 — 응답에 실제 적용 할인율을
#   함께 실어 프런트가 사장님에게 안내하게 한다(아래 _active_timesale_rates 참조).
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


async def _active_timesale_rates(facility_id: str) -> list[float] | None:
    """지금 이 순간 추천에 반영되는 활성 세일들의 rate 목록. 조회 실패 시 None(=알 수 없음).

    필터는 merchant_boost._apply_timesale_boost 와 **동일하게** 맞춘다(canceled_at is null,
    starts_at <= now <= ends_at) — 여기서 계산한 '적용 할인율' 이 실제 랭킹 반영값과 어긋나면
    안내 자체가 거짓말이 되기 때문이다. GET /timesale(목록)은 starts_at 을 보지 않지만,
    이 함수의 목적은 '표시' 가 아니라 '실적용 예측' 이므로 오버레이 기준을 따른다.
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("merchant_timesales")
            .select("rate, starts_at, ends_at, canceled_at")
            .eq("facility_id", facility_id)
            .is_("canceled_at", "null")
            .lte("starts_at", now_iso)
            .gte("ends_at", now_iso)
            .execute
        )
    except Exception as e:
        # 안내용 부가 정보일 뿐 — 발행 자체를 실패시키지 않는다(무해 폴백, 아래 None 처리).
        logger.warning("merchant_timesale_active_lookup_failed", facility_id=facility_id, error=str(e))
        return None

    rates: list[float] = []
    for row in res.data or []:
        try:
            rate = row.get("rate")
            if rate is not None:
                rates.append(float(rate))
        except (TypeError, ValueError):
            continue
    return rates


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

    # 발행 '전' 스냅샷 — 방금 만든 세일이 집계에 섞이지 않게 insert 앞에서 읽는다.
    prior_rates = await _active_timesale_rates(req.facility_id)

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

    # 중복 활성 세일 안내(감사 P1-7) — 발행을 막지는 않되, 오버레이가 '최댓값만' 쓴다는 사실을
    # 응답에 실어 사장님이 어떤 할인율이 실제로 적용되는지 알 수 있게 한다.
    # 조회 실패(prior_rates is None)면 지어내지 않고 None 을 그대로 준다(프런트는 안내 생략).
    created = dict(ins.data[0])
    if prior_rates is None:
        created["other_active_timesale_count"] = None
        created["effective_timesale_rate"] = None
        created["effective_timesale_note"] = None
    else:
        effective = max([*prior_rates, req.rate])
        created["other_active_timesale_count"] = len(prior_rates)
        created["effective_timesale_rate"] = effective
        created["effective_timesale_note"] = (
            None
            if not prior_rates
            else (
                f"이미 진행 중인 타임세일이 {len(prior_rates)}건 있습니다. "
                f"추천에는 활성 세일 중 가장 높은 할인율인 {round(effective * 100)}% 가 적용됩니다."
                + (
                    ""
                    if effective == req.rate
                    else f" 방금 발행한 {round(req.rate * 100)}% 는 더 높은 세일이 끝난 뒤 적용됩니다."
                )
            )
        )
    return created


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
# 추천 랭킹에는 **30분 이내 신선한 값만** 반영된다(merchant_boost.SEAT_STATUS_FRESH_MINUTES).
# level=null 이면 해제 — features 에서 seat_status 키를 통째로 제거한다(타임스탬프가 그 안에
# 중첩돼 있어 별도 정리 대상은 없다). 사장님이 "지금은 모르겠다" 로 되돌릴 수 있어야,
# 오래된 방송이 30분간 랭킹에 남는 상황을 스스로 끊을 수 있다.
# =========================================================================


class SeatStatusUpdate(BaseModel):
    facility_id: str
    # None 은 '해제' 를 뜻한다. 기본값을 두지 않아 필드 자체가 필수 — 바디 누락/오타로 실수로
    # 해제되는 일이 없게, 해제하려면 level:null 을 명시적으로 보내야 한다.
    level: Literal["low", "mid", "full"] | None = Field(
        description="여유(low)/보통(mid)/만석(full), null 이면 좌석 상태 해제"
    )


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
    if req.level is None:
        # 해제 — features 의 다른 키(average_processing_time 등)는 보존하고 seat_status 만 뺀다.
        new_features = {k: v for k, v in current_features.items() if k != "seat_status"}
    else:
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

    logger.info(
        "merchant_seat_status_cleared" if req.level is None else "merchant_seat_status_updated",
        facility_id=req.facility_id, level=req.level,
    )
    # 응답 형태 불변(기존 3키) — 해제 시 level=None, updated_at 은 '해제한 시각'.
    return {"facility_id": req.facility_id, "level": req.level, "updated_at": updated_at}
