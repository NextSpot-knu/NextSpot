"""축제 소개(overview) 다국어 요약 — en/ja/zh 1~2문장, fire-and-forget 배치+캐시 (P1-4).

docs/SOLAR_LLM_EXPANSION.md "P1-4. 축제 소개 다국어 요약" 계약 구현:

  - 요청 경로 비블로킹(조건 ①): events 응답은 LLM 을 절대 기다리지 않는다. 첫 요청은
    한국어 원문만 반환하고, 백그라운드 태스크가 3로케일 요약을 생성해 content_id 키
    모듈 캐시(장기 TTL — 축제 소개문은 사실상 불변)에 적재한다 → 이후 요청부터
    overview_i18n 동봉. JUDGE_QA 의 "사전 배치+캐시" 서사와 정합(요약은 캐시된 결과).
  - 3로케일 일괄(조건 ②): locale 파라미터 없음 — {en,ja,zh} 딕셔너리를 통째로 반환해
    프런트(FestivalBanner)의 로케일 무포함 sessionStorage 캐시 키를 그대로 유지한다.
    ko 는 원문 그대로(요약·번역 대상 아님 — 조건 ⑤).
  - 정직성 게이트(조건 ④): scripts/translate_overviews.py 의 한글 잔존 게이트 패턴
    재사용(en/ja/zh 출력에 한글 0자) + briefing_service._contains_numeric_char 재사용
    (유니코드 N* 카테고리 숫자 검출 시 폐기 — 날짜·장소·시간·요금은 서버 필드가
    표시하므로 요약에 숫자가 필요 없다). 실패 로케일은 저장하지 않는다
    (부분 채택 허용 — en 만 성공하면 en 만 동봉).
  - 무해 폴백: llm_client 미설정이면 태스크 자체 미발행(네트워크 0). 실패·거부 로케일은
    캐시에 없고 프런트가 한국어 원문으로 폴백한다(기존 동작 불변). 이벤트 루프 밖
    (테스트·동기 컨텍스트)에서는 조용한 no-op — 예외로 승격되지 않는다.
  - 보안(§-14): 프롬프트는 json.dumps 데이터 경계 + 원문 제어/bidi(Cc/Cf) 새니타이즈,
    응답 본문 로그 금지(길이만).

표시 우선순위는 docs/TOURAPI_EXPANSION.md 4-4(공식 해당 언어 > 공식 한국어 원문 >
명시된 AI 번역)를 따른다 — 공식 다국어 자매 서비스(2-1) 적재가 후속 정본이며,
그 전까지 이 요약은 'AI 요약·번역' 라벨이 명시된 최하위 계층이다.
"""

import asyncio
import json
import re
import time
import unicodedata
from typing import Optional

import structlog

from app.services import llm_client
from app.services.briefing_service import _contains_numeric_char

logger = structlog.get_logger()

# 요약 대상 로케일 — ko(원문)는 제외(scripts/translate_overviews.py SUPPORTED_LOCALES 와 동일).
SUMMARY_LOCALES: tuple[str, ...] = ("en", "ja", "zh")
_LOCALE_LABELS: dict[str, str] = {"en": "영어", "ja": "일본어", "zh": "중국어(간체)"}
# 로케일별 고유명사 표기 규칙 — translate_overviews._NOTATION_RULES 실측 교훈 재사용
# (zh 는 창작 상호명의 한자 표기가 마땅찮으면 모델이 한글을 유지하며 실패 → 로마자 탈출구).
_NOTATION_RULES: dict[str, str] = {
    "en": "로마자 표기",
    "ja": "가타카나 또는 한자 표기",
    "zh": "중국어 한자 표기(마땅한 한자 표기가 없는 고유명사는 로마자 표기 허용)",
}

# 캐시 정책 — content_id 키 장기 TTL(계약 ①: 축제 소개문은 사실상 불변이라 재생성 불필요).
# 부분 실패(일부 로케일 미채택)는 짧은 백오프 후 빠진 로케일만 재시도한다(부분 채택 보존).
_SUMMARY_TTL_SECONDS = 30 * 24 * 3600.0
_RETRY_BACKOFF_SECONDS = 600.0
_LLM_MAX_TOKENS = 250          # 1~2문장이면 충분 — 과금·장문 폭주 최소화
_LLM_TIMEOUT_SECONDS = 15.0    # 백그라운드 태스크 — 요청 경로 지연과 무관해 넉넉히(translate_overviews 관례)
_MAX_SUMMARY_CHARS = 400       # 게이트: '1~2문장 요약' 계약을 넘는 장문 폭주 거부

# content_id → (monotonic 적재 시각, {locale: 요약}). 성공 로케일만 저장(부분 채택).
_cache: dict[str, tuple[float, dict[str, str]]] = {}
# content_id → 재시도 허용 시각(monotonic). 실패·부분 실패 백오프 — 실패 LLM 을 요청마다 두들기지 않기.
_retry_at: dict[str, float] = {}
# 생성 중인 content_id — 같은 축제의 태스크 중복 발행 방지.
_inflight: set[str] = set()
# fire-and-forget 태스크의 강한 참조(GC 로 태스크가 사라지는 asyncio 함정 방지).
_tasks: set[asyncio.Task] = set()
# content_id → 마지막 시도 결과("rejected"|"llm_failed") — 관찰 필드(llmStatus)용.
_last_status: dict[str, str] = {}

# 한글 잔존 검출 — scripts/translate_overviews.py 의 _HANGUL_CLASS 게이트 패턴 재사용
# (자모·호환 자모·완성형·확장 A/B·반각·톤 마크·괄호/원문자 한글까지 — Codex P1 이력 그대로).
# scripts/* 는 sys.path 부트스트랩이 있는 실행 파일이라 서비스 계층에서 임포트하지 않고
# 문자 클래스를 미러링한다(단일 정의점 승격은 후속 리팩터링 후보).
_HANGUL_RE = re.compile(r"[ᄀ-ᇿ㄰-㆏가-힣ꥠ-꥿ힰ-퟿ﾠ-ￜ〮〯㈀-㈞㉠-㉾]")

def _sanitize(text: str) -> str:
    """개행/탭 → 공백, 제어(Cc)·서식/bidi(Cf) 문자 제거, 연속 공백 축약 — §-14 새니타이즈.

    입력(TourAPI 원문 → 프롬프트)·출력(모델 요약 → 캐시) 양쪽에 적용해 프롬프트 인젝션
    표면과 bidi 위장(RLO 등) 문자를 제거한다. 유니코드 카테고리 기반이라 개별 코드포인트
    나열보다 누락이 없다(briefing_service 의 N* 카테고리 검출과 같은 원칙).
    """
    text = (text or "").replace("\r", " ").replace("\n", " ").replace("\t", " ")
    text = "".join(ch for ch in text if unicodedata.category(ch) not in ("Cc", "Cf"))
    return " ".join(text.split())


def is_honest_summary(text: str) -> bool:
    """요약 출력의 정직성 게이트(조건 ④) — 하나라도 어긋나면 해당 로케일 폐기(저장 안 함).

    - 한글 잔존 0자(translate_overviews 게이트): 미번역 문장을 심사 화면에 내보내지 않는다.
    - 유니코드 숫자(N* 카테고리) 검출 시 폐기(briefing_service._contains_numeric_char 재사용):
      날짜·장소·시간·요금은 서버 필드가 표시한다 — 요약 속 숫자는 창작·오귀속 위험만 있다.
    - 빈 문자열·장문 폭주(>_MAX_SUMMARY_CHARS) 거부.
    """
    if not isinstance(text, str) or not text.strip():
        return False
    if len(text) > _MAX_SUMMARY_CHARS:
        return False
    if _HANGUL_RE.search(text):
        return False
    # 원문 그대로 + NFKC 정규화 후 양쪽에서 검출한다: 정규화 전 검사는 로마 숫자 Ⅹ(Nl —
    # NFKC 가 라틴 문자 'X'(Lu)로 바꿔 정규화 후에는 안 잡힌다)를, 정규화 후 검사
    # (_contains_numeric_char)는 전각(３)·원문자(①) 등 호환 분해형을 잡는다.
    if any(unicodedata.category(ch).startswith("N") for ch in text):
        return False
    if _contains_numeric_char(text):
        return False
    return True


def _build_prompt(locale: str, title: str, overview: str) -> tuple[str, str]:
    """로케일별 system/user 프롬프트 — user 는 json.dumps 데이터 경계(§-14)."""
    label = _LOCALE_LABELS.get(locale, locale)
    notation = _NOTATION_RULES.get(locale, f"{label} 표기")
    system = (
        f"너는 한국 관광 축제 소개문을 {label} 1~2문장으로 요약·번역하는 작성기다. 규칙: "
        "① 입력 JSON 의 소개문에 있는 내용만 써라 — 원문에 없는 사실을 추가하지 마라. "
        "② 어떤 숫자도 출력하지 마라(아라비아·한자 수사·전각·서수 포함). 날짜·시간·요금·기간은 "
        "별도 필드가 표시하므로 요약에서 전부 생략해라 — 숫자가 하나라도 있으면 폐기된다. "
        f"③ 출력에 한글을 한 글자도 남기지 마라 — 고유명사(축제명·지명)도 반드시 {notation}로 옮겨라. "
        "④ 요약문만 출력해라 — 설명·따옴표·머리말·마크다운 없이 줄바꿈 없는 한 문단으로."
    )
    user = json.dumps(
        {"title": _sanitize(title), "overview": _sanitize(overview)},
        ensure_ascii=False,
    )
    return system, user


def get_summaries(content_id: str) -> dict[str, str]:
    """캐시된 로케일별 요약(부분 채택 가능 — 빈 dict 면 아직 없음). 요청 경로에서 즉시 반환."""
    hit = _cache.get(content_id)
    if hit is None:
        return {}
    cached_at, summaries = hit
    if time.monotonic() - cached_at >= _SUMMARY_TTL_SECONDS:
        _cache.pop(content_id, None)
        return {}
    return dict(summaries)


def status_for(content_id: str, has_summaries: bool) -> str:
    """관찰 필드(llmStatus) — "llm"(캐시 동봉) | "pending"(생성 전/중) |
    "rejected"(전 로케일 게이트 폐기) | "llm_failed"(전 로케일 호출 실패) | "disabled"(키 미설정)."""
    if not llm_client.is_enabled():
        return "disabled"
    if has_summaries:
        return "llm"
    return _last_status.get(content_id, "pending")


def ensure_summaries(content_id: str, title: str, overview: str) -> Optional[asyncio.Task]:
    """빠진 로케일 요약 생성을 fire-and-forget 로 예약한다 — 호출자는 절대 기다리지 않는다.

    no-op 조건(전부 무해): llm_client 미설정(태스크 자체 미발행 — 네트워크 0) /
    3로케일 캐시 완비 / 동일 content_id 생성 중 / 실패 백오프 중 / 이벤트 루프 밖.
    반환된 Task 는 테스트 결정성용 — 프로덕션 호출부(events 라우터)는 무시한다.
    """
    if not llm_client.is_enabled():
        return None
    if not content_id or not (overview or "").strip():
        return None
    missing = [loc for loc in SUMMARY_LOCALES if loc not in get_summaries(content_id)]
    if not missing:
        return None
    if content_id in _inflight:
        return None
    if time.monotonic() < _retry_at.get(content_id, 0.0):
        return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # 이벤트 루프 밖(동기 컨텍스트·일부 테스트) — 요약은 부가 기능이라 조용히 건너뛴다.
        return None
    _inflight.add(content_id)
    task = loop.create_task(_generate_and_store(content_id, title, overview, missing))
    _tasks.add(task)
    task.add_done_callback(_on_task_done)
    return task


def _on_task_done(task: asyncio.Task) -> None:
    """태스크 참조 해제 + 예외 회수(미회수 경고 방지). 실패는 이미 상태로 기록돼 있다."""
    _tasks.discard(task)
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        # 방어선 — _generate_and_store 는 자체적으로 예외를 삼키지만, 만약을 위해 회수만 한다.
        logger.warning("festival_summary_task_error", error=str(exc)[:200])


async def _generate_and_store(
    content_id: str, title: str, overview: str, locales: list[str]
) -> None:
    """로케일별 생성 → 게이트 → 통과분만 캐시 병합(부분 채택). 예외는 밖으로 새지 않는다."""
    adopted: dict[str, str] = {}
    rejected = 0
    try:
        for locale in locales:
            system, user = _build_prompt(locale, title, overview)
            text = await llm_client.chat_text(
                system, user, max_tokens=_LLM_MAX_TOKENS, timeout=_LLM_TIMEOUT_SECONDS
            )
            if text is None:
                continue  # 호출 실패(무해 폴백) — 이 로케일만 빠진다
            candidate = _sanitize(text)
            if is_honest_summary(candidate):
                adopted[locale] = candidate
            else:
                rejected += 1
                # 응답 본문은 로그 금지(길이만) — §-14 보안 관례(briefing_service 와 동일).
                logger.warning(
                    "festival_summary_rejected",
                    content_id=content_id,
                    locale=locale,
                    content_length=len(candidate),
                )
    except Exception as e:  # noqa: BLE001 — 백그라운드 태스크의 어떤 실패도 기능 장애로 승격 금지
        logger.warning("festival_summary_generate_failed", content_id=content_id, error=str(e)[:200])
    finally:
        merged = {**get_summaries(content_id), **adopted}
        if merged:
            _cache[content_id] = (time.monotonic(), merged)
        if len(merged) == len(SUMMARY_LOCALES):
            _retry_at.pop(content_id, None)
            _last_status.pop(content_id, None)
        else:
            # 부분/전체 실패 — 백오프 후 빠진 로케일만 재시도(채택분은 보존).
            _retry_at[content_id] = time.monotonic() + _RETRY_BACKOFF_SECONDS
            _last_status[content_id] = "rejected" if rejected and not adopted else "llm_failed"
        _inflight.discard(content_id)


def reset() -> None:
    """테스트 전용 — 모듈 상태 전체 초기화(진행 중 태스크는 취소 시도)."""
    for task in list(_tasks):
        try:
            task.cancel()
        except Exception:  # noqa: BLE001 — 다른 루프의 태스크 취소 실패는 무시(테스트 편의 함수)
            pass
    _tasks.clear()
    _inflight.clear()
    _cache.clear()
    _retry_at.clear()
    _last_status.clear()
