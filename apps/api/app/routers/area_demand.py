"""지역 수요 데이터의 실제 사용 가능 상태를 공개한다.

추천 응답에 숫자를 지어내는 대신, 운영자가 경주 주차 시설/실시간 데이터가 들어오는지
한 번의 요청으로 확인할 수 있다. 인증키와 외부 API 원문은 반환하지 않는다.
"""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.supabase import require_admin
from app.services.area_demand_snapshot_service import (
    SnapshotPersistenceError,
    collect_area_demand_snapshot,
)
from app.services.parking_demand_service import ParkingUpstreamError, get_parking_coverage_status

router = APIRouter(prefix="/api/v1/area-demand", tags=["area-demand"])


class ParkingCoverage(BaseModel):
    configured: bool
    national_api_configured: bool
    source: Literal["gyeongju_its", "national_parking_api"] | None = None
    state: Literal[
        "not_configured",
        "checking",
        "available",
        "upstream_unavailable",
        "no_gyeongju_facilities",
        "no_gyeongju_realtime",
        "no_nearby_realtime",
    ]
    available: bool
    gyeongju_facility_count: int
    gyeongju_realtime_count: int
    nearby_realtime_count: int
    total_spaces: int | None = None
    available_spaces: int | None = None
    facility_checked_at: str | None = None
    realtime_checked_at: str | None = None
    facility_error_code: str | None = None
    realtime_error_code: str | None = None


class AreaDemandStatusResponse(BaseModel):
    kind: Literal["surrounding_area_demand"] = "surrounding_area_demand"
    venue_congestion: Literal[False] = False
    parking: ParkingCoverage


class SnapshotCollectionResponse(BaseModel):
    state: Literal["collected"] = "collected"
    snapshot_id: str
    source: Literal["gyeongju_its", "national_parking_api"]
    observed_at: str
    bucket_at: str
    total_spaces: int
    available_spaces: int
    live_lot_count: int
    stored: bool


@router.get("/status", response_model=AreaDemandStatusResponse)
async def area_demand_status(
    lat: float = Query(35.8361, ge=33.0, le=39.0),
    lng: float = Query(129.2105, ge=124.0, le=132.0),
) -> AreaDemandStatusResponse:
    """지정 지점 2km 안의 경주 실시간 주차 데이터 커버리지를 반환한다."""
    parking = await get_parking_coverage_status(lat, lng)
    return AreaDemandStatusResponse(parking=ParkingCoverage(**parking))


@router.post(
    "/snapshots/collect",
    response_model=SnapshotCollectionResponse,
    dependencies=[Depends(require_admin)],
)
async def collect_snapshot() -> SnapshotCollectionResponse:
    """경주시 ITS 현재값을 조회해 15분 시계열로 한 번 저장한다."""
    try:
        snapshot = await collect_area_demand_snapshot()
    except ParkingUpstreamError as exc:
        raise HTTPException(status_code=503, detail=exc.code) from exc
    except SnapshotPersistenceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return SnapshotCollectionResponse(**snapshot)
