from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "supabase" / "migrations" / "20260825120000_atomic_account_merge.sql"


def _sql() -> str:
    return MIGRATION.read_text(encoding="utf-8").lower()


def test_account_merge_is_service_role_only_and_transactional_rpc():
    sql = _sql()
    assert "create or replace function public.merge_guest_account_data" in sql
    assert "security definer" in sql
    assert "auth.role() <> 'service_role'" in sql
    assert "revoke all on function public.merge_guest_account_data" in sql
    assert "grant execute on function public.merge_guest_account_data" in sql


def test_account_merge_covers_all_user_owned_service_data():
    sql = _sql()
    for table in (
        "public.recommendations",
        "public.user_feedback",
        "public.recommendation_outcomes",
        "public.saved_facilities",
        "public.user_coupons",
        "public.user_preference_vectors",
        "public.congestion_logs",
        "public.inquiries",
    ):
        assert table in sql
    assert "for update" in sql
    assert "report_count = 0" in sql
    assert "foreign key (user_id) references public.users(id) on delete cascade" in sql
