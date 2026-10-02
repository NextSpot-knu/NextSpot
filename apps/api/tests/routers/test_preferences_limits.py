# POST /api/v1/preferences/parse — 게스트 허용 + 유량 제한(HANDOVER 보안 진단 '상', 2026-10-02).
# 추천 화면의 '말로 취향 입력'은 익명 세션으로 부른다 → is_anonymous 를 막지 않고 IP 로 묶는다.
# (리밋 저장소·예산은 conftest._isolate_llm_limits 가 테스트마다 비운다.)

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import jwt
import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app
from app.routers import preferences as prefs
from app.services import llm_client
from app.services.preference_vector_service import preference_vector_service

_URL = "/api/v1/preferences/parse"
_UNPARSEABLE = "아무거나 좋아요"  # 키워드 전량 미스(test_preferences.py 와 같은 발화)
_PARSEABLE = "조용한 카페가 좋아요"


class _Table:
    def __init__(self, name: str, writes: list):
        self._name = name
        self._writes = writes

    def update(self, payload):
        self._writes.append((self._name, "update", payload))
        return self

    def __getattr__(self, _name):
        return lambda *_a, **_k: self

    def execute(self):
        return type("R", (), {"data": []})()


class _Supabase:
    def __init__(self):
        self.writes: list = []

    def table(self, name: str) -> _Table:
        return _Table(name, self.writes)


@pytest.fixture
def recorder(monkeypatch):
    db = _Supabase()
    monkeypatch.setattr(prefs, "supabase_admin", db)
    upsert = AsyncMock()
    monkeypatch.setattr(preference_vector_service, "upsert_user_vector", upsert)
    return db, upsert


def _headers(sub: str = "anon-guest-1", *, anonymous: bool = True) -> dict:
    claims = {
        "sub": sub,
        "aud": "authenticated",
        "role": "authenticated",
        "exp": datetime.now(timezone.utc) + timedelta(hours=1),
    }
    if anonymous:
        claims["is_anonymous"] = True
    return {"Authorization": f"Bearer {jwt.encode(claims, settings.JWT_SECRET, algorithm='HS256')}"}


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def chat(monkeypatch) -> AsyncMock:
    monkeypatch.setattr(llm_client, "is_enabled", lambda: True)
    mock = AsyncMock(return_value={"preferred_categories": ["cafe"], "attributes": []})
    monkeypatch.setattr(llm_client, "chat_json", mock)
    return mock


def test_anonymous_guest_can_still_apply_preference(client, recorder):
    # 실제 get_current_user 경로(오버라이드 없음)로 익명 JWT 를 태운다 — 게스트 흐름이 살아 있어야 한다.
    _db, upsert = recorder
    res = client.post(_URL, json={"text": _PARSEABLE}, headers=_headers())
    assert res.status_code == 200
    assert res.json()["applied"] is True
    upsert.assert_awaited_once()


def test_missing_token_is_still_401(client, recorder):
    assert client.post(_URL, json={"text": _PARSEABLE}).status_code in (401, 403)


def test_request_limit_returns_429_and_writes_nothing_past_it(client, recorder):
    db, upsert = recorder
    headers = _headers("signed-in-1", anonymous=False)
    for _ in range(prefs._PARSE_RATE_LIMIT):
        assert client.post(_URL, json={"text": _PARSEABLE}, headers=headers).status_code == 200
    writes_before = len(db.writes)
    limited = client.post(_URL, json={"text": _PARSEABLE}, headers=headers)
    assert limited.status_code == 429
    assert int(limited.headers["Retry-After"]) >= 1
    assert len(db.writes) == writes_before  # 429 는 저장 경로에 들어가지 않는다
    assert upsert.await_count == prefs._PARSE_RATE_LIMIT


def test_limit_is_per_ip_not_per_token(client, recorder):
    # 익명 JWT 는 무료로 새로 받을 수 있다 — 토큰을 바꿔도 같은 IP 면 같은 한도.
    for i in range(prefs._PARSE_RATE_LIMIT):
        assert client.post(_URL, json={"text": _PARSEABLE}, headers=_headers(f"anon-{i}")).status_code == 200
    limited = client.post(_URL, json={"text": _PARSEABLE}, headers=_headers("anon-fresh"))
    assert limited.status_code == 429


def test_llm_limit_degrades_to_gated_and_writes_nothing(client, recorder, chat):
    db, upsert = recorder
    for _ in range(prefs._LLM_RATE_LIMIT):
        res = client.post(_URL, json={"text": _UNPARSEABLE}, headers=_headers())
        assert res.status_code == 200 and res.json()["llm_status"] == "llm"
    db.writes.clear()
    upsert.reset_mock()
    gated = client.post(_URL, json={"text": _UNPARSEABLE}, headers=_headers())
    assert gated.status_code == 200
    body = gated.json()
    assert body["llm_status"] == "gated"
    assert body["applied"] is False and body["reason"] == prefs.REASON_NO_PREFERENCE
    assert db.writes == [] and upsert.await_count == 0
    assert chat.await_count == prefs._LLM_RATE_LIMIT


def test_daily_budget_exhausted_keeps_keyword_path(client, recorder, chat, monkeypatch):
    monkeypatch.setattr(settings, "LLM_DAILY_BUDGET", 0)
    miss = client.post(_URL, json={"text": _UNPARSEABLE}, headers=_headers())
    assert miss.status_code == 200 and miss.json()["llm_status"] == "gated"
    hit = client.post(_URL, json={"text": _PARSEABLE}, headers=_headers())
    assert hit.json()["applied"] is True and hit.json()["llm_status"] == "keyword"
    chat.assert_not_awaited()
