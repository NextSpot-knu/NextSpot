from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "supabase" / "migrations" / "20260825190000_add_facility_availability_reports.sql"


def test_availability_reports_are_short_lived_and_corroborated():
    sql = MIGRATION.read_text(encoding="utf-8")
    assert "UNIQUE (facility_id, reporter_user_id)" in sql
    assert "COUNT(DISTINCT reporter_user_id)" in sql
    assert "opposing.status <> report.status" in sql
    assert "INTERVAL '30 minutes'" in sql
    assert "INTERVAL '60 minutes'" in sql
    assert "evidence_tier IN ('single_report', 'corroborated')" in sql


def test_availability_rpc_is_service_role_only():
    sql = MIGRATION.read_text(encoding="utf-8")
    assert "auth.role() <> 'service_role'" in sql
    assert "REVOKE ALL ON FUNCTION public.record_facility_availability_report" in sql
    assert "FROM PUBLIC, anon, authenticated" in sql
    assert "TO service_role" in sql


def test_guest_merge_cannot_double_count_one_person():
    sql = MIGRATION.read_text(encoding="utf-8")
    assert "RENAME TO merge_guest_account_data_without_availability" in sql
    assert "guest_report.facility_id = target_report.facility_id" in sql
    assert "SET reporter_user_id = p_target_user_id" in sql
    assert "opposing.facility_id = report.facility_id" in sql
    assert "'availability_reports', moved_count" in sql
