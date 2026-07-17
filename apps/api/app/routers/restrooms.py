"""현재 위치 기준 인근 공중화장실 공개 조회."""

from fastapi import APIRouter, Query

from app.services.restroom_service import find_nearby_restrooms

router = APIRouter(prefix="/api/v1", tags=["restrooms"])


@router.get("/restrooms")
async def restrooms(
    lat: float = Query(35.8361, ge=-90, le=90),
    lng: float = Query(129.2105, ge=-180, le=180),
    radius_m: int = Query(3000, ge=100, le=5000),
):
    items = await find_nearby_restrooms(lat, lng, radius_m)
    return {"source": "kakao" if items else "unavailable", "restrooms": items}
