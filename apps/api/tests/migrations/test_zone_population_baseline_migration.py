"""20261101091000 — 구역 '평소와 비교' 기준선(화면 문구 전용, SEOUL_TESTBED_PLAN §6 S3).

로컬에 Postgres 가 없어 계약을 글자로 고정한다. 행동은 PGlite 로 한 번 돌려 확인했다 — 같은 PPLTN_TIME 의 중복 버킷은
하나(가장 늦게 받은 값)로 합쳐 세고, 대체값(replaced) · 인구 구간 빈 행 · 다른 시 · 다른 요일 구분 · p_at 1시간 안 ·
창 밖 관측은 빠진다. anon·authenticated 는 실행 권한이 없다.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
MIGRATIONS = ROOT / "supabase/migrations"
NAME = "20261101091000_zone_population_baseline.sql"
SIGNATURE = "public.zone_population_baseline(TEXT[], TIMESTAMPTZ, INTEGER)"
CODE = re.sub(r"--[^\n]*", "", (MIGRATIONS / NAME).read_text(encoding="utf-8"))
FLAT = " ".join(CODE.split())


def test_sorts_after_crowd_zones_and_the_isolation_migration():
    names = sorted(p.name for p in MIGRATIONS.glob("*.sql"))
    assert NAME > "20261031130000_guest_crowd_answer_shadow.sql"
    assert names.index(NAME) > names.index("20261031120000_crowd_zones.sql")
    assert names.index(NAME) > names.index("20261101090000_facility_region_isolation.sql")


def test_signature_and_shape():
    assert (
        "CREATE OR REPLACE FUNCTION public.zone_population_baseline( p_zone_ids TEXT[], p_at TIMESTAMPTZ, "
        "p_days INTEGER DEFAULT 28 )"
    ) in FLAT
    assert (
        "RETURNS TABLE ( zone_id TEXT, samples INTEGER, p25 DOUBLE PRECISION, p50 DOUBLE PRECISION, "
        "p75 DOUBLE PRECISION )"
    ) in FLAT
    assert "LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public" in FLAT


def test_dedupes_observations_before_counting():
    assert "SELECT DISTINCT ON (s.zone_id, s.observed_at)" in FLAT
    assert "ORDER BY s.zone_id, s.observed_at, s.fetched_at DESC, s.id" in FLAT
    # 중복 제거가 시·요일 매칭과 백분위보다 먼저다.
    assert FLAT.index("DISTINCT ON") < FLAT.index("matched AS") < FLAT.index("percentile_cont(0.25)")
    assert "count(*)::INTEGER" in FLAT


def test_filters_replaced_missing_and_recent_observations():
    assert "(s.quality ->> 'replaced') IS DISTINCT FROM 'true'" in FLAT
    assert "s.population_min IS NOT NULL" in FLAT and "s.population_max IS NOT NULL" in FLAT
    assert "s.observed_at < p_at - interval '1 hour'" in FLAT
    assert "s.observed_at >= p_at - make_interval(days => t.days)" in FLAT
    assert "(s.population_min::DOUBLE PRECISION + s.population_max::DOUBLE PRECISION) / 2" in FLAT


def test_same_kst_hour_and_weekday_class():
    assert "AT TIME ZONE 'Asia/Seoul'" in FLAT
    assert "extract(hour FROM (d.observed_at AT TIME ZONE 'Asia/Seoul')) = extract(hour FROM t.local_at)" in FLAT
    assert "IN (6, 7)" in FLAT


def test_percentiles():
    for q in ("0.25", "0.50", "0.75"):
        assert f"percentile_cont({q}) WITHIN GROUP (ORDER BY m.population_mid)" in FLAT


def test_service_role_only():
    assert f"REVOKE ALL ON FUNCTION {SIGNATURE} FROM PUBLIC, anon, authenticated;" in FLAT
    grants = re.findall(r"GRANT EXECUTE ON FUNCTION public\.zone_population_baseline\([^)]*\) TO (\w+);", FLAT)
    assert grants == ["service_role"]


def test_never_read_by_the_score():
    score = (ROOT / "apps/api/app/services/spot/score.py").read_text(encoding="utf-8")
    assert "zone_population_baseline" not in score


def test_reset_prelude_drops_the_function():
    statement = f"DROP FUNCTION IF EXISTS {SIGNATURE} CASCADE;"
    builder = (ROOT / "scripts/build_reset.mjs").read_text(encoding="utf-8")
    reset = (ROOT / "supabase/RESET_AND_SETUP.sql").read_text(encoding="utf-8")
    assert statement in builder
    assert statement in reset
    assert f"migrations/{NAME}" in reset
