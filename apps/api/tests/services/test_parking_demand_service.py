import asyncio

import httpx
import pytest

from app.services import parking_demand_service as parking


def _response(body: str, content_type: str = "application/json") -> httpx.Response:
    return httpx.Response(200, text=body, headers={"content-type": content_type})


def test_parse_payload_accepts_official_xml():
    payload = parking._parse_payload(_response("""
        <response><header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header>
        <body><items><item><prk_center_id>g1</prk_center_id></item></items>
        <totalCount>1</totalCount></body></response>
    """, "application/xml"))
    assert parking._result_code(payload) == "00"
    assert parking._items(payload) == [{"prk_center_id": "g1"}]
    assert parking._total_count(payload) == 1


def test_parse_payload_classifies_gateway_pseudo_json_without_leaking_body():
    with pytest.raises(parking.ParkingUpstreamError, match="upstream_rejected") as exc:
        parking._parse_payload(_response("{ result_desc:'fail', result_code:'-999', http_status:'200' }", "text/html"))
    assert str(exc.value) == "upstream_rejected"


def test_parse_payload_accepts_legacy_top_level_json():
    payload = parking._parse_payload(_response(
        '{"resultCode":"0","totalCount":"1","PrkSttusInfo":[{"prk_center_id":"g1"}]}'
    ))
    assert parking._result_code(payload) == "0"
    assert parking._items(payload) == [{"prk_center_id": "g1"}]
    assert parking._total_count(payload) == 1


def test_normalize_official_parking_fields_and_filter_gyeongju():
    rows = [
        {"prk_center_id": "g1", "prk_plce_nm": "대릉원 주차장", "prk_plce_adres": "경주시 황남동",
         "prk_plce_entrc_la": "35.838", "prk_plce_entrc_lo": "129.210"},
        {"prk_center_id": "s1", "prk_plce_nm": "서울", "prk_plce_adres": "서울시",
         "prk_plce_entrc_la": "37.5", "prk_plce_entrc_lo": "127.0"},
    ]
    assert parking.normalize_facilities(rows) == [{
        "id": "g1", "name": "대릉원 주차장", "latitude": 35.838, "longitude": 129.21,
    }]


def test_normalize_official_realtime_fields_clamps_available():
    rows = [
        {"prk_center_id": "g1", "pkfc_ParkingLots_total": "100", "pkfc_Available_ParkingLots_total": "25"},
        {"prk_center_id": "g2", "pkfc_ParkingLots_total": "10", "pkfc_Available_ParkingLots_total": "12"},
        {"prk_center_id": "bad", "pkfc_ParkingLots_total": "0", "pkfc_Available_ParkingLots_total": "0"},
    ]
    assert parking.normalize_realtime(rows) == {
        "g1": {"total": 100, "available": 25},
        "g2": {"total": 10, "available": 10},
    }


def test_normalize_gyeongju_its_uses_only_operating_live_details():
    facilities, realtime = parking.normalize_gyeongju_its(
        [
            {"FCLTS_SN": "87", "FCLTS_NM": "봉황대공영주차장", "X_CNTS": 129.2124,
             "Y_DNTS": 35.8403, "STTS": "Y"},
            {"FCLTS_SN": "92", "FCLTS_NM": "황리단길", "X_CNTS": 129.2100,
             "Y_DNTS": 35.8372, "STTS": "N"},
        ],
        {
            "87": {"TOT_PARKNG_NOPG": 95, "TOTAL_IMP_CNT": 55},
            "92": {"TOT_PARKNG_NOPG": 17, "TOTAL_IMP_CNT": 9},
        },
    )
    assert [facility["id"] for facility in facilities] == ["gyeongju-its:87", "gyeongju-its:92"]
    assert realtime == {"gyeongju-its:87": {"total": 95, "available": 55}}


@pytest.mark.asyncio
async def test_nearby_signal_uses_only_live_parking_within_radius(monkeypatch):
    now = parking.time.monotonic()
    monkeypatch.setattr(parking, "_facility_cache", (now, 300.0, [
        {"id": "near", "name": "가까운 주차장", "latitude": 35.838, "longitude": 129.210},
        {"id": "far", "name": "먼 주차장", "latitude": 36.0, "longitude": 129.210},
    ]))
    monkeypatch.setattr(parking, "_realtime_cache", (now, 300.0, {
            "near": {"total": 100, "available": 20},
            "far": {"total": 100, "available": 100},
    }))
    monkeypatch.setattr(parking, "_realtime_status", {"state": "available", "checked_at": "r", "error_code": None})
    signal = await parking.get_nearby_parking_signal(35.838, 129.210)
    assert signal is not None
    assert signal["level"] == pytest.approx(0.8)
    assert signal["parking_count"] == 1
    assert signal["available_spaces"] == 20


@pytest.mark.asyncio
async def test_coverage_status_distinguishes_no_gyeongju_realtime(monkeypatch):
    now = parking.time.monotonic()
    monkeypatch.setattr(parking.settings, "PARKING_API_KEY", "configured")
    monkeypatch.setattr(parking, "_facility_cache", (now, 300.0, [
        {"id": "g1", "name": "경주 주차장", "latitude": 35.838, "longitude": 129.210}
    ]))
    monkeypatch.setattr(parking, "_realtime_cache", (now, 300.0, {
        "other": {"total": 100, "available": 20}
    }))
    monkeypatch.setattr(parking, "_facility_status", {"state": "available", "checked_at": "f", "error_code": None})
    monkeypatch.setattr(parking, "_realtime_status", {
        "state": "available", "checked_at": "r", "error_code": None, "source": "gyeongju_its"
    })

    status = await parking.get_parking_coverage_status(35.838, 129.210)
    assert status["state"] == "no_gyeongju_realtime"
    assert status["available"] is False
    assert status["gyeongju_facility_count"] == 1
    assert status["gyeongju_realtime_count"] == 0


@pytest.mark.asyncio
async def test_cold_cache_does_not_wait_for_slow_upstream(monkeypatch):
    hold = asyncio.Event()
    started = 0

    async def slow_loader():
        nonlocal started
        started += 1
        await hold.wait()

    monkeypatch.setattr(parking.settings, "PARKING_API_KEY", "configured")
    monkeypatch.setattr(parking, "_facility_cache", None)
    monkeypatch.setattr(parking, "_realtime_cache", None)
    monkeypatch.setattr(parking, "_refresh_tasks", {})
    monkeypatch.setattr(parking, "_refresh_sources", slow_loader)

    assert await parking.get_nearby_parking_signal(35.838, 129.210) is None
    await asyncio.sleep(0)
    assert started == 1

    tasks = list(parking._refresh_tasks.values())
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.asyncio
async def test_refresh_sources_prefers_gyeongju_its(monkeypatch):
    facilities = [
        {"id": "gyeongju-its:87", "name": "봉황대공영주차장", "latitude": 35.84, "longitude": 129.21}
    ]
    realtime = {"gyeongju-its:87": {"total": 95, "available": 55}}

    async def city_source():
        return facilities, realtime

    async def national_source():
        raise AssertionError("national API must not run when city ITS succeeds")

    monkeypatch.setattr(parking, "_fetch_gyeongju_its", city_source)
    monkeypatch.setattr(parking, "_facilities_cached", national_source)
    monkeypatch.setattr(parking, "_realtime_cached", national_source)
    monkeypatch.setattr(parking, "_facility_cache", None)
    monkeypatch.setattr(parking, "_realtime_cache", None)

    await parking._refresh_sources()

    assert parking._facility_cache is not None
    assert parking._facility_cache[2] == facilities
    assert parking._realtime_cache is not None
    assert parking._realtime_cache[2] == realtime
    assert parking._realtime_status["source"] == "gyeongju_its"
