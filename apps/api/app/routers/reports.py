"""혼잡 제보(크라우드소싱) 라우터.

관광객이 '지금 이곳이 얼마나 붐비는지'를 직접 제보하는 엔드포인트.

보안 배경(20260707120000_security_hardening.sql + init RLS):
  congestion_logs 는 service_role 만 INSERT 할 수 있도록 잠겨 있다(anon/authenticated 직접
  쓰기 거부). 따라서 클라이언트가 Supabase 로 직접 insert 하지 못하고, 반드시 이 백엔드
  엔드포인트를 거쳐 supabase_admin(service_role) 으로 기록해야 한다. 신뢰 경계는
  get_current_user(로그인 필수)로 강제한다 — 익명 대량 조작을 1차 차단.

주의(레이트리밋): 본 엔드포인트는 인증만 강제하고 사용자별 제보 빈도 제한은 범위 밖이다.
  운영 배포 시에는 사용자·시설당 쿨다운(예: 5분) 또는 Redis 토큰버킷으로 스팸/조작을
  막는 레이트리밋을 추가해야 한다(현재는 데모 신뢰 경계만 확보).
"""
import asyncio
from datetime import datetime, timezone
from typing import Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

# congestion_logs 쓰기는 RLS 우회가 필요해 service_role(supabase_admin) 을 쓴다
# (infrastructures.simulate_peak / recommendations 와 동일 사유 — anon INSERT 는 RLS 로 거부됨).
from app.core.supabase import supabase_admin, get_current_user

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1", tags=["reports"])

# 3단계 체감 혼잡도(한산/보통/혼잡) → 0~1 추정치 매핑.
# 프런트 3지선다 버튼과 정합. 소수 라벨은 UX 부담이 커 이산 3구간으로 단순화한다.
_LEVEL_ENUM = {"한산": 0.2, "보통": 0.55, "혼잡": 0.9}

# congestion_logs.source CHECK 제약은 ('traffic_cctv','tour_api','event','user_report') 만 허용한다.
# 사용자 제보는 'user_report' 로 기록한다(스키마 제약을 만족하는 정식 값).
_USER_REPORT_SOURCE = "user_report"


class CongestionReportRequest(BaseModel):
    facility_id: str
    # level 은 0~1 연속 추정치 또는 한산/보통/혼잡 라벨 중 하나를 받는다.
    # (프런트는 라벨을 보내고, 다른 클라이언트가 수치를 보내도 검증되게 union 으로 수용.)
    level: float | Literal["한산", "보통", "혼잡"] = Field(
        ..., description="0~1 혼잡 추정치 또는 한산/보통/혼잡"
    )


class CongestionReportResponse(BaseModel):
    success: bool
    facility_id: str
    congestion_level: float
    current_count: int
    timestamp: str
    source: str


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

    # 1. 시설 존재 검증 (없는 facility_id 로의 FK 위반/유령 로그 방지)
    fac_res = await asyncio.to_thread(
        supabase_admin.table("facilities")
        .select("id, capacity")
        .eq("id", req.facility_id)
        .limit(1)
        .execute
    )
    if not fac_res.data:
        raise HTTPException(status_code=404, detail="시설 정보를 찾을 수 없습니다.")

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

    inserted = (ins.data or [{}])[0]
    logger.info("congestion_report_saved", facility_id=req.facility_id, level=level)

    return CongestionReportResponse(
        success=True,
        facility_id=req.facility_id,
        congestion_level=inserted.get("congestion_level", level),
        current_count=inserted.get("current_count", current_count),
        timestamp=inserted.get("timestamp", now_str),
        source=inserted.get("source", _USER_REPORT_SOURCE),
    )
