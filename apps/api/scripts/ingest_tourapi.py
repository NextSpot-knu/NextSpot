"""경주 황리단길 TourAPI POI 적재 배치 — docs/IMPROVEMENT_PLAN.md WS-B-2.

한국관광공사 TourAPI(locationBasedList2)에서 관광지(12)·문화시설(14)·음식점(39) POI 를
수집해 Supabase `facilities` 테이블에 contentid 기준으로 upsert 한다.
(패턴 참고: 루트 scripts/seed.js, 경로/부트스트랩은 scripts/train.py 컨벤션.)

사용 예:
  python scripts/ingest_tourapi.py --dry-run              # DB 미기록, 변환 결과만 출력
  python scripts/ingest_tourapi.py                        # 황리단길 반경 2km 적재
  python scripts/ingest_tourapi.py --details --limit 20   # 상세(개요/전화/홈페이지/운영시간/무장애)까지 — 쿼터 주의
  python scripts/ingest_tourapi.py --no-sync               # 폐업/표출중단 동기화(showflag) 스텝만 끄기

폐업·표출중단 자동 감지(2차 기획 1위, 기본 켜짐 — --no-sync 로 끌 수 있음):
  기존 적재 흐름 뒤에 areaBasedSyncList2 로 지역 전체 showflag 를 조회해 facilities.contentid 와
  대조하고, 비표출(showflag='0')이면 is_active=false, 재표출(showflag='1')이면 true 로 복구한다.
  자세한 설계 근거는 아래 SYNC_AREA_CODE 주석 참고.
"""

import argparse
import asyncio
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

import httpx

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
    detail_image,
    detail_intro,
    extract_barrier_free,
    extract_detail_common,
    extract_gallery_images,
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
# area_based_sync_list 도 패키지 __init__ 재노출 범위 밖(client.py 는 수정 금지 대상이라 __init__.py 도
# 건드리지 않고 위 transform.py 함수들과 동일하게 서브모듈에서 직접 임포트).
from app.services.tourapi.client import area_based_sync_list
from app.services.wikimedia import find_reusable_place_image
from app.services.kakao_coordinate_service import reconcile_row_coordinate

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
    try:
        image_payload = await detail_image(contentid)
        gallery = extract_gallery_images(parse_items(image_payload))
        if gallery:
            row["gallery_images"] = gallery
    except (TourAPIError, RuntimeError) as e:
        print(f"[details] detailImage2 실패 (contentid={contentid}): {e}")

    # TourAPI 사진이 전혀 없는 관광지·문화시설만 보수적으로 Wikimedia 퍼블릭 도메인 폴백.
    if ctid in {12, 14} and not row.get("image_url") and not row.get("gallery_images"):
        try:
            wikimedia = await find_reusable_place_image(
                str(row["name"]), float(row["latitude"]), float(row["longitude"])
            )
            if wikimedia:
                row["gallery_images"] = [wikimedia["url"]]
                row["features"] = {**row.get("features", {}), "image_source": {
                    "provider": "Wikimedia Commons",
                    "source_url": wikimedia["source_url"],
                    "license": wikimedia["license"],
                    "artist": wikimedia["artist"],
                }}
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as e:
            print(f"[details] Wikimedia 이미지 폴백 실패 (contentid={contentid}): {e}")


def upsert_facilities(rows: list[dict]) -> int:
    """facilities 에 contentid 기준 upsert. 성공 행 수를 반환.

    1차: PostgREST upsert(on_conflict='contentid') — 부분 유니크 인덱스(uq_facilities_contentid,
         WHERE contentid IS NOT NULL) 를 충돌 대상으로 사용한다.
    2차(폴백): supabase-py/PostgREST 버전에 따라 부분 인덱스 충돌 대상을 거부할 수 있어(오프라인
         검증 불가), 실패 시 기존 contentid 를 SELECT 로 조회해 신규는 INSERT, 기존은 UPDATE 로 나눈다.

    features 병합(2026-07-17, P0 수정): 두 경로 모두 쓰기 전에 기존 features 와 {**기존, **신규}
    병합한다. 통째 교체하면 이 배치 밖에서 축적된 키 — overview_i18n(번역 배치), image_source
    (Wikimedia 라이선스) 등 — 가 일배치마다 소실된다(실측: 번역 67곳이 다음 cron 에 전멸할 뻔).
    transform/enrich 가 만드는 키는 신규 값이 이기고, 배치가 모르는 키는 보존된다.
    """
    # DB 클라이언트는 여기서 지연 임포트 — --dry-run 경로에서 Supabase 연결을 만들지 않는다.
    from app.core.supabase import supabase_admin

    try:
        existing_res = (
            supabase_admin.table("facilities")
            .select("contentid, features")
            .not_.is_("contentid", "null")
            .execute()
        )
    except Exception as e:  # noqa: BLE001
        # 기존 features 를 모르면 병합 불가 → 진행하면 번역 등 축적 키가 소실된다. fail-closed 중단.
        print(f"[upsert] 기존 features 조회 실패({e}) — features 소실 방지를 위해 upsert 를 중단합니다")
        return 0
    existing_features: dict[str, dict] = {
        r["contentid"]: (r.get("features") or {})
        for r in (existing_res.data or [])
        if r.get("contentid")
    }
    for row in rows:
        prev = existing_features.get(row.get("contentid"))
        if prev:
            row["features"] = {**prev, **(row.get("features") or {})}

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
    # (contentid 집합은 위 features 병합용 SELECT 결과를 재사용 — 추가 왕복 없음)
    written = 0
    existing_ids = set(existing_features)

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


# ---------------------------------------------------------------------------
# 폐업·표출중단 자동 감지(2차 기획 1위) — areaBasedSyncList2(showflag) 동기화.
#
# 실측(2026-07-15, TOURAPI_KEY 실키로 직접 3콜+전수 스캔):
#   · areaCode=35(경북, legacy 체계) + sigunguCode=2 가 경주를 정확히 가리킨다 — 지역 필터 없이
#     조회한 587건 중 addr1 에 '경주'가 포함된 행이 570/587(97%)이고, 우리 기존 적재 facilities
#     69건(contentid 보유) 중 67건이 이 목록에서 매칭됐다(나머지 2건은 행정경계 밖/누락 가능성).
#   · showflag 는 문자열 '1'(표출)과 '0'(비표출) 두 값만 관측됨 — 587건 전수 스캔에서 제3값 없음.
#     따라서 아래 판정 로직은 '로그만 남기고 제외는 안 함' 저하 모드가 아니라 정식(즉시 반영) 모드다.
#   · ⚠️ modifiedtime 파라미터는 실측 무동작 함정: YYYYMMDD/YYYYMMDDHHMMSS/정수/문자열 등 시도한
#     모든 포맷·날짜(2020-01-01 ~ 오늘)에서 totalCount=0 이 나왔고, 파라미터를 아예 생략했을 때만
#     전체 587건이 돌아왔다(searchFestival2 의 구 areaCode 무시 함정과 동일 부류의 스펙 불일치).
#     그래서 이 배치는 modifiedtime 을 쓰지 않고 매번 지역 전체 동기화 목록을 받아 우리
#     facilities.contentid 와 대조한다(587건 ≈ 페이지 6회, 일 1배치라 쿼터 영향 무해).
SYNC_AREA_CODE = 35     # 경북(legacy areaCode 체계 — areaBasedList2/areaBasedSyncList2 전용)
SYNC_SIGUNGU_CODE = 2   # 경주(실측 확인 — 위 주석 참고)
SYNC_PAGE_ROWS = 100


async def fetch_showflag_map(
    area_code: int = SYNC_AREA_CODE, sigungu_code: int = SYNC_SIGUNGU_CODE,
) -> dict[str, str]:
    """지역 전체 areaBasedSyncList2 를 페이지네이션 수집해 {contentid: showflag} 로 반환한다.

    modifiedtime 은 실측 무동작이라 쓰지 않는다(위 모듈 주석 참고) — 매 실행 지역 전체를 받는다.
    """
    showflag_by_id: dict[str, str] = {}
    page = 1
    while True:
        payload = await area_based_sync_list(
            area_code=area_code, sigungu_code=sigungu_code, page=page, rows=SYNC_PAGE_ROWS,
        )
        items = parse_items(payload)
        if not items:
            break
        for item in items:
            contentid = item.get("contentid")
            if contentid not in (None, ""):
                showflag_by_id[str(contentid)] = str(item.get("showflag") or "")
        total = parse_total_count(payload)
        if len(showflag_by_id) >= total or len(items) < SYNC_PAGE_ROWS:
            break
        page += 1
    return showflag_by_id


def _temporary_closure_active(features: dict | None, today: date | None = None) -> bool:
    raw = (features or {}).get("temporarily_inactive_until")
    if not isinstance(raw, str):
        return False
    try:
        kst_today = datetime.now(timezone(timedelta(hours=9))).date()
        return date.fromisoformat(raw) >= (today or kst_today)
    except ValueError:
        return False


def sync_showflags(showflag_by_id: dict[str, str]) -> dict:
    """showflag 맵을 facilities.is_active 에 반영한다(동기 — DB I/O, 스크립트 컨텍스트라 to_thread 불필요).

    반환: {"checked": int, "deactivated": list[str](이번 실행에서 신규로 false 전환한 contentid),
           "reactivated": int(이번 실행에서 신규로 true 복구한 건수),
           "degraded": bool, "reason": str|None}
    이미 같은 상태인 행은 재기록하지 않는다(매일 같은 결과로 로그가 부풀지 않게 — 전환분만 기록).
    is_active 컬럼이 없으면(마이그레이션 미적용) degraded=True 로 정직하게 보고하고 갱신을 건너뛴다
    (오탐 방지 원칙 — 컬럼 없다고 스크립트를 죽이거나 잘못된 값을 쓰지 않는다).
    """
    # DB 클라이언트는 여기서 지연 임포트 — upsert_facilities 와 동일 관례(테스트 용이성 포함).
    from app.core.supabase import supabase_admin

    summary: dict = {"checked": 0, "deactivated": [], "reactivated": 0,
                     "reactivation_deferred": 0, "degraded": False, "reason": None}
    if not showflag_by_id:
        return summary

    try:
        existing = (
            supabase_admin.table("facilities")
            .select("id, contentid, is_active, features")
            .not_.is_("contentid", "null")
            .execute()
        )
    except Exception as e:
        summary["degraded"] = True
        summary["reason"] = f"facilities.is_active 조회 실패(컬럼 미존재/마이그레이션 미적용 가능성): {e}"
        return summary

    for row in existing.data or []:
        contentid = row.get("contentid")
        showflag = showflag_by_id.get(contentid)
        if showflag is None:
            continue  # 이번 동기화 목록에 없음(지역 밖/일시 누락) — 판단 근거 없어 건드리지 않는다.
        summary["checked"] += 1
        prior_active = row.get("is_active")

        if showflag == "0":
            if prior_active is not False:  # True 또는 None(컬럼값 이상) → 신규 비표출 전환
                try:
                    supabase_admin.table("facilities").update({"is_active": False}).eq("id", row["id"]).execute()
                    summary["deactivated"].append(contentid)
                except Exception as e:
                    print(f"[sync] is_active=false 갱신 실패 (contentid={contentid}): {e}")
        elif showflag == "1":
            if prior_active is False:  # 신규 재표출 복구
                if _temporary_closure_active(row.get("features")):
                    summary["reactivation_deferred"] += 1
                    continue
                try:
                    supabase_admin.table("facilities").update({"is_active": True}).eq("id", row["id"]).execute()
                    summary["reactivated"] += 1
                except Exception as e:
                    print(f"[sync] is_active=true 복구 실패 (contentid={contentid}): {e}")
        else:
            # 실측(2026-07-15)으로는 '1'/'0' 외 값을 관측한 적 없다 — 그래도 미상 값은 판단을 지어내지
            # 않고 건드리지 않는다(정직한 저하, 개별 건 단위).
            print(f"[sync] 미상 showflag 값(스킵, contentid={contentid}): {showflag!r}")

    return summary


async def run_showflag_sync(written: int) -> dict:
    """폐업/표출중단 동기화 배치 1회 실행 + app_events 기록(best-effort, 결과에 상관없이 예외를 던지지 않는다)."""
    showflag_by_id = await fetch_showflag_map()
    summary = sync_showflags(showflag_by_id)

    try:
        from app.core.supabase import supabase_admin
        props = {
            "deactivated": summary["deactivated"],
            "reactivated": summary["reactivated"],
            "checked": summary["checked"],
            # written 도 함께 남겨 GET /api/v1/freshness(최신 event='tourapi_sync' 1행을 읽는다)의
            # 기존 '마지막 적재 행수' 표기가 이 신규 스텝 때문에 조용히 null 로 퇴화하지 않게 한다.
            "written": written,
        }
        if summary["degraded"]:
            props["degraded"] = True
            props["reason"] = summary["reason"]
        supabase_admin.table("app_events").insert({"event": "tourapi_sync", "props": props}).execute()
    except Exception as e:
        print(f"[sync] app_events 기록 실패(감지 결과에는 영향 없음): {e}")

    return summary


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

    # 지도 좌표의 최종 정본은 Kakao. 키 미설정 또는 이름+주소/근접성 엄격 매칭 실패 시
    # TourAPI 좌표를 그대로 유지한다. 원 좌표는 features.tourapi_coordinates에 보존된다.
    if os.getenv("KAKAO_REST_API_KEY"):
        matched = 0
        for row in all_rows:
            matched += int(await reconcile_row_coordinate(row))
        print(f"[coordinates] Kakao 엄격 매칭 좌표 교정: {matched}/{len(all_rows)}건")

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

    # 폐업/표출중단 자동 감지(2차 기획 1위) — 기존 흐름 뒤, 기본 켜짐(--no-sync 로 끔).
    # best-effort: 실패해도 위 적재 결과(종료코드)에는 영향을 주지 않는다.
    if args.sync:
        try:
            sync_summary = await run_showflag_sync(written)
            if sync_summary["degraded"]:
                print(f"[sync] 저하 모드(is_active 갱신 미반영): {sync_summary['reason']}")
            else:
                print(
                    f"[sync] showflag 동기화: 확인 {sync_summary['checked']}건 · "
                    f"비표출 신규 감지 {len(sync_summary['deactivated'])}건"
                    + (f" {sync_summary['deactivated']}" if sync_summary["deactivated"] else "")
                    + f" · 재표출 복구 {sync_summary['reactivated']}건"
                )
        except Exception as e:
            print(f"[sync] 폐업/표출중단 동기화 실패(적재 결과에는 영향 없음): {e}")

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
    parser.add_argument("--no-sync", dest="sync", action="store_false",
                        help="폐업/표출중단 동기화(showflag→is_active) 스텝을 건너뛴다(기본: 실행)")
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
