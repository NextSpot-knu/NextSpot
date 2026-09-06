"""관리자용 지역 수요 수집 신뢰도 API."""

from typing import Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.authz import ROLE_ADMIN, require_machine_or_role, require_role
from app.services.area_demand_reliability_service import (
    AreaDemandReliabilityError,
    get_area_demand_reliability,
)
from app.services.area_demand_forecast_service import get_area_demand_forecast_quality

logger = structlog.get_logger()
# 가드를 라우터가 아니라 **엔드포인트마다** 건다.
# 수집 신뢰도는 사람(관리자 화면)과 기계(경보 스케줄러)가 함께 두드리기 때문이다.
# 라우터에 한 번에 걸면 그 둘을 구분할 수 없어, 경보를 붙이려고 전체를 기계에 열게 된다.
router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


@router.get(
    "/area-demand-reliability",
    # 수집이 죽었다는 사실은 **사람이 안 보고 있을 때** 알아야 의미가 있다. 그래서 수집
    # 트리거(snapshots/collect)와 같은 기계 토큰을 받는다 — 경보 스케줄러가 이 값을 폴링한다.
    # 읽기 전용이고, 노출되는 것은 수집률·신선도·주차장 잔여면뿐이다(개인정보 없음).
    dependencies=[Depends(require_machine_or_role(ROLE_ADMIN))],
)
async def area_demand_reliability(
    hours: int = Query(24, ge=1, le=168),
    source: Literal["gyeongju_its", "national_parking_api"] = "gyeongju_its",
):
    """최근 완료 버킷의 실측 수집률·누락·최신 주차장 원본을 반환한다."""
    try:
        return await get_area_demand_reliability(source=source, hours=hours)
    except AreaDemandReliabilityError as exc:
        logger.error("admin_area_demand_reliability_failed", source=source, error=str(exc))
        raise HTTPException(
            status_code=503,
            detail="area_demand_reliability_unavailable",
        ) from exc


@router.get(
    "/area-demand-forecast-quality",
    # 이쪽은 사람 전용 그대로 둔다 — 경보에 쓰지 않으므로 기계에 열 이유가 없다.
    dependencies=[Depends(require_role(ROLE_ADMIN))],
)
async def area_demand_forecast_quality(
    lat: float = Query(35.8361, ge=33.0, le=39.0),
    lng: float = Query(129.2105, ge=124.0, le=132.0),
):
    """권역별 시간 순서 홀드아웃 MAE와 사용자 노출 가능 여부를 반환한다."""
    try:
        return await get_area_demand_forecast_quality(lat, lng)
    except Exception as exc:
        logger.error("admin_area_demand_forecast_quality_failed", error=str(exc))
        raise HTTPException(
            status_code=503,
            detail="area_demand_forecast_quality_unavailable",
        ) from exc
