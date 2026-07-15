"""경주 황리단길 TourAPI POI 적재 배치 — docs/IMPROVEMENT_PLAN.md WS-B-2.

한국관광공사 TourAPI(locationBasedList2)에서 관광지(12)·문화시설(14)·음식점(39) POI 를
수집해 Supabase `facilities` 테이블에 contentid 기준으로 upsert 한다.
(패턴 참고: 루트 scripts/seed.js, 경로/부트스트랩은 scripts/train.py 컨벤션.)

사용 예:
  python scripts/ingest_tourapi.py --dry-run              # DB 미기록, 변환 결과만 출력
  python scripts/ingest_tourapi.py                        # 황리단길 반경 2km 적재
  python scripts/ingest_tourapi.py --details --limit 20   # 상세(개요/전화/홈페이지/운영시간/무장애)까지 — 쿼터 주의
"""

import argparse
import asyncio
import json
import os
import sys

# Add parent directory of this script's directory to sys.path (train.py 와 동일 컨벤션)
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.append(parent_dir)

from dotenv import load_dotenv

# Load env variables if running outside project root
load_dotenv(os.path.join(parent_dir, ".env"))

from app.services.tourapi import (
    CONTENT_TYPE_IDS,
    TourAPIError,
    detail_common,
    detail_info,
    detail_intro,
    extract_barrier_free,
    extract_detail_common,
    extract_operating_hours,
    location_based_list,
    parse_items,
    parse_total_count,
    transform_poi,
)
# transform.py 신규 함수(Tier1 확장 필드/phone 폴백) — 패키지 __init__ 재노출 범위 밖이라 직접 임포트.
from app.services.tourapi.transform import (
    extract_intro_extra_features,
    extract_intro_phone_fallback,
)

# 경주 황리단길 기준좌표 (docs/NEXTSPOT_PIVOT.md — 초기 서비스 지역)
DEFAULT_LAT = 35.8361
DEFAULT_LNG = 129.2105
DEFAULT_RADIUS_M = 2000

PAGE_ROWS = 100        # locationBasedList2 페이지당 조회 건수
UPSERT_CHUNK = 100     # Supabase upsert 배치 크기

TYPE_LABELS = {12: "관광지(12)", 14: "문화시설(14)", 39: "음식점(39)"}


async def fetch_pois(lat: float, lng: float, radius_m: int, limit: int) -> dict[int, list[dict]]:
    """contentTypeId 별로 반경 조회를 페이지네이션하며 원본 item 을 수집한다.

    limit > 0 이면 타입별 최대 limit 건까지만 수집(쿼터 절약용).
    """
    collected: dict[int, list[dict]] = {}
    for ctid in CONTENT_TYPE_IDS:
        items: list[dict] = []
        page = 1
        while True:
            payload = await location_based_list(
                map_x=lng, map_y=lat, radius_m=radius_m,
                content_type_id=ctid, page=page, rows=PAGE_ROWS,
            )
            page_items = parse_items(payload)
            items.extend(page_items)
            total = parse_total_count(payload)
            if not page_items or len(items) >= total:
                break
            if limit and len(items) >= limit:
                break
            page += 1
        if limit:
            items = items[:limit]
        collected[ctid] = items
        print(f"[fetch] {TYPE_LABELS.get(ctid, ctid)}: {len(items)}건 수집")
    return collected


async def enrich_row(row: dict) -> None:
    """--details 옵션: detailCommon2 → overview/phone/homepage(+이미지 폴백),
    detailIntro2 → operating_hours + 확장 features(대표메뉴/주차/유모차/반려동물/카드결제/
    수용인원) + phone 폴백, detailInfo2 → barrier_free 를 채운다(제자리 수정).

    POI 1건당 3회 추가 호출이 발생하므로 기본은 꺼져 있다(쿼터 절약).
    개별 실패는 경고만 남기고 계속 진행(부분 실패 허용).
    """
    contentid = row["contentid"]
    ctid = row["contenttypeid"]
    try:
        common_payload = await detail_common(contentid)
        common_items = parse_items(common_payload)
        if common_items:
            common = extract_detail_common(common_items[0])
            # image_url 은 locationBasedList2 의 firstimage 를 우선 — 없을 때만 폴백으로 채운다.
            if row.get("image_url"):
                common.pop("image_url", None)
            row.update(common)
    except (TourAPIError, RuntimeError) as e:
        print(f"[details] detailCommon2 실패 (contentid={contentid}): {e}")
    try:
        intro_payload = await detail_intro(contentid, ctid)
        intro_items = parse_items(intro_payload)
        if intro_items:
            intro_item = intro_items[0]
            hours = extract_operating_hours(intro_item, ctid)
            if hours:
                row["operating_hours"] = hours
            extra_features = extract_intro_extra_features(intro_item, ctid)
            if extra_features:
                row["features"] = {**row.get("features", {}), **extra_features}
            # phone 폴백: detailCommon2.tel 이 비었을 때만(실측 — 현재 전 시설 tel 빈 값이라 실효).
            if not row.get("phone"):
                phone_fallback = extract_intro_phone_fallback(intro_item, ctid)
                if phone_fallback:
                    row["phone"] = phone_fallback
    except (TourAPIError, RuntimeError) as e:
        print(f"[details] detailIntro2 실패 (contentid={contentid}): {e}")
    try:
        info_payload = await detail_info(contentid, ctid)
        barrier_free = extract_barrier_free(parse_items(info_payload))
        if barrier_free is not None:
            row["barrier_free"] = barrier_free
    except (TourAPIError, RuntimeError) as e:
        print(f"[details] detailInfo2 실패 (contentid={contentid}): {e}")


def upsert_facilities(rows: list[dict]) -> int:
    """facilities 에 contentid 기준 upsert. 성공 행 수를 반환.

    1차: PostgREST upsert(on_conflict='contentid') — 부분 유니크 인덱스(uq_facilities_contentid,
         WHERE contentid IS NOT NULL) 를 충돌 대상으로 사용한다.
    2차(폴백): supabase-py/PostgREST 버전에 따라 부분 인덱스 충돌 대상을 거부할 수 있어(오프라인
         검증 불가), 실패 시 기존 contentid 를 SELECT 로 조회해 신규는 INSERT, 기존은 UPDATE 로 나눈다.
    """
    # DB 클라이언트는 여기서 지연 임포트 — --dry-run 경로에서 Supabase 연결을 만들지 않는다.
    from app.core.supabase import supabase_admin

    written = 0
    try:
        for i in range(0, len(rows), UPSERT_CHUNK):
            chunk = rows[i:i + UPSERT_CHUNK]
            supabase_admin.table("facilities").upsert(chunk, on_conflict="contentid").execute()
            written += len(chunk)
        return written
    except Exception as e:
        print(f"[upsert] on_conflict=contentid upsert 실패({e}) — SELECT 후 INSERT/UPDATE 폴백으로 전환")

    # --- 폴백 경로: 기존 contentid 조회 → 신규 INSERT / 기존 UPDATE ---
    written = 0
    existing_res = (
        supabase_admin.table("facilities")
        .select("contentid")
        .not_.is_("contentid", "null")
        .execute()
    )
    existing_ids = {r["contentid"] for r in (existing_res.data or [])}

    new_rows = [r for r in rows if r["contentid"] not in existing_ids]
    update_rows = [r for r in rows if r["contentid"] in existing_ids]

    for i in range(0, len(new_rows), UPSERT_CHUNK):
        chunk = new_rows[i:i + UPSERT_CHUNK]
        try:
            supabase_admin.table("facilities").insert(chunk).execute()
            written += len(chunk)
        except Exception as e:
            print(f"[upsert] INSERT 배치 실패({len(chunk)}건): {e}")

    for row in update_rows:
        try:
            payload = {k: v for k, v in row.items() if k != "contentid"}
            supabase_admin.table("facilities").update(payload).eq("contentid", row["contentid"]).execute()
            written += 1
        except Exception as e:
            print(f"[upsert] UPDATE 실패 (contentid={row['contentid']}): {e}")

    return written


async def run(args: argparse.Namespace) -> int:
    collected = await fetch_pois(args.lat, args.lng, args.radius, args.limit)

    # 변환 (순수 함수 transform_poi — 비정형 item 은 None 으로 스킵)
    rows_by_type: dict[int, list[dict]] = {}
    skipped = 0
    seen_contentids: set[str] = set()
    for ctid, items in collected.items():
        rows: list[dict] = []
        for item in items:
            row = transform_poi(item)
            if row is None:
                skipped += 1
                continue
            if row["contentid"] in seen_contentids:  # 같은 배치 내 중복 contentid 방지
                continue
            seen_contentids.add(row["contentid"])
            rows.append(row)
        rows_by_type[ctid] = rows

    all_rows = [row for rows in rows_by_type.values() for row in rows]

    if args.details:
        print(f"[details] {len(all_rows)}건 상세 조회 시작 (POI 당 3회 호출 — 쿼터 주의)")
        for row in all_rows:
            await enrich_row(row)

    # 타입별 집계 로그
    for ctid in CONTENT_TYPE_IDS:
        rows = rows_by_type.get(ctid, [])
        by_type: dict[str, int] = {}
        for r in rows:
            by_type[r["type"]] = by_type.get(r["type"], 0) + 1
        detail = ", ".join(f"{t}={n}" for t, n in sorted(by_type.items())) or "0건"
        print(f"[transform] {TYPE_LABELS.get(ctid, ctid)}: {len(rows)}행 ({detail})")
    if skipped:
        print(f"[transform] 필수 필드 누락 등으로 스킵: {skipped}건")

    if not all_rows:
        print("적재할 POI 가 없습니다. 좌표/반경/인증키를 확인하세요.")
        return 1

    if args.dry_run:
        print(f"\n--dry-run: DB 기록 없이 변환 결과 {len(all_rows)}행 출력\n")
        for row in all_rows:
            print(json.dumps(row, ensure_ascii=False))
        return 0

    written = upsert_facilities(all_rows)
    print(f"\n적재 완료: {written}/{len(all_rows)}행 upsert (facilities, contentid 기준)")

    # 동기화 마커 — GET /api/v1/freshness 가 마지막 TourAPI 적재 시각으로 읽는다(D5).
    # best-effort: app_events 마이그레이션 미적용 등으로 실패해도 적재 결과(종료코드)에는 영향 없음.
    try:
        from app.core.supabase import supabase_admin
        supabase_admin.table("app_events").insert({
            "event": "tourapi_sync",
            "props": {"written": written, "total": len(all_rows)},
        }).execute()
    except Exception as e:
        print(f"[sync-marker] app_events 동기화 마커 기록 실패(적재 결과에는 영향 없음): {e}")

    return 0 if written > 0 else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="경주 황리단길 TourAPI POI 적재 배치")
    parser.add_argument("--lat", type=float, default=DEFAULT_LAT, help=f"기준 위도 (기본 {DEFAULT_LAT} — 황리단길)")
    parser.add_argument("--lng", type=float, default=DEFAULT_LNG, help=f"기준 경도 (기본 {DEFAULT_LNG} — 황리단길)")
    parser.add_argument("--radius", type=int, default=DEFAULT_RADIUS_M, help=f"조회 반경 m (기본 {DEFAULT_RADIUS_M})")
    parser.add_argument("--limit", type=int, default=0, help="contentTypeId 별 최대 수집 건수 (0=전체)")
    parser.add_argument("--dry-run", action="store_true", help="DB 에 쓰지 않고 변환 결과만 출력")
    parser.add_argument("--details", action="store_true",
                        help="detailCommon2(개요/전화/홈페이지)·detailIntro2(운영시간)·detailInfo2(무장애)까지 조회 — 쿼터 소모 큼, 기본 꺼짐")
    args = parser.parse_args()

    try:
        exit_code = asyncio.run(run(args))
    except (TourAPIError, RuntimeError) as e:
        # TOURAPI_KEY 미설정/호출 실패 등 — 트레이스백 없이 원인만 명확히 출력
        print(f"오류: {e}")
        sys.exit(1)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
