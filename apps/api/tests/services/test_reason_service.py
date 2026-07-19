# 추천 사유 서비스 — 결정적 템플릿 + 선택적 LLM 문체 다듬기(Upstage Solar).
# 핵심 계약: (1) 정직성 검증(숫자 부분집합·시설명 보존) 하나라도 어긋나면 템플릿 원문,
#           (2) LLM 비활성/실패 시 출력이 기존 템플릿과 100% 동일(회귀 0),
#           (3) 같은 카드(시설+혼잡도 버킷+시각) 반복 노출 시 캐시 히트로 chat_text 미호출.
# conftest 가 UPSTAGE_API_KEY="" 로 고정해 기본은 LLM 완전 비활성 — LLM 경로가 필요한
# 테스트는 reason_service.llm_client 를 개별 monkeypatch 한다(voice_intent_service 테스트와 동일 원칙).

from unittest.mock import AsyncMock

import pytest

from app.services import reason_service
from app.services.reason_service import (
    _build_template,
    _is_honest_polish,
    generate_reason,
    generate_reason_with_source,
)


@pytest.fixture(autouse=True)
def _clear_reason_cache():
    # 모듈 전역 캐시가 테스트 간 오염되지 않도록 매 테스트 전후로 비운다.
    reason_service._cache.clear()
    yield
    reason_service._cache.clear()


_CTX = {
    "facility_id": "f-cafe-1",
    "recommended_facility_name": "카페능",
    "candidate_congestion": 0.3,
    "travel_time": 5,
    "predicted_wait": 10,
}

_CONGESTED_CTX = {
    "facility_id": "f-cafe-2",
    "recommended_facility_name": "북적식당",
    "candidate_congestion": 0.8,
    "travel_time": 7,
    "predicted_wait": 20,
}


# --- 템플릿(기존 결정적 경로) — 회귀 확인용 ------------------------------------------------

def test_build_template_relaxed():
    text = _build_template(_CTX)
    assert text == "카페능 추천: 도보 5분, 예상 대기 10분, 혼잡도 30% 수준으로 여유가 있습니다."


def test_build_template_congested():
    text = _build_template(_CONGESTED_CTX)
    assert text == "북적식당: 도보 7분, 예상 대기 20분, 혼잡도 80% 수준으로 지금은 붐벼 대기가 길 수 있어요."


# --- 혼잡 3단계(CONGESTION_TRUST_SPEC) — measured/predicted/none 문구 계약 -------------------

def test_build_template_predicted_labels_ai_forecast():
    # predicted: 수치는 말하되 'AI 예측'임을 문구에 명시한다(실측처럼 팔지 않는다).
    ctx = {**_CTX, "congestion_source": "predicted"}
    text = _build_template(ctx)
    assert text == "카페능 추천: 도보 5분, 예상 대기 10분, 예상 혼잡도 30% (AI 예측) 수준으로 여유가 있습니다."


def test_build_template_predicted_congested_still_honest():
    # predicted + 혼잡(>=0.75): 붐빔 안내에도 'AI 예측' 꼬리표 유지.
    ctx = {**_CONGESTED_CTX, "congestion_source": "predicted"}
    text = _build_template(ctx)
    assert "예상 혼잡도 80% (AI 예측)" in text
    assert "붐벼" in text


def test_build_template_none_omits_congestion_claims():
    # none: 혼잡 수치도, '여유'라는 혼잡 주장도 하지 않는다 — 준비 중임을 밝힌다.
    ctx = {**_CTX, "congestion_source": "none", "candidate_congestion": None}
    text = _build_template(ctx)
    assert text == "카페능 추천: 도보 5분, 예상 대기 10분 수준입니다. 혼잡 정보는 준비 중이에요."
    assert "여유" not in text
    assert "%" not in text


def test_build_template_none_ignores_stray_numeric_congestion():
    # 방어: congestion_source='none' 인데 수치가 딸려 와도(호출자 실수) 혼잡 문구를 만들지 않는다.
    ctx = {**_CTX, "congestion_source": "none"}  # candidate_congestion=0.3 그대로
    text = _build_template(ctx)
    assert "혼잡도" not in text.replace("혼잡 정보는", "")
    assert "30%" not in text


def test_build_template_measured_unchanged_without_source_key():
    # 하위호환: congestion_source 미지정 호출자는 기존(measured) 문구 그대로 — 회귀 0.
    assert _build_template(_CTX) == "카페능 추천: 도보 5분, 예상 대기 10분, 혼잡도 30% 수준으로 여유가 있습니다."


# --- 정직성 검증(_is_honest_polish) — 핵심 게이트 ------------------------------------------

def test_is_honest_polish_accepts_paraphrase_with_same_facts():
    original = _build_template(_CTX)
    polished = "카페능은 도보로 5분 거리에 있고 대기도 10분 정도라 여유로워요. 혼잡도는 30%대로 낮은 편입니다."
    assert _is_honest_polish(original, polished, "카페능") is True


def test_is_honest_polish_rejects_added_number():
    # 원문에 없는 숫자(예: 3km)를 새로 만들어내면 거부.
    original = _build_template(_CTX)
    polished = "카페능은 여기서 3km 거리에 있고 도보 5분, 대기 10분, 혼잡도 30% 수준입니다."
    assert _is_honest_polish(original, polished, "카페능") is False


def test_is_honest_polish_rejects_altered_number():
    # 원문의 숫자를 다른 값으로 바꿔치기(5분 → 50분)하면 거부. 문자열 부분매치가 아니라
    # 토큰 단위 비교라 '50' 은 원문 숫자 집합 {5, 10, 30} 의 원소가 아니다.
    original = _build_template(_CTX)
    polished = "카페능은 도보 50분, 대기 10분, 혼잡도 30% 수준입니다."
    assert _is_honest_polish(original, polished, "카페능") is False


def test_is_honest_polish_rejects_missing_facility_name():
    original = _build_template(_CTX)
    polished = "이 곳은 도보 5분, 대기 10분, 혼잡도 30% 수준으로 여유로워요."
    assert _is_honest_polish(original, polished, "카페능") is False


def test_is_honest_polish_rejects_empty_output():
    original = _build_template(_CTX)
    assert _is_honest_polish(original, "", "카페능") is False
    assert _is_honest_polish(original, "   ", "카페능") is False
    assert _is_honest_polish(original, None, "카페능") is False


def test_is_honest_polish_allows_subset_of_original_numbers():
    # 원문 숫자 중 일부만 언급해도(부분집합) 통과 — 새 숫자를 만들지만 않으면 된다.
    original = _build_template(_CTX)
    polished = "카페능은 도보 5분 거리로 여유롭습니다."
    assert _is_honest_polish(original, polished, "카페능") is True


# --- generate_reason — LLM 비활성/실패 시 회귀 0 --------------------------------------------

@pytest.mark.asyncio
async def test_generate_reason_llm_disabled_matches_template():
    # conftest 가 UPSTAGE_API_KEY="" 로 고정 — 기본 상태에선 LLM 경로 자체를 타지 않는다.
    assert reason_service.llm_client.is_enabled() is False
    result = await generate_reason(_CTX)
    assert result == _build_template(_CTX)


@pytest.mark.asyncio
async def test_generate_reason_llm_disabled_touches_no_network(monkeypatch):
    # 비활성 상태에선 chat_text 자체가 호출되지 않아야 한다(무해 폴백 — 지연 0).
    chat = AsyncMock()
    monkeypatch.setattr(reason_service.llm_client, "chat_text", chat)
    await generate_reason(_CTX)
    chat.assert_not_awaited()


@pytest.mark.asyncio
async def test_generate_reason_llm_failure_returns_template(monkeypatch):
    # LLM 이 활성이어도 chat_text 실패(타임아웃/오류 → None)면 템플릿 원문 그대로.
    monkeypatch.setattr(reason_service.llm_client, "is_enabled", lambda: True)
    monkeypatch.setattr(reason_service.llm_client, "chat_text", AsyncMock(return_value=None))
    result = await generate_reason(_CTX)
    assert result == _build_template(_CTX)


@pytest.mark.asyncio
async def test_generate_reason_dishonest_llm_output_falls_back_to_template(monkeypatch):
    # LLM 이 응답은 했지만 숫자를 지어냈다면(정직성 검증 실패) 템플릿 원문으로 폴백.
    monkeypatch.setattr(reason_service.llm_client, "is_enabled", lambda: True)
    monkeypatch.setattr(
        reason_service.llm_client, "chat_text",
        AsyncMock(return_value="카페능은 도보 500분 거리에 있어 아주 멀어요."),
    )
    result = await generate_reason(_CTX)
    assert result == _build_template(_CTX)


@pytest.mark.asyncio
async def test_generate_reason_accepts_honest_llm_polish(monkeypatch):
    # LLM 출력이 정직성 검증을 통과하면 다듬어진 문장을 채택한다(템플릿 그대로가 아님).
    monkeypatch.setattr(reason_service.llm_client, "is_enabled", lambda: True)
    polished_text = "카페능은 도보 5분, 대기 10분 정도로 여유로운 편이에요. 혼잡도도 30%대로 낮습니다."
    monkeypatch.setattr(
        reason_service.llm_client, "chat_text", AsyncMock(return_value=polished_text)
    )
    result = await generate_reason(_CTX)
    assert result == polished_text
    assert result != _build_template(_CTX)


# --- 캐시 — 같은 카드 반복 노출 시 재호출 금지 ----------------------------------------------

@pytest.mark.asyncio
async def test_generate_reason_cache_hit_skips_second_llm_call(monkeypatch):
    monkeypatch.setattr(reason_service.llm_client, "is_enabled", lambda: True)
    polished_text = "카페능은 도보 5분, 대기 10분 정도로 여유로운 편이에요. 혼잡도도 30%대로 낮습니다."
    chat = AsyncMock(return_value=polished_text)
    monkeypatch.setattr(reason_service.llm_client, "chat_text", chat)

    first = await generate_reason(_CTX)
    second = await generate_reason(dict(_CTX))  # 새 dict 지만 동일 facility/혼잡도/시각 → 같은 캐시 키

    assert first == second == polished_text
    chat.assert_awaited_once()


@pytest.mark.asyncio
async def test_generate_reason_cache_miss_for_different_facility(monkeypatch):
    # 시설이 다르면(캐시 키의 facility_id 가 다름) 별개로 다시 호출한다.
    monkeypatch.setattr(reason_service.llm_client, "is_enabled", lambda: True)
    chat = AsyncMock(side_effect=[
        "카페능은 도보 5분, 대기 10분 정도로 여유로운 편이에요. 혼잡도도 30%대로 낮습니다.",
        "북적식당: 도보 7분, 대기 20분 정도로 지금은 혼잡도 80%대라 붐벼요.",
    ])
    monkeypatch.setattr(reason_service.llm_client, "chat_text", chat)

    await generate_reason(_CTX)
    await generate_reason(_CONGESTED_CTX)
    assert chat.await_count == 2


@pytest.mark.asyncio
async def test_generate_reason_without_facility_id_still_falls_back_safely(monkeypatch):
    # facility_id(또는 이름)가 전혀 없으면 캐시 키를 만들 수 없어 캐싱을 건너뛴다 — 매 호출
    # LLM 을 다시 타더라도 정상 동작(안전한 저하)해야 하며 출력은 여전히 문자열이어야 한다.
    monkeypatch.setattr(reason_service.llm_client, "is_enabled", lambda: True)
    monkeypatch.setattr(reason_service.llm_client, "chat_text", AsyncMock(return_value=None))
    ctx = {"candidate_congestion": 0.3, "travel_time": 5, "predicted_wait": 10}
    result = await generate_reason(ctx)
    assert result == _build_template(ctx)


# --- generate_reason_with_source(개발 디버그용) — (텍스트, 출처) 계약 + 캐시에도 출처 보존 -------


@pytest.mark.asyncio
async def test_generate_reason_with_source_llm_disabled_reports_template():
    # 키 미설정 — 기존 회귀 0 경로. source 는 "template".
    text, source = await generate_reason_with_source(_CTX)
    assert text == _build_template(_CTX)
    assert source == "template"


@pytest.mark.asyncio
async def test_generate_reason_with_source_reports_llm_when_polish_adopted(monkeypatch):
    # 정직성 검증을 통과한 다듬기가 채택되면 source="llm".
    monkeypatch.setattr(reason_service.llm_client, "is_enabled", lambda: True)
    polished_text = "카페능은 도보 5분, 대기 10분 정도로 여유로운 편이에요. 혼잡도도 30%대로 낮습니다."
    monkeypatch.setattr(
        reason_service.llm_client, "chat_text", AsyncMock(return_value=polished_text)
    )
    text, source = await generate_reason_with_source(_CTX)
    assert text == polished_text
    assert source == "llm"


@pytest.mark.asyncio
async def test_generate_reason_with_source_reports_template_on_dishonest_output(monkeypatch):
    # 정직성 검증 거부(숫자 지어냄) → 템플릿 폴백이므로 source="template"(llm 아님).
    monkeypatch.setattr(reason_service.llm_client, "is_enabled", lambda: True)
    monkeypatch.setattr(
        reason_service.llm_client, "chat_text",
        AsyncMock(return_value="카페능은 도보 500분 거리에 있어 아주 멀어요."),
    )
    text, source = await generate_reason_with_source(_CTX)
    assert text == _build_template(_CTX)
    assert source == "template"


@pytest.mark.asyncio
async def test_generate_reason_with_source_reports_template_on_call_failure(monkeypatch):
    # LLM 활성이지만 호출 실패(None) → 템플릿 폴백, source="template".
    monkeypatch.setattr(reason_service.llm_client, "is_enabled", lambda: True)
    monkeypatch.setattr(reason_service.llm_client, "chat_text", AsyncMock(return_value=None))
    text, source = await generate_reason_with_source(_CTX)
    assert text == _build_template(_CTX)
    assert source == "template"


@pytest.mark.asyncio
async def test_generate_reason_cache_hit_preserves_original_source(monkeypatch):
    # 핵심 계약: 캐시 히트 시에도 원래 출처를 정확히 보존한다 — 캐시된 llm 문장을
    # "template"로 잘못 보고하면 안 된다(반대도 마찬가지).
    monkeypatch.setattr(reason_service.llm_client, "is_enabled", lambda: True)
    polished_text = "카페능은 도보 5분, 대기 10분 정도로 여유로운 편이에요. 혼잡도도 30%대로 낮습니다."
    chat = AsyncMock(return_value=polished_text)
    monkeypatch.setattr(reason_service.llm_client, "chat_text", chat)

    first_text, first_source = await generate_reason_with_source(_CTX)
    second_text, second_source = await generate_reason_with_source(dict(_CTX))  # 캐시 히트

    assert first_text == second_text == polished_text
    assert first_source == second_source == "llm"
    chat.assert_awaited_once()  # 두 번째 호출은 캐시 히트라 LLM 재호출 없음


@pytest.mark.asyncio
async def test_generate_reason_cache_hit_preserves_template_source(monkeypatch):
    # 첫 호출이 정직성 검증 거부로 템플릿 폴백됐다면, 캐시 히트도 계속 "template"이어야 한다.
    monkeypatch.setattr(reason_service.llm_client, "is_enabled", lambda: True)
    chat = AsyncMock(return_value="카페능은 도보 500분 거리에 있어 아주 멀어요.")  # 정직성 위반
    monkeypatch.setattr(reason_service.llm_client, "chat_text", chat)

    first_text, first_source = await generate_reason_with_source(_CTX)
    second_text, second_source = await generate_reason_with_source(dict(_CTX))

    assert first_text == second_text == _build_template(_CTX)
    assert first_source == second_source == "template"
    chat.assert_awaited_once()
