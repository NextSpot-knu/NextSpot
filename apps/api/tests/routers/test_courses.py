# 분산 코스(멀티스톱 동선) 추천 라우터 테스트 — 인증/IDOR 가드 + 행복 경로.
#   · 인증: get_current_user 는 auth_client 픽스처(dependency_overrides)로 대체.
#   · DB: fetch_user/fetch_all_facilities/fetch_congestion_map 는 AsyncMock,
#         선호 벡터는 preference_vector_service 패치 — PostgREST 호출이 전혀 없다.
#   · SPOT 스코어(calculate_spot_score)와 predict_congestion 은 실제로 돈다
#     (Kakao 키·model.pkl 부재 → Haversine·기본예측 0.5 → 결정적). test_routers 와 동일 전략.
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

import pytest

from app.services.preference_vector_service import preference_vector_service

from test_routers import (
    AUTH_USER_ID,
    BASE_LAT,
    BASE_LNG,
    USER_ROW,
    UNIT_VECTOR,
    _cong,
    _facility,
    auth_client,  # noqa: F401 — pytest 픽스처 재사용(import 로 활성화)
    client,       # noqa: F401
    # 후보 자격 판정(closing_soon·심야 규칙)이 실행 시각에 좌우되지 않게 now() 를 고정한다.
    # autouse 픽스처라 import 만으로 이 파일 전체에 적용된다(위 두 개와 같은 관용구).
    _freeze_router_clock,  # noqa: F401
)

_COURSE_PATH = "/api/v1/courses/recommend"


@pytest.fixture(autouse=True)
def _verified_model_prediction(monkeypatch):
    monkeypatch.setattr("app.routers.courses.predict_congestion", lambda *_args, **_kwargs: 0.5)


def _course_body(user_id: str = AUTH_USER_ID) -> dict:
    return {"user_id": user_id, "user_lat": BASE_LAT, "user_lng": BASE_LNG}


def test_course_requires_auth(client):  # noqa: F811
    # 인증 헤더 없음 → 401 (get_current_user 실경로)
    res = client.post(_COURSE_PATH, json=_course_body())
    assert res.status_code == 401


def test_course_idor_guard(auth_client):  # noqa: F811
    # 본문 user_id ≠ 토큰 주체 → 403
    res = auth_client.post(_COURSE_PATH, json=_course_body(user_id="someone-else"))
    assert res.status_code == 403


def test_course_happy_path(auth_client):  # noqa: F811
    # 인근 다종류 후보(카페/식당/관광지/문화) → 2~3 정류지 동선.
    facilities = [
        _facility("f-cafe", "cafe", 0.0002),
        _facility("f-rest", "restaurant", 0.0004),
        _facility("f-attr", "attraction", 0.0006),
        _facility("f-cult", "culture", 0.0008),
    ]
    far = [_facility("f-far", "cafe", 0.02)]  # 약 2.2km — 반경 컷오프에서 제외
    congestion_now = {f["id"]: _cong(0.3) for f in facilities}

    with patch("app.routers.courses.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.courses.fetch_all_facilities", new=AsyncMock(return_value=facilities + far)), \
         patch("app.routers.courses.fetch_congestion_map", new=AsyncMock(return_value=congestion_now)), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)):
        res = auth_client.post(_COURSE_PATH, json=_course_body())

    assert res.status_code == 200
    stops = res.json()
    # 최대 3 정류지 동선(반경 밖 f-far 는 제외)
    assert 2 <= len(stops) <= 3
    assert all(s["facility"]["id"] != "f-far" for s in stops)

    # order 는 1부터 연속, 정류지 시설은 중복되지 않는다.
    assert [s["order"] for s in stops] == list(range(1, len(stops) + 1))
    assert len({s["facility"]["id"] for s in stops}) == len(stops)

    # 도착 누적 시각(arrival_offset_min)은 순서대로 비감소(뒤 정류지가 더 늦게 도착).
    # (백엔드는 snake_case 로 응답 — camelCase 변환은 프런트 api-client 담당.)
    offsets = [s["arrival_offset_min"] for s in stops]
    assert offsets == sorted(offsets)
    # 활성 여정에는 누적 도착시간이 아니라 각 구간의 실제 도보시간을 저장해야 한다.
    assert all(0 < s["travel_minutes"] <= s["arrival_offset_min"] for s in stops)

    for s in stops:
        assert 0.0 <= s["predicted_congestion"] <= 1.0
        assert 0.0 <= s["spot_score"] <= 1.0
        assert isinstance(s["reason"], str) and s["reason"]


def test_course_type_filter(auth_client):  # noqa: F811
    # types 화이트리스트 → 지정 종류만 코스에 포함.
    facilities = [
        _facility("c-1", "cafe", 0.0002),
        _facility("c-2", "cafe", 0.0004),
        _facility("c-3", "cafe", 0.0006),
        _facility("r-1", "restaurant", 0.0003),
        _facility("a-1", "attraction", 0.0005),
    ]
    congestion_now = {f["id"]: _cong(0.2) for f in facilities}

    with patch("app.routers.courses.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.courses.fetch_all_facilities", new=AsyncMock(return_value=facilities)), \
         patch("app.routers.courses.fetch_congestion_map", new=AsyncMock(return_value=congestion_now)), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)):
        res = auth_client.post(_COURSE_PATH, json={**_course_body(), "types": ["cafe"]})

    assert res.status_code == 200
    stops = res.json()
    assert len(stops) >= 2
    assert all(s["facility"]["type"] == "cafe" for s in stops)


def test_course_empty_when_no_candidates(auth_client):  # noqa: F811
    # 후보 시설이 없으면 빈 코스([]) — 값을 지어내지 않는다.
    with patch("app.routers.courses.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.courses.fetch_all_facilities", new=AsyncMock(return_value=[])), \
         patch("app.routers.courses.fetch_congestion_map", new=AsyncMock(return_value={})), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)):
        res = auth_client.post(_COURSE_PATH, json=_course_body())

    assert res.status_code == 200
    assert res.json() == []


def test_course_uses_spot_as_only_ranking_objective(auth_client):  # noqa: F811
    facilities = [
        _facility("high-spot", "cafe", 0.0004),
        _facility("low-spot", "cafe", 0.0002),
    ]

    async def score(**kwargs):
        value = 0.9 if kwargs["candidate_facility"]["id"] == "high-spot" else 0.2
        return SimpleNamespace(score=value, breakdown={})

    with patch("app.routers.courses.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.courses.fetch_all_facilities", new=AsyncMock(return_value=facilities)), \
         patch("app.routers.courses.fetch_congestion_map", new=AsyncMock(return_value={})), \
         patch("app.routers.courses.calculate_spot_score", new=AsyncMock(side_effect=score)), \
         patch("app.routers.courses.predict_congestion", side_effect=lambda *args: 0.99 if args[0] == "cafe" else 0.0), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)):
        res = auth_client.post(_COURSE_PATH, json={**_course_body(), "types": ["cafe"]})

    assert res.status_code == 200
    assert res.json()[0]["facility"]["id"] == "high-spot"


def test_course_context_filters_before_scoring(auth_client):  # noqa: F811
    facilities = [
        {**_facility("indoor", "culture", 0.0002), "features": {"indoor_verified": True}},
        {**_facility("unknown", "culture", 0.0003), "features": {}},
    ]
    with patch("app.routers.courses.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.courses.fetch_all_facilities", new=AsyncMock(return_value=facilities)), \
         patch("app.routers.courses.fetch_congestion_map", new=AsyncMock(return_value={})), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)):
        res = auth_client.post(
            _COURSE_PATH,
            json={**_course_body(), "context": {"required_attributes": ["indoor"]}},
        )
    assert res.status_code == 200
    assert [stop["facility"]["id"] for stop in res.json()] == ["indoor"]


# =========================================================================
# 업스트림 장애를 빈 결과로 삼키지 않는다
# =========================================================================
# 이 엔드포인트는 네트워크 의존 호출이 6곳이다. 예전에는 그 중 하나만 흔들려도 그대로
# 500 "Internal Server Error" 가 나갔다 — 프로덕션에서 같은 요청이 한 번은 500, 재시도하면
# 200 인 것을 확인했다(2026-08-28).
#
# 핵심은 **[] 로 삼키지 않는 것**이다. 빈 배열은 "조건에 맞는 코스가 없다"는 정상 결과이고
# 화면도 그렇게 안내한다(새벽엔 여는 곳이 없어 실제로 자주 빈다). 장애를 같은 모양으로
# 돌려주면 사용자도 우리도 "없는 것"과 "못 만든 것"을 구분할 수 없다.
def test_upstream_failure_becomes_503_not_500(auth_client, monkeypatch):  # noqa: F811
    from app.routers import courses

    async def boom(*_a, **_kw):
        raise RuntimeError("supabase timeout")

    monkeypatch.setattr(courses, "_build_course", boom)
    res = auth_client.post(_COURSE_PATH, json=_course_body())
    assert res.status_code == 503
    assert "잠시 후" in res.json()["detail"]


def test_upstream_failure_is_not_silently_an_empty_course(auth_client, monkeypatch):  # noqa: F811
    from app.routers import courses

    async def boom(*_a, **_kw):
        raise RuntimeError("supabase timeout")

    monkeypatch.setattr(courses, "_build_course", boom)
    res = auth_client.post(_COURSE_PATH, json=_course_body())
    assert res.status_code != 200, "장애가 '코스 없음'(정상 결과)과 구분되지 않는다"


def test_permission_errors_are_not_masked_as_503(auth_client):  # noqa: F811
    """403 같은 의도된 실패까지 503 으로 뭉개면 안 된다."""
    body = _course_body()
    body["user_id"] = "00000000-0000-4000-8000-0000000000ff"  # 토큰 주체와 다른 사용자
    res = auth_client.post(_COURSE_PATH, json=body)
    assert res.status_code == 403


def _mocked_world():
    """행복 경로와 같은 목킹 세트 — 후보 평가 이전 단계는 전부 대체한다."""
    facilities = [
        _facility("f-cafe", "cafe", 0.0002),
        _facility("f-rest", "restaurant", 0.0004),
        _facility("f-attr", "attraction", 0.0006),
        _facility("f-cult", "culture", 0.0008),
    ]
    congestion_now = {f["id"]: _cong(0.3) for f in facilities}
    return (
        patch("app.routers.courses.fetch_user", new=AsyncMock(return_value=USER_ROW)),
        patch("app.routers.courses.fetch_all_facilities", new=AsyncMock(return_value=facilities)),
        patch("app.routers.courses.fetch_congestion_map", new=AsyncMock(return_value=congestion_now)),
        patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)),
    )


def test_one_bad_candidate_does_not_kill_the_whole_course(auth_client, monkeypatch):  # noqa: F811
    """후보 하나가 터져도 나머지로 코스를 만든다.

    후보 평가는 외부 의존이 여럿이라(경로 탐색·혼잡 예측·SPOT 스코어) 하나쯤 흔들릴 수 있다.
    asyncio.gather 기본 동작은 첫 예외를 올려 **멀쩡한 후보까지 버린다** — 그러면 대표 기능이
    통째로 503 이 된다.
    """
    from app.routers import courses

    real = courses._evaluate_candidate
    calls = {"n": 0}

    async def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("routing upstream hiccup")
        return await real(*args, **kwargs)

    a, b, c, d = _mocked_world()
    with a, b, c, d:
        monkeypatch.setattr(courses, "_evaluate_candidate", flaky)
        res = auth_client.post(_COURSE_PATH, json=_course_body())

    assert res.status_code == 200, "후보 하나의 실패가 코스 전체를 죽였다"
    assert calls["n"] > 1


def test_all_candidates_failing_is_surfaced_not_returned_as_empty(auth_client, monkeypatch):  # noqa: F811
    """전부 실패하면 빈 코스로 위장하지 않는다 — '갈 곳이 없다'와 구분돼야 한다."""
    from app.routers import courses

    async def always_boom(*_a, **_kw):
        raise RuntimeError("routing upstream down")

    a, b, c, d = _mocked_world()
    with a, b, c, d:
        monkeypatch.setattr(courses, "_evaluate_candidate", always_boom)
        res = auth_client.post(_COURSE_PATH, json=_course_body())

    assert res.status_code == 503
