"""구역 혼잡 계층 마이그레이션(`20261031120000_crowd_zones.sql`)의 계약.

  · 서비스가 쓰는 upsert 키·컬럼이 DDL 에 있다(어긋나면 이중 저장이 매 버킷 실패한다).
  · 서울은 내부 전용 — RLS 켜짐, service_role 정책만, anon·authenticated 회수(§7 A1).
  · 멱등 — IF NOT EXISTS · 정책 DROP 후 CREATE · 시드 ON CONFLICT DO UPDATE.
  · 시드 9곳 = `crowd.seoul_provider.SEOUL_ZONES`(값까지 같다).
  · RESET 빌더가 새 표를 지운다.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.services.crowd import observation as crowd_obs
from app.services.crowd import seoul_provider as provider
from app.services.crowd import store

ROOT = Path(__file__).resolve().parents[4]
MIGRATION = "supabase/migrations/20261031120000_crowd_zones.sql"
TABLES = ("zones", "zone_crowd_snapshots", "facility_zones")


def _body() -> str:
    """주석을 걷어내고 공백을 하나로 모은 소문자 본문. 주석의 문장이 증거가 되면 안 된다."""
    text = (ROOT / MIGRATION).read_text(encoding="utf-8")
    lines = [line for line in text.splitlines() if not line.lstrip().startswith("--")]
    return " ".join("\n".join(lines).lower().split())


def test_migration_sorts_last_and_store_points_at_it():
    names = sorted(p.name for p in (ROOT / "supabase/migrations").glob("*.sql"))
    assert names.index(Path(MIGRATION).name) > names.index("20261024100000_usage_summary.sql")
    assert store.MIGRATION == Path(MIGRATION).name


def test_tables_are_idempotent_and_keyed_as_the_service_expects():
    sql = _body()
    for table in TABLES:
        assert f"create table if not exists public.{table} (" in sql
    assert "zone_id text primary key" in sql
    assert "constraint zone_crowd_snapshots_bucket_unique unique (zone_id, source, bucket_at)" in sql
    assert "zone_id text not null references public.zones(zone_id) on delete cascade" in sql
    assert "facility_id uuid not null references public.facilities(id) on delete cascade" in sql
    assert "primary key (facility_id, zone_id)" in sql
    assert "create index if not exists idx_zone_crowd_snapshots_zone_bucket" in sql
    kinds = ", ".join(f"'{kind}'" for kind in crowd_obs.ZONE_KINDS)
    assert f"kind in ({kinds})" in sql


def test_internal_only_rls_and_grants():
    sql = _body()
    for table in TABLES:
        assert f"alter table public.{table} enable row level security" in sql
        policies = re.findall(rf"create policy \S+ on public\.{table} (.*?);", sql)
        assert policies == ["for all to service_role using (true) with check (true)"], table
        assert f"drop policy if exists {table}_service_all on public.{table}" in sql
        assert f"grant select, insert, update, delete on table public.{table} to service_role" in sql
        assert f"revoke all on table public.{table} from anon, authenticated" in sql
    assert " to anon" not in sql and " to authenticated" not in sql
    assert re.search(r"to public(?![.\w])", sql) is None


def _seed_rows() -> list[tuple[str, ...]]:
    text = (ROOT / MIGRATION).read_text(encoding="utf-8")
    seed = text[text.index("INSERT INTO public.zones"): text.index("ON CONFLICT (zone_id)")]
    return re.findall(
        r"\('([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)', '([^']+)', "
        r"([\d.]+), ([\d.]+), (\d+)\)",
        seed,
    )


def test_seed_matches_the_python_zone_registry():
    rows = _seed_rows()
    assert len(rows) == 9
    expected = [
        (
            zone.zone_id, zone.region, zone.kind, zone.name, zone.provider,
            zone.provider_zone_code, zone.provider_zone_name, zone.cluster,
            f"{zone.centroid_lat:.6f}", f"{zone.centroid_lng:.6f}", str(zone.radius_m),
        )
        for zone in provider.SEOUL_ZONES
    ]
    assert rows == expected


def test_seed_is_an_upsert():
    sql = _body()
    assert "on conflict (zone_id) do update set" in sql
    for column in ("provider_zone_code", "provider_zone_name", "cluster", "centroid_lat", "centroid_lng", "radius_m"):
        assert f"{column} = excluded.{column}" in sql


@pytest.mark.parametrize("table", TABLES)
def test_reset_builder_and_reset_file_drop_the_new_tables(table):
    builder = (ROOT / "scripts/build_reset.mjs").read_text(encoding="utf-8")
    reset = (ROOT / "supabase/RESET_AND_SETUP.sql").read_text(encoding="utf-8")
    statement = f"DROP TABLE IF EXISTS public.{table} CASCADE;"
    assert statement in builder
    assert statement in reset
    # 자식(facility_zones · zone_crowd_snapshots)을 부모(zones · facilities)보다 먼저 지운다.
    assert builder.index("DROP TABLE IF EXISTS public.facility_zones CASCADE;") < builder.index(
        "DROP TABLE IF EXISTS public.zones CASCADE;"
    ) < builder.index("DROP TABLE IF EXISTS public.facilities CASCADE;")
    assert f"migrations/{Path(MIGRATION).name}" in reset
