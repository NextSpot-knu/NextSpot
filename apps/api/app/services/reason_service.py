"""추천 사유(한국어 1~2문장) 생성 — 로컬 결정적 템플릿 + 선택적 LLM 문체 다듬기.

(대회 종료 후 Vertex AI Gemini 의존성을 제거하고, 기존 결정적 템플릿 폴백을 단일 경로로 승격.
 2026-07-17 국산 Upstage Solar 어댑터(llm_client) 재도입에 맞춰 문체 다듬기 후처리를 추가.)
입력으로 주어진 수치(혼잡도·도보·예상 대기)만 사용해 환각 없는 사유 문장을 만든다.
공개 시그니처 `generate_reason(context) -> str` 는 불변(라우터가 await 로 호출).
개발 디버그용으로 출처("llm"|"template")까지 필요하면 `generate_reason_with_source(context) ->
tuple[str, str]` 를 쓴다 — generate_reason 은 내부적으로 이를 호출해 텍스트만 반환한다.

LLM 다듬기 설계 원칙(무해 폴백 — llm_client.py 계약과 동일):
  - 사실(숫자·시설명)은 항상 템플릿이 정한다. LLM 은 문체(어투·연결)만 다듬을 뿐, 새
    사실을 만들 권한이 없다.
  - 정직성 검증(_is_honest_polish, 핵심): LLM 출력에 등장하는 모든 숫자가 템플릿 사유의
    숫자 집합의 부분집합이고, 시설명이 원문 그대로 보존돼야 채택된다. 하나라도 어긋나면
    템플릿 원문을 그대로 반환한다(이 저장소 원칙 — 지어내지 않기. LLM 환각이 수치를
    만들면 심사 감점 직결).
  - is_enabled()=False(키 미설정) 또는 chat_text 실패(타임아웃/오류)는 전부 템플릿 그대로
    → 기존 동작·출력과 100% 동일(회귀 0). 타임아웃은 추천 응답 지연 상한에 맞춰
    개별 호출마다 1.5초로 지정한다(llm_client 기본 3초보다 짧게).
  - 캐시: (시설 식별자, 템플릿 원문) 키로 10분 TTL — 사실 수치가 같은 카드가 반복
    노출될 때만 재사용하고, 위치가 달라 수치가 다르면 키가 갈린다(Codex 리뷰 P1 반영).
    event_boost._playtime_cache 와 동일 관례(단일 프로세스 데모 서버 전제의 모듈 전역
    dict 캐시, monotonic 시각 기준 TTL).
"""

import re
import time
from typing import Optional

import structlog

from app.services import llm_client
from app.services.card_minutes import wait_minutes, walk_minutes

logger = structlog.get_logger()

_LLM_TIMEOUT_SECONDS = 1.5   # 추천 응답 지연 상한 — 초과 시 None(무해 폴백)
_LLM_MAX_TOKENS = 200        # 한두 문장이면 충분 — 과금·지연 최소화

_CACHE_TTL_SECONDS = 600.0   # 10분 — 같은 카드 반복 노출 시 재호출 금지

# (시설 식별자, 템플릿 원문) → (monotonic 시각, 최종 사유 문자열, 출처("llm"|"template")).
# 성공(다듬어진 문장)·폴백(템플릿) 결과를 모두 캐싱해, 같은 카드가 다시 노출돼도
# LLM 을 재호출하지 않는다. 출처도 함께 저장해야 캐시 히트 시에도 "이번에 LLM 이 실제로
# 돌았는지"를 정확히 보고할 수 있다(캐시된 llm 문장을 template 로 오보하면 안 됨).
_cache: dict[tuple, tuple[float, str, str]] = {}

_NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")


def _facility_name(ctx: dict) -> str:
    return ctx.get("recommended_facility_name") or "대안 시설"


# 업종 시간대 곡선 문장의 주어(조사까지). 업종을 모르면 주어 없이 쓴다.
_INDUSTRY_SUBJECT = {
    "restaurant": "음식점이",
    "cafe": "카페가",
    "attraction": "관광지가",
    "culture": "문화시설이",
}
# 곡선이 이 이상이면 '보통 붐비는 시간대' 라고 말한다 — 아래 '붐빔' 판정(0.75)과 같은 선.
_BUSY_LEVEL = 0.75


def _industry_pattern_sentence(ctx: dict, level) -> str | None:
    """업종 시간대 곡선이 붐비는 시간대를 가리킬 때만 한 문장. 숫자도 'AI' 도 쓰지 않는다."""
    if not isinstance(level, (int, float)) or level < _BUSY_LEVEL:
        return None
    subject = _INDUSTRY_SUBJECT.get(ctx.get("facility_type") or "")
    return f"이 시간대는 {subject} 보통 붐비는 때예요." if subject else "보통 붐비는 시간대예요."


# ── 구역 혼잡 근거(서울 S3) — 시설이 속한 권역의 관측 단계로 말한다 ─────────────────────
# 구역 근거 후보만 이 문장을 쓴다(ctx 의 congestion_evidence_tier == 'zone_measured'). 다른 템플릿은 그대로다.
_ZONE_EVIDENCE_TIER = "zone_measured"
# 단계 이름은 앱 공통 혼잡 등급(한산·여유·보통·혼잡 — 웹 ko congestion.*)이다. 공급원 4단계 문구(여유·보통·약간 붐빔·붐빔)를
# 그대로 쓰면 같은 관측을 카드 칩(단계 중앙값 → 등급)은 '여유', 이 문장은 '보통' 으로 말한다(DESIGN_PRINCIPLES 7).
_ZONE_BAND_LABEL = {
    "relaxed": "한산",
    "normal": "여유",
    "slightly_busy": "보통",
    "busy": "혼잡",
}
# 이 단계면 '붐벼 대기가 길 수 있다' 고 말한다 — 측정 문장과 같이 '혼잡' 등급(busy)만이다(순위 강등도 'busy' 만이다).
_ZONE_BUSY_BANDS = frozenset({"busy"})
# '평소 이 시간' 과의 비교 — 화면 문구 전용(점수·순위에는 쓰지 않는다).
_ZONE_USUAL_SENTENCE = {
    "busier": "평소 이 시간보다 붐비는 편이에요.",
    "usual": "평소 이 시간과 비슷한 수준이에요.",
    "quieter": "평소 이 시간보다 한산한 편이에요.",
}


def _build_zone_template(ctx: dict) -> str | None:
    """구역 근거 사유. 단계를 모르면 None(호출부가 혼잡 없는 종전 문장으로 내려간다)."""
    band = ctx.get("zone_band")
    label = _ZONE_BAND_LABEL.get(band or "")
    zone_name = ctx.get("zone_name")
    if label is None or not zone_name:
        return None
    name = _facility_name(ctx)
    parts = []
    travel = ctx.get("travel_time")
    if isinstance(travel, (int, float)):
        parts.append(f"도보 {walk_minutes(travel)}분")
    parts.append(f"{zone_name} 권역 {label}")
    if band in _ZONE_BUSY_BANDS and ctx.get("zone_band_basis") == "now":
        # 도착 단계가 없고 '지금' 관측 단계만 있다 — 도착 시각의 혼잡은 주장하지 않는다(엔진이 내지 않은 값).
        sentence = f"{name}: " + ", ".join(parts) + " 수준이라 지금 붐비는 편이에요."
    elif band in _ZONE_BUSY_BANDS:
        sentence = f"{name}: " + ", ".join(parts) + " 수준으로 도착할 즈음 붐벼 대기가 길 수 있어요."
    else:
        sentence = f"{name} 추천: " + ", ".join(parts) + " 수준입니다."
    usual = _ZONE_USUAL_SENTENCE.get(ctx.get("zone_usual_comparison") or "")
    return f"{sentence} {usual}" if usual else sentence


def _build_template(ctx: dict) -> str:
    """주어진 수치만으로 만드는 결정적 사유 문장.

    혼잡 3단계(CONGESTION_TRUST_SPEC): congestion_source 가
      - "measured"(또는 미지정 하위호환): 실측 → "혼잡도 N%"
      - "predicted" + 학습된 모델(congestion_prediction_basis 가 "model" 이거나 없음):
        "예상 혼잡도 N% (AI 예측)" — 예측임을 문구에 명시
      - "predicted" + 업종 시간대 곡선(congestion_prediction_basis="industry_baseline"): 이 가게를 잰 값도,
        학습한 모델의 예측도 아니다 — '%' 와 'AI' 를 쓰지 않고, 붐비는 시간대일 때만 "이 시간대는 카페가 보통
        붐비는 때예요." 를 덧붙인다(그 외에는 혼잡을 말하지 않는다). '지금은 붐벼' 처럼 이 가게를 말하지 않는다.
      - "none": 혼잡 근거 없음 → 혼잡 문구 생략(0% 를 실측처럼 팔지 않는다)
      - 구역 근거(congestion_evidence_tier="zone_measured", 서울 S3): '{권역} 권역 {단계}' 로 말하고 '%' 를 쓰지
        않는다(공급원 4단계를 퍼센트로 바꾸면 없는 정밀도를 주장한다). '평소 이 시간' 비교 문장을 덧붙일 수 있다.
    """
    if ctx.get("congestion_evidence_tier") == _ZONE_EVIDENCE_TIER:
        zone_sentence = _build_zone_template(ctx)
        if zone_sentence is not None:
            return zone_sentence
    name = _facility_name(ctx)
    wait = ctx.get("predicted_wait")
    travel = ctx.get("travel_time")
    cand_cong = ctx.get("candidate_congestion")
    cong_source = ctx.get("congestion_source") or "measured"
    if cong_source == "none":
        cand_cong = None
    if cong_source == "predicted" and ctx.get("congestion_prediction_basis") == "industry_baseline":
        pattern = _industry_pattern_sentence(ctx, cand_cong)
        # 곡선 값은 아래 '혼잡도 N%' 자리에도, '지금은 붐벼' 판정에도 쓰지 않는다.
        cand_cong = None
    else:
        pattern = None

    parts = []
    # 분은 카드(웹)와 같은 규칙으로 정수화한다(card_minutes) — 다르면 같은 카드에 두 숫자가 뜬다.
    # 이 문장이 글자로 찍히는 곳은 /explore/recommend 카드(ko)이고, 그 카드의 대기 칸은
    # max(1, Math.round(대기)) 라서 대기에도 최소 1분을 건다.
    if isinstance(travel, (int, float)):
        parts.append(f"도보 {walk_minutes(travel)}분")
    if isinstance(wait, (int, float)):
        parts.append(f"예상 대기 {max(1, wait_minutes(wait))}분")
    if isinstance(cand_cong, (int, float)):
        if cong_source == "predicted":
            parts.append(f"예상 혼잡도 {round(cand_cong * 100)}% (AI 예측)")
        else:
            parts.append(f"혼잡도 {round(cand_cong * 100)}%")

    # 혼잡(>=0.75)이면 추천하지 않고 혼잡·대기를 솔직히 안내한다.
    is_congested = isinstance(cand_cong, (int, float)) and cand_cong >= _BUSY_LEVEL
    if parts:
        if is_congested:
            return f"{name}: " + ", ".join(parts) + " 수준으로 지금은 붐벼 대기가 길 수 있어요."
        if not isinstance(cand_cong, (int, float)):
            # 혼잡 근거 없음 — "여유"도 혼잡 주장이므로 쓰지 않는다(거리·대기 사실만 안내).
            # '준비 중이에요' 같은 자기 결점 고백도 붙이지 않는다(no-defensive-copy, 2026-09-21).
            sentence = f"{name} 추천: " + ", ".join(parts) + " 수준입니다."
            return f"{sentence} {pattern}" if pattern else sentence
        return f"{name} 추천: " + ", ".join(parts) + " 수준으로 여유가 있습니다."
    if is_congested:
        return f"{name}은(는) 현재 혼잡해 대기가 길 수 있어요."
    return f"{name}을(를) 추천합니다. {pattern}" if pattern else f"{name}을(를) 추천합니다."


# --- LLM 문체 다듬기(Upstage Solar) — 사실은 템플릿이 정하고 LLM 은 표현만 다듬는다 -------

def _numbers_in(text: str) -> set:
    return set(_NUMBER_RE.findall(text or ""))


def _is_honest_polish(original: str, polished: str, facility_name: str) -> bool:
    """LLM 출력이 사실을 벗어나지 않았는지 검증(정직성 검증 — 핵심).

    두 조건을 모두 통과해야 True:
      1) 출력에 등장하는 모든 숫자가 원문(템플릿) 숫자 집합의 부분집합(새 숫자 창작 금지).
      2) 시설명이 원문 그대로 보존(문자열 포함).
    하나라도 어긋나면 False — 호출자는 반드시 템플릿 원문으로 폴백한다.
    """
    if not isinstance(polished, str) or not polished.strip():
        return False
    if not _numbers_in(polished) <= _numbers_in(original):
        return False
    if facility_name and facility_name not in polished:
        return False
    return True


def _cache_key(ctx: dict, template: str) -> Optional[tuple]:
    """호출 컨텍스트에서 캐시 키를 만든다. 시설 식별자가 없으면 캐싱하지 않는다
    (오염된 키로 다른 카드의 문장을 재사용하는 것보다 재호출이 안전하다).

    키에 템플릿 원문을 포함한다(Codex 리뷰 P1, 2026-07-17): 혼잡 구간·시각만으로는 같은 시설을
    다른 위치에서 본 사용자의 도보/대기 수치가 구분되지 않아, 첫 사용자의 '도보 3분' 사유가
    다른 사용자의 '도보 18분' 카드에 재사용됐다. 템플릿이 모든 사실 수치를 인코딩하므로
    (facility_id, template) 이 가장 안전한 키다 — 사실이 같을 때만 문장을 재사용한다.
    """
    facility_id = ctx.get("facility_id") or ctx.get("recommended_facility_name")
    if not facility_id:
        return None
    return (facility_id, template)


def _cache_get(key: Optional[tuple]) -> Optional[tuple[str, str]]:
    """(사유 문자열, 출처) 히트 — 만료·미스는 None."""
    if key is None:
        return None
    hit = _cache.get(key)
    if hit is None:
        return None
    cached_at, value, source = hit
    if time.monotonic() - cached_at >= _CACHE_TTL_SECONDS:
        _cache.pop(key, None)
        return None
    return value, source


def _cache_set(key: Optional[tuple], value: str, source: str) -> None:
    if key is None:
        return
    _cache[key] = (time.monotonic(), value, source)


def _polish_system_prompt() -> str:
    return (
        "너는 관광 추천 카드의 사유 문장을 다듬는 한국어 문장 교정기다. "
        "입력으로 받은 '원문 사유'를 자연스러운 한국어 한두 문장으로만 다듬어라. "
        "숫자·시설명·사실 관계는 절대 추가·변경·삭제하지 마라(원문에 없는 숫자를 새로 "
        "만들면 안 된다). 설명이나 마크다운 없이, 다듬은 문장만 출력해라."
    )


def _polish_user_prompt(template: str, facility_name: str) -> str:
    return f"시설명: {facility_name}\n원문 사유: {template}"


async def _llm_polish(template: str, ctx: dict) -> Optional[str]:
    """실패(타임아웃/오류/정직성 검증 실패)는 전부 None — 호출자는 템플릿을 그대로 쓴다."""
    name = _facility_name(ctx)
    text = await llm_client.chat_text(
        _polish_system_prompt(),
        _polish_user_prompt(template, name),
        max_tokens=_LLM_MAX_TOKENS,
        timeout=_LLM_TIMEOUT_SECONDS,
    )
    if text is None:
        return None
    polished = text.strip()
    if not _is_honest_polish(template, polished, name):
        logger.warning("reason_polish_rejected", facility=name)
        return None
    return polished


async def generate_reason_with_source(context: dict, *, polish: bool = True) -> tuple[str, str]:
    """추천 1건의 사유와 출처("llm"|"template")를 함께 반환(개발 디버그용 — 프런트 배지).

    "llm" = LLM 문체 다듬기가 정직성 검증을 통과해 채택됨. "template" = 키 미설정·호출 실패·
    정직성 검증 거부(그 밖의 모든 폴백) — 어느 경로든 텍스트 자체는 generate_reason 과 동일하다.
    """
    template = _build_template(context)
    # 추천 응답의 핵심 경로에서는 사실이 같은 결정적 템플릿을 즉시 반환한다. LLM 문체 다듬기는
    # 상세/비동기 경로에서만 opt-in 하며, 첫 카드 노출을 최대 1.5초 지연시키지 않는다.
    if not polish:
        return template, "template"
    if not llm_client.is_enabled():
        return template, "template"  # 키 미설정 — 기존 동작과 100% 동일(회귀 0)

    key = _cache_key(context, template)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    polished = await _llm_polish(template, context)
    if polished is not None:
        result, source = polished, "llm"
    else:
        result, source = template, "template"
    _cache_set(key, result, source)
    return result, source


async def generate_reason(context: dict) -> str:
    """추천 1건의 점수 구성요소를 받아 한국어 사유를 반환. 항상 문자열(폴백 보장)."""
    text, _source = await generate_reason_with_source(context)
    return text
