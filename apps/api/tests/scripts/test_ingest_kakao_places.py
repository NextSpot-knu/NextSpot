from scripts.ingest_kakao_places import _existing_key, _merge_features, _normalize


DOC = {
    "id": "123", "place_name": "테스트식당", "x": "129.21", "y": "35.83",
    "road_address_name": "경북 경주시 포석로 1", "address_name": "경북 경주시 황남동 1",
    "phone": "054-123-4567", "place_url": "https://place.map.kakao.com/123",
    "category_name": "음식점 > 한식",
}


def test_normalize_ignores_spacing_and_case():
    assert _normalize(" Terra Rosa ") == _normalize("terrarosa")


def test_existing_key_uses_normalized_name_and_address():
    assert _existing_key({"name": "테스트 식당", "address": "경북 경주시 포석로 1"}) == (
        _normalize("테스트식당"),
        _normalize("경북 경주시 포석로 1"),
    )


def test_merge_features_labels_synthetic_capacity_without_congestion_claim():
    candidate = {
        "kakao_place_id": DOC["id"],
        "place_url": DOC["place_url"],
        "queries": ["category_grid:restaurant"],
        "best_rank": 1,
        "appearance_count": 1,
        "discovery_source": "category_grid",
        "category_name": DOC["category_name"],
    }

    features = _merge_features(None, candidate)

    assert features["source"] == "kakao_discovery"
    assert features["capacity_evidence"] == "synthetic_type_default"
    assert "congestion_source" not in features
