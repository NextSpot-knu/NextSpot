"""행사 혼잡 보정 서비스(A4) 테스트 — 거리 감쇠·폴백·캐시.

conftest 의 autouse 픽스처가 _fetch_ongoing_festivals 를 '키 미설정' 예외로 고정하므로,
축제 데이터가 필요한 테스트는 여기서 다시 패치한다(캐시는 픽스처가 매 테스트 초기화).
"""
from datetime import datetime, timezone

import pytest

from app.services import event_boost

# conftest 의 autouse 픽스처가 모듈 속성을 패치하기 전(수집 시점)에 원본을 잡아둔다.
_REAL_FETCH = event_boost._fetch_ongoing_festivals

# 대릉원 인근 기준점(황리단길 상권 중심 근사값)
BASE_LAT, BASE_LNG = 35.8380, 129.2100
WHEN = datetime(2026, 7, 14, 3, 0, 0, tzinfo=timezone.utc)  # KST 정오


def _patch_festivals(monkeypatch, festivals):
    async def _fake(_today):
        return festivals

    monkeypatch.setattr(event_boost, "_fetch_ongoing_festivals", _fake)


@pytest.mark.asyncio
async def test_boost_is_max_at_festival_location(monkeypatch):
    _patch_festivals(monkeypatch, [{"title": "신라문화제", "latitude": BASE_LAT, "longitude": BASE_LNG}])
    boost, title = await event_boost.get_event_congestion_boost(BASE_LAT, BASE_LNG, WHEN)
    assert boost == pytest.approx(event_boost.MAX_BOOST)
    assert title == "신라문화제"


@pytest.mark.asyncio
async def test_boost_decays_linearly_and_zero_beyond_radius(monkeypatch):
    _patch_festivals(monkeypatch, [{"title": "축제", "latitude": BASE_LAT, "longitude": BASE_LNG}])
    # 위도 1도 ≈ 111.32km → 반경 절반(750m) ≈ 0.006737도
    half_lat = BASE_LAT + (event_boost.RADIUS_M / 2) / 111_320.0
    boost_half, _ = await event_boost.get_event_congestion_boost(half_lat, BASE_LNG, WHEN)
    assert boost_half == pytest.approx(event_boost.MAX_BOOST / 2, rel=0.02)

    # 반경 밖(약 3km) → 보정 없음
    far_lat = BASE_LAT + 3000.0 / 111_320.0
    boost_far, title_far = await event_boost.get_event_congestion_boost(far_lat, BASE_LNG, WHEN)
    assert boost_far == 0.0
    assert title_far is None


@pytest.mark.asyncio
async def test_nearest_festival_wins(monkeypatch):
    near_lat = BASE_LAT + 100.0 / 111_320.0
    far_lat = BASE_LAT + 1000.0 / 111_320.0
    _patch_festivals(monkeypatch, [
        {"title": "먼 축제", "latitude": far_lat, "longitude": BASE_LNG},
        {"title": "가까운 축제", "latitude": near_lat, "longitude": BASE_LNG},
    ])
    boost, title = await event_boost.get_event_congestion_boost(BASE_LAT, BASE_LNG, WHEN)
    assert title == "가까운 축제"
    assert boost > event_boost.MAX_BOOST / 2


@pytest.mark.asyncio
async def test_fetch_failure_falls_back_to_zero_and_negative_caches(monkeypatch):
    calls = {"n": 0}

    async def _boom(_today):
        calls["n"] += 1
        raise RuntimeError("quota")

    monkeypatch.setattr(event_boost, "_fetch_ongoing_festivals", _boom)
    boost, title = await event_boost.get_event_congestion_boost(BASE_LAT, BASE_LNG, WHEN)
    assert (boost, title) == (0.0, None)
    # 네거티브 캐시 — 직후 재호출은 재시도하지 않는다(채점 지연 방지)
    await event_boost.get_event_congestion_boost(BASE_LAT, BASE_LNG, WHEN)
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_success_result_cached_within_ttl(monkeypatch):
    calls = {"n": 0}

    async def _once(_today):
        calls["n"] += 1
        return [{"title": "축제", "latitude": BASE_LAT, "longitude": BASE_LNG}]

    monkeypatch.setattr(event_boost, "_fetch_ongoing_festivals", _once)
    await event_boost.get_event_congestion_boost(BASE_LAT, BASE_LNG, WHEN)
    await event_boost.get_event_congestion_boost(BASE_LAT, BASE_LNG, WHEN)
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_fetch_filters_ongoing_and_coords(monkeypatch):
    """_fetch_ongoing_festivals 자체 검증 — 종료·미래·좌표 0 행 제외."""
    from app.services.tourapi import client as tourapi

    items = [
        {"title": "진행중", "eventstartdate": "20260701", "eventenddate": "20260731",
         "mapy": "35.84", "mapx": "129.21"},
        {"title": "종료됨", "eventstartdate": "20260101", "eventenddate": "20260201",
         "mapy": "35.84", "mapx": "129.21"},
        {"title": "미래", "eventstartdate": "20261001", "eventenddate": "20261010",
         "mapy": "35.84", "mapx": "129.21"},
        {"title": "좌표없음", "eventstartdate": "20260701", "eventenddate": "20260731",
         "mapy": "0", "mapx": "0"},
    ]

    async def _fake_search(*args, **kwargs):
        return {"payload": True}

    monkeypatch.setattr(tourapi, "search_festival", _fake_search)
    monkeypatch.setattr(tourapi, "parse_items", lambda _p: items)

    festivals = await _REAL_FETCH(WHEN.astimezone(event_boost._KST).date())
    assert [f["title"] for f in festivals] == ["진행중"]
