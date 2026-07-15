from app.services.tourapi.insights import normalized_concentration_rows


def test_normalized_concentration_rows_preserves_relative_meaning():
    payload = {"response": {"body": {"items": {"item": [{
        "tAtsCd": "47130001", "tAtsNm": "대릉원", "fcastYmd": "20260720", "cnctrRate": "72.5"
    }]}}}}
    assert normalized_concentration_rows(payload) == [{
        "tourist_attraction_code": "47130001",
        "tourist_attraction_name": "대릉원",
        "forecast_date": "2026-07-20",
        "concentration_rate": 72.5,
        "raw": payload["response"]["body"]["items"]["item"][0],
    }]


def test_normalized_concentration_rows_rejects_incomplete_values():
    payload = {"response": {"body": {"items": {"item": [
        {"tAtsNm": "날짜 없음", "cnctrRate": 20},
        {"tAtsNm": "비정형", "fcastYmd": "20260720", "cnctrRate": "unknown"},
    ]}}}}
    assert normalized_concentration_rows(payload) == []
