import pytest

# 테스트 대상 모듈 임포트 — 순수 함수만 검증(네트워크 호출 없음)
from app.services.tourapi import (
    CAPACITY_DEFAULTS,
    CAT3_CAFE,
    extract_barrier_free,
    extract_detail_common,
    extract_operating_hours,
    map_facility_type,
    parse_items,
    parse_total_count,
    transform_poi,
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
