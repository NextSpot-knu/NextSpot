# 검색 0건 질의 재작성 서비스(P1-3) — 출력 화이트리스트·데이터 경계·무해 폴백·일일 예산 캡 검증.
# conftest 가 UPSTAGE_API_KEY="" 로 고정하므로 LLM 은 전 테스트에서 monkeypatch mock 만 탄다.
# 제어·bidi 문자는 소스에 원시 문자로 박지 않고 이스케이프 표기로만 만든다(에디터·diff 오염 방지).

import json
from unittest.mock import AsyncMock

import pytest

from app.core.config import settings
from app.services import search_rewrite_service as srs

_RLO = "\u202e"  # bidi 제어(RIGHT-TO-LEFT OVERRIDE)
_NUL = "\u0000"  # NUL 제어문자


@pytest.fixture(autouse=True)
def _reset_budget():
    """전역 인메모리 예산 카운터를 테스트마다 격리(라우터 레이트리밋 스토어 격리 관례 미러)."""
    srs._budget_day = None
    srs._budget_used = 0
    yield
    srs._budget_day = None
    srs._budget_used = 0


# =========================================================================
# 1. _validate_terms — 출력 화이트리스트(길이·문자·개수·중복·원질의) 강제
# =========================================================================

def test_validate_terms_whitelist_and_caps():
    raw = [
        "어린이 체험",      # 유효
        "park",             # 한글 미포함 → 거부(한국어 출력 강제)
        "공원!",            # 특수문자 → 거부
        "박",               # 1자 → 거부(최소 2자)
        "가" * 21,          # 21자 → 거부(최대 20자, 절단 없이 폐기)
        "어린이 체험",      # 중복 → 거부
        "원질의",           # 원 질의와 동일 → 거부
        "공원",             # 유효(2번째)
        "불국사",           # 유효(3번째 — 여기서 캡)
        "석굴암",           # MAX_TERMS 초과 → 버림
    ]
    assert srs._validate_terms(raw, "원질의") == ["어린이 체험", "공원", "불국사"]


def test_validate_terms_sanitizes_control_and_bidi_chars():
    # 제어·bidi 문자는 공백 치환 후 압축 — 결과가 화이트리스트를 통과하면 채택된다.
    assert srs._validate_terms([f"공{_RLO}원", f"체{_NUL}험"], "질의") == ["공 원", "체 험"]


def test_validate_terms_rejects_non_list_and_non_str():
    assert srs._validate_terms("문자열", "질의") == []
    assert srs._validate_terms(None, "질의") == []
    assert srs._validate_terms([123, {"a": 1}, None], "질의") == []


# =========================================================================
# 2. rewrite_query — json.dumps 데이터 경계 + 무해 폴백(None)
# =========================================================================

@pytest.mark.asyncio
async def test_rewrite_query_happy_path_passes_json_boundary(monkeypatch):
    mock = AsyncMock(return_value={"queries": ["어린이 체험", "공원"]})
    monkeypatch.setattr(srs.llm_client, "chat_json", mock)
    result = await srs.rewrite_query("애들이 뛰어놀 만한 데")
    assert result == ["어린이 체험", "공원"]
    # 원 질의는 자유 문장 연결이 아니라 json.dumps 데이터 경계로만 프롬프트에 실린다.
    system, user = mock.await_args.args
    assert json.loads(user) == {"query": "애들이 뛰어놀 만한 데"}
    assert "재작성" in system  # 시스템 프롬프트에 사용자 입력이 섞이지 않는다


@pytest.mark.asyncio
async def test_rewrite_query_sanitizes_original_before_prompt(monkeypatch):
    mock = AsyncMock(return_value=None)
    monkeypatch.setattr(srs.llm_client, "chat_json", mock)
    await srs.rewrite_query(f"놀이{_RLO}{_NUL}터")
    payload = json.loads(mock.await_args.args[1])
    assert _RLO not in payload["query"] and _NUL not in payload["query"]
    assert payload["query"] == "놀이 터"  # 제어·bidi → 공백 치환 + 연속 공백 압축


@pytest.mark.asyncio
async def test_rewrite_query_llm_none_returns_none(monkeypatch):
    monkeypatch.setattr(srs.llm_client, "chat_json", AsyncMock(return_value=None))
    assert await srs.rewrite_query("이상한질의") is None


@pytest.mark.asyncio
async def test_rewrite_query_invalid_payload_returns_none(monkeypatch):
    monkeypatch.setattr(srs.llm_client, "chat_json", AsyncMock(return_value={"queries": "공원"}))
    assert await srs.rewrite_query("이상한질의") is None
    monkeypatch.setattr(srs.llm_client, "chat_json", AsyncMock(return_value={"other": ["공원"]}))
    assert await srs.rewrite_query("이상한질의") is None


@pytest.mark.asyncio
async def test_rewrite_query_all_terms_rejected_returns_none(monkeypatch):
    # 재작성어가 전부 화이트리스트 탈락(비한글) → None(무해 폴백 — 부분 채택 없음).
    monkeypatch.setattr(
        srs.llm_client, "chat_json", AsyncMock(return_value={"queries": ["park", "zoo!"]})
    )
    assert await srs.rewrite_query("이상한질의") is None


@pytest.mark.asyncio
async def test_rewrite_query_empty_original_skips_llm(monkeypatch):
    mock = AsyncMock(return_value={"queries": ["공원"]})
    monkeypatch.setattr(srs.llm_client, "chat_json", mock)
    assert await srs.rewrite_query("") is None
    assert await srs.rewrite_query(f" {_RLO}{_NUL} ") is None  # 새니타이즈 후 빈 문자열
    assert mock.await_count == 0


# =========================================================================
# 3. consume_budget — 전역 일일 예산 캡(KST 리셋)
# =========================================================================

def test_consume_budget_caps_at_setting(monkeypatch):
    monkeypatch.setattr(settings, "SEARCH_REWRITE_DAILY_BUDGET", 2)
    assert srs.consume_budget() is True
    assert srs.consume_budget() is True
    assert srs.consume_budget() is False  # 캡 도달 — 이후 전부 차단
    assert srs.consume_budget() is False


def test_consume_budget_zero_disables(monkeypatch):
    monkeypatch.setattr(settings, "SEARCH_REWRITE_DAILY_BUDGET", 0)
    assert srs.consume_budget() is False


def test_consume_budget_resets_on_new_day(monkeypatch):
    monkeypatch.setattr(settings, "SEARCH_REWRITE_DAILY_BUDGET", 1)
    srs._budget_day = "2000-01-01"  # 과거 날짜로 캡 소진 상태 시뮬레이션
    srs._budget_used = 1
    assert srs.consume_budget() is True  # 날짜가 바뀌면 카운터 리셋
    assert srs._budget_used == 1
