from app.services.batch.localdata import (
    classify,
    find_duplicate,
    normalize_record,
    transform_coordinate,
)


X, Y = "399620.347641", "261682.261516"


def row(**overrides):
    value = {
        "관리번호": "4713000-101-2026-00001",
        "사업장명": "테스트 카페",
        "도로명전체주소": "경상북도 경주시 포석로 1",
        "영업상태구분코드": "01",
        "데이터갱신일자": "20260721120000",
        "좌표정보(X)": X,
        "좌표정보(Y)": Y,
        "업태구분명": "커피숍",
    }
    value.update(overrides)
    return value


def test_epsg5174_transforms_inside_service_boundary():
    result = transform_coordinate(X, Y)
    assert result.reason is None
    assert result.crs == "EPSG:5174"
    assert abs(result.latitude - 35.835) < 0.00001
    assert abs(result.longitude - 129.21) < 0.00001


def test_historical_ambiguous_crs_is_quarantined():
    result = transform_coordinate(X, Y, allow_legacy=True)
    assert result.reason == "ambiguous_crs"


def test_normal_record_preserves_unknown_hours_and_evidence():
    record, reason = normalize_record(row(), "07_24_05_P")
    assert reason is None
    assert record["type"] == "cafe"
    assert record["operating_hours"] == {}
    assert record["features"]["indoor_evidence"] == "fixed_food_establishment"
    assert record["features"]["capacity_evidence"] == "synthetic_type_default"
    assert record["is_active"] is True


def test_open_api_camel_case_field_variant():
    api_row = {
        "mgtNo": "api-1", "bplcNm": "API 카페", "rdnWhlAddr": "경주시 포석로 2",
        "trdStateGbn": "01", "updateDt": "20260721120000", "x": X, "y": Y,
        "uptaeNm": "커피숍",
    }
    record, reason = normalize_record(api_row, "07_24_05_P")
    assert reason is None
    assert record["external_id"] == "api-1"


def test_inactive_and_missing_required_fields_are_not_invented():
    inactive, _ = normalize_record(row(영업상태구분코드="03"), "07_24_05_P")
    missing, reason = normalize_record(row(사업장명=""), "07_24_05_P")
    assert inactive["is_active"] is False
    assert missing is None
    assert reason == "missing_required_field"


def test_excluded_and_ambiguous_business_types():
    assert classify("07_24_04_P", "일반음식점", "별밤 유흥주점")[1] == "excluded_business_type"
    assert classify("07_24_05_P", "기타 휴게음식점", "가게")[1] == "ambiguous_business_type"
    assert classify("07_24_05_P", "푸드트럭", "커피차")[0] is None


def test_duplicate_order_address_then_50m_and_multiple_is_quarantined():
    record, _ = normalize_record(row(), "07_24_05_P")
    exact = {"id": "a", "name": "테스트카페", "address": "경북 경주시 포석로 1",
             "latitude": 35.84, "longitude": 129.22}
    assert find_duplicate(record, [exact]) == ("a", "name_address")
    nearby = {"id": "b", "name": "테스트 카페", "address": "다른 주소",
              "latitude": record["latitude"], "longitude": record["longitude"]}
    assert find_duplicate(record, [nearby]) == ("b", "name_50m")
    assert find_duplicate(record, [nearby, {**nearby, "id": "c"}]) == (
        None, "multiple_duplicate_candidates"
    )
