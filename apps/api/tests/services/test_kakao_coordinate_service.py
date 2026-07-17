from app.services.kakao_coordinate_service import choose_kakao_match


ROW = {
    "name": "석하한정식", "address": "경상북도 경주시 흥무로 51-14",
    "latitude": 35.8405567, "longitude": 129.1953552,
}


def test_choose_match_requires_name_and_accepts_same_road_address():
    docs = [{
        "id": "1", "place_name": "석하한정식", "road_address_name": "경북 경주시 흥무로 51-14",
        "x": "129.196", "y": "35.841", "place_url": "https://place.map.kakao.com/1",
    }]
    assert choose_kakao_match(ROW, docs) == docs[0]


def test_choose_match_rejects_same_name_far_away_without_address_match():
    docs = [{
        "id": "2", "place_name": "석하한정식", "road_address_name": "경북 포항시 다른길 1",
        "x": "129.35", "y": "36.0",
    }]
    assert choose_kakao_match(ROW, docs) is None


def test_choose_match_rejects_nearby_different_business():
    docs = [{
        "id": "3", "place_name": "석하카페", "road_address_name": "경북 경주시 흥무로 51-14",
        "x": "129.1954", "y": "35.8406",
    }]
    assert choose_kakao_match(ROW, docs) is None
