import pytest

from app.routers.recommendations import _attach_tourism_area_priors


def test_tourism_prior_propagates_with_distance_decay():
    facilities = [
        {"name": "대릉원", "latitude": 35.838, "longitude": 129.21},
        {"name": "인근 카페", "latitude": 35.838, "longitude": 129.215},
        {"name": "먼 식당", "latitude": 36.0, "longitude": 129.21},
    ]
    _attach_tourism_area_priors(
        facilities,
        [{"tourist_attraction_name": "대릉원", "concentration_rate": 90}],
    )
    assert facilities[0]["tourapi_concentration_rate"] == 90
    assert 50 < facilities[1]["tourapi_concentration_rate"] < 90
    assert facilities[1]["tourapi_concentration_basis"] == "대릉원"
    assert "tourapi_concentration_rate" not in facilities[2]


def test_tourism_prior_clamps_invalid_source_rate():
    facilities = [{"name": "대릉원", "latitude": 35.838, "longitude": 129.21}]
    _attach_tourism_area_priors(
        facilities,
        [{"tourist_attraction_name": "대릉원", "concentration_rate": 140}],
    )
    assert facilities[0]["tourapi_concentration_rate"] == pytest.approx(100)
