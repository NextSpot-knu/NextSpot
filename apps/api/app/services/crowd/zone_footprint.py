"""구역 발자국(footprint) — 서울 적재와 시설↔구역 매핑이 **같은** 범위를 쓴다(SEOUL_TESTBED_PLAN S3).

`ingest_mapping_design §0`. 서울 시설은 구역 근거(zone_measured)로만 혼잡을 받는다. 적재가 구역 밖 시설을
들이고 매핑이 그 시설을 어느 구역에도 붙이지 못하면, 그 시설은 근거 없이 순위에 끼어 '구역 밖이라서'
낮은 근거 등급이 된다. 그래서 두 스크립트가 이 모듈 하나로 범위를 정한다(발자국 일치 — footprint parity).

  · 다각형이 있으면 — 다각형을 **200 m** 넓힌 범위(점이 안에 있거나, 경계(구멍 경계 포함)까지 200 m 이내).
  · 없으면 — 중심에서 ``radius_m × 1.5`` 원(같은 넓이 원의 반지름은 실제 다각형 끝을 덮지 못한다).

순수 함수만 둔다(DB·네트워크 없음). 좌표는 WGS84 경위도, 거리는 m. GeoJSON 좌표 순서는 [경도, 위도]다.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

# 다각형 발자국의 바깥 여유(m). 구역 경계에 걸친 가게 입구·좌표 오차(TourAPI 좌표는 수십 m 어긋난다)를 덮는다.
POLYGON_BUFFER_M = 200.0
# 다각형이 없을 때 반지름 배수. radius_m 은 '같은 넓이 원'이라 길쭉한 실제 구역의 끝을 놓친다.
RADIUS_FALLBACK_FACTOR = 1.5
METHOD_POLYGON = "point_in_polygon"
METHOD_RADIUS = "radius"

# 저장소에 싣는 다각형 파일(OA-21285 '서울시 주요 121장소 영역' 중 SEOUL_ZONES 9곳). 없으면 원 발자국을 쓴다.
POLYGON_FILE = Path(__file__).resolve().parent / "data" / "seoul_zone_polygons.geojson"

_EARTH_RADIUS_M = 6_371_008.8

Ring = tuple[tuple[float, float], ...]  # ((lng, lat), ...) — 닫힌 고리(첫 점 = 끝 점)일 필요는 없다
Polygon = tuple[Ring, ...]  # (바깥 고리, 구멍 고리…)


@dataclass(frozen=True)
class Footprint:
    """구역 하나의 범위. ``polygons`` 가 비었으면 원(center·radius)이다."""

    zone_id: str
    region: str
    center_lat: float
    center_lng: float
    polygons: tuple[Polygon, ...] = ()
    radius_m: float = 0.0
    buffer_m: float = POLYGON_BUFFER_M

    @property
    def method(self) -> str:
        return METHOD_POLYGON if self.polygons else METHOD_RADIUS


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * _EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def _get(zone: Any, key: str, default: Any = None) -> Any:
    if isinstance(zone, Mapping):
        return zone.get(key, default)
    return getattr(zone, key, default)


def _ring(raw: Any) -> Ring:
    points: list[tuple[float, float]] = []
    for point in raw or ():
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            raise ValueError("GeoJSON 좌표 모양이 아닙니다")
        lng, lat = float(point[0]), float(point[1])
        if not (math.isfinite(lng) and math.isfinite(lat)):
            raise ValueError("GeoJSON 좌표가 유한하지 않습니다")
        points.append((lng, lat))
    if len(points) < 3:
        raise ValueError("고리는 점이 3개 이상이어야 합니다")
    return tuple(points)


def parse_geometry(geometry: Any) -> tuple[Polygon, ...]:
    """GeoJSON Polygon/MultiPolygon(또는 그걸 담은 Feature) → 다각형 튜플. 없거나 모르는 모양이면 ()."""
    if isinstance(geometry, str):
        try:
            geometry = json.loads(geometry)
        except ValueError:
            return ()
    if not isinstance(geometry, Mapping):
        return ()
    if geometry.get("type") == "Feature":
        return parse_geometry(geometry.get("geometry"))
    kind, coords = geometry.get("type"), geometry.get("coordinates")
    try:
        if kind == "Polygon":
            return (tuple(_ring(ring) for ring in coords),)
        if kind == "MultiPolygon":
            return tuple(tuple(_ring(ring) for ring in polygon) for polygon in coords)
    except (TypeError, ValueError):
        return ()
    return ()


def zone_footprint(zone: Any, geometry: Any = None) -> Footprint:
    """구역 정의(``Zone`` 또는 ``zones`` 행 dict) → 발자국.

    다각형은 ``geometry`` 인자 → 구역의 ``geometry`` 칸 순서로 찾는다. 둘 다 없으면 원(radius_m × 1.5).
    """
    polygons = parse_geometry(geometry) or parse_geometry(_get(zone, "geometry"))
    radius = float(_get(zone, "radius_m") or 0.0)
    return Footprint(
        zone_id=str(_get(zone, "zone_id")),
        region=str(_get(zone, "region") or ""),
        center_lat=float(_get(zone, "centroid_lat")),
        center_lng=float(_get(zone, "centroid_lng")),
        polygons=polygons,
        radius_m=radius * RADIUS_FALLBACK_FACTOR if not polygons else 0.0,
    )


def _inside_ring(ring: Ring, lat: float, lng: float) -> bool:
    """짝홀 규칙(ray casting). 경계 위 점은 어느 쪽이든 될 수 있다 — 호출부가 거리로 다시 본다."""
    inside = False
    count = len(ring)
    j = count - 1
    for i in range(count):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat):
            cross = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lng < cross:
                inside = not inside
        j = i
    return inside


def _inside_polygon(polygon: Polygon, lat: float, lng: float) -> bool:
    outer, holes = polygon[0], polygon[1:]
    return _inside_ring(outer, lat, lng) and not any(_inside_ring(hole, lat, lng) for hole in holes)


def _distance_to_ring_m(ring: Ring, lat: float, lng: float) -> float:
    """점 → 고리(선분들)의 최단 거리(m). 점 주변 등거리 원통 투영 — 구역 크기(수 km)에서 오차는 cm 단위다."""
    k_lat = math.pi * _EARTH_RADIUS_M / 180.0
    k_lng = k_lat * math.cos(math.radians(lat))
    best = math.inf
    count = len(ring)
    for i in range(count):
        ax, ay = (ring[i][0] - lng) * k_lng, (ring[i][1] - lat) * k_lat
        bx, by = (ring[(i + 1) % count][0] - lng) * k_lng, (ring[(i + 1) % count][1] - lat) * k_lat
        dx, dy = bx - ax, by - ay
        length2 = dx * dx + dy * dy
        t = 0.0 if length2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / length2))
        px, py = ax + t * dx, ay + t * dy
        best = min(best, math.hypot(px, py))
    return best


def distance_to_footprint_m(footprint: Footprint, lat: float, lng: float) -> float:
    """발자국 **원래 범위**(여유 전)까지의 거리. 안이면 0."""
    if not footprint.polygons:
        return max(0.0, haversine_m(footprint.center_lat, footprint.center_lng, lat, lng) - footprint.radius_m)
    best = math.inf
    for polygon in footprint.polygons:
        if _inside_polygon(polygon, lat, lng):
            return 0.0
        for ring in polygon:
            best = min(best, _distance_to_ring_m(ring, lat, lng))
    return best


def contains(footprint: Footprint, lat: Any, lng: Any) -> bool:
    """점이 발자국 안인가. 다각형은 200 m 여유까지, 원은 radius_m × 1.5 까지(경계 포함)."""
    try:
        lat_f, lng_f = float(lat), float(lng)
    except (TypeError, ValueError):
        return False
    if not (math.isfinite(lat_f) and math.isfinite(lng_f)):
        return False
    if not footprint.polygons:
        return haversine_m(footprint.center_lat, footprint.center_lng, lat_f, lng_f) <= footprint.radius_m
    return distance_to_footprint_m(footprint, lat_f, lng_f) <= footprint.buffer_m


def extent_m(footprint: Footprint) -> float:
    """중심에서 발자국 끝까지 가장 먼 거리(m) — TourAPI 반경 목록이 발자국 전체를 덮게 하는 반경."""
    if not footprint.polygons:
        return footprint.radius_m
    farthest = 0.0
    for polygon in footprint.polygons:
        for lng, lat in polygon[0]:
            farthest = max(farthest, haversine_m(footprint.center_lat, footprint.center_lng, lat, lng))
    return farthest + footprint.buffer_m


def zones_containing(footprints: Iterable[Footprint], lat: Any, lng: Any) -> list[Footprint]:
    return [footprint for footprint in footprints if contains(footprint, lat, lng)]


def load_polygon_file(path: Path = POLYGON_FILE) -> dict[str, Any]:
    """저장소의 구역 다각형 파일 → {zone_id: geometry}. 파일이 없거나 깨졌으면 {}(원 발자국으로 간다)."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    out: dict[str, Any] = {}
    for feature in (payload or {}).get("features") or ():
        if not isinstance(feature, Mapping):
            continue
        zone_id = str((feature.get("properties") or {}).get("zone_id") or "")
        if zone_id and parse_geometry(feature.get("geometry")):
            out[zone_id] = feature.get("geometry")
    return out


def geometry_hash(geometry: Any) -> str | None:
    """다각형 동기화 판정용 해시(키 순서와 무관). 다각형이 없으면 None."""
    if not parse_geometry(geometry):
        return None
    if isinstance(geometry, str):
        geometry = json.loads(geometry)
    text = json.dumps(geometry, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(text.encode("ascii")).hexdigest()


def footprints_for(
    zones: Sequence[Any], file_geometries: Mapping[str, Any] | None = None
) -> list[Footprint]:
    """구역 목록 → 발자국. 다각형은 구역 행의 geometry → 파일 순서(적재·매핑이 같은 규칙을 쓴다)."""
    geometries = file_geometries or {}
    out = []
    for zone in zones:
        own = _get(zone, "geometry")
        out.append(zone_footprint(zone, own if parse_geometry(own) else geometries.get(str(_get(zone, "zone_id")))))
    return out
