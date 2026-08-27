import pytest

from app.routers.recommendations import _attach_tourism_area_priors


def test_tourism_prior_propagates_with_distance_decay():
    facilities = [
        {
            "name": "대릉원",
            "type": "attraction",
            "latitude": 35.838,
            "longitude": 129.21,
        },
        {"name": "인근 카페", "type": "cafe", "latitude": 35.838, "longitude": 129.215},
        {
            "name": "먼 식당",
            "type": "restaurant",
            "latitude": 36.0,
            "longitude": 129.21,
        },
    ]
    _attach_tourism_area_priors(
        facilities,
        [
            {
                "tourist_attraction_name": "경주 대릉원 일원",
                "concentration_rate": 90,
                "forecast_date": "2026-08-24",
            }
        ],
    )
    assert facilities[0]["tourapi_concentration_rate"] == 90
    assert 50 < facilities[1]["tourapi_concentration_rate"] < 90
    assert facilities[1]["tourapi_concentration_basis"] == "경주 대릉원 일원"
    assert facilities[1]["tourapi_concentration_source_rate"] == 90
    assert facilities[1]["tourapi_concentration_forecast_date"] == "2026-08-24"
    assert "tourapi_concentration_rate" not in facilities[2]


def test_tourism_prior_clamps_invalid_source_rate():
    facilities = [
        {
            "name": "대릉원",
            "type": "attraction",
            "latitude": 35.838,
            "longitude": 129.21,
        }
    ]
    _attach_tourism_area_priors(
        facilities,
        [{"tourist_attraction_name": "대릉원", "concentration_rate": 140}],
    )
    assert facilities[0]["tourapi_concentration_rate"] == pytest.approx(100)


def test_tourism_prior_rejects_ambiguous_normalized_facilities():
    facilities = [
        {
            "name": "대릉원",
            "type": "attraction",
            "latitude": 35.838,
            "longitude": 129.21,
        },
        {
            "name": "경주 대릉원",
            "type": "culture",
            "latitude": 35.839,
            "longitude": 129.21,
        },
    ]
    _attach_tourism_area_priors(
        facilities,
        [{"tourist_attraction_name": "경주 대릉원", "concentration_rate": 80}],
    )

    assert all("tourapi_concentration_rate" not in facility for facility in facilities)


def test_tourism_prior_never_uses_a_cafe_as_a_forecast_anchor():
    facilities = [
        {"name": "첨성대", "type": "cafe", "latitude": 35.835, "longitude": 129.219},
    ]
    _attach_tourism_area_priors(
        facilities,
        [{"tourist_attraction_name": "첨성대", "concentration_rate": 75}],
    )

    assert "tourapi_concentration_rate" not in facilities[0]
