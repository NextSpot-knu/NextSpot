"""시설 → 구역 매핑(`facility_zones`) — SEOUL_TESTBED_PLAN S3 · ingest_mapping_design §2.

서울 시설은 구역 혼잡(zone_crowd_snapshots)을 근거로 순위를 받는다. 이 스크립트가 시설마다 어느 구역에
드는지 정해 `facility_zones` 에 적는다. 범위는 서울 적재(`ingest_tourapi_seoul.py`)와 **같은** 발자국
(`app/services/crowd/zone_footprint.py`)이다 — 적재된 활성 서울 시설은 모두 한 구역 이상에 붙는다.

  · 구역마다 그 구역 지역의 시설만 읽는다(`.eq('region', zone.region)`, 비활성 포함). 다른 지역 쌍은 만들지 않는다.
  · 방법: 다각형(200 m 여유 포함)이면 'point_in_polygon', 원(radius_m × 1.5)이면 'radius'. 가중치 1/k(k = 든 구역 수).
  · 멱등: (facility_id, zone_id) upsert, 그 지역 구역 안에서만 낡은 쌍을 지운다.
  · 기본은 미리보기(`--dry-run`, 쓰기 0). `--apply` 로 쓴다. `--sync-geometry` 는 저장소 다각형 파일
    (crowd/data/seoul_zone_polygons.geojson)과 해시가 다른 구역의 zones.geometry 를 맞춘다.
  · 어느 구역에도 들지 않는 **활성** 시설(active_unmapped)은 근거 없이 순위에 끼므로 비활성화한다(발자국이
    같아 0 이어야 정상이다).
  · 출력은 집계 숫자뿐이다(공개 CI 로그 — 시설 id·이름·좌표를 찍지 않는다).

사용 예:
  python scripts/map_facility_zones.py                          # 미리보기(서울)
  python scripts/map_facility_zones.py --apply --sync-geometry  # 적용
종료 코드: 0 성공 · 1 실패(표 없음·조회 실패 등)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable, Sequence

current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.append(parent_dir)

from dotenv import load_dotenv

load_dotenv(os.path.join(parent_dir, ".env"))

from app.core.region import INTERNAL_REGIONS, REGION_SEOUL, apply_region
from app.services.crowd.store import is_missing_table
from app.services.crowd.zone_footprint import (
    Footprint,
    contains,
    footprints_for,
    geometry_hash,
    load_polygon_file,
)

ZONE_COLUMNS = "zone_id, region, kind, name, cluster, centroid_lat, centroid_lng, radius_m, geometry"
FACILITY_COLUMNS = "id, latitude, longitude, is_active"
UPSERT_CHUNK = 500
EVENT = "facility_zones_sync"


class CrossRegionPair(ValueError):
    """다른 지역의 구역과 시설을 짝지으려 했다 — 만들지 않는다."""


@dataclass
class ZoneMapping:
    pairs: list[dict] = field(default_factory=list)
    unmapped: list[str] = field(default_factory=list)
    refused: int = 0


def compute_facility_zones(
    facilities: Iterable[dict], footprints: Sequence[Footprint], *, region: str
) -> ZoneMapping:
    """순수 계산 — 시설 × 발자국 → facility_zones 행. 가중치는 1/k.

    발자국은 모두 ``region`` 지역이어야 한다(아니면 CrossRegionPair). 시설 행에 region 칸이 있고 다른 지역이면
    짝짓지 않고 ``refused`` 로 센다(읽기가 이미 지역을 걸러 오므로 정상이면 0).
    """
    for footprint in footprints:
        if footprint.region != region:
            raise CrossRegionPair(f"zone region {footprint.region!r} != {region!r}")
    result = ZoneMapping()
    for facility in facilities:
        facility_region = facility.get("region")
        if facility_region is not None and facility_region != region:
            result.refused += 1
            continue
        facility_id = str(facility.get("id") or "")
        if not facility_id:
            continue
        hits = [fp for fp in footprints if contains(fp, facility.get("latitude"), facility.get("longitude"))]
        if not hits:
            result.unmapped.append(facility_id)
            continue
        weight = round(1.0 / len(hits), 6)
        for fp in hits:
            result.pairs.append({
                "facility_id": facility_id, "zone_id": fp.zone_id, "method": fp.method, "weight": weight,
            })
    return result


def _client():
    from app.core.supabase import supabase_admin

    return supabase_admin


def load_zones(client, region: str) -> list[dict]:
    return list(client.table("zones").select(ZONE_COLUMNS).eq("region", region).order("zone_id").execute().data or [])


def load_region_facilities(client, region: str) -> list[dict]:
    """그 지역 시설 전량(비활성 포함) — 쿼리 안에서 지역을 건다."""
    from app.core.supabase import fetch_all_rows

    return fetch_all_rows(
        client, "facilities", FACILITY_COLUMNS,
        apply_filters=lambda q: apply_region(q, region).order("id"),
    )


def load_existing_pairs(client, zone_ids: Sequence[str]) -> set[tuple[str, str]]:
    if not zone_ids:
        return set()
    from app.core.supabase import fetch_all_rows

    rows = fetch_all_rows(
        client, "facility_zones", "facility_id, zone_id",
        apply_filters=lambda q: q.in_("zone_id", list(zone_ids)).order("facility_id").order("zone_id"),
    )
    return {(str(r["facility_id"]), str(r["zone_id"])) for r in rows if r.get("facility_id") and r.get("zone_id")}


def sync_geometry(client, zones: list[dict], file_geometries: dict, *, apply: bool) -> int:
    """저장소 다각형과 해시가 다른 구역의 geometry 를 맞춘다. 맞춘(맞출) 구역 수."""
    changed = 0
    for zone in zones:
        geometry = file_geometries.get(str(zone.get("zone_id")))
        if geometry is None or geometry_hash(geometry) == geometry_hash(zone.get("geometry")):
            continue
        changed += 1
        if apply:
            client.table("zones").update({
                "geometry": geometry, "updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("zone_id", zone["zone_id"]).eq("region", zone["region"]).execute()
        zone["geometry"] = geometry
    return changed


def _chunks(items: list, size: int) -> Iterable[list]:
    for start in range(0, len(items), size):
        yield items[start:start + size]


def _summary(line: str) -> None:
    print(line)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        try:
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except OSError:
            pass


def run(args: argparse.Namespace, *, client=None, file_geometries: dict | None = None) -> int:
    region = args.region
    if region not in INTERNAL_REGIONS:
        print(f"[zones] 지원하지 않는 지역입니다(구역 근거 지역만): {sorted(INTERNAL_REGIONS)}")
        return 1
    db = client if client is not None else _client()
    apply = bool(args.apply)
    try:
        zones = load_zones(db, region)
    except Exception as exc:  # noqa: BLE001 — 표 부재는 사람 작업(마이그레이션)이다
        state = "migration_not_applied" if is_missing_table(exc, "zones") else "zones_read_failed"
        _summary(f"- facility_zones: {state} (error_type={type(exc).__name__})")
        return 1
    if not zones:
        _summary("- facility_zones: zones=0 — 구역 시드가 없습니다")
        return 1

    geometries = load_polygon_file() if file_geometries is None else file_geometries
    geometry_changed = sync_geometry(db, zones, geometries, apply=apply) if args.sync_geometry else 0
    footprints = footprints_for(zones, geometries)

    try:
        facilities = load_region_facilities(db, region)
        existing = load_existing_pairs(db, [z["zone_id"] for z in zones])
    except Exception as exc:  # noqa: BLE001
        state = "migration_not_applied" if is_missing_table(exc, "facility_zones") else "read_failed"
        _summary(f"- facility_zones: {state} (error_type={type(exc).__name__})")
        return 1

    mapping = compute_facility_zones(facilities, footprints, region=region)
    computed = {(p["facility_id"], p["zone_id"]) for p in mapping.pairs}
    stale = sorted(existing - computed)
    active_ids = {str(f["id"]) for f in facilities if f.get("is_active") is not False}
    active_unmapped = sorted(set(mapping.unmapped) & active_ids)
    by_method: dict[str, int] = defaultdict(int)
    for pair in mapping.pairs:
        by_method[pair["method"]] += 1

    if apply:
        now = datetime.now(timezone.utc).isoformat()
        rows = [{**pair, "computed_at": now} for pair in mapping.pairs]
        for chunk in _chunks(rows, UPSERT_CHUNK):
            db.table("facility_zones").upsert(chunk, on_conflict="facility_id,zone_id").execute()
        stale_by_zone: dict[str, list[str]] = defaultdict(list)
        for facility_id, zone_id in stale:
            stale_by_zone[zone_id].append(facility_id)
        zone_ids = {z["zone_id"] for z in zones}
        for zone_id, facility_ids in stale_by_zone.items():
            if zone_id not in zone_ids:  # 그 지역 구역 밖은 지우지 않는다(읽기가 이미 걸렀지만 두 겹)
                continue
            for chunk in _chunks(facility_ids, UPSERT_CHUNK):
                db.table("facility_zones").delete().eq("zone_id", zone_id).in_("facility_id", chunk).execute()
        for chunk in _chunks(active_unmapped, UPSERT_CHUNK):
            # 근거 없는 활성 시설은 순위에 끼지 않게 내린다(같은 지역 안에서만).
            apply_region(db.table("facilities").update({"is_active": False}).in_("id", chunk), region).execute()

    counts = {
        "region": region,
        "apply": apply,
        "zones": len(zones),
        "polygon_zones": sum(1 for fp in footprints if fp.polygons),
        "geometry_synced": geometry_changed,
        "facilities": len(facilities),
        "pairs": len(mapping.pairs),
        "by_method": dict(by_method),
        "stale_deleted": len(stale),
        "unmapped": len(mapping.unmapped),
        "active_unmapped_count": len(active_unmapped),
        "refused_cross_region": mapping.refused,
    }
    if apply:
        try:
            db.table("app_events").insert({"event": EVENT, "props": counts}).execute()
        except Exception as exc:  # noqa: BLE001 — 기록 실패는 결과를 바꾸지 않는다
            print(f"[zones] app_events 기록 실패(error_type={type(exc).__name__})")
    _summary("- facility_zones: " + json.dumps(counts, ensure_ascii=False, sort_keys=True))
    if active_unmapped:
        _summary(f"- facility_zones: 활성인데 구역 밖 {len(active_unmapped)}곳 — "
                 + ("비활성화했습니다" if apply else "적용 시 비활성화합니다"))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="시설 → 구역 매핑(facility_zones)")
    parser.add_argument("--region", default=REGION_SEOUL, help="구역 근거 지역(기본 seoul)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", dest="apply", action="store_false", help="쓰지 않고 집계만(기본)")
    mode.add_argument("--apply", dest="apply", action="store_true", help="facility_zones 에 쓴다")
    parser.set_defaults(apply=False)
    parser.add_argument("--sync-geometry", action="store_true", help="저장소 다각형 파일로 zones.geometry 를 맞춘다")
    return run(parser.parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
