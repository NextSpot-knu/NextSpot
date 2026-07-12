"""혼잡 제보(크라우드소싱) 라우터.

관광객이 '지금 이곳이 얼마나 붐비는지'를 직접 제보하는 엔드포인트.

보안 배경(20260707120000_security_hardening.sql + init RLS):
  congestion_logs 는 service_role 만 INSERT 할 수 있도록 잠겨 있다(anon/authenticated 직접
  쓰기 거부). 따라서 클라이언트가 Supabase 로 직접 insert 하지 못하고, 반드시 이 백엔드
  엔드포인트를 거쳐 supabase_admin(service_role) 으로 기록해야 한다. 신뢰 경계는
  get_current_user(로그인 필수)로 강제한다 — 익명 대량 조작을 1차 차단.

레이트리밋: 사용자·시설당 5분 쿨다운(_REPORT_COOLDOWN_SEC)을 프로세스 인메모리로 적용해
  스팸/조작이 ML 혼잡 신호를 오염시키는 것을 1차 차단한다. 단일 인스턴스 데모 기준이며,
  다중 인스턴스 배포 시에는 Redis 등 공유 저장소 기반 토큰버킷으로 승격해야 한다.
"""
import asyncio
import time
from datetime import datetime, timezone
from typing import Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

# congestion_logs 쓰기는 RLS 우회가 필요해 service_role(supabase_admin) 을 쓴다
# (infrastructures.simulate_peak / recommendations 와 동일 사유 — anon INSERT 는 RLS 로 거부됨).
from app.core.supabase import supabase_admin, get_current_user
from app.services.coupon_service import issue_coupon_if_partner

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1", tags=["reports"])

# 제보 보상 주기 — 이 배수의 제보마다 해당 시설이 제휴면 쿠폰을 발급한다.
_REWARD_EVERY = 3

# 3단계 체감 혼잡도(한산/보통/혼잡) → 0~1 추정치 매핑.
# 프런트 3지선다 버튼과 정합. 소수 라벨은 UX 부담이 커 이산 3구간으로 단순화한다.
_LEVEL_ENUM = {"한산": 0.2, "보통": 0.55, "혼잡": 0.9}

# congestion_logs.source CHECK 제약은 ('traffic_cctv','tour_api','event','user_report') 만 허용한다.
# 사용자 제보는 'user_report' 로 기록한다(스키마 제약을 만족하는 정식 값).
_USER_REPORT_SOURCE = "user_report"

# 사용자·시설당 제보 쿨다운(초) — 스팸/조작이 ML 혼잡 신호를 오염시키지 않도록 1차 차단.
# 프로세스 인메모리(단일 인스턴스 데모 기준). 다중 인스턴스는 Redis 등 공유 저장소로 승격 필요.
_REPORT_COOLDOWN_SEC = 300.0
_last_report_at: dict[tuple[str, str], float] = {}


class CongestionReportRequest(BaseModel):
    facility_id: str
    # level 은 0~1 연속 추정치 또는 한산/보통/혼잡 라벨 중 하나를 받는다.
    # (프런트는 라벨을 보내고, 다른 클라이언트가 수치를 보내도 검증되게 union 으로 수용.)
    level: float | Literal["한산", "보통", "혼잡"] = Field(
        ..., description="0~1 혼잡 추정치 또는 한산/보통/혼잡"
    )


class ReportReward(BaseModel):
    report_count: int      # 누적 제보 횟수(이번 제보 반영 후)
    coupon_issued: bool    # 이번 제보로 쿠폰이 발급됐는지(제휴 시설 & 보상 주기 도달 시)
    next_reward_in: int    # 다음 보상까지 남은 제보 수


class CongestionReportResponse(BaseModel):
    success: bool
    facility_id: str
    congestion_level: float
    current_count: int
    timestamp: str
    source: str
    reward: ReportReward


async def _bump_report_count(user_id: str) -> int:
    """users.report_count 를 +1 하고 갱신 후 값을 반환한다(제보 보상 게이팅용).

    단일 인스턴스 데모 기준의 read-modify-write(원자적 증가 아님) — 동시 제보 경합은 데모 범위에서 무시한다.
    select 실패 시 0(보상 없음)으로 강등하고, update 실패는 흡수한다(제보 성공 자체는 유지).
    """
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("users").select("report_count").eq("id", user_id).limit(1).execute
        )
    except Exception as e:
        logger.warning("report_count_fetch_failed", user_id=user_id, error=str(e))
        return 0
    current = (res.data[0].get("report_count") or 0) if res.data else 0
    new_count = int(current) + 1
    try:
        await asyncio.to_thread(
            supabase_admin.table("users").update({"report_count": new_count}).eq("id", user_id).execute
        )
    except Exception as e:
        # 카운트 영속화 실패라도 이번 제보의 의도된 누적값은 그대로 보고한다(제보 자체는 저장됨).
        logger.warning("report_count_update_failed", user_id=user_id, error=str(e))
    return new_count


def _coerce_level(level: float | str) -> float:
    """입력 level 을 0~1 실수로 정규화한다(라벨이면 매핑, 수치면 범위 검증)."""
    if isinstance(level, str):
        mapped = _LEVEL_ENUM.get(level.strip())
        if mapped is None:
            raise HTTPException(
                status_code=422,
                detail="level 은 한산/보통/혼잡 또는 0~1 사이 수치여야 합니다.",
            )
        return mapped
    # 수치 경로: DB CHECK(congestion_level 0~1)와 정합하도록 범위 검증
    if not (0.0 <= level <= 1.0):
        raise HTTPException(status_code=422, detail="level 수치는 0.0~1.0 범위여야 합니다.")
    return float(level)


@router.post("/reports/congestion", response_model=CongestionReportResponse)
async def report_congestion(
    req: CongestionReportRequest,
    current_user: dict = Depends(get_current_user),
):
    """관광객의 실시간 혼잡 제보를 congestion_logs 에 기록한다(source='user_report').

    흐름: 인증(get_current_user) → level 정규화 → 시설 존재 검증 →
    supabase_admin 으로 로그 INSERT. current_count 는 capacity×level 로 추정한다
    (congestion_logs 에 실인원 컬럼은 있으나 제보는 인원을 모르므로 수용량 기반 추정).
    """
    level = _coerce_level(req.level)

    logger.info(
        "congestion_report_received",
        user_id=current_user["id"],
        facility_id=req.facility_id,
        level=level,
    )

    # 1. 시설 존재 검증 (없는 facility_id 로의 FK 위반/유령 로그 방지). coupon_rate 는 제보 보상 발급 판정용.
    fac_res = await asyncio.to_thread(
        supabase_admin.table("facilities")
        .select("id, capacity, coupon_rate")
        .eq("id", req.facility_id)
        .limit(1)
        .execute
    )
    if not fac_res.data:
        raise HTTPException(status_code=404, detail="시설 정보를 찾을 수 없습니다.")

    # 1-1. 레이트리밋: 사용자·시설당 쿨다운(스팸/조작 1차 차단). 성공 제보 후에만 타임스탬프를 갱신한다.
    cooldown_key = (current_user["id"], req.facility_id)
    last_at = _last_report_at.get(cooldown_key)
    now_mono = time.monotonic()
    if last_at is not None and (now_mono - last_at) < _REPORT_COOLDOWN_SEC:
        retry_after = max(1, int(_REPORT_COOLDOWN_SEC - (now_mono - last_at)))
        raise HTTPException(
            status_code=429,
            detail=f"제보는 {int(_REPORT_COOLDOWN_SEC // 60)}분에 한 번만 가능합니다. 잠시 후 다시 시도해 주세요.",
            headers={"Retry-After": str(retry_after)},
        )

    capacity = fac_res.data[0].get("capacity") or 0
    current_count = round(capacity * level)
    now_str = datetime.now(timezone.utc).isoformat()

    row = {
        "facility_id": req.facility_id,
        "congestion_level": level,
        "current_count": current_count,
        "source": _USER_REPORT_SOURCE,
        "timestamp": now_str,
    }

    # 2. service_role 로 INSERT (anon/authenticated 직접 쓰기는 RLS 로 거부됨 — 상단 도크 참조)
    try:
        ins = await asyncio.to_thread(
            supabase_admin.table("congestion_logs").insert(row).execute
        )
    except Exception as e:
        logger.error("congestion_report_insert_failed", error=str(e), facility_id=req.facility_id)
        raise HTTPException(status_code=500, detail="혼잡 제보 저장에 실패했습니다.")

    _last_report_at[cooldown_key] = now_mono  # 성공 제보 후 쿨다운 시작
    inserted = (ins.data or [{}])[0]
    logger.info("congestion_report_saved", facility_id=req.facility_id, level=level)

    # 3. 제보 보상: 누적 제보 +1, _REWARD_EVERY 배수마다 제휴 시설이면 쿠폰 발급(coupon_rate 0 이면 카운트만).
    report_count = await _bump_report_count(current_user["id"])
    coupon_issued = False
    if report_count > 0 and report_count % _REWARD_EVERY == 0:
        facility_row = fac_res.data[0]
        issue = await issue_coupon_if_partner(
            supabase_admin,
            current_user["id"],
            {"id": req.facility_id, "coupon_rate": facility_row.get("coupon_rate")},
        )
        coupon_issued = issue["coupon_issued"]
    # 다음 보상까지 남은 제보 수 = 다음 배수 - 현재 누적. (report_count=0 강등 시에도 _REWARD_EVERY.)
    next_reward_in = ((report_count // _REWARD_EVERY) + 1) * _REWARD_EVERY - report_count

    return CongestionReportResponse(
        success=True,
        facility_id=req.facility_id,
        congestion_level=inserted.get("congestion_level", level),
        current_count=inserted.get("current_count", current_count),
        timestamp=inserted.get("timestamp", now_str),
        source=inserted.get("source", _USER_REPORT_SOURCE),
        reward=ReportReward(
            report_count=report_count,
            coupon_issued=coupon_issued,
            next_reward_in=next_reward_in,
        ),
    )
