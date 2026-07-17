"""인근 공중화장실 좌표 검색.

행정안전부 전국 공중화장실 API는 2025-02부터 위경도 제공을 중단했으므로 거리순 지도 기능에는
바로 쓸 수 없다. 프로젝트의 기존 Kakao REST 앱 키로 장소 키워드 검색을 사용하며, 결과를
경주 중심 5km 이내로 제한한다. 키/네트워크 장애는 빈 목록으로 무해 폴백한다.
"""

import math

import httpx
import structlog

from app.core.config import settings

logger = structlog.get_logger()
_URL = "https://dapi.kakao.com/v2/local/search/keyword.json"


def _distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> int:
    radius = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return round(radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a)))


# Kakao 는 공중화장실을 '화장실' 명칭 + '가정,생활 > 화장실' 카테고리로 등록한다.
# '공중화장실' 키워드는 황리단길 실측 1건(그마저 월정교 문화유적 오탐)뿐이라 '화장실'로 검색하고,
# 키워드 노이즈(월정교류)는 카테고리 문자열로 걸러낸다(2026-07-18 실측: 3km 내 12건+).
_QUERY = "화장실"
_CATEGORY_TOKEN = "화장실"
_MAX_PAGES = 3  # 페이지당 15건 — 관광지 코어에서 첫 페이지가 가득 차므로 최대 45건까지 수집


async def find_nearby_restrooms(lat: float, lng: float, radius_m: int = 3000) -> list[dict]:
    if not settings.KAKAO_REST_API_KEY:
        return []
    documents: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            for page in range(1, _MAX_PAGES + 1):
                params = {
                    "query": _QUERY, "x": lng, "y": lat, "radius": radius_m,
                    "size": 15, "page": page, "sort": "distance",
                }
                response = await client.get(
                    _URL, params=params, headers={"Authorization": f"KakaoAK {settings.KAKAO_REST_API_KEY}"}
                )
                response.raise_for_status()
                data = response.json()
                documents.extend(data.get("documents", []))
                if data.get("meta", {}).get("is_end", True):
                    break
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        logger.warning("restroom_search_failed", error=str(exc), collected=len(documents))
        if not documents:
            return []
    results = []
    seen_ids: set[str] = set()
    for item in documents:
        # 키워드 매칭 노이즈 차단: 카테고리에 '화장실'이 없는 장소(문화유적 등)는 제외.
        if _CATEGORY_TOKEN not in str(item.get("category_name") or ""):
            continue
        item_id = str(item.get("id") or "")
        if item_id and item_id in seen_ids:
            continue
        if item_id:
            seen_ids.add(item_id)
        try:
            item_lat, item_lng = float(item["y"]), float(item["x"])
        except (KeyError, TypeError, ValueError):
            continue
        distance = _distance_m(lat, lng, item_lat, item_lng)
        if distance > radius_m:
            continue
        results.append({
            "id": str(item.get("id") or f"{item_lat},{item_lng}"),
            "name": str(item.get("place_name") or "공중화장실"),
            "address": str(item.get("road_address_name") or item.get("address_name") or ""),
            "latitude": item_lat,
            "longitude": item_lng,
            "distance_m": distance,
            "place_url": str(item.get("place_url") or ""),
        })
    return sorted(results, key=lambda row: row["distance_m"])
