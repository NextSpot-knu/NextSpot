"""S4 재생 어댑터 == 실제 ``/recommendations`` 핸들러(서울) — 순서와 점수가 같다(라우터 접착 코드가 갈라지면 실패).

대역 DB(test_region_recommendations 의 RegionDB · seoul_world)에 홍대 구역 3곳을 중심 좌표의 관광지 가상 시설로 두고,
구역 관측(load_zone_readings)은 재생이 쓰는 관측으로, 도보 경로는 재생의 (분, m)로, 라우터 시계는 t 로 고정한다.
취향 중립(빈 선호 + 중립 벡터) · 쿠폰 0. 장면 셋: 지금 관측(persistence) · 공급원 예측 · 근거 없는 대안 하나.
이동은 세 벌로 돈다: 상한 안의 손으로 고른 값, **재생이 엔진에 주는 행렬**(``router_travel_matrix`` — 라우터의 그래프
밖 추정 1.18: 연남동 15.2분 · 합정역 17.4분), 그리고 상한 밖 대안이 하나 있는 손 값(합정역 21분). 어느 경우든 재생과
라우터가 같은 후보를 같은 순서로 내야 한다. 그리고 ``get_walking_routes`` 를 **패치하지 않은** 실제 라우터가 내는 대안
집합이 재생의 대안 자격(``eligible_alternatives``)과 같은지 모든 서울 구역 쌍에서 잠근다(S4 검토 2차 — 재생이 보수적
이동 1.4 로 상한을 걸어 라우터가 내는 합정역을 빼던 결함).
"""

from __future__ import annotations

import asyncio
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

from app.routers import recommendations as reco_router
from app.services.batch import crowd_dispersion_replay as replay
from app.services.batch import crowd_replay_engine as engine
from app.services.batch.crowd_replay_data import cluster_zones, load_replay_inputs
from app.services.preference_vector_service import preference_vector_service
from app.services.crowd import seoul_provider
from app.services.spot.travel import WalkingRoute, get_walking_routes
from tests.conftest import DEVELOPER_USER_ID
from tests.fixtures.crowd_replay.synthetic import KST, fcst_row, memory_inputs, obs_row
from tests.routers.test_region_recommendations import (
    OPEN_ALL_DAY,
    client,  # noqa: F401 — 픽스처 재사용
    headers,
    make_db,
    seoul_world,
)

ZONES = {z.zone_id: z for z in cluster_zones("hongdae")}
ORIGIN = "seoul:POI007"  # 홍대 관광특구
ALTS = ("seoul:POI053", "seoul:POI073")
# 라우터의 도보 상한(20분) 안 — 재생과 라우터에 같은 값을 준다.
TRAVEL_INSIDE = {"seoul:POI073": (12.0, 1206.0), "seoul:POI053": (18.0, 1374.0)}
# 재생이 엔진에 주는 행렬(라우터의 그래프 밖 추정 — 연남동 15.2분 · 합정역 17.4분, 둘 다 상한 안).
_ROUTER = engine.router_travel_matrix(tuple(ZONES.values()))
TRAVEL_REAL = {c: (_ROUTER[(ORIGIN, c)].minutes, _ROUTER[(ORIGIN, c)].route_m) for c in ALTS}
# 상한 밖 대안 하나(합정역 21분) — 상한 비교가 라우터와 같은지 본다.
TRAVEL_OUTSIDE = {"seoul:POI073": (15.2, 1016.1), "seoul:POI053": (21.0, 1400.0)}
TRAVELS = {"inside_cap": TRAVEL_INSIDE, "router_matrix": TRAVEL_REAL, "one_outside_cap": TRAVEL_OUTSIDE}
B0 = datetime(2026, 9, 20, 14, 0, tzinfo=KST)


def _facility_rows() -> list[dict]:
    rows = []
    for zone in ZONES.values():
        fac = engine.pseudo_facility(zone)
        rows.append({**fac, "capacity": None, "operating_hours": OPEN_ALL_DAY, "is_active": True, "region": "seoul",
                     "updated_at": "2026-10-01T00:00:00+00:00"})
    return rows


def _scenario(name: str):
    """(정보 집합 관측들, 결정 시각 t)."""
    if name == "persistence":
        rows = [
            obs_row("홍대 관광특구", B0, 3), obs_row("연남동", B0, 2), obs_row("합정역", B0, 0),
        ]
        return load_replay_inputs("hongdae", **memory_inputs(rows)), (B0 + timedelta(minutes=10)).astimezone(timezone.utc)
    if name == "forecast":
        rows = [obs_row(n, B0, b, observed_offset_min=-19) for n, b in (("홍대 관광특구", 3), ("연남동", 1), ("합정역", 2))]
        fc = []
        for row, bands in zip(rows, ((3, 3), (3, 0), (0, 3))):
            fc.append(fcst_row(row, B0 + timedelta(minutes=0), bands[0]))
            fc.append(fcst_row(row, B0 + timedelta(minutes=30), bands[1]))
        return load_replay_inputs("hongdae", **memory_inputs(rows, fc)), (B0 + timedelta(minutes=10)).astimezone(timezone.utc)
    rows = [obs_row("홍대 관광특구", B0, 3), obs_row("연남동", B0, 1)]
    other = [obs_row("합정역", B0 - timedelta(hours=3), 0)]  # 2시간 창 밖 — 근거 없음
    return load_replay_inputs("hongdae", **memory_inputs(rows + other)), (B0 + timedelta(minutes=10)).astimezone(timezone.utc)


def _frozen(moment: datetime):
    class _Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return moment.astimezone(tz) if tz else moment.replace(tzinfo=None)

    return _Frozen


def test_engine_travel_is_the_routers_own_estimate_and_conservative_truth_stays_separate():
    """엔진 입력은 라우터 값(17.4분 · 15.2분), 채점 이동은 보수적 1.4·올림(21 · 19분) — 둘을 섞지 않는다."""
    assert TRAVEL_REAL == {"seoul:POI073": (15.2, 1016.1), "seoul:POI053": (17.4, 1157.9)}
    truth = replay.check_travel_config(tuple(ZONES.values()), replay.CRITERIA["travel"]["detour"])
    assert truth[(ORIGIN, "seoul:POI053")].minutes == 21 and truth[(ORIGIN, "seoul:POI073")].minutes == 19
    assert engine.MAX_WALK_MINUTES == 20 == replay.CRITERIA["travel"]["max_walk_minutes"]


@pytest.mark.parametrize("zone", seoul_provider.SEOUL_ZONES, ids=lambda z: z.zone_id)
def test_replay_eligibility_matches_what_the_real_router_route_function_keeps(zone):
    """패치하지 않은 get_walking_routes(서울 = 그래프 밖 추정)로 라우터 상한을 걸면 재생의 대안 자격과 같은 집합이다."""
    if not zone.cluster:
        pytest.skip("권역 없는 구역")
    members = [z for z in seoul_provider.SEOUL_ZONES if z.cluster == zone.cluster]
    others = [z for z in members if z.zone_id != zone.zone_id]
    routes = asyncio.run(get_walking_routes(
        zone.centroid_lat, zone.centroid_lng, [(z.centroid_lat, z.centroid_lng) for z in others],
    ))
    kept = tuple(sorted(
        z.zone_id for z, route in zip(others, routes) if not route.duration_min > engine.MAX_WALK_MINUTES
    ))
    matrix = engine.router_travel_matrix(members)
    eligible = replay.eligible_alternatives(
        zone.zone_id, sorted(z.zone_id for z in members), matrix, replay.CRITERIA["travel"]["max_walk_minutes"],
    )
    assert eligible == kept
    for z, route in zip(others, routes):
        leg = matrix[(zone.zone_id, z.zone_id)]
        assert (leg.minutes, leg.route_m, leg.source) == (route.duration_min, route.distance_m, route.source)


def test_hongdae_center_has_two_alternatives_the_router_returns():
    """홍대 관광특구 → 합정역은 라우터 17.4분(상한 안) — 재생도 대안으로 둔다(보수적 21분으로 빼지 않는다)."""
    ids = sorted(ZONES)
    matrix = engine.router_travel_matrix(tuple(ZONES.values()))
    cap = replay.CRITERIA["travel"]["max_walk_minutes"]
    assert replay.eligible_alternatives(ORIGIN, ids, matrix, cap) == ("seoul:POI053", "seoul:POI073")
    assert replay.eligible_alternatives("seoul:POI053", ids, matrix, cap) == (ORIGIN,)
    assert replay.eligible_alternatives("seoul:POI073", ids, matrix, cap) == (ORIGIN,)


def _router_items(client, readings, t, travel, *, real_routes=False):  # noqa: F811
    zone_readings = {
        engine.pseudo_id(zid): engine._single(reading) for zid, reading in readings.items() if reading is not None
    }

    async def _load_zone_readings(facility_ids, *, region, wall_now=None, timeout=None):
        assert region == "seoul" and wall_now == t
        return {fid: zone_readings[fid] for fid in facility_ids if fid in zone_readings}

    by_coord = {(z.centroid_lat, z.centroid_lng): zid for zid, z in ZONES.items()}

    async def _routes(_lat, _lng, destinations):
        out = []
        for lat, lng in destinations:
            minutes, meters = travel[by_coord[(lat, lng)]]
            out.append(WalkingRoute(minutes, meters, engine.TRAVEL_SOURCE))
        return out

    db = make_db(extra={"facilities": _facility_rows()})
    users = {DEVELOPER_USER_ID: {"id": DEVELOPER_USER_ID, "preferred_categories": []}}
    origin = ZONES[ORIGIN]
    with seoul_world(db, user_rows=users), ExitStack() as stack:
        stack.enter_context(patch.object(reco_router, "load_zone_readings", new=_load_zone_readings))
        if not real_routes:
            stack.enter_context(patch.object(reco_router, "get_walking_routes", new=_routes))
        stack.enter_context(patch("app.routers.recommendations.datetime", _frozen(t)))
        stack.enter_context(patch.object(
            preference_vector_service, "get_user_vector", new=AsyncMock(return_value=engine.neutral_vector())
        ))
        res = client.post(
            "/api/v1/recommendations",
            json={"user_id": DEVELOPER_USER_ID, "original_facility_id": engine.pseudo_id(ORIGIN),
                  "user_lat": origin.centroid_lat, "user_lng": origin.centroid_lng,
                  "context": {"max_walk_minutes": engine.MAX_WALK_MINUTES}},
            headers=headers("developer"),
        )
    assert res.status_code == 200, res.text
    return res.json()


def test_replay_drops_the_alternative_the_router_cannot_return(client):  # noqa: F811
    """합정역(21분)이 여유이고 연남동(15.2분)이 붐빔이어도 — 상한 밖이면 라우터가 내지 않으므로 재생도 고르지 않는다."""
    rows = [obs_row("홍대 관광특구", B0, 3), obs_row("연남동", B0, 3), obs_row("합정역", B0, 0)]
    data = load_replay_inputs("hongdae", **memory_inputs(rows))
    t = (B0 + timedelta(minutes=10)).astimezone(timezone.utc)
    readings = {zid: data.timelines[zid].latest_reading(t) for zid in ZONES}
    result = asyncio.run(engine.rank_alternatives(
        ZONES[ORIGIN], [ZONES[c] for c in ALTS], origin_reading=readings[ORIGIN],
        alt_readings={c: readings[c] for c in ALTS}, t=t, travel=TRAVEL_OUTSIDE,
    ))
    items = _router_items(client, readings, t, TRAVEL_OUTSIDE)

    assert [item["facility"]["id"] for item in items] == ["replay:seoul:POI073"]
    assert [c.zone_id for c in result.ranked] == ["seoul:POI073"], "상한 밖 대안은 재생에서도 채점·선택되지 않는다"
    assert result.choice == "seoul:POI073"


def test_unpatched_router_returns_hapjeong_and_the_replay_adapter_ranks_the_same(client):  # noqa: F811
    """실제 경로 함수(패치 없음)로 라우터는 합정역(17.4분)을 낸다 — 재생 어댑터도 같은 후보를 같은 순서·점수로 낸다."""
    rows = [obs_row("홍대 관광특구", B0, 3), obs_row("연남동", B0, 3), obs_row("합정역", B0, 0)]
    data = load_replay_inputs("hongdae", **memory_inputs(rows))
    t = (B0 + timedelta(minutes=10)).astimezone(timezone.utc)
    readings = {zid: data.timelines[zid].latest_reading(t) for zid in ZONES}
    result = asyncio.run(engine.rank_alternatives(
        ZONES[ORIGIN], [ZONES[c] for c in ALTS], origin_reading=readings[ORIGIN],
        alt_readings={c: readings[c] for c in ALTS}, t=t, travel=TRAVEL_REAL,
    ))
    items = _router_items(client, readings, t, TRAVEL_REAL, real_routes=True)

    assert {item["facility"]["id"] for item in items} == {"replay:seoul:POI053", "replay:seoul:POI073"}
    assert [item["facility"]["id"] for item in items] == [c.facility_id for c in result.ranked]
    for item, cand in zip(items, result.ranked):
        assert item["spot_score"] == pytest.approx(cand.score, abs=1e-9)
        assert item["breakdown"]["travel_time"] == pytest.approx(cand.travel_time, abs=1e-9)
    assert result.choice == "seoul:POI053", "도착 때 여유인 합정역(17.4분)이 붐비는 연남동보다 앞선다"


@pytest.mark.parametrize("travel_name", sorted(TRAVELS))
@pytest.mark.parametrize("name", ["persistence", "forecast", "no_evidence"])
def test_replay_adapter_matches_the_recommendations_router(client, name, travel_name):  # noqa: F811
    travel = TRAVELS[travel_name]
    data, t = _scenario(name)
    readings = {zid: data.timelines[zid].latest_reading(t) for zid in ZONES}
    result = asyncio.run(engine.rank_alternatives(
        ZONES[ORIGIN], [ZONES[c] for c in ALTS], origin_reading=readings[ORIGIN],
        alt_readings={c: readings[c] for c in ALTS}, t=t, travel=travel,
    ))
    assert result is not None
    items = _router_items(client, readings, t, travel)
    assert [item["facility"]["id"] for item in items] == [c.facility_id for c in result.ranked]
    for item, cand in zip(items, result.ranked):
        assert item["spot_score"] == pytest.approx(cand.score, abs=1e-9)
        assert item["breakdown"]["scoring_mode"] == cand.scoring_mode
        assert item["breakdown"].get("congestion_arrival_basis") == cand.congestion_arrival_basis
    modes = {c.zone_id: c.scoring_mode for c in result.ranked}
    bases = {c.congestion_arrival_basis for c in result.ranked}
    if travel_name == "one_outside_cap":
        assert set(modes) == {"seoul:POI073"}, "합정역 21분 > 상한 20분 — 양쪽 모두 뺀다"
    elif travel_name == "router_matrix":
        assert set(modes) == set(ALTS), "라우터 이동(15.2 · 17.4분)은 둘 다 상한 안 — 양쪽 모두 낸다"
    if name == "persistence":
        assert bases == {"persistence"}
    elif name == "forecast":
        assert "provider_forecast" in bases
    elif travel_name in {"inside_cap", "router_matrix"}:
        assert modes["seoul:POI053"] == "degraded_rules" and modes["seoul:POI073"] == "measured_rules"
    else:
        assert modes["seoul:POI073"] == "measured_rules"
