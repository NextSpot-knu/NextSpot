# 관제 대시보드 '오늘의 브리핑'(P0-2) 라우터/서비스 테스트 — LLM·supabase 전부 mock.
#  · 인증: require_admin 실경로(X-Admin-Authorization) — test_routers.py 관례.
#  · DB: app.routers.admin.supabase_admin 을 FakeSupabase(canned)로 패치 — 네트워크 0.
#  · LLM: app.services.llm_client 의 is_enabled/chat_text 를 monkeypatch — 네트워크 0.
#  검증 계약(docs/SOLAR_LLM_EXPANSION.md P0-2 + Codex 적대 감사 반영 — 플레이스홀더 설계):
#    hasLogs=False → LLM 미호출·null / 숫자·수사·미지 토큰·추세어 → 폐기 /
#    성공 → 템플릿 치환 채택+llmStatus / 캐시 히트 → 재호출 0 / 키 미설정 → 조용한 null.
#  적대 사례(감사 실증 우회 경로)를 전부 회귀로 고정한다: 한글 수사, 천 단위 콤마,
#  부호 숫자, 쉼표 절 분리 추세어, '이상' 없는 동의 표현, 3문장 초과, 무플레이스홀더.
import json
from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import briefing_service, llm_client

# test_routers.py 의 공용 Fake(체이닝 흡수 + table별 canned)와 관리자 헤더 헬퍼를 재사용한다.
from tests.routers.test_routers import FakeSupabase, _admin_headers

BRIEFING_PATH = "/api/v1/admin/dashboard/briefing"

_NOW_ISO = datetime.now(timezone.utc).isoformat()

# hasLogs=True 가 되는 최소 표본(5건) — 전부 0.8(이상 임계 0.9 미만 → anomalyCount=0).
# get_dashboard_today 는 오늘/어제 두 쿼리를 같은 canned 테이블에서 받으므로 전일 변화율은 0.0.
_LOGS_08 = [
    {
        "congestion_level": 0.8,
        "current_count": 40,
        "timestamp": _NOW_ISO,
        "facility": {"name": "황리단길 카페", "type": "cafe"},
    }
    for _ in range(5)
]

# get_impact(accepted=True 필터는 FakeTable 이 흡수) — 재배치 1건, 절감 20-5=15.0분.
_ACCEPTED_RECS = [
    {
        "accepted": True,
        "created_at": _NOW_ISO,
        "score_breakdown": {"original_wait_time": 20.0, "wait_time": 5.0},
    }
]

# 숫자 없이 플레이스홀더만 쓰는 정직한 템플릿 — 서버가 80.0%/1건/15분으로 치환한다.
_HONEST_TEMPLATE = "오늘 평균 혼잡도는 {avg}이며, 수락된 재배치 {relocations}으로 대기시간 {saved}을 절감했습니다."
_RENDERED_TEXT = "오늘 평균 혼잡도는 80.0%이며, 수락된 재배치 1건으로 대기시간 15분을 절감했습니다."


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_briefing_cache():
    """KST 날짜 키 TTL 캐시를 테스트 간 격리 — 이전 테스트의 결과 재사용 방지."""
    briefing_service._cache.clear()
    yield
    briefing_service._cache.clear()


@pytest.fixture
def llm_calls(monkeypatch):
    """is_enabled=True + chat_text 호출 기록. 반환 텍스트는 calls['reply'] 로 테스트별 지정."""
    calls = {"prompts": [], "reply": _HONEST_TEMPLATE}

    async def _fake_chat_text(system, user, **_kwargs):
        calls["prompts"].append(user)
        return calls["reply"]

    monkeypatch.setattr(llm_client, "is_enabled", lambda: True)
    monkeypatch.setattr(llm_client, "chat_text", _fake_chat_text)
    return calls


def _patched_db(tables: dict):
    return patch("app.routers.admin.supabase_admin", new=FakeSupabase(tables))


# =========================================================================
# 인증 가드 — 관리자 헤더 없으면 401 (require_admin 실경로)
# =========================================================================

def test_briefing_requires_admin_header(client):
    assert client.get(BRIEFING_PATH).status_code == 401


# =========================================================================
# 스킵 경로 — hasLogs=False / 전 지표 0 이면 LLM 호출 자체가 없다
# =========================================================================

def test_briefing_no_logs_skips_llm(client, llm_calls):
    with _patched_db({"congestion_logs": [], "recommendations": []}):
        res = client.get(BRIEFING_PATH, headers=_admin_headers())
    assert res.status_code == 200
    assert res.json() == {"briefing": None, "llmStatus": "skipped"}
    assert llm_calls["prompts"] == []  # LLM 미호출


def test_briefing_all_zero_metrics_skips_llm(client, llm_calls):
    zero_logs = [
        {"congestion_level": 0.0, "current_count": 0, "timestamp": _NOW_ISO,
         "facility": {"name": "황리단길 카페", "type": "cafe"}}
        for _ in range(5)
    ]
    with _patched_db({"congestion_logs": zero_logs, "recommendations": []}):
        res = client.get(BRIEFING_PATH, headers=_admin_headers())
    assert res.status_code == 200
    assert res.json() == {"briefing": None, "llmStatus": "skipped"}
    assert llm_calls["prompts"] == []


# =========================================================================
# 키 미설정 — 조용한 null (conftest 가 UPSTAGE_API_KEY="" 고정 → is_enabled=False)
# =========================================================================

def test_briefing_disabled_without_key(client, monkeypatch):
    async def _must_not_call(*_args, **_kwargs):
        raise AssertionError("키 미설정이면 chat_text 가 호출되면 안 된다")

    monkeypatch.setattr(llm_client, "chat_text", _must_not_call)
    with _patched_db({"congestion_logs": _LOGS_08, "recommendations": _ACCEPTED_RECS}):
        res = client.get(BRIEFING_PATH, headers=_admin_headers())
    assert res.status_code == 200
    assert res.json() == {"briefing": None, "llmStatus": "disabled"}


# =========================================================================
# 정직성 게이트 — 위반 시 전량 폐기(briefing=None)
# Codex 감사가 실증한 우회 경로 전부를 회귀로 고정한다.
# =========================================================================

def _assert_rejected(client, llm_calls, reply: str):
    # 직전 거부 결과가 실패 캐시(60s)에 남아 다음 검증이 게이트를 안 타고 통과하는 것을
    # 방지 — 이 캐시 마스킹으로 Ⅹ(로마 숫자) 우회가 테스트를 가짜 통과한 전례가 있다.
    briefing_service._cache.clear()
    llm_calls["reply"] = reply
    with _patched_db({"congestion_logs": _LOGS_08, "recommendations": _ACCEPTED_RECS}):
        res = client.get(BRIEFING_PATH, headers=_admin_headers())
    assert res.status_code == 200
    assert res.json() == {"briefing": None, "llmStatus": "rejected"}


def test_briefing_rejects_any_digits(client, llm_calls):
    # 플레이스홀더 설계 — 아라비아 숫자는 출처 불문 전량 폐기(창작·콤마·부호 변형 원천 차단).
    _assert_rejected(client, llm_calls, "오늘 방문객이 1200명으로 집계됐습니다.")


def test_briefing_rejects_comma_and_signed_numbers(client, llm_calls):
    # 감사 사례: "2,026명" 콤마 분해·"+10%" 부호 반전 — 숫자 금지 규칙이 전부 걸러야 한다.
    _assert_rejected(client, llm_calls, "방문객 2,026명이 다녀갔고 혼잡은 +10% 변동했습니다.")


def test_briefing_rejects_korean_numerals(client, llm_calls):
    # 감사 사례: 한글 수사("삼 건")는 숫자 정규식에 안 잡히던 우회 — 수사+단위 패턴으로 폐기.
    _assert_rejected(client, llm_calls, "오늘 이상 혼잡이 삼 건 감지되었습니다. 현황은 {avg}입니다.")
    # 고유어 수사("두 건")도 동일 — P1-5 머천트 게이트에서 역이식된 패턴.
    _assert_rejected(client, llm_calls, "오늘 이상 혼잡이 두 건 감지되었습니다. 현황은 {avg}입니다.")


def test_briefing_rejects_unknown_placeholder(client, llm_calls):
    # 화이트리스트 밖 토큰({visitors}) — 서버가 치환할 수 없는 슬롯은 폐기.
    _assert_rejected(client, llm_calls, "오늘 {visitors}가 방문했고 혼잡도는 {avg}입니다.")


def test_briefing_rejects_trend_words_even_in_split_clause(client, llm_calls):
    # 감사 사례: 쉼표 절 분리("이상 혼잡은 N건, 전일보다 증가") — 추세어는 전역 금지라 절
    # 분리로 우회할 수 없다. 방향 서술은 서버 {change} 치환문만 가능.
    _assert_rejected(client, llm_calls, "이상 혼잡은 {anomalies}, 전일보다 증가했습니다.")


def test_briefing_rejects_trend_synonyms_without_anomaly_word(client, llm_calls):
    # 감사 사례: '이상' 없는 동의 표현("고혼잡 건수가 많아졌습니다") — 전역 금지 어휘로 폐기.
    _assert_rejected(client, llm_calls, "고혼잡 건수가 많아졌습니다. 현재 {avg} 수준입니다.")


def test_briefing_rejects_more_than_two_sentences(client, llm_calls):
    # 계약 '한국어 1~2문장'을 코드로 강제 — 3문장 이상 폐기.
    _assert_rejected(client, llm_calls, "혼잡도는 {avg}입니다. 이상은 {anomalies}입니다. 재배치는 {relocations}입니다.")


def test_briefing_rejects_text_without_placeholder(client, llm_calls):
    # 사실 슬롯이 하나도 없는 감상문은 브리핑이 아니다 — 폐기.
    _assert_rejected(client, llm_calls, "오늘은 전반적으로 평온한 하루였습니다.")


def test_briefing_rejects_unicode_numerals(client, llm_calls):
    # 2차 감사: 원문자 ①·로마 숫자 Ⅹ 는 \d 에 안 잡히던 우회 — 유니코드 N* 카테고리로 거부.
    _assert_rejected(client, llm_calls, "이상 혼잡이 ①건이며 평균 혼잡도는 {avg}입니다.")
    _assert_rejected(client, llm_calls, "이상 혼잡이 Ⅹ건이며 평균 혼잡도는 {avg}입니다.")


def test_briefing_rejects_vague_quantity_words(client, llm_calls):
    # 2차 감사: 숫자 없이 규모를 창작하는 비정량 수량어("여러 재배치") — 폐기.
    _assert_rejected(client, llm_calls, "여러 재배치가 있었고 집계는 재배치 {relocations}입니다.")


def test_briefing_rejects_misplaced_placeholder(client, llm_calls):
    # 2차 감사 P0: 토큰 의미 오배치 — {anomalies}(이상건수)를 재배치 자리에 두면 치환 후
    # "0건의 재배치" 같은 사실 왜곡이 된다. 토큰 직전 문맥의 지표 키워드 검증으로 폐기.
    _assert_rejected(client, llm_calls, "{anomalies}의 재배치가 있었고 평균 혼잡도는 {avg}입니다.")
    _assert_rejected(client, llm_calls, "절감 대기시간은 {relocations}이며 재배치 실적은 {saved}입니다.")


def test_briefing_rejects_extremum_trend_synonyms(client, llm_calls):
    # 2차 감사: 블랙리스트 밖이던 극값·기준 돌파 표현("웃돌"·"기록적"·"처음으로") — 확장 목록으로 폐기.
    _assert_rejected(client, llm_calls, "평균 혼잡도는 {avg}로 기준을 웃돌았습니다.")
    _assert_rejected(client, llm_calls, "평균 혼잡도는 {avg}로 기록적 수준입니다.")
    _assert_rejected(client, llm_calls, "평균 혼잡도는 {avg}로 처음으로 안전권입니다.")


def test_change_placeholder_unavailable_without_baseline():
    # changePercent=None(전일 표본 없음)이면 서버가 {change} 자체를 제공하지 않는다 —
    # LLM 이 써도 화이트리스트 게이트에서 폐기된다("전일과 동일" 류 창작 비교의 서버측 차단).
    built = briefing_service.build_facts(
        {"hasLogs": True, "avgCongestion": {"value": 0.8, "changePercent": None}, "anomalyCount": 0},
        {"relocations": 1, "saved_wait_minutes": 15.0},
    )
    assert built is not None and "change" not in built["placeholders"]
    assert not briefing_service.is_honest_briefing(
        "평균 혼잡도는 {avg}로 {change}입니다.", set(built["placeholders"])
    )


# =========================================================================
# 성공 경로 — 게이트 통과 템플릿을 서버가 치환해 채택, 프롬프트는 사실 JSON(데이터 경계)
# =========================================================================

def test_briefing_success_renders_placeholders(client, llm_calls):
    with _patched_db({"congestion_logs": _LOGS_08, "recommendations": _ACCEPTED_RECS}):
        res = client.get(BRIEFING_PATH, headers=_admin_headers())
    assert res.status_code == 200
    assert res.json() == {"briefing": _RENDERED_TEXT, "llmStatus": "llm"}
    # 치환 후 문자열에 플레이스홀더 잔존 0 — 수치는 전부 서버 값(80.0%·1건·15분).
    body = res.json()["briefing"]
    assert "{" not in body and "}" not in body
    # user 프롬프트는 사실 JSON 원형(json.dumps 경계) — 대시보드와 동일 포맷 수치가 들어간다.
    assert len(llm_calls["prompts"]) == 1
    facts = json.loads(llm_calls["prompts"][0])
    assert facts["avg_congestion_percent"] == "80.0%"
    assert facts["accepted_relocations_today"] == 1
    assert facts["saved_wait_minutes_today"] == 15.0
    assert "avg" in facts["available_placeholders"]


def test_briefing_change_placeholder_direction_is_server_owned(client, llm_calls):
    # {change} 치환문은 서버가 changePercent 부호로 방향을 결정한다 — LLM 은 방향을 쓸 수 없다.
    # canned 는 오늘/어제 동일 테이블이라 변화율 0 → "전일과 동일한 수준".
    llm_calls["reply"] = "평균 혼잡도는 {avg}로 {change}입니다."
    with _patched_db({"congestion_logs": _LOGS_08, "recommendations": _ACCEPTED_RECS}):
        res = client.get(BRIEFING_PATH, headers=_admin_headers())
    assert res.status_code == 200
    assert res.json()["llmStatus"] == "llm"
    assert "전일과 동일한 수준" in res.json()["briefing"]


# =========================================================================
# 캐시 — 12분 TTL 내 재요청은 LLM 재호출 0 (같은 응답 재사용)
# =========================================================================

def test_briefing_cache_hit_skips_second_llm_call(client, llm_calls):
    with _patched_db({"congestion_logs": _LOGS_08, "recommendations": _ACCEPTED_RECS}):
        first = client.get(BRIEFING_PATH, headers=_admin_headers())
        second = client.get(BRIEFING_PATH, headers=_admin_headers())
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json() == {"briefing": _RENDERED_TEXT, "llmStatus": "llm"}
    assert len(llm_calls["prompts"]) == 1  # 두 번째 요청은 캐시 히트 — 재호출 0


def test_briefing_failure_cache_expires_quickly(client, llm_calls, monkeypatch):
    # 2차 감사 P2: 거부 결과가 12분 캐시되면 일시 오류가 장시간 비활성으로 확대된다 —
    # 실패 TTL(60초) 경과 후에는 재시도해 정상 응답으로 회복돼야 한다.
    llm_calls["reply"] = "오늘 방문객이 1200명으로 집계됐습니다."  # 숫자 → 거부
    with _patched_db({"congestion_logs": _LOGS_08, "recommendations": _ACCEPTED_RECS}):
        first = client.get(BRIEFING_PATH, headers=_admin_headers())
        assert first.json() == {"briefing": None, "llmStatus": "rejected"}
        base = briefing_service.time.monotonic()
        monkeypatch.setattr(briefing_service.time, "monotonic", lambda: base + 61.0)
        llm_calls["reply"] = _HONEST_TEMPLATE
        second = client.get(BRIEFING_PATH, headers=_admin_headers())
    assert second.json() == {"briefing": _RENDERED_TEXT, "llmStatus": "llm"}
    assert len(llm_calls["prompts"]) == 2  # 실패 TTL 만료 → 재시도 1회
