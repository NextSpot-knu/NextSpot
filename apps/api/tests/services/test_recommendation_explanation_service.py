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


@pytest.mark.parametrize("locale", ["ko", "en", "ja", "zh"])
def test_template_never_turns_missing_wait_into_zero(locale):
    snapshot = {**SNAPSHOT, "breakdown": {"travel_time": 8, "wait_time": None}}
    answer = service.build_template("why_first", [snapshot], locale)
    assert "0" not in answer
    assert "8" in answer


_MINUTES_IN_ANSWER = {
    # (도보, 대기)가 4개 언어 문장에 찍히는 모양
    "ko": ("도보 약 {walk}분", "예상 대기 {wait}분"),
    "en": ("{walk}-minute walk", "{wait}-minute estimated wait"),
    "ja": ("徒歩約{walk}分", "予想待ち時間{wait}分"),
    "zh": ("约{walk}分钟步行", "{wait}分钟预计等待"),
}
_FAMILY_MINUTES_IN_ANSWER = {
    "ko": ("도보 약 {walk}분", "예상 대기 {wait}분"),
    "en": ("{walk}-minute walk", "{wait}-minute wait"),
    "ja": ("徒歩約{walk}分", "予想待ち時間は{wait}分"),
    "zh": ("约需{walk}分钟", "预计等待{wait}分钟"),
}


@pytest.mark.parametrize("locale", ["ko", "en", "ja", "zh"])
@pytest.mark.parametrize(
    ("travel", "wait", "walk_shown", "wait_shown"),
    [
        # Top 3 비교 표의 '도보·대기' 줄은 도보 = max(1, 올림), 대기 = Math.round(.5 올림)다.
        # round 를 쓰면 2.2분이 표의 '3m' 아래에서 '도보 약 2분' 이 되고, 2.5분 대기가 '3m' 아래에서 '2분' 이 된다.
        (2.2, 2.5, 3, 3),
        (0, 9.2, 1, 9),
        (8, 0, 8, 0),
    ],
)
@pytest.mark.parametrize(("question", "shapes"), [("why_first", _MINUTES_IN_ANSWER), ("family_check", _FAMILY_MINUTES_IN_ANSWER)])
def test_answer_minutes_match_comparison_row(locale, travel, wait, walk_shown, wait_shown, question, shapes):
    snapshot = {**SNAPSHOT, "breakdown": {"travel_time": travel, "wait_time": wait}}
    answer = service.build_template(question, [snapshot], locale)
    walk_shape, wait_shape = shapes[locale]
    assert walk_shape.format(walk=walk_shown) in answer
    assert wait_shape.format(wait=wait_shown) in answer


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
