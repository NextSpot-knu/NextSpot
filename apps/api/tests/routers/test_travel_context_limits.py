# POST /api/v1/travel-context/parse 유량 제한(HANDOVER 보안 진단 '상', 2026-10-02).
# 무인증 경로: 요청 리밋 초과는 429 + Retry-After, LLM 리밋·전역 일일 예산 초과는 429 가 아니라 "gated" 강등.
# (리밋 저장소·예산은 conftest._isolate_llm_limits 가 테스트마다 비운다.)

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.config import settings
from app.routers import travel_context as tc
from app.services import llm_client

app = FastAPI()
app.include_router(tc.router)

_URL = "/api/v1/travel-context/parse"
_KEYWORD_TEXT = "실내 문화시설"
_UNMATCHED_TEXT = "그냥 좀 다른 데"  # 키워드 사전 전량 미스 → LLM 백스톱 대상


@pytest.fixture
def chat(monkeypatch) -> AsyncMock:
    monkeypatch.setattr(llm_client, "is_enabled", lambda: True)
    mock = AsyncMock(return_value={"categories": ["cafe"]})
    monkeypatch.setattr(llm_client, "chat_json", mock)
    return mock


def test_request_limit_returns_429_with_retry_after():
    client = TestClient(app)
    for _ in range(tc._PARSE_RATE_LIMIT):
        assert client.post(_URL, json={"text": _KEYWORD_TEXT}).status_code == 200
    limited = client.post(_URL, json={"text": _KEYWORD_TEXT})
    assert limited.status_code == 429
    assert int(limited.headers["Retry-After"]) >= 1


def test_limit_is_keyed_by_last_xff_value_like_search():
    # 첫 값만 바꿔 위조해도 같은 키(마지막 값)로 묶인다 — search 리밋과 같은 키 규칙(core.rate_limit.client_ip).
    client = TestClient(app)
    for i in range(tc._PARSE_RATE_LIMIT):
        ok = client.post(
            _URL, json={"text": _KEYWORD_TEXT},
            headers={"x-forwarded-for": f"10.0.0.{i}, 203.0.113.7"},
        )
        assert ok.status_code == 200
    limited = client.post(
        _URL, json={"text": _KEYWORD_TEXT},
        headers={"x-forwarded-for": "10.9.9.9, 203.0.113.7"},
    )
    assert limited.status_code == 429
    other_visitor = client.post(
        _URL, json={"text": _KEYWORD_TEXT},
        headers={"x-forwarded-for": "198.51.100.1"},
    )
    assert other_visitor.status_code == 200


def test_llm_limit_degrades_to_gated_not_429(chat):
    client = TestClient(app)
    for _ in range(tc._LLM_RATE_LIMIT):
        res = client.post(_URL, json={"text": _UNMATCHED_TEXT})
        assert res.status_code == 200 and res.json()["llm_status"] == "llm"
    gated = client.post(_URL, json={"text": _UNMATCHED_TEXT})
    assert gated.status_code == 200
    assert gated.json() == {"context": {}, "llm_status": "gated", "requires_confirmation": True}
    assert chat.await_count == tc._LLM_RATE_LIMIT


def test_keyword_turns_do_not_spend_llm_limit(chat):
    client = TestClient(app)
    for _ in range(tc._LLM_RATE_LIMIT + 3):
        assert client.post(_URL, json={"text": _KEYWORD_TEXT}).json()["llm_status"] == "keyword"
    chat.assert_not_awaited()
    assert client.post(_URL, json={"text": _UNMATCHED_TEXT}).json()["llm_status"] == "llm"


def test_daily_budget_exhausted_falls_back_without_llm(chat, monkeypatch):
    monkeypatch.setattr(settings, "LLM_DAILY_BUDGET", 0)
    client = TestClient(app)
    res = client.post(_URL, json={"text": _UNMATCHED_TEXT})
    assert res.status_code == 200 and res.json()["llm_status"] == "gated"
    # 키워드 경로는 예산과 무관하게 그대로 답한다.
    kw = client.post(_URL, json={"text": _KEYWORD_TEXT})
    assert kw.json()["context"] == {"categories": ["culture"], "required_attributes": ["indoor"]}
    chat.assert_not_awaited()
