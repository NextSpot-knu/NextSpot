# 분산 코스(멀티스톱 동선) 추천 라우터 테스트 — 인증/IDOR 가드 + 행복 경로.
#   · 인증: get_current_user 는 auth_client 픽스처(dependency_overrides)로 대체.
#   · DB: fetch_user/fetch_all_facilities/fetch_congestion_map 는 AsyncMock,
#         선호 벡터는 preference_vector_service 패치 — PostgREST 호출이 전혀 없다.
#   · SPOT 스코어(calculate_spot_score)와 predict_congestion 은 실제로 돈다
#     (Kakao 키·model.pkl 부재 → Haversine·기본예측 0.5 → 결정적). test_routers 와 동일 전략.
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

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
)

_COURSE_PATH = "/api/v1/courses/recommend"


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
