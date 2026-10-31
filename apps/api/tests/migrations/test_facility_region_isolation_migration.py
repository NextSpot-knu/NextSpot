"""20261101090000 — 시설 지역 격리(SEOUL_TESTBED_PLAN §6 S3 · §7 A1).

로컬에 Postgres 가 없어 계약을 글자로 고정한다. 행동은 PGlite 로 한 번 돌려 확인했다 — 서울 상자 위반 행이 있으면 예외로
전체 롤백 · 재적용 멱등 · anon·authenticated(개발자 포함)는 서울 행 0 · service_role 은 보임 · 옛 USING (true) 정책을
다시 만들어도 서울은 닫힘 · 자식 표 6개가 서울 시설 id 를 P0001 로 거부 · 서울 방문 확인 답은 오류 없이 투영 생략 ·
region 변경 거부 · 트리거 끄기/정책 삭제·허용형 전환·WITH CHECK 누락·옛 투영 본문 복원마다 상태 0.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
MIGRATIONS = ROOT / "supabase/migrations"
NAME = "20261101090000_facility_region_isolation.sql"
SQL = (MIGRATIONS / NAME).read_text(encoding="utf-8")
CODE = re.sub(r"--[^\n]*", "", SQL)  # 주석의 문장이 증거가 되지 않게
FLAT = " ".join(CODE.split())

CHILD_TABLES = (
    "congestion_logs",
    "facility_source_refs",
    "merchant_timesales",
    "facility_owners",
    "facility_availability_reports",
    "business_verification_requests",
)
SEOUL_BBOX = ("37.41", "37.72", "126.76", "127.19")


def _function(code: str, name: str) -> str:
    start = code.index(f"FUNCTION public.{name}(")
    body_open = code.index("$$", start)
    return code[start:code.index("$$;", body_open + 2) + 3]


def _squash(text: str) -> str:
    return " ".join(text.split())


def test_timestamp_sorts_after_the_guest_crowd_answer_migration():
    names = sorted(p.name for p in MIGRATIONS.glob("*.sql"))
    assert NAME > "20261031130000_guest_crowd_answer_shadow.sql"
    assert names.index(NAME) > names.index("20261031130000_guest_crowd_answer_shadow.sql")


def test_region_column_default_check_and_index():
    assert "ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'gyeongju'" in FLAT
    assert "ADD CONSTRAINT facilities_region_known CHECK (region IN ('gyeongju', 'seoul'))" in FLAT
    assert "conname = 'facilities_region_known'" in FLAT  # 재적용 시 중복 추가하지 않는다
    assert "CREATE INDEX IF NOT EXISTS idx_facilities_region_active ON public.facilities (region, is_active)" in FLAT


def test_seoul_bbox_checks_validate_and_raise_on_violators():
    for name in ("facilities_seoul_coords_need_seoul_region", "facilities_seoul_region_needs_seoul_coords"):
        assert f"ADD CONSTRAINT {name} CHECK (" in FLAT
        assert f"conname = '{name}'" in FLAT
        assert f"VALIDATE CONSTRAINT {name};" in FLAT
        # NOT VALID 로 붙이고 바로 VALIDATE 한다.
        add_at = FLAT.index(f"ADD CONSTRAINT {name}")
        assert "NOT VALID" in FLAT[add_at:FLAT.index(";", add_at)]
    for number in SEOUL_BBOX:
        assert FLAT.count(number) >= 4  # 위반 집계 2번 + CHECK 2개
    assert "latitude BETWEEN 37.41 AND 37.72 AND longitude BETWEEN 126.76 AND 127.19" in FLAT
    check_block = FLAT[FLAT.index("v_violators INTEGER") : FLAT.index("VALIDATE CONSTRAINT facilities_seoul_region_needs")]
    assert "IF v_violators > 0 THEN RAISE EXCEPTION" in check_block
    assert "RAISE NOTICE" not in check_block and "RAISE WARNING" not in check_block
    # 위반 집계가 제약 추가보다 먼저다(반쯤 걸린 제약을 남기지 않는다).
    assert check_block.index("RAISE EXCEPTION") < check_block.index("ADD CONSTRAINT")


def test_restrictive_policy_is_new_and_covers_both_browser_roles():
    assert "DROP POLICY IF EXISTS facilities_public_region_only ON public.facilities;" in FLAT
    assert (
        "CREATE POLICY facilities_public_region_only ON public.facilities AS RESTRICTIVE FOR ALL "
        "TO anon, authenticated USING (region = 'gyeongju') WITH CHECK (region = 'gyeongju');"
    ) in FLAT
    assert "ALTER TABLE public.facilities ENABLE ROW LEVEL SECURITY;" in FLAT
    # 이 이름은 이 파일 말고 어떤 마이그레이션에도 없다 — 옛 파일 재실행이 지우거나 넓힐 수 없다.
    for path in MIGRATIONS.glob("*.sql"):
        if path.name != NAME:
            assert "facilities_public_region_only" not in path.read_text(encoding="utf-8"), path.name


def test_permissive_policies_rewritten_with_the_region_predicate():
    assert (
        "CREATE POLICY select_facilities ON public.facilities FOR SELECT TO authenticated USING (region = 'gyeongju');"
    ) in FLAT
    assert "CREATE POLICY anon_select_facilities ON public.facilities FOR SELECT TO anon USING (region = 'gyeongju');" in FLAT
    assert (
        "CREATE POLICY admin_all_facilities ON public.facilities FOR ALL TO authenticated "
        "USING (region = 'gyeongju' AND public.is_admin_or_dev()) "
        "WITH CHECK (region = 'gyeongju' AND public.is_admin_or_dev());"
    ) in FLAT
    for name in ("select_facilities", "anon_select_facilities", "admin_all_facilities"):
        assert f"DROP POLICY IF EXISTS {name} ON public.facilities;" in FLAT


def test_no_browser_facilities_policy_without_the_region_predicate():
    policies = re.findall(r"CREATE POLICY (\w+) ON public\.facilities (.*?);", FLAT)
    assert {name for name, _ in policies} == {
        "facilities_public_region_only",
        "select_facilities",
        "anon_select_facilities",
        "admin_all_facilities",
    }
    for name, body in policies:
        assert re.search(r"\bTO\b.*\b(anon|authenticated)\b", body), name
        assert "USING (region = 'gyeongju'" in body, name
        assert "USING (true)" not in body, name


@pytest.mark.parametrize("table", CHILD_TABLES)
def test_child_table_triggers(table):
    trigger = f"trg_{table}_public_region"
    assert f"DROP TRIGGER IF EXISTS {trigger} ON public.{table};" in FLAT
    assert (
        f"CREATE TRIGGER {trigger} BEFORE INSERT OR UPDATE OF facility_id ON public.{table} "
        "FOR EACH ROW EXECUTE FUNCTION public.reject_non_public_region_facility();"
    ) in FLAT
    # 상태 점검 함수가 같은 트리거를 센다.
    assert f"(to_regclass('public.{table}')::OID, '{trigger}'::NAME)" in FLAT


def test_exactly_six_child_triggers_including_business_verification_requests():
    triggers = re.findall(r"CREATE TRIGGER (trg_\w+_public_region) ", FLAT)
    assert sorted(triggers) == sorted(f"trg_{t}_public_region" for t in CHILD_TABLES)
    assert "trg_business_verification_requests_public_region" in triggers
    assert "IF v_child_triggers <> 6 THEN RETURN 0;" in FLAT


def test_child_guard_function_raises_p0001_and_tolerates_null():
    body = _squash(_function(CODE, "reject_non_public_region_facility"))
    assert "SECURITY DEFINER" in body
    assert "SET search_path = public" in body
    assert "IF NEW.facility_id IS NULL THEN RETURN NEW;" in body
    assert "IF v_region IS NOT NULL AND v_region <> 'gyeongju' THEN" in body
    assert "RAISE EXCEPTION 'facility_region_not_public' USING ERRCODE = 'P0001';" in body
    assert "REVOKE ALL ON FUNCTION public.reject_non_public_region_facility() FROM PUBLIC, anon, authenticated;" in FLAT


def test_projection_replacement_is_the_d3_body_plus_one_region_line():
    source = (MIGRATIONS / "20261031130000_guest_crowd_answer_shadow.sql").read_text(encoding="utf-8")
    original = _function(source, "project_outcome_congestion_log")
    replaced = _function(SQL, "project_outcome_congestion_log")  # 함수 본문 안의 주석까지 그대로인지 원문으로 본다
    assert "CREATE OR REPLACE FUNCTION public.project_outcome_congestion_log()" in SQL
    added = [line for line in replaced.splitlines() if "f.region = 'gyeongju'" in line]
    assert [line.strip() for line in added] == ["AND f.region = 'gyeongju'"]
    without = "\n".join(line for line in replaced.splitlines() if line not in added)
    assert _squash(without) == _squash(original)
    # 추가 줄은 facilities 조인 바로 뒤에 있다.
    lines = replaced.splitlines()
    join_at = next(i for i, line in enumerate(lines) if "JOIN public.facilities AS f ON f.id = r.recommended_facility_id" in line)
    assert lines[join_at + 1] == added[0]
    # 트리거는 같은 함수를 계속 가리키므로 다시 만들지 않는다.
    assert "CREATE TRIGGER project_outcome_congestion_log" not in CODE


def test_region_is_frozen():
    body = _squash(_function(CODE, "freeze_facility_region"))
    assert "IF OLD.region IS DISTINCT FROM NEW.region THEN" in body
    assert "RAISE EXCEPTION 'facility_region_immutable'" in body
    assert "DROP TRIGGER IF EXISTS trg_facilities_freeze_region ON public.facilities;" in FLAT
    assert (
        "CREATE TRIGGER trg_facilities_freeze_region BEFORE UPDATE OF region ON public.facilities "
        "FOR EACH ROW EXECUTE FUNCTION public.freeze_facility_region();"
    ) in FLAT


def test_isolation_marker_introspects_and_is_service_role_only():
    body = _squash(_function(CODE, "region_isolation_status"))
    assert "RETURNS INTEGER" in body
    assert "STABLE SECURITY DEFINER SET search_path = pg_catalog, public" in body
    assert "c.relrowsecurity" in body
    assert "p.polname = 'facilities_public_region_only'" in body
    assert "AND NOT p.polpermissive" in body
    assert "@> ARRAY['anon', 'authenticated']" in body
    assert "pg_get_expr(p.polqual, p.polrelid) LIKE '%region = ''gyeongju''%'" in body
    assert "pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%region = ''gyeongju''%'" in body
    assert body.count("t.tgenabled <> 'D'") == 2  # 자식 6개 + freeze
    assert "t.tgname = 'trg_facilities_freeze_region'" in body
    assert "position('f.region = ''gyeongju''' IN p.prosrc) > 0" in body
    assert "RETURN 1;" in body
    assert "REVOKE ALL ON FUNCTION public.region_isolation_status() FROM PUBLIC, anon, authenticated;" in FLAT
    grants = re.findall(r"GRANT EXECUTE ON FUNCTION public\.region_isolation_status\(\) TO (\w+);", FLAT)
    assert grants == ["service_role"]


def test_migration_ends_by_asserting_isolation():
    tail = FLAT[FLAT.rindex("DO $$") :]
    assert "IF public.region_isolation_status() <> 1 THEN RAISE EXCEPTION 'region isolation incomplete';" in tail
    assert FLAT.rindex("DO $$") > FLAT.index("GRANT EXECUTE ON FUNCTION public.region_isolation_status()")


@pytest.mark.parametrize(
    "statement",
    [
        "DROP FUNCTION IF EXISTS public.reject_non_public_region_facility() CASCADE;",
        "DROP FUNCTION IF EXISTS public.freeze_facility_region() CASCADE;",
        "DROP FUNCTION IF EXISTS public.region_isolation_status() CASCADE;",
        "DROP FUNCTION IF EXISTS public.project_outcome_congestion_log() CASCADE;",
    ],
)
def test_reset_prelude_drops_the_new_functions(statement):
    builder = (ROOT / "scripts/build_reset.mjs").read_text(encoding="utf-8")
    reset = (ROOT / "supabase/RESET_AND_SETUP.sql").read_text(encoding="utf-8")
    assert statement in builder
    assert statement in reset
    assert f"migrations/{NAME}" in reset


# ── 추천 이력 격리(관제 계정이 개발자의 서울 추천 행을 브라우저에서 읽지 못한다) ─────────────────────────────
# PGlite 로 행동도 확인했다: admin 은 경주 추천(시설이 지워진 경주 행 포함)만, 개발자는 자기 행 전부 + 경주, 관광객은
# 자기 행만(종전과 같다), 서울 시설이 지워져 id 가 NULL 이 된 행도 스냅샷 지역 표시로 숨는다.

REC_POLICY = (
    "CREATE POLICY recommendations_public_region_only ON public.recommendations AS RESTRICTIVE FOR SELECT "
    "TO anon, authenticated USING ( user_id = auth.uid() OR ( (recommendation_snapshot ->> 'region') IS NULL "
    "AND (recommended_facility_id IS NULL OR EXISTS (SELECT 1 FROM public.facilities AS f "
    "WHERE f.id = recommendations.recommended_facility_id)) "
    "AND (original_facility_id IS NULL OR EXISTS (SELECT 1 FROM public.facilities AS f "
    "WHERE f.id = recommendations.original_facility_id)) ) );"
)
FEEDBACK_POLICY = (
    "CREATE POLICY user_feedback_public_region_only ON public.user_feedback AS RESTRICTIVE FOR SELECT "
    "TO anon, authenticated USING ( user_id = auth.uid() "
    "OR EXISTS (SELECT 1 FROM public.recommendations AS r WHERE r.id = user_feedback.recommendation_id) );"
)
FACILITIES_POLICY = (
    "CREATE POLICY facilities_public_region_only ON public.facilities AS RESTRICTIVE FOR ALL "
    "TO anon, authenticated USING (region = 'gyeongju') WITH CHECK (region = 'gyeongju');"
)


def _top_level() -> str:
    """함수 본문($$ … $$)을 뺀 최상위 문장들."""
    return _squash(re.sub(r"\$\$.*?\$\$", "", CODE, flags=re.S))


def test_recommendation_history_is_restricted_for_browser_roles():
    top = _top_level()
    for table, name, policy in (
        ("recommendations", "recommendations_public_region_only", REC_POLICY),
        ("user_feedback", "user_feedback_public_region_only", FEEDBACK_POLICY),
    ):
        assert f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY;" in top
        assert f"DROP POLICY IF EXISTS {name} ON public.{table};" in top
        assert policy in top, name
        for path in MIGRATIONS.glob("*.sql"):
            if path.name != NAME:
                assert name not in path.read_text(encoding="utf-8"), path.name


def test_status_requires_the_recommendation_history_policies():
    body = _squash(_function(CODE, "region_isolation_status"))
    assert "p.polname = 'recommendations_public_region_only'" in body
    assert "p.polname = 'user_feedback_public_region_only'" in body
    assert "SELECT count(*) = 2 INTO v_ok FROM pg_policy AS p WHERE NOT p.polpermissive AND p.polcmd = 'r'" in body
    assert "to_regclass('public.recommendations'), to_regclass('public.user_feedback')" in body


def test_containment_rpc_recreates_the_same_policies_and_is_service_role_only():
    body = _squash(_function(CODE, "region_guard_contain"))
    assert "RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public" in body
    for table in ("facilities", "recommendations", "user_feedback"):
        assert f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY;" in body
    # 최상위 정의와 글자 그대로 같다 — 봉쇄가 다른(더 느슨한) 정책을 만들지 않는다.
    for policy in (FACILITIES_POLICY, REC_POLICY, FEEDBACK_POLICY):
        assert policy in body
        assert policy in _top_level()
    assert "RETURN public.region_isolation_status();" in body
    assert "REVOKE ALL ON FUNCTION public.region_guard_contain() FROM PUBLIC, anon, authenticated;" in FLAT
    grants = re.findall(r"GRANT EXECUTE ON FUNCTION public\.region_guard_contain\(\) TO (\w+);", FLAT)
    assert grants == ["service_role"]
    builder = (ROOT / "scripts/build_reset.mjs").read_text(encoding="utf-8")
    assert "DROP FUNCTION IF EXISTS public.region_guard_contain() CASCADE;" in builder
