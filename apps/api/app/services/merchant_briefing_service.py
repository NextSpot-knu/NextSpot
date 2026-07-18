"""사장님 콘솔 '오늘의 실행 브리핑' — 6시간 혼잡 예측 창의 사실을 한국어 2~3문장 프로즈화 (P1-5).

docs/SOLAR_LLM_EXPANSION.md P1-5 계약 — P0-2(briefing_service)의 플레이스홀더 치환 설계를
공용 게이트(is_honest_briefing 파라미터화)로 재사용한다:

  - LLM 은 수치·시각·%를 일절 쓰지 못하고 {window} {low_hour} {low_congestion} {timesale}
    토큰만 배치한다. 실제 값은 게이트 통과 후 서버가 치환 — 숫자의 창작·변형이 구조적으로 불가능.
  - 최저 혼잡 시간대의 argmin 은 서버가 계산한다(LLM 이 고르지 않음). 산식은 기존
    /predict/golden-hour(predict.py) 와 동일: predict_congestion 타입 수준 곡선 +
    현재 실측 로그 앵커링(offset = 현재실측 − 지금 시점 타입수준예측), clamp01.
    단 창은 골든아워의 '오늘 남은 시간대'가 아니라 머천트 예측 섹션과 동일한
    **앞으로 6시간**(hours_ahead 0..6, /predict/batch 의 UTC target 시각 방식)이다.
  - 스코프 정직(계약 ①): {window}("앞으로 6시간") 토큰 사용을 게이트가 강제한다 —
    하루 전체를 함의하는 브리핑이 나올 수 없다. 창 밖 시각 언급은 숫자 전면 금지가 구조적으로 차단.
  - 실행 결정 금지(계약 ③): 할인율·발행 시점을 LLM 이 결정할 수 없다 — 숫자 금지가 할인율/시각
    구체화를 차단하고, 이 모듈은 어떤 쓰기 동작(타임세일 발행 등)도 하지 않는다(읽기 전용).
    "타임세일 발행을 고려해보세요" 류 제안 문구까지만 허용(프롬프트 지시 + 잔존 리스크 문서화).
  - 금지어(ForecastSection honestNote 원칙): 혼잡 '예측'을 방문객 수·매출로 둔갑시키는 어휘
    (방문객/매출/손님/고객/인원/몇/단독 '명'/고유어 수사+단위)는 전량 폐기.
  - 무해 폴백: 키 미설정/모델 미학습/타임아웃/파싱 실패/게이트 거부 → briefing=None.
    프런트는 null 이면 카드 자체를 렌더하지 않는다.
  - 캐시: facility_id + KST 시간 버킷 키(모듈 전역 dict + monotonic). 성공 30분(계약 30~60분),
    거부·실패 1분(P0-2 관례 — 일시 장애가 장시간 비활성으로 확대되지 않게).
  - 응답 본문은 로그에 남기지 않는다(길이만) — §-14 보안 관례.
"""

import asyncio
import json
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import structlog

from app.core.supabase import supabase_admin
from app.routers.infrastructures import fetch_latest_congestion_for_all
from app.services import briefing_service, llm_client
from app.services.predict_service import get_model_info, predict_congestion

logger = structlog.get_logger()

_KST = timezone(timedelta(hours=9))
_WINDOW_HOURS = 6            # merchant-api.ts 예측 섹션과 동일한 6시간 창 — 계약 ①
_CACHE_TTL_SECONDS = 1800.0  # 성공 30분 — 계약 범위(30~60분) 하한(예측 창이 시간 단위로 움직인다)
_FAILURE_TTL_SECONDS = 60.0  # 거부·실패는 1분만(P0-2 관례)
_LLM_MAX_TOKENS = 300        # 한국어 2~3문장이면 충분
_MAX_SENTENCES = 3           # 기획: "2~3문장 행동 브리핑" — 상한 3(하한 1은 공용 게이트)

# facility_id:KST시간버킷 → (monotonic 시각, TTL, 응답 dict). LLM 을 실제 시도한 결과만 저장
# (skipped/disabled 는 호출 비용이 없어 캐싱하지 않는다 — briefing_service 관례).
_cache: dict[str, tuple[float, float, dict]] = {}

# 머천트 금지어(계약 ② + ForecastSection honestNote 원칙): 이 브리핑의 근거는 '혼잡도 예측'뿐이다.
#  - 방문객/매출/손님/고객/인원: 입력에 없는 지표로 둔갑 금지.
#  - 몇: 비정량 수량 창작("몇 명", "몇 시쯤").
#  - 단위 명사 '명': 어두(비한글 뒤)의 명이 조사·공백·문장부호로 이어지는 꼴만 잡는다 —
#    "설명"·"유명"(명 앞이 한글)과 "명소"·"명확"(명 뒤가 조사 아님) 오탐 회피.
#  - 고유어 수사+단위(한/두/…/열 + 건·명·분·곳·회·배·시간·시): 공용 게이트의 한자어 수사
#    패턴([일이삼…])이 못 잡는 "여섯 시간"·"두 건" 우회 차단. 어두 경계(?<![가-힣])로
#    "한산한 시간대" 류 오탐을 피한다. 오탐(보수적 폐기)은 무해 — admin 게이트와 동일 원칙.
_MERCHANT_FORBIDDEN_RE = re.compile(
    r"방문객|매출|손님|고객|인원|몇"
    r"|(?<![가-힣])명(?=$|[^가-힣]|[이은는을도의만과와나까꼴])"
    r"|(?<![가-힣])(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s?(?:건|명|분|곳|회|배|시간|시)"
)

# 게이트가 사용을 강제하는 토큰 — {window} 는 스코프 정직(계약 ①), {low_hour} 는 브리핑의
# 핵심 사실(최저 혼잡 창) 자체다. 없으면 '하루 전체 함의' 또는 '사실 없는 감상문'이라 폐기.
_REQUIRED_TOKENS = frozenset({"window", "low_hour"})

# 토큰 문맥 게이트 키워드 맵(공용 _token_context_ok 파라미터) — 직전 25자 검증.
# 빈 튜플 = 자기서술형 토큰: 치환문 자체가 지표명을 포함해("앞으로 6시간",
# "진행 중인 타임세일 N건") 오배치가 사실 왜곡이 되지 않는다 → 문두 배치 허용.
_TOKEN_CONTEXT_KEYWORDS: dict[str, tuple[str, ...]] = {
    "window": (),
    "low_hour": ("한산", "혼잡", "시간대", "여유"),
    "low_congestion": ("혼잡", "예상", "예측"),
    "timesale": (),
}


def _utcnow() -> datetime:
    # 테스트에서 고정 시각으로 패치할 수 있게 분리(predict.py 관례).
    return datetime.now(timezone.utc)


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def _cache_key(facility_id: str) -> str:
    # KST 시간 버킷 — 시간이 넘어가면 예측 창 자체가 이동하므로 키가 자연 만료된다.
    return f"{facility_id}:{_utcnow().astimezone(_KST).strftime('%Y-%m-%d-%H')}"


async def _active_timesale_count(facility_id: str) -> Optional[int]:
    """지금 활성(미취소·기간 내) 타임세일 건수 — 조회 실패 시 None(지어내지 않음).

    필터는 merchant.py _active_timesale_rates 와 동일(canceled_at null,
    starts_at <= now <= ends_at) — '지금 추천에 반영 중' 기준의 사실 수집이다.
    """
    now_iso = _utcnow().isoformat()
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("merchant_timesales")
            .select("id")
            .eq("facility_id", facility_id)
            .is_("canceled_at", "null")
            .lte("starts_at", now_iso)
            .gte("ends_at", now_iso)
            .execute
        )
    except Exception as e:
        # 부가 사실일 뿐 — 브리핑 자체를 실패시키지 않는다. 실패 시 {timesale} 토큰 미제공.
        logger.warning("merchant_briefing_timesale_lookup_failed", facility_id=facility_id, error=str(e))
        return None
    return len(res.data or [])


async def collect_facts(facility_id: str, facility_type: str) -> Optional[dict]:
    """예측 창(앞으로 6시간) 사실 수집 → {"facts", "placeholders"}. 데이터 부족이면 None(스킵).

    스킵 조건: 모델 미학습 — 전 시각 0.5 평탄 곡선의 argmin 은 '최저 혼잡 시간대'가 아니다
    (golden-hour 의 available=False 폴백과 동일한 정직성 판단 → LLM 미호출).
    """
    if not get_model_info()["trained"]:
        return None

    now = _utcnow()
    # 앵커링(golden-hour/batch 와 동일 공식): offset = 현재 실측 − 지금 시점 타입 수준 예측.
    congestion_map = await fetch_latest_congestion_for_all([facility_id])
    current_log = congestion_map.get(facility_id)
    base_now = await asyncio.to_thread(predict_congestion, facility_type, now.hour, now.weekday())
    offset = (float(current_log["level"]) - base_now) if current_log is not None else 0.0

    curve: list[dict] = []
    for hours_ahead in range(_WINDOW_HOURS + 1):
        target = now + timedelta(hours=hours_ahead)
        base = await asyncio.to_thread(predict_congestion, facility_type, target.hour, target.weekday())
        curve.append({
            "hours_ahead": hours_ahead,
            "kst_hour": target.astimezone(_KST).hour,
            "congestion": round(_clamp01(base + offset), 4),
        })

    # 최저 혼잡 60분 창 — argmin 은 서버가 계산한다(동률이면 이른 시각, min 은 안정 정렬).
    best = min(curve, key=lambda p: p["congestion"])

    timesale_count = await _active_timesale_count(facility_id)

    placeholders = {
        "window": f"앞으로 {_WINDOW_HOURS}시간",
        "low_hour": f"{best['kst_hour']}시~{(best['kst_hour'] + 1) % 24}시",
        "low_congestion": f"{round(best['congestion'] * 100)}%",
    }
    if timesale_count is not None:
        placeholders["timesale"] = (
            "진행 중인 타임세일 없음"
            if timesale_count == 0
            else f"진행 중인 타임세일 {timesale_count}건"
        )

    facts = {
        "forecast_window": placeholders["window"],
        "lowest_congestion_hour_kst": placeholders["low_hour"],
        "lowest_congestion_percent": placeholders["low_congestion"],
        "anchored_to_recent_log": current_log is not None,
        "active_timesale_count": timesale_count,  # None 이면 알 수 없음(토큰 미제공)
        "available_placeholders": sorted(placeholders),
    }
    return {"facts": facts, "placeholders": placeholders}


def is_honest_merchant_briefing(template: str, allowed_placeholders: set[str]) -> bool:
    """머천트 게이트 — 공용 게이트(플레이스홀더 화이트리스트·숫자/수사/추세어/문장 수·토큰 문맥)
    + 머천트 금지어 + 필수 토큰({window}·{low_hour}) 강제. 하나라도 어긋나면 전량 폐기."""
    if not briefing_service.is_honest_briefing(
        template,
        allowed_placeholders,
        context_keywords=_TOKEN_CONTEXT_KEYWORDS,
        max_sentences=_MAX_SENTENCES,
    ):
        return False
    if _MERCHANT_FORBIDDEN_RE.search(template):
        return False
    used = set(briefing_service._PLACEHOLDER_RE.findall(template))
    if not _REQUIRED_TOKENS <= used:
        return False  # 창 스코프({window})·최저 혼잡 창({low_hour}) 미명시 — 계약 ① 위반
    return True


def _system_prompt(available: list[str]) -> str:
    return (
        "너는 경주 소상공인 사장님 콘솔의 '오늘의 실행 브리핑' 작성기다. "
        "입력 JSON(앞으로 6시간 혼잡 예측 창의 최저 혼잡 시간대 + 타임세일 현황)을 근거로 "
        "사장님용 한국어 브리핑 2~3문장을 작성해라. 규칙: "
        "① 숫자·시각·퍼센트를 직접 쓰지 마라 — 아라비아 숫자·한글 수사(여섯 시간, 두 건 등) 모두 금지다. "
        "수치는 반드시 다음 플레이스홀더 토큰으로만 지칭해라(치환은 서버가 한다): "
        "{window}=예측 범위, {low_hour}=가장 한산할 것으로 예측된 시간대, "
        "{low_congestion}=그 시간대의 예상 혼잡도"
        + (", {timesale}=타임세일 진행 현황" if "timesale" in available else "")
        + ". 사용 가능 토큰: " + ", ".join("{" + p + "}" for p in available) + ". "
        "② 브리핑 범위는 {window} 안이다 — 반드시 {window} 와 {low_hour} 를 포함하고, "
        "하루 전체나 내일을 말하지 마라. "
        "③ 토큰은 제 지표를 서술하는 자리에만 놓아라 — 예: "
        "'{window} 중 가장 한산한 시간대는 {low_hour}(예상 혼잡도 {low_congestion})로 예측됩니다.' "
        "④ 방문객 수·매출·손님 수·인원을 말하지 마라 — 입력에 없는 지표다(이 값은 혼잡도 예측이다). "
        "⑤ 할인율·발행 시점을 정하지 마라 — 행동 제안은 '한산한 시간대에 타임세일 발행을 "
        "고려해보세요' 수준까지만 하고, 실행 결정은 사장님 몫이다. "
        "⑥ 비교·추세·극값 표현(증가/감소/어제/전일/대비/상승/하락/최고 등)을 쓰지 마라. "
        "⑦ 설명·마크다운·따옴표 없이 브리핑 문장만 출력해라."
    )


def cached_briefing(facility_id: str) -> Optional[dict]:
    """시설+KST 시간 버킷 캐시 히트 시 응답 dict — 미스/만료는 None. 라우터가 먼저 확인한다."""
    key = _cache_key(facility_id)
    hit = _cache.get(key)
    if hit is None:
        return None
    cached_at, ttl, result = hit
    if time.monotonic() - cached_at >= ttl:
        _cache.pop(key, None)
        return None
    return result


def _cache_set(facility_id: str, result: dict) -> None:
    ttl = _CACHE_TTL_SECONDS if result.get("briefing") else _FAILURE_TTL_SECONDS
    _cache[_cache_key(facility_id)] = (time.monotonic(), ttl, result)


async def generate_briefing(facility_id: str, facility_type: str) -> dict:
    """예측 창 사실 → { briefing: str|None, llmStatus } (항상 dict, 예외 없음 — 무해 폴백).

    llmStatus: "llm"(채택) | "rejected"(게이트 폐기) | "llm_failed"(호출 실패) |
               "disabled"(키 미설정) | "skipped"(모델 미학습 — 호출 자체 스킵)
    """
    built = await collect_facts(facility_id, facility_type)
    if built is None:
        return {"briefing": None, "llmStatus": "skipped"}
    if not llm_client.is_enabled():
        return {"briefing": None, "llmStatus": "disabled"}

    facts, placeholders = built["facts"], built["placeholders"]
    text = await llm_client.chat_text(
        _system_prompt(sorted(placeholders)),
        json.dumps(facts, ensure_ascii=False),  # 데이터 경계(§-14) — 사실 JSON 원형 그대로
        max_tokens=_LLM_MAX_TOKENS,
    )
    if text is None:
        result = {"briefing": None, "llmStatus": "llm_failed"}
    else:
        template = text.strip()
        if is_honest_merchant_briefing(template, set(placeholders)):
            result = {
                "briefing": briefing_service.render_briefing(template, placeholders),
                "llmStatus": "llm",
            }
        else:
            # 본문은 로그 금지(길이만) — §-14 보안 관례.
            logger.warning("merchant_briefing_rejected", facility_id=facility_id, content_length=len(template))
            result = {"briefing": None, "llmStatus": "rejected"}
    _cache_set(facility_id, result)
    return result
