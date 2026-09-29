"""P3 배치 B — 압축 보행 그래프(csr 커널). 결과가 legacy·memo 와 비트까지 같은지, 커밋된 이진이 원본과 맞는지."""
import asyncio
import gzip
import json
import random
import time

import pytest

from app.core.config import settings
from app.services.spot import travel, walking_csr

_DEMO_CENTER = (35.8361, 129.2105)
_TINY = {
    "metadata": {},
    "nodes": [[1, 35.8360, 129.2100], [2, 35.8360, 129.2110], [3, 35.8370, 129.2110]],
    "edges": [[1, 2, 100], [2, 1, 100], [2, 3, 120], [3, 2, 120]],
}


@pytest.fixture(autouse=True)
def _isolated_caches(monkeypatch):
    """모듈 캐시를 시험마다 원래 값으로 되돌린다(다른 시험의 주입·적재와 섞이지 않게)."""
    monkeypatch.setattr(travel, "_csr_cache", False)
    monkeypatch.setattr(travel, "_graph_cache", False)


@pytest.fixture(scope="module")
def real_dict_graph():
    saved = travel._graph_cache
    travel._graph_cache = False
    try:
        graph = travel._load_graph()
    finally:
        travel._graph_cache = saved
    assert graph is not None
    return graph


@pytest.fixture(scope="module")
def real_csr():
    saved = travel._csr_cache
    travel._csr_cache = False
    try:
        graph = travel._load_csr()
    finally:
        travel._csr_cache = saved
    assert graph is not None
    return graph


def _write_graph(path, graph: dict) -> None:
    with gzip.open(path, "wt", encoding="utf-8") as target:
        json.dump(graph, target)


def _sample_points(coords: list[tuple[float, float]], n: int, seed: int) -> list[tuple[float, float]]:
    """노드 위 · 스냅 범위 안 · 범위 밖(250m 초과) · 그래프 밖이 섞인 시드 고정 표본."""
    rng = random.Random(seed)
    points: list[tuple[float, float]] = []
    for i in range(n):
        lat, lng = rng.choice(coords)
        if i % 10 == 0:
            points.append((lat, lng))
        elif i % 10 == 1:
            points.append((lat + 0.3, lng + 0.3))
        elif i % 10 == 2:
            points.append((lat + rng.uniform(-0.004, 0.004), lng + rng.uniform(-0.004, 0.004)))
        else:
            points.append((lat + rng.uniform(-0.0015, 0.0015), lng + rng.uniform(-0.0015, 0.0015)))
    return points


# ---------------------------------------------------------------- 이진 파일


def test_committed_csr_matches_the_committed_graph():
    """커밋된 `.csr.bin` = 커밋된 원본 .json.gz 에서 새로 만든 바이트. 원본만 바꾸고 이진을 안 만들면 여기서 깨진다
    (`py -3.11 scripts/build_walking_graph.py --emit-csr`)."""
    source = travel._GRAPH_PATH.read_bytes()
    raw = json.loads(gzip.decompress(source).decode("utf-8"))
    rebuilt = walking_csr.to_bytes(walking_csr.build_from_raw(raw, walking_csr.source_digest(source)))
    assert travel._csr_path().read_bytes() == rebuilt


def test_bytes_round_trip(real_csr):
    again = walking_csr.from_bytes(walking_csr.to_bytes(real_csr), real_csr.source_sha256)
    for name in ("lat", "lng", "indptr", "indices", "weights", "component"):
        assert getattr(again, name) == getattr(real_csr, name), name
    assert again.cells.keys() == real_csr.cells.keys()
    assert all(again.cells[key] == real_csr.cells[key] for key in real_csr.cells)


def test_from_bytes_rejects_other_source_truncation_and_magic(real_csr):
    data = walking_csr.to_bytes(real_csr)
    with pytest.raises(ValueError, match="different walking graph"):
        walking_csr.from_bytes(data, b"\0" * 32)
    with pytest.raises(ValueError, match="size"):
        walking_csr.from_bytes(data[:-2], real_csr.source_sha256)
    with pytest.raises(ValueError, match="magic"):
        walking_csr.from_bytes(b"XXXX" + data[4:], real_csr.source_sha256)
    with pytest.raises(ValueError, match="short"):
        walking_csr.from_bytes(b"NS", None)


def test_build_rejects_weights_it_cannot_hold_exactly():
    base = {"nodes": [[1, 35.0, 129.0], [2, 35.0, 129.001]]}
    for bad in (0, 1.5, 70_000):
        with pytest.raises(ValueError):
            walking_csr.build_from_raw({**base, "edges": [[1, 2, bad]]}, b"\0" * 32)


def test_formulas_match_travel():
    assert walking_csr.SPATIAL_CELL_DEGREES == travel._SPATIAL_CELL_DEGREES
    rng = random.Random(3)
    for _ in range(2_000):
        a = (35.8 + rng.random() * 0.08, 129.17 + rng.random() * 0.08)
        b = (a[0] + rng.uniform(-0.01, 0.01), a[1] + rng.uniform(-0.01, 0.01))
        assert walking_csr.haversine_m(*a, *b) == travel.calculate_haversine_distance(*a, *b)


# ---------------------------------------------------------------- 같은 답


def test_nearest_node_matches_dict_graph(real_dict_graph, real_csr):
    """같은 노드(원본 id 로 되돌려 비교)·같은 거리, None 도 같다 — 0.1m 반올림 동률에서 고르는 노드까지."""
    ids = [node_id for node_id in real_dict_graph["coordinates"]]  # 원본 순서 = csr 번호
    coords = [real_dict_graph["coordinates"][node_id] for node_id in ids]
    nones = 0
    for lat, lng in _sample_points(coords, 600, seed=11):
        cold = travel._nearest_node(real_dict_graph["coordinates"], real_dict_graph["spatial_index"], lat, lng)
        snap = walking_csr.nearest_node(real_csr, lat, lng)
        assert (snap and (ids[snap[0]], snap[1])) == cold
        nones += cold is None
    assert nones >= 30


def test_routes_are_bit_identical_to_legacy_and_memo(real_dict_graph, monkeypatch):
    """출발 12곳 × 목적지 300곳. legacy(도입 전 코드)·memo·csr 콜드·csr 웜이 repr 까지 같다."""
    coords = [real_dict_graph["coordinates"][node_id] for node_id in real_dict_graph["coordinates"]]
    destinations = _sample_points(coords, 300, seed=20260930)
    origins = [_DEMO_CENTER, (35.8363895617662, 129.209288173926), *_sample_points(coords, 10, seed=5)]
    monkeypatch.setattr(travel, "_load_graph", lambda: real_dict_graph)
    sources: dict[str, int] = {}
    for origin in origins:
        results = {}
        for kernel in ("legacy", "memo", "csr", "csr-warm"):
            monkeypatch.setattr(settings, "WALKING_ROUTE_KERNEL", kernel.split("-")[0])
            results[kernel] = [repr(r) for r in travel._walking_routes_sync(origin[0], origin[1], destinations)]
        assert results["memo"] == results["legacy"]
        assert results["csr"] == results["legacy"]
        assert results["csr-warm"] == results["legacy"]
        for line in results["legacy"]:
            key = "osm" if "osm_pedestrian" in line else "estimated"
            sources[key] = sources.get(key, 0) + 1
    assert sources["osm"] >= 1_000 and sources["estimated"] >= 300


def test_component_filter_matches_full_search(real_dict_graph, real_csr):
    """다른 연결 요소의 목적지를 미리 빼도 전탐색(travel._dijkstra)과 같은 거리. 작은 요소 안의 출발도 포함."""
    ids = list(real_dict_graph["coordinates"])
    component = real_csr.component
    small = [i for i in range(real_csr.node_count) if component[i] != component[0] or False]
    by_component: dict[int, list[int]] = {}
    for index in range(real_csr.node_count):
        by_component.setdefault(component[index], []).append(index)
    assert len(by_component) >= 2
    rng = random.Random(9)
    starts = [rng.randrange(real_csr.node_count) for _ in range(6)]
    starts += [members[0] for members in by_component.values() if len(members) < 1_000][:3]
    targets = set(rng.sample(range(real_csr.node_count), 200)) | set(small[:20])
    for start in starts:
        full = travel._dijkstra(real_dict_graph["adjacency"], ids[start], {ids[t] for t in targets})
        mine = walking_csr.shortest_distances(real_csr, start, targets)
        assert {ids[node]: distance for node, distance in mine.items()} == full


# ---------------------------------------------------------------- 공개 경로(csr 커널)


@pytest.mark.asyncio
async def test_csr_kernel_routes_around_a_barrier_from_a_json_only_graph(tmp_path, monkeypatch):
    """이진 파일이 없는 원본(시험용 3노드) — 원본에서 만들어 같은 답."""
    graph_path = tmp_path / "walking.json.gz"
    _write_graph(graph_path, _TINY)
    monkeypatch.setattr(travel, "_GRAPH_PATH", graph_path)
    monkeypatch.setattr(settings, "WALKING_ROUTE_KERNEL", "csr")
    routes = await travel.get_walking_routes(35.8360, 129.2100, [(35.8370, 129.2110)])
    assert routes[0].source == "osm_pedestrian"
    assert routes[0].distance_m == pytest.approx(220, abs=3)
    assert isinstance(travel._csr_cache, walking_csr.CsrGraph)
    assert travel._graph_cache is False  # dict 그래프는 올리지 않았다


@pytest.mark.asyncio
async def test_csr_kernel_out_of_snap_range_falls_back(tmp_path, monkeypatch):
    graph_path = tmp_path / "walking.json.gz"
    _write_graph(graph_path, {"nodes": [[1, 35.0, 129.0]], "edges": [], "metadata": {}})
    monkeypatch.setattr(travel, "_GRAPH_PATH", graph_path)
    monkeypatch.setattr(settings, "WALKING_ROUTE_KERNEL", "csr")
    route = (await travel.get_walking_routes(35.836, 129.21, [(35.837, 129.211)]))[0]
    assert route.source == "estimated"


@pytest.mark.asyncio
async def test_csr_kernel_ichinisanndo_to_pizzaok(monkeypatch):
    monkeypatch.setattr(settings, "WALKING_ROUTE_KERNEL", "csr")
    route = (await travel.get_walking_routes(
        35.8363895617662, 129.209288173926, [(35.8364227819948, 129.210812817078)],
    ))[0]
    assert route.source == "osm_pedestrian"
    assert route.distance_m == pytest.approx(196, abs=15)
    assert 2.7 <= route.duration_min <= 3.1
    assert travel._graph_cache is False


def test_stale_or_corrupt_bin_is_ignored_and_rebuilt_from_json(tmp_path, monkeypatch):
    """원본과 해시가 다른 이진·깨진 이진은 쓰지 않는다 — 원본에서 만들고 답은 같다."""
    graph_path = tmp_path / "walking.json.gz"
    _write_graph(graph_path, _TINY)
    monkeypatch.setattr(travel, "_GRAPH_PATH", graph_path)
    monkeypatch.setattr(settings, "WALKING_ROUTE_KERNEL", "csr")
    other = walking_csr.build_from_raw(_TINY, b"\1" * 32)  # 다른 원본에서 만든 척
    for payload in (walking_csr.to_bytes(other), b"NSWG garbage"):
        travel._csr_path().write_bytes(payload)
        monkeypatch.setattr(travel, "_csr_cache", False)
        graph = travel._load_csr()
        assert graph is not None
        assert graph.source_sha256 == walking_csr.source_digest(graph_path.read_bytes())
        route = travel._walking_routes_sync(35.8360, 129.2100, [(35.8370, 129.2110)])[0]
        assert route.source == "osm_pedestrian" and route.distance_m == pytest.approx(220, abs=3)


def test_csr_load_failure_falls_back_to_the_memo_path(tmp_path, monkeypatch):
    """원본을 못 읽으면 csr 은 None 으로 굳고, 요청은 dict 그래프(memo 경로)로 같은 판정을 낸다."""
    monkeypatch.setattr(travel, "_GRAPH_PATH", tmp_path / "missing.json.gz")
    monkeypatch.setattr(settings, "WALKING_ROUTE_KERNEL", "csr")
    assert travel._load_csr() is None
    assert travel._csr_cache is None
    graph = {
        "coordinates": {1: (35.8360, 129.2100), 2: (35.8370, 129.2110)},
        "adjacency": {1: [(2, 150.0)], 2: [(1, 150.0)]},
        "spatial_index": {},
        "metadata": {},
    }
    for node_id, (lat, lng) in graph["coordinates"].items():
        cell = (int(lat // travel._SPATIAL_CELL_DEGREES), int(lng // travel._SPATIAL_CELL_DEGREES))
        graph["spatial_index"].setdefault(cell, []).append(node_id)
    monkeypatch.setattr(travel, "_load_graph", lambda: graph)
    route = travel._walking_routes_sync(35.8360, 129.2100, [(35.8370, 129.2110)])[0]
    assert route.source == "osm_pedestrian" and route.distance_m == pytest.approx(150, abs=1)
    assert "_snap_memo" in graph  # memo 경로가 돌았다


def test_csr_route_search_does_not_block_the_event_loop(monkeypatch):
    monkeypatch.setattr(settings, "WALKING_ROUTE_KERNEL", "csr")
    real = walking_csr.shortest_distances

    def slow(graph, start, targets):
        time.sleep(0.4)
        return real(graph, start, targets)

    monkeypatch.setattr(walking_csr, "shortest_distances", slow)

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
    assert len(routes) == 1
    assert ticks >= 5, f"이벤트 루프가 경로 탐색 동안 멈췄다(heartbeat {ticks}회)"


# ---------------------------------------------------------------- 예열·부팅


def test_prewarm_fills_the_csr_memo_with_request_keys_and_skips_the_dict_graph(monkeypatch):
    from app.routers.warmup import _presnap_points

    monkeypatch.setattr(settings, "WALKING_ROUTE_KERNEL", "csr")
    rng = random.Random(7)
    rows = [
        {"latitude": _DEMO_CENTER[0] + rng.uniform(-0.01, 0.01), "longitude": _DEMO_CENTER[1] + rng.uniform(-0.01, 0.01)}
        for _ in range(40)
    ]
    rows.append({"latitude": "35.84", "longitude": "129.21"})
    assert travel.prewarm_destinations(_presnap_points(rows)) == len(rows)
    csr = travel._csr_cache
    assert isinstance(csr, walking_csr.CsrGraph)
    assert set(csr.snap_memo) == {(float(f["latitude"]), float(f["longitude"])) for f in rows}
    for (lat, lng), snap in csr.snap_memo.items():
        assert snap == walking_csr.nearest_node(csr, lat, lng)
    assert travel._graph_cache is False


def test_csr_snap_memo_bounded(real_csr):
    graph = walking_csr.CsrGraph(
        real_csr.lat, real_csr.lng, real_csr.indptr, real_csr.indices, real_csr.weights,
        real_csr.component, real_csr.source_sha256, real_csr.cells,
    )
    for i in range(10_000):
        travel._snap_destination_csr(graph, 35.0 + i * 1e-5, 129.0)
    assert 0 < len(graph.snap_memo) <= travel._SNAP_MEMO_MAX


def test_boot_presnap_runs_only_for_csr(monkeypatch):
    from app import main

    calls: list[int] = []
    monkeypatch.setattr(travel, "prewarm_destinations", lambda points: calls.append(len(points)) or len(points))
    rows = [{"latitude": 35.836, "longitude": 129.21}, {"latitude": 35.837, "longitude": 129.211}]

    async def run(kernel: str):
        monkeypatch.setattr(settings, "WALKING_ROUTE_KERNEL", kernel)
        task = main._start_boot_presnap(rows)
        if task is not None:
            await task
        return task

    assert asyncio.run(run("memo")) is None
    assert asyncio.run(run("legacy")) is None
    assert calls == []
    assert asyncio.run(run("csr")) is not None
    assert calls == [2]
