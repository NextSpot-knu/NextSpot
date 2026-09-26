"""Supabase URL·키의 앞뒤 공백·줄바꿈을 설정 단계에서 걷는지.

2026-09-26 bd44110(Supabase 연결을 HTTP/1.1 로) 배포 직후 운영에서 service_role 호출이 전부 실패했다.
Render 환경변수의 키 끝에 '\\n' 이 붙어 있었고, h11 은 줄바꿈이 섞인 헤더 값을 연결도 열기 전에 거부한다
(LocalProtocolError "Illegal header value"). HTTP/2 시절에는 이 값이 문제를 드러내지 않았다.
"""
import h11
import pytest

from app.core.config import Settings

_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl"


def _settings(**overrides) -> Settings:
    values = {
        "SUPABASE_URL": "https://example.supabase.co",
        "SUPABASE_ANON_KEY": _KEY,
        "SUPABASE_SERVICE_ROLE_KEY": _KEY,
        "JWT_SECRET": "test-secret",
        "ADMIN_API_TOKEN": "test-admin-token",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


@pytest.mark.parametrize("field", ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"])
@pytest.mark.parametrize("junk", ["\n", "\r\n", " ", "\t\n"])
def test_supabase_values_are_stripped(field, junk):
    clean = _settings()
    dirty = _settings(**{field: f"{junk}{getattr(clean, field)}{junk}"})
    assert getattr(dirty, field) == getattr(clean, field)


def test_h11_rejects_a_key_with_a_trailing_newline_and_accepts_the_cleaned_one():
    # 운영에서 난 거부를 그대로 재현한다 — 걷지 않은 값은 헤더가 될 수 없다.
    with pytest.raises(h11.LocalProtocolError):
        h11.Request(method="GET", target="/", headers=[("host", "x"), ("apikey", f"{_KEY}\n")])

    cleaned = _settings(SUPABASE_SERVICE_ROLE_KEY=f"{_KEY}\n").SUPABASE_SERVICE_ROLE_KEY
    h11.Request(
        method="GET",
        target="/",
        headers=[("host", "x"), ("apikey", cleaned), ("authorization", f"Bearer {cleaned}")],
    )


def test_empty_service_role_key_stays_empty():
    # 비어 있으면 anon 폴백 경고(core/supabase.py)가 그대로 동작해야 한다.
    assert _settings(SUPABASE_SERVICE_ROLE_KEY="").SUPABASE_SERVICE_ROLE_KEY == ""
    assert _settings(SUPABASE_SERVICE_ROLE_KEY="  \n").SUPABASE_SERVICE_ROLE_KEY == ""
