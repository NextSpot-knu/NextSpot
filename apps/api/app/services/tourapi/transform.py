"""TourAPI 응답 → NextSpot `facilities` 행 변환 — 순수 함수 모음 (I/O 없음, 단위 테스트 대상).

scripts/ingest_tourapi.py 가 사용한다. tests/services/test_tourapi.py 에서 검증.
"""

import re
from typing import Any, Optional

# 적재 대상 contentTypeId — 관광지(12)·문화시설(14)·음식점(39). (docs/archive/NEXTSPOT_PIVOT.md §1)
CONTENT_TYPE_IDS = (12, 14, 39)

# TourAPI 소분류: A05020900 = 카페/전통찻집 (음식점 39 중 카페 판별 기준)
CAT3_CAFE = "A05020900"
# TourAPI 신분류체계 중분류 FD05 = 카페/전통찻집. 2023년 이후 등록분은 cat1~3(구 분류)이 빈 값이라
# (2026-09-29 실측: 법정동 목록에만 나오는 경주 카페 13곳 전부 cat3 공란 + FD05) cat3 가 비었을 때만 이것으로 본다.
LCLS2_CAFE = "FD05"

# 문화시설(14) 소분류(cat3) 중 **건물 안에서 보는 곳** — 비 오는 날 '실내만' 조건의 근거다.
# 박물관·기념관·전시관·컨벤션센터·미술관/화랑·문화원·외국문화원·도서관·대형서점·영화관.
# 같은 중분류(A0206)라도 넣지 않은 것: 공연장(A02060600 — 야외 공연장이 같은 분류다), 문화전수시설(A02061100 —
# 마당·공방이 딸린 곳이 많다), 어학당·학교(A02061300·A02061400 — 방문지가 아니다). 이름('박물관')으로는 판정하지
# 않는다 — '야외 전시장'·'유적 전시관 터' 처럼 이름만 실내인 곳이 있어서다. 신분류(lclsSystm) 코드는 실측으로
# 확인하기 전이라 쓰지 않는다 — cat3 가 빈 행은 실내 근거가 없는 것으로 남는다(travel_context 의 fail-closed).
INDOOR_CULTURE_CAT3 = frozenset({
    "A02060100",  # 박물관
    "A02060200",  # 기념관
    "A02060300",  # 전시관
    "A02060400",  # 컨벤션센터
    "A02060500",  # 미술관/화랑
    "A02060700",  # 문화원
    "A02060800",  # 외국문화원
    "A02060900",  # 도서관
    "A02061000",  # 대형서점
    "A02061200",  # 영화관
})
# features.indoor 를 이 분류로 세웠다는 근거 표시 — 카카오·LocalData 음식점의 'fixed_food_establishment' 와 같은 자리다.
INDOOR_CULTURE_EVIDENCE = "tourapi_culture_class"

# TourAPI '가능/불가' 류 자유 글(주차·유모차·반려동물) 판정. 웹 lib/restDate.ts 의 parseAvailability 와 **같은 식**이다
# (공유 사례: tests/fixtures/opening_hours_parity.json). 불가 쪽을 먼저 본다 — '대여 불가' 는 '대여' 를 담고 있어도 불가다.
_AVAILABILITY_NO_RE = re.compile(r"불가|없음|무료?없")
_AVAILABILITY_YES_RE = re.compile(r"가능|있음|허용")


def parse_availability_text(value: object) -> Optional[bool]:
    """'가능'·'있음' 이면 True, '불가'·'없음' 이면 False, 그 밖(빈 값·'Y'·자유 문장)은 None(모름)."""
    text = str(value or "").strip()
    if not text:
        return None
    if _AVAILABILITY_NO_RE.search(text):
        return False
    if _AVAILABILITY_YES_RE.search(text):
        return True
    return None

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

# detailIntro2 의 phone 폴백 필드명 — detailCommon2.tel 이 비었을 때만 사용한다(구현 1).
# 실측(2026-07, contentid 2903556/126214/3453492): 세 타입 모두 detailCommon2.tel 은 빈 값이라
# 이 폴백이 실효한다.
_INTRO_PHONE_FIELDS = {
    12: "infocenter",         # 관광지
    14: "infocenterculture",  # 문화시설
    39: "infocenterfood",     # 음식점
}

# detailIntro2 확장 필드 → features 키 매핑(구현 1, docs/archive/TOURAPI_EXPANSION.md Tier1 1-3·1-5).
# 필드명은 응답 실측으로 확정(2026-07, contentid 2903556=음식점/126214=관광지/3453492=문화시설).
# accomcount(관광지, 1-1)는 숫자 파싱이 필요해 별도 처리 — 아래 _parse_accom_count 참고.
_INTRO_EXTRA_FIELDS = {
    39: {  # 음식점
        "firstmenu": "first_menu",
        "treatmenu": "treat_menu",
        "parkingfood": "parking",
        "packing": "packing",
    },
    12: {  # 관광지
        "parking": "parking",
        "chkbabycarriage": "chk_babycarriage",
        "chkpet": "chk_pet",
        "chkcreditcard": "chk_creditcard",
    },
    14: {  # 문화시설 — 실측 필드명: chkbabycarriageculture(기획 문서의 chkbabycarriagculture 오타 정정)
        "parkingculture": "parking",
        "chkbabycarriageculture": "chk_babycarriage",
        "chkpetculture": "chk_pet",
        "chkcreditcardculture": "chk_creditcard",
    },
}

# detailCommon2 의 homepage 는 '<a href="...">...</a>' HTML 로 오는 경우가 흔하다 — href 만 추출.
_HOMEPAGE_HREF_RE = re.compile(r"""href=["']([^"']+)["']""", re.IGNORECASE)

# 전화번호 패턴(하이픈/점/공백 구분자 필수) — "문의처 : 054-000-0000" 같은 접두 텍스트를
# 정리하고 번호만 뽑아낸다. 구분자가 없는 순수 숫자열(사업자등록번호 등)은 오탐 방지를 위해 제외.
_PHONE_PATTERN_RE = re.compile(r"(\d{2,4}[-.\s]\d{3,4}[-.\s]\d{4})")

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


def map_facility_type(
    content_type_id: int, cat3: Optional[str] = None, lcls_systm2: Optional[str] = None,
) -> str:
    """contentTypeId → NextSpot canonical 타입(restaurant/cafe/attraction/culture).

    12→attraction, 14→culture, 39→(cat3 가 카페/전통찻집이면 cafe, cat3 가 비었고 신분류 lclsSystm2 가
    FD05(카페/전통찻집)면 cafe, 아니면 restaurant). cat3 가 있으면 cat3 가 이긴다(기존 분류 유지).
    """
    ctid = int(content_type_id)
    if ctid == 12:
        return "attraction"
    if ctid == 14:
        return "culture"
    if ctid == 39:
        if cat3:
            return "cafe" if cat3 == CAT3_CAFE else "restaurant"
        return "cafe" if lcls_systm2 == LCLS2_CAFE else "restaurant"
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

    lcls_systm2 = item.get("lclsSystm2") or item.get("lclssystm2")
    try:
        contenttypeid = int(item.get("contenttypeid"))
        facility_type = map_facility_type(contenttypeid, item.get("cat3") or None, lcls_systm2 or None)
    except (TypeError, ValueError):
        return None

    # 실내로 분류된 문화시설(박물관·미술관 등)만 실내 근거를 단다. 분류가 실내가 아니거나 비었으면 키를 넣지
    # 않는다 — '모름' 을 False(야외)로 적지 않고, 기존 값(사람이 확인한 indoor_verified 등)도 덮지 않는다.
    # 사람이 '야외' 로 바로잡을 때는 indoor_verified=false 를 쓴다 — travel_context 가 그 값을 먼저 보므로 이
    # 밤 적재가 다시 실내로 돌려놓지 못한다.
    indoor_marker = (
        {"indoor": True, "indoor_evidence": INDOOR_CULTURE_EVIDENCE}
        if facility_type == "culture" and item.get("cat3") in INDOOR_CULTURE_CAT3
        else {}
    )

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
            # TourAPI 신분류체계. 응답에 존재할 때만 이후 세부 취향 재랭킹에 사용한다.
            "lcls_systm1": item.get("lclsSystm1") or item.get("lclssystm1"),
            "lcls_systm2": lcls_systm2,
            "lcls_systm3": item.get("lclsSystm3") or item.get("lclssystm3"),
            # 목록 대표 사진(firstimage)의 공공누리 유형(Type1 출처표시 · Type3 출처표시+변경금지 등). 사진이 없으면
            # 빈 값이 온다. 화면 표기(유형별 출처)를 나중에 붙일 수 있게 적재만 해 둔다.
            "firstimage_cpyrht_div_cd": str(item.get("cpyrhtDivCd") or "").strip() or None,
            **indoor_marker,
        },
    }


def extract_gallery_images(items: Any, limit: int = 5) -> list[str]:
    """detailImage2 목록에서 HTTPS URL을 중복 없이 최대 5개 추출한다."""
    if not isinstance(items, list):
        return []
    result: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        url = item.get("originimgurl") or item.get("smallimageurl")
        normalized = upgrade_image_scheme(str(url).strip()) if url else None
        if normalized and normalized not in result:
            result.append(normalized)
        if len(result) >= limit:
            break
    return result


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


def _parse_accom_count(raw: object) -> Optional[Any]:
    """accomcount(관광지 수용인원) 문자열 → int 파싱 시도, 실패 시 원문 문자열 그대로.

    "1,000" 같은 천단위 콤마는 제거 후 파싱. "약 5000명(성수기)" 처럼 숫자만으로 안 떨어지면
    원문을 그대로 보존한다(억지 부분 추출 금지 — 정직한 저하).
    """
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        return int(text.replace(",", ""))
    except ValueError:
        return text


def _clean_phone_pattern(raw: object) -> Optional[str]:
    """"문의처 : 054-000-0000" 같은 원문에서 전화번호 패턴만 뽑아낸다(접두 텍스트 정리).

    패턴이 없으면 None(전화번호로 확신할 수 없는 값은 phone 에 넣지 않는다).
    """
    text = str(raw or "").strip()
    if not text:
        return None
    match = _PHONE_PATTERN_RE.search(text)
    return match.group(1) if match else None


def extract_intro_phone_fallback(intro_item: Any, content_type_id: int) -> Optional[str]:
    """detailIntro2 item → phone 폴백(구현 1).

    detailCommon2.tel 이 비어 있을 때만 호출부가 사용해야 한다(우선순위 판단은 호출부 몫 —
    extract_detail_common 과 동일 원칙). 타입별 infocenter*(§_INTRO_PHONE_FIELDS) 필드에서
    전화번호 패턴만 정리해 반환하고, 패턴이 없으면 None.
    """
    if not isinstance(intro_item, dict):
        return None
    field = _INTRO_PHONE_FIELDS.get(int(content_type_id))
    if not field:
        return None
    return _clean_phone_pattern(intro_item.get(field))


def extract_intro_extra_features(intro_item: Any, content_type_id: int) -> dict:
    """detailIntro2 item → 확장 features dict (구현 1, Tier1 1-1·1-3·1-5).

    타입별 매핑은 _INTRO_EXTRA_FIELDS 실측표를 따른다. 값이 있을 때만 키를 포함한다
    (extract_operating_hours/extract_detail_common 과 동일한 "빈 값 키 생략" 원칙 —
    features 오염 방지). 추가로:
      - 관광지(12) accomcount → features.accom_count (숫자 파싱, 실패 시 원문 문자열)
      - rest_date_raw: operating_hours.closed 와 동일 원문을 features 에도 중복 보존해
        향후 '오늘 휴무' 파서(§1-2)가 참조할 수 있게 한다.
      - stroller: chk_babycarriage(유모차 대여 정보) 원문이 '가능' 이면 True, 그 밖이면 null.
        휠체어 접근(barrier_free·accessible_verified)과 **다른 칸**이다 — 유모차 대여가 된다고 휠체어로 다닐 수
        있다는 뜻이 아니고, 그 반대도 아니다. False 는 적지 않는다: 이 칸은 '대여' 정보라 '없음'(대여 없음)이
        유모차로 못 간다는 뜻이 아니다. null 은 전날 적은 True 를 지우고 판정이 원문을 다시 읽게 한다.
    """
    if not isinstance(intro_item, dict):
        return {}
    ctid = int(content_type_id)
    features: dict = {}

    for src_field, dest_key in _INTRO_EXTRA_FIELDS.get(ctid, {}).items():
        value = str(intro_item.get(src_field) or "").strip()
        if value:
            features[dest_key] = value

    if "chk_babycarriage" in features:
        features["stroller"] = True if parse_availability_text(features["chk_babycarriage"]) is True else None

    if ctid == 12:
        accom_count = _parse_accom_count(intro_item.get("accomcount"))
        if accom_count is not None:
            features["accom_count"] = accom_count

    _, rest_field = _INTRO_HOURS_FIELDS.get(ctid, ("usetime", "restdate"))
    rest_raw = str(intro_item.get(rest_field) or "").strip()
    if rest_raw:
        features["rest_date_raw"] = rest_raw

    return features


def extract_detail_common(item: Any) -> dict:
    """detailCommon2 item → 상세 공통 필드 {overview, phone(←tel), homepage, image_url(←firstimage)}.

    값이 비어 있으면 키 자체를 넣지 않는다(기존 값 보존 원칙 — extract_operating_hours 와
    동일 패턴). image_url 은 locationBasedList2 의 firstimage 가 이미 있으므로 폴백 용도이며,
    역시 값이 있을 때만 키를 포함한다(우선순위 판단은 호출부 몫).
    """
    if not isinstance(item, dict):
        return {}
    common: dict = {}
    overview = str(item.get("overview") or "").strip()
    if overview:
        common["overview"] = overview
    phone = str(item.get("tel") or "").strip()
    if phone:
        common["phone"] = phone
    homepage_raw = str(item.get("homepage") or "").strip()
    if homepage_raw:
        # anchor HTML 이면 href 만, 아니면 원문 strip 그대로.
        match = _HOMEPAGE_HREF_RE.search(homepage_raw)
        common["homepage"] = match.group(1) if match else homepage_raw
    image_url = upgrade_image_scheme(str(item.get("firstimage") or "").strip() or None)
    if image_url:
        common["image_url"] = image_url
    return common


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
