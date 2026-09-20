"""응답 캐시(app/core/response_cache.py)와 그것을 쓰는 두 핫 엔드포인트 + /warmup.

이 파일은 tests/conftest.py 의 `_isolate_response_cache` 가 전 테스트에서 TTL 을 0 으로
떨어뜨려 둔 것을 **일부러 되돌려** 캐시가 실제로 동작하는 상태를 검증한다. 되돌리는 범위는
각 테스트 안이며, monkeypatch 가 끝나면 다시 0 으로 돌아간다.
"""

import asyncio
import time
from unittest.mock import AsyncMock, patch

import pytest

from app.core.response_cache import (
    ResponseCache,
    assumed_time_bucket,
    model_signature,
    round_location,
)
from app.routers import courses as courses_router
from app.routers import recommendations as recommendations_router
from app.routers import warmup as warmup_router
from app.services.preference_vector_service import preference_vector_service
from app.services.travel_context import TravelContext

from test_routers import (
    AUTH_USER_ID,
    BASE_LAT,
    BASE_LNG,
    UNIT_VECTOR,
    USER_ROW,
    _cong,
    _facility,
    auth_client,  # noqa: F401 — pytest 픽스처 재사용(import 로 활성화)
    client,       # noqa: F401
    _freeze_router_clock,  # noqa: F401 — 후보 자격 판정의 now() 고정(autouse)
)

_BY_TYPE_PATH = "/api/v1/recommendations/by-type"
_COURSE_PATH = "/api/v1/courses/plan"


@pytest.fixture
def live_caches(monkeypatch):
    """두 응답 캐시를 프로덕션 TTL(180초)로 되돌린다."""
    caches = (recommendations_router._by_type_cache, courses_router._course_cache)
    for cache in caches:
        cache.clear()
        monkeypatch.setattr(cache, "ttl_seconds", 180.0)
    yield caches
    for cache in caches:
        cache.clear()


# =========================================================================
# 1. ResponseCache 단위 — TTL · LRU · 깊은 복사 · 단일 비행 · 실패 미캐시
# =========================================================================

@pytest.mark.asyncio
async def test_cache_serves_second_call_without_rerunning_the_factory():
    cache = ResponseCache("unit", ttl_seconds=180.0)
    calls = 0

    async def factory():
        nonlocal calls
        calls += 1
        return {"n": calls}

    first = await cache.get_or_compute("k", factory)
    second = await cache.get_or_compute("k", factory)

    assert calls == 1
    assert first == second == {"n": 1}


@pytest.mark.asyncio
async def test_cache_never_hands_the_same_object_to_two_callers():
    """돌려준 값을 호출자가 망가뜨려도 다음 호출자의 답이 오염되지 않는다."""
    cache = ResponseCache("unit", ttl_seconds=180.0)

    async def factory():
        return {"items": [{"id": "a"}]}

    first = await cache.get_or_compute("k", factory)
    first["items"][0]["id"] = "mutated"
    second = await cache.get_or_compute("k", factory)

    assert second == {"items": [{"id": "a"}]}
    assert first is not second


@pytest.mark.asyncio
async def test_cache_expires_after_ttl():
    clock = {"t": 1000.0}
    cache = ResponseCache("unit", ttl_seconds=180.0, clock=lambda: clock["t"])
    calls = 0

    async def factory():
        nonlocal calls
        calls += 1
        return {"n": calls}

    assert await cache.get_or_compute("k", factory) == {"n": 1}
    clock["t"] += 179.0
    assert await cache.get_or_compute("k", factory) == {"n": 1}  # 아직 유효
    clock["t"] += 2.0                                            # 총 181초 — 만료
    assert await cache.get_or_compute("k", factory) == {"n": 2}
    assert calls == 2


@pytest.mark.asyncio
async def test_cache_evicts_least_recently_used_beyond_max_entries():
    cache = ResponseCache("unit", ttl_seconds=180.0, max_entries=2)
    calls: list[str] = []

    def make(key):
        async def factory():
            calls.append(key)
            return {"key": key}
        return factory

    await cache.get_or_compute("a", make("a"))
    await cache.get_or_compute("b", make("b"))
    await cache.get_or_compute("a", make("a"))  # a 를 최근 사용으로 끌어올린다
    await cache.get_or_compute("c", make("c"))  # b 가 밀려난다
    await cache.get_or_compute("a", make("a"))  # 히트
    await cache.get_or_compute("b", make("b"))  # 미스 — 다시 계산

    assert calls == ["a", "b", "c", "b"]


@pytest.mark.asyncio
async def test_cache_does_not_store_failures():
    cache = ResponseCache("unit", ttl_seconds=180.0)
    attempts = 0

    async def factory():
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("upstream flaked")
        return {"ok": True}

    with pytest.raises(RuntimeError):
        await cache.get_or_compute("k", factory)
    assert await cache.get_or_compute("k", factory) == {"ok": True}
    assert attempts == 2


@pytest.mark.asyncio
async def test_concurrent_misses_on_one_key_run_the_pipeline_once():
    """동시 미스가 파이프라인을 한 번만 돌린다 — 0.5 CPU 인스턴스를 죽이는 것이 이 떼몰림이다."""
    cache = ResponseCache("unit", ttl_seconds=180.0)
    runs = 0
    gate = asyncio.Event()

    async def factory():
        nonlocal runs
        runs += 1
        await gate.wait()
        return {"runs": runs}

    waiters = [asyncio.create_task(cache.get_or_compute("k", factory)) for _ in range(5)]
    await asyncio.sleep(0)  # 다섯 태스크가 모두 캐시에 도착하게 한다
    gate.set()
    results = await asyncio.gather(*waiters)

    assert runs == 1
    assert all(r == {"runs": 1} for r in results)
    # 어느 둘도 같은 객체를 쥐고 있지 않다.
    assert len({id(r) for r in results}) == len(results)


# =========================================================================
# 2. 키 구성요소
# =========================================================================

def test_round_location_folds_a_drifting_fix_into_one_bucket():
    assert round_location(35.83601, 129.21004) == round_location(35.83604, 129.20996)
    assert round_location(35.8360, 129.2100) != round_location(35.8370, 129.2100)


def test_assumed_time_bucket_separates_hours_and_live_from_assumed():
    from datetime import datetime, timedelta, timezone

    ten = datetime(2026, 9, 21, 10, 5, tzinfo=timezone.utc)
    ten_later = datetime(2026, 9, 21, 10, 55, tzinfo=timezone.utc)
    eleven = datetime(2026, 9, 21, 11, 5, tzinfo=timezone.utc)

    assert assumed_time_bucket(ten) == assumed_time_bucket(ten_later)
    assert assumed_time_bucket(ten) != assumed_time_bucket(eleven)
    # 같은 시각이라도 '가정' 과 '지금' 은 다른 질문이다(가정이 있으면 채점에 depart_time 이 실린다).
    assert assumed_time_bucket(None, now=ten) != assumed_time_bucket(ten)
    # 타임존이 달라도 같은 UTC 시각이면 같은 버킷이다.
    kst = timezone(timedelta(hours=9))
    assert assumed_time_bucket(ten.astimezone(kst)) == assumed_time_bucket(ten)


def test_travel_context_changes_the_cache_key():
    assert model_signature(None) is None
    indoor = TravelContext(required_attributes=["indoor"])
    walk = TravelContext(max_walk_minutes=5)
    assert model_signature(indoor) != model_signature(walk)
    assert model_signature(indoor) == model_signature(TravelContext(required_attributes=["indoor"]))


def test_by_type_key_covers_every_input_that_moves_the_answer():
    base = dict(
        user_id=AUTH_USER_ID, facility_type="cafe", user_lat=BASE_LAT, user_lng=BASE_LNG,
    )
    Req = recommendations_router.RecommendByTypeRequest
    key = recommendations_router._by_type_cache_key(Req(**base))

    variants = {
        "user_id": {"user_id": "other-user"},
        "facility_type": {"facility_type": "restaurant"},
        "latitude": {"user_lat": BASE_LAT + 0.01},
        "longitude": {"user_lng": BASE_LNG + 0.01},
        "limit": {"limit": 3},
        "preference_intent": {"preference_intent": "조용한 곳"},
        "exclude_ids": {"exclude_ids": ["c-1"]},
        "context": {"context": TravelContext(max_walk_minutes=5)},
        "assumed_at": {"assumed_at": "2026-09-21T02:00:00Z"},
    }
    for label, override in variants.items():
        other = recommendations_router._by_type_cache_key(Req(**{**base, **override}))
        assert other != key, f"{label} 이(가) 캐시 키에 반영되지 않았다"

    # 답을 바꾸지 않는 차이는 같은 키여야 한다(적중률).
    same_exclude_order = recommendations_router._by_type_cache_key(
        Req(**base, exclude_ids=["b", "a"])
    )
    assert same_exclude_order == recommendations_router._by_type_cache_key(
        Req(**base, exclude_ids=["a", "b", "a"])
    )


def test_course_key_covers_pins_sequence_and_types():
    base = dict(user_id=AUTH_USER_ID, user_lat=BASE_LAT, user_lng=BASE_LNG)
    Req = courses_router.CourseRequest
    key = courses_router._course_cache_key(Req(**base))

    variants = {
        "user_id": {"user_id": "other-user"},
        "latitude": {"user_lat": BASE_LAT + 0.01},
        "types": {"types": ["cafe"]},
        "sequence": {"sequence": ["cafe", "restaurant"]},
        "pins": {"pins": [{"order": 1, "facility_id": "f-cafe"}]},
        "context": {"context": TravelContext(available_minutes=60)},
        "assumed_at": {"assumed_at": "2026-09-21T02:00:00Z"},
    }
    for label, override in variants.items():
        assert courses_router._course_cache_key(Req(**{**base, **override})) != key, label

    # sequence 는 순서가 곧 답이다 — 접지 않는다.
    assert courses_router._course_cache_key(Req(**base, sequence=["cafe", "restaurant"])) != \
        courses_router._course_cache_key(Req(**base, sequence=["restaurant", "cafe"]))
    # types 는 집합으로만 쓰이므로 순서가 달라도 같은 키다.
    assert courses_router._course_cache_key(Req(**base, types=["cafe", "restaurant"])) == \
        courses_router._course_cache_key(Req(**base, types=["restaurant", "cafe"]))
    # 같은 자리에 겹쳐 온 핀은 **뒤엣것이 이긴다** — 순서를 접으면 다른 코스가 같은 키가 된다.
    assert courses_router._course_cache_key(
        Req(**base, pins=[{"order": 1, "facility_id": "a"}, {"order": 1, "facility_id": "b"}])
    ) != courses_router._course_cache_key(
        Req(**base, pins=[{"order": 1, "facility_id": "b"}, {"order": 1, "facility_id": "a"}])
    )


# =========================================================================
# 3. by-type 엔드포인트 — 히트/미스와 payload 동일성
# =========================================================================

_CAFES = [
    _facility("c-1", "cafe", 0.0002),
    _facility("c-2", "cafe", 0.0004, coupon_rate=0.1),
    _facility("c-3", "cafe", 0.0006),
]


def _by_type_body(**overrides) -> dict:
    return {
        "user_id": AUTH_USER_ID,
        "facility_type": "cafe",
        "user_lat": BASE_LAT,
        "user_lng": BASE_LNG,
        **overrides,
    }


class _CountingFetch:
    """파이프라인 안쪽 의존성 호출 횟수 계수기(= 파이프라인이 실제로 돌았는가)."""

    def __init__(self, value):
        self.value = value
        self.calls = 0

    async def __call__(self, *_args, **_kwargs):
        self.calls += 1
        return self.value


def _run_by_type(auth_client, body, facilities_fetch):  # noqa: F811
    congestion = {f["id"]: _cong(0.2) for f in _CAFES}
    with patch("app.routers.recommendations.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.recommendations.fetch_all_facilities", new=facilities_fetch), \
         patch("app.routers.recommendations.fetch_congestion_map", new=AsyncMock(return_value=congestion)), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)), \
         patch("app.routers.recommendations.generate_reason_with_source",
               new=AsyncMock(return_value=("사유", "template"))):
        res = auth_client.post(_BY_TYPE_PATH, json=body)
    assert res.status_code == 200
    return res.json()


def test_by_type_repeat_returns_identical_payload_without_rerunning_pipeline(
    auth_client, live_caches  # noqa: F811
):
    fetch = _CountingFetch(_CAFES)
    body = _by_type_body()

    first = _run_by_type(auth_client, body, fetch)
    second = _run_by_type(auth_client, body, fetch)

    assert fetch.calls == 1, "두 번째 요청이 파이프라인을 다시 돌렸다"
    assert first == second
    assert first, "캐시 동일성 검증에는 후보가 있어야 한다"
    assert [i["facility"]["type"] for i in first] == ["cafe"] * len(first)


def test_by_type_different_assumed_buckets_miss_the_cache(auth_client, live_caches):  # noqa: F811
    fetch = _CountingFetch(_CAFES)

    morning = _run_by_type(auth_client, _by_type_body(assumed_at="2026-08-27T01:00:00Z"), fetch)
    assert fetch.calls == 1
    # 같은 시(hour) 안의 다른 분 → 같은 버킷 → 히트.
    same_hour = _run_by_type(auth_client, _by_type_body(assumed_at="2026-08-27T01:40:00Z"), fetch)
    assert fetch.calls == 1
    assert same_hour == morning
    # 다른 시 → 다른 버킷 → 미스.
    _run_by_type(auth_client, _by_type_body(assumed_at="2026-08-27T05:00:00Z"), fetch)
    assert fetch.calls == 2
    # 가정 없음('지금')도 별개의 질문이다.
    _run_by_type(auth_client, _by_type_body(), fetch)
    assert fetch.calls == 3


def test_by_type_other_request_fields_miss_the_cache(auth_client, live_caches):  # noqa: F811
    fetch = _CountingFetch(_CAFES + [_facility("r-1", "restaurant", 0.0003)])

    _run_by_type(auth_client, _by_type_body(), fetch)
    _run_by_type(auth_client, _by_type_body(facility_type="restaurant"), fetch)
    _run_by_type(auth_client, _by_type_body(limit=2), fetch)
    _run_by_type(auth_client, _by_type_body(user_lat=BASE_LAT + 0.01), fetch)
    assert fetch.calls == 4


def test_by_type_cache_expires(auth_client, monkeypatch, live_caches):  # noqa: F811
    clock = {"t": 5_000.0}
    cache = recommendations_router._by_type_cache
    monkeypatch.setattr(cache, "_clock", lambda: clock["t"])
    cache.clear()

    fetch = _CountingFetch(_CAFES)
    body = _by_type_body()
    first = _run_by_type(auth_client, body, fetch)
    clock["t"] += 179.0
    assert _run_by_type(auth_client, body, fetch) == first
    assert fetch.calls == 1
    clock["t"] += 2.0  # 총 181초
    _run_by_type(auth_client, body, fetch)
    assert fetch.calls == 2


def test_by_type_failure_is_not_cached(auth_client, live_caches):  # noqa: F811
    """503 강등 경로는 그대로이고, 실패가 캐시에 눌러앉지 않는다."""
    body = _by_type_body()
    boom = AsyncMock(side_effect=RuntimeError("upstream down"))
    with patch("app.routers.recommendations.fetch_user", new=boom):
        res = auth_client.post(_BY_TYPE_PATH, json=body)
    assert res.status_code == 503

    fetch = _CountingFetch(_CAFES)
    assert _run_by_type(auth_client, body, fetch)
    assert fetch.calls == 1


def test_by_type_cached_payload_is_not_mutated_by_serialization(auth_client, live_caches):  # noqa: F811
    """캐시가 돌려준 객체를 FastAPI 가 직렬화해도 다음 호출자의 답은 그대로다."""
    fetch = _CountingFetch(_CAFES)
    body = _by_type_body()
    first = _run_by_type(auth_client, body, fetch)
    second = _run_by_type(auth_client, body, fetch)
    third = _run_by_type(auth_client, body, fetch)
    assert first == second == third
    assert fetch.calls == 1


# =========================================================================
# 4. 코스 엔드포인트
# =========================================================================

_COURSE_FACILITIES = [
    _facility("f-cafe", "cafe", 0.0002),
    _facility("f-rest", "restaurant", 0.0004),
    _facility("f-attr", "attraction", 0.0006),
]


def _run_course(auth_client, body, facilities_fetch):  # noqa: F811
    congestion = {f["id"]: _cong(0.3) for f in _COURSE_FACILITIES}
    with patch("app.routers.courses.predict_congestion", lambda *_a, **_k: 0.5), \
         patch("app.routers.courses.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.courses.fetch_all_facilities", new=facilities_fetch), \
         patch("app.routers.courses.fetch_congestion_map", new=AsyncMock(return_value=congestion)), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)):
        res = auth_client.post(_COURSE_PATH, json=body)
    assert res.status_code == 200
    return res.json()


def test_course_plan_repeat_returns_identical_payload_without_rerunning_pipeline(
    auth_client, live_caches  # noqa: F811
):
    fetch = _CountingFetch(_COURSE_FACILITIES)
    body = {"user_id": AUTH_USER_ID, "user_lat": BASE_LAT, "user_lng": BASE_LNG}

    first = _run_course(auth_client, body, fetch)
    second = _run_course(auth_client, body, fetch)

    assert fetch.calls == 1
    assert first == second
    assert first["stops"], "캐시 동일성 검증에는 정류지가 있어야 한다"
    assert first["plan_id"] == second["plan_id"]


def test_course_plan_assumed_bucket_and_pins_miss_the_cache(auth_client, live_caches):  # noqa: F811
    fetch = _CountingFetch(_COURSE_FACILITIES)
    base = {"user_id": AUTH_USER_ID, "user_lat": BASE_LAT, "user_lng": BASE_LNG}

    _run_course(auth_client, base, fetch)
    _run_course(auth_client, {**base, "assumed_at": "2026-08-27T05:00:00Z"}, fetch)
    _run_course(auth_client, {**base, "pins": [{"order": 1, "facility_id": "f-rest"}]}, fetch)
    _run_course(auth_client, {**base, "sequence": ["cafe", "restaurant"]}, fetch)
    assert fetch.calls == 4


def test_course_recommend_and_plan_share_one_computation(auth_client, live_caches):  # noqa: F811
    """/courses/recommend 와 /courses/plan 은 같은 계산이다 — 봉투만 다르다."""
    fetch = _CountingFetch(_COURSE_FACILITIES)
    body = {"user_id": AUTH_USER_ID, "user_lat": BASE_LAT, "user_lng": BASE_LNG}
    plan = _run_course(auth_client, body, fetch)

    congestion = {f["id"]: _cong(0.3) for f in _COURSE_FACILITIES}
    with patch("app.routers.courses.predict_congestion", lambda *_a, **_k: 0.5), \
         patch("app.routers.courses.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.courses.fetch_all_facilities", new=fetch), \
         patch("app.routers.courses.fetch_congestion_map", new=AsyncMock(return_value=congestion)), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)):
        res = auth_client.post("/api/v1/courses/recommend", json=body)

    assert res.status_code == 200
    assert res.json() == plan["stops"]
    assert fetch.calls == 1


# =========================================================================
# 5. /api/v1/warmup — 무인증 · 즉시 응답 · 절대 500 없음 · 멱등
# =========================================================================

@pytest.fixture(autouse=True)
def _reset_warmup_state():
    warmup_router._running = False
    warmup_router._last_finished_at = None
    yield
    warmup_router._running = False
    warmup_router._last_finished_at = None


def test_warmup_needs_no_auth_and_answers_immediately(client):  # noqa: F811
    with patch.object(warmup_router, "_warm_all", new=AsyncMock(return_value=None)):
        started = time.perf_counter()
        res = client.get("/api/v1/warmup")
        elapsed_ms = (time.perf_counter() - started) * 1000

    assert res.status_code == 200
    assert res.json() == {"status": "warming"}
    # 넉넉한 상한이다 — 여기서 실제 적재를 기다리면 초 단위가 된다.
    assert elapsed_ms < 500


def test_warmup_is_idempotent_within_the_cooldown(client):  # noqa: F811
    warm = AsyncMock(return_value=None)
    with patch.object(warmup_router, "_warm_all", new=warm):
        for _ in range(5):
            assert client.get("/api/v1/warmup").json() == {"status": "warming"}
    assert warm.await_count == 1


def test_warmup_never_500s_when_every_loader_explodes(client):  # noqa: F811
    async def _boom(*_args, **_kwargs):
        raise RuntimeError("upstream down")

    with patch.object(warmup_router, "_warm_all", new=_boom):
        res = client.get("/api/v1/warmup")

    assert res.status_code == 200
    assert res.json() == {"status": "warming"}
    # 실패해도 쿨다운은 걸린다(재시도 폭주 방지) — 그리고 두 번째 호출도 200 이다.
    assert client.get("/api/v1/warmup").status_code == 200


def test_warmup_recovers_when_the_task_cannot_be_scheduled(client):  # noqa: F811
    """예약 자체가 실패하면 쿨다운 없이 플래그를 풀어 다음 호출이 다시 시도한다."""
    def _cannot_schedule(coro, **_kwargs):
        coro.close()  # 태스크가 안 생겼으니 코루틴도 닫는다("never awaited" 경고 방지)
        raise RuntimeError("no loop")

    with patch.object(warmup_router.asyncio, "create_task", side_effect=_cannot_schedule):
        assert client.get("/api/v1/warmup").json() == {"status": "warming"}
    assert warmup_router._running is False
    assert warmup_router._last_finished_at is None

    warm = AsyncMock(return_value=None)
    with patch.object(warmup_router, "_warm_all", new=warm):
        client.get("/api/v1/warmup")
    assert warm.await_count == 1


@pytest.mark.asyncio
async def test_warm_all_swallows_every_step_failure():
    """단계가 전부 터져도 _warm_all 은 조용히 끝난다(예열은 계약이 아니다)."""
    async def _boom(*_args, **_kwargs):
        raise RuntimeError("upstream down")

    def _boom_sync(*_args, **_kwargs):
        raise RuntimeError("graph missing")

    with patch("app.routers.recommendations.fetch_all_facilities", new=_boom), \
         patch("app.services.congestion_evidence.load_current_estimates", new=_boom), \
         patch("app.services.area_demand_forecast_service.prefetch_area_demand_points", new=_boom), \
         patch("app.services.event_boost.get_event_congestion_boost", new=_boom), \
         patch("app.services.parking_demand_service.get_nearby_parking_lots", new=_boom), \
         patch("app.services.weather_service.get_gyeongju_weather", new=_boom), \
         patch("app.services.spot.travel._load_graph", new=_boom_sync):
        await warmup_router._warm_all()
