# /voice/turn 무인증 하드닝 — typed 후보 스키마(P1-4)·LLM 레이트리밋(P1-3) 계약 검증.
# (Codex 적대적 감사 2026-07-17 반영. 전체 흐름 E2E 는 프런트 실화면 검증에서 별도 수행.)

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import app
from app.routers import recommendations as rec
from app.services import voice_intent_service


def test_voice_candidate_caps_long_strings_instead_of_422():
    # 1. 내부 문자열 폭탄은 422 가 아니라 조용한 절단 — 정상 UX 회귀 없이 토큰 상한 방어
    c = rec.VoiceCandidate(
        id="f1",
        name="가" * 5000,
        menu="바닐라라떼 / " * 200,
        cuisine=["한식" * 100] * 50,
        congestion=0.5,
        distance_m=120,
    )
    assert len(c.name) == 80
    assert c.menu is not None and len(c.menu) == 300
    assert isinstance(c.cuisine, list) and len(c.cuisine) == 10
    assert all(len(x) <= 60 for x in c.cuisine)


def test_voice_candidate_rejects_missing_id_and_drops_bad_numbers():
    # 2. id 없는 후보는 거부(선택 대상이 될 수 없음), 비정상 수치는 None 으로 폐기(클램프보다 정직)
    with pytest.raises(ValidationError):
        rec.VoiceCandidate(name="이름만")
    c = rec.VoiceCandidate(id="f1", name="가게", congestion="붐빔", distance_m=-5)
    assert c.congestion is None
    assert c.distance_m is None


def test_voice_llm_rate_limit_sliding_window(monkeypatch):
    # 3. IP당 분당 5회 — 6번째는 False(카운트 미소비), 다른 IP 는 독립
    monkeypatch.setattr(rec, "_voice_llm_hits", {})
    for _ in range(rec._VOICE_LLM_RATE_LIMIT):
        assert rec._voice_llm_allowed("1.2.3.4") is True
    assert rec._voice_llm_allowed("1.2.3.4") is False
    assert rec._voice_llm_allowed("5.6.7.8") is True  # 타 IP 독립


def test_voice_llm_rate_limit_window_expiry(monkeypatch):
    # 4. 윈도우(60초) 경과분은 소거 — monotonic 을 조작해 시간 경과 시뮬레이션
    monkeypatch.setattr(rec, "_voice_llm_hits", {})
    fake_now = [1000.0]
    monkeypatch.setattr(rec.time, "monotonic", lambda: fake_now[0])
    for _ in range(rec._VOICE_LLM_RATE_LIMIT):
        assert rec._voice_llm_allowed("9.9.9.9") is True
    assert rec._voice_llm_allowed("9.9.9.9") is False
    fake_now[0] += rec._VOICE_LLM_WINDOW_SEC + 1
    assert rec._voice_llm_allowed("9.9.9.9") is True


# --- llm_status 가 응답까지 그대로 실려 나가는지(E2E) — 판정 로직 자체는 서비스 단위 테스트가 커버 ---


def test_voice_turn_response_includes_llm_status_keyword_path():
    # 키워드 분류기가 바로 판정하는 발화("다음")는 llm_status="keyword"로 응답에 실린다.
    with TestClient(app) as client:
        res = client.post("/api/v1/voice/turn", json={"utterance": "다음", "facility_type": "restaurant"})
    assert res.status_code == 200
    body = res.json()
    assert body["action"] == "next"
    assert body["llm_status"] == "keyword"


def test_voice_turn_response_includes_llm_status_disabled_path():
    # conftest 가 UPSTAGE_API_KEY="" 로 고정 — 키워드로 못 알아듣는 발화는 llm_status="disabled".
    with TestClient(app) as client:
        res = client.post(
            "/api/v1/voice/turn",
            json={"utterance": "조용한 분위기면 좋겠어", "facility_type": "restaurant"},
        )
    assert res.status_code == 200
    body = res.json()
    assert body["action"] == "unknown"
    assert body["llm_status"] == "disabled"


# --- filter 매칭 정본 결정 — Solar(llm_status="llm")가 고른 match_ids 우선(2026-07-18) --------
# 배경: "삼겹살 먹고싶다"에 화덕피자집 추천 사고. 종전 `match = vids or match_ids`가 로컬
# 부분문자열 매처(vids)를 무조건 우선해 Solar 판단이 무시됐다 — llm 턴은 Solar 가 정본이다.

_FILTER_CANDIDATES = [
    {"id": "f1", "name": "화덕피자집", "menu": "불고기 피자 / 마르게리타"},
    {"id": "f2", "name": "황남숯불", "menu": "삼겹살 / 목살"},
]


def _fake_interpret(result: dict):
    async def _interpret(*args, **kwargs):
        return dict(result)
    return _interpret


def _fake_vector(vids: list[str]):
    async def _filter(query, candidates, intent_category=None):
        return list(vids)
    return _filter


def _post_filter_turn(client):
    return client.post(
        "/api/v1/voice/turn",
        json={
            "utterance": "삼겹살 먹고싶다",
            "facility_type": "restaurant",
            "candidates": _FILTER_CANDIDATES,
        },
    )


def test_voice_turn_llm_match_overrides_local_matcher():
    # Solar(llm)가 f2(고깃집)를 골랐으면 로컬 매처가 f1(피자집)을 내놔도 Solar 선택이 정본
    # (교집합이 비므로 Solar 단독 채택 — 로컬 매처 단독 결과로 폴백하지 않는다).
    result = {
        "action": "filter", "target_facility_id": None, "match_ids": ["f2"],
        "search_query": "삼겹살", "intent_category": None,
        "spoken": "고깃집 쪽으로 찾아볼게요.", "llm_status": "llm",
    }
    with patch.object(rec, "interpret_turn", _fake_interpret(result)), \
         patch.object(rec, "vector_filter_candidates", _fake_vector(["f1"])):
        with TestClient(app) as client:
            res = _post_filter_turn(client)
    assert res.status_code == 200
    body = res.json()
    assert body["action"] == "filter"
    assert body["match_ids"] == ["f2"]
    assert body["llm_status"] == "llm"


def test_voice_turn_llm_empty_match_stays_empty():
    # Solar(llm)가 "맞는 곳 없음"(빈 배열)이라 판단 → 로컬 매처 결과로 되살리지 않고 0건 유지
    # (action 은 filter 그대로 — 현재 카드 유지, next 강등 없음).
    result = {
        "action": "filter", "target_facility_id": None, "match_ids": [],
        "search_query": "삼겹살", "intent_category": None,
        "spoken": None, "llm_status": "llm",
    }
    with patch.object(rec, "interpret_turn", _fake_interpret(result)), \
         patch.object(rec, "vector_filter_candidates", _fake_vector(["f1"])):
        with TestClient(app) as client:
            res = _post_filter_turn(client)
    assert res.status_code == 200
    body = res.json()
    assert body["action"] == "filter"
    assert body["match_ids"] == []


def test_voice_turn_keyword_path_keeps_local_matcher():
    # LLM 미개입(llm_status="keyword") — 기존처럼 로컬 매처(vids) 우선 동작 불변.
    result = {
        "action": "filter", "target_facility_id": None, "match_ids": [],
        "search_query": "삼겹살", "intent_category": None,
        "spoken": "고깃집 쪽으로 찾아볼게요.", "llm_status": "keyword",
    }
    with patch.object(rec, "interpret_turn", _fake_interpret(result)), \
         patch.object(rec, "vector_filter_candidates", _fake_vector(["f2"])):
        with TestClient(app) as client:
            res = _post_filter_turn(client)
    assert res.status_code == 200
    body = res.json()
    assert body["action"] == "filter"
    assert body["match_ids"] == ["f2"]
    assert body["llm_status"] == "keyword"


def test_voice_turn_response_includes_llm_status_gated_path_when_rate_limited():
    # 레이트리밋 초과로 LLM 이 게이트에서 막히면 llm_status="gated"(429 아님, unknown 강등).
    with patch.object(voice_intent_service.llm_client, "is_enabled", lambda: True), \
         patch.object(rec, "_voice_llm_allowed", lambda ip: False):
        with TestClient(app) as client:
            res = client.post(
                "/api/v1/voice/turn",
                json={
                    "utterance": "조용한 분위기면 좋겠어",
                    "facility_type": "restaurant",
                    "candidates": [{"id": "f1", "name": "가게1"}],
                },
            )
    assert res.status_code == 200
    body = res.json()
    assert body["action"] == "unknown"
    assert body["llm_status"] == "gated"
