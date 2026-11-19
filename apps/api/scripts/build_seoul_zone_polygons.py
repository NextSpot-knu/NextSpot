"""서울 구역 다각형 만들기(1회성) — OA-21285 '서울시 주요 121장소 영역.zip' → GeoJSON(SEOUL_ZONES 9곳).

SEOUL_TESTBED_PLAN S3 · ingest_mapping_design §3. 결과 파일은
`apps/api/app/services/crowd/data/seoul_zone_polygons.geojson` 이고, 서울 적재·매핑이 같은 발자국
(`zone_footprint`)으로 읽는다. 파일이 없으면 두 스크립트 모두 원 발자국(radius_m × 1.5)을 쓴다.

**표준 라이브러리만 쓴다**(SHP type 5/15 · DBF CP949 직접 해석). `app` 을 import 하지 않는다 — 내려받은
압축 파일은 믿을 수 없는 데이터라 격리 모드로 돌린다:

    mkdir <빈 폴더> && (그 폴더에 zip 만 둔다)
    python -I apps/api/scripts/build_seoul_zone_polygons.py <빈 폴더>/서울시\\ 주요\\ 121장소\\ 영역.zip

좌표계는 .prj 가 WGS84 가 아니면 pyproj 가 있을 때만 변환하고, 없으면 멈춘다(지어내지 않는다).
단순화는 약 2 m(더글러스-포이커, 지역 평면 근사). 출처: 서울 열린데이터광장 OA-21285, 공공누리 제1유형(출처표시).
종료 코드: 0 성공 · 1 실패(파일·모양·좌표계·구역 누락)
"""

from __future__ import annotations

import argparse
import io
import json
import math
import re
import struct
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

# seoul_provider.SEOUL_ZONES 와 같은 9곳(코드 → zone_id·이름). 테스트가 대조한다 — app 을 import 하지 않으려 사본을 둔다.
SEOUL_ZONE_CODES: dict[str, str] = {
    "POI008": "경복궁",
    "POI066": "북촌한옥마을",
    "POI078": "인사동",
    "POI012": "창덕궁·종묘",
    "POI007": "홍대 관광특구",
    "POI073": "연남동",
    "POI053": "합정역",
    "POI003": "명동 관광특구",
    "POI002": "동대문 관광특구",
}
REGION = "seoul"
SIMPLIFY_TOLERANCE_M = 2.0
COORD_DIGITS = 7
DEFAULT_OUTPUT = (
    Path(__file__).resolve().parents[1] / "app" / "services" / "crowd" / "data" / "seoul_zone_polygons.geojson"
)
PROVENANCE = {
    "source": "서울 열린데이터광장 OA-21285 '서울시 주요 121장소 영역'",
    "license": "공공누리 제1유형(출처표시)",
    "simplify_tolerance_m": SIMPLIFY_TOLERANCE_M,
}
_CODE = re.compile(r"^POI\d{3}$")
_EARTH_RADIUS_M = 6_371_008.8
_MAX_MEMBER_BYTES = 200 * 1024 * 1024  # 압축 폭탄 방지 — 121장소 원본은 수 MB 다


class BuildError(RuntimeError):
    pass


# ── SHP ──────────────────────────────────────────────────────────────────────

def read_shp(data: bytes) -> list[list[list[tuple[float, float]]] | None]:
    """SHP 바이트 → 레코드별 고리 목록(점은 (x, y)). Null shape 는 None."""
    if len(data) < 100 or struct.unpack(">i", data[0:4])[0] != 9994:
        raise BuildError("SHP 머리말이 아닙니다")
    shape_type = struct.unpack("<i", data[32:36])[0]
    if shape_type not in (5, 15):
        raise BuildError(f"다각형 SHP 가 아닙니다(type={shape_type})")
    records: list[list[list[tuple[float, float]]] | None] = []
    offset = 100
    while offset + 8 <= len(data):
        _number, words = struct.unpack(">ii", data[offset:offset + 8])
        content = data[offset + 8: offset + 8 + words * 2]
        offset += 8 + words * 2
        record_type = struct.unpack("<i", content[0:4])[0]
        if record_type == 0:
            records.append(None)
            continue
        if record_type not in (5, 15):
            raise BuildError(f"다각형이 아닌 레코드(type={record_type})")
        num_parts, num_points = struct.unpack("<ii", content[36:44])
        parts = list(struct.unpack(f"<{num_parts}i", content[44:44 + 4 * num_parts]))
        base = 44 + 4 * num_parts
        points = [struct.unpack("<dd", content[base + 16 * i: base + 16 * i + 16]) for i in range(num_points)]
        bounds = parts + [num_points]
        records.append([[(float(x), float(y)) for x, y in points[bounds[i]:bounds[i + 1]]] for i in range(num_parts)])
    return records


# ── DBF ──────────────────────────────────────────────────────────────────────

def read_dbf(data: bytes, encoding: str = "cp949") -> list[dict[str, str]]:
    if len(data) < 32:
        raise BuildError("DBF 머리말이 아닙니다")
    count, header_len, record_len = struct.unpack("<IHH", data[4:12])
    fields: list[tuple[str, int]] = []
    pos = 32
    while pos < header_len - 1 and data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b"\x00", 1)[0].decode("ascii", "replace").strip()
        fields.append((name, data[pos + 16]))
        pos += 32
    rows: list[dict[str, str]] = []
    for index in range(count):
        start = header_len + index * record_len
        record = data[start:start + record_len]
        if not record or record[:1] == b"*":
            rows.append({})
            continue
        cursor, row = 1, {}
        for name, length in fields:
            row[name] = record[cursor:cursor + length].decode(encoding, "replace").strip()
            cursor += length
        rows.append(row)
    return rows


# ── 기하 ─────────────────────────────────────────────────────────────────────

def _signed_area(ring: list[tuple[float, float]]) -> float:
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1])) / 2.0


def _inside(ring: list[tuple[float, float]], x: float, y: float) -> bool:
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _perpendicular_m(point, start, end, k_lng: float, k_lat: float) -> float:
    px, py = point[0] * k_lng, point[1] * k_lat
    ax, ay = start[0] * k_lng, start[1] * k_lat
    bx, by = end[0] * k_lng, end[1] * k_lat
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    if length2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def simplify_ring(ring: list[tuple[float, float]], tolerance_m: float = SIMPLIFY_TOLERANCE_M) -> list[tuple[float, float]]:
    """닫힌 고리 단순화(더글러스-포이커, 미터). 결과는 닫혀 있고 점이 4개 이상이다."""
    points = list(ring)
    if points and points[0] == points[-1]:
        points = points[:-1]
    if len(points) < 4:
        return points + points[:1]
    lat0 = sum(y for _, y in points) / len(points)
    k_lat = math.pi * _EARTH_RADIUS_M / 180.0
    k_lng = k_lat * math.cos(math.radians(lat0))
    closed = points + points[:1]
    keep = [False] * len(closed)
    keep[0] = keep[-1] = True
    # 시작점에서 가장 먼 점을 고정해 고리가 선분 하나로 무너지지 않게 한다.
    far = max(range(len(points)), key=lambda i: math.hypot((points[i][0] - points[0][0]) * k_lng,
                                                           (points[i][1] - points[0][1]) * k_lat))
    keep[far] = True
    stack = [(0, far), (far, len(closed) - 1)]
    while stack:
        first, last = stack.pop()
        best, index = 0.0, None
        for i in range(first + 1, last):
            dist = _perpendicular_m(closed[i], closed[first], closed[last], k_lng, k_lat)
            if dist > best:
                best, index = dist, i
        if index is not None and best > tolerance_m:
            keep[index] = True
            stack.extend([(first, index), (index, last)])
    result = [p for p, k in zip(closed, keep) if k]
    if len(result) < 4:
        result = closed
    return result


def rings_to_geometry(rings: list[list[tuple[float, float]]], tolerance_m: float = SIMPLIFY_TOLERANCE_M) -> dict:
    """SHP 고리(바깥 = 시계, 구멍 = 반시계) → GeoJSON Polygon/MultiPolygon."""
    outers: list[list[list[tuple[float, float]]]] = []
    holes: list[list[tuple[float, float]]] = []
    for ring in rings:
        if len(ring) < 4:
            continue
        (outers.append([ring]) if _signed_area(ring) <= 0 else holes.append(ring))
    if not outers:  # 방향이 뒤집힌 파일 — 가장 큰 고리를 바깥으로 본다
        biggest = max(holes, key=lambda r: abs(_signed_area(r)))
        holes.remove(biggest)
        outers.append([biggest])
    for hole in holes:
        x, y = hole[0]
        target = next((polygon for polygon in outers if _inside(polygon[0], x, y)), None)
        if target is not None:
            target.append(hole)

    def _fmt(ring):
        return [[round(x, COORD_DIGITS), round(y, COORD_DIGITS)] for x, y in simplify_ring(ring, tolerance_m)]

    polygons = [[_fmt(ring) for ring in polygon] for polygon in outers]
    if len(polygons) == 1:
        return {"type": "Polygon", "coordinates": polygons[0]}
    return {"type": "MultiPolygon", "coordinates": polygons}


# ── 압축 · 좌표계 ─────────────────────────────────────────────────────────────

def _member(archive: zipfile.ZipFile, suffix: str) -> bytes | None:
    names = [info for info in archive.infolist() if info.filename.lower().endswith(suffix)]
    if not names:
        return None
    if len(names) > 1:
        raise BuildError(f"{suffix} 파일이 여러 개입니다 — 한 레이어만 담긴 zip 을 주세요")
    if names[0].file_size > _MAX_MEMBER_BYTES:
        raise BuildError(f"{suffix} 파일이 너무 큽니다")
    return archive.read(names[0])


def is_wgs84(prj: str | None) -> bool:
    if not prj:
        return True  # OA-21285 영역 파일은 WGS84 다(seoul_provider 독스트링) — .prj 가 없으면 그대로 본다
    text = prj.upper()
    if "PROJCS" in text:  # 투영 좌표계(UTM·TM 등) — 기준 타원체가 WGS84 여도 경위도가 아니다
        return False
    return any(token in text for token in ("WGS_1984", "WGS 84", "WGS84"))


def _transformer(prj: str):
    try:
        from pyproj import CRS, Transformer  # type: ignore[import-not-found]
    except ImportError as exc:
        raise BuildError("좌표계가 WGS84 가 아닌데 pyproj 가 없습니다 — pip install pyproj 후 다시 실행") from exc
    return Transformer.from_crs(CRS.from_wkt(prj), CRS.from_epsg(4326), always_xy=True)


def build(zip_path: Path, *, tolerance_m: float = SIMPLIFY_TOLERANCE_M) -> dict:
    with zipfile.ZipFile(zip_path) as archive:
        shp = _member(archive, ".shp")
        dbf = _member(archive, ".dbf")
        prj_bytes = _member(archive, ".prj")
    if shp is None or dbf is None:
        raise BuildError("zip 에 .shp 와 .dbf 가 모두 있어야 합니다")
    prj = prj_bytes.decode("latin-1", "replace") if prj_bytes else None
    shapes = read_shp(shp)
    rows = read_dbf(dbf)
    if len(shapes) != len(rows):
        raise BuildError("SHP 와 DBF 레코드 수가 다릅니다")
    transform = None if is_wgs84(prj) else _transformer(prj or "")

    code_field = next(
        (name for name in (rows[0] if rows else {}) if any(_CODE.match(str(r.get(name, ""))) for r in rows)),
        None,
    )
    if code_field is None:
        raise BuildError("POI 코드 칸을 찾지 못했습니다")
    features = []
    for shape, row in zip(shapes, rows):
        code = str(row.get(code_field) or "")
        if code not in SEOUL_ZONE_CODES or shape is None:
            continue
        rings = shape
        if transform is not None:
            rings = [[tuple(transform.transform(x, y)) for x, y in ring] for ring in rings]
        features.append({
            "type": "Feature",
            "properties": {
                "zone_id": f"{REGION}:{code}", "provider_zone_code": code, "name": SEOUL_ZONE_CODES[code],
            },
            "geometry": rings_to_geometry(rings, tolerance_m),
        })
    missing = sorted(set(SEOUL_ZONE_CODES) - {f["properties"]["provider_zone_code"] for f in features})
    if missing:
        raise BuildError(f"zip 에 없는 구역: {missing}")
    features.sort(key=lambda f: f["properties"]["zone_id"])
    return {
        "type": "FeatureCollection",
        "name": "seoul_zone_polygons",
        "provenance": {**PROVENANCE, "generated_at": datetime.now(timezone.utc).date().isoformat()},
        "features": features,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="OA-21285 영역 zip → 서울 구역 GeoJSON")
    parser.add_argument("zip_path", type=Path)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--tolerance-m", type=float, default=SIMPLIFY_TOLERANCE_M)
    args = parser.parse_args(argv)
    try:
        collection = build(args.zip_path, tolerance_m=args.tolerance_m)
    except (BuildError, zipfile.BadZipFile, OSError, struct.error) as exc:
        print(f"[polygons] 실패: {exc}")
        return 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.StringIO()
    json.dump(collection, buffer, ensure_ascii=False, indent=1)
    args.output.write_text(buffer.getvalue() + "\n", encoding="utf-8")
    points = sum(len(ring) for f in collection["features"] for ring in _iter_rings(f["geometry"]))
    print(f"[polygons] 구역 {len(collection['features'])}곳 · 꼭짓점 {points}개 → {args.output.name}")
    return 0


def _iter_rings(geometry: dict):
    if geometry["type"] == "Polygon":
        yield from geometry["coordinates"]
    else:
        for polygon in geometry["coordinates"]:
            yield from polygon


if __name__ == "__main__":
    sys.exit(main())
