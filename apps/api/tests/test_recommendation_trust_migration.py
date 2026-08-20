from pathlib import Path


def test_trust_migration_contains_atomic_rls_and_private_bucket_contracts():
    root = Path(__file__).resolve().parents[3]
    sql = (root / "supabase/migrations/20260819120000_recommendation_trust_loop.sql").read_text(encoding="utf-8")
    assert "'recommendation-models'" in sql and "false" in sql
    assert "uq_model_registry_one_active" in sql
    assert "record_recommendation_outcome" in sql
    assert "recommendation owner mismatch" in sql
    assert "navigation_started must be recorded first" in sql
    assert "ENABLE ROW LEVEL SECURITY" in sql
    assert "evidence_tier IN ('synthetic', 'single_report', 'corroborated', 'verified')" in sql


def test_collection_migration_projects_visit_observations_without_duplicates():
    root = Path(__file__).resolve().parents[3]
    sql = (root / "supabase/migrations/20260820123000_connect_congestion_collection.sql").read_text(
        encoding="utf-8"
    )
    assert "project_outcome_congestion_log" in sql
    assert "OLD.observed_congestion IS NOT NULL" in sql
    assert "recommended_facility_id" in sql
    assert "'merchant_report'" in sql
    assert "'single_report'" in sql
    assert "c.evidence_tier IN ('single_report', 'corroborated', 'verified')" in sql
    assert "c.source NOT IN ('seed', 'simulated')" in sql
