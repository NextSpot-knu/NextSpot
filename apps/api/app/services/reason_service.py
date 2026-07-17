"""추천 사유(한국어 1~2문장) 생성 — 로컬 결정적 템플릿 + 선택적 LLM 문체 다듬기.

(대회 종료 후 Vertex AI Gemini 의존성을 제거하고, 기존 결정적 템플릿 폴백을 단일 경로로 승격.
 2026-07-17 국산 Upstage Solar 어댑터(llm_client) 재도입에 맞춰 문체 다듬기 후처리를 추가.)
입력으로 주어진 수치(혼잡도·도보·예상 대기)만 사용해 환각 없는 사유 문장을 만든다.
공개 시그니처 `generate_reason(context) -> str` 는 불변(라우터가 await 로 호출).

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

logger = structlog.get_logger()

_LLM_TIMEOUT_SECONDS = 1.5   # 추천 응답 지연 상한 — 초과 시 None(무해 폴백)
_LLM_MAX_TOKENS = 200        # 한두 문장이면 충분 — 과금·지연 최소화

_CACHE_TTL_SECONDS = 600.0   # 10분 — 같은 카드 반복 노출 시 재호출 금지

# (시설 식별자, 템플릿 원문) → (monotonic 시각, 최종 사유 문자열).
# 성공(다듬어진 문장)·폴백(템플릿) 결과를 모두 캐싱해, 같은 카드가 다시 노출돼도
# LLM 을 재호출하지 않는다.
_cache: dict[tuple, tuple[float, str]] = {}

_NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")


def _facility_name(ctx: dict) -> str:
    return ctx.get("recommended_facility_name") or "대안 시설"


def _build_template(ctx: dict) -> str:
    """주어진 수치만으로 만드는 결정적 사유 문장."""
    name = _facility_name(ctx)
    wait = ctx.get("predicted_wait")
    travel = ctx.get("travel_time")
    cand_cong = ctx.get("candidate_congestion")

    parts = []
    if isinstance(travel, (int, float)):
        parts.append(f"도보 {round(travel)}분")
    if isinstance(wait, (int, float)):
        parts.append(f"예상 대기 {round(wait)}분")
    if isinstance(cand_cong, (int, float)):
        parts.append(f"혼잡도 {round(cand_cong * 100)}%")

    # 혼잡(>=0.75)이면 추천하지 않고 혼잡·대기를 솔직히 안내한다.
    is_congested = isinstance(cand_cong, (int, float)) and cand_cong >= 0.75
    if parts:
        if is_congested:
            return f"{name}: " + ", ".join(parts) + " 수준으로 지금은 붐벼 대기가 길 수 있어요."
        return f"{name} 추천: " + ", ".join(parts) + " 수준으로 여유가 있습니다."
    if is_congested:
        return f"{name}은(는) 현재 혼잡해 대기가 길 수 있어요."
    return f"{name}을(를) 추천합니다."


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


def _cache_get(key: Optional[tuple]) -> Optional[str]:
    if key is None:
        return None
    hit = _cache.get(key)
    if hit is None:
        return None
    cached_at, value = hit
    if time.monotonic() - cached_at >= _CACHE_TTL_SECONDS:
        _cache.pop(key, None)
        return None
    return value


def _cache_set(key: Optional[tuple], value: str) -> None:
    if key is None:
        return
    _cache[key] = (time.monotonic(), value)


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


async def generate_reason(context: dict) -> str:
    """추천 1건의 점수 구성요소를 받아 한국어 사유를 반환. 항상 문자열(폴백 보장)."""
    template = _build_template(context)
    if not llm_client.is_enabled():
        return template  # 키 미설정 — 기존 동작과 100% 동일(회귀 0)

    key = _cache_key(context, template)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    polished = await _llm_polish(template, context)
    result = polished if polished is not None else template
    _cache_set(key, result)
    return result
