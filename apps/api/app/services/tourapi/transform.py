"""TourAPI 응답 → NextSpot `facilities` 행 변환 — 순수 함수 모음 (I/O 없음, 단위 테스트 대상).

scripts/ingest_tourapi.py 가 사용한다. tests/services/test_tourapi.py 에서 검증.
"""

from typing import Any, Optional

# 적재 대상 contentTypeId — 관광지(12)·문화시설(14)·음식점(39). (docs/NEXTSPOT_PIVOT.md §1)
CONTENT_TYPE_IDS = (12, 14, 39)

# TourAPI 소분류: A05020900 = 카페/전통찻집 (음식점 39 중 카페 판별 기준)
CAT3_CAFE = "A05020900"

# TourAPI 에는 수용인원(capacity) 정보가 없다 — SPOT 산식/데모용 합성 기본값(타입별 추정치).
CAPACITY_DEFAULTS = {
    "restaurant": 40,
    "cafe": 30,
    "attraction": 300,
    "culture": 200,
}

# detailIntro2 의 운영시간/휴무일 필드명은 contentTypeId 마다 다르다.
_INTRO_HOURS_FIELDS = {
    12: ("usetime", "restdate"),            # 관광지
    14: ("usetimeculture", "restdateculture"),  # 문화시설
    39: ("opentimefood", "restdatefood"),   # 음식점
}

# detailInfo2 텍스트에서 무장애(barrier-free) 신호로 간주할 키워드(데모용 휴리스틱).
# 정밀한 무장애 정보는 별도 서비스(KorWithService)라서, 여기서는 언급 여부만 판별한다.
_BARRIER_FREE_KEYWORDS = ("무장애", "휠체어", "장애인", "배리어프리", "베리어프리", "엘리베이터")


def upgrade_image_scheme(url: Optional[str]) -> Optional[str]:
    """TourAPI 이미지 URL 의 http:// 를 https:// 로 승격.

    tong.visitkorea.or.kr CDN 은 https 를 지원하는데 API 는 http 를 주는 경우가 있어,
    HTTPS 로 배포된 프런트에서 혼합 콘텐츠(mixed content)로 차단되는 것을 막는다.
    """
    if url and url.startswith("http://"):
        return "https://" + url[len("http://"):]
    return url


def map_facility_type(content_type_id: int, cat3: Optional[str] = None) -> str:
    """contentTypeId → NextSpot canonical 타입(restaurant/cafe/attraction/culture).

    12→attraction, 14→culture, 39→(cat3 가 카페/전통찻집이면 cafe, 아니면 restaurant).
    """
    ctid = int(content_type_id)
    if ctid == 12:
        return "attraction"
    if ctid == 14:
        return "culture"
    if ctid == 39:
        return "cafe" if cat3 == CAT3_CAFE else "restaurant"
    raise ValueError(f"지원하지 않는 contentTypeId 입니다: {content_type_id} (지원: {CONTENT_TYPE_IDS})")


def transform_poi(item: Any) -> Optional[dict]:
    """locationBasedList2/areaBasedList2 의 item 1건 → facilities upsert 행.

    필수 필드(title/mapx/mapy/contentid/지원 contentTypeId) 누락·비정형이면 None(스킵).
    """
    if not isinstance(item, dict):
        return None
    try:
        latitude = float(item["mapy"])   # TourAPI: mapy = 위도
        longitude = float(item["mapx"])  # TourAPI: mapx = 경도
    except (KeyError, TypeError, ValueError):
        return None

    name = str(item.get("title") or "").strip()
    contentid = item.get("contentid")
    if not name or contentid in (None, ""):
        return None

    try:
        contenttypeid = int(item.get("contenttypeid"))
        facility_type = map_facility_type(contenttypeid, item.get("cat3") or None)
    except (TypeError, ValueError):
        return None

    return {
        "name": name,
        "type": facility_type,
        "latitude": latitude,
        "longitude": longitude,
        "address": str(item.get("addr1") or "").strip() or None,
        "contentid": str(contentid),
        "contenttypeid": contenttypeid,
        "image_url": upgrade_image_scheme(str(item.get("firstimage") or "").strip() or None),
        # 합성 기본값 — TourAPI 무제공 필드(위 CAPACITY_DEFAULTS 주석 참고)
        "capacity": CAPACITY_DEFAULTS[facility_type],
        "features": {
            "source": "tourapi",
            "cat1": item.get("cat1"),
            "cat2": item.get("cat2"),
            "cat3": item.get("cat3"),
        },
    }


def extract_operating_hours(intro_item: Any, content_type_id: int) -> dict:
    """detailIntro2 item → facilities.operating_hours JSONB (예: {"open": …, "closed": …}).

    타입별 필드명 차이를 흡수한다. 값이 없으면 빈 dict(기존 값 보존 판단은 호출부 몫).
    """
    if not isinstance(intro_item, dict):
        return {}
    open_field, rest_field = _INTRO_HOURS_FIELDS.get(int(content_type_id), ("usetime", "restdate"))
    hours: dict = {}
    open_text = str(intro_item.get(open_field) or "").strip()
    rest_text = str(intro_item.get(rest_field) or "").strip()
    if open_text:
        hours["open"] = open_text
    if rest_text:
        hours["closed"] = rest_text
    return hours


def extract_barrier_free(info_items: Any) -> Optional[bool]:
    """detailInfo2 item 목록 → barrier_free 판정.

    무장애 관련 키워드가 언급되면 True, 판단 근거가 없으면 None(미상 — False 로 단정하지 않음).
    """
    if not isinstance(info_items, list):
        return None
    for it in info_items:
        if not isinstance(it, dict):
            continue
        text = f"{it.get('infoname') or ''} {it.get('infotext') or ''}"
        if any(keyword in text for keyword in _BARRIER_FREE_KEYWORDS):
            return True
    return None
