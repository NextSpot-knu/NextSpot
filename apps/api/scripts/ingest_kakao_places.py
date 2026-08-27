"""Kakao Local 검색으로 TourAPI 누락 카페·식당을 보완한다.

검색 결과를 전부 넣지 않는다. 경주 중심 6km 안에서 각 의도 검색의 상위 15위 또는 서로 다른
검색어 두 개 이상에 반복 등장한 장소만 후보로 승격한다. 평점·혼잡·좌석은 제공되지 않으므로
만들지 않고, 운영시간은 장소 상세 링크에서 사용자가 확인하게 둔다.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.core.config import settings  # noqa: E402
from app.core.supabase import fetch_all_rows, supabase_admin  # noqa: E402
from app.services.spot.travel import calculate_haversine_distance  # noqa: E402

CENTER_LAT = 35.8361
CENTER_LNG = 129.2105
RADIUS_M = 6_000
MAX_PAGES = 3
PAGE_SIZE = 15
GRID_STEP_M = 1_350
GRID_RADIUS_M = 1_100
GRID_AXIS = range(-4, 5)
QUERIES: tuple[tuple[str, str], ...] = (
    ("경주 카페", "cafe"),
    ("황리단길 카페", "cafe"),
    ("경주 한옥 카페", "cafe"),
    ("경주 베이커리 카페", "cafe"),
    ("경주 맛집", "restaurant"),
    ("황리단길 맛집", "restaurant"),
    ("경주 현지인 맛집", "restaurant"),
    ("경주 한식 맛집", "restaurant"),
)
EXPECTED_GROUP = {"cafe": "CE7", "restaurant": "FD6"}
EXCLUDED_CATEGORY_TERMS = ("구내식당", "장례식장")


def _normalize(value: Any) -> str:
    return "".join(str(value or "").split()).casefold()


def _existing_key(row: dict[str, Any]) -> tuple[str, str]:
    return _normalize(row.get("name")), _normalize(row.get("address"))


async def _search(client: httpx.AsyncClient, query: str, facility_type: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for page in range(1, MAX_PAGES + 1):
        response = await client.get(
            "https://dapi.kakao.com/v2/local/search/keyword.json",
            params={
                "query": query,
                "x": CENTER_LNG,
                "y": CENTER_LAT,
                "radius": RADIUS_M,
                "page": page,
                "size": PAGE_SIZE,
                "sort": "accuracy",
            },
        )
        response.raise_for_status()
        payload = response.json()
        documents = payload.get("documents") or []
        for offset, document in enumerate(documents):
            if not isinstance(document, dict):
                continue
            document = dict(document)
            document["discovery_query"] = query
            document["discovery_type"] = facility_type
            document["discovery_rank"] = (page - 1) * PAGE_SIZE + offset + 1
            rows.append(document)
        if payload.get("meta", {}).get("is_end", True):
            break
    return rows


def _grid_points() -> list[tuple[float, float]]:
    """중심 6km를 겹치는 9x9 격자로 덮는다."""
    return [
        (
            CENTER_LAT + north * GRID_STEP_M / 111_000.0,
            CENTER_LNG + east * GRID_STEP_M / 90_000.0,
        )
        for north in GRID_AXIS
        for east in GRID_AXIS
    ]


async def _category_search(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    latitude: float,
    longitude: float,
    facility_type: str,
) -> list[dict[str, Any]]:
    """키워드 순위 밖 작은 점포까지 Kakao 업종 분류로 찾는다."""
    rows: list[dict[str, Any]] = []
    async with semaphore:
        for page in range(1, MAX_PAGES + 1):
            response = await client.get(
                "https://dapi.kakao.com/v2/local/search/category.json",
                params={
                    "category_group_code": EXPECTED_GROUP[facility_type],
                    "x": longitude,
                    "y": latitude,
                    "radius": GRID_RADIUS_M,
                    "page": page,
                    "size": PAGE_SIZE,
                    "sort": "distance",
                },
            )
            response.raise_for_status()
            payload = response.json()
            for offset, document in enumerate(payload.get("documents") or []):
                if not isinstance(document, dict):
                    continue
                document = dict(document)
                document["discovery_query"] = f"category_grid:{facility_type}"
                document["discovery_type"] = facility_type
                document["discovery_rank"] = (page - 1) * PAGE_SIZE + offset + 1
                document["category_grid"] = True
                rows.append(document)
            if payload.get("meta", {}).get("is_end", True):
                break
    return rows


def select_candidates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        place_id = str(row.get("id") or "").strip()
        address = str(row.get("road_address_name") or row.get("address_name") or "")
        if not place_id or "경주" not in address:
            continue
        facility_type = row.get("discovery_type")
        if facility_type not in EXPECTED_GROUP or row.get("category_group_code") != EXPECTED_GROUP[facility_type]:
            continue
        try:
            lat, lng = float(row["y"]), float(row["x"])
        except (KeyError, TypeError, ValueError):
            continue
        if calculate_haversine_distance(CENTER_LAT, CENTER_LNG, lat, lng) > RADIUS_M:
            continue
        grouped[place_id].append(row)

    selected: list[dict[str, Any]] = []
    for place_id, appearances in grouped.items():
        appearances.sort(key=lambda row: int(row["discovery_rank"]))
        queries = sorted({str(row["discovery_query"]) for row in appearances})
        best = appearances[0]
        best_rank = int(best["discovery_rank"])
        discovered_by_grid = any(bool(row.get("category_grid")) for row in appearances)
        if not discovered_by_grid and best_rank > 15 and len(queries) < 2:
            continue
        selected.append({
            "kakao_place_id": place_id,
            "name": str(best.get("place_name") or "").strip(),
            "type": best["discovery_type"],
            "latitude": float(best["y"]),
            "longitude": float(best["x"]),
            "address": str(best.get("road_address_name") or best.get("address_name") or "").strip(),
            "phone": str(best.get("phone") or "").strip() or None,
            "place_url": str(best.get("place_url") or "").strip() or None,
            "category_name": str(best.get("category_name") or "").strip(),
            "queries": queries,
            "best_rank": best_rank,
            "appearance_count": len(queries),
            "discovery_source": "category_grid" if discovered_by_grid else "keyword_relevance",
        })
    return sorted(selected, key=lambda row: (row["type"], row["best_rank"], row["name"]))


def _merge_features(existing: dict[str, Any] | None, candidate: dict[str, Any]) -> dict[str, Any]:
    features = dict((existing or {}).get("features") or {})
    category_tokens = [
        token.strip()
        for token in candidate["category_name"].split(">")
        if token.strip() not in {"음식점", "카페"}
    ]
    features.update({
        "source": features.get("source") or "kakao_discovery",
        "kakao_place_id": candidate["kakao_place_id"],
        "kakao_place_url": candidate["place_url"],
        "coordinate_source": features.get("coordinate_source") or "kakao",
        "discovery_queries": candidate["queries"],
        "discovery_best_rank": candidate["best_rank"],
        "discovery_appearance_count": candidate["appearance_count"],
        "discovery_source": candidate["discovery_source"],
        "kakao_category_name": candidate["category_name"],
        "discovery_updated_at": datetime.now(timezone.utc).isoformat(),
        "capacity_evidence": features.get("capacity_evidence") or "synthetic_type_default",
        "indoor": True,
        "indoor_evidence": features.get("indoor_evidence") or "fixed_food_establishment",
    })
    if not features.get("cuisine_tags") and category_tokens:
        features["cuisine_tags"] = category_tokens
    return features


async def run(*, apply: bool, report_path: Path) -> dict[str, Any]:
    key = settings.KAKAO_REST_API_KEY.strip()
    if not key:
        raise ValueError("KAKAO_REST_API_KEY가 필요합니다")
    headers = {"Authorization": f"KakaoAK {key}", "User-Agent": "NextSpot/1.0"}
    async with httpx.AsyncClient(timeout=15, headers=headers) as client:
        keyword_batches = await asyncio.gather(
            *[_search(client, query, kind) for query, kind in QUERIES]
        )
        semaphore = asyncio.Semaphore(8)
        category_batches = await asyncio.gather(*[
            _category_search(client, semaphore, latitude, longitude, facility_type)
            for latitude, longitude in _grid_points()
            for facility_type in EXPECTED_GROUP
        ])
    batches = [*keyword_batches, *category_batches]
    candidates = select_candidates([row for batch in batches for row in batch])

    select_columns = (
        "id,name,address,phone,type,latitude,longitude,capacity,is_active,features,"
        "kakao_place_id,contentid,overview,image_url,operating_hours"
    )
    supports_kakao_column = True
    try:
        existing = fetch_all_rows(supabase_admin, "facilities", select_columns)
    except Exception:
        # 별도 스키마 배포가 없어도 features.kakao_place_id로 재실행 중복을 막는다.
        supports_kakao_column = False
        existing = fetch_all_rows(
            supabase_admin,
            "facilities",
            "id,name,address,phone,type,latitude,longitude,capacity,is_active,features,"
            "contentid,overview,image_url,operating_hours",
        )
        for row in existing:
            row["kakao_place_id"] = None
    by_place_id = {
        str(row["kakao_place_id"]): row for row in existing if row.get("kakao_place_id")
    }
    by_feature_id = {
        str((row.get("features") or {}).get("kakao_place_id")): row
        for row in existing if (row.get("features") or {}).get("kakao_place_id")
    }
    by_name_address = {_existing_key(row): row for row in existing if row.get("address")}

    inserted = updated = 0
    insert_payloads: list[dict[str, Any]] = []
    update_payloads: list[dict[str, Any]] = []
    actions: list[dict[str, Any]] = []
    for candidate in candidates:
        existing_row = (
            by_place_id.get(candidate["kakao_place_id"])
            or by_feature_id.get(candidate["kakao_place_id"])
            or by_name_address.get((_normalize(candidate["name"]), _normalize(candidate["address"])))
        )
        action = {
            "status": "update" if existing_row else "insert",
            "existing_id": existing_row.get("id") if existing_row else None,
            **candidate,
        }
        actions.append(action)
        if not apply:
            continue
        if existing_row:
            eligible = not any(
                term in candidate["category_name"] for term in EXCLUDED_CATEGORY_TERMS
            )
            payload = {
                "latitude": candidate["latitude"],
                "longitude": candidate["longitude"],
                "features": _merge_features(existing_row, candidate),
                "is_active": eligible,
            }
            if supports_kakao_column:
                payload["kakao_place_id"] = candidate["kakao_place_id"]
            if not existing_row.get("address"):
                payload["address"] = candidate["address"]
            if not existing_row.get("phone") and candidate.get("phone"):
                payload["phone"] = candidate["phone"]
            update_row = {**existing_row, **payload}
            if not supports_kakao_column:
                update_row.pop("kakao_place_id", None)
            update_payloads.append(update_row)
        else:
            eligible = not any(
                term in candidate["category_name"] for term in EXCLUDED_CATEGORY_TERMS
            )
            insert_payload = {
                "name": candidate["name"],
                "type": candidate["type"],
                "latitude": candidate["latitude"],
                "longitude": candidate["longitude"],
                "capacity": 24 if candidate["type"] == "cafe" else 30,
                "operating_hours": {},
                "features": _merge_features(None, candidate),
                "address": candidate["address"],
                "phone": candidate["phone"],
                "is_active": eligible,
            }
            if supports_kakao_column:
                insert_payload["kakao_place_id"] = candidate["kakao_place_id"]
            insert_payloads.append(insert_payload)

    if apply:
        for offset in range(0, len(update_payloads), 100):
            batch = update_payloads[offset:offset + 100]
            supabase_admin.table("facilities").upsert(batch, on_conflict="id").execute()
            updated += len(batch)
        for offset in range(0, len(insert_payloads), 100):
            batch = insert_payloads[offset:offset + 100]
            supabase_admin.table("facilities").insert(batch).execute()
            inserted += len(batch)

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "apply": apply,
        "identity_storage": "column_and_features" if supports_kakao_column else "features",
        "raw_count": sum(map(len, batches)),
        "selected_count": len(candidates),
        "new_count": sum(action["status"] == "insert" for action in actions),
        "matched_count": sum(action["status"] == "update" for action in actions),
        "inserted": inserted,
        "updated": updated,
        "terarosa_gyeongju_present": any(
            candidate["kakao_place_id"] == "1526605585" for candidate in candidates
        ),
        "actions": actions,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


# 기존 도구/테스트가 쓰는 작은 호환 헬퍼. 실제 수집의 정본은 select_candidates/run이다.
def split_rect(rect: tuple[float, float, float, float]) -> list[tuple[float, float, float, float]]:
    west, south, east, north = rect
    mid_x, mid_y = (west + east) / 2, (south + north) / 2
    return [
        (west, south, mid_x, mid_y),
        (mid_x, south, east, mid_y),
        (west, mid_y, mid_x, north),
        (mid_x, mid_y, east, north),
    ]


def is_duplicate(document: dict[str, Any], existing: list[dict[str, Any]]) -> bool:
    place_id = str(document.get("id") or "")
    key = (
        _normalize(document.get("place_name")),
        _normalize(document.get("road_address_name") or document.get("address_name")),
    )
    return any(
        str((row.get("features") or {}).get("kakao_place_id") or "") == place_id
        or _existing_key(row) == key
        for row in existing
    )


def to_row(document: dict[str, Any], facility_type: str) -> dict[str, Any]:
    """단건 호환 변환. 혼잡·운영시간은 절대 합성하지 않는다."""
    return {
        "name": str(document.get("place_name") or "").strip(),
        "type": facility_type,
        "latitude": float(document["y"]),
        "longitude": float(document["x"]),
        "capacity": 24 if facility_type == "cafe" else 40,
        "operating_hours": {},
        "address": str(
            document.get("road_address_name") or document.get("address_name") or ""
        ).strip(),
        "phone": str(document.get("phone") or "").strip() or None,
        "features": {
            "source": "kakao",
            "kakao_place_id": str(document.get("id") or ""),
            "kakao_place_url": str(document.get("place_url") or "") or None,
            "capacity_source": "synthetic_type_default",
            "congestion_source": "unavailable",
        },
        "is_active": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--report", type=Path, default=Path("../../scratch/kakao_places.json"))
    args = parser.parse_args()
    result = asyncio.run(run(apply=args.apply, report_path=args.report))
    print(json.dumps({key: value for key, value in result.items() if key != "actions"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
