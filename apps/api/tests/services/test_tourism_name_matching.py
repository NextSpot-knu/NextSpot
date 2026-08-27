from app.services.tourism_name_matching import (
    match_tourism_forecasts_to_facilities,
    normalize_tourism_anchor_name,
)


def test_normalizes_only_safe_tourism_presentation_differences():
    assert normalize_tourism_anchor_name("경주 대릉원 일원") == "대릉원"
    assert normalize_tourism_anchor_name("국립 경주 박물관") == "국립경주박물관"
    assert normalize_tourism_anchor_name("불국사 (유네스코 세계문화유산)") == "불국사"
    assert normalize_tourism_anchor_name("불국사 · UNESCO 세계유산") == "불국사"


def test_keeps_identity_bearing_parentheses_and_compound_gyeongju_names():
    assert normalize_tourism_anchor_name(
        "박물관(신관)"
    ) != normalize_tourism_anchor_name("박물관(본관)")
    assert normalize_tourism_anchor_name("박물관(국보관)") == "박물관(국보관)"
    assert normalize_tourism_anchor_name("경주월드") == "경주월드"
    assert normalize_tourism_anchor_name("경주 월드") == "월드"


def test_matches_safe_aliases_only_for_unique_tourism_facilities():
    facility = {"name": "국립경주박물관", "type": "culture"}
    forecasts = [
        {
            "tourist_attraction_name": "경주 국립 경주 박물관",
            "concentration_rate": 63,
        }
    ]

    matches = match_tourism_forecasts_to_facilities([facility], forecasts)

    assert len(matches) == 1
    assert matches[0].facility is facility
    assert matches[0].forecast is forecasts[0]


def test_rejects_duplicate_forecast_collision_instead_of_overwriting():
    facilities = [{"name": "첨성대", "type": "attraction"}]
    forecasts = [
        {"tourist_attraction_name": "첨성대", "concentration_rate": 50},
        {"tourist_attraction_name": "경주 첨성대", "concentration_rate": 80},
    ]

    assert match_tourism_forecasts_to_facilities(facilities, forecasts) == []


def test_rejects_non_tourism_type_and_unrecognized_alias():
    facilities = [
        {"name": "첨성대", "type": "cafe"},
        {"name": "첨성대 동편", "type": "attraction"},
    ]
    forecasts = [{"tourist_attraction_name": "첨성대", "concentration_rate": 50}]

    assert match_tourism_forecasts_to_facilities(facilities, forecasts) == []
