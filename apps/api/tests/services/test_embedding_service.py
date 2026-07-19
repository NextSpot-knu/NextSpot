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


@pytest.mark.asyncio
async def test_samgyeopsal_query_does_not_match_bulgogi_pizza():
    """회귀 재현: '삼겹살' 발화의 우산 별칭 '고기'가 대표메뉴 '반월성 불고기'(피자)에
    부분문자열 오탐되던 버그 — 태그 없는 피자집은 제외되고 고기집만 남아야 한다."""
    candidates = [
        {
            "id": "pizza",
            "name": "반월성화덕피자",
            "cuisine": None,
            "menu": "반월성 불고기 / 마르게리따",
        },
        {"id": "meat", "name": "황남 숯불 삼겹살", "cuisine": ["한식", "육류,고기"]},
    ]

    result = await filter_candidates("삼겹살 먹고싶다", candidates)

    assert "pizza" not in result
    assert result == ["meat"]


@pytest.mark.asyncio
async def test_umbrella_token_does_not_match_free_text():
    """우산 토큰('고기'·'육류')만으로는 name/menu 자유 텍스트에 매칭되지 않는다."""
    candidates = [
        {"id": "pizza", "name": "화덕피자", "menu": "불고기피자"},
    ]

    result = await filter_candidates("돼지고기 삼겹살", candidates)

    assert result == []


@pytest.mark.asyncio
async def test_umbrella_token_matches_classification_tags():
    """우산 토큰은 분류 태그(cuisine/category)에는 그대로 매칭된다."""
    candidates = [
        {"id": "meat", "name": "이름무관식당", "cuisine": ["육류,고기"]},
    ]

    result = await filter_candidates("고기 먹고싶어", candidates)

    assert result == ["meat"]
