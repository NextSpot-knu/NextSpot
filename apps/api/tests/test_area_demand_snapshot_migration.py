from pathlib import Path


def _migration_sql() -> str:
    root = Path(__file__).resolve().parents[3]
    return (
        root / "supabase/migrations/20260820220000_add_area_demand_snapshots.sql"
    ).read_text(encoding="utf-8")


def test_area_demand_snapshot_migration_is_retry_safe_and_factual():
    sql = " ".join(_migration_sql().lower().split())

    assert "unique (source, bucket_at)" in sql
    assert "interval '15 minutes'" in sql
    assert "generated always as" in sql
    assert "available_spaces <= total_spaces" in sql
    assert "'gyeongju_its', 'national_parking_api'" in sql
    assert "prediction" not in sql
    assert "wait_time" not in sql


def test_area_demand_lots_are_idempotent_children_and_service_only():
    sql = " ".join(_migration_sql().lower().split())

    assert "primary key (snapshot_id, source_lot_id)" in sql
    assert "references public.area_demand_snapshots(id) on delete cascade" in sql
    assert "alter table public.area_demand_snapshots enable row level security" in sql
    assert "alter table public.area_demand_snapshot_lots enable row level security" in sql
    assert "create policy" not in sql


def test_reset_builder_drops_area_demand_children_before_parent():
    root = Path(__file__).resolve().parents[3]
    builder = (root / "scripts/build_reset.mjs").read_text(encoding="utf-8")

    child_drop = "DROP TABLE IF EXISTS public.area_demand_snapshot_lots CASCADE;"
    parent_drop = "DROP TABLE IF EXISTS public.area_demand_snapshots CASCADE;"
    assert child_drop in builder
    assert parent_drop in builder
    assert builder.index(child_drop) < builder.index(parent_drop)
    assert (
        "DROP FUNCTION IF EXISTS public.record_area_demand_snapshot(TEXT, TIMESTAMPTZ, JSONB) CASCADE;"
        in builder
    )


def test_record_snapshot_rpc_is_atomic_validated_and_ignores_older_retries():
    sql = " ".join(_migration_sql().lower().split())

    assert "record_area_demand_snapshot" in sql
    assert "p_source text, p_observed_at timestamptz, p_lots jsonb" in sql
    assert "returns jsonb language plpgsql security invoker" in sql
    assert "jsonb_array_length(p_lots) = 0" in sql
    assert "duplicate source_lot_id in lots" in sql
    assert "pg_advisory_xact_lock" in sql
    assert "v_existing.observed_at > p_observed_at" in sql
    assert "delete from public.area_demand_snapshot_lots" in sql
    assert "jsonb_build_object('stored', false)" in sql
    assert "jsonb_build_object('stored', true)" in sql
    assert "grant execute on function public.record_area_demand_snapshot" in sql
