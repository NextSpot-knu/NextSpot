"""시설 → 구역 매핑(scripts/map_facility_zones.py) — 같은 지역 안에서만, 적재와 같은 발자국으로(S3 §2)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import scripts.map_facility_zones as mapping
from app.services.crowd import zone_footprint as zf
from app.services.crowd.seoul_provider import SEOUL_ZONES
from tests.scripts.test_ingest_tourapi_seoul import FakeDB

LAT0, LNG0 = 37.57, 126.98


def _square(half_m, lat=LAT0, lng=LNG0):
    dl, dg = half_m / 111_195, half_m / 88_150
    return [[lng - dg, lat - dl], [lng + dg, lat - dl], [lng + dg, lat + dl], [lng - dg, lat + dl], [lng - dg, lat - dl]]


def _zone_row(zone_id="seoul:A", lat=LAT0, lng=LNG0, radius=300, geometry=None, region="seoul"):
    return {"zone_id": zone_id, "region": region, "kind": "hotspot_polygon", "name": zone_id, "cluster": "c",
            "centroid_lat": lat, "centroid_lng": lng, "radius_m": radius, "geometry": geometry}


def _fac(fid, lat, lng, *, region="seoul", active=True):
    return {"id": fid, "latitude": lat, "longitude": lng, "is_active": active, "region": region}


def _args(**kw):
    values = dict(region="seoul", apply=True, sync_geometry=False)
    values.update(kw)
    return SimpleNamespace(**values)


# ── 순수 계산 ─────────────────────────────────────────────────────────────────

def test_inside_outside_edge_hole_multipolygon():
    hole = list(reversed(_square(800)))
    far = LNG0 + 0.03
    footprints = [
        zf.zone_footprint(_zone_row("seoul:H"), {"type": "Polygon", "coordinates": [_square(1500), hole]}),
        zf.zone_footprint(_zone_row("seoul:M"), {"type": "MultiPolygon", "coordinates": [[_square(100, lng=far)]]}),
    ]
    facilities = [
        _fac("in-body", LAT0 + 0.010, LNG0),          # 몸통
        _fac("in-hole", LAT0, LNG0),                  # 구멍 한가운데 → 어디에도 없음
        _fac("edge", LAT0 + 1500 / 111_195, LNG0),    # 바깥 경계 위
        _fac("multi", LAT0, far),                     # 두 번째 다각형
        _fac("outside", LAT0 + 0.03, LNG0),           # 3 km 밖
    ]
    result = mapping.compute_facility_zones(facilities, footprints, region="seoul")
    pairs = {(p["facility_id"], p["zone_id"]) for p in result.pairs}
    assert pairs == {("in-body", "seoul:H"), ("edge", "seoul:H"), ("multi", "seoul:M")}
    assert set(result.unmapped) == {"in-hole", "outside"}
    assert {p["method"] for p in result.pairs} == {zf.METHOD_POLYGON}


def test_polygon_buffer_200m_and_radius_fallback():
    poly = zf.zone_footprint(_zone_row("seoul:P"), {"type": "Polygon", "coordinates": [_square(300)]})
    circle = zf.zone_footprint(_zone_row("seoul:R", lat=LAT0 + 0.05, radius=400))
    facilities = [
        _fac("buffer-in", LAT0 + (300 + 150) / 111_195, LNG0),
        _fac("buffer-out", LAT0 + (300 + 260) / 111_195, LNG0),
        _fac("radius-in", LAT0 + 0.05 + 590 / 111_195, LNG0),   # 400 × 1.5 = 600 안
        _fac("radius-out", LAT0 + 0.05 + 620 / 111_195, LNG0),
    ]
    result = mapping.compute_facility_zones(facilities, [poly, circle], region="seoul")
    got = {p["facility_id"]: p["method"] for p in result.pairs}
    assert got == {"buffer-in": zf.METHOD_POLYGON, "radius-in": zf.METHOD_RADIUS}


def test_weights_are_one_over_k():
    a = zf.zone_footprint(_zone_row("seoul:A", radius=500))
    b = zf.zone_footprint(_zone_row("seoul:B", lng=LNG0 + 0.002, radius=500))
    result = mapping.compute_facility_zones([_fac("both", LAT0, LNG0 + 0.001), _fac("one", LAT0, LNG0 - 0.007)],
                                            [a, b], region="seoul")
    weights = {(p["facility_id"], p["zone_id"]): p["weight"] for p in result.pairs}
    assert weights == {("both", "seoul:A"): 0.5, ("both", "seoul:B"): 0.5, ("one", "seoul:A"): 1.0}


def test_cross_region_pair_is_refused():
    gyeongju_zone = zf.zone_footprint(_zone_row("gyeongju:X", region="gyeongju"))
    with pytest.raises(mapping.CrossRegionPair):
        mapping.compute_facility_zones([_fac("s", LAT0, LNG0)], [gyeongju_zone], region="seoul")
    seoul_zone = zf.zone_footprint(_zone_row())
    result = mapping.compute_facility_zones([_fac("g", LAT0, LNG0, region="gyeongju")], [seoul_zone], region="seoul")
    assert result.pairs == [] and result.refused == 1


# ── 실행(DB 대역) ─────────────────────────────────────────────────────────────

def _db(facilities, zones=None, pairs=None):
    return FakeDB({
        "zones": zones if zones is not None else [_zone_row()],
        "facilities": facilities,
        "facility_zones": pairs or [],
        "app_events": [],
    })


def test_reads_only_the_zone_region_and_never_maps_gyeongju():
    db = _db([_fac("s1", LAT0, LNG0), _fac("g1", LAT0, LNG0, region="gyeongju")])
    assert mapping.run(_args(), client=db, file_geometries={}) == 0
    assert {(r["facility_id"], r["zone_id"]) for r in db.tables["facility_zones"]} == {("s1", "seoul:A")}
    facility_reads = [f for op, table, f, _ in db.journal if table == "facilities" and op == "select"]
    assert facility_reads and all(("region", "eq", "seoul", False) in filters for filters in facility_reads)


def test_stale_deletes_are_scoped_to_the_region_zones():
    existing = [
        {"facility_id": "s-gone", "zone_id": "seoul:A", "method": "radius", "weight": 1},
        {"facility_id": "g-1", "zone_id": "gyeongju:Z", "method": "manual", "weight": 1},
    ]
    db = _db([_fac("s1", LAT0, LNG0)], pairs=existing)
    assert mapping.run(_args(), client=db, file_geometries={}) == 0
    left = {(r["facility_id"], r["zone_id"]) for r in db.tables["facility_zones"]}
    assert ("s-gone", "seoul:A") not in left
    assert ("g-1", "gyeongju:Z") in left  # 다른 지역 구역의 쌍은 건드리지 않는다
    deletes = [f for op, table, f, _ in db.journal if table == "facility_zones" and op == "delete"]
    assert deletes and all(("zone_id", "eq", "seoul:A", False) in f for f in deletes)


def test_dry_run_writes_nothing():
    db = _db([_fac("s1", LAT0, LNG0), _fac("lost", LAT0 + 0.05, LNG0)])
    assert mapping.run(_args(apply=False, sync_geometry=True), client=db,
                       file_geometries={"seoul:A": {"type": "Polygon", "coordinates": [_square(200)]}}) == 0
    assert [entry for entry in db.journal if entry[0] != "select"] == []


def test_active_unmapped_rows_are_deactivated_in_region():
    db = _db([_fac("s1", LAT0, LNG0), _fac("lost", LAT0 + 0.05, LNG0), _fac("lost-off", LAT0 + 0.05, LNG0, active=False)])
    assert mapping.run(_args(), client=db, file_geometries={}) == 0
    by_id = {r["id"]: r for r in db.tables["facilities"]}
    assert by_id["lost"]["is_active"] is False
    assert by_id["s1"]["is_active"] is True
    event = next(e for e in db.tables["app_events"] if e["event"] == mapping.EVENT)
    assert event["props"]["active_unmapped_count"] == 1


def test_sync_geometry_updates_only_changed_zones():
    geometry = {"type": "Polygon", "coordinates": [_square(200)]}
    zones = [_zone_row("seoul:A"), _zone_row("seoul:B", geometry=geometry)]
    db = _db([], zones=zones)
    assert mapping.run(_args(sync_geometry=True), client=db,
                       file_geometries={"seoul:A": geometry, "seoul:B": geometry}) == 0
    updates = [f for op, table, f, _ in db.journal if table == "zones" and op == "update"]
    assert len(updates) == 1 and ("zone_id", "eq", "seoul:A", False) in updates[0]


def test_missing_table_is_reported_not_raised(capsys):
    db = _db([])

    class Missing(Exception):
        code = "PGRST205"

    db.fail[("zones", "select")] = Missing("Could not find the table 'public.zones'")
    assert mapping.run(_args(), client=db, file_geometries={}) == 1
    assert "migration_not_applied" in capsys.readouterr().out


def test_gyeongju_region_is_rejected():
    assert mapping.run(_args(region="gyeongju"), client=_db([]), file_geometries={}) == 1


def test_parity_every_ingested_fixture_facility_maps_to_a_zone():
    """적재가 받아들인 점(발자국 안)은 매핑에서도 한 구역 이상에 붙는다 — 같은 발자국 함수."""
    import scripts.ingest_tourapi_seoul as ingest

    zone_rows = [
        {"zone_id": z.zone_id, "region": z.region, "centroid_lat": z.centroid_lat, "centroid_lng": z.centroid_lng,
         "radius_m": z.radius_m, "geometry": None}
        for z in SEOUL_ZONES
    ]
    footprints = zf.footprints_for(zone_rows)
    facilities = []
    for z in SEOUL_ZONES:
        for d_lat in (-0.006, -0.003, 0.0, 0.003, 0.006):
            for d_lng in (-0.006, 0.0, 0.006):
                lat, lng = z.centroid_lat + d_lat, z.centroid_lng + d_lng
                if any(zf.contains(fp, lat, lng) for fp in footprints):  # 적재의 판정(collect 와 같은 식)
                    facilities.append(_fac(f"{z.zone_id}:{d_lat}:{d_lng}", lat, lng))
    assert len(facilities) > 40
    result = mapping.compute_facility_zones(facilities, footprints, region="seoul")
    assert result.unmapped == []
    assert ingest.footprints_for is zf.footprints_for and mapping.footprints_for is zf.footprints_for
