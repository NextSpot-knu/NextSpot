# LLM 어댑터(llm_client) — 무해 폴백 계약 검증.
# 계약: 키 미설정/타임아웃/HTTP 오류/JSON 파싱 실패 → 전부 None (예외 금지, 네트워크 강제 금지).

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.core.config import settings
from app.services import llm_client


def test_extract_json_variants():
    # 1. 관대한 JSON 추출 — 코드펜스·전후 설명·공백 흡수, 비정형은 None
    assert llm_client.extract_json('{"a": 1}') == {"a": 1}
    assert llm_client.extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert llm_client.extract_json('설명입니다: {"a": {"b": 2}} 끝.') == {"a": {"b": 2}}
    assert llm_client.extract_json("[1, 2]") is None  # dict 아님
    assert llm_client.extract_json("{깨진 json}") is None
    assert llm_client.extract_json("json 없음") is None
    assert llm_client.extract_json(None) is None
    assert llm_client.extract_json(123) is None


def test_is_enabled_false_without_key():
    # 2. conftest 가 UPSTAGE_API_KEY="" 로 고정 — 테스트 환경에선 항상 비활성
    assert llm_client.is_enabled() is False


@pytest.mark.asyncio
async def test_chat_disabled_returns_none_without_network():
    # 3. 비활성 상태에선 네트워크 접근 자체가 없어야 한다(_get_client 호출 시 실패하도록 패치)
    with patch.object(llm_client, "_get_client", side_effect=AssertionError("network touched")):
        assert await llm_client.chat_text("s", "u") is None
        assert await llm_client.chat_json("s", "u") is None


@pytest.mark.asyncio
async def test_chat_timeout_returns_none(monkeypatch):
    # 4. 키가 있어도 타임아웃이면 None — 호출자는 키워드 경로 유지(무해 폴백)
    monkeypatch.setattr(settings, "UPSTAGE_API_KEY", "test-key")
    monkeypatch.setattr(llm_client, "_client", None)  # 헤더 재구성 + 테스트 후 원복
    with patch.object(
        httpx.AsyncClient, "post", new=AsyncMock(side_effect=httpx.TimeoutException("slow"))
    ):
        assert await llm_client.chat_text("s", "u") is None


@pytest.mark.asyncio
async def test_chat_http_error_returns_none(monkeypatch):
    # 5. 429/5xx 등 HTTP 오류도 None (raise_for_status 경로)
    monkeypatch.setattr(settings, "UPSTAGE_API_KEY", "test-key")
    monkeypatch.setattr(llm_client, "_client", None)
    error_response = httpx.Response(429, request=httpx.Request("POST", "https://t.test"))
    with patch.object(httpx.AsyncClient, "post", new=AsyncMock(return_value=error_response)):
        assert await llm_client.chat_text("s", "u") is None


@pytest.mark.asyncio
async def test_chat_json_success_and_garbage(monkeypatch):
    # 6. chat_text 성공 시 JSON 파싱까지 — 정상은 dict, 깨진 출력은 None
    async def ok(*_a, **_k):
        return '```json\n{"action": "filter"}\n```'

    async def garbage(*_a, **_k):
        return "그냥 문장입니다"

    monkeypatch.setattr(llm_client, "chat_text", ok)
    assert await llm_client.chat_json("s", "u") == {"action": "filter"}
    monkeypatch.setattr(llm_client, "chat_text", garbage)
    assert await llm_client.chat_json("s", "u") is None
