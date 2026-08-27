from pathlib import Path


def _migration_sql() -> str:
    root = Path(__file__).resolve().parents[3]
    return (
        root / "supabase/migrations/20260820220000_add_area_demand_snapshots.sql"
    ).read_text(encoding="utf-8")


def _ten_minute_migration_sql() -> str:
    root = Path(__file__).resolve().parents[3]
    return (
        root / "supabase/migrations/20260824120000_area_demand_ten_minute_buckets.sql"
    ).read_text(encoding="utf-8")


def _scheduler_migration_sql() -> str:
    root = Path(__file__).resolve().parents[3]
    return (
        root / "supabase/migrations/20260824130000_schedule_area_demand_collection.sql"
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


def test_ten_minute_migration_preserves_legacy_cadence_and_updates_rpc():
    sql = " ".join(_ten_minute_migration_sql().lower().split())

    assert "add column if not exists bucket_minutes smallint" in sql
    assert "set bucket_minutes = 15 where bucket_minutes is null" in sql
    assert "alter column bucket_minutes set default 10" in sql
    assert "bucket_minutes = 15 and bucket_at = date_bin" in sql
    assert "bucket_minutes = 10 and bucket_at = date_bin" in sql
    assert "interval '10 minutes'" in sql
    assert "bucket_minutes = 10" in sql
    assert "delete from public.area_demand_snapshots" not in sql
    assert "grant execute on function public.record_area_demand_snapshot" in sql


def test_supabase_scheduler_uses_offset_ten_minute_cron_and_missing_only_retry():
    sql = " ".join(_scheduler_migration_sql().lower().split())

    assert "create extension if not exists pg_cron" in sql
    assert "create extension if not exists pg_net" in sql
    assert "nextspot-area-demand-primary" in sql
    assert "3,13,23,33,43,53 * * * *" in sql
    assert "nextspot-area-demand-retry" in sql
    assert "6,16,26,36,46,56 * * * *" in sql
    assert "p_only_if_missing and exists" in sql
    assert "snapshot.bucket_minutes = 10" in sql
    assert "snapshot.bucket_at = v_bucket_at" in sql
    assert "timeout_milliseconds := 90000" in sql


def test_supabase_scheduler_reads_vault_and_does_not_embed_a_token():
    sql = " ".join(_scheduler_migration_sql().lower().split())

    assert "vault.decrypted_secrets" in sql
    assert "nextspot_area_demand_api_url" in sql
    assert "nextspot_area_demand_admin_token" in sql
    assert "'x-admin-authorization', 'bearer ' || v_admin_token" in sql
    assert "revoke all on function public.request_area_demand_collection" in sql
    assert "from public, anon, authenticated" in sql
    assert "eyj" not in sql


def test_scheduler_configuration_rpc_is_service_only_and_rotates_vault_values():
    sql = " ".join(_scheduler_migration_sql().lower().split())

    assert "configure_area_demand_collection" in sql
    assert "vault.create_secret" in sql
    assert "vault.update_secret" in sql
    assert "grant execute on function public.configure_area_demand_collection" in sql
    assert "to service_role" in sql


def test_collection_workflow_is_manual_recovery_only():
    root = Path(__file__).resolve().parents[3]
    collector = (root / ".github/workflows/collect-area-demand.yml").read_text(
        encoding="utf-8"
    )
    uptime = (root / ".github/workflows/uptime.yml").read_text(encoding="utf-8")

    assert "schedule:" not in collector
    assert "workflow_dispatch:" in collector
    assert collector.index("Ping backend health endpoint") < collector.index(
        "Collect snapshot"
    )
    assert "schedule:" not in uptime
    assert "workflow_dispatch:" in uptime
