# 분산 코스(멀티스톱 동선) 추천 라우터 테스트 — 인증/IDOR 가드 + 행복 경로.
#   · 인증: get_current_user 는 auth_client 픽스처(dependency_overrides)로 대체.
#   · DB: fetch_user/fetch_all_facilities/fetch_congestion_map 는 AsyncMock,
#         선호 벡터는 preference_vector_service 패치 — PostgREST 호출이 전혀 없다.
#   · SPOT 스코어(calculate_spot_score)·보행 경로(get_walking_routes)는 **실제로 돈다.** 둘 다
#     외부 키 없이 로컬에서 결정적이다(보행 경로는 동봉된 경주 OSM 그래프 app/data). test_routers
#     와 달리 여기서는 길찾기를 목으로 막지 않으므로, 이 파일이 배치 경로의 실측 회귀 방어선이다.
#   · predict_congestion 은 **실제로 돌지 않는다.** 아래 _verified_model_prediction 이 파일 전체에서
#     0.5 로 가로챈다. 그리고 진짜 함수는 '기본값' 을 주지 않는다 — 활성 모델 스냅샷이 없으면
#     None 이다(predict_service.predict_congestion_detailed → get_snapshot() is None).
#     **프로덕션이 지금 그 상태다**(/predict/model-info trained=false, 점수 근거 degraded_rules).
#     그러니 0.5 를 전제한 아래 단언들은 '학습된 모델이 있다면' 의 이야기다.
#   · 게다가 그 픽스처는 courses 에 import 된 이름만 갈아치우고, score.py 가 따로 import 한
#     predict_congestion_detailed 는 그대로 둔다 — 점수는 degraded 로 매기고 응답 필드만 0.5 인
#     **어디에도 없는 혼종 상태**다. 그래도 픽스처를 걷어내지 않는 이유는 숫자가 필요한 단언들이
#     있어서다(대안 정렬·혼잡 범위). 프로덕션이 100% 타는 None 분기는 파일 맨 아래 '미학습
#     (degraded) 상태' 절에서 따로 검증한다.
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
    """'학습된 모델이 있다면' 을 가정한다 — 프로덕션의 상태가 아니다(파일 상단 주석 참조).

    걷어내지 않는 이유는 숫자가 필요한 단언들(0 ≤ predicted_congestion ≤ 1, 대안 점수 내림차순)이
    이 값에 기대고 있어서다. 실제 프로덕션 분기(None)는 아래 '미학습(degraded) 상태' 절에서 잡는다.
    """
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


# =========================================================================
# 영업 근거는 후보 풀에만 조회한다
# =========================================================================
# 예전에는 fetch_all_facilities() 가 시설 전체분(1,600곳+)의 영업 근거를 받아 왔다.
# PostgREST in.(...) URL 한계로 150개씩 끊어 받으므로 **코스 한 번에 요청 11건**이 그것
# 때문에 나갔고(실측: 웜 캐시 기준 15건 중 11건), 정작 쓰는 곳은 후보 12~24곳을 평가하는
# open_status_at_arrival 하나뿐이라 나머지는 전부 버려졌다.
#
# Render free 플랜에서 요청당 작업량이 곧 실패율이라, 이 낭비를 되돌리면 안 된다.
def test_availability_is_fetched_only_for_the_candidate_pool(auth_client, monkeypatch):  # noqa: F811
    from app.routers import courses

    asked: list[list[str]] = []

    async def spy(ids):
        asked.append(list(ids))
        return {}

    monkeypatch.setattr(courses, "fetch_effective_availability_map", spy)

    a, b, c, d = _mocked_world()
    with a, b, c, d:
        res = auth_client.post(_COURSE_PATH, json=_course_body())

    assert res.status_code == 200
    assert len(asked) == 1, "영업 근거 조회가 한 번이 아니다"
    # 목킹된 세계의 시설은 4곳뿐이라 '전체'와 '풀'이 같아 보일 수 있으므로, 최소한
    # 후보 수를 넘지 않는다는 것과 실제 후보 id 만 물었다는 것을 확인한다.
    assert asked[0], "후보 id 없이 조회했다"
    assert len(asked[0]) <= 4


def test_course_still_uses_availability_for_open_status(auth_client, monkeypatch):  # noqa: F811
    """조회 시점을 옮겼다고 영업 근거가 반영되지 않으면 최적화가 아니라 기능 삭제다."""
    from app.routers import courses

    async def closed_everywhere(ids):
        return {
            fid: {"status": "closed", "evidence_tier": "verified", "reported_at": "2026-08-28T00:00:00+00:00"}
            for fid in ids
        }

    monkeypatch.setattr(courses, "fetch_effective_availability_map", closed_everywhere)

    a, b, c, d = _mocked_world()
    with a, b, c, d:
        res = auth_client.post(_COURSE_PATH, json=_course_body())

    assert res.status_code == 200
    # 영업 근거가 붙었다면 정류지의 도착 시점 상태에 그 판정이 실린다.
    for stop in res.json():
        assert "open_status_at_arrival" in stop


# =============================================================================
# 자리별 재계획 — 순서를 바꾸면 실제로 다른 답이 나오는가
# =============================================================================
# 이 절이 지키는 계약은 하나다: **사용자가 순서를 짜면 2번 이후 정류지가 달라진다.**
# 1번은 달라지지 않는다(출발점이 언제나 사용자 위치다) — 그 사실도 함께 못 박는다.
# 과장하지 않는 것이 이 기능의 약속이다.

_PLAN_PATH = "/api/v1/courses/plan"
_FAR = 0.0100  # 약 1.1km — 반경 컷오프 안이지만 도보로는 먼 거리


def _at(fid: str, ftype: str, lat_off: float, lng_off: float = 0.0) -> dict:
    """_facility 는 위도만 움직인다. 여기서는 '사용자에게선 멀지만 1번 정류지 옆' 을
    만들어야 해서 경도도 쓴다."""
    facility = _facility(fid, ftype, lat_off)
    facility["longitude"] = BASE_LNG + lng_off
    return facility


def _run(auth_client, facilities, body, path=_PLAN_PATH):  # noqa: F811
    congestion_now = {f["id"]: _cong(0.3) for f in facilities}
    with patch("app.routers.courses.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.courses.fetch_all_facilities", new=AsyncMock(return_value=facilities)), \
         patch("app.routers.courses.fetch_congestion_map", new=AsyncMock(return_value=congestion_now)), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)):
        res = auth_client.post(path, json=body)
    assert res.status_code == 200, res.text
    return res.json()


def _seq_body(sequence, pins=None):
    body = dict(_course_body(), sequence=sequence)
    if pins is not None:
        body["pins"] = pins
    return body


def _reorder_fixture():
    """사용자 근처 카페 10곳(미끼) + 멀리 관광지 1곳 + 그 관광지 **바로 옆** 카페 1곳.

    미끼가 10곳인 것이 핵심이다. 후보 풀이 '사용자 기준 가까운 6곳' 이던 시절에는 관광지 옆
    카페가 풀에 **들어오지도 못했다** — 그래서 순서를 어떻게 바꿔도 2번 카페가 늘 같았다.
    풀을 넓히고 자리마다 다시 추리는 변경을 되돌리면 아래 테스트들이 깨진다.
    """
    decoys = [_at("cafe-near-%d" % i, "cafe", 0.0001 * (i + 1)) for i in range(10)]
    return decoys + [
        _at("attr-far", "attraction", _FAR),
        _at("cafe-by-attr", "cafe", _FAR, lng_off=0.00005),  # 관광지에서 몇 m
    ]


def test_sequence_order_changes_later_stops(auth_client):  # noqa: F811
    """[관광지, 카페] 와 [카페, 관광지] 는 **다른 카페**를 데려와야 한다.

    관광지를 먼저 가면 2번 카페는 '관광지 옆' 이 맞고, 카페를 먼저 가면 '사용자 옆' 이 맞다.
    예전에는 둘 다 '사용자 옆' 이었다 — 자리마다 다시 추리지 않아, 이미 옮겨간 출발점
    근처의 가게가 애초에 후보에 없었기 때문이다.
    """
    facilities = _reorder_fixture()

    attr_first = _run(auth_client, facilities, _seq_body(["attraction", "cafe"]))
    cafe_first = _run(auth_client, facilities, _seq_body(["cafe", "attraction"]))

    attr_first_ids = [s["facility"]["id"] for s in attr_first["stops"]]
    cafe_first_ids = [s["facility"]["id"] for s in cafe_first["stops"]]

    assert attr_first_ids[0] == "attr-far"
    assert attr_first_ids[1] == "cafe-by-attr", (
        "관광지 다음 카페가 관광지 옆이 아니다: %s — 자리마다 '지금 서 있는 자리' 기준으로 "
        "다시 추리지 않으면 이 단언이 깨진다" % attr_first_ids
    )
    assert cafe_first_ids[0].startswith("cafe-near-"), cafe_first_ids
    assert cafe_first_ids[1] == "attr-far"
    # 같은 시설 집합·같은 위치인데 결과가 실제로 다르다 — 사용자 불만의 핵심이 이것이었다.
    assert set(attr_first_ids) != set(cafe_first_ids)
    assert attr_first["plan_id"] != cafe_first["plan_id"]


def test_first_stop_is_not_changed_by_reordering(auth_client):  # noqa: F811
    """1번 정류지는 순열과 무관하다 — 출발점이 언제나 사용자 위치이기 때문이다.

    이 기능이 약속할 수 있는 범위를 못 박는 테스트다. '순서를 바꾸면 전부 바뀐다' 고
    말하고 싶어지는 자리인데 그건 사실이 아니다.
    """
    facilities = _reorder_fixture()
    a = _run(auth_client, facilities, _seq_body(["cafe", "attraction"]))
    b = _run(auth_client, facilities, _seq_body(["cafe", "cafe"]))
    assert a["stops"][0]["facility"]["id"] == b["stops"][0]["facility"]["id"]


def test_alternatives_are_the_runner_ups(auth_client):  # noqa: F811
    """대안은 그 자리의 2·3등이고, 뽑힌 곳과 겹치지 않는다."""
    plan = _run(auth_client, _reorder_fixture(), _seq_body(["cafe", "cafe"]))
    first = plan["stops"][0]
    alts = first["alternatives"]
    assert alts, "채점은 다 해 놓고 2등 이하를 버리고 있다"
    assert len(alts) <= 3
    assert first["facility"]["id"] not in [a["facility"]["id"] for a in alts]
    # 같은 자리의 후보이므로 점수는 1등 이하로 내림차순이어야 한다.
    scores = [first["spot_score"]] + [a["spot_score"] for a in alts]
    assert scores == sorted(scores, reverse=True), scores
    # 도착 시각은 '그 자리의 실제 누적 시각' 이라 0 보다 크다(지어낸 값이 아니다).
    assert all(a["arrival_offset_min"] > 0 for a in alts)
    # 2번 자리의 대안에 1번에서 이미 쓴 가게가 들어오면 안 된다.
    if len(plan["stops"]) > 1:
        used = plan["stops"][0]["facility"]["id"]
        assert used not in [a["facility"]["id"] for a in plan["stops"][1]["alternatives"]]


def test_pin_is_not_stolen_by_an_earlier_slot(auth_client):  # noqa: F811
    """3번에 고정한 가게를 1번 그리디가 집어가면 안 된다.

    빼놓지 않으면 앞 자리가 먼저 쓰고, 정작 3번 차례에는 remaining 에서 사라져
    pin_unavailable 이 된다 — 사용자가 명시적으로 고정한 자리가 조용히 먹히는 것이다.
    """
    facilities = _reorder_fixture()
    # 사용자 바로 옆 카페(1번이 자연히 고를 곳)를 3번 자리에 고정한다.
    target = "cafe-near-0"
    plan = _run(auth_client, facilities, _seq_body(
        ["cafe", "attraction", "cafe"], pins=[{"order": 3, "facility_id": target}]
    ))
    stops = plan["stops"]
    assert stops[0]["facility"]["id"] != target, "1번이 3번의 고정 가게를 집어갔다"
    assert stops[-1]["facility"]["id"] == target
    third = next(o for o in plan["slot_outcomes"] if o["order"] == 3)
    assert third["status"] == "filled" and third["pinned"] is True


def test_pin_failing_eligibility_is_reported_not_forced(auth_client):  # noqa: F811
    """자격에 걸린 고정은 **넣지 않고** 알린다.

    접근성은 '미상 = 부적격' 의 fail-closed 판정이다(travel_context.py). 고정이라는
    이유로 우회시키면 그 결과는 휠체어 사용자를 계단 앞에 세우는 것이다.
    """
    facilities = _reorder_fixture()
    accessible = _at("cafe-ok", "cafe", 0.0003)
    accessible["barrier_free"] = True
    facilities.append(accessible)

    body = _seq_body(["cafe", "cafe"], pins=[{"order": 2, "facility_id": "cafe-near-0"}])
    body["context"] = {"required_attributes": ["accessible"]}
    plan = _run(auth_client, facilities, body)

    ids = [s["facility"]["id"] for s in plan["stops"]]
    assert "cafe-near-0" not in ids, "무장애 여부 미상인 가게가 고정을 이유로 들어갔다"
    second = next(o for o in plan["slot_outcomes"] if o["order"] == 2)
    assert second["status"] == "pin_unavailable"
    assert second["facility_id"] == "cafe-near-0"


def test_dead_middle_slot_does_not_kill_later_slots(auth_client):  # noqa: F811
    """가운데 자리가 비어도 뒤 자리는 살아남는다(예전에는 break 라 통째로 사라졌다).

    그리고 왜 비었는지를 코드로 알려 준다 — 개수 차이로 추측하게 두지 않는다.
    """
    facilities = _reorder_fixture()
    closed = _at("cult-closed", "culture", 0.0005)
    closed["operating_hours"] = {"open": "18:00~22:00"}  # 12:00 KST 도착 → 영업 전
    facilities.append(closed)

    plan = _run(auth_client, facilities, _seq_body(["cafe", "culture", "attraction"]))
    outcomes = {o["order"]: o["status"] for o in plan["slot_outcomes"]}
    assert outcomes[1] == "filled"
    assert outcomes[2] == "closed_at_arrival", outcomes
    assert outcomes[3] == "filled", "가운데 자리가 비었다고 뒤 자리까지 날아갔다"
    assert [s["facility"]["id"] for s in plan["stops"]][-1] == "attr-far"
    # 응답 order 는 남은 것만으로 1..n 이다 — 그래서 slot_outcomes 가 따로 필요하다.
    assert [s["order"] for s in plan["stops"]] == [1, 2]


def test_missing_type_reports_its_own_code(auth_client):  # noqa: F811
    """'그 종류가 아예 없다' 와 '있는데 문을 닫았다' 는 다른 코드여야 한다."""
    plan = _run(auth_client, _reorder_fixture(), _seq_body(["cafe", "culture"]))
    outcomes = {o["order"]: o["status"] for o in plan["slot_outcomes"]}
    assert outcomes[2] == "no_candidate_of_type", outcomes


def test_plan_id_tracks_the_actual_result(auth_client):  # noqa: F811
    """같은 입력이면 같고, 결과가 달라지면 달라진다.

    화면이 '새 추천이 왔어요' 를 추측이 아니라 사실로 말할 수 있게 하는 값이다.
    """
    facilities = _reorder_fixture()
    a = _run(auth_client, facilities, _seq_body(["cafe", "attraction"]))
    b = _run(auth_client, facilities, _seq_body(["cafe", "attraction"]))
    assert a["plan_id"] == b["plan_id"]
    c = _run(auth_client, facilities, _seq_body(["attraction", "cafe"]))
    assert c["plan_id"] != a["plan_id"]


def test_recommend_endpoint_still_returns_a_bare_array(auth_client):  # noqa: F811
    """구 번들 호환 — /recommend 의 최상위는 여전히 배열이다.

    Vercel 과 Render 는 배포 시점이 다르고 스테이징이 없다. 여기가 객체가 되는 순간
    구 번들의 Array.isArray 검사가 false 로 떨어져 **장애가 '갈 곳 없음' 으로 보인다.**
    """
    stops = _run(auth_client, _reorder_fixture(), _course_body(), path=_COURSE_PATH)
    assert isinstance(stops, list)
    assert stops and "facility" in stops[0]
    assert all("order" in s for s in stops)



def test_empty_course_still_says_why(auth_client):  # noqa: F811
    """후보가 하나도 없어도 **자리마다 이유**를 돌려준다.

    빈 배열만 오면 '서버가 죽었나' 와 '조건에 맞는 곳이 없나' 를 화면이 구분할 수 없다.
    이 라우터가 다른 곳에서 503 과 빈 배열을 굳이 갈라 놓는 것과 같은 이유다.
    """
    # 여행 조건이 모든 후보를 걸러내는 상황(무장애 미상인 카페만 있는데 accessible 요구).
    body = _seq_body(["cafe", "cafe"])
    body["context"] = {"required_attributes": ["accessible"]}
    plan = _run(auth_client, _reorder_fixture(), body)

    assert plan["stops"] == []
    assert [o["order"] for o in plan["slot_outcomes"]] == [1, 2], plan["slot_outcomes"]
    assert all(o["status"] == "no_candidate_of_type" for o in plan["slot_outcomes"])
    assert all(o["requested_type"] == "cafe" for o in plan["slot_outcomes"])


def test_late_night_unconfirmed_food_says_so(auth_client):  # noqa: F811
    """밤에는 영업 미확인 식당·카페를 보내지 않는다 — 그리고 **그렇다고 말한다.**

    '문을 닫았다' 와 '열었는지 우리가 모른다' 는 사용자에게 전혀 다른 사실이다. 후자는
    아침에 다시 오면 결과가 달라진다. 그래서 closed_at_arrival 과 코드를 나눈다.

    이 테스트가 없으면, 심야에 코스가 비는 것과 조건이 너무 좁아서 비는 것을 화면이
    같은 문구로 말하게 된다(실제로 그랬다 — 2026-09-06 23:00 에 사용자가 빈 화면을 보고
    "밤이라 그런가?" 라고 물었고, 화면에는 그 답이 없었다).
    """
    from datetime import datetime, timezone
    from unittest.mock import patch as _patch

    # 영업 시간을 **모르는** 카페들(needs_confirmation) — 심야 규칙의 대상이다.
    facilities = []
    for i in range(3):
        cafe = _at("cafe-unknown-%d" % i, "cafe", 0.0002 * (i + 1))
        cafe.pop("operating_hours", None)
        facilities.append(cafe)

    late = datetime(2026, 8, 27, 14, 0, tzinfo=timezone.utc)  # = 23:00 KST

    class _LateNight(datetime):
        @classmethod
        def now(cls, tz=None):
            return late.astimezone(tz) if tz else late.replace(tzinfo=None)

    with _patch("app.routers.courses.datetime", _LateNight):
        plan = _run(auth_client, facilities, _seq_body(["cafe", "cafe"]))

    assert plan["stops"] == [], "심야 미확인 식당·카페가 코스에 들어갔다"
    statuses = {o["status"] for o in plan["slot_outcomes"]}
    assert statuses == {"late_night_unconfirmed"}, statuses


def test_daytime_keeps_the_same_unconfirmed_places(auth_client):  # noqa: F811
    """낮에는 같은 후보가 그대로 추천된다 — 심야 규칙이 시간대 규칙임을 못 박는다.

    이게 없으면 위 테스트는 '미확인 후보는 언제나 빠진다' 로도 통과한다.
    """
    facilities = []
    for i in range(3):
        cafe = _at("cafe-unknown-%d" % i, "cafe", 0.0002 * (i + 1))
        cafe.pop("operating_hours", None)
        facilities.append(cafe)

    # 파일 기본 픽스처(_freeze_router_clock)가 12:00 KST 로 고정한다.
    plan = _run(auth_client, facilities, _seq_body(["cafe", "cafe"]))
    assert len(plan["stops"]) == 2, plan["slot_outcomes"]

def test_course_stop_limit_parity_with_web():
    """백엔드 MAX_STOPS 와 프런트 MAX_SEQUENCE 가 어긋나면 CI 가 여기서 실패한다.

    강제 장치가 필요한 이유: 두 상수는 **한쪽만 늘려도 조용히 어긋난다.**
      · 프런트만 4 로 올리면 courses.py 의 `seq[:MAX_STOPS]` 가 4번째 칩을 말없이 버린다.
        사용자는 4칸을 짰는데 3곳만 오고, 화면은 이유를 말하지 못한다.
      · 그리고 이제는 더 나쁘다 — CoursePin.order 가 `le=MAX_STOPS` 라, 4번 자리에 고정을
        걸면 요청 전체가 422 로 떨어진다(자리 하나가 비는 게 아니라 코스가 통째로 실패한다).
    SPOT 가중치가 packages/shared-types 와 패리티 테스트로 묶여 있는 것과 같은 이유다
    (tests/services/test_spot.py::test_spot_weights_parity_with_shared_types).

    모노레포 밖(Docker 등)에서는 프런트 파일이 없으므로 건너뛴다.
    """
    import re
    from pathlib import Path

    from app.routers.courses import MAX_STOPS

    page = Path(__file__).resolve().parents[4] / "apps" / "web" / "app" / "course" / "page.tsx"
    if not page.exists():
        pytest.skip("apps/web/app/course/page.tsx 부재(모노레포 밖 실행) — 패리티 검증 생략")

    text = page.read_text(encoding="utf-8")
    match = re.search(r"const\s+MAX_SEQUENCE\s*=\s*(\d+)\s*;", text)
    assert match, "course/page.tsx 에서 MAX_SEQUENCE 를 찾지 못했다(이름이 바뀌었다면 이 테스트도 고칠 것)"
    assert int(match.group(1)) == MAX_STOPS, (
        f"프런트 MAX_SEQUENCE={match.group(1)} 와 백엔드 MAX_STOPS={MAX_STOPS} 가 다르다"
    )


# =============================================================================
# 고정(핀) 이 스스로를, 혹은 남을 죽이지 않는가
# =============================================================================

def test_same_facility_pinned_to_two_slots_still_fills_one(auth_client):  # noqa: F811
    """같은 가게를 두 자리에 고정해도 **한 자리는 채워진다.**

    other_pinned 에서 '자기 자신과 같은 facility_id' 를 빼지 않으면 두 자리가 서로를 지운다:
    1번의 other_pinned 에는 2번에서 온 X 가, 2번에는 1번에서 온 X 가 들어가 양쪽 available 에서
    X 가 빠지고 둘 다 pin_unavailable 이 된다. 한 자리에는 멀쩡히 들어갈 수 있는 가게가 통째로
    사라지는 것이라, 사용자에게는 '고정했더니 코스가 비었다' 로 보인다.
    """
    target = "cafe-near-3"
    plan = _run(auth_client, _reorder_fixture(), _seq_body(
        ["cafe", "cafe"],
        pins=[{"order": 1, "facility_id": target}, {"order": 2, "facility_id": target}],
    ))

    ids = [s["facility"]["id"] for s in plan["stops"]]
    assert ids == [target], "같은 가게를 두 자리에 고정했더니 두 자리가 함께 죽었다: %s" % plan["slot_outcomes"]

    outcomes = {o["order"]: o for o in plan["slot_outcomes"]}
    assert outcomes[1]["status"] == "filled" and outcomes[1]["pinned"] is True
    # 뒤 자리는 '앞에서 이미 쓰였다' 는 정직한 사유다 — 넣지 못했다는 사실을 감추지 않는다.
    assert outcomes[2]["status"] == "pin_unavailable"
    assert outcomes[2]["facility_id"] == target


def test_pins_are_capped_at_the_stop_count(auth_client):  # noqa: F811
    """고정은 자리마다 하나이므로 MAX_STOPS 개를 넘는 pins 는 받지 않는다.

    상한이 없던 시절 이 리스트는 그대로 후보 풀에 얹혔다. 자리 수를 넘는 핀은 코스에 아무 영향도
    주지 못하면서 풀만 부풀리는데, 일괄 조회(혼잡·타임세일·영업근거)가 전부 풀 크기에 비례하고
    영업근거는 PostgREST in.() 한계 때문에 150개씩 끊어 나간다 — 인증만 있으면(익명 세션으로
    충분) 누구나 보낼 수 있는 요청량 증폭이었다.
    """
    body = _seq_body(["cafe", "cafe"], pins=[
        {"order": 1, "facility_id": "cafe-near-0"},
        {"order": 2, "facility_id": "cafe-near-1"},
        {"order": 3, "facility_id": "cafe-near-2"},
        {"order": 1, "facility_id": "cafe-near-3"},
    ])
    res = auth_client.post(_PLAN_PATH, json=body)
    assert res.status_code == 422, "자리 수를 넘는 pins 가 그대로 통과했다"


def test_duplicate_order_pins_do_not_inflate_the_candidate_pool(auth_client, monkeypatch):  # noqa: F811
    """같은 자리에 겹쳐 온 핀은 **풀에 얹지 않는다.**

    슬롯 루프는 order 하나당 하나(뒤엣것)만 쓴다. 나머지를 풀에 넣으면 코스에는 나타나지도
    않으면서 일괄 조회 대상만 늘어난다 — 풀 크기가 곧 Supabase 요청량이다.
    """
    from app.routers import courses

    # 반경(약 1.3km) 밖이라 후보 풀에는 못 들어가지만 여행 조건은 통과하는 가게들.
    # 핀으로 지목되면 풀에 얹히므로, 풀에 무엇이 얹혔는지가 그대로 드러난다.
    outside = [_at("far-pin-%d" % i, "cafe", 0.05 + 0.001 * i) for i in range(3)]

    asked: list[list[str]] = []

    async def spy(ids):
        asked.append(list(ids))
        return {}

    monkeypatch.setattr(courses, "fetch_effective_availability_map", spy)

    plan = _run(auth_client, _reorder_fixture() + outside, _seq_body(
        ["cafe", "cafe"],
        pins=[{"order": 1, "facility_id": f["id"]} for f in outside],  # 전부 1번 자리
    ))

    pool_ids = set(asked[0])
    assert "far-pin-2" in pool_ids, "1번 자리에 실제로 쓰이는 마지막 핀이 풀에서 빠졌다"
    assert not {"far-pin-0", "far-pin-1"} & pool_ids, (
        "쓰이지도 않는 겹친 핀이 후보 풀에 얹혔다: %s" % sorted(pool_ids)
    )
    # 실제로 쓰인 핀은 1번 자리를 채운다(풀에서 뺐다가 코스가 망가지지 않았는지 함께 본다).
    assert plan["stops"][0]["facility"]["id"] == "far-pin-2"


def test_pin_past_the_last_slot_is_reported_and_blocks_nothing(auth_client):  # noqa: F811
    """돌지 않는 자리에 걸린 핀은 **사유를 남기고**, 다른 자리를 막지 않는다.

    루프는 range(target_stops) 만 돈다. 자동 모드의 target_stops 는 min(MAX_STOPS, len(pool)) 이라
    풀이 2곳이면 2인데, 프런트 자동 모드의 자리 키는 언제나 3개(auto-0..2)라 3번 칸 핀은 늘
    order=3 으로 나가고, 풀이 줄어든 뒤에도 상태에 남아 계속 올라온다.
    그러면 (a) 그 자리는 슬롯이 안 돌아 SlotOutcome 이 하나도 안 생기고(화면에 사유 행조차 없다),
    (b) 그러면서 other_pinned 에는 남아 1·2번 후보에서 그 가게를 빼 버렸다 — 고정한 가게가
    '여기 넣어라' 가 아니라 '아무 데도 넣지 마라' 로 작동한 셈이다.
    """
    facilities = [_at("cafe-a", "cafe", 0.0002), _at("cafe-b", "cafe", 0.0004)]
    body = dict(_course_body(), pins=[{"order": 3, "facility_id": "cafe-a"}])
    plan = _run(auth_client, facilities, body)

    ids = [s["facility"]["id"] for s in plan["stops"]]
    assert set(ids) == {"cafe-a", "cafe-b"}, (
        "자리 없는 핀이 그 가게를 남은 자리에서까지 몰아냈다: %s / %s" % (ids, plan["slot_outcomes"])
    )

    third = next((o for o in plan["slot_outcomes"] if o["order"] == 3), None)
    assert third is not None, "돌지 않은 자리의 핀이 사유 없이 증발했다: %s" % plan["slot_outcomes"]
    assert third["status"] == "pin_unavailable"
    assert third["facility_id"] == "cafe-a" and third["pinned"] is True


def test_alternatives_never_contain_a_stop_of_the_same_course(auth_client):  # noqa: F811
    """어느 자리의 '다른 곳' 에도 **이 코스에 이미 들어간 가게**가 있으면 안 된다.

    대안은 그 자리의 2·3등인데, 선택분이 remaining 에서 빠지는 것은 대안을 실은 다음 줄이고
    뒤 자리는 그 remaining 에서 고른다. 그래서 1번의 2등이 그대로 2번 정류지가 되는 흔한
    경우(같은 종류를 연달아 짜면 거의 항상), 1번 카드의 '다른 곳' 안에 바로 아래 2번 정류지가
    들어 있었다. 눌러도 새로운 데를 얻지 못하고 1·2번이 자리만 맞바꾸므로, '다른 곳' 이라는
    이름 자체가 거짓이 된다. 그 선택은 프런트에서 '이 자리에 고정' 으로 되돌아오기도 한다.

    기존 test_alternatives_are_the_runner_ups 는 '2번의 대안에 1번이 없다' 는 **반대 방향만**
    본다. 실제로 터진 것은 이쪽이다.
    """
    plan = _run(auth_client, _reorder_fixture(), _seq_body(["cafe", "cafe", "cafe"]))
    stop_ids = {s["facility"]["id"] for s in plan["stops"]}
    assert len(stop_ids) >= 2, plan["slot_outcomes"]

    for stop in plan["stops"]:
        overlap = stop_ids & {a["facility"]["id"] for a in stop["alternatives"]}
        assert not overlap, (
            "%d번 정류지의 '다른 곳' 에 이 코스의 정류지가 들어 있다: %s"
            % (stop["order"], sorted(overlap))
        )
    # 걸러내기가 대안을 통째로 없애 버린 것은 아닌지 함께 본다(기능 삭제가 아니라 정정이다).
    assert any(s["alternatives"] for s in plan["stops"]), "대안이 전부 사라졌다"


# =============================================================================
# 미학습(degraded) 상태 — 프로덕션이 지금 100% 타는 분기
# =============================================================================
# 활성 모델 스냅샷이 없으면 predict_congestion 은 None 이다(기본값이 아니다).
# 프로덕션이 그 상태다(/predict/model-info trained=false). 위쪽 테스트들은 파일 전체에 걸린
# _verified_model_prediction 픽스처 때문에 전부 0.5 를 전제하므로, 아래 분기는 그 어느
# 테스트에서도 실행되지 않았다 — 배포된 어떤 환경에도 없는 상태만 검증하고 있었던 것이다.


def _degraded(monkeypatch):
    """이 요청 한 벌을 프로덕션과 같은 미학습 상태로 되돌린다.

    autouse 픽스처가 갈아치운 courses.predict_congestion 을 **진짜 함수**로 되돌리고,
    스냅샷 조회만 없는 상태로 고정한다. 그러면 courses 도 score.py 도 같은 get_snapshot 을
    보므로 응답 필드와 점수 근거가 한 상태(degraded)로 정합한다 — 픽스처가 만들던
    '점수는 degraded, 필드는 0.5' 인 혼종 상태가 아니다.
    """
    from app.services import predict_service

    monkeypatch.setattr(predict_service, "get_snapshot", lambda: None)
    monkeypatch.setattr("app.routers.courses.predict_congestion", predict_service.predict_congestion)


def test_degraded_model_reports_no_congestion_instead_of_inventing_one(auth_client, monkeypatch):  # noqa: F811
    """모델이 없으면 혼잡 수치를 **주지 않는다** — 지어내지도, 기본값으로 때우지도 않는다."""
    _degraded(monkeypatch)
    plan = _run(auth_client, _reorder_fixture(), _seq_body(["cafe", "attraction"]))

    assert plan["stops"], "미학습 상태에서 코스가 통째로 비었다: %s" % plan["slot_outcomes"]
    for stop in plan["stops"]:
        assert stop["predicted_congestion"] is None, stop
        # 도착 시점 예상 인원도 마찬가지다(capacity × None 을 0 으로 접지 않는다).
        assert stop["facility"]["current_count"] is None, stop["facility"]
        for alt in stop["alternatives"]:
            assert alt["predicted_congestion"] is None, alt


def test_degraded_reason_does_not_quote_a_percentage(auth_client, monkeypatch):  # noqa: F811
    """사유 문구도 수치를 말하지 않는다.

    _build_stop_reason 의 None 분기는 '몇 분 후 도착' 만 말하고 혼잡도 %·라벨을 뺀다. 이 분기는
    픽스처 때문에 이 파일에서 한 번도 실행된 적이 없었는데, 정작 프로덕션은 언제나 여기로 온다.
    """
    _degraded(monkeypatch)
    plan = _run(auth_client, _reorder_fixture(), _seq_body(["cafe", "attraction"]))

    for stop in plan["stops"]:
        reason = stop["reason"]
        assert reason
        assert "%" not in reason, "미학습 상태인데 사유가 혼잡도 수치를 말한다: %s" % reason
        assert "분 후 도착" in reason, reason


def test_degraded_course_still_ranks_and_still_says_why(auth_client, monkeypatch):  # noqa: F811
    """수치가 없어도 코스는 성립한다 — SPOT(선호·이동시간·인센티브)만으로 순위가 정해진다.

    '모델이 없으면 아무것도 못 한다' 가 아니라 '아는 것만 말한다' 가 이 라우터의 계약이다.
    """
    _degraded(monkeypatch)
    plan = _run(auth_client, _reorder_fixture(), _seq_body(["cafe", "attraction"]))

    assert [o["status"] for o in plan["slot_outcomes"]] == ["filled", "filled"], plan["slot_outcomes"]
    offsets = [s["arrival_offset_min"] for s in plan["stops"]]
    assert offsets == sorted(offsets)
    assert all(0.0 <= s["spot_score"] <= 1.0 for s in plan["stops"])
    assert plan["plan_id"]
