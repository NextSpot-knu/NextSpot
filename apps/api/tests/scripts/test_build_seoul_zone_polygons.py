"""서울 구역 다각형 빌더(scripts/build_seoul_zone_polygons.py) — 표준 라이브러리만으로 SHP+DBF zip 을 읽는다."""

from __future__ import annotations

import json
import struct
import zipfile

import pytest

import scripts.build_seoul_zone_polygons as builder
from app.services.crowd import zone_footprint as zf
from app.services.crowd.seoul_provider import SEOUL_ZONES


def _ring_square(lat, lng, half_deg, *, clockwise=True):
    pts = [(lng - half_deg, lat - half_deg), (lng - half_deg, lat + half_deg),
           (lng + half_deg, lat + half_deg), (lng + half_deg, lat - half_deg)]
    if not clockwise:
        pts = list(reversed(pts))
    return pts + pts[:1]


def _shp(records: list[list[list[tuple[float, float]]]]) -> bytes:
    body = b""
    for number, rings in enumerate(records, start=1):
        points = [p for ring in rings for p in ring]
        parts, offset = [], 0
        for ring in rings:
            parts.append(offset)
            offset += len(ring)
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        content = struct.pack("<i4d2i", 5, min(xs), min(ys), max(xs), max(ys), len(rings), len(points))
        content += struct.pack(f"<{len(parts)}i", *parts)
        content += b"".join(struct.pack("<2d", x, y) for x, y in points)
        body += struct.pack(">2i", number, len(content) // 2) + content
    header = struct.pack(">7i", 9994, 0, 0, 0, 0, 0, (100 + len(body)) // 2)
    header += struct.pack("<2i", 1000, 5) + struct.pack("<4d", 0, 0, 0, 0) + struct.pack("<4d", 0, 0, 0, 0)
    return header + body


def _dbf(rows: list[dict[str, str]]) -> bytes:
    fields = [("AREA_CD", 10), ("AREA_NM", 40)]
    header_len = 32 + 32 * len(fields) + 1
    record_len = 1 + sum(length for _, length in fields)
    header = struct.pack("<4BIHH20x", 3, 126, 10, 31, len(rows), header_len, record_len)
    for name, length in fields:
        header += name.encode("ascii").ljust(11, b"\x00") + b"C" + b"\x00" * 4 + bytes([length, 0]) + b"\x00" * 14
    header += b"\x0d"
    body = b""
    for row in rows:
        body += b" " + b"".join(row[name].encode("cp949").ljust(length, b" ") for name, length in fields)
    return header + body + b"\x1a"


def _zip(tmp_path, records, rows, prj=None):
    path = tmp_path / "zones.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("영역/zones.shp", _shp(records))
        archive.writestr("영역/zones.dbf", _dbf(rows))
        if prj is not None:
            archive.writestr("영역/zones.prj", prj)
    return path


WGS84_PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]]]'


def _all_zones(extra_hole_for=None):
    records, rows = [], []
    for zone in SEOUL_ZONES:
        rings = [_ring_square(zone.centroid_lat, zone.centroid_lng, 0.003)]
        if zone.provider_zone_code == extra_hole_for:
            rings.append(_ring_square(zone.centroid_lat, zone.centroid_lng, 0.001, clockwise=False))
        records.append(rings)
        rows.append({"AREA_CD": zone.provider_zone_code, "AREA_NM": zone.name})
    records.append([_ring_square(37.0, 127.0, 0.001)])  # 9곳 밖의 장소는 버린다
    rows.append({"AREA_CD": "POI999", "AREA_NM": "다른 곳"})
    return records, rows


def test_codes_match_seoul_zones():
    assert builder.SEOUL_ZONE_CODES == {z.provider_zone_code: z.name for z in SEOUL_ZONES}


def test_build_writes_nine_zone_features_with_provenance(tmp_path):
    records, rows = _all_zones(extra_hole_for="POI078")
    out = tmp_path / "out.geojson"
    assert builder.main([str(_zip(tmp_path, records, rows, WGS84_PRJ)), "--output", str(out)]) == 0
    collection = json.loads(out.read_text(encoding="utf-8"))
    ids = [f["properties"]["zone_id"] for f in collection["features"]]
    assert sorted(ids) == sorted(z.zone_id for z in SEOUL_ZONES)
    assert "OA-21285" in collection["provenance"]["source"]
    assert "공공누리" in collection["provenance"]["license"]
    insadong = next(f for f in collection["features"] if f["properties"]["provider_zone_code"] == "POI078")
    assert insadong["geometry"]["type"] == "Polygon" and len(insadong["geometry"]["coordinates"]) == 2  # 구멍 유지
    # 발자국 모듈이 그대로 읽는다
    geometries = zf.load_polygon_file(out)
    for zone in SEOUL_ZONES:
        assert zf.contains(zf.zone_footprint(zone, geometries[zone.zone_id]), zone.centroid_lat + 0.0025, zone.centroid_lng)


def test_missing_zone_fails(tmp_path):
    records, rows = _all_zones()
    path = _zip(tmp_path, records[1:], rows[1:])
    assert builder.main([str(path), "--output", str(tmp_path / "o.geojson")]) == 1
    assert not (tmp_path / "o.geojson").exists()


def test_projected_prj_needs_pyproj_or_fails(tmp_path, monkeypatch):
    records, rows = _all_zones()
    prj = 'PROJCS["Korea_2000_Korea_Central_Belt_2010",GEOGCS["GCS_Korea_2000"]]'
    import builtins

    real_import = builtins.__import__

    def no_pyproj(name, *args, **kwargs):
        if name == "pyproj":
            raise ImportError("no pyproj")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_pyproj)
    assert builder.main([str(_zip(tmp_path, records, rows, prj)), "--output", str(tmp_path / "o.geojson")]) == 1


def test_is_wgs84():
    assert builder.is_wgs84(None)
    assert builder.is_wgs84(WGS84_PRJ)
    assert not builder.is_wgs84('PROJCS["WGS_1984_UTM_Zone_52N",GEOGCS["GCS_WGS_1984"]]')


def test_simplify_keeps_a_closed_ring_and_drops_collinear_points():
    lat, lng = 37.57, 126.98
    ring = [(lng, lat), (lng + 0.00001, lat), (lng + 0.00002, lat), (lng + 0.01, lat),
            (lng + 0.01, lat + 0.01), (lng, lat + 0.01), (lng, lat)]
    out = builder.simplify_ring(ring, 2.0)
    assert out[0] == out[-1]
    assert len(out) == 5


def test_not_a_polygon_shapefile_is_rejected():
    with pytest.raises(builder.BuildError):
        builder.read_shp(b"\x00" * 100)


def test_script_does_not_import_app():
    source = builder.__file__
    text = open(source, encoding="utf-8").read()
    assert "from app" not in text and "import app" not in text
