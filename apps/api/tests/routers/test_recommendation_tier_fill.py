"""영업 근거 등급 채움(P1-4) — 요청이 청하고(fill_weaker_tiers) 확인 등급이 카드 수보다 적을 때만 다음 등급에서 채운다.

예전(keep_best_eligibility_tier)에는 가장 강한 등급만 남겨, 영업시간이 확인된 곳이 반경에 하나라도 있으면
영업시간이 빈 카카오·LocalData 행이 통째로 빠졌다 — 모두가 같은 소수 가게로 몰렸다. 채우면 확인된 곳이 언제나
앞이고(정렬은 등급 먼저), 채운 카드는 자기 등급('영업 확인 필요')을 단다. 배포된 구 번들은 응답을 점수로 다시
줄 세워 등급을 보지 않으므로, 플래그가 없거나 false 면 종전처럼 가장 강한 등급만 돌려준다.
"""
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.core.supabase import get_current_user
from app.main import app
from app.services.preference_vector_service import preference_vector_service
from app.services.spot.travel import WalkingRoute

USER_ID = "u-tier"
LAT, LNG = 35.8360, 129.2100
USER_ROW = {"id": USER_ID, "preferred_categories": ["cafe"]}
UNIT_VECTOR = [1.0 / (8 ** 0.5)] * 8


class _Result:
    def __init__(self, data):
        self.data = data


class _Table:
    def __init__(self, data):
        self._data = data

    def __getattr__(self, _name):
        return lambda *_args, **_kwargs: self

    def execute(self):
        return _Result(self._data)


class _Db:
    """추천 저장(INSERT)은 고정 id 를 돌려주고 나머지 조회는 빈 결과."""

    def table(self, name):
        return _Table([{"id": "11111111-2222-4333-8444-555555555555"}] if name == "recommendations" else [])


def _cafe(facility_id: str, lat_offset: float) -> dict:
    return {
        "id": facility_id, "name": facility_id, "type": "cafe",
        "latitude": LAT + lat_offset, "longitude": LNG, "capacity": 30, "coupon_rate": 0.0,
        "features": {"average_processing_time": 10},
        "operating_hours": {},
    }


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = lambda: {"id": USER_ID, "role": "authenticated"}
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_current_user, None)


_ABSENT = object()  # 요청에 fill_weaker_tiers 를 아예 싣지 않는다(구 번들)


def _run_by_type(client, cafes, routes, tier_by_id, limit, fill=True):
    body = {"user_id": USER_ID, "facility_type": "cafe", "user_lat": LAT, "user_lng": LNG, "limit": limit}
    if fill is not _ABSENT:
        body["fill_weaker_tiers"] = fill
    with patch("app.routers.recommendations.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.recommendations.fetch_all_facilities", new=AsyncMock(return_value=cafes)), \
         patch("app.routers.recommendations.get_walking_routes", new=AsyncMock(return_value=routes)), \
         patch(
             "app.routers.recommendations.recommendation_eligibility_tier",
             side_effect=lambda facility, _arrival, _source: tier_by_id[facility["id"]],
         ), \
         patch("app.routers.recommendations.fetch_congestion_map", new=AsyncMock(return_value={})), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)), \
         patch("app.routers.recommendations.generate_reason_with_source", new=AsyncMock(return_value=("사유", "template"))), \
         patch("app.routers.recommendations.supabase_client", new=_Db()):
        return client.post("/api/v1/recommendations/by-type", json=body)


def _by_type_fixture():
    cafes = [_cafe("verified-a", 0.0004), _cafe("verified-b", 0.0006), _cafe("unknown-near", 0.0002),
             _cafe("unknown-far", 0.0008)]
    routes = [WalkingRoute(3.0, 195.0, "osm_pedestrian"), WalkingRoute(4.0, 260.0, "osm_pedestrian"),
              WalkingRoute(1.0, 65.0, "osm_pedestrian"), WalkingRoute(5.0, 330.0, "osm_pedestrian")]
    tiers = {"verified-a": 0, "verified-b": 0, "unknown-near": 2, "unknown-far": 2}
    return cafes, routes, tiers


def test_by_type_fills_from_unconfirmed_hours_only_after_confirmed_places(client):
    cafes, routes, tiers = _by_type_fixture()
    res = _run_by_type(client, cafes, routes, tiers, limit=3, fill=True)

    assert res.status_code == 200
    items = res.json()
    # 확인된 두 곳이 (더 가까운 미확인 곳보다도) 먼저, 모자란 한 자리만 미확인에서 채운다.
    assert [item["facility"]["id"] for item in items][:2] == ["verified-a", "verified-b"]
    assert len(items) == 3 and items[2]["facility"]["id"].startswith("unknown")
    assert [item["eligibility_tier"] for item in items] == [
        "verified_open_route", "verified_open_route", "hours_confirmation_required_route",
    ]
    assert [item["information_confidence"] for item in items] == ["verified", "verified", "unknown"]
    assert [item["rank"] for item in items] == [1, 2, 3]


@pytest.mark.parametrize("fill", [_ABSENT, False], ids=["flag-absent", "flag-false"])
def test_by_type_without_the_fill_flag_keeps_the_best_tier_only(client, fill):
    # 구 번들은 이 플래그를 모른다 — 종전처럼 확인된 두 곳만, 가까운 미확인 곳은 오지 않는다.
    cafes, routes, tiers = _by_type_fixture()
    res = _run_by_type(client, cafes, routes, tiers, limit=3, fill=fill)

    assert res.status_code == 200
    items = res.json()
    assert [item["facility"]["id"] for item in items] == ["verified-a", "verified-b"]
    assert all(item["eligibility_tier"] == "verified_open_route" for item in items)


def test_by_type_does_not_fill_when_confirmed_places_meet_the_limit(client):
    cafes = [_cafe("verified-a", 0.0004), _cafe("verified-b", 0.0006), _cafe("unknown", 0.0002)]
    routes = [WalkingRoute(3.0, 195.0, "osm_pedestrian"), WalkingRoute(4.0, 260.0, "osm_pedestrian"),
              WalkingRoute(1.0, 65.0, "osm_pedestrian")]
    res = _run_by_type(client, cafes, routes, {"verified-a": 0, "verified-b": 0, "unknown": 2}, limit=2, fill=True)

    assert res.status_code == 200
    assert [item["facility"]["id"] for item in res.json()] == ["verified-a", "verified-b"]


def test_by_type_cache_key_separates_the_fill_flag():
    # 구 번들과 새 번들이 같은 키를 나누면 서로의 답(채운 목록 / 채우지 않은 목록)을 받는다.
    from app.routers.recommendations import RecommendByTypeRequest, _by_type_cache_key

    base = {"user_id": USER_ID, "facility_type": "cafe", "user_lat": LAT, "user_lng": LNG}
    assert _by_type_cache_key(RecommendByTypeRequest(**base)) != _by_type_cache_key(
        RecommendByTypeRequest(**base, fill_weaker_tiers=True)
    )


def _run_main(client, fill):
    origin = _cafe("origin", 0.0)
    cafes = [_cafe("verified", 0.0004), *[_cafe(f"unknown-{index}", 0.0002 * (index + 1)) for index in range(6)]]
    routes = [WalkingRoute(2.0, 130.0, "osm_pedestrian")] + [
        WalkingRoute(1.0 + index * 0.5, 65.0 + index * 30, "estimated") for index in range(6)
    ]
    tiers = {"verified": 0, **{f"unknown-{index}": 3 for index in range(6)}}
    body = {"user_id": USER_ID, "original_facility_id": "origin", "user_lat": LAT, "user_lng": LNG}
    if fill is not _ABSENT:
        body["fill_weaker_tiers"] = fill
    with patch("app.routers.recommendations.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.recommendations.fetch_facility", new=AsyncMock(return_value=origin)), \
         patch("app.routers.recommendations.fetch_all_facilities", new=AsyncMock(return_value=[origin, *cafes])), \
         patch("app.routers.recommendations.get_walking_routes", new=AsyncMock(return_value=routes)), \
         patch(
             "app.routers.recommendations.recommendation_eligibility_tier",
             side_effect=lambda facility, _arrival, _source: tiers[facility["id"]],
         ), \
         patch("app.routers.recommendations.fetch_congestion_map", new=AsyncMock(return_value={})), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)), \
         patch("app.routers.recommendations.generate_reason_with_source", new=AsyncMock(return_value=("사유", "template"))), \
         patch("app.routers.recommendations.supabase_client", new=_Db()):
        res = client.post("/api/v1/recommendations", json=body)
    assert res.status_code == 200
    return res.json()


def test_main_recommendations_fill_and_label_each_card_with_its_own_tier(client):
    items = _run_main(client, fill=True)
    assert len(items) == 5
    assert items[0]["facility"]["id"] == "verified"
    assert items[0]["eligibility_tier"] == "verified_open_route"
    assert {item["eligibility_tier"] for item in items[1:]} == {"hours_and_route_confirmation_required"}
    assert all(item["information_confidence"] == "unknown" for item in items[1:])


@pytest.mark.parametrize("fill", [_ABSENT, False], ids=["flag-absent", "flag-false"])
def test_main_recommendations_without_the_fill_flag_keep_the_best_tier_only(client, fill):
    items = _run_main(client, fill=fill)
    assert [item["facility"]["id"] for item in items] == ["verified"]
    assert items[0]["eligibility_tier"] == "verified_open_route"
