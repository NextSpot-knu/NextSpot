"""Kakao Local 음식점·카페를 NextSpot 시설로 확장한다.

기본은 dry-run이며 ``--apply``를 명시해야 신규 행을 추가한다. Kakao 카테고리 검색의
45건 노출 상한을 피하기 위해 결과가 포화된 사각형을 재귀 분할하고, 최종적으로 황리단길
중심 3km 안의 장소만 남긴다. TourAPI 시설은 덮어쓰지 않는다.
"""

import argparse
import asyncio
import json
import math
import re
from pathlib import Path

import httpx

from app.core.config import settings
from app.core.supabase import supabase_admin
from app.services.tourapi.transform import CAPACITY_DEFAULTS

URL = "https://dapi.kakao.com/v2/local/search/category.json"
CENTER_LAT = 35.8361
CENTER_LNG = 129.2105
RADIUS_M = 3000
CATEGORIES = {"FD6": "restaurant", "CE7": "cafe"}
MAX_DEPTH = 6


def normalize(value: object) -> str:
    return re.sub(r"[^0-9a-z가-힣]", "", str(value or "").lower())


def haversine_m(lat: float, lng: float) -> float:
    r = 6_371_000
    p1, p2 = math.radians(CENTER_LAT), math.radians(lat)
    dp, dl = p2 - p1, math.radians(lng - CENTER_LNG)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def split_rect(rect: tuple[float, float, float, float]) -> list[tuple[float, float, float, float]]:
    left, bottom, right, top = rect
    mid_x, mid_y = (left + right) / 2, (bottom + top) / 2
    return [
        (left, bottom, mid_x, mid_y), (mid_x, bottom, right, mid_y),
        (left, mid_y, mid_x, top), (mid_x, mid_y, right, top),
    ]


def is_duplicate(doc: dict, existing: list[dict]) -> bool:
    place_id = str(doc.get("id") or "")
    name = normalize(doc.get("place_name"))
    address = normalize(doc.get("road_address_name") or doc.get("address_name"))
    phone = normalize(doc.get("phone"))
    for row in existing:
        features = row.get("features") or {}
        if place_id and str(features.get("kakao_place_id") or "") == place_id:
            return True
        if name and normalize(row.get("name")) == name:
            row_address = normalize(row.get("address"))
            if address and row_address and address == row_address:
                return True
            if phone and normalize(row.get("phone")) == phone:
                return True
    return False


def to_row(doc: dict, facility_type: str) -> dict:
    return {
        "name": str(doc["place_name"]).strip(),
        "type": facility_type,
        "latitude": float(doc["y"]),
        "longitude": float(doc["x"]),
        "capacity": CAPACITY_DEFAULTS[facility_type],
        "address": str(doc.get("road_address_name") or doc.get("address_name") or "").strip() or None,
        "phone": str(doc.get("phone") or "").strip() or None,
        "is_active": True,
        "features": {
            "source": "kakao",
            "kakao_place_id": str(doc["id"]),
            "kakao_place_url": str(doc.get("place_url") or ""),
            "kakao_category_name": str(doc.get("category_name") or ""),
            "capacity_source": "synthetic_type_default",
            "congestion_source": "unavailable",
        },
    }


async def fetch_cell(client: httpx.AsyncClient, code: str, rect, depth: int = 0) -> dict[str, dict]:
    rect_text = ",".join(f"{value:.8f}" for value in rect)
    response = await client.get(URL, params={"category_group_code": code, "rect": rect_text, "size": 15, "page": 1})
    response.raise_for_status()
    payload = response.json()
    meta = payload.get("meta", {})
    if int(meta.get("total_count") or 0) > 45 and depth < MAX_DEPTH:
        parts = await asyncio.gather(*(fetch_cell(client, code, child, depth + 1) for child in split_rect(rect)))
        return {key: value for part in parts for key, value in part.items()}
    documents = list(payload.get("documents") or [])
    page = 2
    while not meta.get("is_end") and page <= 3:
        response = await client.get(URL, params={"category_group_code": code, "rect": rect_text, "size": 15, "page": page})
        response.raise_for_status()
        payload = response.json()
        meta = payload.get("meta", {})
        documents.extend(payload.get("documents") or [])
        page += 1
    return {str(doc.get("id")): doc for doc in documents if doc.get("id")}


async def collect() -> dict[str, dict]:
    lat_delta = RADIUS_M / 111_320
    lng_delta = RADIUS_M / (111_320 * math.cos(math.radians(CENTER_LAT)))
    rect = (CENTER_LNG - lng_delta, CENTER_LAT - lat_delta, CENTER_LNG + lng_delta, CENTER_LAT + lat_delta)
    headers = {"Authorization": f"KakaoAK {settings.KAKAO_REST_API_KEY}"}
    async with httpx.AsyncClient(timeout=15, headers=headers, limits=httpx.Limits(max_connections=10)) as client:
        groups = await asyncio.gather(*(fetch_cell(client, code, rect) for code in CATEGORIES))
    result: dict[str, dict] = {}
    for code, docs in zip(CATEGORIES, groups, strict=True):
        for place_id, doc in docs.items():
            try:
                if haversine_m(float(doc["y"]), float(doc["x"])) <= RADIUS_M:
                    result[place_id] = {**doc, "_facility_type": CATEGORIES[code]}
            except (KeyError, TypeError, ValueError):
                continue
    return result


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--report", default="scratch/kakao_place_ingest.json")
    args = parser.parse_args()
    if not settings.KAKAO_REST_API_KEY:
        raise SystemExit("KAKAO_REST_API_KEY가 필요합니다.")
    existing = (supabase_admin.table("facilities").select("id,name,address,phone,type,features").execute().data or [])
    docs = await collect()
    new_docs = [doc for doc in docs.values() if not is_duplicate(doc, existing)]
    rows = [to_row(doc, doc["_facility_type"]) for doc in new_docs]
    rows.sort(key=lambda row: (row["type"], row["name"]))
    if args.apply:
        for start in range(0, len(rows), 100):
            supabase_admin.table("facilities").insert(rows[start:start + 100]).execute()
    report = {
        "mode": "apply" if args.apply else "dry-run", "collected": len(docs),
        "existing": len(existing), "duplicates": len(docs) - len(rows), "new": len(rows), "rows": rows,
    }
    path = Path(args.report)
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[2] / path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    counts = {kind: sum(row["type"] == kind for row in rows) for kind in CATEGORIES.values()}
    print(f"Kakao 수집 {len(docs)} · 기존/중복 {len(docs) - len(rows)} · 신규 {len(rows)} {counts}")
    print(f"mode={report['mode']} report={path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
