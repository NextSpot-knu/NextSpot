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


# =========================================================================
# P3a3 commit 7 — 붙이기가 이벤트 루프 밖(스레드)에서 돌고, 결과 행은 루프 안에서 붙인 것과 같다
# =========================================================================

def _prior_fixture() -> tuple[list[dict], list[dict]]:
    import random

    rng = random.Random(5)
    facilities = [
        {"id": "a-1", "name": "대릉원", "type": "attraction", "latitude": 35.838, "longitude": 129.21},
        {"id": "a-2", "name": "첨성대", "type": "attraction", "latitude": 35.8347, "longitude": 129.2190},
        {"id": "c-0", "name": "좌표 없는 카페", "type": "cafe", "latitude": None, "longitude": None},
    ]
    for i in range(120):
        facilities.append({
            "id": f"f-{i}", "name": f"시설 {i}", "type": rng.choice(["cafe", "restaurant", "culture"]),
            "latitude": 35.8361 + rng.uniform(-0.03, 0.03), "longitude": 129.2105 + rng.uniform(-0.03, 0.03),
            "features": {"indoor": bool(i % 2)},
        })
    forecasts = [
        {"tourist_attraction_name": "경주 대릉원 일원", "concentration_rate": 90, "forecast_date": "2026-09-29"},
        {"tourist_attraction_name": "첨성대", "concentration_rate": 35.5, "forecast_date": "2026-09-29"},
    ]
    return facilities, forecasts


class _ForecastQuery:
    def __init__(self, rows):
        self._rows = rows

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def execute(self):
        return type("Result", (), {"data": list(self._rows)})()


class _ForecastClient:
    def __init__(self, rows):
        self._rows = rows

    def table(self, name):
        assert name == "tourism_concentration_forecasts"
        return _ForecastQuery(self._rows)


@pytest.mark.asyncio
async def test_prior_attach_runs_off_the_event_loop_with_the_same_rows(monkeypatch):
    import copy
    import threading

    from app.routers import recommendations
    from app.services.tourism_area_prior_service import attach_tourism_area_priors

    facilities, forecasts = _prior_fixture()

    async def _active(_client, _select="*", **_kwargs):
        return copy.deepcopy(facilities)

    threads: list[threading.Thread] = []
    real_attach = recommendations._attach_tourism_area_priors

    def _recording_attach(rows, data):
        threads.append(threading.current_thread())
        real_attach(rows, data)

    monkeypatch.setattr(recommendations, "fetch_active_facilities", _active)
    monkeypatch.setattr(recommendations, "supabase_client", _ForecastClient(forecasts))
    monkeypatch.setattr(recommendations, "_attach_tourism_area_priors", _recording_attach)

    rows = await recommendations._fetch_all_facilities_uncached()

    assert len(threads) == 1 and threads[0] is not threading.main_thread()
    expected = copy.deepcopy(facilities)
    attach_tourism_area_priors(expected, forecasts)  # 루프 안에서 붙인 것(예전 방식)
    assert rows == expected
    assert rows[0]["tourapi_concentration_rate"] == 90
    assert any("tourapi_concentration_basis" in row for row in rows[3:])


@pytest.mark.asyncio
async def test_prior_attach_failure_still_returns_the_rows(monkeypatch):
    import copy

    from app.routers import recommendations

    facilities, forecasts = _prior_fixture()

    async def _active(_client, _select="*", **_kwargs):
        return copy.deepcopy(facilities)

    def _boom(_rows, _data):
        raise RuntimeError("prior attach failed")

    monkeypatch.setattr(recommendations, "fetch_active_facilities", _active)
    monkeypatch.setattr(recommendations, "supabase_client", _ForecastClient(forecasts))
    monkeypatch.setattr(recommendations, "_attach_tourism_area_priors", _boom)

    rows = await recommendations._fetch_all_facilities_uncached()
    assert rows == facilities
