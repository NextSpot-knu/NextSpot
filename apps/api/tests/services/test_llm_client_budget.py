# llm_client 전역 일일 예산(LLM_DAILY_BUDGET) — 소진은 '비활성'과 같은 None(네트워크 0).
# (예산 카운터는 conftest._isolate_llm_limits 가 테스트마다 비운다.)

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.core.config import settings
from app.services import llm_client


def _ok_response() -> httpx.Response:
    return httpx.Response(
        200,
        json={"choices": [{"message": {"content": "다듬은 문장"}}]},
        request=httpx.Request("POST", "https://t.test/chat/completions"),
    )


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(settings, "UPSTAGE_API_KEY", "test-key")
    monkeypatch.setattr(llm_client, "_client", None)


@pytest.mark.asyncio
async def test_budget_caps_network_calls_then_returns_none(enabled, monkeypatch):
    monkeypatch.setattr(settings, "LLM_DAILY_BUDGET", 2)
    post = AsyncMock(return_value=_ok_response())
    with patch.object(httpx.AsyncClient, "post", new=post):
        assert await llm_client.chat_text("s", "u") == "다듬은 문장"
        assert await llm_client.chat_text("s", "u") == "다듬은 문장"
        assert llm_client.budget_available() is False
        assert await llm_client.chat_text("s", "u") is None
        assert await llm_client.chat_json("s", "u") is None
    assert post.await_count == 2


@pytest.mark.asyncio
async def test_zero_budget_disables_llm_without_network(enabled, monkeypatch):
    monkeypatch.setattr(settings, "LLM_DAILY_BUDGET", 0)
    with patch.object(llm_client, "_get_client", side_effect=AssertionError("network touched")):
        assert llm_client.budget_available() is False
        assert await llm_client.chat_text("s", "u") is None


@pytest.mark.asyncio
async def test_budget_resets_on_new_kst_day(enabled, monkeypatch):
    monkeypatch.setattr(settings, "LLM_DAILY_BUDGET", 1)
    monkeypatch.setattr(llm_client, "_today_kst", lambda: "2026-10-02")
    post = AsyncMock(return_value=_ok_response())
    with patch.object(httpx.AsyncClient, "post", new=post):
        assert await llm_client.chat_text("s", "u") is not None
        assert await llm_client.chat_text("s", "u") is None
        monkeypatch.setattr(llm_client, "_today_kst", lambda: "2026-10-03")
        assert await llm_client.chat_text("s", "u") is not None
    assert post.await_count == 2


@pytest.mark.asyncio
async def test_failed_calls_still_count_against_budget(enabled, monkeypatch):
    # 비용 안전판이므로 실패한 호출(타임아웃 등)도 1회로 센다 — 실패 반복으로 상한을 우회할 수 없다.
    monkeypatch.setattr(settings, "LLM_DAILY_BUDGET", 1)
    post = AsyncMock(side_effect=httpx.TimeoutException("slow"))
    with patch.object(httpx.AsyncClient, "post", new=post):
        assert await llm_client.chat_text("s", "u") is None
        assert await llm_client.chat_text("s", "u") is None
    assert post.await_count == 1


def test_default_budget_is_positive():
    assert settings.LLM_DAILY_BUDGET > 0
