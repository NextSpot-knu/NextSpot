"""TourAPI POI를 Kakao 장소 좌표에 보수적으로 정합한다."""

import asyncio
import re

import httpx

from app.core.config import settings
from app.services.spot.travel import calculate_haversine_distance

_URL = "https://dapi.kakao.com/v2/local/search/keyword.json"
_semaphore = asyncio.Semaphore(5)


def _normalize(value: object) -> str:
    return re.sub(r"[^0-9a-z가-힣]", "", str(value or "").lower())


def _road_key(address: object) -> str:
    text = str(address or "")
    match = re.search(r"([가-힣A-Za-z0-9·.-]+(?:로|길)\s*\d+(?:-\d+)?)", text)
    return _normalize(match.group(1) if match else text)


def choose_kakao_match(row: dict, documents: list[dict]) -> dict | None:
    """이름이 일치하고 주소 또는 150m 근접성이 확인되는 유일한 최상 후보만 선택한다."""
    name = _normalize(row.get("name"))
    road = _road_key(row.get("address"))
    scored: list[tuple[int, float, dict]] = []
    for doc in documents:
        doc_name = _normalize(doc.get("place_name"))
        if not name or not doc_name or not (name == doc_name or name in doc_name or doc_name in name):
            continue
        try:
            lat, lng = float(doc["y"]), float(doc["x"])
            distance = calculate_haversine_distance(row["latitude"], row["longitude"], lat, lng)
        except (KeyError, TypeError, ValueError):
            continue
        doc_road = _road_key(doc.get("road_address_name") or doc.get("address_name"))
        address_match = bool(road and doc_road and (road in doc_road or doc_road in road))
        if not address_match and distance > 150:
            continue
        score = (4 if name == doc_name else 2) + (4 if address_match else 0)
        scored.append((score, distance, doc))
    if not scored:
        return None
    scored.sort(key=lambda item: (-item[0], item[1]))
    if len(scored) > 1 and scored[0][0] == scored[1][0] and abs(scored[0][1] - scored[1][1]) < 30:
        return None
    return scored[0][2]


async def reconcile_row_coordinate(row: dict) -> bool:
    """확실한 Kakao 후보가 있으면 row 좌표/features를 제자리 수정한다."""
    if not settings.KAKAO_REST_API_KEY:
        return False
    params = {
        "query": row["name"], "x": row["longitude"], "y": row["latitude"],
        "radius": 2000, "size": 5, "sort": "distance",
    }
    try:
        async with _semaphore, httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(
                _URL, params=params,
                headers={"Authorization": f"KakaoAK {settings.KAKAO_REST_API_KEY}"},
            )
            response.raise_for_status()
            match = choose_kakao_match(row, response.json().get("documents", []))
    except (httpx.HTTPError, ValueError, TypeError):
        return False
    if not match:
        return False
    old_lat, old_lng = float(row["latitude"]), float(row["longitude"])
    new_lat, new_lng = float(match["y"]), float(match["x"])
    features = dict(row.get("features") or {})
    features.setdefault("tourapi_coordinates", {"latitude": old_lat, "longitude": old_lng})
    features.update({
        "coordinate_source": "kakao",
        "kakao_place_id": str(match.get("id") or ""),
        "kakao_place_url": str(match.get("place_url") or ""),
    })
    row.update({"latitude": new_lat, "longitude": new_lng, "features": features})
    return True
