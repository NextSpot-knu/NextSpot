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


def test_choose_match_accepts_unique_exact_name_in_gyeongju_despite_bad_source_coordinate():
    docs = [{
        "id": "4", "place_name": "석하한정식", "address_name": "경북 경주시 황남동 1",
        "x": "129.21721", "y": "35.83256",
    }]
    assert choose_kakao_match(ROW, docs) == docs[0]


def test_choose_match_rejects_exact_name_outside_gyeongju():
    docs = [{
        "id": "5", "place_name": "석하한정식", "address_name": "경북 포항시 북구 다른동 1",
        "x": "129.35", "y": "36.0",
    }]
    assert choose_kakao_match(ROW, docs) is None


def test_choose_match_rejects_ambiguous_exact_names_without_address_evidence():
    docs = [
        {"id": "6", "place_name": "석하한정식", "address_name": "경북 경주시 황남동 1",
         "x": "129.30", "y": "35.90"},
        {"id": "7", "place_name": "석하한정식", "address_name": "경북 경주시 황오동 2",
         "x": "129.31", "y": "35.91"},
    ]
    assert choose_kakao_match(ROW, docs) is None


def test_choose_match_ignores_gyeongju_prefix_for_heritage_name_with_bad_coordinate():
    row = {
        "name": "경주 내물왕릉", "address": "경상북도 경주시 포석로 1065",
        "latitude": 35.8362047, "longitude": 129.2095708,
    }
    docs = [{
        "id": "8", "place_name": "내물왕릉", "address_name": "경북 경주시 교동 14",
        "x": "129.21721", "y": "35.83256",
    }]
    assert choose_kakao_match(row, docs) == docs[0]
