"""경량 제품 분석 이벤트 트래킹 라우터 — POST /api/v1/events/track.

배경: 리텐션/퍼널(랜딩 조회·추천 수락·쿠폰 사용 등)을 계측할 최소 수집 지점이 없었다.
  민감정보가 아닌 익명 이벤트만 app_events(service_role 전용, RLS)로 적재한다.

설계:
  - 무인증(랜딩·로그인 전에도 계측). user_id 는 기록하지 않는다(익명).
  - 페이로드 상한: event<=64자(pydantic), props<=1KB(직렬화 바이트 검증) — 과대/남용 방지.
  - IP 당 2초 쿨다운(프로세스 인메모리) — 비콘 남발 1차 차단. 쿨다운 시 조용히 드롭(204, 트래킹 손실 허용).
    단일 인스턴스 데모 기준이며 다중 인스턴스는 공유 저장소 기반으로 승격 필요(reports 쿨다운과 동일 관례).
  - 적재는 best-effort — DB 오류가 클라이언트 UX(비콘)를 깨지 않도록 흡수하고 204 를 준다.
"""
import asyncio
import json
import time

import structlog
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.core.supabase import supabase_admin

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/events", tags=["tracking"])

# props 직렬화 바이트 상한(1KB) 및 IP 쿨다운(초).
_PROPS_MAX_BYTES = 1024
_TRACK_COOLDOWN_SEC = 2.0
_last_track_at: dict[str, float] = {}

_EVENT_PROPS: dict[str, set[str]] = {
    "context_applied": {"categories", "max_walk_minutes", "available_minutes", "required_attributes", "exclude_visited"},
    "recommendation_compared": {"count"},
    "recommendation_explained": {"question", "llm_status"},
    "navigation_started": {"facility_type", "navigation_mode", "walk_minutes"},
    "trip_resumed": {"facility_type"},
    "replan_requested": {"facility_type"},
    "arrival_confirmed": {"facility_type"},
    "visit_confirmed": {"facility_type", "rating"},
    # 음성 지도 명령 실행. 프런트(analytics.ts:23)는 이미 이 이름으로 쏘고 있었는데 서버
    # 허용목록에 없어 전부 422 로 버려졌다 — 음성 퍼널 계측이 통째로 비어 있었다.
    "voice_tool_executed": {"tool", "status", "facility_type", "max_walk_minutes"},
}
_FACILITY_TYPES = {"restaurant", "cafe", "attraction", "culture"}
_ATTRIBUTES = {"indoor", "accessible"}
# 음성 명령 이름·결과. lib/voiceCommands.ts 의 VoiceAppCommand 와 같은 집합이어야 한다.
_VOICE_TOOLS = {"set_facility_type", "set_indoor_mode", "set_max_walk_minutes", "open_waiting_board"}
_VOICE_STATUSES = {"applied", "no_match"}


def _validate_product_event(event: str, props: dict) -> None:
    """공모전 퍼널 이벤트만 허용하고 자유 텍스트·좌표가 들어갈 표면 자체를 닫는다."""
    allowed = _EVENT_PROPS.get(event)
    if allowed is None or not set(props).issubset(allowed):
        raise HTTPException(status_code=422, detail="허용되지 않은 분석 이벤트 또는 속성입니다.")

    facility_type = props.get("facility_type")
    if facility_type is not None and facility_type not in _FACILITY_TYPES:
        raise HTTPException(status_code=422, detail="facility_type 값이 올바르지 않습니다.")
    categories = props.get("categories")
    if categories is not None and (
        not isinstance(categories, list) or len(categories) > 4 or any(v not in _FACILITY_TYPES for v in categories)
    ):
        raise HTTPException(status_code=422, detail="categories 값이 올바르지 않습니다.")
    attributes = props.get("required_attributes")
    if attributes is not None and (
        not isinstance(attributes, list) or len(attributes) > 2 or any(v not in _ATTRIBUTES for v in attributes)
    ):
        raise HTTPException(status_code=422, detail="required_attributes 값이 올바르지 않습니다.")
    if "max_walk_minutes" in props and props["max_walk_minutes"] not in {None, 5, 10, 20}:
        raise HTTPException(status_code=422, detail="max_walk_minutes 값이 올바르지 않습니다.")
    if "available_minutes" in props and props["available_minutes"] not in {None, 30, 60, 120}:
        raise HTTPException(status_code=422, detail="available_minutes 값이 올바르지 않습니다.")
    if "exclude_visited" in props and not isinstance(props["exclude_visited"], bool):
        raise HTTPException(status_code=422, detail="exclude_visited 값이 올바르지 않습니다.")
    if "question" in props and props["question"] not in {"why_first", "difference", "family_check"}:
        raise HTTPException(status_code=422, detail="question 값이 올바르지 않습니다.")
    if "llm_status" in props and props["llm_status"] not in {"llm", "llm_failed", "disabled", "rejected"}:
        raise HTTPException(status_code=422, detail="llm_status 값이 올바르지 않습니다.")
    if "navigation_mode" in props and props["navigation_mode"] not in {"walk", "car"}:
        raise HTTPException(status_code=422, detail="navigation_mode 값이 올바르지 않습니다.")
    if "rating" in props and props["rating"] not in {None, "up", "down"}:
        raise HTTPException(status_code=422, detail="rating 값이 올바르지 않습니다.")
    # 아래 두 검사는 이 함수의 다른 검사들과 마찬가지로 **이벤트가 아니라 속성 이름**에 걸린다.
    # 같은 이름을 쓰는 이벤트가 나중에 생기면 이 열거를 물려받는다 — question·llm_status·
    # navigation_mode 도 같은 구조다. 자유 텍스트 표면을 닫는 게 우선이라 관례를 따른다.
    if "tool" in props and props["tool"] not in _VOICE_TOOLS:
        raise HTTPException(status_code=422, detail="tool 값이 올바르지 않습니다.")
    if "status" in props and props["status"] not in _VOICE_STATUSES:
        raise HTTPException(status_code=422, detail="status 값이 올바르지 않습니다.")
    for key, maximum in (("count", 3), ("walk_minutes", 300)):
        value = props.get(key)
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0 or value > maximum):
            raise HTTPException(status_code=422, detail=f"{key} 값이 올바르지 않습니다.")


class TrackRequest(BaseModel):
    event: str = Field(..., max_length=64, description="이벤트명(<=64자)")
    props: dict = Field(default_factory=dict, description="부가 속성(<=1KB)")


def _client_ip(request: Request) -> str:
    """클라이언트 IP — 프록시(X-Forwarded-For) 우선, 없으면 소켓 피어. 쿨다운 키로만 쓴다.

    **마지막** 항목을 쓴다. 프록시는 XFF 에 덧붙이므로 첫 항목은 클라이언트가 임의로 써 보낼
    수 있고, 그걸 키로 쓰면 매 요청 다른 값을 넣어 쿨다운을 통째로 우회하면서 _last_track_at
    을 무한히 키운다. search.py:_client_ip · recommendations.py:_voice_client_ip 가 이미 같은
    이유로 마지막 항목을 쓴다 — 여기만 빠져 있었다.
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return request.client.host if request.client else "unknown"


@router.post("/track", status_code=status.HTTP_204_NO_CONTENT)
async def track_event(req: TrackRequest, request: Request):
    """익명 분석 이벤트 1건 적재 → 204. props 과대(422)·IP 쿨다운(조용히 드롭, 204)."""
    props = req.props or {}
    _validate_product_event(req.event, props)
    # props 크기 상한(직렬화 바이트 기준). 한글 등 멀티바이트도 정확히 반영되도록 ensure_ascii=False.
    if len(json.dumps(props, ensure_ascii=False).encode("utf-8")) > _PROPS_MAX_BYTES:
        raise HTTPException(status_code=422, detail="props 는 1KB 를 초과할 수 없습니다.")

    # IP 쿨다운 — 초과 요청은 적재하지 않고 조용히 204(트래킹 손실 허용).
    ip = _client_ip(request)
    now_mono = time.monotonic()
    cooldown_key = f"{ip}:{req.event}"
    last_at = _last_track_at.get(cooldown_key)
    if last_at is not None and (now_mono - last_at) < _TRACK_COOLDOWN_SEC:
        return None
    _last_track_at[cooldown_key] = now_mono

    # best-effort 적재 — DB 오류가 비콘 UX 를 깨지 않도록 흡수.
    try:
        await asyncio.to_thread(
            supabase_admin.table("app_events").insert({
                "event": req.event,
                "props": props,
            }).execute
        )
    except Exception as e:
        logger.warning("event_track_insert_failed", event=req.event, error=str(e))
    return None
