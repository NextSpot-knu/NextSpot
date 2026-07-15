from pathlib import Path


def test_recommendation_source_migration_has_safe_default_and_check():
    migration = (
        Path(__file__).parents[3]
        / "supabase"
        / "migrations"
        / "20260716150000_recommendation_source.sql"
    ).read_text(encoding="utf-8")
    normalized = " ".join(migration.lower().split())
    assert "source text not null default 'spot'" in normalized
    assert "check (source in ('spot', 'browse'))" in normalized
