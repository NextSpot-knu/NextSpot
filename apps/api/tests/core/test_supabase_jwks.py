import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from jwt.exceptions import InvalidSignatureError, PyJWKClientConnectionError
from starlette.requests import Request

from app.core import supabase

_REAL_SLEEP = time.sleep


def _request() -> Request:
    return Request({"type": "http", "headers": []})


def _credentials():
    return SimpleNamespace(credentials="test.jwt.token")


@pytest.fixture
def asymmetric_jwt(monkeypatch):
    monkeypatch.setattr(supabase.jwt, "get_unverified_header", lambda _token: {"alg": "RS256"})
    monkeypatch.setattr(
        supabase.jwt,
        "decode",
        lambda *_args, **_kwargs: {
            "sub": "user-1",
            "email": "user@example.com",
            "role": "authenticated",
        },
    )
    monkeypatch.setattr(supabase.time, "sleep", lambda _seconds: None)


def test_jwks_connection_failure_retries_then_returns_user(monkeypatch, asymmetric_jwt):
    calls = 0

    class Client:
        def get_signing_key_from_jwt(self, _token):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise PyJWKClientConnectionError("temporary failure")
            return SimpleNamespace(key="public-key")

    monkeypatch.setattr(supabase, "_jwks_client", Client())

    user = supabase.get_current_user(_request(), _credentials())

    assert user["id"] == "user-1"
    assert calls == 2


def test_jwks_connection_failure_returns_service_unavailable(monkeypatch, asymmetric_jwt):
    calls = 0

    class Client:
        def get_signing_key_from_jwt(self, _token):
            nonlocal calls
            calls += 1
            raise PyJWKClientConnectionError("persistent failure")

    monkeypatch.setattr(supabase, "_jwks_client", Client())

    with pytest.raises(HTTPException) as exc_info:
        supabase.get_current_user(_request(), _credentials())

    assert exc_info.value.status_code == 503
    assert calls == 2


def test_jwt_signature_failure_remains_unauthorized(monkeypatch, asymmetric_jwt):
    class Client:
        def get_signing_key_from_jwt(self, _token):
            return SimpleNamespace(key="public-key")

    monkeypatch.setattr(supabase, "_jwks_client", Client())
    monkeypatch.setattr(
        supabase.jwt,
        "decode",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(InvalidSignatureError("bad signature")),
    )

    with pytest.raises(HTTPException) as exc_info:
        supabase.get_current_user(_request(), _credentials())

    assert exc_info.value.status_code == 401


# ── 시계 오차 ────────────────────────────────────────────────────────────────
# 토큰은 Supabase 가 서명하고 검증은 Render 워커가 한다 — 서로 다른 기계의 시계다.
# 몇 초 어긋나면 **방금 발급받은** 토큰이 401 이 되고, 화면에는 로그인 직후 인증 실패가 뜬다.

def _hs256(**claims) -> str:
    import jwt as pyjwt

    from app.core.config import settings

    return pyjwt.encode(
        {"sub": "user-1", "aud": "authenticated", **claims}, settings.JWT_SECRET, algorithm="HS256"
    )


def test_a_token_issued_a_few_seconds_in_the_future_is_accepted():
    """클라이언트/Auth 서버 시계가 조금 앞서면 iat·nbf 가 미래가 된다(ImmatureSignatureError)."""
    now = datetime.now(timezone.utc)
    token = _hs256(
        iat=now + timedelta(seconds=5),
        nbf=now + timedelta(seconds=5),
        exp=now + timedelta(hours=1),
    )
    assert supabase.verify_supabase_token(token)["sub"] == "user-1"


def test_a_token_expired_well_past_the_leeway_is_still_401():
    """유예는 시계 오차용이지 만료 무시용이 아니다 — 대조군."""
    now = datetime.now(timezone.utc)
    token = _hs256(iat=now - timedelta(hours=2), exp=now - timedelta(hours=1))
    with pytest.raises(HTTPException) as exc_info:
        supabase.verify_supabase_token(token)
    assert exc_info.value.status_code == 401


def test_concurrent_jwks_calls_share_one_fetch(monkeypatch, asymmetric_jwt):
    calls = 0
    cached = False

    class Client:
        def get_signing_key_from_jwt(self, _token):
            nonlocal calls, cached
            if not cached:
                calls += 1
                _REAL_SLEEP(0.05)
                cached = True
            return SimpleNamespace(key="public-key")

    monkeypatch.setattr(supabase, "_jwks_client", Client())

    with ThreadPoolExecutor(max_workers=4) as executor:
        users = list(executor.map(lambda _index: supabase.get_current_user(_request(), _credentials()), range(4)))

    assert [user["id"] for user in users] == ["user-1"] * 4
    assert calls == 1
