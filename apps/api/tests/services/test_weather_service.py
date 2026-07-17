from datetime import datetime, timezone, timedelta

from app.services import weather_service


KST = timezone(timedelta(hours=9))


def test_latest_base_uses_previous_day_before_first_release():
    assert weather_service._latest_base(datetime(2026, 7, 17, 1, 0, tzinfo=KST)) == ("20260716", "2300")


def test_parse_forecast_marks_rain_as_indoor_recommended():
    payload = {"response": {"header": {"resultCode": "00"}, "body": {"items": {"item": [
        {"fcstDate": "20260717", "fcstTime": "1200", "category": "TMP", "fcstValue": "29"},
        {"fcstDate": "20260717", "fcstTime": "1200", "category": "SKY", "fcstValue": "4"},
        {"fcstDate": "20260717", "fcstTime": "1200", "category": "PTY", "fcstValue": "1"},
        {"fcstDate": "20260717", "fcstTime": "1200", "category": "POP", "fcstValue": "80"},
        {"fcstDate": "20260717", "fcstTime": "1200", "category": "WSD", "fcstValue": "2.1"},
    ]}}}}
    result = weather_service._parse(payload, datetime(2026, 7, 17, 11, 40, tzinfo=KST))
    assert result is not None
    assert result["source"] == "kma"
    assert result["current"]["temperature_c"] == 29.0
    assert result["indoor_recommended"] is True


def test_parse_rejects_kma_error_envelope():
    assert weather_service._parse({"response": {"header": {"resultCode": "03"}}}, datetime.now(KST)) is None
