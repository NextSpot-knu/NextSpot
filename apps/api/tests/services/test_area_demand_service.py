from datetime import datetime, timezone

import pytest

from app.services import area_demand_service as area


@pytest.mark.asyncio
async def test_parking_live_leads_and_tourism_is_statistical_prior(monkeypatch):
    async def parking(_lat, _lng):
        return {"level": 0.8, "observed_at": "2026-08-20T01:00:00+00:00"}

    async def event(_lat, _lng, _arrival):
        return 0.0, None

    async def weather(_arrival=None):
        return None

    monkeypatch.setattr(area, "get_nearby_parking_signal", parking)
    monkeypatch.setattr(area, "get_event_congestion_boost", event)
    monkeypatch.setattr(area, "get_gyeongju_weather", weather)
    signal = await area.get_area_demand_signal(
        {
            "type": "cafe",
            "latitude": 35.838,
            "longitude": 129.21,
            "tourapi_concentration_rate": 40,
        },
        datetime(2026, 8, 20, 1, tzinfo=timezone.utc),
    )
    assert signal is not None
    assert signal["level"] == pytest.approx(0.68)
    assert signal["mode"] == "live"
    assert signal["sources"] == ["parking", "tourism"]
    assert signal["observed_at"] == "2026-08-20T01:00:00+00:00"


@pytest.mark.asyncio
async def test_tourism_event_and_weather_adjust_without_claiming_live(monkeypatch):
    async def parking(_lat, _lng):
        return None

    async def event(_lat, _lng, _arrival):
        return 0.1, "경주 축제"

    async def weather(_arrival=None):
        return {
            "forecasts": [{
                "at": "2026-08-20T10:00:00+09:00",
                "temperature_c": 25,
                "precipitation_type": 1,
                "precipitation_probability": 80,
                "wind_speed_mps": 2,
            }]
        }

    monkeypatch.setattr(area, "get_nearby_parking_signal", parking)
    monkeypatch.setattr(area, "get_event_congestion_boost", event)
    monkeypatch.setattr(area, "get_gyeongju_weather", weather)
    signal = await area.get_area_demand_signal(
        {
            "type": "cafe",
            "latitude": 35.838,
            "longitude": 129.21,
            "tourapi_concentration_rate": 50,
        },
        datetime(2026, 8, 20, 1, tzinfo=timezone.utc),
    )
    assert signal is not None
    assert signal["level"] == pytest.approx(0.66)
    assert signal["mode"] == "statistical"
    assert signal["sources"] == ["tourism", "festival", "weather"]
    assert signal["event_title"] == "경주 축제"


@pytest.mark.asyncio
async def test_no_public_basis_returns_none_even_with_weather(monkeypatch):
    async def nothing(*_args, **_kwargs):
        return None

    async def no_event(*_args, **_kwargs):
        return 0.0, None

    monkeypatch.setattr(area, "get_nearby_parking_signal", nothing)
    monkeypatch.setattr(area, "get_event_congestion_boost", no_event)
    monkeypatch.setattr(area, "get_gyeongju_weather", nothing)
    signal = await area.get_area_demand_signal(
        {"type": "cafe", "latitude": 35.838, "longitude": 129.21},
        datetime(2026, 8, 20, 1, tzinfo=timezone.utc),
    )
    assert signal is None
