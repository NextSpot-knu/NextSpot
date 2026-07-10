"""GET /api/v1/events (경주 축제/행사) 엔드포인트 테스트.

events 라우터만 격리 마운트하고 tourapi.search_festival 을 패치해
변환·정렬·무해 폴백을 결정적으로 검증한다(외부 TourAPI 호출 없음).
"""

from datetime import date
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import events
from app.routers.events import transform_festival

TODAY = date(2026, 7, 10)


def _make_client() -> TestClient:
    app = FastAPI()
    app.include_router(events.router)
    return TestClient(app)


def _item(**over) -> dict:
    base = {
        "contentid": "3021483",
        "title": "신라문화제",
        "eventstartdate": "20261009",
        "eventenddate": "20261012",
        "addr1": "경상북도 경주시 노동동",
        "firstimage": "http://tong.visitkorea.or.kr/f.jpg",
        "firstimage2": "http://tong.visitkorea.or.kr/f2.jpg",
        "mapx": "129.2105",
        "mapy": "35.8361",
        "tel": "054-000-0000",
    }
    base.update(over)
    return base


def _payload(items: list[dict]) -> dict:
    return {
        "response": {
            "header": {"resultCode": "0000", "resultMsg": "OK"},
            "body": {"items": {"item": items}, "totalCount": len(items)},
        }
    }


# --- transform_festival 순수 함수 -------------------------------------------

def test_transform_upcoming():
    ev = transform_festival(_item(), TODAY)
    assert ev is not None
    assert ev.title == "신라문화제"
    assert ev.start_date == "2026-10-09"
    assert ev.end_date == "2026-10-12"
    assert ev.is_ongoing is False
    assert ev.latitude == 35.8361 and ev.longitude == 129.2105
    assert ev.image_url == "https://tong.visitkorea.or.kr/f.jpg"  # http → https 승격


def test_transform_ongoing_flag():
    ev = transform_festival(
        _item(eventstartdate="20260701", eventenddate="20260720"), TODAY
    )
    assert ev is not None and ev.is_ongoing is True


def test_transform_drops_ended_and_malformed():
    # 이미 끝난 축제는 목록에서 제외
    assert transform_festival(_item(eventenddate="20260709"), TODAY) is None
    # 날짜 비정형 / 제목 없음도 제외
    assert transform_festival(_item(eventstartdate="not-a-date"), TODAY) is None
    assert transform_festival(_item(title="  "), TODAY) is None


def test_transform_zero_coords_and_image_fallback():
    ev = transform_festival(_item(mapx="0", mapy="0", firstimage=""), TODAY)
    assert ev is not None
    assert ev.latitude is None and ev.longitude is None
    # firstimage 가 비면 firstimage2 로 폴백
    assert ev.image_url == "https://tong.visitkorea.or.kr/f2.jpg"  # 폴백 + https 승격


# --- GET /api/v1/events ------------------------------------------------------

def test_events_sorted_ongoing_first_with_ldong_filter():
    items = [
        _item(contentid="up", title="예정 축제", eventstartdate="20990101", eventenddate="20990110"),
        _item(contentid="on", title="진행 중 축제", eventstartdate="20000101", eventenddate="20990101"),
        _item(contentid="ended", title="끝난 축제", eventstartdate="20000101", eventenddate="20000102"),
    ]
    mock = AsyncMock(return_value=_payload(items))
    with patch.object(events.tourapi, "search_festival", mock):
        res = _make_client().get("/api/v1/events")

    assert res.status_code == 200
    body = res.json()
    assert body["source"] == "tourapi"
    # 끝난 축제 제외 + 진행 중이 예정보다 앞
    assert [e["content_id"] for e in body["events"]] == ["on", "up"]
    assert body["events"][0]["is_ongoing"] is True
    # 지역 필터는 법정동 코드(경북=47, 경주=130) — 구 areaCode 는 조용히 0건이 되므로 회귀 방지
    kwargs = mock.await_args.kwargs
    assert kwargs["ldong_regn_cd"] == 47 and kwargs["ldong_signgu_cd"] == 130


def test_events_limit():
    items = [
        _item(contentid=f"e{i}", eventstartdate="20990101", eventenddate="20990110")
        for i in range(5)
    ]
    with patch.object(events.tourapi, "search_festival", AsyncMock(return_value=_payload(items))):
        res = _make_client().get("/api/v1/events", params={"limit": 2})
    assert res.status_code == 200
    assert len(res.json()["events"]) == 2


def test_events_unavailable_fallback():
    # 키 미설정(RuntimeError)·API 오류(TourAPIError) 모두 200 + 빈 목록으로 흡수돼야 한다.
    with patch.object(
        events.tourapi, "search_festival", AsyncMock(side_effect=RuntimeError("TOURAPI_KEY 없음"))
    ):
        res = _make_client().get("/api/v1/events")
    assert res.status_code == 200
    assert res.json() == {"events": [], "source": "unavailable"}
