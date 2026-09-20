"""경주 메뉴별음식점(data.go.kr 15114465) → facilities 보강 배치.

app/services/gyeongju_restaurant_service.py 로 경주 음식점 목록(대표메뉴·영업시간·주차·
편의시설)을 받아, 기존 facilities 의 음식점 행과 **이름 + 좌표 근접**으로 매칭해 features
JSON 을 보강한다. 스키마 변경 없음 — 대표메뉴는 features.menu(SPOT 취향매칭이 읽는 키,
app/services/spot/preference.py)로, 나머지 상세는 features.gyeongju_food 네임스페이스로 넣어
TourAPI 가 쌓은 키(first_menu·parking·cat3·번역 등)를 덮어쓰지 않는다. 값이 있고 기존이 비어
있을 때만 operating_hours·homepage(기존 컬럼)도 채운다.

매칭 안 되면 **skip**(신규 삽입하지 않는다 — 좌표/식별자 신뢰 문제). 키/URL 미설정이면
로그만 남기고 정상 종료(무해). app_events 에 event='gyeongju_food_sync' 기록.

사용 예:
  python scripts/ingest_gyeongju_restaurants.py --dry-run   # DB 미기록, 매칭/보강 계획만 출력
  python scripts/ingest_gyeongju_restaurants.py             # 매칭 행 features 보강 upsert
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any

# train.py 컨벤션 — 이 스크립트 디렉터리의 부모(apps/api)를 sys.path 에 추가해 app.* 임포트.
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.append(parent_dir)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(parent_dir, ".env"))

from app.core.config import settings  # noqa: E402
from app.services.gyeongju_restaurant_service import get_gyeongju_restaurants  # noqa: E402
from app.services.spot.travel import calculate_haversine_distance  # noqa: E402

# 매칭 후보로 볼 음식점 시설: TourAPI 음식점(39) + Kakao 로 보완된 restaurant/cafe.
_FOOD_CONTENT_TYPE_ID = 39
_FOOD_TYPES = {"restaurant", "cafe"}
# 이름 정확 일치 시 허용 반경 / 이름 부분포함 시 (더 엄격한) 허용 반경.
_EXACT_NAME_MAX_M = 200.0
_CONTAINS_NAME_MAX_M = 80.0
UPSERT_CHUNK = 100


def _normalize_name(value: Any) -> str:
    return "".join(str(value or "").split()).casefold()


def _is_food_facility(facility: dict[str, Any]) -> bool:
    try:
        ctid_match = int(facility.get("contenttypeid")) == _FOOD_CONTENT_TYPE_ID
    except (TypeError, ValueError):
        ctid_match = False
    return ctid_match or str(facility.get("type") or "") in _FOOD_TYPES


def match_facility(
    restaurant: dict[str, Any], facilities: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """음식점 1건을 이름+좌표 근접으로 기존 시설에 매칭한다(없으면 None).

    - 이름 정규화 완전일치 + 200m 이내, 또는
    - 이름 부분포함(양방향, 2글자 이상) + 80m 이내.
    조건을 만족하는 후보 중 가장 가까운 시설을 고른다(오탐 방지 — 애매하면 매칭하지 않는다).
    """
    r_name = _normalize_name(restaurant.get("name"))
    r_lat = restaurant.get("lat")
    r_lng = restaurant.get("lng")
    if not r_name or r_lat is None or r_lng is None:
        return None

    best: dict[str, Any] | None = None
    best_distance = float("inf")
    for facility in facilities:
        if not _is_food_facility(facility):
            continue
        f_lat = facility.get("latitude")
        f_lng = facility.get("longitude")
        if f_lat is None or f_lng is None:
            continue
        f_name = _normalize_name(facility.get("name"))
        if not f_name:
            continue
        distance = calculate_haversine_distance(float(r_lat), float(r_lng), float(f_lat), float(f_lng))
        exact = f_name == r_name
        contains = len(r_name) >= 2 and len(f_name) >= 2 and (r_name in f_name or f_name in r_name)
        if exact and distance <= _EXACT_NAME_MAX_M:
            pass
        elif contains and distance <= _CONTAINS_NAME_MAX_M:
            pass
        else:
            continue
        if distance < best_distance:
            best = facility
            best_distance = distance
    return best


def merge_features(
    existing_features: dict[str, Any] | None, restaurant: dict[str, Any], now_iso: str
) -> dict[str, Any]:
    """기존 features 를 보존하며 경주 음식점 상세를 보강한 새 features 를 만든다.

    - features.menu: 대표메뉴(SPOT 취향매칭 preference.py 가 읽는 키). TourAPI 는 first_menu 를
      쓰므로 충돌하지 않는다.
    - features.gyeongju_food: 출처·상세(menu/hours/closed/parking/amenities/homepage/con_uid/
      address)를 네임스페이스로 보존해 TourAPI 축적 키를 덮지 않는다.
    """
    features = dict(existing_features or {})
    detail = {
        key: value
        for key, value in {
            "con_uid": restaurant.get("con_uid"),
            "menu": restaurant.get("menu"),
            "hours": restaurant.get("hours"),
            "closed": restaurant.get("closed"),
            "parking": restaurant.get("parking"),
            "amenities": restaurant.get("amenities"),
            "homepage": restaurant.get("homepage"),
            "address": restaurant.get("address"),
        }.items()
        if value is not None
    }
    detail["source"] = "gyeongju_food_15114465"
    detail["synced_at"] = now_iso
    features["gyeongju_food"] = {**(features.get("gyeongju_food") or {}), **detail}
    if restaurant.get("menu"):
        features["menu"] = restaurant["menu"]
    return features


def build_actions(
    restaurants: list[dict[str, Any]], facilities: list[dict[str, Any]], now_iso: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """매칭 결과로 (upsert 할 update_row 목록, 감사용 action 목록)을 만든다(순수 함수).

    같은 시설이 여러 음식점 행에 매칭되면 첫 매칭만 반영한다(중복 upsert 방지).
    """
    update_rows: list[dict[str, Any]] = []
    actions: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for restaurant in restaurants:
        facility = match_facility(restaurant, facilities)
        if facility is None:
            actions.append({"name": restaurant.get("name"), "status": "skipped_no_match"})
            continue
        facility_id = str(facility.get("id"))
        if facility_id in used_ids:
            actions.append({
                "name": restaurant.get("name"),
                "status": "skipped_duplicate_match",
                "facility_id": facility_id,
            })
            continue
        used_ids.add(facility_id)

        payload: dict[str, Any] = {
            "features": merge_features(facility.get("features"), restaurant, now_iso),
        }
        # 기존 컬럼은 비어 있을 때만 채운다(스키마 변경 없이, 기존 값 보존).
        if restaurant.get("hours") and not (facility.get("operating_hours") or {}):
            hours_payload: dict[str, Any] = {"open": restaurant["hours"], "source": "gyeongju_food"}
            if restaurant.get("closed"):
                hours_payload["closed"] = restaurant["closed"]
            payload["operating_hours"] = hours_payload
        if restaurant.get("homepage") and not facility.get("homepage"):
            payload["homepage"] = restaurant["homepage"]

        update_rows.append({**facility, **payload})
        actions.append({
            "name": restaurant.get("name"),
            "status": "matched",
            "facility_id": facility_id,
            "facility_name": facility.get("name"),
            "fields": sorted(payload.keys()),
        })
    return update_rows, actions


async def run(*, apply: bool) -> dict[str, Any]:
    configured = bool(settings.GYEONGJU_FOOD_API_BASE_URL.strip()) and bool(
        settings.GYEONGJU_FOOD_API_KEY.strip()
    )
    if not configured:
        print(
            "GYEONGJU_FOOD_API_BASE_URL / GYEONGJU_FOOD_API_KEY 가 설정되지 않아 "
            "경주 음식점 보강을 건너뜁니다(무해 종료)."
        )
        return {"configured": False, "fetched": 0, "matched": 0, "updated": 0}

    restaurants = await get_gyeongju_restaurants(use_cache=False)
    print(f"[fetch] 경주 메뉴별음식점 {len(restaurants)}건 수신")
    if not restaurants:
        return {"configured": True, "fetched": 0, "matched": 0, "updated": 0}

    # DB 클라이언트는 여기서 지연 임포트 — --dry-run 경로에서 Supabase 연결을 만들지 않는다.
    from app.core.supabase import fetch_all_rows, supabase_admin

    facilities = fetch_all_rows(
        supabase_admin,
        "facilities",
        "id, name, address, latitude, longitude, contenttypeid, type, homepage, operating_hours, features, is_active",
    )
    now_iso = datetime.now(timezone.utc).isoformat()
    update_rows, actions = build_actions(restaurants, facilities, now_iso)
    matched = sum(1 for action in actions if action["status"] == "matched")
    print(f"[match] 음식점 시설 {sum(1 for f in facilities if _is_food_facility(f))}곳 중 매칭 {matched}건")

    updated = 0
    if apply and update_rows:
        for offset in range(0, len(update_rows), UPSERT_CHUNK):
            chunk = update_rows[offset:offset + UPSERT_CHUNK]
            supabase_admin.table("facilities").upsert(chunk, on_conflict="id").execute()
            updated += len(chunk)
        print(f"[upsert] features 보강 {updated}건 완료")
    elif not apply:
        print("[dry-run] DB 미기록 — 매칭/보강 계획만 출력")
        for action in actions:
            print(json.dumps(action, ensure_ascii=False))

    summary = {
        "configured": True,
        "fetched": len(restaurants),
        "matched": matched,
        "updated": updated,
        "unmatched": len(restaurants) - matched,
    }

    if apply:
        try:
            supabase_admin.table("app_events").insert({
                "event": "gyeongju_food_sync",
                "props": summary,
            }).execute()
        except Exception as exc:  # noqa: BLE001 — 마커 기록 실패가 보강 결과를 무르지 않게.
            print(f"[sync-marker] app_events 기록 실패(보강 결과에는 영향 없음): {exc}")

    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="경주 메뉴별음식점 → facilities features 보강 배치")
    parser.add_argument("--dry-run", action="store_true", help="DB 에 쓰지 않고 매칭/보강 계획만 출력")
    args = parser.parse_args()
    summary = asyncio.run(run(apply=not args.dry_run))
    print(json.dumps(summary, ensure_ascii=False))
    # 미설정(무해)·정상 보강 모두 성공 종료. 설정됐는데 0건 수신이면 상류 이슈로 보고 1.
    if summary.get("configured") and summary.get("fetched", 0) == 0:
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
