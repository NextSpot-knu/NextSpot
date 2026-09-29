"""키 없는 경주 보행로 경로와 범위 밖의 보수적 직선거리 폴백."""
import asyncio
import gzip
import heapq
import json
import math
import threading
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import structlog

from app.services.spot import walking_csr

logger = structlog.get_logger()

WALKING_SPEED_M_PER_MIN = 66.67
FALLBACK_ROUTE_FACTOR = 1.18
MAX_GRAPH_SNAP_M = 250.0
_SPATIAL_CELL_DEGREES = 0.002
_GRAPH_PATH = Path(__file__).resolve().parents[2] / "data/gyeongju_walking_graph.json.gz"
_graph_cache: dict[str, Any] | None | bool = False
# 그래프 적재(15.9MB, 수 초)를 스레드 여럿이 동시에 시작하지 않게 — 콜드 스타트에 추천·코스가 겹치면
# 각자 적재해 메모리가 두 배로 튀었다. 적재가 끝난 뒤의 조회는 잠금 없이 읽는다(아래 빠른 경로).
_graph_lock = threading.Lock()
# 목적지 스냅 메모 상한. 시설 1,682곳이면 ~0.25MB, 상한에 차도 ~1.2MB 이고, 넘으면 통째로 비운다.
_SNAP_MEMO_MAX = 8192
_MISS = object()
# csr 커널(P3 배치 B)의 그래프. False = 아직 안 읽음, None = 읽기 실패(그때 요청은 memo 경로로 돈다).
_csr_cache: walking_csr.CsrGraph | None | bool = False


@dataclass(frozen=True)
class WalkingRoute:
    duration_min: float
    distance_m: float
    source: str

def calculate_haversine_distance(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r_lat1, r_lng1, r_lat2, r_lng2 = map(math.radians, [lat1, lng1, lat2, lng2])
    
    d_lat = r_lat2 - r_lat1
    d_lng = r_lng2 - r_lng1
    
    a = math.sin(d_lat / 2)**2 + math.cos(r_lat1) * math.cos(r_lat2) * math.sin(d_lng / 2)**2
    c = 2 * math.asin(min(1.0, math.sqrt(a)))
    
    distance = 6371000 * c
    return round(distance, 1)


def estimate_walking_route(start_lat: float, start_lng: float, end_lat: float, end_lng: float) -> WalkingRoute:
    straight = calculate_haversine_distance(start_lat, start_lng, end_lat, end_lng)
    distance = straight * FALLBACK_ROUTE_FACTOR
    return WalkingRoute(round(distance / WALKING_SPEED_M_PER_MIN, 1), round(distance, 1), "estimated")


def _load_graph() -> dict[str, Any] | None:
    if _graph_cache is not False:
        return _graph_cache if isinstance(_graph_cache, dict) else None
    with _graph_lock:
        return _load_graph_locked()


def _load_graph_locked() -> dict[str, Any] | None:
    global _graph_cache
    if _graph_cache is not False:  # 기다리는 동안 다른 스레드가 적재를 끝냈다
        return _graph_cache if isinstance(_graph_cache, dict) else None
    try:
        with gzip.open(_GRAPH_PATH, "rt", encoding="utf-8") as source:
            raw = json.load(source)
        coordinates = {
            int(node_id): (float(lat), float(lng)) for node_id, lat, lng in raw["nodes"]
        }
        adjacency: dict[int, list[tuple[int, float]]] = {node_id: [] for node_id in coordinates}
        spatial_index: dict[tuple[int, int], list[int]] = {}
        for node_id, (latitude, longitude) in coordinates.items():
            cell = (
                math.floor(latitude / _SPATIAL_CELL_DEGREES),
                math.floor(longitude / _SPATIAL_CELL_DEGREES),
            )
            spatial_index.setdefault(cell, []).append(node_id)
        for start, end, meters in raw["edges"]:
            if int(start) in adjacency and int(end) in coordinates:
                adjacency[int(start)].append((int(end), float(meters)))
        _graph_cache = {
            "coordinates": coordinates,
            "adjacency": adjacency,
            "spatial_index": spatial_index,
            "metadata": raw.get("metadata") or {},
        }
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        _graph_cache = None
    return _graph_cache if isinstance(_graph_cache, dict) else None


def _nearest_node(
    coordinates: dict[int, tuple[float, float]],
    spatial_index: dict[tuple[int, int], list[int]],
    latitude: float,
    longitude: float,
) -> tuple[int, float] | None:
    nearest: tuple[int, float] | None = None
    center = (
        math.floor(latitude / _SPATIAL_CELL_DEGREES),
        math.floor(longitude / _SPATIAL_CELL_DEGREES),
    )
    candidates = [
        node_id
        for lat_offset in range(-2, 3)
        for lng_offset in range(-2, 3)
        for node_id in spatial_index.get(
            (center[0] + lat_offset, center[1] + lng_offset), []
        )
    ]
    for node_id in candidates:
        node_lat, node_lng = coordinates[node_id]
        meters = calculate_haversine_distance(latitude, longitude, node_lat, node_lng)
        if nearest is None or meters < nearest[1]:
            nearest = node_id, meters
    return nearest


def _route_kernel() -> str:
    """WALKING_ROUTE_KERNEL 의 실효 값. 앞뒤 공백·대소문자는 무시하고, 'legacy' 는 도입 전 코드 그대로,
    'csr' 은 압축 그래프(walking_csr — dict 그래프를 아예 올리지 않는다), 그 밖의 값은 전부 memo.

    설정은 여기서 늦게 읽는다 — 거리 함수만 쓰는 배치·스크립트가 이 모듈을 import 할 때 앱 설정(필수 시크릿)을
    끌고 오지 않게 한다."""
    from app.core.config import settings

    value = str(getattr(settings, "WALKING_ROUTE_KERNEL", "memo")).strip().lower()
    return value if value in ("legacy", "csr") else "memo"


def _csr_path() -> Path:
    """원본 옆의 이진 파일. 원본 경로(시험이 바꿔 끼우는 `_GRAPH_PATH`)에서 매번 만든다."""
    name = _GRAPH_PATH.name
    stem = name[: -len(".json.gz")] if name.endswith(".json.gz") else name
    return _GRAPH_PATH.with_name(stem + ".csr.bin")


def _load_csr() -> walking_csr.CsrGraph | None:
    if _csr_cache is not False:
        return _csr_cache if isinstance(_csr_cache, walking_csr.CsrGraph) else None
    # dict 그래프와 같은 잠금 — 두 그래프 적재가 동시에 돌아 피크가 겹치지 않게.
    with _graph_lock:
        return _load_csr_locked()


def _load_csr_locked() -> walking_csr.CsrGraph | None:
    """커밋된 이진(`*.csr.bin`, 원본 sha256 이 맞을 때만)을 읽고, 없거나 어긋나면 원본 JSON 에서 만든다.
    둘 다 안 되면 None — 요청은 memo 경로(dict 그래프)로 돈다. 결과는 어느 쪽이든 같다."""
    global _csr_cache
    if _csr_cache is not False:
        return _csr_cache if isinstance(_csr_cache, walking_csr.CsrGraph) else None
    started = time.perf_counter()
    try:
        source = _GRAPH_PATH.read_bytes()
        digest = walking_csr.source_digest(source)
        origin = "bin"
        try:
            graph = walking_csr.from_bytes(_csr_path().read_bytes(), digest)
        except Exception as exc:  # noqa: BLE001 — 이진이 어떻게 깨졌든(OverflowError 포함) 원본에서 다시 만든다
            logger.warning(
                "walking_graph_csr_bin_unusable", error_type=type(exc).__name__, error=str(exc)[:200]
            )
            raw = json.loads(gzip.decompress(source).decode("utf-8"))
            graph = walking_csr.build_from_raw(raw, digest)
            del raw
            origin = "json"
        _csr_cache = graph
        logger.info(
            "walking_graph_csr_loaded",
            origin=origin,
            nodes=graph.node_count,
            edges=len(graph.indices),
            elapsed_ms=round((time.perf_counter() - started) * 1000),
        )
    except Exception as exc:  # noqa: BLE001 — csr 을 못 쓰면 None 으로 굳히고 요청은 memo 경로(dict 그래프)로 돈다
        _csr_cache = None
        logger.warning("walking_graph_csr_load_failed", error_type=type(exc).__name__, error=str(exc)[:200])
    return _csr_cache if isinstance(_csr_cache, walking_csr.CsrGraph) else None


def _snap_destination_csr(graph: walking_csr.CsrGraph, latitude: float, longitude: float) -> tuple[int, float] | None:
    """`_snap_destination` 의 csr 판 — 메모는 그래프 객체에 달리고, 값은 같은 키의 `nearest_node` 그대로."""
    memo = graph.snap_memo
    key = (latitude, longitude)
    hit = memo.get(key, _MISS)
    if hit is not _MISS:
        return hit
    snap = walking_csr.nearest_node(graph, latitude, longitude)
    if len(memo) >= _SNAP_MEMO_MAX:
        memo.clear()
    memo[key] = snap
    return snap


def _snap_memo_of(graph: dict[str, Any]) -> dict:
    """그래프 객체에 붙은 목적지 스냅 메모. 모듈 전역이 아니라 **그래프에** 달려 있으므로 새로 적재·주입·
    교체된 그래프는 언제나 빈 메모로 시작한다(비울 곳이 따로 없다). setdefault — 두 스레드가 동시에 만들어도
    같은 dict 하나로 끝난다."""
    memo = graph.get("_snap_memo")
    if memo is None:
        memo = graph.setdefault("_snap_memo", {})
    return memo


def _snap_destination(graph: dict[str, Any], latitude: float, longitude: float) -> tuple[int, float] | None:
    """`_nearest_node` 의 메모. 그래프는 프로세스 동안 바뀌지 않으니 적중 값이 낡을 수 없고, 저장하는 값은
    같은 키로 계산한 `_nearest_node` 의 반환 그대로다(None 포함). 경합은 GIL 아래 dict get/set 이라
    최악이어도 두 스레드가 같은 튜플을 한 번씩 계산할 뿐이다."""
    memo = _snap_memo_of(graph)
    key = (latitude, longitude)
    hit = memo.get(key, _MISS)
    if hit is not _MISS:
        return hit
    snap = _nearest_node(graph["coordinates"], graph["spatial_index"], latitude, longitude)
    if len(memo) >= _SNAP_MEMO_MAX:
        memo.clear()
    memo[key] = snap
    return snap


def prewarm_destinations(points: Iterable[tuple[float, float]]) -> int:
    """시설 좌표를 미리 스냅해 둔다(동기 — 워커 스레드에서 부른다). 예열 뒤 첫 by-type·추천·코스가 스냅
    비용(Render 기준 호출마다 ~0.7-1.5초)을 물지 않게 한다. 키는 요청이 쓰는 것과 같은 `(float(lat), float(lng))`.
    그래프가 없거나 legacy 면 아무것도 하지 않고 0. csr 은 압축 그래프의 메모를 채운다. csr 을 못 읽었으면 0 —
    예열 때문에 dict 그래프(적재 피크 27MB)를 올리지 않는다(부팅 훅에서 불리면 다른 부팅 적재와 겹친다, OOM 이력).
    그때 요청은 memo 경로로 돌며 목적지를 그 자리에서 스냅해 기억한다(P3a 이전 첫 요청과 같은 속도)."""
    kernel = _route_kernel()
    if kernel == "csr":
        csr = _load_csr()
        if csr is None:
            logger.warning("walking_graph_presnap_skipped", kernel=kernel, reason="csr_unavailable")
            return 0
        started = time.perf_counter()
        count = 0
        for latitude, longitude in points:
            _snap_destination_csr(csr, latitude, longitude)
            count += 1
        logger.info(
            "walking_graph_presnap",
            count=count,
            elapsed_ms=round((time.perf_counter() - started) * 1000),
            kernel=kernel,
        )
        return count
    graph = _load_graph()
    if not graph or kernel == "legacy":
        return 0
    started = time.perf_counter()
    count = 0
    for latitude, longitude in points:
        _snap_destination(graph, latitude, longitude)
        count += 1
    logger.info(
        "walking_graph_presnap",
        count=count,
        elapsed_ms=round((time.perf_counter() - started) * 1000),
        kernel=kernel,
    )
    return count


def _dijkstra(
    adjacency: dict[int, list[tuple[int, float]]], start: int, targets: set[int]
) -> dict[int, float]:
    distances = {start: 0.0}
    queue: list[tuple[float, int]] = [(0.0, start)]
    remaining = set(targets)
    found: dict[int, float] = {}
    while queue and remaining:
        distance, node = heapq.heappop(queue)
        if distance != distances.get(node):
            continue
        if node in remaining:
            found[node] = distance
            remaining.remove(node)
        for neighbor, edge_distance in adjacency.get(node, []):
            candidate = distance + edge_distance
            if candidate < distances.get(neighbor, math.inf):
                distances[neighbor] = candidate
                heapq.heappush(queue, (candidate, neighbor))
    return found


async def get_walking_routes(
    start_lat: float, start_lng: float, destinations: list[tuple[float, float]]
) -> list[WalkingRoute]:
    """경주 중심은 OSM 보행로 최단경로, 그래프 밖·스냅 실패는 정직한 추정으로 반환한다.

    계산(그래프 적재 + 28,832노드 Dijkstra)은 **이벤트 루프 밖**(스레드)에서 돈다. 예전에는 async 함수
    안에서 동기로 돌아, 코스·추천 하나가 계산하는 동안 서버 전체가 멈췄다 — /account/me·관리자 조회·
    /health 까지. 2026-09-26 01:21 KST 운영: 코스 계산 23초 동안 /account/me 가 프런트 10초 타임아웃에
    걸려 관제 콘솔이 로그인으로 튕겼고, 09-22 의 헬스체크 타임아웃 재시작도 같은 병으로 본다.
    결과는 같다 — 실행 위치만 바뀐다.
    """
    return await asyncio.to_thread(_walking_routes_sync, start_lat, start_lng, destinations)


def _walking_routes_sync(
    start_lat: float, start_lng: float, destinations: list[tuple[float, float]]
) -> list[WalkingRoute]:
    fallbacks = [estimate_walking_route(start_lat, start_lng, lat, lng) for lat, lng in destinations]
    if _route_kernel() == "csr":
        csr = _load_csr()
        if csr is not None:
            return _walking_routes_csr(csr, fallbacks, start_lat, start_lng, destinations)
        # 압축 그래프를 못 읽었다 — 아래 memo 경로(dict 그래프)로 같은 답을 낸다.
    graph = _load_graph()
    if not graph or not destinations:
        return fallbacks
    coordinates = graph["coordinates"]
    spatial_index = graph["spatial_index"]
    start_snap = _nearest_node(coordinates, spatial_index, start_lat, start_lng)
    if start_snap is None or start_snap[1] > MAX_GRAPH_SNAP_M:
        return fallbacks
    # 출발점 스냅은 메모하지 않는다(사용자 위치는 끝이 없고 호출마다 하나뿐). 목적지는 시설 좌표라 되풀이된다.
    if _route_kernel() == "legacy":
        destination_snaps = [
            _nearest_node(coordinates, spatial_index, latitude, longitude)
            for latitude, longitude in destinations
        ]
    else:
        destination_snaps = [
            _snap_destination(graph, latitude, longitude)
            for latitude, longitude in destinations
        ]
    valid_targets = {
        snap[0] for snap in destination_snaps if snap is not None and snap[1] <= MAX_GRAPH_SNAP_M
    }
    graph_distances = _dijkstra(graph["adjacency"], start_snap[0], valid_targets)
    routes: list[WalkingRoute] = []
    for fallback, snap in zip(fallbacks, destination_snaps):
        if snap is None or snap[1] > MAX_GRAPH_SNAP_M or snap[0] not in graph_distances:
            routes.append(fallback)
            continue
        distance = start_snap[1] + graph_distances[snap[0]] + snap[1]
        # 잘못 끊긴 그래프가 직선 폴백보다 짧아지는 경우는 경로 근거로 승격하지 않는다.
        straight = calculate_haversine_distance(
            start_lat, start_lng,
            coordinates[snap[0]][0], coordinates[snap[0]][1],
        )
        if distance + 1 < straight:
            routes.append(fallback)
            continue
        routes.append(WalkingRoute(
            round(distance / WALKING_SPEED_M_PER_MIN, 1), round(distance, 1), "osm_pedestrian"
        ))
    return routes


def _walking_routes_csr(
    graph: walking_csr.CsrGraph,
    fallbacks: list[WalkingRoute],
    start_lat: float,
    start_lng: float,
    destinations: list[tuple[float, float]],
) -> list[WalkingRoute]:
    """`_walking_routes_sync` 의 memo 경로와 같은 판정·같은 식 — 그래프 표현만 다르다."""
    if not destinations:
        return fallbacks
    start_snap = walking_csr.nearest_node(graph, start_lat, start_lng)
    if start_snap is None or start_snap[1] > MAX_GRAPH_SNAP_M:
        return fallbacks
    destination_snaps = [
        _snap_destination_csr(graph, latitude, longitude) for latitude, longitude in destinations
    ]
    valid_targets = {
        snap[0] for snap in destination_snaps if snap is not None and snap[1] <= MAX_GRAPH_SNAP_M
    }
    graph_distances = walking_csr.shortest_distances(graph, start_snap[0], valid_targets)
    routes: list[WalkingRoute] = []
    for fallback, snap in zip(fallbacks, destination_snaps):
        if snap is None or snap[1] > MAX_GRAPH_SNAP_M or snap[0] not in graph_distances:
            routes.append(fallback)
            continue
        distance = start_snap[1] + graph_distances[snap[0]] + snap[1]
        straight = calculate_haversine_distance(
            start_lat, start_lng, graph.lat[snap[0]], graph.lng[snap[0]],
        )
        if distance + 1 < straight:
            routes.append(fallback)
            continue
        routes.append(WalkingRoute(
            round(distance / WALKING_SPEED_M_PER_MIN, 1), round(distance, 1), "osm_pedestrian"
        ))
    return routes


async def get_travel_time_and_distance(
    start_lat: float, start_lng: float,
    end_lat: float, end_lng: float
) -> tuple[float, float]:
    route = (await get_walking_routes(start_lat, start_lng, [(end_lat, end_lng)]))[0]
    return route.duration_min, route.distance_m
