import pytest

from app.services.embedding_service import filter_candidates


@pytest.mark.asyncio
async def test_pork_query_matches_broad_meat_tourapi_tag():
    candidates = [
        {"id": "meat", "name": "황남 식당", "cuisine": ["한식", "육류,고기"]},
        {"id": "noodle", "name": "경주 칼국수", "cuisine": ["한식", "면요리"]},
    ]

    result = await filter_candidates("돼지고기 삼겹살 목살", candidates)

    assert result == ["meat"]


@pytest.mark.asyncio
async def test_pork_query_does_not_return_unrelated_restaurant():
    candidates = [
        {"id": "noodle", "name": "경주 칼국수", "cuisine": ["한식", "면요리"]},
    ]

    result = await filter_candidates("돼지고기 삼겹살 목살", candidates)

    assert result == []
