from unittest.mock import AsyncMock

import pytest

from app.services import recommendation_explanation_service as service


SNAPSHOT = {
    "facility_name": "첨성대",
    "spot_score": 0.91,
    "rank": 1,
    "breakdown": {"travel_time": 8, "wait_time": 3},
    "tourapi_facts": {"barrier_free": True},
}


def test_template_uses_only_snapshot_values():
    answer = service.build_template("why_first", [SNAPSHOT])
    assert "첨성대" in answer
    assert "91점" in answer
    assert "8분" in answer


def test_difference_uses_both_snapshot_scores():
    other = {**SNAPSHOT, "facility_name": "대릉원", "spot_score": 0.82, "rank": 2}
    answer = service.build_template("difference", [SNAPSHOT, other])
    assert "첨성대" in answer and "대릉원" in answer
    assert "91점" in answer and "82점" in answer


@pytest.mark.parametrize(
    ("locale", "expected", "labels"),
    [
        ("ko", "91점", ["SPOT 근거 설명", "TourAPI 정보"]),
        ("en", "SPOT score of 91", ["SPOT rationale", "TourAPI facts"]),
        ("ja", "SPOTスコア91点", ["SPOT根拠説明", "TourAPI情報"]),
        ("zh", "SPOT 91分", ["SPOT依据说明", "TourAPI信息"]),
    ],
)
@pytest.mark.asyncio
async def test_disabled_fallback_has_locale_parity(monkeypatch, locale, expected, labels):
    monkeypatch.setattr(service.llm_client, "is_enabled", lambda: False)
    answer, source_labels, status = await service.explain("why_first", [SNAPSHOT], locale)
    assert expected in answer
    assert source_labels == labels
    assert status == "disabled"
    for number in ("91", "1", "8", "3"):
        assert number in answer


@pytest.mark.asyncio
async def test_llm_fabricated_number_is_rejected(monkeypatch):
    monkeypatch.setattr(service.llm_client, "is_enabled", lambda: True)
    monkeypatch.setattr(
        service.llm_client, "chat_text", AsyncMock(return_value="첨성대는 SPOT 99점이라 1위입니다."),
    )
    answer, labels, status = await service.explain("why_first", [SNAPSHOT])
    assert status == "rejected"
    assert "99" not in answer
    assert "AI 요약" not in labels


@pytest.mark.asyncio
async def test_disabled_llm_returns_deterministic_fallback(monkeypatch):
    monkeypatch.setattr(service.llm_client, "is_enabled", lambda: False)
    answer, labels, status = await service.explain("family_check", [SNAPSHOT])
    assert status == "disabled"
    assert "무장애 정보가 확인" in answer
    assert labels == ["SPOT 근거 설명", "TourAPI 정보"]
