"""구역 발자국(app/services/crowd/zone_footprint.py) — 서울 적재와 매핑이 같은 범위를 쓰는가(S3 §0)."""

from __future__ import annotations

import json

import pytest

from app.services.crowd import zone_footprint as zf
from app.services.crowd.seoul_provider import SEOUL_ZONES

# 경도 1도 ≈ 88.2 km, 위도 1도 ≈ 111.2 km (위도 37.57 근처)
LAT0, LNG0 = 37.57, 126.98
D_LAT_100M = 100 / 111_195
D_LNG_100M = 100 / 88_150


def _square(half_m: float, lat=LAT0, lng=LNG0):
    dl, dg = half_m / 111_195, half_m / 88_150
    return [[lng - dg, lat - dl], [lng + dg, lat - dl], [lng + dg, lat + dl], [lng - dg, lat + dl], [lng - dg, lat - dl]]


def _zone(**extra):
    return {"zone_id": "seoul:T1", "region": "seoul", "centroid_lat": LAT0, "centroid_lng": LNG0, "radius_m": 300, **extra}


def test_polygon_inside_outside_and_200m_buffer():
    fp = zf.zone_footprint(_zone(), {"type": "Polygon", "coordinates": [_square(500)]})
    assert fp.method == zf.METHOD_POLYGON
    assert zf.contains(fp, LAT0, LNG0)
    # 경계에서 바깥으로 150 m — 여유(200 m) 안
    assert zf.contains(fp, LAT0 + 6.5 * D_LAT_100M, LNG0)
    # 바깥으로 300 m — 여유 밖
    assert not zf.contains(fp, LAT0 + 8 * D_LAT_100M, LNG0)


def test_polygon_edge_point_is_inside():
    fp = zf.zone_footprint(_zone(), {"type": "Polygon", "coordinates": [_square(500)]})
    edge_lat = LAT0 + 500 / 111_195
    assert zf.contains(fp, edge_lat, LNG0)
    assert zf.distance_to_footprint_m(fp, edge_lat + 10 * D_LAT_100M, LNG0) == pytest.approx(1000, rel=0.02)


def test_hole_excludes_its_middle_but_buffers_its_edge():
    outer = _square(1500)
    hole = list(reversed(_square(800)))
    fp = zf.zone_footprint(_zone(), {"type": "Polygon", "coordinates": [outer, hole]})
    assert not zf.contains(fp, LAT0, LNG0)  # 구멍 한가운데(경계까지 800 m)
    assert zf.contains(fp, LAT0 + 7 * D_LAT_100M, LNG0)  # 구멍 경계에서 안쪽 100 m — 넓힌 범위 안
    assert zf.contains(fp, LAT0 + 10 * D_LAT_100M, LNG0)  # 다각형 몸통


def test_multipolygon_any_part_counts():
    far_lng = LNG0 + 30 * D_LNG_100M
    geometry = {"type": "MultiPolygon", "coordinates": [[_square(200)], [_square(200, lng=far_lng)]]}
    fp = zf.zone_footprint(_zone(), geometry)
    assert zf.contains(fp, LAT0, LNG0)
    assert zf.contains(fp, LAT0, far_lng)
    assert not zf.contains(fp, LAT0, LNG0 + 15 * D_LNG_100M)  # 둘 사이(각각에서 1.3 km)


def test_radius_fallback_is_one_and_a_half_radius():
    fp = zf.zone_footprint(_zone(radius_m=400))
    assert fp.method == zf.METHOD_RADIUS
    assert fp.radius_m == pytest.approx(600)
    assert zf.contains(fp, LAT0 + 5.9 * D_LAT_100M, LNG0)
    assert not zf.contains(fp, LAT0 + 6.1 * D_LAT_100M, LNG0)
    assert zf.extent_m(fp) == pytest.approx(600)


def test_bad_inputs_are_outside_not_errors():
    fp = zf.zone_footprint(_zone())
    assert not zf.contains(fp, None, LNG0)
    assert not zf.contains(fp, "x", "y")
    assert not zf.contains(fp, float("nan"), LNG0)
    assert zf.parse_geometry({"type": "Point", "coordinates": [1, 2]}) == ()
    assert zf.parse_geometry("not json") == ()
    assert zf.parse_geometry({"type": "Polygon", "coordinates": [[[1, 2]]]}) == ()


def test_geometry_on_zone_row_and_file_fallback_order():
    own = {"type": "Polygon", "coordinates": [_square(300)]}
    other = {"type": "Polygon", "coordinates": [_square(900)]}
    fps = zf.footprints_for([_zone(geometry=own), _zone(zone_id="seoul:T2")], {"seoul:T1": other, "seoul:T2": other})
    assert fps[0].polygons == zf.parse_geometry(own)  # 구역 행의 geometry 가 먼저
    assert fps[1].polygons == zf.parse_geometry(other)  # 없으면 파일


def test_polygon_extent_covers_the_buffered_corner():
    fp = zf.zone_footprint(_zone(), {"type": "Polygon", "coordinates": [_square(500)]})
    assert zf.extent_m(fp) == pytest.approx(500 * 2 ** 0.5 + 200, rel=0.02)


def test_geometry_hash_ignores_key_order():
    a = {"type": "Polygon", "coordinates": [_square(100)]}
    b = json.loads(json.dumps({"coordinates": a["coordinates"], "type": "Polygon"}))
    assert zf.geometry_hash(a) == zf.geometry_hash(b)
    assert zf.geometry_hash(None) is None


def test_every_seoul_zone_contains_its_own_centroid():
    for fp in zf.footprints_for(list(SEOUL_ZONES)):
        assert fp.region == "seoul"
        assert zf.contains(fp, fp.center_lat, fp.center_lng)


def test_missing_polygon_file_means_radius_footprints(tmp_path):
    assert zf.load_polygon_file(tmp_path / "nope.geojson") == {}
    broken = tmp_path / "broken.geojson"
    broken.write_text("{", encoding="utf-8")
    assert zf.load_polygon_file(broken) == {}


def test_committed_polygon_file_matches_seoul_zones():
    """저장소에 다각형 파일이 있으면 SEOUL_ZONES 9곳과 정확히 맞아야 한다(없으면 건너뛴다)."""
    if not zf.POLYGON_FILE.exists():
        pytest.skip("seoul_zone_polygons.geojson 미적재 — 원 발자국을 쓴다")
    geometries = zf.load_polygon_file()
    assert set(geometries) == {zone.zone_id for zone in SEOUL_ZONES}
    for zone in SEOUL_ZONES:
        fp = zf.zone_footprint(zone, geometries[zone.zone_id])
        assert zf.contains(fp, zone.centroid_lat, zone.centroid_lng)
