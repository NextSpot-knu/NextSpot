"""제공자 독립 LLM 어댑터 — OpenAI 호환 chat completions (기본: 국산 Upstage Solar).

공모전 결정(2026-07-17, PM 확정): 국산 우선 + 비용 최소화 → Upstage solar-pro3
(가입 $10 크레딧, $0.15/$0.60 per MTok, 실측 지연 0.8~1.1초, JSON 신뢰성 solar-mini 대비 우위).
2026 관광데이터 공모전 규정에 외부 AI API 제한 없음(TourAPI 필수 활용 조건은 별도 충족).

설계 원칙 — 무해 폴백(이 저장소의 LLM 재도입 조건):
  - UPSTAGE_API_KEY 미설정 → is_enabled() False, 호출은 네트워크 없이 즉시 None.
  - 타임아웃(기본 3초)·HTTP 오류·JSON 파싱 실패 → 전부 None. 호출자는 None 이면 기존
    결정적 경로(키워드 분류기·템플릿)를 그대로 쓴다 — LLM 장애가 기능 장애로 승격되지 않는다.
  - 예외 원문·응답 본문은 서버 로그에만 남긴다(인증키·발화 원문 노출 방지).

제공자 교체: settings.LLM_BASE_URL/LLM_MODEL 만 바꾸면 OpenAI 호환 제공자(Gemini OpenAI
엔드포인트 등)로 전환된다 — 호출부는 이 모듈의 시그니처만 안다.

전신(InduSpot)에서 Vertex Gemini 를 제거했던 이유(외부 의존·데모 리스크)를 기억할 것:
LLM 은 항상 '보조'다. 주 경로를 LLM 으로 바꾸는 변경은 이 원칙 재검토 후에만.
"""

import json
from typing import Any, Optional

import httpx
import structlog

from app.core.config import settings

logger = structlog.get_logger()

# tourapi/client.py 와 동일 패턴 — 이벤트 루프 밖 생성/누수 방지용 lazy 싱글턴.
_client: Optional[httpx.AsyncClient] = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            base_url=settings.LLM_BASE_URL,
            headers={"Authorization": f"Bearer {settings.UPSTAGE_API_KEY}"},
            timeout=settings.LLM_TIMEOUT_SECONDS,
            limits=httpx.Limits(max_connections=10),
        )
    return _client


def is_enabled() -> bool:
    """키가 설정돼 있을 때만 True — 호출자는 False 면 LLM 경로 자체를 건너뛴다."""
    return bool((settings.UPSTAGE_API_KEY or "").strip())


async def aclose() -> None:
    """lifespan 종료 시 연결 정리(Codex 감사 P2-8) — 미기동/이미 닫힘이면 no-op."""
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


def extract_json(text: Any) -> Optional[dict]:
    """모델 출력에서 단일 JSON 객체를 엄격 추출(Codex 감사 P2-6).

    선행 텍스트·코드펜스는 허용(첫 '{' 부터 raw_decode)하되, 객체 뒤에 펜스 잔여물 외의
    후행 콘텐츠(이중 JSON·설명문)가 있으면 모호성으로 보고 거부한다 — '첫 번째/마지막을
    임의 채택'하는 관대한 파서는 인젝션 모호성을 키운다. dict 아님/실패는 None(예외 없음).
    """
    if not isinstance(text, str):
        return None
    start = text.find("{")
    if start < 0:
        return None
    try:
        parsed, end = json.JSONDecoder().raw_decode(text, start)
    except ValueError:
        return None
    if not isinstance(parsed, dict):
        return None
    if text[end:].strip().strip("`").strip():  # 코드펜스 백틱만 후행 허용
        return None
    return parsed


async def chat_text(
    system: str,
    user: str,
    *,
    max_tokens: int = 300,
    timeout: Optional[float] = None,
) -> Optional[str]:
    """1턴 chat completion — 성공 시 응답 텍스트, 실패(비활성/타임아웃/오류) 시 None."""
    if not is_enabled():
        return None
    try:
        response = await _get_client().post(
            "/chat/completions",
            json={
                "model": settings.LLM_MODEL,
                "max_tokens": max_tokens,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
            timeout=timeout if timeout is not None else settings.LLM_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
    except Exception as e:  # noqa: BLE001 — 어떤 실패든 None 폴백이 계약(무해 폴백)
        logger.warning("llm_request_failed", model=settings.LLM_MODEL, error=str(e)[:300])
        return None
    if not isinstance(content, str) or not content.strip():
        logger.warning("llm_empty_content", model=settings.LLM_MODEL)
        return None
    return content


async def chat_json(
    system: str,
    user: str,
    *,
    max_tokens: int = 300,
    timeout: Optional[float] = None,
) -> Optional[dict]:
    """JSON 출력을 기대하는 1턴 호출 — 파싱까지 성공해야 dict, 아니면 None."""
    content = await chat_text(system, user, max_tokens=max_tokens, timeout=timeout)
    if content is None:
        return None
    parsed = extract_json(content)
    if parsed is None:
        # 응답 본문은 로그에 남기지 않는다(Codex 리뷰 P1): 모델이 입력(실험실 자유 텍스트 등
        # 민감 정보)을 되풀이한 출력이 로그로 재노출될 수 있다. 길이만 기록.
        logger.warning("llm_bad_json", model=settings.LLM_MODEL, content_length=len(content))
    return parsed
