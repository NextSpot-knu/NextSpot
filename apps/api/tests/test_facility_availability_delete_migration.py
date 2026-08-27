from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
MIGRATION = (
    ROOT
    / "supabase"
    / "migrations"
    / "20260825210000_recompute_availability_after_delete.sql"
)


def _sql() -> str:
    return MIGRATION.read_text(encoding="utf-8")


def test_deleted_report_immediately_recomputes_remaining_evidence():
    sql = _sql()
    assert "AFTER DELETE ON public.facility_availability_reports" in sql
    assert "FOR EACH ROW" in sql
    assert "recompute_facility_availability_evidence(OLD.facility_id)" in sql
    assert "COUNT(DISTINCT reporter_user_id)" in sql
    assert "counts.user_count >= 2" in sql
    assert "opposing.status <> report.status" in sql


def test_expired_retained_rows_can_have_zero_current_corroborators():
    sql = _sql()
    assert "CHECK (corroborating_count >= 0)" in sql
    assert "reported_at >= server_now - INTERVAL '30 minutes'" in sql
    assert "ELSE 'single_report'" in sql


def test_trigger_helpers_are_not_client_callable():
    sql = _sql()
    assert "REVOKE ALL ON FUNCTION public.recompute_facility_availability_evidence" in sql
    assert "REVOKE ALL ON FUNCTION public.refresh_facility_availability_after_delete" in sql
    assert "FROM PUBLIC, anon, authenticated" in sql
