"""관제 대시보드 '오늘의 브리핑' — 서버 집계 사실의 한국어 1~2문장 프로즈화 (P0-2).

docs/SOLAR_LLM_EXPANSION.md P0-2 계약 + Codex 적대 감사(2026-07-18) 반영 설계:

  자유 문장에 숫자 부분집합 검사를 적용하는 1차 설계는 한글 수사("삼 건")·천 단위
  콤마 분해·부호 방향·날짜 숫자 재사용·필드 바꿔치기로 우회 가능함이 감사에서 실증됐다.
  → **플레이스홀더 치환 설계**로 교체: LLM 은 수치를 일절 쓰지 못하고(아라비아 숫자
  검출 시 전량 폐기) {avg} {change} {anomalies} {relocations} {saved} {threshold}
  토큰만 배치한다. 실제 수치는 게이트 통과 후 서버가 치환하므로 숫자의 창작·변형·
  필드 오귀속이 구조적으로 불가능하다.

  - 추세·비교 어휘는 전역 금지: 전일 기준선이 있는 지표는 avgCongestion.changePercent
    하나뿐이고, 그 방향 서술은 서버가 {change} 치환문("전일 대비 N% 감소" 류)으로만
    생성한다. LLM 출력에 비교 어휘가 하나라도 있으면 폐기 — 이상건수(전일 기준선
    없음)에 대한 창작 비교가 절 분리·동의어로 우회할 표면 자체를 없앤다.
  - hasLogs=False 또는 전 지표 0 이면 LLM 호출 자체를 스킵(briefing=None, 프런트 미렌더).
  - 무해 폴백: 키 미설정/타임아웃/파싱 실패/게이트 거부 → briefing=None. LLM 장애가
    대시보드 장애로 승격되지 않는다(llm_client 계약과 동일).
  - 토큰 문맥 게이트(2차 감사): "{anomalies}의 재배치" 같은 의미 오배치를 토큰 직전 문맥의
    지표 키워드 검증으로 폐기한다. 비정량 수량어("여러 건")·유니코드 숫자(①·Ⅹ)도 거부.
  - 캐시: KST 날짜 키(모듈 전역 dict + monotonic, reason_service 관례). 성공 12분,
    거부·실패 1분 — 실패 LLM 을 두들기지 않되 일시 장애가 장시간 비활성으로 확대되지 않게.
  - 응답 본문은 로그에 남기지 않는다(길이만) — §-14 보안 관례.
"""

import json
import re
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Optional

import structlog

from app.services import llm_client

logger = structlog.get_logger()

_CACHE_TTL_SECONDS = 720.0   # 성공 결과 12분 — 계약 범위(10~15분) 내
_FAILURE_TTL_SECONDS = 60.0  # 거부·호출 실패는 1분만 — 일시 장애가 12분 비활성으로 확대되지 않게(2차 감사 P2)
_LLM_MAX_TOKENS = 250        # 한국어 1~2문장이면 충분 — 과금·지연 최소화
_MAX_BRIEFING_CHARS = 400    # 치환 전 템플릿 기준 상한 — 장문 폭주 출력 거부

_KST_OFFSET = timedelta(hours=9)

# KST 날짜 → (monotonic 시각, TTL, 응답 dict). LLM 을 실제 시도한 결과만 저장한다
# (skipped/disabled 는 호출 비용이 없어 캐싱하지 않는다 — 상태 변화에 즉시 반응).
_cache: dict[str, tuple[float, float, dict]] = {}

_HANGUL_RE = re.compile(r"[가-힣]")
_SENTENCE_END_RE = re.compile(r"[.!?。]")
_PLACEHOLDER_RE = re.compile(r"\{([a-z_]+)\}")
# 한글 수사+단위 — 숫자 금지를 "삼 건"/"이천 명" 표기로 우회하는 경로 차단.
# 수사 문자가 단위 명사 직전에 붙은 조합만 잡아 '이상'·'오늘' 같은 일반어 오탐을 피한다.
_KOREAN_NUMERAL_RE = re.compile(r"[일이삼사오육칠팔구십백천만]+\s*(?:건|명|분|곳|회|배|퍼센트|프로)")
# 비정량 수량어 — 숫자 없이도 규모를 창작하는 표현("여러 재배치", "수 건")을 폐기(2차 감사 P1).
_VAGUE_QUANTITY_RE = re.compile(r"여러|다수|소수|한두|몇몇|몇\s|수\s*(?:건|명|분|곳|회|배)|상당수|대부분|절반|과반|일부")
# 비교·추세·극값 어휘 전역 금지 — 방향 서술은 서버 {change} 치환문에서만 나온다.
# 블랙리스트는 자연어 의미를 완전히 검증하지 못한다(2차 감사) — 회귀 방어선으로 두고,
# 구조 방어는 숫자 전면 금지 + 토큰 문맥 게이트가 담당한다. 오탐(보수적 폐기)은 무해.
_TREND_WORDS = (
    "증가", "감소", "급증", "급감", "늘었", "늘어", "줄었", "줄어",
    "어제", "전일", "전날", "대비", "보다", "추세", "상승", "하락", "완화", "악화",
    "많아", "적어", "높아", "낮아", "지난",
    "웃돌", "밑돌", "상회", "하회", "역대", "최고", "최저", "최대", "최소",
    "처음", "신기록", "정점", "바닥", "회복", "반등", "둔화", "가속", "경신", "돌파", "기록적",
)

# 토큰 문맥 게이트(2차 감사 P0 — 의미 오배치 방어): 각 토큰은 해당 지표를 서술하는 문맥에만
# 놓일 수 있다. 토큰 직전 25자(이웃 토큰 마스킹 후)에 지표 키워드가 없으면 폐기.
# 한국어 표현 변형상 완전한 방어는 아니다 — 잔존 리스크는 SOLAR_LLM_EXPANSION.md 에 기록.
_TOKEN_CONTEXT_KEYWORDS: dict[str, tuple[str, ...]] = {
    "avg": ("혼잡", "평균"),
    "change": ("혼잡", "평균", "수준"),
    "anomalies": ("이상", "감지", "경보"),
    "threshold": ("기준", "임계", "이상"),
    "relocations": ("재배치", "분산", "수락"),
    "saved": ("대기", "절감", "시간"),
}
_CONTEXT_WINDOW_CHARS = 25


def _contains_numeric_char(text: str) -> bool:
    """NFKC 정규화 후 유니코드 숫자 카테고리(Nd/Nl/No) 전부 검출 — 아라비아·전각·원문자(①)·
    로마 숫자(Ⅹ)를 하나의 규칙으로 거부한다(2차 감사 P1)."""
    normalized = unicodedata.normalize("NFKC", text)
    return any(unicodedata.category(ch).startswith("N") for ch in normalized)


def _token_context_ok(template: str) -> bool:
    """모든 플레이스홀더가 제 지표의 문맥(직전 25자 내 키워드)에 있는지 검증."""
    for match in _PLACEHOLDER_RE.finditer(template):
        keywords = _TOKEN_CONTEXT_KEYWORDS.get(match.group(1))
        if keywords is None:
            return False  # 미지 토큰 — 화이트리스트 게이트와 이중 방어
        prefix = template[max(0, match.start() - _CONTEXT_WINDOW_CHARS):match.start()]
        prefix = _PLACEHOLDER_RE.sub("", prefix)  # 이웃 토큰 이름이 키워드 판정을 오염하지 않게
        if not any(keyword in prefix for keyword in keywords):
            return False
    return True


def _kst_today() -> str:
    return (datetime.now(timezone.utc) + _KST_OFFSET).strftime("%Y-%m-%d")


def build_facts(today: dict, impact: dict) -> Optional[dict]:
    """대시보드 집계 → {"facts": LLM 프롬프트용 사실, "placeholders": 서버 치환값}. 스킵이면 None.

    스킵 조건(계약 ④): hasLogs=False, 또는 전 지표 0(평균 혼잡·이상건수·재배치·절감분 전부 0).
    changePercent 가 None(전일 표본 없음)이면 {change} 플레이스홀더 자체를 제공하지 않는다 —
    "전일과 동일" 류 창작 비교를 서버 쪽에서도 만들지 않기 위해서다.
    """
    if not today.get("hasLogs"):
        return None
    avg = today.get("avgCongestion") or {}
    value = float(avg.get("value") or 0)
    change_raw = avg.get("changePercent")
    anomaly_count = int(today.get("anomalyCount") or 0)
    relocations = int(impact.get("relocations") or 0)
    saved_minutes = float(impact.get("saved_wait_minutes") or 0)

    if value == 0 and anomaly_count == 0 and relocations == 0 and saved_minutes == 0:
        return None

    placeholders = {
        "avg": f"{value * 100:.1f}%",           # 대시보드 KPI 타일과 동일 표기
        "anomalies": f"{anomaly_count}건",
        "threshold": "90%",                      # 이상 판정 기준(혼잡도 90% 이상) — 서버 고정 사실
        "relocations": f"{relocations}건",
        "saved": f"{saved_minutes:.0f}분",
    }
    if change_raw is not None:
        change = float(change_raw)
        if change > 0:
            placeholders["change"] = f"전일 대비 {change:g}% 상승"
        elif change < 0:
            placeholders["change"] = f"전일 대비 {abs(change):g}% 하락"
        else:
            placeholders["change"] = "전일과 동일한 수준"

    facts = {
        "date_kst": _kst_today(),
        "avg_congestion_percent": placeholders["avg"],
        "avg_change_vs_yesterday": placeholders.get("change"),  # None 이면 언급 불가 지표
        "anomaly_count": anomaly_count,
        "anomaly_threshold_percent": 90,
        "accepted_relocations_today": relocations,
        "saved_wait_minutes_today": saved_minutes,
        "available_placeholders": sorted(placeholders),
    }
    return {"facts": facts, "placeholders": placeholders}


def is_honest_briefing(template: str, allowed_placeholders: set[str]) -> bool:
    """치환 전 템플릿의 정직성 게이트 — 하나라도 어긋나면 전량 폐기(부분 채택 없음).

    수치는 플레이스홀더로만 존재해야 하므로 숫자(아라비아·한글 수사) 검출 = 즉시 폐기.
    비교·추세 어휘도 전역 폐기 — 방향 서술은 서버 {change} 치환문만 담을 수 있다.
    """
    if not isinstance(template, str) or not template.strip():
        return False
    if len(template) > _MAX_BRIEFING_CHARS:
        return False
    if _contains_numeric_char(template):
        return False
    if _KOREAN_NUMERAL_RE.search(template):
        return False
    if _VAGUE_QUANTITY_RE.search(template):
        return False
    if any(word in template for word in _TREND_WORDS):
        return False
    if not _HANGUL_RE.search(template):
        return False
    used = _PLACEHOLDER_RE.findall(template)
    if not used or not set(used) <= allowed_placeholders:
        return False
    # 미지의 중괄호 토큰({Visitors}, {n+1} 등)은 _PLACEHOLDER_RE 에 안 잡힌다 — 잔존 검출로 폐기.
    if _PLACEHOLDER_RE.sub("", template).count("{") or _PLACEHOLDER_RE.sub("", template).count("}"):
        return False
    if not _token_context_ok(template):
        return False
    sentence_count = len(_SENTENCE_END_RE.findall(template.strip()))
    if not 1 <= sentence_count <= 2:
        return False
    return True


def render_briefing(template: str, placeholders: dict[str, str]) -> str:
    """게이트 통과 템플릿에 서버 수치를 치환 — 최종 표시 문자열."""
    return _PLACEHOLDER_RE.sub(lambda m: placeholders[m.group(1)], template)


def _system_prompt(available: list[str]) -> str:
    return (
        "너는 경주 관광 관제 대시보드의 일일 브리핑 작성기다. "
        "입력 JSON 의 상황을 요약한 관제 담당자용 한국어 브리핑 1~2문장을 작성해라. 규칙: "
        "① 숫자를 직접 쓰지 마라 — 아라비아 숫자·한글 수사(삼 건 등) 모두 금지다. "
        "수치는 반드시 다음 플레이스홀더 토큰으로만 지칭해라(치환은 서버가 한다): "
        "{avg}=오늘 평균 혼잡도, {anomalies}=이상 혼잡 감지 건수, {threshold}=이상 판정 기준, "
        "{relocations}=분산 수락 건수, {saved}=절감된 대기시간"
        + (", {change}=전일 대비 변화(방향 포함 문구)" if "change" in available else "")
        + ". 사용 가능 토큰: " + ", ".join("{" + p + "}" for p in available) + ". "
        "② 각 토큰은 반드시 해당 지표를 서술하는 자리에만 놓아라 — 예: '이상 감지는 {anomalies}', "
        "'재배치 {relocations}', '대기시간 {saved} 절감'. 토큰을 다른 지표 자리에 두면 폐기된다. "
        "③ 비교·추세·극값 표현(증가/감소/어제/전일/대비/상승/하락/최고/처음 등)을 직접 쓰지 마라 — "
        "전일 대비 서술이 필요하면 {change} 토큰이 문구를 대신한다. "
        "④ 설명·마크다운·따옴표 없이 브리핑 문장만 출력해라."
    )


def cached_briefing() -> Optional[dict]:
    """오늘(KST) 캐시 히트 시 응답 dict — 미스/만료는 None. 라우터가 집계 전에 먼저 확인한다."""
    hit = _cache.get(_kst_today())
    if hit is None:
        return None
    cached_at, ttl, result = hit
    if time.monotonic() - cached_at >= ttl:
        _cache.pop(_kst_today(), None)
        return None
    return result


def _cache_set(result: dict) -> None:
    # 성공(채택)은 12분, 거부·실패는 1분 — 일시적 모델 오류가 관리자 세션 전체의
    # 장시간 기능 비활성으로 확대되지 않게 한다(2차 감사 P2).
    ttl = _CACHE_TTL_SECONDS if result.get("briefing") else _FAILURE_TTL_SECONDS
    _cache[_kst_today()] = (time.monotonic(), ttl, result)


async def generate_briefing(today: dict, impact: dict) -> dict:
    """대시보드 집계 2종 → { briefing: str|None, llmStatus } (항상 dict, 예외 없음).

    llmStatus: "llm"(채택) | "rejected"(게이트 폐기) | "llm_failed"(호출 실패) |
               "disabled"(키 미설정) | "skipped"(hasLogs=False/전 지표 0 — 호출 자체 스킵)
    """
    built = build_facts(today, impact)
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
        if is_honest_briefing(template, set(placeholders)):
            result = {"briefing": render_briefing(template, placeholders), "llmStatus": "llm"}
        else:
            # 본문은 로그 금지(길이만) — 모델이 만든 문장이 로그로 재노출되지 않게 한다.
            logger.warning("briefing_rejected", content_length=len(template))
            result = {"briefing": None, "llmStatus": "rejected"}
    _cache_set(result)
    return result
