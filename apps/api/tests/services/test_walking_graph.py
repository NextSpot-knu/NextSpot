import gzip
import json
import random

import pytest

from app.core.config import settings
from app.services.spot import travel


@pytest.mark.asyncio
async def test_osm_graph_routes_around_barrier_instead_of_using_straight_line(tmp_path, monkeypatch):
    graph_path = tmp_path / "walking.json.gz"
    graph = {
        "metadata": {"source": "OpenStreetMap contributors"},
        "nodes": [
            [1, 35.8360, 129.2100],
            [2, 35.8360, 129.2110],
            [3, 35.8370, 129.2110],
        ],
        "edges": [[1, 2, 100], [2, 1, 100], [2, 3, 120], [3, 2, 120]],
    }
    with gzip.open(graph_path, "wt", encoding="utf-8") as target:
        json.dump(graph, target)
    monkeypatch.setattr(travel, "_GRAPH_PATH", graph_path)
    monkeypatch.setattr(travel, "_graph_cache", False)
    routes = await travel.get_walking_routes(35.8360, 129.2100, [(35.8370, 129.2110)])
    assert routes[0].source == "osm_pedestrian"
    assert routes[0].distance_m == pytest.approx(220, abs=3)


@pytest.mark.asyncio
async def test_graph_outside_snap_range_falls_back_without_failure(tmp_path, monkeypatch):
    graph_path = tmp_path / "walking.json.gz"
    with gzip.open(graph_path, "wt", encoding="utf-8") as target:
        json.dump({"nodes": [[1, 35.0, 129.0]], "edges": [], "metadata": {}}, target)
    monkeypatch.setattr(travel, "_GRAPH_PATH", graph_path)
    monkeypatch.setattr(travel, "_graph_cache", False)
    route = (await travel.get_walking_routes(35.836, 129.21, [(35.837, 129.211)]))[0]
    assert route.source == "estimated"


@pytest.mark.asyncio
async def test_ichinisanndo_to_pizzaok_matches_three_minute_walk():
    """사용자 제보 기준 경로: 실제 번들 보행망은 약 196m/2.9분이어야 한다."""
    travel._graph_cache = False
    route = (await travel.get_walking_routes(
        35.8363895617662,
        129.209288173926,
        [(35.8364227819948, 129.210812817078)],
    ))[0]
    assert route.source == "osm_pedestrian"
    assert route.distance_m == pytest.approx(196, abs=15)
    assert 2.7 <= route.duration_min <= 3.1


def test_route_search_does_not_block_the_event_loop(monkeypatch):
    """2026-09-26 01:21 KST 회귀: 경로 탐색이 이벤트 루프 위에서 동기로 돌면 그 동안 서버 전체
    (/account/me·/health 포함)가 멈춘다. 탐색이 스레드에서 도는 동안 다른 코루틴이 계속 돌아야 한다."""
    import asyncio
    import time

    from app.services.spot import travel

    graph = {
        "coordinates": {1: (35.8347, 129.2190), 2: (35.8360, 129.2105)},
        "adjacency": {1: [(2, 800.0)], 2: [(1, 800.0)]},
        "spatial_index": {},
        "metadata": {},
    }
    for node_id, (lat, lng) in graph["coordinates"].items():
        cell = (int(lat // travel._SPATIAL_CELL_DEGREES), int(lng // travel._SPATIAL_CELL_DEGREES))
        graph["spatial_index"].setdefault(cell, []).append(node_id)
    real_dijkstra = travel._dijkstra

    def slow_dijkstra(adjacency, start, targets):
        time.sleep(0.4)  # 28,832노드 전탐색의 대역
        return real_dijkstra(adjacency, start, targets)

    monkeypatch.setattr(travel, "_load_graph", lambda: graph)
    monkeypatch.setattr(travel, "_dijkstra", slow_dijkstra)

    async def run():
        ticks = 0
        stop = asyncio.Event()

        async def heartbeat():
            nonlocal ticks
            while not stop.is_set():
                ticks += 1
                await asyncio.sleep(0.02)

        beat = asyncio.create_task(heartbeat())
        routes = await travel.get_walking_routes(35.8347, 129.2190, [(35.8360, 129.2105)])
        stop.set()
        await beat
        return ticks, routes

    ticks, routes = asyncio.run(run())
    assert len(routes) == 1 and routes[0].source == "osm_pedestrian"
    # 0.4초 동안 루프가 살아 있었다면 20ms 박동이 여러 번 뛴다(막혔다면 1회 이하).
    assert ticks >= 5, f"이벤트 루프가 경로 탐색 동안 멈췄다(heartbeat {ticks}회)"


# =========================================================================
# P3a1 — 목적지 스냅 메모(WALKING_ROUTE_KERNEL = memo | legacy)
# =========================================================================
# memo 는 `_nearest_node` 의 기억값일 뿐이라 경로가 legacy(도입 전 코드 그대로)와 비트까지 같아야 한다.
# 메모는 그래프 객체에 달려 있어서, 주입·재적재된 그래프는 언제나 빈 메모로 시작한다.

_DEMO_CENTER = (35.8361, 129.2105)


@pytest.fixture(params=["legacy", "memo"])
def kernel(request, monkeypatch):
    monkeypatch.setattr(settings, "WALKING_ROUTE_KERNEL", request.param)
    return request.param


@pytest.fixture(scope="module")
def real_graph():
    """번들 보행망을 한 번만 올린다. 모듈 캐시는 원래 값으로 되돌린다(다른 테스트의 주입과 섞이지 않게)."""
    saved = travel._graph_cache
    travel._graph_cache = False
    try:
        graph = travel._load_graph()
    finally:
        travel._graph_cache = saved
    assert graph is not None
    return graph


def _fresh(graph: dict) -> dict:
    """같은 노드·간선을 공유하되 메모는 비어 있는 새 그래프 객체."""
    return {key: value for key, value in graph.items() if key != "_snap_memo"}


def _sample_points(graph: dict, n: int = 200, seed: int = 20260929) -> list[tuple[float, float]]:
    """실제 보행망 노드 좌표 주변의 시드 고정 표본 — 노드 위, 스냅 범위 안, 범위 밖(250m 초과), 그래프 밖이 섞인다."""
    rng = random.Random(seed)
    coords = [graph["coordinates"][node_id] for node_id in sorted(graph["coordinates"])]
    points: list[tuple[float, float]] = []
    for i in range(n):
        lat, lng = rng.choice(coords)
        if i % 10 == 0:
            points.append((lat, lng))
        elif i % 10 == 1:
            points.append((lat + 0.3, lng + 0.3))  # 그래프 밖(후보 셀이 비어 None)
        else:
            points.append((lat + rng.uniform(-0.004, 0.004), lng + rng.uniform(-0.004, 0.004)))
    return points


def _routes(monkeypatch, graph: dict, kernel_name: str, origin, destinations):
    monkeypatch.setattr(settings, "WALKING_ROUTE_KERNEL", kernel_name)
    monkeypatch.setattr(travel, "_load_graph", lambda: graph)
    return travel._walking_routes_sync(origin[0], origin[1], destinations)


@pytest.mark.asyncio
async def test_barrier_route_holds_in_each_kernel(kernel, tmp_path, monkeypatch):
    await test_osm_graph_routes_around_barrier_instead_of_using_straight_line(tmp_path, monkeypatch)


@pytest.mark.asyncio
async def test_out_of_snap_range_holds_in_each_kernel(kernel, tmp_path, monkeypatch):
    await test_graph_outside_snap_range_falls_back_without_failure(tmp_path, monkeypatch)


@pytest.mark.asyncio
async def test_ichinisanndo_to_pizzaok_holds_in_each_kernel(kernel):
    await test_ichinisanndo_to_pizzaok_matches_three_minute_walk()


def test_route_search_does_not_block_the_event_loop_in_each_kernel(kernel, monkeypatch):
    test_route_search_does_not_block_the_event_loop(monkeypatch)


@pytest.mark.parametrize(
    ("value", "expected"),
    [("memo", "memo"), ("legacy", "legacy"), (" Legacy ", "legacy"), ("", "memo"), ("unknown", "memo"),
     ("csr", "csr"), (" CSR ", "csr")],  # 배치 B 에서 csr 커널이 들어왔다(시험은 test_walking_csr.py).
)
def test_route_kernel_values(monkeypatch, value, expected):
    monkeypatch.setattr(settings, "WALKING_ROUTE_KERNEL", value)
    assert travel._route_kernel() == expected


def test_snap_memo_hit_equals_cold_nearest_node(real_graph, monkeypatch):
    """예열로 채운 메모 값 == 그 자리에서 다시 계산한 `_nearest_node`(None 포함), 경로도 메모 콜드·웜·legacy 가 같다."""
    points = _sample_points(real_graph)
    graph = _fresh(real_graph)
    monkeypatch.setattr(settings, "WALKING_ROUTE_KERNEL", "memo")
    monkeypatch.setattr(travel, "_load_graph", lambda: graph)
    assert travel.prewarm_destinations(points) == len(points)
    memo = graph["_snap_memo"]
    nones = 0
    for lat, lng in points:
        cold = travel._nearest_node(real_graph["coordinates"], real_graph["spatial_index"], lat, lng)
        assert memo[(lat, lng)] == cold
        nones += cold is None
    assert nones >= 10  # 그래프 밖 표본이 실제로 None 을 기억했다

    sources: dict[str, int] = {}
    for origin in [_DEMO_CENTER, (35.8363895617662, 129.209288173926), (35.8412, 129.2168)]:
        legacy = _routes(monkeypatch, _fresh(real_graph), "legacy", origin, points)
        cold_graph = _fresh(real_graph)
        cold = _routes(monkeypatch, cold_graph, "memo", origin, points)
        warm = _routes(monkeypatch, cold_graph, "memo", origin, points)
        assert cold == legacy and warm == legacy
        assert [repr(r) for r in warm] == [repr(r) for r in legacy]
        for route in legacy:
            sources[route.source] = sources.get(route.source, 0) + 1
    assert sources.get("osm_pedestrian", 0) >= 50 and sources.get("estimated", 0) >= 50


def test_snap_memo_is_per_graph(real_graph, tmp_path, monkeypatch):
    """실제 그래프 → 주입한 3노드 그래프 → 다시 실제 그래프. 앞 그래프의 노드 번호가 뒤 그래프로 새지 않는다."""
    graph_path = tmp_path / "tiny.json.gz"
    with gzip.open(graph_path, "wt", encoding="utf-8") as target:
        json.dump({
            "metadata": {},
            "nodes": [[1, 35.8360, 129.2100], [2, 35.8360, 129.2110], [3, 35.8370, 129.2110]],
            "edges": [[1, 2, 100], [2, 1, 100], [2, 3, 120], [3, 2, 120]],
        }, target)
    monkeypatch.setattr(travel, "_GRAPH_PATH", graph_path)
    monkeypatch.setattr(travel, "_graph_cache", False)
    tiny = travel._load_graph()
    assert tiny is not None

    origin = (35.8360, 129.2100)
    destinations = [(35.8370, 129.2110), (35.8361, 129.2105)]
    real = _fresh(real_graph)
    first = _routes(monkeypatch, real, "memo", origin, destinations)
    on_tiny = _routes(monkeypatch, tiny, "memo", origin, destinations)
    again = _routes(monkeypatch, real, "memo", origin, destinations)

    assert first == again == _routes(monkeypatch, _fresh(real_graph), "legacy", origin, destinations)
    assert on_tiny == _routes(monkeypatch, _fresh(tiny), "legacy", origin, destinations)
    assert on_tiny[0].source == "osm_pedestrian" and on_tiny[0].distance_m == pytest.approx(220, abs=3)
    assert {snap[0] for snap in tiny["_snap_memo"].values() if snap} <= {1, 2, 3}


def test_snap_memo_bounded():
    graph = {"coordinates": {1: (35.836, 129.21)}, "adjacency": {1: []}, "spatial_index": {}, "metadata": {}}
    for i in range(10_000):
        travel._snap_destination(graph, 35.0 + i * 1e-5, 129.0)
    assert 0 < len(graph["_snap_memo"]) <= travel._SNAP_MEMO_MAX
    assert (35.0 + 9_999 * 1e-5, 129.0) in graph["_snap_memo"]


def test_prewarm_uses_the_request_keys(real_graph, monkeypatch):
    """예열 키 == 추천이 경로를 물을 때 만드는 키(`recommendations.py` 의 `(float(lat), float(lng))`)."""
    from app.routers.warmup import _presnap_points

    rng = random.Random(7)
    rows = [
        {"latitude": _DEMO_CENTER[0] + rng.uniform(-0.01, 0.01), "longitude": _DEMO_CENTER[1] + rng.uniform(-0.01, 0.01)}
        for _ in range(40)
    ]
    rows.append({"latitude": "35.84", "longitude": "129.21"})  # 문자열로 온 좌표도 요청과 같은 float 키가 된다
    graph = _fresh(real_graph)
    monkeypatch.setattr(settings, "WALKING_ROUTE_KERNEL", "memo")
    monkeypatch.setattr(travel, "_load_graph", lambda: graph)
    travel.prewarm_destinations(_presnap_points(rows))
    request_keys = [(float(f["latitude"]), float(f["longitude"])) for f in rows]
    assert set(graph["_snap_memo"]) == set(request_keys)


def test_legacy_kernel_leaves_the_graph_untouched(real_graph, monkeypatch):
    graph = _fresh(real_graph)
    points = _sample_points(real_graph, n=20)
    monkeypatch.setattr(travel, "_load_graph", lambda: graph)
    monkeypatch.setattr(settings, "WALKING_ROUTE_KERNEL", "legacy")
    assert travel.prewarm_destinations(points) == 0
    travel._walking_routes_sync(_DEMO_CENTER[0], _DEMO_CENTER[1], points)
    assert "_snap_memo" not in graph


def test_prewarm_without_graph_is_a_no_op(monkeypatch):
    monkeypatch.setattr(settings, "WALKING_ROUTE_KERNEL", "memo")
    monkeypatch.setattr(travel, "_load_graph", lambda: None)
    assert travel.prewarm_destinations([(35.8361, 129.2105)]) == 0
