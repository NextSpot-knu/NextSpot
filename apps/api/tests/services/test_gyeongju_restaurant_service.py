import json

import httpx
import pytest

from app.services import gyeongju_restaurant_service as svc


# 팀 실측 CON_SUMMARY 형식(대표메뉴/영업시간/휴무일/주차/편의시설이 한 필드에 <br> 로 구분).
_SUMMARY = (
    "대표메뉴 : 밀면, 연탄불고기&nbsp;<br />\r\n"
    "영업시간 : 11:00-20:00<br />\r\n"
    "휴무일 : 인스타공지<br />\r\n"
    "주차 : 매장 옆 공용주차장 이용<br />\r\n"
    "편의시설 : 현금/카드결제, 화장실, 무선인터넷, 단체석, 포장가능"
)


def _item(**overrides):
    base = {
        "CON_UID": 101,
        "CON_TITLE": "황남밀면",
        "CON_ADDRESS": "경북 경주시 포석로 1",
        "CON_LATITUDE": "35.8361",
        "CON_LONGITUDE": "129.2105",
        "CON_HOMEPAGE": "https://example.com",
        "CON_SUMMARY": _SUMMARY,
    }
    base.update(overrides)
    return base


def _fake_client(payload_text: str, calls: dict | None = None):
    class _Response:
        def __init__(self):
            self.text = payload_text

        def raise_for_status(self):
            return None

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, *_args, **_kwargs):
            if calls is not None:
                calls["n"] = calls.get("n", 0) + 1
            return _Response()

    return lambda **_kwargs: _Client()


def _envelope(items, result_code="00"):
    total = len(items)
    return json.dumps({
        "response": {
            "header": {"resultCode": result_code, "resultMsg": "OK"},
            "body": {"items": {"item": items}, "totalCount": total, "pageNo": 1, "numOfRows": 100},
        }
    }, ensure_ascii=False)


# --- 순수 파서 ---------------------------------------------------------------

def test_parse_summary_splits_labeled_sections():
    parsed = svc.parse_summary(_SUMMARY)
    assert parsed["menu"] == "밀면, 연탄불고기"
    assert parsed["hours"] == "11:00-20:00"
    assert parsed["closed"] == "인스타공지"
    assert parsed["parking"] == "매장 옆 공용주차장 이용"
    assert parsed["amenities"] == "현금/카드결제, 화장실, 무선인터넷, 단체석, 포장가능"


def test_parse_summary_missing_labels_are_none():
    parsed = svc.parse_summary("대표메뉴 : 국밥<br />")
    assert parsed["menu"] == "국밥"
    assert parsed["hours"] is None
    assert parsed["parking"] is None


def test_normalize_restaurant_maps_con_fields_and_summary():
    row = svc.normalize_restaurant(_item())
    assert row == {
        "con_uid": 101,
        "name": "황남밀면",
        "address": "경북 경주시 포석로 1",
        "homepage": "https://example.com",
        "menu": "밀면, 연탄불고기",
        "hours": "11:00-20:00",
        "closed": "인스타공지",
        "parking": "매장 옆 공용주차장 이용",
        "amenities": "현금/카드결제, 화장실, 무선인터넷, 단체석, 포장가능",
        "lat": 35.8361,
        "lng": 129.2105,
    }


def test_normalize_restaurant_requires_name_and_coordinates():
    assert svc.normalize_restaurant({"CON_TITLE": "이름만", "CON_SUMMARY": _SUMMARY}) is None
    assert svc.normalize_restaurant({"CON_LATITUDE": "35.8", "CON_LONGITUDE": "129.2"}) is None
    assert svc.normalize_restaurant("not a dict") is None


def test_parking_normalizes_clear_yes_no_but_keeps_descriptions():
    assert svc._parking("가능") is True
    assert svc._parking("불가") is False
    assert svc._parking("매장 옆 공용주차장 이용") == "매장 옆 공용주차장 이용"
    assert svc._parking(None) is None


# --- 네트워크 경로(mock) -----------------------------------------------------

@pytest.mark.asyncio
async def test_returns_empty_when_not_configured(monkeypatch):
    svc.clear_cache()
    monkeypatch.setattr(svc.settings, "GYEONGJU_FOOD_API_BASE_URL", "")
    monkeypatch.setattr(svc.settings, "GYEONGJU_FOOD_API_KEY", "")
    calls = {"n": 0}
    monkeypatch.setattr(svc.httpx, "AsyncClient", _fake_client(_envelope([_item()]), calls))

    assert await svc.get_gyeongju_restaurants(use_cache=False) == []
    assert calls["n"] == 0  # 미설정이면 네트워크 호출도 하지 않는다.


@pytest.mark.asyncio
async def test_normalizes_confirmed_response_shape(monkeypatch):
    svc.clear_cache()
    monkeypatch.setattr(svc.settings, "GYEONGJU_FOOD_API_BASE_URL", "https://apis.data.go.kr/5050000/menuRstrtService")
    monkeypatch.setattr(svc.settings, "GYEONGJU_FOOD_API_KEY", "test-key")
    monkeypatch.setattr(svc.httpx, "AsyncClient", _fake_client(_envelope([_item(), _item(CON_UID=102, CON_TITLE="교촌쌈밥")])))

    rows = await svc.get_gyeongju_restaurants(use_cache=False)
    assert [r["name"] for r in rows] == ["황남밀면", "교촌쌈밥"]
    assert rows[0]["menu"] == "밀면, 연탄불고기"


@pytest.mark.asyncio
async def test_single_item_dict_is_normalized(monkeypatch):
    svc.clear_cache()
    monkeypatch.setattr(svc.settings, "GYEONGJU_FOOD_API_BASE_URL", "https://apis.data.go.kr/5050000/menuRstrtService")
    monkeypatch.setattr(svc.settings, "GYEONGJU_FOOD_API_KEY", "test-key")
    # items.item 이 단건이면 dict 로 온다.
    single = json.dumps({"response": {"header": {"resultCode": "00"},
                                      "body": {"items": {"item": _item()}, "totalCount": 1}}}, ensure_ascii=False)
    monkeypatch.setattr(svc.httpx, "AsyncClient", _fake_client(single))

    rows = await svc.get_gyeongju_restaurants(use_cache=False)
    assert len(rows) == 1 and rows[0]["name"] == "황남밀면"


@pytest.mark.asyncio
async def test_bad_result_code_yields_empty(monkeypatch):
    svc.clear_cache()
    monkeypatch.setattr(svc.settings, "GYEONGJU_FOOD_API_BASE_URL", "https://apis.data.go.kr/5050000/menuRstrtService")
    monkeypatch.setattr(svc.settings, "GYEONGJU_FOOD_API_KEY", "test-key")
    monkeypatch.setattr(svc.httpx, "AsyncClient", _fake_client(_envelope([_item()], result_code="30")))

    assert await svc.get_gyeongju_restaurants(use_cache=False) == []


@pytest.mark.asyncio
async def test_network_error_is_swallowed(monkeypatch):
    svc.clear_cache()
    monkeypatch.setattr(svc.settings, "GYEONGJU_FOOD_API_BASE_URL", "https://apis.data.go.kr/5050000/menuRstrtService")
    monkeypatch.setattr(svc.settings, "GYEONGJU_FOOD_API_KEY", "test-key")

    class _BoomClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, *_args, **_kwargs):
            raise httpx.ConnectError("boom")

    monkeypatch.setattr(svc.httpx, "AsyncClient", lambda **_kwargs: _BoomClient())
    assert await svc.get_gyeongju_restaurants(use_cache=False) == []
