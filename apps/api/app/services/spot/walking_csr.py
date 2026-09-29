"""경주 보행망의 압축 표현(CSR) — P3 배치 B. 순수 함수만 둔다(설정·로그·네트워크 없음).

dict 그래프(travel._load_graph_locked)는 노드 28,832개를 파이썬 dict·튜플로 들고 있어 살아 있는 객체만 ~16.7MB,
적재 피크 ~27MB 다(512MB 인스턴스 OOM 이력). 여기서는 같은 그래프를 표준 라이브러리 ``array`` 몇 개로 든다
(~2MB, numpy/scipy import 없음 — 그 import 만으로 +34MB 라 아끼는 것보다 크다).

**결과는 dict 그래프와 비트까지 같아야 한다.** 그래서 지키는 것:
- 노드 번호 = 원본 JSON ``nodes`` 순서의 위치. 좌표는 float64 그대로(스냅 거리 = 같은 haversine 입력).
- 공간 칸은 dict 그래프와 같은 식(``floor(좌표 / 0.002)``)이고, 칸 안의 노드 순서도 원본 순서 —
  가장 가까운 노드가 0.1m 반올림으로 비길 때 먼저 나온 노드를 고르는 규칙이 그대로 재현된다.
- 간선은 dict 그래프와 같은 거름(출발·도착 노드가 있는 것만)과 같은 순서. 가중치는 정수 미터(1~717,
  빌드가 ``max(1, round(...))`` 로 만든다)라 float 합이 경로와 무관하게 정확하다 — 최단 거리 값이 같다.
- 연결 요소(간선을 무방향으로 본 것)는 미리 센다. 출발점과 다른 요소의 목적지는 dict 그래프에서도 끝내
  찾지 못해 추정 경로로 떨어지므로, 미리 빼도 결과가 같고 탐색은 목적지를 다 찾는 순간 멈춘다.

이진 파일(``gyeongju_walking_graph.csr.bin``)은 원본 JSON 에서 ``scripts/build_walking_graph.py --emit-csr`` 로
만들어 커밋한다. 머리에 원본 .json.gz 바이트의 sha256 을 적어 두고, 적재 쪽은 원본과 다르면 이 파일을 쓰지 않는다.
CI(``tests/services/test_walking_csr.py``)가 커밋된 파일 = 원본에서 새로 만든 바이트 인지 확인한다.
"""
from __future__ import annotations

import hashlib
import heapq
import math
import struct
import sys
from array import array
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

SPATIAL_CELL_DEGREES = 0.002  # travel._SPATIAL_CELL_DEGREES 와 같아야 한다(시험이 잠근다)

MAGIC = b"NSWG"
FORMAT_VERSION = 1
# magic(4) · version(u32) · 노드 수(u32) · 간선 수(u32) · 원본 sha256(32)
_HEADER = struct.Struct("<4sIII32s")


@dataclass(eq=False)
class CsrGraph:
    """불변으로 다룬다(적재 뒤 배열을 고치지 않는다). ``snap_memo`` 만 목적지 스냅 기억으로 자란다."""

    lat: array  # 'd' — 노드 위도
    lng: array  # 'd' — 노드 경도
    indptr: array  # 'I' — 노드 i 의 간선은 [indptr[i], indptr[i+1])
    indices: array  # 'I' — 간선의 도착 노드
    weights: array  # 'H' — 간선 길이(정수 미터)
    component: array  # 'I' — 노드의 연결 요소 번호
    source_sha256: bytes
    cells: dict[tuple[int, int], array] = field(default_factory=dict)  # 칸 → 노드 번호('I'), 원본 순서
    snap_memo: dict = field(default_factory=dict)

    @property
    def node_count(self) -> int:
        return len(self.lat)


def _cell_of(latitude: float, longitude: float) -> tuple[int, int]:
    return (
        math.floor(latitude / SPATIAL_CELL_DEGREES),
        math.floor(longitude / SPATIAL_CELL_DEGREES),
    )


def _index_cells(lat: array, lng: array) -> dict[tuple[int, int], array]:
    cells: dict[tuple[int, int], array] = {}
    for index in range(len(lat)):
        key = _cell_of(lat[index], lng[index])
        bucket = cells.get(key)
        if bucket is None:
            bucket = cells[key] = array("I")
        bucket.append(index)
    return cells


def _components(node_count: int, indptr: array, indices: array) -> array:
    """간선을 무방향으로 본 연결 요소. 요소 번호는 노드 번호가 가장 작은 노드를 처음 만난 순서."""
    parent = list(range(node_count))

    def find(node: int) -> int:
        root = node
        while parent[root] != root:
            root = parent[root]
        while parent[node] != root:
            parent[node], node = root, parent[node]
        return root

    for start in range(node_count):
        for k in range(indptr[start], indptr[start + 1]):
            a, b = find(start), find(indices[k])
            if a != b:
                if a < b:
                    parent[b] = a
                else:
                    parent[a] = b
    labels: dict[int, int] = {}
    component = array("I", bytes(4 * node_count))
    for node in range(node_count):
        root = find(node)
        label = labels.get(root)
        if label is None:
            label = labels[root] = len(labels)
        component[node] = label
    return component


def build_from_raw(raw: dict[str, Any], source_sha256: bytes) -> CsrGraph:
    """원본 JSON(``{"nodes": [[id, lat, lng]...], "edges": [[from, to, meters]...]}``)에서 CSR 을 만든다.

    거름·순서는 travel._load_graph_locked 와 같다. 가중치가 1~65535 정수가 아니면 ValueError —
    uint16 로 담을 수 없거나 float 합의 정확성이 깨지는 입력이다(그때 적재 쪽은 dict 그래프로 돈다)."""
    node_ids: list[int] = []
    lat = array("d")
    lng = array("d")
    position: dict[int, int] = {}
    for node_id, latitude, longitude in raw["nodes"]:
        key = int(node_id)
        if key in position:  # dict 그래프는 같은 id 를 나중 좌표로 덮는다 — 그 모양은 여기서 재현하지 않는다
            raise ValueError(f"duplicate node id {key}")
        position[key] = len(node_ids)
        node_ids.append(key)
        lat.append(float(latitude))
        lng.append(float(longitude))
    node_count = len(node_ids)
    per_node: list[list[tuple[int, int]]] = [[] for _ in range(node_count)]
    for start, end, meters in raw["edges"]:
        s, e = position.get(int(start)), position.get(int(end))
        if s is None or e is None:
            continue
        value = float(meters)
        if not value.is_integer() or not 1 <= value <= 0xFFFF:
            raise ValueError(f"edge weight {meters!r} is not an integer metre in 1..65535")
        per_node[s].append((e, int(value)))
    indptr = array("I", [0])
    indices = array("I")
    weights = array("H")
    for edges in per_node:
        for end, meters in edges:
            indices.append(end)
            weights.append(meters)
        indptr.append(len(indices))
    del per_node, position
    component = _components(node_count, indptr, indices)
    graph = CsrGraph(lat, lng, indptr, indices, weights, component, bytes(source_sha256))
    graph.cells = _index_cells(lat, lng)
    return graph


def _le(values: array) -> bytes:
    if sys.byteorder == "little":
        return values.tobytes()
    swapped = array(values.typecode, values)
    swapped.byteswap()
    return swapped.tobytes()


def _from_le(typecode: str, data: bytes) -> array:
    values = array(typecode)
    values.frombytes(data)
    if sys.byteorder != "little":
        values.byteswap()
    return values


def _check_itemsizes() -> None:
    if array("I").itemsize != 4 or array("H").itemsize != 2 or array("d").itemsize != 8:
        raise ValueError("unsupported array item sizes on this platform")


def to_bytes(graph: CsrGraph) -> bytes:
    _check_itemsizes()
    node_count = graph.node_count
    edge_count = len(graph.indices)
    parts = [
        _HEADER.pack(MAGIC, FORMAT_VERSION, node_count, edge_count, graph.source_sha256),
        _le(graph.lat),
        _le(graph.lng),
        _le(graph.indptr),
        _le(graph.indices),
        _le(graph.component),
        _le(graph.weights),  # 2바이트 배열은 맨 끝 — 앞의 4·8바이트 배열 정렬을 흩뜨리지 않는다
    ]
    return b"".join(parts)


def from_bytes(data: bytes, expected_source_sha256: bytes | None = None) -> CsrGraph:
    """``to_bytes`` 의 역. 모양·길이·원본 해시가 어긋나면 ValueError(부분 적재 없음)."""
    _check_itemsizes()
    if len(data) < _HEADER.size:
        raise ValueError("csr file too short")
    magic, version, node_count, edge_count, source = _HEADER.unpack_from(data, 0)
    if magic != MAGIC or version != FORMAT_VERSION:
        raise ValueError("csr file magic/version mismatch")
    if expected_source_sha256 is not None and source != expected_source_sha256:
        raise ValueError("csr file was built from a different walking graph")
    sizes = [
        ("d", node_count),
        ("d", node_count),
        ("I", node_count + 1),
        ("I", edge_count),
        ("I", node_count),
        ("H", edge_count),
    ]
    expected = _HEADER.size + sum(array(code).itemsize * count for code, count in sizes)
    if len(data) != expected:
        raise ValueError(f"csr file size {len(data)} != expected {expected}")
    offset = _HEADER.size
    arrays: list[array] = []
    for code, count in sizes:
        width = array(code).itemsize * count
        arrays.append(_from_le(code, data[offset:offset + width]))
        offset += width
    lat, lng, indptr, indices, component, weights = arrays
    if indptr[0] != 0 or indptr[-1] != edge_count or any(
        indptr[i] > indptr[i + 1] for i in range(node_count)
    ):
        raise ValueError("csr indptr is not monotonic")
    if edge_count and max(indices) >= node_count:
        raise ValueError("csr edge points past the last node")
    graph = CsrGraph(lat, lng, indptr, indices, weights, component, source)
    graph.cells = _index_cells(lat, lng)
    return graph


def source_digest(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """travel.calculate_haversine_distance 와 같은 식·같은 반올림(시험이 잠근다). 순환 import 를 피하려고 둘로 둔다."""
    r_lat1, r_lng1, r_lat2, r_lng2 = map(math.radians, [lat1, lng1, lat2, lng2])
    d_lat = r_lat2 - r_lat1
    d_lng = r_lng2 - r_lng1
    a = math.sin(d_lat / 2) ** 2 + math.cos(r_lat1) * math.cos(r_lat2) * math.sin(d_lng / 2) ** 2
    c = 2 * math.asin(min(1.0, math.sqrt(a)))
    return round(6371000 * c, 1)


def nearest_node(graph: CsrGraph, latitude: float, longitude: float) -> tuple[int, float] | None:
    """travel._nearest_node 와 같은 후보(5×5 칸)·같은 순서·같은 비교(엄격한 <)."""
    nearest: tuple[int, float] | None = None
    center_lat, center_lng = _cell_of(latitude, longitude)
    cells = graph.cells
    lat, lng = graph.lat, graph.lng
    for lat_offset in range(-2, 3):
        for lng_offset in range(-2, 3):
            bucket = cells.get((center_lat + lat_offset, center_lng + lng_offset))
            if not bucket:
                continue
            for index in bucket:
                meters = haversine_m(latitude, longitude, lat[index], lng[index])
                if nearest is None or meters < nearest[1]:
                    nearest = index, meters
    return nearest


def shortest_distances(graph: CsrGraph, start: int, targets: Iterable[int]) -> dict[int, float]:
    """travel._dijkstra 와 같은 값. 출발점과 다른 연결 요소의 목적지는 미리 뺀다(어차피 찾지 못한다)."""
    home = graph.component[start]
    component = graph.component
    remaining = {target for target in targets if component[target] == home}
    found: dict[int, float] = {}
    if not remaining:
        return found
    indptr, indices, weights = graph.indptr, graph.indices, graph.weights
    distances = [math.inf] * graph.node_count
    distances[start] = 0.0
    queue: list[tuple[float, int]] = [(0.0, start)]
    heappop, heappush = heapq.heappop, heapq.heappush
    while queue and remaining:
        distance, node = heappop(queue)
        if distance != distances[node]:
            continue
        if node in remaining:
            found[node] = distance
            remaining.remove(node)
        for k in range(indptr[node], indptr[node + 1]):
            neighbor = indices[k]
            candidate = distance + weights[k]
            if candidate < distances[neighbor]:
                distances[neighbor] = candidate
                heappush(queue, (candidate, neighbor))
    return found
