"""경주 황리단길 TourAPI POI 적재 배치 — docs/archive/IMPROVEMENT_PLAN.md WS-B-2.

한국관광공사 TourAPI(locationBasedList2)에서 관광지(12)·문화시설(14)·음식점(39) POI 를
수집해 Supabase `facilities` 테이블에 contentid 기준으로 upsert 한다.
(경로/부트스트랩은 scripts/train.py 컨벤션.)

세 타입 모두 법정동 코드 목록(areaBasedList2 lDongRegnCd=47·lDongSignguCd=130)도 받아 같은 반경 안의 것을
contentid 로 합친다 — 구 지역코드가 빈 레코드(경주 음식점·문화시설 243건 중 127건, 3km 안 관광지 26곳 —
2026-09-29 실측)는 locationBasedList2 에 나오지 않는다. 새 행은 같은 가게가 이미 다른 행(Kakao 보완 등)으로 있으면 넣지 않는다
(중복 가드 — 이어 붙이기는 사람이 contentid 를 넣어서 한다, docs/HANDOVER.md).

사용 예:
  python scripts/ingest_tourapi.py --dry-run              # DB 미기록, 변환 결과만 출력
  python scripts/ingest_tourapi.py                        # 황리단길 반경 2km 적재
  python scripts/ingest_tourapi.py --details --limit 20   # 상세(개요/전화/홈페이지/운영시간/무장애)까지 — 쿼터 주의
  python scripts/ingest_tourapi.py --no-sync               # 폐업/표출중단 동기화(showflag) 스텝만 끄기

폐업·표출중단 자동 감지(2차 기획 1위, 기본 켜짐 — --no-sync 로 끌 수 있음):
  기존 적재 흐름 뒤에 areaBasedSyncList2 로 지역 전체 showflag 를 조회해 facilities.contentid 와
  대조하고, 비표출(showflag='0')이면 is_active=false, 재표출(showflag='1')이면 true 로 복구한다.
  자세한 설계 근거는 아래 SYNC_AREA_CODE 주석 참고.

종료 코드(ingest.yml 의 새 러너 재시도가 이 값을 본다):
  0  적재 성공
  75 목록 호출(locationBasedList2)이 재시도 후에도 일시 오류 — 상세 조회·DB 쓰기 전에 멈췄다(EX_TEMPFAIL).
     이 경우에만 워크플로가 새 러너로 다시 돈다. 다시 돌아도 TourAPI 목록 호출 몇 번만 더 쓴다.
  1  그 밖의 실패(키·resultCode 오류, 적재 0행, Supabase 조회 실패 등) — 다시 돌려도 같거나,
     상세 조회를 이미 끝낸 뒤라 재실행하면 쿼터를 한 번 더 태운다. 자동 재시도 대상이 아니다.
"""

import argparse
import asyncio
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlparse

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
    area_based_list,
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
# area_based_sync_list·TourAPITransientError 도 패키지 __init__ 재노출 범위 밖이라
# 위 transform.py 함수들과 동일하게 서브모듈에서 직접 임포트.
from app.services.tourapi.client import TourAPITransientError, area_based_sync_list
from app.services.batch.wikimedia import find_reusable_place_image
from app.services.batch.city_photo import retire_superseded_city_photo
from app.services.batch.facility_visibility import is_manually_hidden
from app.services.batch.kakao_coordinate_service import reconcile_row_coordinate
from app.services.spot.travel import calculate_haversine_distance

# 경주 황리단길 기준좌표 (docs/archive/NEXTSPOT_PIVOT.md — 초기 서비스 지역)
DEFAULT_LAT = 35.8361
DEFAULT_LNG = 129.2105
DEFAULT_RADIUS_M = 2000

PAGE_ROWS = 100        # locationBasedList2 페이지당 조회 건수
UPSERT_CHUNK = 100     # Supabase upsert 배치 크기

TYPE_LABELS = {12: "관광지(12)", 14: "문화시설(14)", 39: "음식점(39)"}

# 법정동 코드 목록(areaBasedList2 lDongRegnCd·lDongSignguCd). 2026-09-29 실측: 경주 음식점·문화시설 243건 중 127건은 구
# areacode/sigungucode 가 빈 값이라 locationBasedList2 에 아예 나오지 않는다(신라고분정보센터 새 레코드·카페 13곳 등).
# 법정동 목록을 반경(같은 --radius) 안으로 거른 뒤 contentid 로 합친다. 관광지(12)도 같은 사각지대라 합친다(PM 승인
# 2026-09-29 — 3km 안 26곳: 첨성대·대릉원 일원·분황사 등. 시드 행 월정교·교촌마을과 겹치는 곳은 새 행 가드가 막는다).
LDONG_REGN_CD = 47      # 경상북도(법정동)
LDONG_SIGNGU_CD = 130   # 경주시(법정동)
LDONG_CONTENT_TYPE_IDS: tuple[int, ...] = (12, 14, 39)
LDONG_PAGE_ROWS = 1000  # 경주 음식점 211·문화시설 32·관광지 203건(실측) — 한 페이지
# 원본 item 에 붙이는 표시 — run() 이 '법정동 목록에만 나온 곳'을 안다(transform_poi 는 모르는 키를 버린다).
LDONG_ONLY_MARK = "_nextspot_ldong_only"

# 적재하지 않는 contentid(사람 결정 — 이유를 함께 적는다). 행이 이미 있으면 showflag 동기화도 다시 켜지 않는다.
EXCLUDED_CONTENTIDS: dict[str, str] = {
    "3451999": "황리단길 생활문화센터 — TourAPI 에 운영시간이 없어 밤·새벽에도 '지금 열린 문화시설'로 뜬다"
               "(PM 2026-09-29 제외 결정)",
    # 옛 레코드는 대표 사진이 없고 구 지역코드라 반경 목록(locationBasedList2)에 계속 나온다. 새 레코드 3532127 로
    # 통합(PM_STEPS 3단계 C — 행 70231629 의 contentid 를 바꾼다)한 뒤에는 이름·거리 가드만 이 옛 레코드를 막는데,
    # 가드의 DB 조회가 한 번 실패하면(반경 목록 행이라 법정동 폴백으로도 안 빠진다) 사진 없는 두 번째
    # 신라고분정보센터 카드가 영구히 들어온다. 그래서 목록에서 아예 뺀다. 통합 전에는 행 70231629 가 이 번호라
    # 밤 적재가 그 행을 갱신하지 않는다(오늘 밤 SQL 로 넣은 갤러리 사진은 그대로 남는다).
    "3442528": "신라고분정보센터 옛 레코드 — 새 레코드 3532127 로 통합(같은 곳, PM 2026-09-29)",
    # PM 결정 대기(2026-09-29 관광지 법정동 목록 대조) — 넣을지 PM 이 정하기 전까지 막는다. 이 목록은 **새로 넣기만** 막고,
    # 이미 들어간 행을 끄지는 않는다(끄려면 is_active=false + features.manual_hidden SQL). 그래서 첫 밤 전에 막아 두고,
    # PM 이 넣기로 하면 그 줄을 지운다(다음 04:00 에 들어온다).
    "2658227": "경주 황리단길(관광지) — 황리단길 붐빔의 대안 목록에 황리단길 자체가 뜬다 · 운영시간 '점포 별로 상이함'"
               "(PM 결정 대기 2026-09-29)",
    "3417731": "경주 비단벌레 전동차 — 탈것(겨울 운휴), 장소 카드와 성격이 다르다(PM 결정 대기 2026-09-29)",
    "3494364": "경주 깁 모어 막걸리 — 양조장 체험(11:00~18:00, 화요일 휴무), 장소 카드와 성격이 다르다(PM 결정 대기 2026-09-29)",
    "3367497": "미추왕릉 — 대릉원 담장 안(같은 입장권), 이미 있는 천마총(대릉원) 126214 에서 337m · 새 경주 대릉원 일원에서"
               " 190m — 한 곳에 카드 세 장(PM 결정 대기 2026-09-29)",
    # 한 곳에 카드 두 장(2026-10-02 리뷰 — PM 이 "추천대로 보류" 10-02). 넣기로 하면 줄을 지운다(다음 04:00 에 들어온다).
    # 가드는 새 행끼리 · 음식점↔그 밖을 견주지 않아 아래 둘은 이 목록이 아니면 첫 밤에 그대로 들어온다.
    "1492402": "경주 대릉원 일원 — 기존 천마총(대릉원) 126214 에서 204m · 경주역사유적지구 971032 에서 61m(보류 2026-10-02)",
    "2781625": "금장대 수변공원 — 새 금장대 2756715 에서 265m, 같은 곳 카드 두 장(보류 2026-10-02)",
    "2756694": "흥무로 벚꽃길 — 새 흥무공원 2756706 에서 113m, 같은 곳 카드 두 장(보류 2026-10-02)",
    "3036159": "플레이스 씨(문화시설) — 기존 Kakao 플레이스씨 한식당 6m, 같은 가게(보류 2026-10-02)",
    "3036287": "경주쪽샘유적발굴관 — 새 쪽샘지구 3032585 와 같은 주소(태종로 788)·같은 좌표(보류 2026-10-02)",
}

# 새 행 중복 가드: 같은 부류(음식점·카페 / 그 밖)이고 정규화 이름이 같거나 한쪽이 다른 쪽을 품고(2글자 이상)
# 80m 안에 살아 있는 시설이 있으면 새 TourAPI 행을 넣지 않는다. 2026-09-29 운영 대조: 법정동 목록에만 나오는 3km 안
# 음식점 39곳 중 26곳이 이미 Kakao 보완 행(예: 동양백반 ↔ 동양백반 경주황리단길 본점 11m)이라, 가드 없이 넣으면
# 첫 밤에 같은 가게 카드가 두 장 뜬다. 가드에 걸린 곳은 로그에 남고, 사람이 그 행에 contentid 를 넣으면 다음 밤부터
# 그 행이 TourAPI 사진·운영시간을 받는다(docs/HANDOVER.md "사람 작업 대기").
DUPLICATE_GUARD_MAX_M = 80.0
# 관광지(새 행 type='attraction')는 가게가 아니라 넓은 터라 같은 곳의 두 좌표가 멀다 — 2026-09-29 운영 대조: TourAPI
# '경주 교촌마을'(128676) ↔ 시드 행 '경주 교촌마을'(f4000000-…-0002, Kakao 검증 좌표) 221m. 80m 로는 카드가 두 장이 된다.
# 대신 다른 TourAPI 레코드(contentid 가 있는 행)와는 이름이 같을 때만(정규화·지점 표시 뗀 이름) 같은 곳으로 본다 —
# '분황사'(317503) ↔ '분황사 청보리밭'(2774279, 40m)처럼 한쪽 이름이 다른 쪽을 품는 이웃 명소는 TourAPI 가 이미 다른
# 곳으로 나눈 것이다. 시드·Kakao 행(contentid 없음)과는 음식점과 같은 이름 규칙(품음 포함)을 쓴다.
ATTRACTION_DUPLICATE_GUARD_MAX_M = 300.0
_FOOD_TYPES = frozenset({"restaurant", "cafe"})
# 가게 이름 끝의 지점 표시('본점'·'경주본점'·'황리단길점'·'2호점' 등). 가드는 이것을 뗀 이름으로도 한 번 더 견준다 —
# 2026-09-29 리뷰: '교리김밥 본점'(TourAPI) ↔ '교리김밥 경주본점'(Kakao, 같은 주소 0m)은 어느 쪽도 다른 쪽을 품지 않아
# 가드를 지나쳤다. 뗀 이름끼리는 같을 때, 또는 짧은 쪽이 3글자 이상일 때만 품음을 본다(2글자 '카페' 같은 오탐 방지).
_BRANCH_SUFFIX = re.compile(r"(?:경주|황리단길|황남|보문|불국사)*(?:본점|직영점|\d+호점|점)$")

# 목록 호출(locationBasedList2·areaBasedSyncList2)의 일시 실패 재시도 간격(초).
# 2026-09 일배치 실패는 전부 첫 locationBasedList2 가 10초 httpx 타임아웃(str 이 빈 문자열 — 로그상 `error=` 공란)으로
# 죽은 것이었고, 목록은 재시도가 없어 한 번의 네트워크 끊김이 배치 전체를 죽였다. 4회 시도·최대 약 2분.
# 상세 호출은 이미 건별 부분 실패를 허용하므로 재시도하지 않는다(쿼터·총 소요시간 보호).
LIST_RETRY_DELAYS_S: tuple[float, ...] = (5.0, 15.0, 45.0)

# 목록 호출이 위 재시도를 다 쓰고도 일시 오류일 때의 종료 코드(sysexits.h EX_TEMPFAIL).
# ingest.yml 은 이 값일 때만 새 러너로 다시 돈다. run() 이 fetch_pois 경계에서만 이 값을 돌려주므로
# 75 는 언제나 "상세 조회 전·DB 쓰기 전"을 뜻한다 — 상세 조회 뒤의 실패가 재실행으로 쿼터를 두세 배
# 태우지 않게. (os.EX_TEMPFAIL 은 Windows 에 없어 상수로 둔다.)
EXIT_TEMPFAIL = 75

# enrich_row 가 행에 남기는 판정 표시 — "TourAPI 가 대표 이미지가 없다고 답했다"(detailCommon2 가 상세 항목을
# 돌려줬고 목록 firstimage·상세 firstimage 가 모두 빈 값 — 항목 0개 응답은 확인이 아니다). _write_payload 는 이 표시가 있을 때만 image_url=None 을
# 보내 DB 의 옛 사진을 지우고, 밑줄로 시작하는 키는 DB 로 보내지 않는다.
IMAGE_CONFIRMED_ABSENT = "_image_confirmed_absent"
# features.image_source 의 provider — 지금 이 출처를 쓰는 곳은 enrich_row 의 Wikimedia 대체 사진 하나뿐이다.
WIKIMEDIA_PROVIDER = "Wikimedia Commons"


async def _list_call_with_retry(label: str, call):
    """목록 호출을 일시 실패(TourAPITransientError)에 한해 LIST_RETRY_DELAYS_S 간격으로 재시도한다.

    resultCode 오류(키·쿼터·파라미터)는 다시 불러도 같으므로 즉시 올린다.
    `call` 은 매번 새 코루틴을 만드는 0-인자 함수다(코루틴은 한 번만 await 할 수 있다).
    """
    for attempt in range(len(LIST_RETRY_DELAYS_S) + 1):
        try:
            return await call()
        except TourAPITransientError:
            if attempt >= len(LIST_RETRY_DELAYS_S):
                raise
            delay = LIST_RETRY_DELAYS_S[attempt]
            print(f"[retry] {label} 일시 실패 — {delay:g}초 후 재시도 ({attempt + 1}/{len(LIST_RETRY_DELAYS_S)})")
            await asyncio.sleep(delay)


async def fetch_ldong_items(ctid: int) -> list[dict]:
    """법정동 코드(경북 47·경주 130) areaBasedList2 목록 전량. 일시 실패는 목록 호출과 같은 규칙으로 재시도한다."""
    items: list[dict] = []
    page = 1
    while True:
        payload = await _list_call_with_retry(
            f"areaBasedList2(lDong, type={ctid}, page={page})",
            lambda ctid=ctid, page=page: area_based_list(
                content_type_id=ctid, page=page, rows=LDONG_PAGE_ROWS,
                ldong_regn_cd=LDONG_REGN_CD, ldong_signgu_cd=LDONG_SIGNGU_CD,
            ),
        )
        page_items = parse_items(payload)
        items.extend(page_items)
        if not page_items or len(items) >= parse_total_count(payload) or len(page_items) < LDONG_PAGE_ROWS:
            return items
        page += 1


async def _merge_ldong_items(
    items: list[dict], ctid: int, lat: float, lng: float, radius_m: int,
) -> list[dict]:
    """반경 목록(items)에 법정동 목록 가운데 반경 안·아직 없는 contentid 만 덧붙인다(반경 목록 쪽이 이긴다).

    법정동 목록은 보탬이다 — 실패하면(재시도 뒤 일시 오류 포함) 경고만 남기고 반경 목록만 쓴다. 이미 있는 행은
    지워지지 않고 그날 갱신만 빠진다. 종료 코드 75(새 러너 재실행)는 여전히 반경 목록 실패에서만 나온다.
    """
    label = TYPE_LABELS.get(ctid, ctid)
    try:
        ldong_items = await fetch_ldong_items(ctid)
    except RuntimeError as e:  # TourAPIError(재시도 뒤 일시 오류 포함)와 키 미설정 RuntimeError.
        print(f"[fetch] {label}: 법정동 목록 실패 — 반경 목록만 씁니다: {e}")
        return items
    seen = {str(item.get("contentid")) for item in items if item.get("contentid") not in (None, "")}
    added = 0
    for item in ldong_items:
        contentid = item.get("contentid")
        if contentid in (None, "") or str(contentid) in seen:
            continue
        try:
            distance = calculate_haversine_distance(lat, lng, float(item["mapy"]), float(item["mapx"]))
        except (KeyError, TypeError, ValueError):
            continue
        if distance > radius_m:
            continue
        seen.add(str(contentid))
        items.append({**item, LDONG_ONLY_MARK: True})  # 원본(목록 캐시)은 건드리지 않는다
        added += 1
    print(f"[fetch] {label}: 법정동 목록 {len(ldong_items)}건 중 반경 안 새 contentid {added}건 추가")
    return items


async def fetch_pois(lat: float, lng: float, radius_m: int, limit: int) -> dict[int, list[dict]]:
    """contentTypeId 별로 반경 조회를 페이지네이션하며 원본 item 을 수집한다.

    LDONG_CONTENT_TYPE_IDS(관광지·문화시설·음식점)는 법정동 목록의 반경 안 항목을 contentid 로 합친다(_merge_ldong_items).
    limit > 0 이면 타입별 최대 limit 건까지만 수집(쿼터 절약용).
    """
    collected: dict[int, list[dict]] = {}
    for ctid in CONTENT_TYPE_IDS:
        items: list[dict] = []
        page = 1
        while True:
            payload = await _list_call_with_retry(
                f"locationBasedList2(type={ctid}, page={page})",
                lambda ctid=ctid, page=page: location_based_list(
                    map_x=lng, map_y=lat, radius_m=radius_m,
                    content_type_id=ctid, page=page, rows=PAGE_ROWS,
                ),
            )
            page_items = parse_items(payload)
            items.extend(page_items)
            total = parse_total_count(payload)
            if not page_items or len(items) >= total:
                break
            if limit and len(items) >= limit:
                break
            page += 1
        if ctid in LDONG_CONTENT_TYPE_IDS:
            items = await _merge_ldong_items(items, ctid, lat, lng, radius_m)
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

    키는 값을 실제로 얻었을 때만 넣는다 — 호출이 실패했거나 빈 값이 오면 키가 없고, 없는 키는
    facilities 에 쓰이지 않아 기존 값이 남는다(upsert_facilities). 빈 응답으로 기존 값을 지우는 경로는
    대표 이미지 하나뿐이다 — detailCommon2 가 상세 항목을 돌려줬는데 목록·상세 firstimage 가 모두 비었을 때
    (IMAGE_CONFIRMED_ABSENT).
    """
    contentid = row["contentid"]
    ctid = row["contenttypeid"]
    # common_item_seen: detailCommon2 가 상세 항목을 실제로 돌려줬다. 정상 코드(0000)에 항목 0개인 응답은
    # 아무것도 확인해 주지 않는다 — 대표 이미지가 없다는 판정·Wikimedia 대체의 근거가 되지 못한다.
    common_item_seen = image_answered = False
    try:
        common_payload = await detail_common(contentid)
        common_items = parse_items(common_payload)
        if common_items:
            common = extract_detail_common(common_items[0])
            # image_url 은 locationBasedList2 의 firstimage 를 우선 — 없을 때만 폴백으로 채운다.
            if row.get("image_url"):
                common.pop("image_url", None)
            row.update(common)
            common_item_seen = True
    except (TourAPIError, RuntimeError) as e:
        print(f"[details] detailCommon2 실패 (contentid={contentid}): {e}")
    # 대표 이미지는 목록 firstimage 가 먼저, detailCommon2 firstimage 가 폴백이다. detailCommon2 가 상세 항목을
    # 돌려줬는데도 둘 다 비었으면 TourAPI 가 사진을 거둔 것이다 — 그날만 image_url 을 지운다(_write_payload).
    # 호출이 실패했거나 항목 없이 답한 날은 모르는 것이므로 표시하지 않아 DB 의 기존 사진이 남는다.
    if common_item_seen and not row.get("image_url"):
        row[IMAGE_CONFIRMED_ABSENT] = True
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
        image_answered = True
    except (TourAPIError, RuntimeError) as e:
        print(f"[details] detailImage2 실패 (contentid={contentid}): {e}")

    # 예전 밤의 Wikimedia 대체 사진·출처를 오늘 TourAPI 사진으로 걷어 내는 판정은 여기서 하지 않는다 — 기존
    # features(옛 출처)를 아는 upsert_facilities 가 사진과 출처를 함께 지운다(_retire_superseded_wikimedia).

    # TourAPI 사진이 전혀 없는 관광지·문화시설만 보수적으로 Wikimedia 퍼블릭 도메인 폴백.
    # '사진이 없다'는 사진을 주는 두 호출(detailCommon2 대표 이미지 · detailImage2 갤러리)이 모두 답했을 때만
    # 안다 — detailCommon2 는 상세 항목까지 돌려줘야 한다(항목 0개는 대표 이미지에 대해 아무것도 말하지 않는다).
    # 하나라도 모르는 날 대체 사진을 넣으면 DB 에 있던 TourAPI 사진(대표·갤러리 최대 5장)을 Wikimedia 로 덮는다.
    # detailImage2 의 항목 0개 응답도 저장된 갤러리가 사라졌다고 확인해 주지 않는다 — 저장된 갤러리에 TourAPI
    # 사진이 있으면 upsert_facilities(_retire_superseded_wikimedia)가 이 대체 사진과 출처를 버린다.
    if (ctid in {12, 14} and common_item_seen and image_answered
            and not row.get("image_url") and not row.get("gallery_images")):
        try:
            wikimedia = await find_reusable_place_image(
                str(row["name"]), float(row["latitude"]), float(row["longitude"])
            )
            if wikimedia:
                row["gallery_images"] = [wikimedia["url"]]
                row["features"] = {**row.get("features", {}), "image_source": {
                    "provider": WIKIMEDIA_PROVIDER,
                    "source_url": wikimedia["source_url"],
                    "license": wikimedia["license"],
                    "artist": wikimedia["artist"],
                }}
        # 대체 사진은 선택 기능이다 — MediaWiki 의 이상 응답(StopIteration→RuntimeError, 빈 imageinfo→IndexError 등)이
        # 밤 적재 전체를 멈추지 않게 어떤 예외든 이 행의 대체 사진만 건너뛴다.
        except Exception as e:  # noqa: BLE001
            print(f"[details] Wikimedia 이미지 폴백 실패 (contentid={contentid}): {type(e).__name__}: {e}")


def _normalize_name(value) -> str:
    return "".join(str(value or "").split()).casefold()


def _core_name(normalized: str) -> str:
    """정규화 이름에서 끝의 지점 표시(_BRANCH_SUFFIX)를 뗀다. 떼고 2글자 미만이면 원래 이름."""
    core = _BRANCH_SUFFIX.sub("", normalized)
    return core if len(core) >= 2 else normalized


def _same_place_name(name: str, other: str) -> bool:
    """가드의 이름 판정 — 정규화 이름이 같거나 한쪽이 다른 쪽을 품거나, 지점 표시를 뗀 이름이 같거나
    (짧은 쪽이 3글자 이상일 때) 한쪽이 다른 쪽을 품는다."""
    if name == other or name in other or other in name:
        return True
    core, other_core = _core_name(name), _core_name(other)
    if core == other_core:
        return True
    shorter, longer = sorted((core, other_core), key=len)
    return len(shorter) >= 3 and shorter in longer


def _same_record_name(name: str, other: str) -> bool:
    """관광지 새 행 ↔ 다른 TourAPI 레코드의 이름 판정 — 정규화 이름이나 지점 표시를 뗀 이름이 같을 때만(품음은 보지 않는다)."""
    return name == other or _core_name(name) == _core_name(other)


def find_probable_duplicates(rows: list[dict], facilities: list[dict]) -> dict[str, dict]:
    """새 contentid 행 가운데 같은 가게가 이미 다른 행으로 있는 것 → {contentid: 그 시설 요약}(순수 함수).

    facilities 는 DB 전량(id·name·type·latitude·longitude·contentid·is_active). DB 에 이미 있는 contentid 는 평소처럼
    갱신되므로 보지 않는다. 판정: 같은 부류(음식점·카페 / 그 밖), 살아 있는 행(is_active 가 false 가 아님), 이름이
    같은 가게로 보임(_same_place_name — 둘 다 2글자 이상), 거리 DUPLICATE_GUARD_MAX_M 이하. 가장 가까운 시설을 돌려준다.
    관광지 새 행은 거리 ATTRACTION_DUPLICATE_GUARD_MAX_M 까지 보고, 다른 TourAPI 레코드와는 같은 이름일 때만 겹친다
    (_same_record_name — 위 상수 주석). 요약의 manual 은 겹친 행이 TourAPI 레코드가 아닌(시드·Kakao) 행인지다.
    """
    known = {str(f.get("contentid")) for f in facilities if f.get("contentid") not in (None, "")}
    pool = []
    for facility in facilities:
        if facility.get("is_active") is False:
            continue
        name = _normalize_name(facility.get("name"))
        try:
            f_lat, f_lng = float(facility["latitude"]), float(facility["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        if len(name) >= 2:
            pool.append((facility, name, f_lat, f_lng, facility.get("type") in _FOOD_TYPES))
    duplicates: dict[str, dict] = {}
    for row in rows:
        contentid = str(row.get("contentid"))
        name = _normalize_name(row.get("name"))
        if contentid in known or len(name) < 2:
            continue
        food = row.get("type") in _FOOD_TYPES
        attraction = row.get("type") == "attraction"
        max_m = ATTRACTION_DUPLICATE_GUARD_MAX_M if attraction else DUPLICATE_GUARD_MAX_M
        best, best_distance = None, float("inf")
        for facility, f_name, f_lat, f_lng, f_food in pool:
            if f_food != food:
                continue
            record = facility.get("contentid") not in (None, "")
            same = _same_record_name(name, f_name) if attraction and record else _same_place_name(name, f_name)
            if not same:
                continue
            distance = calculate_haversine_distance(float(row["latitude"]), float(row["longitude"]), f_lat, f_lng)
            if distance <= max_m and distance < best_distance:
                best, best_distance = facility, distance
        if best is not None:
            duplicates[contentid] = {"id": best.get("id"), "name": best.get("name"),
                                     "contentid": best.get("contentid"), "distance_m": best_distance,
                                     "manual": best.get("contentid") in (None, "")}
    return duplicates


_PLACE_PREFIX = re.compile(r"^경주")
_PLACE_SUFFIX = re.compile(r"일원$")


def _place_key(normalized: str) -> str:
    """이웃 관광지 대조용 이름 — 정규화 이름에서 앞의 '경주'와 끝의 '일원'을 뗀다('경주대릉원일원' → '대릉원')."""
    key = _PLACE_SUFFIX.sub("", _PLACE_PREFIX.sub("", normalized))
    return key if len(key) >= 2 else normalized


def find_attraction_overlaps(rows: list[dict], facilities: list[dict]) -> list[dict]:
    """오늘 넣는 관광지 새 행 가운데, 한쪽 이름이 다른 쪽을 품는 관광지가 ATTRACTION_DUPLICATE_GUARD_MAX_M 안에 있는 쌍(순수 함수).

    가드는 다른 TourAPI 레코드와는 같은 이름일 때만 막는다(분황사 ↔ 분황사 청보리밭은 TourAPI 가 나눈 이웃 명소). 그래도
    한 곳에 카드가 두 장으로 보일 수 있는 쌍은 넣되 로그로 남겨 사람이 고른다 — 2026-09-29 리뷰: 새 '경주 대릉원 일원' ↔
    기존 '천마총(대릉원)' 204m, 새 '금장대' ↔ 새 '금장대 수변공원' 265m(새 행끼리는 가드가 서로 견주지 않는다).
    rows 는 가드를 지난(넣을) 행, facilities 는 DB 전량. 상대는 다른 새 관광지 행과 살아 있는 TourAPI 레코드(시드·Kakao 행은
    가드가 품음까지 이미 본다). 음식점·카페는 보지 않는다. 결과는 새 행 contentid 순, 새 행끼리의 쌍은 한 번만.
    """
    known = {str(f.get("contentid")) for f in facilities if f.get("contentid") not in (None, "")}
    new = []
    for row in rows:
        contentid = str(row.get("contentid"))
        if row.get("type") != "attraction" or contentid in known:
            continue
        try:
            lat, lng = float(row["latitude"]), float(row["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        new.append((contentid, row.get("name"), _place_key(_normalize_name(row.get("name"))), lat, lng))
    others = [(c, n, k, a, b, True) for c, n, k, a, b in new]
    for facility in facilities:
        if (facility.get("is_active") is False or facility.get("contentid") in (None, "")
                or facility.get("type") in _FOOD_TYPES):
            continue
        try:
            f_lat, f_lng = float(facility["latitude"]), float(facility["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        others.append((str(facility.get("contentid")), facility.get("name"),
                       _place_key(_normalize_name(facility.get("name"))), f_lat, f_lng, False))
    pairs: list[dict] = []
    for contentid, name, key, lat, lng in sorted(new, key=lambda n: n[0]):
        for o_cid, o_name, o_key, o_lat, o_lng, o_new in others:
            if o_cid == contentid or (o_new and o_cid < contentid):
                continue
            shorter, longer = sorted((key, o_key), key=len)
            if len(shorter) < 2 or shorter not in longer:
                continue
            distance = calculate_haversine_distance(lat, lng, o_lat, o_lng)
            if distance <= ATTRACTION_DUPLICATE_GUARD_MAX_M:
                pairs.append({"contentid": contentid, "name": name, "other_contentid": o_cid, "other_name": o_name,
                              "other_new": o_new, "distance_m": distance})
    return pairs


def _load_guard_facilities() -> list[dict]:
    # DB 클라이언트는 여기서 지연 임포트 — --dry-run 경로에서 Supabase 연결을 만들지 않는다.
    from app.core.supabase import fetch_all_rows, supabase_admin

    # 전량이어야 한다 — 잘리면 빠진 시설과 겹치는 새 행이 중복으로 들어간다.
    return fetch_all_rows(
        supabase_admin,
        "facilities",
        "id, name, type, latitude, longitude, contentid, is_active",
        apply_filters=lambda q: q.order("id"),
    )


def photo_less_new_ldong_contentids(rows: list[dict], facilities: list[dict], ldong_only: set[str]) -> set[str]:
    """법정동 목록에만 나온 **새** 행(DB 에 없는 contentid) 가운데 목록 대표 사진(firstimage → image_url)이 없는 것(순수 함수).

    PM 승인 범위(2026-09-29)는 '사진이 있는 새 장소'다. 사진 없는 새 카드(예: 경주문화원 130030 — 문화시설 칸이
    승인한 3장을 넘어 4장이 되고 그중 한 장이 사진 없음)는 넣지 않는다. 이미 DB 에 있는 행(사람이 contentid 를
    이은 Kakao 행 포함)은 사진이 없어도 평소처럼 갱신한다. 반경 목록 행은 도입 전 동작 그대로 둔다.
    """
    known = {str(f.get("contentid")) for f in facilities if f.get("contentid") not in (None, "")}
    return {
        str(row.get("contentid")) for row in rows
        if str(row.get("contentid")) in ldong_only
        and str(row.get("contentid")) not in known
        and not str(row.get("image_url") or "").strip()
    }


def probable_duplicate_contentids(rows: list[dict], ldong_only: set[str]) -> set[str]:
    """오늘 넣지 않을 새 행의 contentid — 같은 가게가 이미 있는 행(find_probable_duplicates)과 법정동 목록에만 나온
    사진 없는 새 행(photo_less_new_ldong_contentids). 기존 시설 조회가 실패하면 법정동 목록에만 나온 곳을 전부 뺀다
    (중복을 가릴 수 없으면 도입 전 동작 — 반경 목록만 — 으로 돌아간다. 반경 목록의 옛 신라고분정보센터 3442528 은
    EXCLUDED_CONTENTIDS 가 따로 막는다)."""
    try:
        facilities = _load_guard_facilities()
    except Exception as e:  # noqa: BLE001 — 가드 조회 실패가 적재 전체를 멈추지 않게.
        print(f"[dedupe] 기존 시설 조회 실패({type(e).__name__}) — 법정동 목록에만 나온 {len(ldong_only)}곳은 오늘 넣지 않습니다")
        return set(ldong_only)
    duplicates = find_probable_duplicates(rows, facilities)
    for contentid, hit in sorted(duplicates.items()):
        name = next((r.get("name") for r in rows if str(r.get("contentid")) == contentid), "")
        kind = "시드·Kakao 행 — 이을지 PM 결정" if hit.get("manual") else "다른 TourAPI 레코드"
        print(f"[dedupe] 새 행 넣지 않음: {name}(contentid={contentid}) ≈ 기존 {hit['name']}"
              f"(id={hit['id']}, contentid={hit['contentid']}, {hit['distance_m']:.0f}m, {kind})"
              " — 이으려면 그 행에 contentid 를 넣는다")
    photo_less = photo_less_new_ldong_contentids(rows, facilities, ldong_only) - set(duplicates)
    for contentid in sorted(photo_less):
        name = next((r.get("name") for r in rows if str(r.get("contentid")) == contentid), "")
        print(f"[dedupe] 사진 없는 새 행 넣지 않음: {name}(contentid={contentid}) — 법정동 목록 대표 사진 없음")
    drop = set(duplicates) | photo_less
    kept = [row for row in rows if str(row.get("contentid")) not in drop]
    for pair in find_attraction_overlaps(kept, facilities):
        other = "새 행" if pair["other_new"] else "기존 카드"
        print(f"[dedupe] 이름이 겹치는 이웃 관광지(둘 다 뜸 — 하나만 둘지 PM 확인): {pair['name']}(contentid={pair['contentid']})"
              f" ↔ {pair['other_name']}(contentid={pair['other_contentid']}, {other}) {pair['distance_m']:.0f}m")
    return drop


def _uniform_key_chunks(rows: list[dict]) -> list[list[dict]]:
    """rows 를 키 집합이 같은 행끼리 묶은 뒤 UPSERT_CHUNK 이하 조각으로 나눈다.

    왜: postgrest-py(2.31 확인)의 bulk upsert·insert 는 `columns=` 를 **조각 안 모든 행의 키 합집합**으로
    보내고(default_to_null=True), PostgREST 는 그 열 가운데 행에 없는 값을 NULL 로 채워 쓴다. 그래서
    상세 조회가 실패해 overview 가 없는 행이 overview 가 있는 행과 같은 조각에 들어가면 overview=NULL 로
    덮인다(phone·homepage·operating_hours·barrier_free·gallery_images 도 같다). 키 집합이 같은 행끼리만
    보내면 합집합이 곧 각 행의 키라 빈칸 채우기가 생기지 않는다 — 행에 없는 열은 요청에 아예 없다.

    묶음은 처음 나온 순서, 묶음 안은 입력 순서 그대로다. 조각 크기는 호출 시점의 UPSERT_CHUNK.
    """
    groups: dict[frozenset, list[dict]] = {}
    for row in rows:
        groups.setdefault(frozenset(row), []).append(row)
    return [
        group[i:i + UPSERT_CHUNK]
        for group in groups.values()
        for i in range(0, len(group), UPSERT_CHUNK)
    ]


def _write_payload(row: dict, *, keep_coordinates: bool = False) -> dict:
    """한 행을 facilities 에 보낼 모양으로 만든다 — 이 배치가 모르는 값은 보내지 않는다(기존 값 유지).

    - 값이 None 인 열은 뺀다. None 은 "이번에 얻지 못했다"이지 "비워라"가 아니다. 지금 None 이 되는 열은
      image_url(목록 firstimage 도 상세 폴백도 없을 때)과 address(addr1 빈 값)뿐인데, 보내면 전날 상세 폴백이
      채운 대표 이미지나 Kakao 보완 배치가 채운 주소를 NULL 로 지운다.
    - 예외 하나: image_url 은 TourAPI 가 "대표 이미지 없음"을 확인해 준 날(IMAGE_CONFIRMED_ABSENT — detailCommon2
      가 상세 항목을 돌려줬고 목록·상세 firstimage 가 모두 빈 값)에는 None 을 보내 지운다. 거둔 사진이 DB 에 영원히 남거나,
      Wikimedia 대체 사진(두 사진 호출이 모두 답한 날에만 생긴다)의 출처 아래 옛 TourAPI 사진이 뜨지 않게.
      address 에는 이런 "확인된 부재" 신호가 없다 — 주소는 목록 addr1 에서만 오고(detailCommon2 추출에 주소가
      없다) 빈 addr1 은 "TourAPI 에 없음"일 뿐 "장소에 주소가 없음"이 아니다. 기존 주소는 Kakao 보완 배치가
      채운 값일 수 있으므로 None 이면 계속 보내지 않는다.
    - capacity 는 기존 행에도 보낸다 — transform 의 CAPACITY_DEFAULTS(타입별 합성 기본값)로 매일 밤 다시 쓴다.
      PM 결정(2026-09-28): 10월 심사가 끝날 때까지 이 초기화를 유지한다(main 3cf5bf9 와 같은 동작). 심사위원이
      공유 관리자 계정으로 수용 인원을 잘못 고쳐도 다음 날 데모가 기본값으로 돌아온다. capacity 는 INT NOT NULL
      이라 None 이면 위 규칙대로 빠진다(NULL 을 보내지 않는다). 심사 후 과제: 관리자가 고친 값에 표시(예: 관리자
      PATCH 가 features.capacity_source='admin')를 남기고 그 행만 건너뛴다.
    - keep_coordinates 면 latitude·longitude 를 뺀다. DB 좌표가 Kakao 로 검증된 값인데(features.coordinate_source
      ='kakao') 이번 실행에서 Kakao 매칭을 얻지 못한 행이다 — 모르는 값(TourAPI 원 좌표)이 검증된 값을 덮지 않게
      (upsert_facilities 가 판정한다).
    - 밑줄로 시작하는 키(배치 안 판정 표시)는 보내지 않는다.
    """
    clear_image = bool(row.get(IMAGE_CONFIRMED_ABSENT)) and not row.get("image_url")
    return {
        key: value
        for key, value in row.items()
        if not key.startswith("_")
        and (value is not None or (key == "image_url" and clear_image))
        and not (keep_coordinates and key in ("latitude", "longitude"))
    }


def _is_wikimedia_credit(source) -> bool:
    return isinstance(source, dict) and source.get("provider") == WIKIMEDIA_PROVIDER


def _is_wikimedia_url(url) -> bool:
    """Wikimedia 대체 사진 URL 인가 — find_reusable_place_image 는 upload.wikimedia.org 썸네일을 준다."""
    if not isinstance(url, str):
        return False
    try:
        host = (urlparse(url.strip()).hostname or "").lower()
    except ValueError:  # 호스트에 [ ] 가 섞인 깨진 URL — 판정만 거짓으로, 적재는 멈추지 않는다.
        return False
    return host == "wikimedia.org" or host.endswith(".wikimedia.org")


def _retire_superseded_wikimedia(row: dict, prev: dict) -> None:
    """Wikimedia 사진과 그 출처를 **한 쌍으로** 맞춘다 — 저장된 행(prev: features·image_url·gallery_images)을 보고
    이번 행을 제자리 수정한다. 이름은 역사적이다: 처음에는 '옛 Wikimedia 를 걷어 내기'만 했다.

    Wikimedia 대체 사진은 gallery_images 에만 들어가고 출처는 features.image_source 에 있다. 웹은
    [image_url, ...gallery_images] 를 차례로 시도해 대표 사진이 깨지면 갤러리 사진을 띄운다. PM 규칙(2026-09-28):
    사진은 호출 실패로 지우지 않고, CC BY/BY-SA Wikimedia 사진은 출처 없이 저장·표시되지 않으며, 출처는 늘 보이는
    사진과 맞는다.

    1. 이번 행이 새 Wikimedia 대체 사진을 들고 왔는데 저장된 갤러리에 TourAPI 사진이 있으면 대체를 버린다 —
       detailImage2 의 항목 0개 응답은 '갤러리가 사라졌다'를 확인해 주지 않는다(detailCommon2 의 항목 0개와
       같은 규칙). 저장된 TourAPI 갤러리가 남고, 대체 출처도 싣지 않는다. 저장된 TourAPI 갤러리가 없으면
       대체 사진과 출처가 한 쌍으로 들어간다(아래는 할 일이 없다).
    2. 옛 출처가 Wikimedia 가 아니면 여기서 끝난다.
    3. 오늘 TourAPI 사진(대표 image_url 또는 TourAPI 갤러리)을 얻었으면 저장된 갤러리의 Wikimedia 사진만 뺀다.
       TourAPI 갤러리 사진은 그대로 둔다 — gallery_images 는 바뀔 때만 싣고, 저장된 TourAPI 사진이 있는데 []
       를 보내지 않는다. 오늘 TourAPI 사진이 없으면 Wikimedia 사진을 빼지 않는다(호출 실패로 지우지 않는다).
    4. 이 쓰기 뒤에도 Wikimedia 사진이 남는지 본다. 남지 않으면 옛 출처는 TourAPI 사진 아래 뜨는 틀린 출처라
       image_source=None 을 싣는다({**기존, **신규} 병합이 옛 출처를 덮는다 — 웹은 null 을 없는 값처럼 다룬다).
       main 3cf5bf9 가 남긴 행(Wikimedia 갤러리가 나중에 TourAPI 갤러리로 바뀌었는데 출처는 그대로)이 이 경우다.
       사진은 하나도 지우지 않는다.
    """
    own = row.get("features") or {}
    stored_gallery = [u for u in (prev.get("gallery_images") or []) if isinstance(u, str) and u]
    if _is_wikimedia_credit(own.get("image_source")):
        if not [u for u in stored_gallery if not _is_wikimedia_url(u)]:
            return
        row.pop("gallery_images", None)
        own = {k: v for k, v in own.items() if k != "image_source"}
        row["features"] = own
    if not _is_wikimedia_credit((prev.get("features") or {}).get("image_source")):
        return
    # 이번 쓰기 뒤 DB 의 갤러리 — 행에 gallery_images 가 있으면 그 값(오늘 TourAPI 갤러리), 없으면 저장된 값.
    gallery = row["gallery_images"] if row.get("gallery_images") is not None else stored_gallery
    if row.get("image_url") or row.get("gallery_images"):
        kept = [u for u in gallery if not _is_wikimedia_url(u)]
        if kept != gallery:
            row["gallery_images"] = kept
            gallery = kept
    if not [u for u in gallery if _is_wikimedia_url(u)]:
        row["features"] = {**own, "image_source": None}


def upsert_facilities(rows: list[dict]) -> int:
    """facilities 에 contentid 기준 upsert. 성공 행 수를 반환.

    1차: PostgREST upsert(on_conflict='contentid') — 부분 유니크 인덱스(uq_facilities_contentid,
         WHERE contentid IS NOT NULL) 를 충돌 대상으로 사용한다.
    2차(폴백): 1차가 실패하면 아직 못 쓴 행만 — 신규는 INSERT, 기존은 행마다 UPDATE.
         실측(ingest.yml 로그 09-21~09-27): 운영 DB 에서 1차는 매번 42P10 으로 실패한다(부분 인덱스는
         ON CONFLICT(contentid) 의 추론 대상이 아니다). 그래서 **지금 실제로 도는 경로는 폴백**이다.
         충돌 대상이 살아난 뒤 1차가 중간 조각에서 실패하더라도 폴백은 남은 행만 이어 쓰므로 이미 쓴 행을
         다시 넣지 않는다.

    쓰는 값(_write_payload): 행에 있는 키만, None 은 빼고(capacity 는 기존 행에도 기본값으로). bulk 요청은 키 집합이 같은
    행끼리만 묶는다(_uniform_key_chunks) — 섞이면 postgrest-py 가 없는 키를 NULL 로 채운다.

    features 병합(2026-07-17, P0 수정): 두 경로 모두 쓰기 전에 기존 features 와 {**기존, **신규}
    병합한다. 통째 교체하면 이 배치 밖에서 축적된 키 — overview_i18n(번역 배치), image_source
    (Wikimedia 라이선스) 등 — 가 일배치마다 소실된다(실측: 번역 67곳이 다음 cron 에 전멸할 뻔).
    transform/enrich 가 만드는 키는 신규 값이 이기고, 배치가 모르는 키는 보존된다.
    병합 직전 _retire_superseded_wikimedia 가 저장된 사진(image_url·gallery_images)과 견줘 Wikimedia 사진과 출처를
    한 쌍으로 맞춘다 — 그래서 기존 행 SELECT 는 features 와 함께 두 사진 열도 읽는다(한 번, 약 90행).
    경주시 음식점 사진(features.city_photo)도 같은 자리에서 retire_superseded_city_photo 가 맞춘다.
    """
    # DB 클라이언트는 여기서 지연 임포트 — --dry-run 경로에서 Supabase 연결을 만들지 않는다.
    from app.core.supabase import fetch_all_rows, supabase_admin

    try:
        # 전량이어야 한다. 잘린 페이지로 병합하면 **빠진 시설의 features 가 통째로 덮여** 번역·
        # 음식태그 같은 축적 키가 사라진다 — 바로 아래 except 가 fail-closed 로 막으려는 그 사고를,
        # 캡 절단은 오류 없이(200) 일으킨다. 지금은 contentid 보유 시설이 89곳이라 잠재적이다.
        existing_rows = fetch_all_rows(
            supabase_admin,
            "facilities",
            "contentid, features, image_url, gallery_images",
            apply_filters=lambda q: q.not_.is_("contentid", "null").order("contentid"),
        )
    except Exception as e:  # noqa: BLE001
        # 기존 features 를 모르면 병합 불가 → 진행하면 번역 등 축적 키가 소실된다. fail-closed 중단.
        print(f"[upsert] 기존 features 조회 실패({e}) — features 소실 방지를 위해 upsert 를 중단합니다")
        return 0
    existing_by_id: dict[str, dict] = {r["contentid"]: r for r in existing_rows if r.get("contentid")}
    existing_features: dict[str, dict] = {
        cid: (r.get("features") or {}) for cid, r in existing_by_id.items()
    }
    # Kakao 로 검증된 좌표 보존: 좌표의 정본은 Kakao 다(run 의 reconcile_row_coordinate). 이번 실행에서 매칭을
    # 얻지 못한 행(타임아웃·동점 후보·키 미설정)은 TourAPI 원 좌표를 들고 있는데, 그대로 보내면 DB 의 Kakao
    # 좌표가 되돌아가고 병합된 features 는 여전히 coordinate_source='kakao' 라고 말한다. 매칭 성공 여부는
    # 병합 **전** 이번 행의 features 로 본다 — 성공했을 때만 reconcile 이 coordinate_source 를 넣는다.
    keep_coordinates: set[str] = set()
    for row in rows:
        stored = existing_by_id.get(row.get("contentid"))
        if stored is not None:
            prev = existing_features[row["contentid"]]
            if (prev.get("coordinate_source") == "kakao"
                    and (row.get("features") or {}).get("coordinate_source") != "kakao"):
                keep_coordinates.add(row["contentid"])
            # 병합 전 — 이번 행의 features 에 새 Wikimedia 출처가 있는지 옛 출처와 구분해 봐야 한다.
            _retire_superseded_wikimedia(row, stored)
            # 경주시 음식점 사진(features.city_photo)도 같은 한 쌍 규칙 — 오늘 TourAPI 사진이 생긴 행이면 사진과 출처를
            # 함께 뺀다(PM 이 Kakao 행에 contentid 를 이어 준 첫 밤이 이 경우다). 규칙 정본: services/batch/city_photo.py.
            retire_superseded_city_photo(row, stored, image_cleared=bool(row.get(IMAGE_CONFIRMED_ABSENT)))
            row["features"] = {**prev, **(row.get("features") or {})}

    # 기존/신규 판정(폴백의 INSERT/UPDATE 나눔)도 위 전량 SELECT 를 재사용한다(추가 왕복 없음).
    existing_ids = set(existing_features)
    payloads = [
        _write_payload(row, keep_coordinates=row["contentid"] in keep_coordinates)
        for row in rows
    ]

    written = 0
    chunks = _uniform_key_chunks(payloads)
    done_chunks = 0
    try:
        # 조각마다 키 집합이 같아야 한다 — 섞이면 없는 키가 NULL 로 덮인다(_uniform_key_chunks).
        for chunk in chunks:
            supabase_admin.table("facilities").upsert(chunk, on_conflict="contentid").execute()
            written += len(chunk)
            done_chunks += 1
        return written
    except Exception as e:
        print(f"[upsert] on_conflict=contentid upsert 실패({e}) — SELECT 후 INSERT/UPDATE 폴백으로 전환")

    # --- 폴백 경로: 1차가 아직 쓰지 못한 행만, 신규 INSERT / 기존 UPDATE ---
    # 1차에서 이미 쓴 조각까지 다시 INSERT 하면 유니크 위반으로 실패 로그만 남고 written 이 틀어진다.
    upserted_ids = {p["contentid"] for chunk in chunks[:done_chunks] for p in chunk}
    remaining = [p for p in payloads if p["contentid"] not in upserted_ids]
    new_rows = [p for p in remaining if p["contentid"] not in existing_ids]
    update_rows = [p for p in remaining if p["contentid"] in existing_ids]

    # bulk insert 도 columns= 합집합을 보낸다 — 신규 행이라도 없는 키가 열 기본값 대신 NULL 이 된다.
    # 조각이 실패하면 그 행들을 하나씩 다시 넣는다 — 이름 길이·제약 위반 같은 나쁜 행 하나가 같은 키 묶음의
    # 새 장소(최대 UPSERT_CHUNK 곳)를 매일 밤 함께 막지 않게. bulk INSERT 는 한 문장이라 실패하면 아무것도 쓰이지
    # 않았고, 설령 응답만 잃었어도 contentid 유니크 인덱스가 중복 행을 막는다(그 행은 실패 로그로 남는다).
    for chunk in _uniform_key_chunks(new_rows):
        try:
            supabase_admin.table("facilities").insert(chunk).execute()
            written += len(chunk)
            continue
        except Exception as e:
            print(f"[upsert] INSERT 배치 실패({len(chunk)}건): {e} — 행마다 다시 시도")
        if len(chunk) == 1:
            print(f"[upsert] INSERT 실패 (contentid={chunk[0]['contentid']})")
            continue
        for row in chunk:
            try:
                supabase_admin.table("facilities").insert([row]).execute()
                written += 1
            except Exception as e:
                print(f"[upsert] INSERT 실패 (contentid={row['contentid']}): {e}")

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
    area_code: int | None = SYNC_AREA_CODE, sigungu_code: int | None = SYNC_SIGUNGU_CODE,
    *, ldong_regn_cd: int | None = None, ldong_signgu_cd: int | None = None,
) -> dict[str, str]:
    """지역 전체 areaBasedSyncList2 를 페이지네이션 수집해 {contentid: showflag} 로 반환한다.

    modifiedtime 은 실측 무동작이라 쓰지 않는다(위 모듈 주석 참고) — 매 실행 지역 전체를 받는다.
    기본은 구 지역코드(35/2). 법정동 코드로 부르려면 area_code=None 과 ldong_* 를 준다.
    """
    showflag_by_id: dict[str, str] = {}
    page = 1
    region = f"lDong={ldong_regn_cd}/{ldong_signgu_cd}" if ldong_regn_cd else f"area={area_code}/{sigungu_code}"
    while True:
        payload = await _list_call_with_retry(
            f"areaBasedSyncList2({region}, page={page})",
            lambda page=page: area_based_sync_list(
                area_code=area_code, sigungu_code=sigungu_code, page=page, rows=SYNC_PAGE_ROWS,
                ldong_regn_cd=ldong_regn_cd, ldong_signgu_cd=ldong_signgu_cd,
            ),
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


async def fetch_gyeongju_showflags() -> dict[str, str]:
    """구 지역코드(35/2)와 법정동 코드(47/130) showflag 를 합친다 — 법정동 목록으로 들어온 행(구 코드가 빈 레코드)도
    폐업·표출중단을 감지하게(2026-09-29 실측 525건 → 753건). contentTypeId 를 주지 않으므로 관광지(12)도 함께 온다.
    둘 다 있는 contentid 는 구 코드 값(도입 전 동작)을 쓴다.
    법정동 조회가 실패하면 구 코드 결과만 쓴다(구 코드 실패는 도입 전처럼 올린다).
    """
    showflags = await fetch_showflag_map()
    try:
        ldong = await fetch_showflag_map(
            area_code=None, sigungu_code=None, ldong_regn_cd=LDONG_REGN_CD, ldong_signgu_cd=LDONG_SIGNGU_CD,
        )
    except RuntimeError as e:  # TourAPIError(일시 오류 포함)·키 미설정 — 구 코드 결과는 이미 얻었다.
        print(f"[sync] 법정동 showflag 조회 실패 — 구 지역코드 결과만 씁니다: {e}")
        return showflags
    added = sum(1 for contentid in ldong if contentid not in showflags)
    print(f"[sync] showflag: 구 지역코드 {len(showflags)}건 + 법정동에만 있는 {added}건")
    return {**ldong, **showflags}


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
    from app.core.supabase import fetch_all_rows, supabase_admin

    summary: dict = {"checked": 0, "deactivated": [], "reactivated": 0,
                     "reactivation_deferred": 0, "degraded": False, "reason": None}
    if not showflag_by_id:
        return summary

    try:
        # 전량이어야 한다 — 잘리면 빠진 시설이 showflag 대조에서 누락돼 영업/폐업 반영이 멈춘다.
        existing_rows = fetch_all_rows(
            supabase_admin,
            "facilities",
            "id, contentid, is_active, features",
            apply_filters=lambda q: q.not_.is_("contentid", "null").order("contentid"),
        )
    except Exception as e:
        summary["degraded"] = True
        summary["reason"] = f"facilities.is_active 조회 실패(컬럼 미존재/마이그레이션 미적용 가능성): {e}"
        return summary

    try:
        inactive_localdata_ids = {
            str(r["facility_id"])
            for r in (supabase_admin.table("facility_source_refs")
                      .select("facility_id,source_status").eq("source", "localdata").execute().data or [])
            if str(r.get("source_status") or "") != "01"
        }
    except Exception:
        # 마이그레이션 배포 전 하위호환. 배포 후에는 source ref가 공통 우선순위 정본이다.
        inactive_localdata_ids = set()

    for row in existing_rows:
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
                if str(contentid) in EXCLUDED_CONTENTIDS or is_manually_hidden(row.get("features")):
                    summary["reactivation_deferred"] += 1  # 사람이 뺀·숨긴 곳 — 표출 중이어도 켜지 않는다.
                    continue
                if str(row.get("id")) in inactive_localdata_ids:
                    summary["reactivation_deferred"] += 1
                    continue
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
    showflag_by_id = await fetch_gyeongju_showflags()
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


def _append_step_summary(line: str) -> None:
    """GitHub Actions 실행 Summary 에 한 줄 덧붙인다(GITHUB_STEP_SUMMARY 가 있을 때만, best-effort).

    부분 실패(written < 전체)는 종료 코드를 바꾸지 않는다 — ingest.yml 의 재시도 사슬이 종료 코드를 본다.
    대신 초록 실행에서도 몇 행이 빠졌는지 Summary 에서 바로 보이게 한다.
    """
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as summary:
            summary.write(line + "\n")
    except OSError as e:
        print(f"[summary] GITHUB_STEP_SUMMARY 기록 실패(적재 결과에는 영향 없음): {e}")


async def run(args: argparse.Namespace) -> int:
    try:
        collected = await fetch_pois(args.lat, args.lng, args.radius, args.limit)
    except TourAPITransientError as e:
        # 아직 상세 조회·DB 쓰기 전이다 — 새 러너 재실행이 싸고 안전한 유일한 지점.
        # 이 아래에서 나는 일시 오류는 main() 의 일반 경로(exit 1)로 간다.
        print(f"오류: {e} — 목록 호출이 재시도 후에도 일시 오류라 상세 조회 전에 멈춥니다(exit {EXIT_TEMPFAIL})")
        return EXIT_TEMPFAIL

    # 변환 (순수 함수 transform_poi — 비정형 item 은 None 으로 스킵)
    rows_by_type: dict[int, list[dict]] = {}
    skipped = 0
    excluded = 0
    seen_contentids: set[str] = set()
    ldong_only: set[str] = set()
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
            if row["contentid"] in EXCLUDED_CONTENTIDS:
                excluded += 1
                continue
            if isinstance(item, dict) and item.get(LDONG_ONLY_MARK):
                ldong_only.add(row["contentid"])
            rows.append(row)
        rows_by_type[ctid] = rows
    if excluded:
        print(f"[transform] 사람 결정으로 적재하지 않는 contentid {excluded}건(EXCLUDED_CONTENTIDS)")

    # 새 행 가드(중복 · 법정동 목록의 사진 없는 새 행) — 상세 조회(쿼터) 전에 거른다.
    # --dry-run 은 DB 를 읽지 않으므로 가드 없이 출력한다.
    if not args.dry_run:
        drop = probable_duplicate_contentids(
            [row for rows in rows_by_type.values() for row in rows], ldong_only,
        )
        if drop:
            rows_by_type = {
                ctid: [row for row in rows if row["contentid"] not in drop]
                for ctid, rows in rows_by_type.items()
            }
            print(f"[dedupe] 같은 가게가 이미 있거나 사진이 없어 새로 넣지 않은 행: {len(drop)}건")

    all_rows = [row for rows in rows_by_type.values() for row in rows]

    if args.details:
        print(f"[details] {len(all_rows)}건 상세 조회 시작 (POI 당 3회 호출 — 쿼터 주의)")
        for row in all_rows:
            await enrich_row(row)

    # 지도 좌표의 최종 정본은 Kakao. 키 미설정 또는 이름+주소/근접성 엄격 매칭 실패 시
    # 행은 TourAPI 좌표를 그대로 들고 간다. 원 좌표는 features.tourapi_coordinates에 보존된다.
    # 단, DB 좌표가 이미 Kakao 로 검증된 기존 행이면 upsert_facilities 가 좌표를 보내지 않는다(검증값 유지).
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
    _append_step_summary(f"- TourAPI 적재: written {written}/{len(all_rows)} (facilities)")

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
        # TOURAPI_KEY 미설정/호출 실패 등 — 트레이스백 없이 원인만 명확히 출력.
        # 여기로 온 TourAPITransientError 도 exit 1 이다 — 75 는 run() 의 목록 수집 경계에서만 나온다.
        print(f"오류: {e}")
        sys.exit(1)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
