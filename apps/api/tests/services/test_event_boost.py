"""행사 혼잡 보정 서비스(A4) 테스트 — 거리 감쇠·폴백·캐시.

conftest 의 autouse 픽스처가 _fetch_ongoing_festivals 를 '키 미설정' 예외로 고정하므로,
축제 데이터가 필요한 테스트는 여기서 다시 패치한다(캐시는 픽스처가 매 테스트 초기화).
"""
from datetime import datetime, timezone
from datetime import time as dtime

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


# --- 구현 2: 공연시간 정밀 보정(1-4) — playtime 파서 ------------------------------------


def test_parse_playtime_windows_normal_colon_format():
    # 정상 1. 'HH:MM ~ HH:MM' (실측: 경주 대릉원돌담길 축제 contentid=2485128)
    assert event_boost.parse_playtime_windows("13:00 ~ 22:00") == [(dtime(13, 0), dtime(22, 0))]


def test_parse_playtime_windows_normal_si_format_and_multi_window():
    # 정상 2. 'HH시 ~ HH시' + 복수 시간 창(콤마 구분) 모두 인식
    assert event_boost.parse_playtime_windows("10시 ~ 18시") == [(dtime(10, 0), dtime(18, 0))]
    assert event_boost.parse_playtime_windows("10:00~12:30, 15:00~18:00") == [
        (dtime(10, 0), dtime(12, 30)),
        (dtime(15, 0), dtime(18, 0)),
    ]


def test_parse_playtime_windows_empty_returns_none():
    # 실패 1. 빈 값/공백만 → None(호출부는 기존 종일 보정 유지)
    assert event_boost.parse_playtime_windows("") is None
    assert event_boost.parse_playtime_windows("   ") is None
    assert event_boost.parse_playtime_windows(None) is None


def test_parse_playtime_windows_no_recognizable_pattern_returns_none():
    # 실패 2. 명확한 시간 패턴이 없는 자유 텍스트 → None(억지 추출 금지)
    assert event_boost.parse_playtime_windows("상시 개방") is None
    assert event_boost.parse_playtime_windows("사전 예약 문의") is None


def test_parse_playtime_windows_boundary_midnight_hour():
    # 경계. 24:00(자정) 은 23:59 로 정규화, 시작≥종료(자정 넘김 등 모호)는 해당 매치만 버림
    assert event_boost.parse_playtime_windows("09:00 ~ 24:00") == [(dtime(9, 0), dtime(23, 59))]
    assert event_boost.parse_playtime_windows("22:00 ~ 09:00") is None  # 자정 넘김 — 구현 범위 밖


# --- 구현 2: 공연시간 정밀 보정(1-4) — event_boost 시간 창 게이트(목킹) -------------------


def _patch_playtime_windows(monkeypatch, windows):
    async def _fake(_contentid):
        return windows

    monkeypatch.setattr(event_boost, "_get_playtime_windows_cached", _fake)


@pytest.mark.asyncio
async def test_boost_applied_when_arrival_inside_playtime_buffer(monkeypatch):
    _patch_festivals(monkeypatch, [
        {"title": "돌담길 축제", "latitude": BASE_LAT, "longitude": BASE_LNG, "contentid": "2485128"},
    ])
    _patch_playtime_windows(monkeypatch, [(dtime(13, 0), dtime(22, 0))])

    when_in_window = datetime(2026, 7, 14, 6, 30, 0, tzinfo=timezone.utc)  # KST 15:30 — 창 안
    boost, title = await event_boost.get_event_congestion_boost(BASE_LAT, BASE_LNG, when_in_window)
    assert boost == pytest.approx(event_boost.MAX_BOOST)
    assert title == "돌담길 축제"


@pytest.mark.asyncio
async def test_boost_zeroed_when_arrival_outside_playtime_buffer(monkeypatch):
    _patch_festivals(monkeypatch, [
        {"title": "돌담길 축제", "latitude": BASE_LAT, "longitude": BASE_LNG, "contentid": "2485128"},
    ])
    _patch_playtime_windows(monkeypatch, [(dtime(13, 0), dtime(22, 0))])

    # KST 08:00 — 시간 창(13:00~22:00) ±1h 버퍼(12:00~23:00) 밖
    when_outside = datetime(2026, 7, 13, 23, 0, 0, tzinfo=timezone.utc)
    boost, title = await event_boost.get_event_congestion_boost(BASE_LAT, BASE_LNG, when_outside)
    assert (boost, title) == (0.0, None)


@pytest.mark.asyncio
async def test_boost_falls_back_to_all_day_when_playtime_unavailable(monkeypatch):
    # playtime 조회/파싱 실패(None) → 기존 '기간 중 종일' 보정 그대로(무해 폴백)
    _patch_festivals(monkeypatch, [
        {"title": "돌담길 축제", "latitude": BASE_LAT, "longitude": BASE_LNG, "contentid": "2485128"},
    ])
    _patch_playtime_windows(monkeypatch, None)

    when_any = datetime(2026, 7, 13, 23, 0, 0, tzinfo=timezone.utc)  # 시간 창이면 제외될 이른 시각
    boost, title = await event_boost.get_event_congestion_boost(BASE_LAT, BASE_LNG, when_any)
    assert boost == pytest.approx(event_boost.MAX_BOOST)
    assert title == "돌담길 축제"


@pytest.mark.asyncio
async def test_boost_skips_playtime_lookup_when_festival_has_no_contentid(monkeypatch):
    # contentid 가 없으면(구형 캐시/미상) playtime 조회 자체를 시도하지 않고 기존 종일 보정 유지
    calls = {"n": 0}

    async def _should_not_be_called(_contentid):
        calls["n"] += 1
        return None

    monkeypatch.setattr(event_boost, "_get_playtime_windows_cached", _should_not_be_called)
    _patch_festivals(monkeypatch, [
        {"title": "구형 축제", "latitude": BASE_LAT, "longitude": BASE_LNG},  # contentid 키 없음
    ])

    boost, title = await event_boost.get_event_congestion_boost(BASE_LAT, BASE_LNG, WHEN)
    assert boost == pytest.approx(event_boost.MAX_BOOST)
    assert title == "구형 축제"
    assert calls["n"] == 0


@pytest.mark.asyncio
async def test_playtime_lookup_cached_per_festival_within_ttl(monkeypatch):
    """detail_intro 는 축제당 1회만 호출되고, 24h TTL 내 재호출은 캐시가 응답한다."""
    from app.services.tourapi import client as tourapi_client

    calls = {"n": 0}

    async def _fake_detail_intro(_content_id, _content_type_id):
        calls["n"] += 1
        return {
            "response": {
                "header": {"resultCode": "0000"},
                "body": {"items": {"item": {"playtime": "13:00 ~ 22:00"}}},
            }
        }

    monkeypatch.setattr(tourapi_client, "detail_intro", _fake_detail_intro)
    monkeypatch.setattr(event_boost, "_playtime_cache", {})
    _patch_festivals(monkeypatch, [
        {"title": "돌담길 축제", "latitude": BASE_LAT, "longitude": BASE_LNG, "contentid": "2485128"},
    ])

    when_in_window = datetime(2026, 7, 14, 6, 30, 0, tzinfo=timezone.utc)  # KST 15:30 — 창 안
    await event_boost.get_event_congestion_boost(BASE_LAT, BASE_LNG, when_in_window)
    await event_boost.get_event_congestion_boost(BASE_LAT, BASE_LNG, when_in_window)
    assert calls["n"] == 1
