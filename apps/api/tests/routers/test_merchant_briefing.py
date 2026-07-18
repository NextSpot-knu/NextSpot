# 사장님 '오늘의 실행 브리핑'(P1-5) 라우터/서비스 테스트 — LLM·DB·예측 모델 전부 mock.
#  · 인증: require_merchant 실경로(X-Merchant-Token) — test_merchant.py 관례.
#  · DB: 라우터의 supabase_admin(시설 조회)과 서비스의 supabase_admin(타임세일 집계)을
#        각각 FakeSupabase(canned)로 패치 — PostgREST 호출 없음.
#  · 예측: merchant_briefing_service 네임스페이스의 get_model_info/predict_congestion/
#          fetch_latest_congestion_for_all/_utcnow 를 패치 — 결정적 곡선(golden-hour 테스트 관례).
#  · LLM: app.services.llm_client 의 is_enabled/chat_text 를 monkeypatch — 네트워크 0.
#  검증 계약(docs/SOLAR_LLM_EXPANSION.md P1-5):
#    모델 미학습 → LLM 미호출·null / 숫자·금지어(방문객·매출·명)·토큰 오배치·{window} 누락 → 폐기 /
#    argmin 은 서버(최저 혼잡 시각이 치환값으로 확정) / 성공 치환 / facility+시간버킷 캐시 /
#    타임세일 현황은 사실 수집(조회 실패 시 {timesale} 토큰 미제공 → 사용하면 폐기).
import contextlib
import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import merchant
from app.services import llm_client, merchant_briefing_service

# test_routers.py 의 공용 Fake(체이닝 흡수 + table별 canned)를 재사용한다.
from tests.routers.test_routers import FakeSupabase, FakeTable

BRIEFING_PATH = "/api/v1/merchant/briefing"
FACILITY_ID = "fac-brief-1"
MERCHANT_TOKEN = "nextspot-merchant-local"  # merchant.py 기본 토큰(test_merchant.py 와 동일 전제)

# UTC 03:00 = KST 12:00, 2026-07-06 은 월요일. 예측 창(h=0..6)은 UTC 3..9시 = KST 12..18시.
FIXED_NOW = datetime(2026, 7, 6, 3, 0, 0, tzinfo=timezone.utc)

_FACILITY_ROW = {"id": FACILITY_ID, "type": "cafe"}


def _merchant_headers(token: str | None = None) -> dict:
    return {"X-Merchant-Token": token or MERCHANT_TOKEN}


def _fake_predict(_facility_type: str, hour: int, _dow: int) -> float:
    """UTC 7시(=KST 16시)만 0.05, 나머지 0.5 — 결정적 타입 수준 곡선(golden-hour 테스트 미러)."""
    return 0.05 if hour == 7 else 0.5


# 실측 0.9 → offset = 0.9 - base_now(0.5) = 0.4. 최저는 KST 16시: 0.05+0.4=0.45 → "45%".
_CONGESTION_MAP = {
    FACILITY_ID: {"level": 0.9, "current_count": 90, "timestamp": "2026-07-06T03:00:00+00:00"}
}

# 숫자 없이 토큰만 배치한 정직한 템플릿 — 서버가 앞으로 6시간/16시~17시/45%/타임세일 현황으로 치환.
_HONEST_TEMPLATE = (
    "{window} 중 가장 한산한 시간대는 {low_hour}(예상 혼잡도 {low_congestion})입니다. "
    "현재 {timesale} 상태이니 이 시간대 타임세일 발행을 고려해보세요."
)
_RENDERED_TEXT = (
    "앞으로 6시간 중 가장 한산한 시간대는 16시~17시(예상 혼잡도 45%)입니다. "
    "현재 진행 중인 타임세일 없음 상태이니 이 시간대 타임세일 발행을 고려해보세요."
)


@pytest.fixture
def client():
    # 라우터 자체를 격리 검증(test_merchant.py 관례) — main 앱 lifespan 의존 없음.
    test_app = FastAPI()
    test_app.include_router(merchant.router)
    with TestClient(test_app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_briefing_cache():
    merchant_briefing_service._cache.clear()
    yield
    merchant_briefing_service._cache.clear()


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


@contextlib.contextmanager
def _briefing_env(
    facilities: list | None = None,
    timesales: list | None = None,
    trained: bool = True,
    congestion_map: dict | None = None,
):
    """라우터 DB + 서비스 DB/예측/시각을 한 번에 패치하는 표준 환경."""
    with patch(
        "app.routers.merchant.supabase_admin",
        new=FakeSupabase({"facilities": facilities if facilities is not None else [_FACILITY_ROW]}),
    ), patch.object(
        merchant_briefing_service, "supabase_admin",
        new=FakeSupabase({"merchant_timesales": timesales or []}),
    ), patch.object(
        merchant_briefing_service, "get_model_info",
        return_value={"trained": trained, "metrics": None},
    ), patch.object(
        merchant_briefing_service, "predict_congestion", side_effect=_fake_predict,
    ), patch.object(
        merchant_briefing_service, "fetch_latest_congestion_for_all",
        new=AsyncMock(return_value=_CONGESTION_MAP if congestion_map is None else congestion_map),
    ), patch.object(
        merchant_briefing_service, "_utcnow", return_value=FIXED_NOW,
    ):
        yield


def _get(client, facility_id: str = FACILITY_ID, headers: dict | None = None):
    return client.get(
        BRIEFING_PATH,
        params={"facility_id": facility_id},
        headers=_merchant_headers() if headers is None else headers,
    )


# =========================================================================
# 1. require_merchant 가드 — 헤더 없음/오답 토큰 → 401
# =========================================================================


def test_briefing_no_header_401(client):
    res = client.get(BRIEFING_PATH, params={"facility_id": FACILITY_ID})
    assert res.status_code == 401


def test_briefing_wrong_token_401(client):
    res = _get(client, headers=_merchant_headers("wrong-token"))
    assert res.status_code == 401


# =========================================================================
# 2. 시설 없음 → 404, LLM 미호출
# =========================================================================


def test_briefing_facility_not_found_404(client, llm_calls):
    with _briefing_env(facilities=[]):
        res = _get(client, facility_id="ghost")
    assert res.status_code == 404
    assert llm_calls["prompts"] == []


# =========================================================================
# 3. 예측 데이터 부족(모델 미학습) — LLM 호출 자체가 없다(정직한 스킵)
# =========================================================================


def test_briefing_untrained_model_skips_llm(client, llm_calls):
    with _briefing_env(trained=False):
        res = _get(client)
    assert res.status_code == 200
    assert res.json() == {"briefing": None, "llmStatus": "skipped"}
    assert llm_calls["prompts"] == []


# =========================================================================
# 4. 키 미설정 — 조용한 null (conftest 가 UPSTAGE_API_KEY="" 고정 → is_enabled=False)
# =========================================================================


def test_briefing_disabled_without_key(client, monkeypatch):
    async def _must_not_call(*_args, **_kwargs):
        raise AssertionError("키 미설정이면 chat_text 가 호출되면 안 된다")

    monkeypatch.setattr(llm_client, "chat_text", _must_not_call)
    with _briefing_env():
        res = _get(client)
    assert res.status_code == 200
    assert res.json() == {"briefing": None, "llmStatus": "disabled"}


# =========================================================================
# 5. 정직성 게이트 — 위반 시 전량 폐기(briefing=None)
# =========================================================================


def _assert_rejected(client, llm_calls, reply: str):
    llm_calls["reply"] = reply
    with _briefing_env():
        res = _get(client)
    assert res.status_code == 200
    assert res.json() == {"briefing": None, "llmStatus": "rejected"}


def test_briefing_rejects_any_digits(client, llm_calls):
    # 플레이스홀더 설계 — 시각·%를 포함한 모든 숫자는 출처 불문 폐기(창작·변형 원천 차단).
    _assert_rejected(client, llm_calls, "{window} 중 15시가 한산할 것으로 예측됩니다. 시간대는 {low_hour}입니다.")


def test_briefing_rejects_visitor_word(client, llm_calls):
    # ForecastSection honestNote 원칙 — 혼잡도 예측을 '방문객'으로 둔갑 금지.
    _assert_rejected(
        client, llm_calls,
        "{window} 중 가장 한산한 시간대는 {low_hour}입니다. 방문객이 적을 것으로 예상됩니다.",
    )


def test_briefing_rejects_revenue_word(client, llm_calls):
    _assert_rejected(
        client, llm_calls,
        "{window} 중 가장 한산한 시간대는 {low_hour}입니다. 매출을 끌어올릴 기회입니다.",
    )


def test_briefing_rejects_head_count_words(client, llm_calls):
    # 단위 명사 '명'(조사 결합 포함)과 '몇' — 손님 수 함의 금지.
    _assert_rejected(
        client, llm_calls,
        "{window} 중 가장 한산한 시간대는 {low_hour}이며 열 명이 몰릴 수 있습니다.",
    )
    _assert_rejected(
        client, llm_calls,
        "{window} 중 가장 한산한 시간대는 {low_hour}이며 몇 분 정도 여유가 있습니다.",
    )


def test_briefing_rejects_native_korean_numerals(client, llm_calls):
    # 공용 게이트의 한자어 수사 패턴이 못 잡는 고유어 수사("여섯 시간") — 머천트 금지어로 폐기.
    _assert_rejected(
        client, llm_calls,
        "앞으로 여섯 시간 중 가장 한산한 시간대는 {low_hour}입니다. 범위는 {window}입니다.",
    )


def test_briefing_rejects_missing_window_token(client, llm_calls):
    # 스코프 정직(계약 ①) — {window} 미포함이면 '하루 전체' 함의 위험 → 폐기.
    _assert_rejected(
        client, llm_calls,
        "가장 한산한 시간대는 {low_hour}(예상 혼잡도 {low_congestion})입니다. 타임세일 발행을 고려해보세요.",
    )


def test_briefing_rejects_missing_low_hour_token(client, llm_calls):
    # 핵심 사실(최저 혼잡 창) 없는 감상문 — 폐기.
    _assert_rejected(client, llm_calls, "{window} 동안 전반적으로 여유가 예상됩니다.")


def test_briefing_rejects_misplaced_low_hour(client, llm_calls):
    # 토큰 문맥 게이트 — {low_hour}(최저 혼잡 시간대)를 타임세일 시각 자리에 두면 사실 왜곡.
    _assert_rejected(client, llm_calls, "{window} 중 타임세일 종료 시각은 {low_hour}입니다.")


def test_briefing_rejects_unknown_placeholder(client, llm_calls):
    # 화이트리스트 밖 토큰({visitors}) — 서버가 치환할 수 없는 슬롯은 폐기.
    _assert_rejected(
        client, llm_calls,
        "{window} 중 가장 한산한 시간대는 {low_hour}이고 예상 유입은 {visitors}입니다.",
    )


def test_briefing_rejects_trend_words(client, llm_calls):
    # 비교·추세 어휘 전역 금지(공용 게이트) — 전일 기준선이 없는 지표의 창작 비교 차단.
    _assert_rejected(
        client, llm_calls,
        "{window} 중 가장 한산한 시간대는 {low_hour}로 어제보다 완화될 전망입니다.",
    )


def test_briefing_rejects_more_than_three_sentences(client, llm_calls):
    # 계약 '2~3문장 행동 브리핑' — 4문장 이상 폐기(공용 게이트 max_sentences=3).
    _assert_rejected(
        client, llm_calls,
        "{window} 기준 요약입니다. 가장 한산한 시간대는 {low_hour}입니다. 여유가 예상됩니다. 참고하세요.",
    )


# =========================================================================
# 6. 성공 경로 — argmin 은 서버, 게이트 통과 템플릿을 서버 수치로 치환
# =========================================================================


def test_briefing_success_renders_server_computed_values(client, llm_calls):
    with _briefing_env():
        res = _get(client)
    assert res.status_code == 200
    assert res.json() == {"briefing": _RENDERED_TEXT, "llmStatus": "llm"}
    body = res.json()["briefing"]
    # 치환 후 플레이스홀더 잔존 0 — 수치(창·최저 시각·혼잡도)는 전부 서버 계산값.
    assert "{" not in body and "}" not in body
    assert "앞으로 6시간" in body      # 스코프 명시(계약 ①)
    assert "16시~17시" in body         # argmin=KST 16시(앵커링 0.05+0.4=0.45) — 서버가 결정
    assert "45%" in body
    # user 프롬프트는 사실 JSON 원형(json.dumps 경계) — 서버 확정값만 담긴다.
    assert len(llm_calls["prompts"]) == 1
    facts = json.loads(llm_calls["prompts"][0])
    assert facts["forecast_window"] == "앞으로 6시간"
    assert facts["lowest_congestion_hour_kst"] == "16시~17시"
    assert facts["lowest_congestion_percent"] == "45%"
    assert facts["anchored_to_recent_log"] is True
    assert facts["active_timesale_count"] == 0
    assert set(facts["available_placeholders"]) == {"window", "low_hour", "low_congestion", "timesale"}


def test_briefing_active_timesale_count_is_server_fact(client, llm_calls):
    # 활성 타임세일 2건 → {timesale} 치환문 "진행 중인 타임세일 2건" — 건수는 서버 집계.
    timesales = [{"id": "ts-1"}, {"id": "ts-2"}]
    with _briefing_env(timesales=timesales):
        res = _get(client)
    assert res.status_code == 200
    assert res.json()["llmStatus"] == "llm"
    assert "진행 중인 타임세일 2건" in res.json()["briefing"]


def test_briefing_timesale_lookup_failure_drops_token(client, llm_calls):
    # 타임세일 조회 실패 → 지어내지 않고 {timesale} 토큰 자체를 미제공 —
    # 템플릿이 {timesale} 을 쓰면 화이트리스트 게이트에서 폐기된다(무해 폴백은 유지).
    class _RaisingTable(FakeTable):
        def execute(self):
            raise RuntimeError('relation "merchant_timesales" does not exist')

    class _RaisingTimesaleSupabase:
        def table(self, name: str):
            if name == "merchant_timesales":
                return _RaisingTable([])
            return FakeTable([])

    with _briefing_env(), patch.object(
        merchant_briefing_service, "supabase_admin", new=_RaisingTimesaleSupabase()
    ):
        res = _get(client)
    assert res.status_code == 200
    assert res.json() == {"briefing": None, "llmStatus": "rejected"}


def test_briefing_unanchored_when_no_recent_log(client, llm_calls):
    # 실측 로그 없음 → offset 0(타입 수준 원값) — 최저는 KST 16시 0.05 → "5%", 정직 표기 유지.
    with _briefing_env(congestion_map={}):
        res = _get(client)
    assert res.status_code == 200
    assert res.json()["llmStatus"] == "llm"
    assert "16시~17시" in res.json()["briefing"]
    assert "5%" in res.json()["briefing"]
    facts = json.loads(llm_calls["prompts"][0])
    assert facts["anchored_to_recent_log"] is False


# =========================================================================
# 7. 캐시 — facility_id + KST 시간 버킷 키, 히트 시 LLM 재호출 0
# =========================================================================


def test_briefing_cache_hit_skips_second_llm_call(client, llm_calls):
    with _briefing_env():
        first = _get(client)
        second = _get(client)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json() == {"briefing": _RENDERED_TEXT, "llmStatus": "llm"}
    assert len(llm_calls["prompts"]) == 1  # 두 번째 요청은 캐시 히트 — 재호출 0


def test_briefing_cache_is_per_facility(client, llm_calls):
    # 다른 시설은 다른 캐시 키 — 시설 간 브리핑이 섞이지 않는다.
    facilities = [_FACILITY_ROW, {"id": "fac-brief-2", "type": "cafe"}]
    with _briefing_env(facilities=facilities):
        _get(client, facility_id=FACILITY_ID)
        _get(client, facility_id="fac-brief-2")
    assert len(llm_calls["prompts"]) == 2


def test_briefing_failure_cache_expires_quickly(client, llm_calls, monkeypatch):
    # P0-2 관례 — 거부 결과는 1분 TTL: 일시 오류가 30분 비활성으로 확대되지 않는다.
    llm_calls["reply"] = "오늘 방문객이 1200명으로 예상됩니다."  # 숫자+금지어 → 거부
    with _briefing_env():
        first = _get(client)
        assert first.json() == {"briefing": None, "llmStatus": "rejected"}
        base = merchant_briefing_service.time.monotonic()
        monkeypatch.setattr(merchant_briefing_service.time, "monotonic", lambda: base + 61.0)
        llm_calls["reply"] = _HONEST_TEMPLATE
        second = _get(client)
    assert second.json() == {"briefing": _RENDERED_TEXT, "llmStatus": "llm"}
    assert len(llm_calls["prompts"]) == 2  # 실패 TTL 만료 → 재시도 1회


# =========================================================================
# 8. 게이트 단위 검증 — 공용 게이트 재사용 파라미터가 admin 기본값과 분리돼 있는지
# =========================================================================


def test_gate_allows_three_sentences_but_admin_default_still_two():
    from app.services import briefing_service

    allowed = {"window", "low_hour", "low_congestion"}
    three = "범위는 {window}입니다. 가장 한산한 시간대는 {low_hour}입니다. 발행을 고려해보세요."
    assert merchant_briefing_service.is_honest_merchant_briefing(three, allowed)
    # admin 기본 게이트(max_sentences=2)는 동일 문장 수를 거부한다 — 파라미터 분리 확인.
    assert not briefing_service.is_honest_briefing("{avg}입니다. {avg}입니다. {avg}입니다.", {"avg"})


def test_gate_requires_window_and_low_hour_tokens():
    allowed = {"window", "low_hour", "low_congestion", "timesale"}
    assert not merchant_briefing_service.is_honest_merchant_briefing(
        "현재 {timesale} 상태입니다.", allowed
    )
    assert merchant_briefing_service.is_honest_merchant_briefing(
        "{window} 중 가장 한산한 시간대는 {low_hour}입니다.", allowed
    )
