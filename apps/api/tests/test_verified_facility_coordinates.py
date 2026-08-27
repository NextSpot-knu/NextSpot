from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_woljeonggyo_is_reactivated_at_the_verified_bridge_location():
    migration = ROOT / "supabase/migrations/20260821150000_verify_woljeonggyo.sql"
    sql = " ".join(migration.read_text(encoding="utf-8").lower().split())

    assert "35.82929954620109" in sql
    assert "129.21812129691938" in sql
    assert "경북 경주시 교동 274" in sql
    assert "'kakao_place_id', '1839209698'" in sql
    assert "'kakao_place_url', 'https://place.map.kakao.com/1839209698'" in sql
    assert "operating_hours = '{\"weekday\":\"09:00-22:00\",\"weekend\":\"09:00-22:00\"}'::jsonb" in sql
    assert "is_active = true" in sql
    assert "'production_eligible', true" in sql


def test_woljeonggyo_verification_runs_after_demo_deactivation():
    deactivate = "20260821140000_deactivate_unverified_demo_facilities.sql"
    verify = "20260821150000_verify_woljeonggyo.sql"

    assert deactivate < verify
