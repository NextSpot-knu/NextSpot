import gzip
import json

import pytest

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
