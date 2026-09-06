from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
MIGRATION = ROOT / "supabase/migrations/20260821140000_deactivate_unverified_demo_facilities.sql"


def test_unverified_demo_places_are_deactivated_and_verified_gyochon_is_preserved():
    sql = MIGRATION.read_text(encoding="utf-8")
    assert "SET is_active = false" in sql
    assert "unverified_demo_seed" in sql
    assert "f2000000-0000-0000-0000-000000000001" in sql
    assert "f2000000-0000-0000-0000-000000000002" in sql
    assert "f4000000-0000-0000-0000-000000000002" not in sql
