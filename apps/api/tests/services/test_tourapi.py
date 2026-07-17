import pytest

# 테스트 대상 모듈 임포트 — 순수 함수만 검증(네트워크 호출 없음)
from app.services.tourapi import (
    CAPACITY_DEFAULTS,
    CAT3_CAFE,
    extract_barrier_free,
    extract_detail_common,
    extract_gallery_images,
    extract_operating_hours,
    map_facility_type,
    parse_items,
    parse_total_count,
    transform_poi,
)
# 구현 1 신규 함수(패키지 __init__ 재노출 범위 밖) — 서브모듈에서 직접 임포트.
from app.services.tourapi.transform import (
    extract_intro_extra_features,
    extract_intro_phone_fallback,
)


def _payload(items, total=None):
    """TourAPI 정상 응답 골격 생성 헬퍼."""
    body = {"items": items, "numOfRows": 100, "pageNo": 1}
    if total is not None:
        body["totalCount"] = total
    return {
        "response": {
            "header": {"resultCode": "0000", "resultMsg": "OK"},
            "body": body,
        }
    }


def test_parse_items_normal_list():
    # 1. 다건 응답: items.item 이 list 인 정상 케이스
    items = parse_items(_payload({"item": [{"contentid": "1"}, {"contentid": "2"}]}))
    assert len(items) == 2
    assert items[0]["contentid"] == "1"


def test_parse_items_single_dict_wrapped():
    # 2. 단건 응답: TourAPI 는 1건이면 item 을 dict 로 준다 → list 로 감싸져야 함
    items = parse_items(_payload({"item": {"contentid": "solo"}}))
    assert items == [{"contentid": "solo"}]


def test_parse_items_empty_string_items():
    # 3. 결과 0건: items 가 객체가 아니라 빈 문자열 "" 로 온다 — 예외 없이 빈 리스트
    assert parse_items(_payload("", total=0)) == []


def test_parse_items_missing_keys_and_garbage():
    # 4. 키 누락/비정형 입력 전부 빈 리스트 (예외 금지)
    assert parse_items({}) == []
    assert parse_items(None) == []
    assert parse_items("not-a-dict") == []
    assert parse_items({"response": {}}) == []
    assert parse_items({"response": {"body": {}}}) == []
    assert parse_items({"response": {"body": {"items": {"item": None}}}}) == []


def test_parse_total_count():
    # 5. totalCount 안전 추출 (누락/비정형이면 0)
    assert parse_total_count(_payload("", total=37)) == 37
    assert parse_total_count(_payload("", total="12")) == 12
    assert parse_total_count({}) == 0
    assert parse_total_count(None) == 0


def test_map_facility_type_basic():
    # 6. contentTypeId → canonical 타입 매핑
    assert map_facility_type(12) == "attraction"
    assert map_facility_type(14) == "culture"
    assert map_facility_type(39) == "restaurant"
    assert map_facility_type("39") == "restaurant"  # 문자열 id 도 허용


def test_map_facility_type_cafe_cat3_branch():
    # 7. 음식점(39) 중 cat3=A05020900(카페/전통찻집)만 cafe 로 분기
    assert map_facility_type(39, cat3=CAT3_CAFE) == "cafe"
    assert map_facility_type(39, cat3="A05020100") == "restaurant"  # 한식 등은 restaurant
    assert map_facility_type(12, cat3=CAT3_CAFE) == "attraction"  # cat3 는 39 에만 영향


def test_map_facility_type_unknown_raises():
    # 8. 미지원 contentTypeId 는 명확히 실패
    with pytest.raises(ValueError):
        map_facility_type(15)


def test_transform_poi_full_row():
    # 9. 정상 item → facilities 행 변환 (좌표 float, contentid str, 합성 capacity)
    item = {
        "title": "황리단길 한옥카페",
        "contentid": 2764978,          # int 로 와도 str 로 저장돼야 함
        "contenttypeid": "39",         # str 로 와도 int 로 저장돼야 함
        "mapx": "129.2105",            # TourAPI: mapx=경도, mapy=위도 (문자열)
        "mapy": "35.8361",
        "addr1": "경상북도 경주시 포석로 일대",
        "firstimage": "http://tong.visitkorea.or.kr/cms/sample.jpg",
        "cat1": "A05", "cat2": "A0502", "cat3": CAT3_CAFE,
    }
    row = transform_poi(item)

    assert row is not None
    assert row["name"] == "황리단길 한옥카페"
    assert row["type"] == "cafe"
    assert isinstance(row["latitude"], float) and row["latitude"] == pytest.approx(35.8361)
    assert isinstance(row["longitude"], float) and row["longitude"] == pytest.approx(129.2105)
    assert row["contentid"] == "2764978" and isinstance(row["contentid"], str)
    assert row["contenttypeid"] == 39 and isinstance(row["contenttypeid"], int)
    assert row["address"] == "경상북도 경주시 포석로 일대"
    assert row["image_url"] == "https://tong.visitkorea.or.kr/cms/sample.jpg"  # http → https 승격(혼합 콘텐츠 차단 방지)
    assert row["capacity"] == CAPACITY_DEFAULTS["cafe"] == 30
    assert row["features"]["source"] == "tourapi"
    assert row["features"]["cat3"] == CAT3_CAFE


def test_transform_poi_capacity_defaults_per_type():
    # 10. 타입별 합성 capacity 기본값 (TourAPI 에 수용인원 없음 — 데모용)
    base = {"title": "t", "contentid": "1", "mapx": "129.0", "mapy": "35.0"}
    assert transform_poi({**base, "contenttypeid": 12})["capacity"] == 300   # attraction
    assert transform_poi({**base, "contenttypeid": 14})["capacity"] == 200   # culture
    assert transform_poi({**base, "contenttypeid": 39})["capacity"] == 40    # restaurant
    assert transform_poi({**base, "contenttypeid": 39, "cat3": CAT3_CAFE})["capacity"] == 30  # cafe


def test_transform_poi_optional_fields_none():
    # 11. firstimage/addr1 미제공(빈 문자열) → None 으로 정규화
    row = transform_poi({
        "title": "무이미지", "contentid": "9", "contenttypeid": 12,
        "mapx": "129.21", "mapy": "35.83", "firstimage": "", "addr1": "",
    })
    assert row["image_url"] is None
    assert row["address"] is None


def test_transform_poi_invalid_items_skipped():
    # 12. 필수 필드 누락/비정형 → None(스킵)
    assert transform_poi(None) is None
    assert transform_poi({}) is None
    assert transform_poi({"title": "좌표없음", "contentid": "1", "contenttypeid": 12}) is None
    assert transform_poi({"title": "", "contentid": "1", "contenttypeid": 12,
                          "mapx": "129.0", "mapy": "35.0"}) is None       # 빈 이름
    assert transform_poi({"title": "t", "contentid": "", "contenttypeid": 12,
                          "mapx": "129.0", "mapy": "35.0"}) is None       # contentid 없음
    assert transform_poi({"title": "t", "contentid": "1", "contenttypeid": 15,
                          "mapx": "129.0", "mapy": "35.0"}) is None       # 미지원 타입
    assert transform_poi({"title": "t", "contentid": "1", "contenttypeid": 12,
                          "mapx": "경도아님", "mapy": "35.0"}) is None    # 좌표 비정형


def test_extract_operating_hours_per_type_fields():
    # 13. detailIntro2 운영시간 필드명은 타입별로 다르다 — 흡수 확인
    assert extract_operating_hours({"usetime": "09:00~18:00", "restdate": "연중무휴"}, 12) == \
        {"open": "09:00~18:00", "closed": "연중무휴"}
    assert extract_operating_hours({"usetimeculture": "10:00~17:00"}, 14) == {"open": "10:00~17:00"}
    assert extract_operating_hours({"opentimefood": "11:00~21:00", "restdatefood": "매주 월요일"}, 39) == \
        {"open": "11:00~21:00", "closed": "매주 월요일"}
    assert extract_operating_hours({}, 12) == {}
    assert extract_operating_hours(None, 39) == {}


def test_extract_barrier_free_heuristic():
    # 14. detailInfo2 텍스트에서 무장애 키워드 언급 시 True, 근거 없으면 None(미상)
    assert extract_barrier_free([{"infoname": "장애인 편의시설", "infotext": "휠체어 대여 가능"}]) is True
    assert extract_barrier_free([{"infoname": "주차", "infotext": "주차 가능"}]) is None
    assert extract_barrier_free([]) is None
    assert extract_barrier_free(None) is None


def test_extract_detail_common_full():
    # 15. detailCommon2 → overview/phone(tel 매핑)/homepage/image_url 추출.
    #     homepage 는 anchor HTML 에서 href 만, image_url 은 http→https 승격.
    common = extract_detail_common({
        "overview": "황리단길 대표 한옥카페입니다.",
        "tel": "054-000-0000",
        "homepage": '<a href="http://www.example.com" target="_blank" title="새창">www.example.com</a>',
        "firstimage": "http://tong.visitkorea.or.kr/cms/detail.jpg",
    })
    assert common["overview"] == "황리단길 대표 한옥카페입니다."
    assert common["phone"] == "054-000-0000"  # tel → phone 컬럼명 매핑
    assert common["homepage"] == "http://www.example.com"
    assert common["image_url"] == "https://tong.visitkorea.or.kr/cms/detail.jpg"


def test_extract_detail_common_homepage_plain_text():
    # 16. homepage 가 anchor HTML 이 아니면 원문 strip 그대로
    assert extract_detail_common({"homepage": " https://hwangridan.example "})["homepage"] == \
        "https://hwangridan.example"


def test_extract_detail_common_empty_values_omit_keys():
    # 17. 빈 값은 키 자체를 넣지 않는다(기존 값 보존 — extract_operating_hours 와 동일 패턴)
    assert extract_detail_common({"overview": "", "tel": "", "homepage": "", "firstimage": ""}) == {}
    assert extract_detail_common({"tel": "054-000-0000"}) == {"phone": "054-000-0000"}
    assert extract_detail_common({}) == {}
    assert extract_detail_common(None) == {}


def test_extract_gallery_images_https_dedupe_and_limit():
    items = [
        {"originimgurl": "http://tong.visitkorea.or.kr/a.jpg"},
        {"originimgurl": "http://tong.visitkorea.or.kr/a.jpg"},
        {"smallimageurl": "https://tong.visitkorea.or.kr/b.jpg"},
    ]
    assert extract_gallery_images(items) == [
        "https://tong.visitkorea.or.kr/a.jpg",
        "https://tong.visitkorea.or.kr/b.jpg",
    ]


# --- 구현 1: detailIntro2 확장 필드(Tier1 1-1·1-3·1-5) + phone 폴백 ---------------------
# 실측 응답(2026-07, TourAPI 실 호출): 음식점 contentid=2903556(카페능), 관광지 contentid=126214
# (천마총), 문화시설 contentid=3453492(경주중앙도서관). 아래 fixture 는 그 실측 원문을 그대로 옮김.

_REAL_INTRO_RESTAURANT = {
    "contentid": "2903556", "contenttypeid": "39",
    "kidsfacility": "0", "firstmenu": "바닐라라떼",
    "treatmenu": "아메리카노 / 카페라떼 / 플랫화이트 / 아인슈페너 / 아포가토 / 돼지바 크림치즈 크럼블 등",
    "smoking": "", "packing": "",
    "infocenterfood": "0507-1320-3898", "scalefood": "",
    "parkingfood": "불가능", "opendatefood": "", "opentimefood": "10:00~22:00",
    "restdatefood": "매월 첫 번째 수요일", "discountinfofood": "", "chkcreditcardfood": "",
    "reservationfood": "", "lcnsno": "20190542075",
}

_REAL_INTRO_ATTRACTION = {
    "contentid": "126214", "contenttypeid": "12",
    "heritage1": "0", "heritage2": "0", "heritage3": "0",
    "infocenter": "054-771-8650", "opendate": "", "restdate": "연중무휴",
    "expguide": "", "expagerange": "", "accomcount": "",
    "useseason": "", "usetime": "- 정문 09:00~22:00 (입장 마감 21:30)<br>\n- 후문·천마총 09:00~21:30",
    "parking": "가능", "chkbabycarriage": "", "chkpet": "", "chkcreditcard": "",
}

_REAL_INTRO_CULTURE = {
    "contentid": "3453492", "contenttypeid": "14",
    "scale": "", "usefee": "", "discountinfo": "", "spendtime": "", "parkingfee": "",
    "infocenterculture": "054-779-8918", "accomcountculture": "",
    "usetimeculture": "자료실 : 화~금 09:00~18:00, 주말 : 09:00~17:00 / 열람실 : 09:00~21:00",
    "restdateculture": "매주 월요일 / 법정공휴일",
    "parkingculture": "", "chkbabycarriageculture": "", "chkpetculture": "", "chkcreditcardculture": "",
}


def test_extract_intro_extra_features_restaurant():
    # 18. 음식점(39): firstmenu/treatmenu/parkingfood→parking/packing(빈 값은 생략)
    features = extract_intro_extra_features(_REAL_INTRO_RESTAURANT, 39)
    assert features["first_menu"] == "바닐라라떼"
    assert features["treat_menu"].startswith("아메리카노")
    assert features["parking"] == "불가능"
    assert "packing" not in features  # 실측 원문이 빈 값 — 키 생략
    assert features["rest_date_raw"] == "매월 첫 번째 수요일"
    assert "accom_count" not in features  # accomcount 는 관광지(12) 전용


def test_extract_intro_extra_features_attraction_with_accom_count():
    # 19. 관광지(12): parking/chk*, accomcount 숫자 파싱(성공/실패) + rest_date_raw
    features = extract_intro_extra_features(_REAL_INTRO_ATTRACTION, 12)
    assert features["parking"] == "가능"
    assert "chk_babycarriage" not in features  # 실측 원문 빈 값
    assert "chk_pet" not in features
    assert "chk_creditcard" not in features
    assert features["rest_date_raw"] == "연중무휴"
    assert "accom_count" not in features  # 실측 원문(accomcount) 빈 값 — 키 생략

    numeric = extract_intro_extra_features({**_REAL_INTRO_ATTRACTION, "accomcount": "1,000"}, 12)
    assert numeric["accom_count"] == 1000 and isinstance(numeric["accom_count"], int)

    non_numeric = extract_intro_extra_features(
        {**_REAL_INTRO_ATTRACTION, "accomcount": "약 5000명(성수기 기준)"}, 12
    )
    assert non_numeric["accom_count"] == "약 5000명(성수기 기준)"  # 파싱 실패 → 원문 문자열 보존


def test_extract_intro_extra_features_culture_field_names():
    # 20. 문화시설(14): parkingculture/chk*culture 실측 필드명 확인(빈 값이면 생략)
    features = extract_intro_extra_features(_REAL_INTRO_CULTURE, 14)
    assert features["rest_date_raw"] == "매주 월요일 / 법정공휴일"
    assert "parking" not in features  # 실측 원문(parkingculture) 빈 값
    assert "chk_babycarriage" not in features

    filled = extract_intro_extra_features({
        **_REAL_INTRO_CULTURE,
        "parkingculture": "가능", "chkbabycarriageculture": "Y",
        "chkpetculture": "N", "chkcreditcardculture": "Y",
    }, 14)
    assert filled["parking"] == "가능"
    assert filled["chk_babycarriage"] == "Y"
    assert filled["chk_pet"] == "N"
    assert filled["chk_creditcard"] == "Y"


def test_extract_intro_extra_features_empty_values_omit_keys():
    # 21. 빈 값은 키 자체를 넣지 않는다(기존 patterns 과 동일 원칙)
    assert extract_intro_extra_features({}, 39) == {}
    assert extract_intro_extra_features(None, 12) == {}
    assert extract_intro_extra_features({"contentid": "1"}, 14) == {}


def test_extract_intro_phone_fallback_uses_type_specific_infocenter():
    # 22. 타입별 infocenter*(관광지=infocenter, 음식점=infocenterfood, 문화시설=infocenterculture)
    assert extract_intro_phone_fallback(_REAL_INTRO_RESTAURANT, 39) == "0507-1320-3898"
    assert extract_intro_phone_fallback(_REAL_INTRO_ATTRACTION, 12) == "054-771-8650"
    assert extract_intro_phone_fallback(_REAL_INTRO_CULTURE, 14) == "054-779-8918"


def test_extract_intro_phone_fallback_strips_prefix_text():
    # 23. "문의처 : ..." 같은 접두 텍스트는 정리하고 전화번호 패턴만 반환
    assert extract_intro_phone_fallback(
        {"infocenter": "문의처 : 054-000-0000 (관리사무소)"}, 12
    ) == "054-000-0000"


def test_extract_intro_phone_fallback_no_pattern_returns_none():
    # 24. 전화번호 패턴이 없으면 None(억지 추출 금지)
    assert extract_intro_phone_fallback({"infocenterfood": "정보없음"}, 39) is None
    assert extract_intro_phone_fallback({"infocenter": ""}, 12) is None
    assert extract_intro_phone_fallback(None, 12) is None
    assert extract_intro_phone_fallback({"infocenter": "054-000-0000"}, 15) is None  # 미지원 타입


# --- detailImage2 함정 회귀 방지 (2026-07-17 실측) --------------------------------------
# KorService2 는 구(KorService1) 파라미터 subImageYN 을 받으면 봉투 없는 평면 에러 JSON 을
# 반환한다: {"responseTime": ..., "resultCode": "10", "resultMsg": "INVALID_REQUEST_PARAMETER_ERROR(subImageYN)"}
# → 갤러리 적재가 전건 실패했었다(HANDOVER §-12). 아래 두 테스트가 그 함정의 회귀 방지선이다.

from app.services.tourapi.client import TourAPIError, _check_result  # noqa: E402


def test_check_result_flat_error_format_raises_with_code():
    # 25. 봉투(response.header) 없는 평면 에러 형식도 resultCode 를 읽어 TourAPIError
    flat_error = {
        "responseTime": "2026-07-17T15:20:29.784",
        "resultCode": "10",
        "resultMsg": "INVALID_REQUEST_PARAMETER_ERROR(subImageYN)",
    }
    with pytest.raises(TourAPIError, match="resultCode=10"):
        _check_result(flat_error, "detailImage2")


def test_check_result_envelope_ok_passes():
    # 26. 정상 봉투 0000 은 통과, 비-0000 봉투는 실패(기존 동작 불변 확인)
    _check_result(_payload("", total=0), "detailImage2")  # 예외 없어야 함
    bad = {"response": {"header": {"resultCode": "99", "resultMsg": "SERVICE ERROR"}, "body": {}}}
    with pytest.raises(TourAPIError, match="resultCode=99"):
        _check_result(bad, "detailImage2")


@pytest.mark.asyncio
async def test_detail_image_does_not_send_sub_image_yn(monkeypatch):
    # 27. detail_image 가 subImageYN 을 다시 보내면 KorService2 가 전건 거부한다 — 재도입 금지
    from app.services.tourapi import client as tourapi_client

    captured: dict = {}

    async def fake_get(endpoint, params):
        captured["endpoint"] = endpoint
        captured["params"] = params
        return _payload({"item": []})

    monkeypatch.setattr(tourapi_client, "_get", fake_get)
    await tourapi_client.detail_image("2756611")
    assert captured["endpoint"] == "detailImage2"
    assert "subImageYN" not in captured["params"]
    assert captured["params"]["imageYN"] == "Y"
