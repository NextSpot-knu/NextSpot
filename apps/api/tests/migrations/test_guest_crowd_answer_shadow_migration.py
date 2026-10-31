"""20261031130000 — 게스트 방문 확인 체감 혼잡 그림자 모드(PRODUCT_EVALUATION_PLAN §6 D3).

로컬에 Postgres 가 없어 계약을 글자로 고정한다(행동은 PGlite 로 한 번 돌려 확인했다 — 그림자 0행 · 계정 사용자 예전 그대로 ·
실시간 게스트 같은 네트워크 single_report · 다른 네트워크/계정 사용자/실측 일치 corroborated · auth 행 없음 = 그림자).
"""
import re
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[4]
_NAME = "20261031130000_guest_crowd_answer_shadow.sql"
_SQL = (_ROOT / "supabase/migrations" / _NAME).read_text(encoding="utf-8")
_CODE = re.sub(r"--[^\n]*", "", _SQL)  # 주석 빼고 본다


def _function(name: str) -> str:
    start = _CODE.index(f"FUNCTION public.{name}(")
    body_open = _CODE.index("$$", start)
    return _CODE[start:_CODE.index("$$;", body_open + 2)]


def test_idempotent_shapes():
    assert "ADD COLUMN IF NOT EXISTS observed_answer_mode" in _CODE
    assert "ADD COLUMN IF NOT EXISTS observed_at" in _CODE
    assert "ADD COLUMN IF NOT EXISTS reporter_is_guest BOOLEAN NOT NULL DEFAULT false" in _CODE
    assert "ADD COLUMN IF NOT EXISTS reporter_network_hash" in _CODE
    for trigger in (
        "classify_outcome_congestion_answer",
        "project_outcome_congestion_log",
        "correlate_congestion_report_evidence",
    ):
        assert f"DROP TRIGGER IF EXISTS {trigger}" in _CODE


def test_guest_is_decided_by_auth_users_and_fails_closed():
    body = _function("classify_outcome_congestion_answer")
    assert "FROM auth.users AS u WHERE u.id = NEW.user_id" in body
    assert "COALESCE(v_is_anonymous, true)" in body  # auth 행이 없으면 게스트로 본다
    assert "NEW.observed_answer_mode := 'registered'" in body
    assert "NEW.observed_network_hash := NULL" in body  # 계정 사용자 네트워크 키는 남기지 않는다
    assert "IS DISTINCT FROM 'guest_live'" in body and "'guest_shadow'" in body
    assert "BEFORE INSERT OR UPDATE OF observed_congestion" in _CODE


def test_shadow_answers_never_reach_congestion_logs():
    body = _function("project_outcome_congestion_log")
    assert body.index("NEW.observed_answer_mode = 'guest_shadow'") < body.index("INSERT INTO public.congestion_logs")
    assert "reporter_is_guest, reporter_network_hash" in body


def test_corroboration_keeps_registered_rule_and_gates_guest_only_agreement():
    body = _function("correlate_congestion_report_evidence")
    assert "count(DISTINCT reporter_user_id) FILTER (WHERE NOT reporter_is_guest)" in body
    assert "count(DISTINCT reporter_network_hash) FILTER (WHERE reporter_is_guest)" in body
    assert "IF matching_users < 2 THEN" in body
    assert "IF registered_users = 0 AND guest_networks < 2 THEN" in body
    assert "m.evidence_tier = 'verified'" in body
    assert "abs(congestion_level - NEW.congestion_level) <= 0.05" in body  # 기존 일치 기준 그대로


def test_rpc_signature_is_backward_compatible_and_service_role_only():
    assert "DROP FUNCTION IF EXISTS public.record_recommendation_outcome(UUID, UUID, TEXT, TEXT, TEXT);" in _CODE
    body = _function("record_recommendation_outcome")
    assert "p_network_hash TEXT DEFAULT NULL" in body
    assert "p_guest_answer_live BOOLEAN DEFAULT false" in body
    assert "auth.role() <> 'service_role'" in body
    assert "invalid network hash" in body
    assert body.count("observed_answer_mode = requested_mode") == 2
    assert (
        "GRANT EXECUTE ON FUNCTION public.record_recommendation_outcome(UUID, UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN)\n"
        "    TO service_role;"
    ) in _SQL


def test_network_hash_retention_is_scheduled_and_columns_stay_private():
    assert "interval '30 days'" in _function("purge_expired_network_hashes")
    assert "'nextspot-network-hash-retention'" in _CODE
    assert "cron.unschedule" in _CODE
    assert "observed_network_hash ~ '^[0-9a-f]{32}$'" in _CODE
    # congestion_logs 는 컬럼 GRANT — 새 컬럼을 브라우저 역할에 주지 않는다.
    assert not re.search(r"GRANT\s+SELECT\s*\([^)]*reporter_", _CODE)


def test_metrics_function_is_service_role_only_and_bounded():
    body = _function("guest_crowd_answer_shadow_metrics")
    assert "auth.role() <> 'service_role'" in body
    assert "LEAST(GREATEST(COALESCE(p_days, 14), 1), 30)" in body
    assert (
        "REVOKE ALL ON FUNCTION public.guest_crowd_answer_shadow_metrics(INTEGER) FROM PUBLIC, anon, authenticated"
        in _CODE
    )


def test_build_reset_prelude_drops_new_functions():
    prelude = (_ROOT / "scripts/build_reset.mjs").read_text(encoding="utf-8")
    for signature in (
        "record_recommendation_outcome(UUID, UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN)",
        "classify_outcome_congestion_answer()",
        "congestion_level_band(DOUBLE PRECISION)",
        "purge_expired_network_hashes()",
        "guest_crowd_answer_shadow_metrics(INTEGER)",
    ):
        assert f"DROP FUNCTION IF EXISTS public.{signature} CASCADE;" in prelude
