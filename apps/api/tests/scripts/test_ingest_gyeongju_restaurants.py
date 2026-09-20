from scripts.ingest_gyeongju_restaurants import (
    build_actions,
    match_facility,
    merge_features,
)


_NOW = "2026-09-20T00:00:00+00:00"


def _restaurant(**overrides):
    base = {
        "con_uid": 101,
        "name": "황남밀면",
        "address": "경북 경주시 포석로 1",
        "menu": "밀면, 연탄불고기",
        "hours": "11:00-20:00",
        "closed": "인스타공지",
        "parking": "매장 옆 공용주차장 이용",
        "amenities": "카드결제, 포장가능",
        "homepage": "https://example.com",
        "lat": 35.8361,
        "lng": 129.2105,
    }
    base.update(overrides)
    return base


def _facility(**overrides):
    base = {
        "id": "fac-1",
        "name": "황남밀면",
        "latitude": 35.8361,
        "longitude": 129.2105,
        "contenttypeid": 39,
        "type": "restaurant",
        "features": {},
        "operating_hours": {},
        "homepage": None,
    }
    base.update(overrides)
    return base


def test_match_facility_matches_same_name_within_radius():
    facility = _facility()
    assert match_facility(_restaurant(), [facility]) is facility


def test_match_facility_rejects_far_facility():
    far = _facility(latitude=35.90, longitude=129.30)  # ~수 km 떨어짐
    assert match_facility(_restaurant(), [far]) is None


def test_match_facility_rejects_different_name_even_if_close():
    other = _facility(name="전혀다른가게")
    assert match_facility(_restaurant(), [other]) is None


def test_match_facility_ignores_non_food_facilities():
    attraction = _facility(contenttypeid=12, type="attraction")
    assert match_facility(_restaurant(), [attraction]) is None


def test_match_facility_allows_kakao_food_type_without_contenttypeid():
    cafe = _facility(id="fac-cafe", name="황남밀면", contenttypeid=None, type="cafe")
    assert match_facility(_restaurant(), [cafe]) is cafe


def test_merge_features_preserves_tourapi_keys_and_adds_menu():
    existing = {
        "source": "tourapi",
        "first_menu": "TourAPI메뉴",
        "parking": "가능",  # TourAPI 의 주차 키 — 덮이면 안 된다.
        "cat3": "A05020900",
    }
    merged = merge_features(existing, _restaurant(), _NOW)

    # 기존 TourAPI 키는 보존.
    assert merged["source"] == "tourapi"
    assert merged["first_menu"] == "TourAPI메뉴"
    assert merged["parking"] == "가능"
    assert merged["cat3"] == "A05020900"
    # 대표메뉴는 features.menu 로(취향매칭 preference.py 가 읽는 키).
    assert merged["menu"] == "밀면, 연탄불고기"
    # 상세는 네임스페이스로 보존.
    assert merged["gyeongju_food"]["menu"] == "밀면, 연탄불고기"
    assert merged["gyeongju_food"]["parking"] == "매장 옆 공용주차장 이용"
    assert merged["gyeongju_food"]["source"] == "gyeongju_food_15114465"
    assert merged["gyeongju_food"]["synced_at"] == _NOW


def test_build_actions_matches_and_fills_empty_columns():
    update_rows, actions = build_actions([_restaurant()], [_facility()], _NOW)

    assert len(update_rows) == 1
    row = update_rows[0]
    assert row["id"] == "fac-1"
    assert row["features"]["menu"] == "밀면, 연탄불고기"
    # operating_hours 가 비어 있었으므로 채운다.
    assert row["operating_hours"] == {"open": "11:00-20:00", "source": "gyeongju_food", "closed": "인스타공지"}
    # homepage 가 비어 있었으므로 채운다.
    assert row["homepage"] == "https://example.com"

    assert actions[0]["status"] == "matched"
    assert "features" in actions[0]["fields"]


def test_build_actions_does_not_overwrite_existing_hours():
    facility = _facility(operating_hours={"open": "이미있음"})
    update_rows, _ = build_actions([_restaurant()], [facility], _NOW)
    # 기존 operating_hours 는 보존(덮지 않는다).
    assert update_rows[0]["operating_hours"] == {"open": "이미있음"}


def test_build_actions_skips_unmatched_restaurants():
    update_rows, actions = build_actions(
        [_restaurant(name="매칭안됨", lat=35.99, lng=129.40)], [_facility()], _NOW
    )
    assert update_rows == []
    assert actions[0]["status"] == "skipped_no_match"


def test_build_actions_skips_duplicate_facility_match():
    restaurants = [_restaurant(con_uid=1), _restaurant(con_uid=2)]  # 같은 이름·좌표 → 같은 시설
    update_rows, actions = build_actions(restaurants, [_facility()], _NOW)
    assert len(update_rows) == 1
    assert [a["status"] for a in actions] == ["matched", "skipped_duplicate_match"]
