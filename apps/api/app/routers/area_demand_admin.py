"""관리자용 지역 수요 수집 신뢰도 API."""

from typing import Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.authz import ROLE_ADMIN, require_role
from app.services.area_demand_reliability_service import (
    AreaDemandReliabilityError,
    get_area_demand_reliability,
)
from app.services.area_demand_forecast_service import get_area_demand_forecast_quality

logger = structlog.get_logger()
router = APIRouter(
    prefix="/api/v1/admin",
    tags=["admin"],
    dependencies=[Depends(require_role(ROLE_ADMIN))],
)


@router.get("/area-demand-reliability")
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


@router.get("/area-demand-forecast-quality")
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
