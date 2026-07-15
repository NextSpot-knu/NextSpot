import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from jwt.exceptions import PyJWKClientConnectionError
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


def test_jwks_connection_failure_remains_unauthorized(monkeypatch, asymmetric_jwt):
    calls = 0

    class Client:
        def get_signing_key_from_jwt(self, _token):
            nonlocal calls
            calls += 1
            raise PyJWKClientConnectionError("persistent failure")

    monkeypatch.setattr(supabase, "_jwks_client", Client())

    with pytest.raises(HTTPException) as exc_info:
        supabase.get_current_user(_request(), _credentials())

    assert exc_info.value.status_code == 401
    assert calls == 2


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
