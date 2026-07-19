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


class TrackRequest(BaseModel):
    event: str = Field(..., max_length=64, description="이벤트명(<=64자)")
    props: dict = Field(default_factory=dict, description="부가 속성(<=1KB)")


def _client_ip(request: Request) -> str:
    """클라이언트 IP — 프록시(X-Forwarded-For) 우선, 없으면 소켓 피어. 쿨다운 키로만 쓴다."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@router.post("/track", status_code=status.HTTP_204_NO_CONTENT)
async def track_event(req: TrackRequest, request: Request):
    """익명 분석 이벤트 1건 적재 → 204. props 과대(422)·IP 쿨다운(조용히 드롭, 204)."""
    props = req.props or {}
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
