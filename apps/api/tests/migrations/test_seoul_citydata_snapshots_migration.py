"""서울 검증 표본 테이블·10분 수집 예약 마이그레이션의 계약.

서비스가 쓰는 upsert 키·컬럼과 DDL 이 어긋나면 수집이 매 버킷 실패한다. 예약 쪽은 경주
(20260824130000)와 같은 모양 — Vault 에서만 비밀을 읽고, 이름이 같은 예약은 지우고 다시 만든다.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.services import seoul_citydata_service as seoul

ROOT = Path(__file__).resolve().parents[4]
TABLE_MIGRATION = "supabase/migrations/20260920120000_seoul_citydata_snapshots.sql"
CRON_MIGRATION = "supabase/migrations/20260920121000_schedule_seoul_citydata_collection.sql"
RETRY_BUDGET_MIGRATION = "supabase/migrations/20260920140000_seoul_citydata_retry_budget.sql"
GYEONGJU_CRON = "supabase/migrations/20260824130000_schedule_area_demand_collection.sql"


def _body(relative: str) -> str:
    """주석을 걷어내고 공백을 하나로 모은 소문자 본문. 주석에 적힌 문장이 증거가 되면 안 된다."""
    text = (ROOT / relative).read_text(encoding="utf-8")
    lines = [line for line in text.splitlines() if not line.lstrip().startswith("--")]
    return " ".join("\n".join(lines).lower().split())


def test_migrations_sort_after_the_previous_latest():
    names = sorted(p.name for p in (ROOT / "supabase/migrations").glob("*.sql"))
    assert names.index(Path(TABLE_MIGRATION).name) > names.index("20260908120000_parking_derived_congestion_source.sql")
    assert names.index(Path(CRON_MIGRATION).name) == names.index(Path(TABLE_MIGRATION).name) + 1


def test_table_has_every_column_the_service_writes():
    sql = _body(TABLE_MIGRATION)
    assert "create table if not exists public.seoul_citydata_snapshots" in sql
    for column in (
        "area_cd text", "area_nm text not null", "bucket_at timestamptz not null",
        "observed_at timestamptz not null", "fetched_at timestamptz not null",
        "congest_lvl text not null", "ppltn_min integer", "ppltn_max integer",
        "fcst jsonb not null", "prk jsonb not null", "live_lot_count integer not null",
        "parking_level double precision", "tourism_level double precision",
        "level_est double precision", "estimator_version text not null",
    ):
        assert column in sql, column


def test_upsert_key_matches_the_unique_constraint():
    sql = _body(TABLE_MIGRATION)
    assert "unique (area_nm, bucket_at)" in sql
    source = (ROOT / "apps/api/app/services/seoul_citydata_service.py").read_text(encoding="utf-8")
    assert 'on_conflict="area_nm,bucket_at"' in source
    assert "create index if not exists idx_seoul_citydata_snapshots_area_bucket" in sql
    assert "(area_nm, bucket_at desc)" in sql


def test_levels_are_bounded_and_grades_are_closed():
    sql = _body(TABLE_MIGRATION)
    for column in ("parking_level", "tourism_level", "level_est"):
        assert f"{column} is null or {column} between 0 and 1" in sql, column
    quoted = ", ".join(f"'{level}'" for level in seoul.CONGEST_LEVELS)
    assert f"congest_lvl in ({quoted})" in sql
    assert "ppltn_min is null or ppltn_max is null or ppltn_min <= ppltn_max" in sql


def test_table_is_service_role_only():
    sql = _body(TABLE_MIGRATION)
    assert "alter table public.seoul_citydata_snapshots enable row level security" in sql
    policies = re.findall(r"create policy \S+ on public\.seoul_citydata_snapshots (.*?);", sql)
    assert policies == ["for all to service_role using (true) with check (true)"]
    assert "revoke all on table public.seoul_citydata_snapshots from anon, authenticated" in sql
    # 정답을 congestion_logs 에 섞지 않는다(§5.3-2).
    assert "public.congestion_logs" not in sql


def test_cron_uses_offset_minutes_and_missing_only_retry():
    sql = _body(CRON_MIGRATION)
    assert "create extension if not exists pg_cron" in sql
    assert "create extension if not exists pg_net" in sql
    assert "'nextspot-seoul-citydata-primary', '4,14,24,34,44,54 * * * *'" in sql
    # 원본 파일의 보충 주기는 10분이었다. 20260920140000 이 이것을 시간당 2회로 줄인다
    # (인증키 일 한도 1,000회 — 아래 test_retry_budget_migration 참조). 원본은 그대로 둔다:
    # 이미 적용된 파일을 고치면 적용한 DB 와 저장소가 다른 말을 한다.
    assert "'nextspot-seoul-citydata-retry', '9,19,29,39,49,59 * * * *'" in sql
    assert "p_only_if_missing and exists" in sql
    assert "from public.seoul_citydata_snapshots as snapshot where snapshot.bucket_at = v_bucket_at" in sql
    assert "interval '10 minutes'" in sql
    assert "timeout_milliseconds := 90000" in sql


def test_retry_budget_migration_fits_the_daily_call_limit():
    """보충 호출을 시간당 2회로 줄여 최악의 날에도 인증키 한도(1,000회) 안에 있는가.

    대상지 5곳 · 주 호출 10분 주기 = 하루 720회. 보충이 10분 주기면 나쁜 날 720회가 더 붙어
    1,440회가 되고 한도를 넘는다(그러면 그날 남은 시간 전체가 수집 불가다). 2회/시간이면
    최악이 720 + 240 = 960회다.
    """
    sql = _body(RETRY_BUDGET_MIGRATION)
    assert "'nextspot-seoul-citydata-retry', '9,39 * * * *'" in sql
    # 주 호출(10분 주기)은 건드리지 않는다 — 버킷 해상도가 30분 전망 지표의 기반이다.
    assert "nextspot-seoul-citydata-primary" not in sql
    assert "select public.request_seoul_citydata_collection(true)" in sql
    # 재적용해도 잡이 두 벌 생기지 않는다.
    assert "cron.unschedule" in sql

    targets = 5
    primary_per_day = 6 * 24 * targets
    retry_per_day = len("9,39".split(",")) * 24 * targets
    assert primary_per_day == 720
    assert primary_per_day + retry_per_day == 960 <= 1000


def test_cron_minutes_do_not_collide_with_gyeongju_jobs():
    def minutes(relative: str) -> set[int]:
        found: set[int] = set()
        for spec in re.findall(r"'([\d,]+) \* \* \* \*'", _body(relative)):
            found.update(int(m) for m in spec.split(","))
        return found

    seoul_minutes = minutes(CRON_MIGRATION)
    gyeongju_minutes = minutes(GYEONGJU_CRON)
    assert len(seoul_minutes) == 12 and len(gyeongju_minutes) == 12
    assert not seoul_minutes & gyeongju_minutes
    # 주 호출과 보충 호출이 같은 10분 버킷 안에 있어야 보충이 '그 버킷' 을 채운다.
    assert {m // 10 for m in seoul_minutes} == set(range(6))


def test_cron_reads_vault_reuses_the_existing_token_and_embeds_no_secret():
    sql = _body(CRON_MIGRATION)
    assert "vault.decrypted_secrets" in sql
    assert "nextspot_seoul_citydata_api_url" in sql
    assert "nextspot_area_demand_admin_token" in sql
    assert "'x-admin-authorization', 'bearer ' || v_admin_token" in sql
    assert "eyj" not in sql
    assert "seoul_opendata_key" not in sql
    for function in (
        "public.request_seoul_citydata_collection(boolean)",
        "public.configure_seoul_citydata_collection(text)",
    ):
        assert f"revoke all on function {function} from public, anon, authenticated" in sql
        assert f"grant execute on function {function} to service_role" in sql
    assert "p_api_url !~ '^https://[^[:space:]]+$'" in sql


def test_cron_is_idempotent_by_unscheduling_same_names_first():
    sql = _body(CRON_MIGRATION)
    unschedule = sql.index("perform cron.unschedule")
    assert unschedule < sql.index("select cron.schedule(")
    assert "'nextspot-seoul-citydata-primary', 'nextspot-seoul-citydata-retry'" in sql
    assert sql.count("create or replace function") == 2


def test_reset_builder_drops_table_functions_and_jobs():
    builder = (ROOT / "scripts/build_reset.mjs").read_text(encoding="utf-8")
    assert "DROP TABLE IF EXISTS public.seoul_citydata_snapshots CASCADE;" in builder
    assert "DROP FUNCTION IF EXISTS public.request_seoul_citydata_collection(BOOLEAN) CASCADE;" in builder
    assert "DROP FUNCTION IF EXISTS public.configure_seoul_citydata_collection(TEXT) CASCADE;" in builder
    assert "''nextspot-seoul-citydata-primary'', ''nextspot-seoul-citydata-retry''" in builder


def test_reset_file_was_regenerated_with_both_migrations():
    reset = (ROOT / "supabase/RESET_AND_SETUP.sql").read_text(encoding="utf-8")
    for relative in (TABLE_MIGRATION, CRON_MIGRATION):
        assert f"migrations/{Path(relative).name}" in reset
    assert "DROP TABLE IF EXISTS public.seoul_citydata_snapshots CASCADE;" in reset
