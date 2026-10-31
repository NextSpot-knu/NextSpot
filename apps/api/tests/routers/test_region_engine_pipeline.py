"""서울 엔진 파이프라인은 경주 전용 입력을 한 번도 부르지 않는다(서울 S3 — WP3 회귀 잠금).

**실제** ``fetch_all_facilities`` → ``_fetch_all_facilities_uncached`` → ``fetch_active_facilities`` 를 대역 DB 위에서
태우고(시설 행에 region 이 있다), 개발자 + 서울 헤더로 네 엔진 경로를 부른다:

  · 주변 수요(get_area_demand_signal · get_historical_area_demand_forecast) · 코스 예열(prefetch_area_demand_points) ·
    관광공사 집중률 prior · Tmap 연관 목적지 prior → 호출 0회.
  · 경주 모델이 학습된 상태(get_model_info trained=True)여도 서울 후보는 scoring_mode 'model' 이 되지 않는다.
  · 요청이 끝난 뒤에도 공유 캐시의 풀 행은 region 칸을 그대로 갖고 있다(응답 사본에서만 뺀다).

대조군으로 같은 배선의 경주 요청은 주변 수요를 실제로 부른다 — 스파이가 살아 있다는 증거다.
"""

from __future__ import annotations

from contextlib import ExitStack, contextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.routers import courses as courses_router
from app.routers import recommendations as reco_router
from app.services import area_demand_service, facility_cache
from app.services.spot import score as score_module
from tests.conftest import DEVELOPER_USER_ID, TOURIST_USER_ID, role_headers
from tests.routers.test_region_recommendations import (
    GJ_CENTER,
    GYEONGJU_IDS,
    SEOUL_CENTER,
    SEOUL_IDS,
    by_type_body,
    client,  # noqa: F401 — pytest 픽스처 재사용
    course_body,
    has_key_anywhere,
    headers,
    make_db,
    reco_body,
    seoul_world,
)

TRAINED = {"trained": True, "version": "gyeongju-model-v9"}


class Spies:
    def __init__(self) -> None:
        self.score_area = AsyncMock(return_value=None)
        self.delayed_area = AsyncMock(return_value=None)
        self.history = AsyncMock(return_value=None)
        self.prefetch = AsyncMock(return_value=0)
        self.tourism_prior = MagicMock()  # 동기 함수(to_thread 안에서 불린다)
        self.related_prior = AsyncMock()
        self.model_calls: list[tuple] = []
        self.uncached_calls: list[dict] = []

    def model(self, *args, **_kwargs):
        self.model_calls.append(args)
        return 0.7, "registry"

    def course_model(self, *args, **_kwargs):
        self.model_calls.append(args)
        return 0.7

    def gyeongju_only_calls(self) -> dict[str, int]:
        return {
            "get_area_demand_signal(score)": self.score_area.await_count,
            "get_area_demand_signal(delayed)": self.delayed_area.await_count,
            "get_historical_area_demand_forecast": self.history.await_count,
            "prefetch_area_demand_points": self.prefetch.await_count,
            "attach_tourism_area_priors": self.tourism_prior.call_count,
            "attach_related_destination_priors": self.related_prior.await_count,
            "gyeongju model": len(self.model_calls),
        }


@contextmanager
def pipeline(db, *, trained: bool = True):
    spies = Spies()
    real_uncached = reco_router._fetch_all_facilities_uncached

    async def _uncached(**kwargs):
        spies.uncached_calls.append(kwargs)
        return await real_uncached(**kwargs)

    info = TRAINED if trained else {"trained": False, "version": None}
    with seoul_world(db), ExitStack() as stack:
        stack.enter_context(patch.object(score_module, "get_area_demand_signal", new=spies.score_area))
        stack.enter_context(patch.object(reco_router, "get_area_demand_signal", new=spies.delayed_area))
        stack.enter_context(
            patch.object(area_demand_service, "get_historical_area_demand_forecast", new=spies.history)
        )
        stack.enter_context(patch.object(courses_router, "prefetch_area_demand_points", new=spies.prefetch))
        stack.enter_context(patch.object(reco_router, "attach_tourism_area_priors", new=spies.tourism_prior))
        stack.enter_context(patch.object(reco_router, "attach_related_destination_priors", new=spies.related_prior))
        stack.enter_context(patch.object(reco_router, "_fetch_all_facilities_uncached", new=_uncached))
        stack.enter_context(patch.object(score_module, "get_model_info", return_value=info))
        stack.enter_context(patch.object(reco_router, "get_model_info", return_value=info))
        stack.enter_context(patch.object(score_module, "predict_congestion_detailed", new=spies.model))
        stack.enter_context(patch.object(reco_router, "predict_congestion_detailed", new=spies.model))
        stack.enter_context(patch.object(courses_router, "predict_congestion", new=spies.course_model))
        yield spies


def _seoul_requests(client):  # noqa: F811
    dev = headers("developer")
    return {
        "recommendations": client.post(
            "/api/v1/recommendations", json=reco_body(DEVELOPER_USER_ID, "s-attr", SEOUL_CENTER), headers=dev,
        ),
        "by-type": client.post(
            "/api/v1/recommendations/by-type", json=by_type_body(DEVELOPER_USER_ID, SEOUL_CENTER), headers=dev,
        ),
        "courses/plan": client.post(
            "/api/v1/courses/plan", json=course_body(DEVELOPER_USER_ID, SEOUL_CENTER), headers=dev,
        ),
        "courses/recommend": client.post(
            "/api/v1/courses/recommend", json=course_body(DEVELOPER_USER_ID, SEOUL_CENTER), headers=dev,
        ),
    }


def _items(name: str, body) -> list[dict]:
    if name == "courses/plan":
        return body["stops"]
    return body


def test_seoul_pipeline_never_calls_gyeongju_only_inputs(client):  # noqa: F811
    db = make_db()
    with pipeline(db) as spies:
        responses = _seoul_requests(client)
    for name, res in responses.items():
        assert res.status_code == 200, (name, res.text)
        items = _items(name, res.json())
        assert items, name
        assert {item["facility"]["id"] for item in items} <= SEOUL_IDS, name
        assert not has_key_anywhere(res.json(), "region"), name
    assert spies.gyeongju_only_calls() == {key: 0 for key in spies.gyeongju_only_calls()}
    # 실제 로더를 탔다 — 서울 풀은 region='seoul' 로 따로 적재되고, 관광공사 집중률 표는 읽지 않는다.
    assert {"region": "seoul"} in spies.uncached_calls
    assert not db.queries_on("tourism_concentration_forecasts")
    seoul_pool_reads = [
        q for q in db.queries_on("facilities") if ("region", "eq", "seoul") in q.filters and ("is_active", "eq", True) in q.filters
    ]
    assert seoul_pool_reads


def test_trained_gyeongju_model_never_ranks_seoul_candidates(client):  # noqa: F811
    db = make_db()
    with pipeline(db, trained=True) as spies:
        responses = _seoul_requests(client)
    for name in ("recommendations", "by-type"):
        for item in responses[name].json():
            assert item["scoring_mode"] != "model"
            assert item["breakdown"]["scoring_mode"] == "measured_rules"
            assert item["prediction_source"] == "measured"
            assert item["congestion_prediction_basis"] is None
            assert item["model_version"] is None
    assert spies.model_calls == []


def test_seoul_without_zone_readings_degrades_instead_of_using_the_model(client):  # noqa: F811
    db = make_db(extra={"zone_crowd_snapshots": []})
    with pipeline(db, trained=True) as spies:
        res = client.post(
            "/api/v1/recommendations", json=reco_body(DEVELOPER_USER_ID, "s-attr", SEOUL_CENTER),
            headers=headers("developer"),
        )
    assert res.status_code == 200, res.text
    items = res.json()
    assert items
    for item in items:
        assert item["scoring_mode"] == "degraded_rules"
        assert item["congestion_source"] == "none"
    assert spies.model_calls == []


def test_gyeongju_control_request_does_reach_the_gyeongju_inputs(client):  # noqa: F811
    """대조군 — 같은 배선에서 경주 요청은 주변 수요·연관 prior·모델을 실제로 부른다(스파이가 살아 있다)."""
    db = make_db()
    with pipeline(db, trained=True) as spies:
        res = client.post(
            "/api/v1/recommendations", json=reco_body(TOURIST_USER_ID, "g-attr", GJ_CENTER),
            headers=role_headers("tourist"),
        )
    assert res.status_code == 200, res.text
    assert {item["facility"]["id"] for item in res.json()} <= GYEONGJU_IDS
    calls = spies.gyeongju_only_calls()
    assert calls["get_area_demand_signal(score)"] > 0
    assert calls["attach_related_destination_priors"] == 1
    assert calls["attach_tourism_area_priors"] == 1
    assert calls["gyeongju model"] > 0
    assert {} in spies.uncached_calls  # 경주 로더는 지역 도입 전과 같은 인자(없음)로 불린다
    assert not db.queries_on("zones") and not db.queries_on("zone_crowd_snapshots")


def test_cached_pool_rows_keep_region_after_requests(client):  # noqa: F811
    db = make_db()
    with pipeline(db):
        _seoul_requests(client)
        client.post(
            "/api/v1/recommendations", json=reco_body(TOURIST_USER_ID, "g-attr", GJ_CENTER),
            headers=role_headers("tourist"),
        )
        seoul_entry = facility_cache._entries.get(("region", "seoul"))
        gyeongju_entry = facility_cache._entries.get(("all",))
    assert seoul_entry is not None and gyeongju_entry is not None
    seoul_rows, gyeongju_rows = seoul_entry[2], gyeongju_entry[2]
    assert {r["id"] for r in seoul_rows} == SEOUL_IDS
    assert all(r.get("region") == "seoul" for r in seoul_rows)
    assert {r["id"] for r in gyeongju_rows} == GYEONGJU_IDS
    assert all(r.get("region") == "gyeongju" for r in gyeongju_rows)


@pytest.mark.parametrize("path", ["/api/v1/courses/plan", "/api/v1/courses/recommend"])
def test_seoul_course_reads_zone_readings_once_for_the_whole_pool(client, path):  # noqa: F811
    db = make_db()
    with pipeline(db):
        res = client.post(path, json=course_body(DEVELOPER_USER_ID, SEOUL_CENTER), headers=headers("developer"))
    assert res.status_code == 200, res.text
    # 구역 상태(60초 캐시)와 매핑은 풀 전체에 대해 한 번 — 자리마다 다시 읽지 않는다.
    assert len(db.queries_on("zones")) == 1
    assert len(db.queries_on("facility_zones")) == 1
