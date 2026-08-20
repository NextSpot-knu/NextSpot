"""관리자용 지역 수요 수집 신뢰도 API."""

from typing import Literal

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.supabase import require_admin
from app.services.area_demand_reliability_service import (
    AreaDemandReliabilityError,
    get_area_demand_reliability,
)

logger = structlog.get_logger()
router = APIRouter(
    prefix="/api/v1/admin",
    tags=["admin"],
    dependencies=[Depends(require_admin)],
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
