"""경주 시설명 검색용 Kakao Local 게이트웨이."""

from __future__ import annotations

import asyncio
import re
from typing import Any

import httpx

from app.core.config import settings
from app.services.spot.travel import calculate_haversine_distance

_URL = "https://dapi.kakao.com/v2/local/search/keyword.json"
_CENTER_LAT = 35.8361
_CENTER_LNG = 129.2105
_MAX_DISTANCE_M = 8_000.0
_TYPE_BY_GROUP = {"CE7": "cafe", "FD6": "restaurant"}

# 검색어를 장소명으로만 취급하지 않는다. Kakao Local이 메뉴/업종에 붙인 실제 검색
# 인덱스를 재조회하기 위한 제한된 동의어이며, 이 값을 시설의 "대표 메뉴"로 저장하지는 않는다.
# 너무 넓은 우산어(예: 음식, 맛집)는 무관한 결과를 늘리므로 의도가 명확한 표현만 둔다.
_QUERY_EXPANSIONS: dict[str, tuple[str, ...]] = {
    "아메리카노": ("커피",),
    "라떼": ("카페라떼",),
    "돼지고기": ("삼겹살", "돼지갈비"),
    "돼지 고기": ("삼겹살", "돼지갈비"),
    "구이": ("고깃집", "숯불구이"),
    "고기": ("고깃집", "삼겹살"),
}
_EXACT_TOKEN_EXPANSION_KEYS = {"고기", "구이"}


def expand_place_search_queries(query: str) -> list[str]:
    """원문 우선 + 검토된 메뉴/업종 동의어(최대 3개)를 반환한다."""
    normalized = " ".join(query.strip().lower().split())
    tokens = set(re.findall(r"[0-9a-z가-힣]+", normalized))
    queries = [query.strip()]
    for key, expansions in _QUERY_EXPANSIONS.items():
        matches = key in tokens if key in _EXACT_TOKEN_EXPANSION_KEYS else key in normalized
        if matches:
            queries.extend(expansions)
            break
    return list(dict.fromkeys(q for q in queries if q))[:3]


def normalize_place_documents(documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Kakao의 이름·주소·좌표를 같은 레코드에서만 묶어 반환한다."""
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for document in documents:
        group_code = str(document.get("category_group_code") or "")
        if group_code not in _TYPE_BY_GROUP:
            continue
        place_id = str(document.get("id") or "").strip()
        name = str(document.get("place_name") or "").strip()
        address = str(
            document.get("road_address_name") or document.get("address_name") or ""
        ).strip()
        if not place_id or place_id in seen or not name or "경주" not in address:
            continue
        try:
            latitude = float(document["y"])
            longitude = float(document["x"])
        except (KeyError, TypeError, ValueError):
            continue
        if calculate_haversine_distance(
            _CENTER_LAT, _CENTER_LNG, latitude, longitude
        ) > _MAX_DISTANCE_M:
            continue
        seen.add(place_id)
        rows.append({
            "place_id": place_id,
            "name": name,
            "type": _TYPE_BY_GROUP[group_code],
            "latitude": latitude,
            "longitude": longitude,
            "address": address,
            "phone": str(document.get("phone") or "").strip() or None,
            "place_url": str(document.get("place_url") or "").strip() or None,
            "category_name": str(document.get("category_name") or "").strip() or None,
        })
    return rows


async def search_kakao_places(query: str) -> list[dict[str, Any]]:
    key = settings.KAKAO_REST_API_KEY.strip()
    if not key:
        return []
    async with httpx.AsyncClient(timeout=4.0) as client:
        async def _search(term: str) -> list[dict[str, Any]]:
            response = await client.get(
                _URL,
                params={
                    "query": term,
                    "x": _CENTER_LNG,
                    "y": _CENTER_LAT,
                    "radius": 8_000,
                    "size": 15,
                    "sort": "accuracy",
                },
                headers={"Authorization": f"KakaoAK {key}", "User-Agent": "NextSpot/1.0"},
            )
            response.raise_for_status()
            return normalize_place_documents(response.json().get("documents") or [])

        results = await asyncio.gather(
            *(_search(term) for term in expand_place_search_queries(query)),
            return_exceptions=True,
        )
        # 동의어 보충 요청 하나의 장애가 성공한 원문 검색까지 지우지 않게 격리한다.
        batches = [result for result in results if not isinstance(result, BaseException)]

    # 원문 결과를 항상 먼저 유지하고 동의어 결과는 Kakao place_id 기준으로만 보충한다.
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for batch in batches:
        for item in batch:
            place_id = item["place_id"]
            if place_id in seen:
                continue
            seen.add(place_id)
            merged.append(item)
    return merged[:10]
