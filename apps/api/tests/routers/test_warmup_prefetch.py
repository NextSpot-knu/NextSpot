"""`/api/v1/warmup` 의 지역수요 프리페치 좌표 선택 — `app/routers/warmup.py::_nearest_coordinates`.

2026-09-21 메모리 사고 조치: DB 순서 앞 N개가 아니라 데모 중심에서 가장 가까운 시설의 좌표를
골라야 한다. 배경은 `warmup.py`의 `_AREA_DEMAND_PREFETCH_LIMIT` 주석 참조 — 옛 로직(앞 60개)은
경주 전역에 흩어진 임의의 시설을 채워 격자 40~57개(~20-26MB)를 차지했지만, 심사위원이 데모장에서
누르는 첫 요청이 채점하는 후보는 데모 중심 반경 안뿐이라 그 효과가 거의 없었다.
"""

from unittest.mock import AsyncMock, patch

import pytest

from app.routers import warmup as warmup_router

_LAT = warmup_router._DEMO_CENTER_LAT
_LNG = warmup_router._DEMO_CENTER_LNG


def _f(lat, lng) -> dict:
    return {"latitude": lat, "longitude": lng}


# =========================================================================
# 1. _nearest_coordinates — 순수 함수
# =========================================================================

def test_orders_by_distance_to_the_demo_center():
    """DB 순서는 거리와 무관하게 섞여 있다 — 결과는 항상 가까운 순으로 정렬돼야 한다."""
    near = _f(_LAT + 0.0005, _LNG)
    mid = _f(_LAT + 0.01, _LNG)
    far = _f(_LAT + 0.05, _LNG)
    facilities = [far, near, mid]  # DB 순서를 일부러 뒤섞는다

    result = warmup_router._nearest_coordinates(facilities, limit=10)

    assert result == [
        (near["latitude"], near["longitude"]),
        (mid["latitude"], mid["longitude"]),
        (far["latitude"], far["longitude"]),
    ]


def test_limit_is_respected():
    facilities = [_f(_LAT + i * 0.001, _LNG) for i in range(10)]

    result = warmup_router._nearest_coordinates(facilities, limit=3)

    assert len(result) == 3
    assert result == [(_LAT + i * 0.001, _LNG) for i in range(3)]


def test_rows_with_none_or_missing_coordinates_are_skipped():
    facilities = [
        _f(None, _LNG),                              # 위도 None
        _f(_LAT, None),                               # 경도 None
        {"id": "no-coords-at-all"},                    # 키 자체가 없음
        {"latitude": _LAT, "longitude": _LNG},         # 정상
    ]

    result = warmup_router._nearest_coordinates(facilities, limit=10)

    assert result == [(_LAT, _LNG)]


def test_rows_with_non_numeric_coordinates_are_skipped():
    facilities = [
        _f("경주시 어딘가", _LNG),   # 숫자로 못 바꾸는 문자열
        _f(_LAT, object()),          # float() 이 TypeError 를 내는 값
        _f(_LAT, _LNG),               # 정상
    ]

    result = warmup_router._nearest_coordinates(facilities, limit=10)

    assert result == [(_LAT, _LNG)]


def test_rows_with_infinite_or_nan_coordinates_are_skipped():
    """float() 을 통과하지만 하버사인을 죽이는 값 — 이 행 하나가 예열 전체를 날리면 안 된다.

    float("1e309") 은 예외 없이 inf 를 돌려주고(Postgres double precision 은 'Infinity' 를
    저장할 수 있다), calculate_haversine_distance 는 math.sin(inf) 에서 ValueError 를 낸다.
    _nearest_coordinates 는 _warm_all 이 gather 를 만들기 전에 동기로 불리므로, 그 예외가
    올라오면 6단계(walking_graph·estimates·parking·festival·weather·area_demand)가 하나도
    돌지 않고, _run_warmup 이 그걸 삼킨 뒤 5분 쿨다운까지 걸어 그 뒤 호출도 no-op 이 된다.
    """
    facilities = [
        _f(float("inf"), _LNG),
        _f(_LAT, float("-inf")),
        _f("1e309", _LNG),            # 문자열이지만 float() 이 inf 로 받아 준다
        _f(float("nan"), _LNG),       # 예외는 안 나지만 좌표로 쓸 수 없다
        _f(_LAT, _LNG),                # 정상
    ]

    result = warmup_router._nearest_coordinates(facilities, limit=10)

    assert result == [(_LAT, _LNG)]


def test_empty_facilities_returns_empty_list():
    assert warmup_router._nearest_coordinates([], limit=24) == []


# =========================================================================
# 2. _warm_all 배선 — prefetch_area_demand_points 로 실제 넘어가는 좌표
# =========================================================================

@pytest.mark.asyncio
async def test_warm_all_prefetches_only_the_nearest_facilities():
    """60개가 아니라 24개, 그것도 데모 중심에서 가까운 것만 prefetch_area_demand_points 로 간다.

    facilities 는 일부러 거리 역순(DB 순서 맨 앞이 가장 멀다)으로 만든다 — 옛 구현처럼
    facilities[:limit] 로 앞에서 자르기만 했다면 이 테스트는 실패한다.
    """
    offsets = list(reversed(range(40)))  # 리스트 순서(=DB 순서)와 거리 순서를 반대로 둔다
    facilities = [_f(_LAT + off * 0.001, _LNG) for off in offsets]

    captured: dict = {}

    async def _fake_facilities(**_kwargs):
        return facilities

    async def _fake_prefetch(coords, *, now):
        captured["coords"] = coords

    with patch("app.routers.recommendations.fetch_all_facilities", new=_fake_facilities), \
         patch("app.services.congestion_evidence.load_current_estimates", new=AsyncMock(return_value=None)), \
         patch("app.services.area_demand_forecast_service.prefetch_area_demand_points", new=_fake_prefetch), \
         patch("app.services.event_boost.get_event_congestion_boost", new=AsyncMock(return_value=None)), \
         patch("app.services.parking_demand_service.get_nearby_parking_lots", new=AsyncMock(return_value=None)), \
         patch("app.services.weather_service.get_gyeongju_weather", new=AsyncMock(return_value=None)), \
         patch("app.services.spot.travel._load_graph", lambda: None):
        await warmup_router._warm_all()

    coords = captured["coords"]
    assert len(coords) == warmup_router._AREA_DEMAND_PREFETCH_LIMIT == 24
    # 가장 가까운 24개(오프셋 0~23)가, 가까운 순서 그대로 넘어가야 한다.
    assert coords == [(_LAT + off * 0.001, _LNG) for off in range(24)]


# =========================================================================
# 3. 보행 그래프 사전 스냅(P3a1) — walking_graph 단계가 시설 좌표를 미리 스냅한다
# =========================================================================

def test_presnap_points_use_the_request_keys_and_skip_bad_rows():
    facilities = [
        _f(_LAT, _LNG),
        _f("35.84", "129.21"),          # 문자열 좌표 — 요청도 float() 로 같은 키를 만든다
        _f(None, _LNG),
        {"id": "no-coords"},
        _f("경주시 어딘가", _LNG),
        _f(float("nan"), _LNG),
        _f(_LAT, float("inf")),
    ]

    assert warmup_router._presnap_points(facilities) == [(_LAT, _LNG), (35.84, 129.21)]


@pytest.mark.asyncio
async def test_warmup_step_prewarms():
    """walking_graph 단계는 그래프를 올리는 데서 그치지 않고 시설 전체의 좌표를 사전 스냅에 넘긴다(가까운 24개가 아니라 전부)."""
    offsets = list(range(40))
    facilities = [_f(_LAT + off * 0.001, _LNG) for off in offsets] + [_f(None, _LNG)]
    captured: dict = {}

    async def _fake_facilities(**_kwargs):
        return facilities

    def _fake_prewarm(points):
        captured["points"] = list(points)
        return len(captured["points"])

    with patch("app.routers.recommendations.fetch_all_facilities", new=_fake_facilities), \
         patch("app.services.congestion_evidence.load_current_estimates", new=AsyncMock(return_value=None)), \
         patch("app.services.area_demand_forecast_service.prefetch_area_demand_points", new=AsyncMock(return_value=None)), \
         patch("app.services.event_boost.get_event_congestion_boost", new=AsyncMock(return_value=None)), \
         patch("app.services.parking_demand_service.get_nearby_parking_lots", new=AsyncMock(return_value=None)), \
         patch("app.services.weather_service.get_gyeongju_weather", new=AsyncMock(return_value=None)), \
         patch("app.services.spot.travel.prewarm_destinations", new=_fake_prewarm):
        await warmup_router._warm_all()

    assert captured["points"] == [(float(f["latitude"]), float(f["longitude"])) for f in facilities[:40]]


# =========================================================================
# 4. 부팅 사전 스냅 — csr 커널에서만(배치 B). memo·legacy 는 부팅에서 그래프를 올리지 않는다
# =========================================================================

def _quiet_lifespan(monkeypatch, facilities):
    """lifespan 의 예열이 네트워크로 나가지 않게(test_parking_history._quiet_warmup 과 같은 틀)."""
    from app.core import supabase as supabase_module
    from app.routers import recommendations
    from app.services import event_boost, parking_demand_service, predict_service, weather_service

    async def _none(*_args, **_kwargs):
        return None

    async def _no_lots(*_args, **_kwargs):
        return {"lots": [], "source": "test"}

    async def _facilities(*_args, **_kwargs):
        return facilities

    class _NoJwks:
        def get_jwk_set(self):
            raise RuntimeError("offline")

    monkeypatch.setattr(predict_service, "start_model_manager", _none)
    monkeypatch.setattr(predict_service, "stop_model_manager", _none)
    monkeypatch.setattr(predict_service, "get_model_info", lambda: {"trained": False})
    monkeypatch.setattr(supabase_module, "_get_jwks_client", lambda: _NoJwks())
    monkeypatch.setattr(recommendations, "fetch_all_facilities", _facilities)
    monkeypatch.setattr(parking_demand_service, "get_nearby_parking_lots", _no_lots)
    monkeypatch.setattr(weather_service, "get_gyeongju_weather", _none)
    monkeypatch.setattr(event_boost, "get_event_congestion_boost", _none)


@pytest.mark.parametrize(("kernel", "expect_presnap"), [("csr", True), ("memo", False), ("legacy", False)])
def test_boot_presnap_only_in_csr(monkeypatch, kernel, expect_presnap):
    import threading

    from fastapi.testclient import TestClient

    from app import main
    from app.services.spot import travel

    facilities = [_f(_LAT, _LNG), _f(_LAT + 0.001, _LNG), _f(None, _LNG)]
    _quiet_lifespan(monkeypatch, facilities)
    monkeypatch.setattr(travel, "_route_kernel", lambda: kernel)
    calls: list[list] = []
    done = threading.Event()

    def _fake_prewarm(points):
        calls.append(list(points))
        done.set()
        return len(calls[-1])

    monkeypatch.setattr(travel, "prewarm_destinations", _fake_prewarm)

    with TestClient(main.app) as client:
        assert client.get("/health").status_code == 200
        done.wait(timeout=5 if expect_presnap else 0.2)

    if expect_presnap:
        assert calls == [[(_LAT, _LNG), (_LAT + 0.001, _LNG)]]
    else:
        assert calls == []
