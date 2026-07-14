"""데이터 신선도 라우터 — GET /api/v1/freshness (D5, TourAPI 마지막 동기화 시각).

배경: 심사·관광객 모두 "이 데이터가 언제 것인가"를 알 수 있어야 한다(정직한 신선도 표기).
  scripts/ingest_tourapi.py 가 적재 후 app_events 에 남기는 동기화 마커(event='tourapi_sync')를
  정본으로 읽고, 마커가 없으면 facilities(TourAPI 적재분)의 updated_at 최대값으로 추정한다.

설계:
  - 공개 정보라 인증 불요(랜딩 푸터/배지에서 로그인 전에도 표시).
  - app_events 는 service_role 전용(RLS) — supabase_admin 으로 조회한다.
  - 예외는 structlog 서버 로그로만 남기고, 응답은 무해 null(전부 Optional) —
    이 엔드포인트 장애가 관광객 플로우를 막아선 안 된다(infrastructures 오류 컨벤션).
"""
import asyncio
from typing import Literal, Optional

import structlog
from fastapi import APIRouter
from pydantic import BaseModel

from app.core.supabase import supabase_admin

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1", tags=["freshness"])


class FreshnessResponse(BaseModel):
    last_tourapi_sync: Optional[str] = None            # ISO 시각. 판단 근거 없으면 None
    source: Optional[Literal["event", "estimate"]] = None  # event=동기화 마커, estimate=updated_at 추정
    written: Optional[int] = None                      # 마지막 동기화의 upsert 행 수(마커에만 존재)


@router.get("/freshness", response_model=FreshnessResponse)
async def get_freshness():
    """마지막 TourAPI 동기화 시각 — ① 동기화 마커 → ② updated_at 추정 → ③ 전부 null."""
    # ① app_events 동기화 마커(정본): ingest_tourapi.py 가 적재 직후 남긴 event='tourapi_sync'.
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("app_events")
            .select("created_at, props")
            .eq("event", "tourapi_sync")
            .order("created_at", desc=True)
            .limit(1)
            .execute
        )
        if res.data:
            row = res.data[0]
            written = (row.get("props") or {}).get("written")
            return FreshnessResponse(
                last_tourapi_sync=row.get("created_at"),
                source="event",
                written=written if isinstance(written, int) else None,
            )
    except Exception as e:
        logger.warning("freshness_event_marker_failed", error=str(e))

    # ② 폴백: TourAPI 적재분(contentid 있는 행)의 updated_at 최대값 — 정확한 배치 시각은 아니라 'estimate'.
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("facilities")
            .select("updated_at")
            .not_.is_("contentid", "null")
            .order("updated_at", desc=True)
            .limit(1)
            .execute
        )
        if res.data and res.data[0].get("updated_at"):
            return FreshnessResponse(
                last_tourapi_sync=res.data[0]["updated_at"],
                source="estimate",
                written=None,
            )
    except Exception as e:
        logger.warning("freshness_estimate_failed", error=str(e))

    # ③ 판단 근거 전무 — 전부 null(지어내지 않음). 프런트는 표기 자체를 숨긴다.
    return FreshnessResponse()
