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


def _normalize_place_name(value: object) -> str:
    """TourAPI가 문화유산명 앞에 붙이는 지역명(경주/경주시)을 비교에서 제거한다."""
    return re.sub(r"^경주시?", "", _normalize(value))


def _road_key(address: object) -> str:
    text = str(address or "")
    match = re.search(r"([가-힣A-Za-z0-9·.-]+(?:로|길)\s*\d+(?:-\d+)?)", text)
    return _normalize(match.group(1) if match else text)


def _is_gyeongju_address(address: object) -> bool:
    normalized = _normalize(address)
    return "경주시" in normalized or "경주" in normalized


def choose_kakao_match(row: dict, documents: list[dict]) -> dict | None:
    """경주시 안의 유일한 동명 장소이거나 주소/근접성이 확인된 후보만 선택한다."""
    name = _normalize_place_name(row.get("name"))
    road = _road_key(row.get("address"))
    scored: list[tuple[int, float, dict]] = []
    for doc in documents:
        doc_name = _normalize_place_name(doc.get("place_name"))
        doc_address = doc.get("road_address_name") or doc.get("address_name")
        if not _is_gyeongju_address(doc_address):
            continue
        if not name or not doc_name or not (name == doc_name or name in doc_name or doc_name in name):
            continue
        try:
            lat, lng = float(doc["y"]), float(doc["x"])
            distance = calculate_haversine_distance(row["latitude"], row["longitude"], lat, lng)
        except (KeyError, TypeError, ValueError):
            continue
        doc_road = _road_key(doc_address)
        address_match = bool(road and doc_road and (road in doc_road or doc_road in road))
        exact_name = name == doc_name
        if not exact_name and not address_match and distance > 150:
            continue
        score = (8 if exact_name else 2) + (4 if address_match else 0)
        scored.append((score, distance, doc))
    if not scored:
        return None
    scored.sort(key=lambda item: (-item[0], item[1]))
    # 같은 근거 점수의 후보가 둘 이상이면 기존 좌표와의 거리로 추정하지 않는다.
    # 기존 좌표 자체가 오염됐을 수 있으므로 사람 검토 대상으로 남기는 fail-closed 정책이다.
    if len(scored) > 1 and scored[0][0] == scored[1][0]:
        return None
    return scored[0][2]


async def reconcile_row_coordinate(row: dict) -> bool:
    """확실한 Kakao 후보가 있으면 row 좌표/features를 제자리 수정한다."""
    if not settings.KAKAO_REST_API_KEY:
        return False
    try:
        async with _semaphore, httpx.AsyncClient(timeout=5.0) as client:
            headers = {"Authorization": f"KakaoAK {settings.KAKAO_REST_API_KEY}"}
            nearby_params = {
                "query": row["name"], "x": row["longitude"], "y": row["latitude"],
                "radius": 2000, "size": 10, "sort": "distance",
            }
            # 기존 좌표가 크게 틀린 장소도 찾도록 경주 한정 전역 검색을 함께 수행한다.
            responses = await asyncio.gather(
                client.get(_URL, params=nearby_params, headers=headers),
                client.get(_URL, params={"query": f"경주 {row['name']}", "size": 15}, headers=headers),
            )
            documents: list[dict] = []
            seen: set[str] = set()
            for response in responses:
                response.raise_for_status()
                for doc in response.json().get("documents", []):
                    identity = str(doc.get("id") or f"{doc.get('x')}:{doc.get('y')}")
                    if identity not in seen:
                        seen.add(identity)
                        documents.append(doc)
            match = choose_kakao_match(row, documents)
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
