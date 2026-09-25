"""키 없는 경주 보행로 경로와 범위 밖의 보수적 직선거리 폴백."""
import asyncio
import gzip
import heapq
import json
import math
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

WALKING_SPEED_M_PER_MIN = 66.67
FALLBACK_ROUTE_FACTOR = 1.18
MAX_GRAPH_SNAP_M = 250.0
_SPATIAL_CELL_DEGREES = 0.002
_GRAPH_PATH = Path(__file__).resolve().parents[2] / "data/gyeongju_walking_graph.json.gz"
_graph_cache: dict[str, Any] | None | bool = False
# 그래프 적재(15.9MB, 수 초)를 스레드 여럿이 동시에 시작하지 않게 — 콜드 스타트에 추천·코스가 겹치면
# 각자 적재해 메모리가 두 배로 튀었다. 적재가 끝난 뒤의 조회는 잠금 없이 읽는다(아래 빠른 경로).
_graph_lock = threading.Lock()


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
    graph = _load_graph()
    if not graph or not destinations:
        return fallbacks
    coordinates = graph["coordinates"]
    spatial_index = graph["spatial_index"]
    start_snap = _nearest_node(coordinates, spatial_index, start_lat, start_lng)
    if start_snap is None or start_snap[1] > MAX_GRAPH_SNAP_M:
        return fallbacks
    destination_snaps = [
        _nearest_node(coordinates, spatial_index, latitude, longitude)
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


async def get_travel_time_and_distance(
    start_lat: float, start_lng: float,
    end_lat: float, end_lng: float
) -> tuple[float, float]:
    route = (await get_walking_routes(start_lat, start_lng, [(end_lat, end_lng)]))[0]
    return route.duration_min, route.distance_m
