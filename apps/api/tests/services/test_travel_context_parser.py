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


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("돼지고기 먹고 싶어", {"categories": ["restaurant"]}),
        ("조용한 카페", {"categories": ["cafe"]}),
        ("비가 와서 실내", {"required_attributes": ["indoor"]}),
        ("너무 멀어서 가까운 곳", {"max_walk_minutes": 10}),
    ],
)
@pytest.mark.asyncio
async def test_golden_field_phrases_are_deterministic(monkeypatch, text, expected):
    monkeypatch.setattr(travel_context_parser.llm_client, "is_enabled", lambda: False)
    context, status = await travel_context_parser.parse_travel_context(text)
    assert context == expected
    assert status == "keyword"


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


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # 유모차는 휠체어(accessible)가 아니라 stroller 다 — 근거가 다른 조건(travel_context 참조).
        ("유모차 끌고 갈 만한 곳", ["stroller"]),
        ("We have a stroller", ["stroller"]),
        ("ベビーカーで行ける場所", ["stroller"]),
        ("推着婴儿车能去的地方", ["stroller"]),
        ("휠체어로 갈 수 있는 곳", ["accessible"]),
        ("wheelchair friendly", ["accessible"]),
        # 둘 다 말하면 둘 다 필요하다(조건은 AND 로 걸린다).
        ("휠체어랑 유모차 둘 다 가능한 곳", ["accessible", "stroller"]),
    ],
)
@pytest.mark.asyncio
async def test_stroller_and_wheelchair_words_map_to_separate_attributes(monkeypatch, text, expected):
    monkeypatch.setattr(travel_context_parser.llm_client, "is_enabled", lambda: False)
    context, status = await travel_context_parser.parse_travel_context(text)
    assert context["required_attributes"] == expected
    assert status == "keyword"


@pytest.mark.asyncio
async def test_llm_stroller_attribute_is_allowlisted(monkeypatch):
    monkeypatch.setattr(travel_context_parser.llm_client, "is_enabled", lambda: True)
    monkeypatch.setattr(
        travel_context_parser.llm_client,
        "chat_json",
        AsyncMock(return_value={"required_attributes": ["stroller", "baby_seat", "Stroller"]}),
    )
    context, status = await travel_context_parser.parse_travel_context("아이랑 편하게 다닐래")
    assert context == {"required_attributes": ["stroller"]}
    assert status == "llm"


def test_parser_allowlist_matches_the_server_context_model():
    # 파서가 내놓는 조건은 추천 요청(TravelContext)이 받아 주는 값이어야 한다 — 한쪽만 늘면 422 가 난다.
    from typing import get_args

    from app.services.travel_context import VALID_ATTRIBUTES, TravelContext

    annotation = TravelContext.model_fields["required_attributes"].annotation
    literal_values = set(get_args(get_args(annotation)[0]))
    assert travel_context_parser.VALID_ATTRIBUTES == VALID_ATTRIBUTES == literal_values


@pytest.mark.asyncio
async def test_disabled_llm_has_harmless_empty_fallback(monkeypatch):
    monkeypatch.setattr(travel_context_parser.llm_client, "is_enabled", lambda: False)
    assert await travel_context_parser.parse_travel_context("조금 편하게 둘러볼래") == ({}, "disabled")


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            "It is raining. Find an indoor museum within 10 minutes, with one hour remaining, excluding visited places.",
            {"categories": ["culture"], "max_walk_minutes": 10, "available_minutes": 60,
             "required_attributes": ["indoor"], "exclude_visited": True},
        ),
        (
            "雨なので徒歩10分以内の屋内博物館。残り30分で、訪問済みを除外して。",
            {"categories": ["culture"], "max_walk_minutes": 10, "available_minutes": 30,
             "required_attributes": ["indoor"], "exclude_visited": True},
        ),
        (
            "下雨了，找步行10分钟内的室内博物馆，剩余60分钟，排除去过的地方。",
            {"categories": ["culture"], "max_walk_minutes": 10, "available_minutes": 60,
             "required_attributes": ["indoor"], "exclude_visited": True},
        ),
    ],
)
@pytest.mark.asyncio
async def test_keyword_fallback_has_en_ja_zh_parity(monkeypatch, text, expected):
    monkeypatch.setattr(travel_context_parser.llm_client, "is_enabled", lambda: False)
    context, status = await travel_context_parser.parse_travel_context(text)
    assert context == expected
    assert status == "keyword"
