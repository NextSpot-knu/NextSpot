"""경주 날씨 공개 API — 기상청 단기예보, 실패 시 200 unavailable."""

from fastapi import APIRouter

from app.services.weather_service import get_gyeongju_weather

router = APIRouter(prefix="/api/v1", tags=["weather"])


@router.get("/weather")
async def weather():
    result = await get_gyeongju_weather()
    if result is None:
        return {"source": "unavailable", "current": None, "forecasts": [], "indoor_recommended": False}
    return result
