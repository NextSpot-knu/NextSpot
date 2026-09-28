"""AREA_DEMAND_SOURCE — 권역 수요 전망 원본 스위치의 코드 기본값이 rpc 인지.

PM 결정(2026-09-28): 배포 자체는 고객에게 무변화여야 한다. env 를 비워 둔 운영 인스턴스는 도입 전 경로(rpc)로
돌아야 하고, shadow·matrix 는 Render env 로만 켠다. 모르는 값의 rpc 해석은 parking_history.mode() 가 맡는다.
"""
from app.core.config import Settings


def _settings(**overrides) -> Settings:
    values = {
        "SUPABASE_URL": "https://example.supabase.co",
        "SUPABASE_ANON_KEY": "anon",
        "JWT_SECRET": "test-secret",
        "ADMIN_API_TOKEN": "test-admin-token",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def test_code_default_is_rpc_when_env_is_unset(monkeypatch):
    monkeypatch.delenv("AREA_DEMAND_SOURCE", raising=False)
    assert _settings().AREA_DEMAND_SOURCE == "rpc"


def test_env_value_reaches_settings_unchanged(monkeypatch):
    # 정규화(strip·lower·허용 목록)는 설정이 아니라 읽는 쪽(parking_history.mode())에서 한다 — 설정은 원문 그대로.
    monkeypatch.setenv("AREA_DEMAND_SOURCE", "matrix ")
    assert _settings().AREA_DEMAND_SOURCE == "matrix "


def test_test_suite_runs_with_rpc():
    # conftest 가 고정한다 — 기존 테스트는 도입 전 경로를 검증한다.
    from app.core.config import settings

    assert settings.AREA_DEMAND_SOURCE == "rpc"
