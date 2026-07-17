"""기상청 단기예보 어댑터 — 경주 황리단길 시간대별 날씨.

TourAPI에는 일반 지역 기상예보가 없으므로 공공데이터포털의 기상청 단기예보
(`getVilageFcst`)를 결합한다. 키 미설정·네트워크·응답 오류는 모두 None으로 폴백하며,
성공 30분/실패 5분 캐시로 관광객 요청마다 외부 API를 호출하지 않는다.
"""

import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
import structlog

from app.core.config import settings

logger = structlog.get_logger()

_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst"
_KST = timezone(timedelta(hours=9))
# 황리단길(35.8361, 129.2105)의 기상청 Lambert 격자.
_GYEONGJU_NX = 100
_GYEONGJU_NY = 91
_BASE_HOURS = (2, 5, 8, 11, 14, 17, 20, 23)
_TTL_OK = 1800.0
_TTL_FAIL = 300.0
_cache: Optional[tuple[float, float, Optional[dict]]] = None


def _latest_base(now: datetime) -> tuple[str, str]:
    """발표 후 API 반영 여유 10분을 둔 최신 단기예보 발표시각을 구한다."""
    ready = now.astimezone(_KST) - timedelta(minutes=10)
    candidates = [h for h in _BASE_HOURS if h <= ready.hour]
    if candidates:
        base = ready.replace(hour=max(candidates), minute=0, second=0, microsecond=0)
    else:
        yesterday = ready - timedelta(days=1)
        base = yesterday.replace(hour=23, minute=0, second=0, microsecond=0)
    return base.strftime("%Y%m%d"), base.strftime("%H%M")


def _parse(payload: dict, now: datetime) -> Optional[dict]:
    header = payload.get("response", {}).get("header", {})
    if str(header.get("resultCode")) != "00":
        return None
    items = payload.get("response", {}).get("body", {}).get("items", {}).get("item", [])
    grouped: dict[tuple[str, str], dict[str, str]] = {}
    for item in items:
        date = str(item.get("fcstDate") or "")
        clock = str(item.get("fcstTime") or "").zfill(4)
        category = str(item.get("category") or "")
        if date and clock and category:
            grouped.setdefault((date, clock), {})[category] = str(item.get("fcstValue") or "")

    now_kst = now.astimezone(_KST)
    forecasts = []
    for (date, clock), values in sorted(grouped.items()):
        try:
            at = datetime.strptime(date + clock, "%Y%m%d%H%M").replace(tzinfo=_KST)
        except ValueError:
            continue
        if at < now_kst - timedelta(minutes=30) or at > now_kst + timedelta(hours=24):
            continue
        try:
            temperature = float(values["TMP"])
        except (KeyError, TypeError, ValueError):
            continue
        forecasts.append({
            "at": at.isoformat(),
            "temperature_c": temperature,
            "sky": int(values.get("SKY", "1")),
            "precipitation_type": int(values.get("PTY", "0")),
            "precipitation_probability": int(values.get("POP", "0")),
            "wind_speed_mps": float(values.get("WSD", "0")),
        })
    if not forecasts:
        return None
    current = min(forecasts, key=lambda row: abs(datetime.fromisoformat(row["at"]) - now_kst))
    severe = current["precipitation_type"] > 0 or current["precipitation_probability"] >= 60
    if current["temperature_c"] >= 33 or current["temperature_c"] <= -5 or current["wind_speed_mps"] >= 9:
        severe = True
    return {"source": "kma", "current": current, "forecasts": forecasts, "indoor_recommended": severe}


async def get_gyeongju_weather(now: datetime | None = None) -> Optional[dict]:
    global _cache
    current_time = now or datetime.now(_KST)
    mono = time.monotonic()
    if _cache and mono - _cache[0] < _cache[1]:
        return _cache[2]
    if not settings.KMA_API_KEY:
        _cache = (mono, _TTL_FAIL, None)
        return None
    base_date, base_time = _latest_base(current_time)
    params = {
        "serviceKey": settings.KMA_API_KEY,
        "pageNo": 1,
        "numOfRows": 1000,
        "dataType": "JSON",
        "base_date": base_date,
        "base_time": base_time,
        "nx": _GYEONGJU_NX,
        "ny": _GYEONGJU_NY,
    }
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(_URL, params=params)
            response.raise_for_status()
            result = _parse(response.json(), current_time)
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        logger.warning("kma_weather_fetch_failed", error=str(exc))
        result = None
    _cache = (mono, _TTL_OK if result else _TTL_FAIL, result)
    return result


def clear_weather_cache() -> None:
    global _cache
    _cache = None
