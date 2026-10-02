"""진행 중 여정의 자연어 현장조건 → 허용 목록 조건(적용은 사용자가 확인한 뒤 프런트가 한다).

무인증 경로라 두 겹의 IP 리밋을 둔다(HANDOVER 보안 진단 '상', 키는 search 와 같은 `core.rate_limit.client_ip`):
  - 요청 리밋(분당 `_PARSE_RATE_LIMIT`) — 초과는 429 + Retry-After. 사람이 문장을 쳐서 누르는 속도보다 훨씬
    넉넉하게 잡았다(XFF 키가 엣지 IP 라 여러 방문자가 한 키를 공유할 가능성 — core/rate_limit.py 주석).
    웹(ActiveJourneyCard)은 429 를 재시도하지 않고 수동 조건 칩을 그대로 보여 준다.
  - LLM 리밋(분당 `_LLM_RATE_LIMIT`) — 키워드가 전량 미스라 LLM 백스톱을 부를 때만 소비한다. 초과는 429 가
    아니라 LLM 없이 빈 조건 + llm_status="gated"(search 재작성·음성 리밋과 같은 강등 방식).
전역 일일 LLM 예산은 llm_client 가 따로 묶는다(LLM_DAILY_BUDGET).
"""

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.core.rate_limit import check_rate_limit, client_ip, rate_limit_or_429
from app.services.travel_context_parser import parse_travel_context

router = APIRouter(prefix="/api/v1/travel-context", tags=["travel-context"])

_PARSE_RATE_LIMIT = 30
_LLM_RATE_LIMIT = 5
_parse_hits: dict[str, list[float]] = {}
_llm_hits: dict[str, list[float]] = {}


class ParseRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=300)


class ParseResponse(BaseModel):
    context: dict
    llm_status: str
    requires_confirmation: bool = True


@router.post("/parse", response_model=ParseResponse)
async def parse_context(req: ParseRequest, request: Request):
    ip = client_ip(request)
    rate_limit_or_429(
        _parse_hits, ip, _PARSE_RATE_LIMIT,
        "요청이 많아 잠시 후 다시 시도해 주세요.",
    )
    context, status = await parse_travel_context(
        req.text,
        llm_gate=lambda: check_rate_limit(_llm_hits, ip, _LLM_RATE_LIMIT) is None,
    )
    return ParseResponse(context=context, llm_status=status)
