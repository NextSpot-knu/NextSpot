from app.services.discovery_theme_service import discovery_theme_match


def test_official_related_destination_is_always_auditable_theme_match():
    assert discovery_theme_match(
        {"name": "후보", "tourapi_related_rank": 3}, "silla_core"
    ) == {"source": "tourapi_related", "value": "3"}


def test_theme_matches_only_stored_facility_facts():
    result = discovery_theme_match(
        {"name": "마당 깊은 카페", "features": {"category_name": "한옥 카페"}},
        "hanok_cafe",
    )
    assert result == {"source": "facility_fact", "value": "한옥"}


def test_same_type_without_theme_evidence_is_not_called_same_experience():
    assert discovery_theme_match(
        {"name": "키즈 테마파크", "overview": "놀이 시설"}, "silla_core"
    ) is None


def test_nested_feature_lists_are_searchable_without_string_invention():
    assert discovery_theme_match(
        {"name": "전시 공간", "features": {"tags": ["실내", "박물관"]}},
        "indoor_history",
    ) == {"source": "facility_fact", "value": "박물관"}
