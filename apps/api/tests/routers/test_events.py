"""GET /api/v1/events (경주 축제/행사) 엔드포인트 테스트.

events 라우터만 격리 마운트하고 tourapi.search_festival 을 패치해
변환·정렬·무해 폴백을 결정적으로 검증한다(외부 TourAPI 호출 없음).
"""

import pytest
from datetime import date
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import events
from app.routers.events import transform_festival

TODAY = date(2026, 7, 10)


@pytest.fixture(autouse=True)
def _isolate_detail_cache():
    """축제 상세(overview/homepage/playtime 등) 캐시를 매 테스트 초기화(모듈 전역 dict 격리)."""
    events._detail_cache.clear()
    yield
    events._detail_cache.clear()


def _make_client() -> TestClient:
    app = FastAPI()
    app.include_router(events.router)
    return TestClient(app)


def _detail_common_payload(overview=None, homepage=None) -> dict:
    item = {}
    if overview is not None:
        item["overview"] = overview
    if homepage is not None:
        item["homepage"] = homepage
    return {
        "response": {
            "header": {"resultCode": "0000", "resultMsg": "OK"},
            "body": {"items": {"item": item} if item else {"item": ""}, "totalCount": 1 if item else 0},
        }
    }


def _detail_intro_payload(playtime=None, eventplace=None, usetimefestival=None) -> dict:
    item = {}
    if playtime is not None:
        item["playtime"] = playtime
    if eventplace is not None:
        item["eventplace"] = eventplace
    if usetimefestival is not None:
        item["usetimefestival"] = usetimefestival
    return {
        "response": {
            "header": {"resultCode": "0000", "resultMsg": "OK"},
            "body": {"items": {"item": item} if item else {"item": ""}, "totalCount": 1 if item else 0},
        }
    }


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
    # "on" 은 진행 중이라 상세 2콜이 시도된다 — 결정적 테스트를 위해 키 미설정 시나리오로 고정.
    with patch.object(events.tourapi, "search_festival", mock), \
         patch.object(events.tourapi, "detail_common", AsyncMock(side_effect=RuntimeError("TOURAPI_KEY 없음"))), \
         patch.object(events.tourapi, "detail_intro", AsyncMock(side_effect=RuntimeError("TOURAPI_KEY 없음"))):
        res = _make_client().get("/api/v1/events")

    assert res.status_code == 200
    body = res.json()
    assert body["source"] == "tourapi"
    # 끝난 축제 제외 + 진행 중이 예정보다 앞
    assert [e["content_id"] for e in body["events"]] == ["on", "up"]
    assert body["events"][0]["is_ongoing"] is True
    # 상세 콜 실패 시 신규 필드는 조용히 생략(None) — 기존 필드 계약(제목·기간 등)은 불변
    assert body["events"][0]["overview"] is None
    assert body["events"][0]["homepage"] is None
    assert body["events"][0]["playtime"] is None
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


# --- 축제 상세 조합(퀵윈 C3) — overview/homepage/playtime/event_place/usetime_festival ------


def _ongoing_item(content_id="on") -> dict:
    return _item(contentid=content_id, title="진행 중 축제", eventstartdate="20000101", eventenddate="20990101")


def _upcoming_item(content_id="up") -> dict:
    return _item(contentid=content_id, title="예정 축제", eventstartdate="20990101", eventenddate="20990110")


def test_events_ongoing_enriched_with_detail_success():
    common_mock = AsyncMock(
        return_value=_detail_common_payload(
            overview="신라 천년의 이야기를 만나는 축제입니다.",
            homepage='<a href="http://festival.gyeongju.go.kr" target="_blank">공식 홈페이지</a>',
        )
    )
    intro_mock = AsyncMock(
        return_value=_detail_intro_payload(
            playtime="13:00 ~ 22:00", eventplace="경주 대릉원 일원", usetimefestival="무료",
        )
    )
    with patch.object(events.tourapi, "search_festival", AsyncMock(return_value=_payload([_ongoing_item()]))), \
         patch.object(events.tourapi, "detail_common", common_mock), \
         patch.object(events.tourapi, "detail_intro", intro_mock):
        res = _make_client().get("/api/v1/events")

    assert res.status_code == 200
    ev = res.json()["events"][0]
    assert ev["overview"] == "신라 천년의 이야기를 만나는 축제입니다."
    # homepage 는 href 원문 그대로(HTML anchor 포함) — 추출은 프런트 몫이라 백엔드는 가공하지 않는다.
    assert ev["homepage"] == '<a href="http://festival.gyeongju.go.kr" target="_blank">공식 홈페이지</a>'
    assert ev["playtime"] == "13:00 ~ 22:00"
    assert ev["event_place"] == "경주 대릉원 일원"
    assert ev["usetime_festival"] == "무료"
    # detailIntro2 는 contentTypeId=15(행사) 고정으로 호출돼야 한다.
    assert intro_mock.await_args.args[1] == 15


def test_events_detail_partial_failure_omits_only_that_half():
    # detailCommon2 는 실패, detailIntro2 는 성공 — 실패한 절반만 생략되고 나머지는 살아야 한다.
    with patch.object(events.tourapi, "search_festival", AsyncMock(return_value=_payload([_ongoing_item()]))), \
         patch.object(events.tourapi, "detail_common", AsyncMock(side_effect=RuntimeError("network"))), \
         patch.object(
             events.tourapi, "detail_intro",
             AsyncMock(return_value=_detail_intro_payload(playtime="10시 ~ 18시")),
         ):
        res = _make_client().get("/api/v1/events")

    assert res.status_code == 200
    ev = res.json()["events"][0]
    assert ev["overview"] is None
    assert ev["homepage"] is None
    assert ev["playtime"] == "10시 ~ 18시"
    # 목록 자체·기존 필드(제목 등)는 상세 실패와 무관하게 살아 있다.
    assert ev["title"] == "진행 중 축제"


def test_events_detail_not_fetched_for_upcoming_events():
    # 예정 축제는 상세 2콜을 아예 시도하지 않는다(쿼터 무해 — 진행 중 축제 수 × 2콜).
    common_mock = AsyncMock(return_value=_detail_common_payload(overview="호출되면 안 됨"))
    intro_mock = AsyncMock(return_value=_detail_intro_payload(playtime="호출되면 안 됨"))
    with patch.object(events.tourapi, "search_festival", AsyncMock(return_value=_payload([_upcoming_item()]))), \
         patch.object(events.tourapi, "detail_common", common_mock), \
         patch.object(events.tourapi, "detail_intro", intro_mock):
        res = _make_client().get("/api/v1/events")

    assert res.status_code == 200
    ev = res.json()["events"][0]
    assert ev["is_ongoing"] is False
    assert ev["overview"] is None
    assert ev["playtime"] is None
    assert common_mock.await_count == 0
    assert intro_mock.await_count == 0


def test_events_detail_cached_within_ttl():
    # 같은 요청 안에서도(동일 content_id 재조회 없음), 그리고 두 번째 요청에서도 1h 캐시가 재사용돼
    # detailCommon2/detailIntro2 가 축제당 1회씩만 불려야 한다.
    common_mock = AsyncMock(return_value=_detail_common_payload(overview="캐시 확인용 개요"))
    intro_mock = AsyncMock(return_value=_detail_intro_payload(playtime="13:00 ~ 22:00"))
    with patch.object(events.tourapi, "search_festival", AsyncMock(return_value=_payload([_ongoing_item()]))), \
         patch.object(events.tourapi, "detail_common", common_mock), \
         patch.object(events.tourapi, "detail_intro", intro_mock):
        client = _make_client()
        res1 = client.get("/api/v1/events")
        res2 = client.get("/api/v1/events")

    assert res1.json()["events"][0]["overview"] == "캐시 확인용 개요"
    assert res2.json()["events"][0]["overview"] == "캐시 확인용 개요"
    assert common_mock.await_count == 1
    assert intro_mock.await_count == 1


@pytest.mark.asyncio
async def test_get_festival_detail_cached_negative_caches_failure():
    # 실패(빈 dict)도 캐싱돼 장애 시 재요청마다 재시도하지 않는다(event_boost 의 네거티브 캐싱과 동일 원칙).
    calls = {"n": 0}

    async def _boom(_content_id):
        calls["n"] += 1
        raise RuntimeError("quota")

    with patch.object(events.tourapi, "detail_common", _boom), \
         patch.object(events.tourapi, "detail_intro", AsyncMock(side_effect=RuntimeError("quota"))):
        first = await events._get_festival_detail_cached("boom")
        second = await events._get_festival_detail_cached("boom")

    assert first == {} and second == {}
    assert calls["n"] == 1
