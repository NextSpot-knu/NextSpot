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
