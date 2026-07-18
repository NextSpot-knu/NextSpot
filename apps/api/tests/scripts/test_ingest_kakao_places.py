from scripts.ingest_kakao_places import is_duplicate, split_rect, to_row


DOC = {
    "id": "123", "place_name": "테스트식당", "x": "129.21", "y": "35.83",
    "road_address_name": "경북 경주시 포석로 1", "address_name": "경북 경주시 황남동 1",
    "phone": "054-123-4567", "place_url": "https://place.map.kakao.com/123",
    "category_name": "음식점 > 한식",
}


def test_split_rect_covers_four_quadrants():
    assert split_rect((0, 0, 2, 2)) == [(0, 0, 1, 1), (1, 0, 2, 1), (0, 1, 1, 2), (1, 1, 2, 2)]


def test_duplicate_by_kakao_id_or_same_name_address():
    assert is_duplicate(DOC, [{"name": "다른 이름", "features": {"kakao_place_id": "123"}}])
    assert is_duplicate(DOC, [{"name": "테스트 식당", "address": "경북 경주시 포석로 1", "features": {}}])
    assert not is_duplicate(DOC, [{"name": "테스트식당", "address": "경북 포항시 포석로 1", "features": {}}])


def test_to_row_labels_synthetic_and_unavailable_data():
    row = to_row(DOC, "restaurant")
    assert row["capacity"] == 40
    assert row["features"]["source"] == "kakao"
    assert row["features"]["capacity_source"] == "synthetic_type_default"
    assert row["features"]["congestion_source"] == "unavailable"
