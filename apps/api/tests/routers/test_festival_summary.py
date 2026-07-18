"""축제 소개 다국어 요약(P1-4 — festival_summary_service + events 라우터 동봉) 테스트.

LLM 은 전부 mock(네트워크 0 — conftest 가 UPSTAGE_API_KEY="" 고정, 필요 시 개별 monkeypatch).
검증 계약(docs/SOLAR_LLM_EXPANSION.md P1-4):
  · 첫 응답 비블로킹 — LLM 이 느려도 원문 즉시 반환(overview_i18n 없음, status=pending)
  · 캐시 적재 후 overview_i18n {en,ja,zh} 3로케일 일괄 동봉(locale 파라미터 없음)
  · 정직성 게이트 — 한글 잔존·숫자(유니코드 N* 카테고리) 검출 로케일은 폐기(저장 안 함)
  · 부분 채택 — en 만 성공하면 en 만 동봉(실패 로케일은 프런트가 한국어 원문 폴백)
  · 키 미설정 — 태스크 자체 미발행(네트워크 0) + status="disabled"
  · 이벤트 루프 밖 호출 안전(no-op) · 기존 events 계약 불변(회귀는 test_events.py 가 커버)
"""

import asyncio
import json
import time
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import events
from app.services import festival_summary_service, llm_client

# 게이트를 통과하는 로케일별 정직한 요약(한글 0자·숫자 0자).
_GOOD = {
    "en": "A quiet festival where visitors empty their minds and slowly refill them.",
    "ja": "心を空にして、ゆっくり満たしていく静かなお祭りです。",
    "zh": "放空身心、慢慢充实自我的安静庆典。",
}


@pytest.fixture(autouse=True)
def _isolate_state():
    """요약 캐시·백오프·태스크와 events 상세 캐시를 매 테스트 격리(모듈 전역 상태)."""
    festival_summary_service.reset()
    events._detail_cache.clear()
    yield
    festival_summary_service.reset()
    events._detail_cache.clear()


@pytest.fixture
def llm_enabled(monkeypatch):
    """is_enabled=True + 로케일별 canned 응답. calls 로 프롬프트·호출 수 검사."""
    calls = {"system": [], "user": [], "replies": dict(_GOOD), "delay": 0.0}

    async def _fake_chat_text(system, user, **_kwargs):
        if calls["delay"]:
            await asyncio.sleep(calls["delay"])
        calls["system"].append(system)
        calls["user"].append(user)
        for locale, label in (("en", "영어"), ("ja", "일본어"), ("zh", "중국어")):
            if label in system:
                return calls["replies"].get(locale)
        return None

    monkeypatch.setattr(llm_client, "is_enabled", lambda: True)
    monkeypatch.setattr(llm_client, "chat_text", _fake_chat_text)
    return calls


def _ongoing_payload():
    return {
        "response": {
            "header": {"resultCode": "0000", "resultMsg": "OK"},
            "body": {
                "items": {
                    "item": [{
                        "contentid": "on",
                        "title": "쉼표 축제",
                        "eventstartdate": "20000101",
                        "eventenddate": "20990101",
                        "addr1": "경주시",
                        "mapx": "129.2",
                        "mapy": "35.8",
                    }]
                },
                "totalCount": 1,
            },
        }
    }


_OVERVIEW = "비우고, 머무르고, 채우는 시간을 보내는 축제입니다."


def _detail_common_payload():
    return {
        "response": {
            "header": {"resultCode": "0000", "resultMsg": "OK"},
            "body": {"items": {"item": {"overview": _OVERVIEW}}, "totalCount": 1},
        }
    }


def _patched_tourapi():
    return (
        patch.object(events.tourapi, "search_festival", AsyncMock(return_value=_ongoing_payload())),
        patch.object(events.tourapi, "detail_common", AsyncMock(return_value=_detail_common_payload())),
        patch.object(events.tourapi, "detail_intro", AsyncMock(side_effect=RuntimeError("intro 없음"))),
    )


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(events.router)
    return app


def _wait_for_summaries(content_id: str, n: int, timeout: float = 3.0) -> dict:
    """백그라운드 태스크가 캐시를 채울 때까지 폴링(TestClient 포털 루프가 태스크를 실행한다)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        summaries = festival_summary_service.get_summaries(content_id)
        if len(summaries) >= n:
            return summaries
        time.sleep(0.02)
    return festival_summary_service.get_summaries(content_id)


# =========================================================================
# 라우터 — 첫 응답 비블로킹 → 캐시 적재 후 3로케일 일괄 동봉
# =========================================================================

def test_first_response_nonblocking_then_cached_i18n_attached(llm_enabled):
    llm_enabled["delay"] = 0.05  # LLM 이 응답보다 느린 상황 — 블로킹이면 첫 응답에 요약이 실린다
    s, c, i = _patched_tourapi()
    with s, c, i, TestClient(_make_app()) as client:
        first = client.get("/api/v1/events").json()
        ev = first["events"][0]
        # 첫 응답: 원문 즉시(LLM 대기 없음) — 요약은 아직 없고 상태만 pending.
        assert ev["overview"] == _OVERVIEW
        assert ev["overview_i18n"] is None
        assert ev["summary_llm_status"] == "pending"

        assert _wait_for_summaries("on", 3) == _GOOD

        second = client.get("/api/v1/events").json()
        ev2 = second["events"][0]
        # 이후 응답: {en,ja,zh} 3로케일 일괄 동봉(locale 파라미터 없음) + ko 원문 불변.
        assert ev2["overview"] == _OVERVIEW
        assert ev2["overview_i18n"] == _GOOD
        assert ev2["summary_llm_status"] == "llm"

    # 프롬프트는 json.dumps 데이터 경계 — user 가 JSON 이고 원문이 데이터로만 들어간다.
    facts = json.loads(llm_enabled["user"][0])
    assert facts["overview"] == _OVERVIEW
    assert facts["title"] == "쉼표 축제"


def test_cached_summaries_do_not_retrigger_llm(llm_enabled):
    s, c, i = _patched_tourapi()
    with s, c, i, TestClient(_make_app()) as client:
        client.get("/api/v1/events")
        assert _wait_for_summaries("on", 3) == _GOOD
        before = len(llm_enabled["system"])
        client.get("/api/v1/events")
        time.sleep(0.1)  # 태스크가 발행됐다면 이 사이 호출이 늘었을 것
    assert len(llm_enabled["system"]) == before  # 3로케일 완비 — 재호출 0(장기 캐시)


# =========================================================================
# 키 미설정 — 태스크 자체 미발행(네트워크 0) + status="disabled"
# =========================================================================

def test_disabled_key_no_task_no_network(monkeypatch):
    async def _must_not_call(*_args, **_kwargs):
        raise AssertionError("키 미설정이면 chat_text 가 호출되면 안 된다")

    monkeypatch.setattr(llm_client, "chat_text", _must_not_call)  # conftest 가 키 "" 고정
    s, c, i = _patched_tourapi()
    with s, c, i, TestClient(_make_app()) as client:
        ev = client.get("/api/v1/events").json()["events"][0]
    assert ev["overview"] == _OVERVIEW           # 기존 경로 그대로(무해 폴백)
    assert ev["overview_i18n"] is None
    assert ev["summary_llm_status"] == "disabled"
    assert not festival_summary_service._tasks   # 태스크 미발행 — fire-and-forget 조차 없다


# =========================================================================
# 정직성 게이트 — 한글 잔존·숫자 폐기, 부분 채택
# =========================================================================

@pytest.mark.asyncio
async def test_hangul_residual_locale_discarded(llm_enabled):
    llm_enabled["replies"]["ja"] = "쉼표 のお祭りです。"  # 한글 잔존 → ja 폐기
    await festival_summary_service._generate_and_store("cid", "쉼표 축제", _OVERVIEW, ["en", "ja", "zh"])
    summaries = festival_summary_service.get_summaries("cid")
    assert "ja" not in summaries
    assert summaries == {"en": _GOOD["en"], "zh": _GOOD["zh"]}


@pytest.mark.asyncio
async def test_numeric_output_discarded_all_unicode_categories(llm_enabled):
    # 유니코드 N* 카테고리 전부 — 아라비아(3)·전각(３)·원문자(①)·로마 숫자(Ⅹ).
    llm_enabled["replies"]["en"] = "The festival runs for 3 days."
    llm_enabled["replies"]["ja"] = "①番目の祭りです。"
    llm_enabled["replies"]["zh"] = "第Ⅹ届庆典。"
    await festival_summary_service._generate_and_store("cid", "쉼표 축제", _OVERVIEW, ["en", "ja", "zh"])
    assert festival_summary_service.get_summaries("cid") == {}
    assert festival_summary_service.status_for("cid", False) == "rejected"


@pytest.mark.asyncio
async def test_partial_adoption_en_only(llm_enabled):
    llm_enabled["replies"]["ja"] = None            # LLM 실패
    llm_enabled["replies"]["zh"] = "为期3天的庆典。"  # 숫자 → 폐기
    await festival_summary_service._generate_and_store("cid", "쉼표 축제", _OVERVIEW, ["en", "ja", "zh"])
    # en 만 성공 → en 만 저장(부분 채택). 실패 로케일은 저장하지 않는다.
    assert festival_summary_service.get_summaries("cid") == {"en": _GOOD["en"]}
    assert festival_summary_service.status_for("cid", True) == "llm"
    # 부분 실패는 백오프 후 재시도 대상 — 즉시 재예약은 안 된다.
    assert festival_summary_service._retry_at["cid"] > time.monotonic()


@pytest.mark.asyncio
async def test_retry_fills_only_missing_locales(llm_enabled):
    llm_enabled["replies"]["ja"] = None
    await festival_summary_service._generate_and_store("cid", "쉼표 축제", _OVERVIEW, ["en", "ja", "zh"])
    assert set(festival_summary_service.get_summaries("cid")) == {"en", "zh"}
    # 백오프 경과를 시뮬레이션 후 빠진 ja 만 재생성 — 기존 en/zh 채택분은 보존·병합된다.
    llm_enabled["replies"]["ja"] = _GOOD["ja"]
    await festival_summary_service._generate_and_store("cid", "쉼표 축제", _OVERVIEW, ["ja"])
    assert festival_summary_service.get_summaries("cid") == _GOOD


@pytest.mark.asyncio
async def test_all_llm_failed_status(llm_enabled):
    llm_enabled["replies"] = {"en": None, "ja": None, "zh": None}
    await festival_summary_service._generate_and_store("cid", "쉼표 축제", _OVERVIEW, ["en", "ja", "zh"])
    assert festival_summary_service.get_summaries("cid") == {}
    assert festival_summary_service.status_for("cid", False) == "llm_failed"


# =========================================================================
# ensure_summaries 가드 — 루프 밖 안전·백오프·완비 시 no-op
# =========================================================================

def test_ensure_summaries_safe_outside_event_loop(monkeypatch):
    monkeypatch.setattr(llm_client, "is_enabled", lambda: True)
    # 동기 컨텍스트(실행 중인 이벤트 루프 없음) — 예외 없이 조용한 no-op 이어야 한다.
    assert festival_summary_service.ensure_summaries("cid", "쉼표 축제", _OVERVIEW) is None
    assert not festival_summary_service._tasks


@pytest.mark.asyncio
async def test_ensure_summaries_noop_when_complete_or_backoff(llm_enabled):
    # 3로케일 완비 → no-op(재생성 없음 — 축제 소개문은 사실상 불변).
    festival_summary_service._cache["cid"] = (time.monotonic(), dict(_GOOD))
    assert festival_summary_service.ensure_summaries("cid", "쉼표 축제", _OVERVIEW) is None
    # 실패 백오프 중 → no-op(실패 LLM 을 요청마다 두들기지 않는다).
    festival_summary_service._cache.pop("cid")
    festival_summary_service._retry_at["cid"] = time.monotonic() + 600
    assert festival_summary_service.ensure_summaries("cid", "쉼표 축제", _OVERVIEW) is None
    # 백오프 해제 → 태스크 발행(완주까지 대기해 격리 유지).
    festival_summary_service._retry_at.pop("cid")
    task = festival_summary_service.ensure_summaries("cid", "쉼표 축제", _OVERVIEW)
    assert task is not None
    # 발행 직후 중복 예약은 in-flight 가드로 차단된다.
    assert festival_summary_service.ensure_summaries("cid", "쉼표 축제", _OVERVIEW) is None
    await task
    assert festival_summary_service.get_summaries("cid") == _GOOD
