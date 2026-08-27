"""지역 수요 데이터의 실제 사용 가능 상태와 이력 전망을 공개한다.

추천 응답에 숫자를 지어내는 대신, 운영자가 경주 주차 시설/실시간 데이터가 들어오는지
한 번의 요청으로 확인할 수 있다. 인증키와 외부 API 원문은 반환하지 않는다.
"""

from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.core.authz import ROLE_ADMIN, require_machine_or_role
from app.services.area_demand_snapshot_service import (
    SnapshotPersistenceError,
    collect_area_demand_snapshot,
)
from app.services.area_demand_forecast_service import get_historical_area_demand_forecast
from app.services.parking_demand_service import (
    ParkingUpstreamError,
    get_nearby_parking_lots,
    get_parking_coverage_status,
)

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


class AreaDemandForecastResponse(BaseModel):
    kind: Literal["surrounding_area_demand_forecast"] = "surrounding_area_demand_forecast"
    venue_congestion: Literal[False] = False
    available: bool
    forecast: dict[str, Any] | None = None


class ParkingLotItem(BaseModel):
    id: str
    name: str
    latitude: float
    longitude: float
    distance_m: int
    total_spaces: int | None = None
    available_spaces: int | None = None
    occupancy: float | None = None
    live: bool
    observed_at: str | None = None
    source: str | None = None


class ParkingLotsResponse(BaseModel):
    available: bool
    state: str
    source: str | None = None
    radius_m: int
    observed_at: str | None = None
    lots: list[ParkingLotItem]


@router.get("/status", response_model=AreaDemandStatusResponse)
async def area_demand_status(
    lat: float = Query(35.8361, ge=33.0, le=39.0),
    lng: float = Query(129.2105, ge=124.0, le=132.0),
) -> AreaDemandStatusResponse:
    """지정 지점 2km 안의 경주 실시간 주차 데이터 커버리지를 반환한다."""
    parking = await get_parking_coverage_status(lat, lng)
    return AreaDemandStatusResponse(parking=ParkingCoverage(**parking))


@router.get("/parking-lots", response_model=ParkingLotsResponse)
async def parking_lots(
    lat: float = Query(35.8361, ge=33.0, le=39.0),
    lng: float = Query(129.2105, ge=124.0, le=132.0),
    radius_m: int = Query(3_000, ge=500, le=10_000),
) -> ParkingLotsResponse:
    """현재 위치 주변 공식 주차장과 실제 잔여면을 반환한다."""
    result = await get_nearby_parking_lots(lat, lng, radius_m=float(radius_m))
    return ParkingLotsResponse(**result)


@router.get("/forecast", response_model=AreaDemandForecastResponse)
async def area_demand_forecast(
    arrival_at: datetime,
    lat: float = Query(..., ge=33.0, le=39.0),
    lng: float = Query(..., ge=124.0, le=132.0),
) -> AreaDemandForecastResponse:
    """앞으로 30분~6시간의 권역 주차 수요 전망을 반환한다.

    과거 동일 시간대 표본이 부족하면 ``available=false``이며 숫자를 만들지 않는다.
    """
    now = datetime.now(timezone.utc)
    if arrival_at.tzinfo is None:
        arrival_at = arrival_at.replace(tzinfo=timezone.utc)
    arrival_at = arrival_at.astimezone(timezone.utc)
    if arrival_at < now + timedelta(minutes=30) or arrival_at > now + timedelta(hours=6):
        raise HTTPException(status_code=422, detail="arrival_at must be 30 minutes to 6 hours ahead")
    forecast = await get_historical_area_demand_forecast(lat, lng, arrival_at, now=now)
    return AreaDemandForecastResponse(available=forecast is not None, forecast=forecast)


@router.post(
    "/snapshots/collect",
    response_model=SnapshotCollectionResponse,
    # 이 경로의 주 호출자는 **사람이 아니다** — GitHub Actions 스케줄러와 Supabase pg_cron 이
    # 10분마다 두드린다. 세션을 가질 수 없으므로 서비스 토큰을 함께 받는다.
    # (RBAC 전환 때 require_role 만 남겨 수집이 401 로 조용히 죽었던 자리다.)
    dependencies=[Depends(require_machine_or_role(ROLE_ADMIN))],
)
async def collect_snapshot() -> SnapshotCollectionResponse:
    """경주시 ITS 현재값을 조회해 10분 시계열로 한 번 저장한다."""
    try:
        snapshot = await collect_area_demand_snapshot()
    except ParkingUpstreamError as exc:
        raise HTTPException(status_code=503, detail=exc.code) from exc
    except SnapshotPersistenceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return SnapshotCollectionResponse(**snapshot)
