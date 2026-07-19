from unittest.mock import AsyncMock

import pytest

from app.services import travel_context_parser


@pytest.mark.asyncio
async def test_keyword_context_is_allowlisted_and_skips_llm(monkeypatch):
    monkeypatch.setattr(travel_context_parser.llm_client, "is_enabled", lambda: True)
    chat = AsyncMock()
    monkeypatch.setattr(travel_context_parser.llm_client, "chat_json", chat)

    context, status = await travel_context_parser.parse_travel_context(
        "비가 와서 10분 안쪽 실내 문화시설로 가고 싶어"
    )

    assert context == {
        "categories": ["culture"],
        "max_walk_minutes": 10,
        "required_attributes": ["indoor"],
    }
    assert status == "keyword"
    chat.assert_not_awaited()


@pytest.mark.asyncio
async def test_llm_cannot_inject_ids_coordinates_or_unknown_values(monkeypatch):
    monkeypatch.setattr(travel_context_parser.llm_client, "is_enabled", lambda: True)
    monkeypatch.setattr(
        travel_context_parser.llm_client,
        "chat_json",
        AsyncMock(return_value={
            "categories": ["cafe", "hotel"],
            "max_walk_minutes": 7,
            "available_minutes": 60,
            "required_attributes": ["accessible", "parking"],
            "exclude_visited": True,
            "facility_id": "forced-place",
            "latitude": 35.8,
            "longitude": 129.2,
        }),
    )

    context, status = await travel_context_parser.parse_travel_context("조금 편하게 둘러볼래")

    assert context == {
        "categories": ["cafe"],
        "available_minutes": 60,
        "required_attributes": ["accessible"],
        "exclude_visited": True,
    }
    assert status == "llm"


@pytest.mark.asyncio
async def test_disabled_llm_has_harmless_empty_fallback(monkeypatch):
    monkeypatch.setattr(travel_context_parser.llm_client, "is_enabled", lambda: False)
    assert await travel_context_parser.parse_travel_context("조금 편하게 둘러볼래") == ({}, "disabled")

