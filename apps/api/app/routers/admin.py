"""관리자 전용 라우터 — docs/IMPROVEMENT_PLAN.md WS-A-6.

배경: 관리자 프런트(admin/*)가 anon 키(createPublicClient)로 facilities/system_settings/inquiries 를
직접 쓰던 경로는 RLS 강화(20260707120000_security_hardening.sql) 이후 전부 거부된다(이전에도
0행 갱신이 성공으로 표시되는 무음 실패였다). 이 라우터가 그 쓰기/민감 읽기의 단일 관문이다.

- 모든 엔드포인트는 require_admin(X-Admin-Authorization 공유 토큰) 가드로 보호된다.
- DB 접근은 service_role(supabase_admin) — RLS 우회는 이 신뢰 경로 안에서만 일어난다.
- 예외 원문은 서버 로그로만 남기고 클라이언트에는 일반 메시지를 준다.
"""
import asyncio
from datetime import datetime, timedelta, timezone

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.supabase import supabase_admin, require_admin

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/admin", tags=["admin"], dependencies=[Depends(require_admin)])

FACILITY_TYPES = {"restaurant", "cafe", "attraction", "culture"}
INQUIRY_STATUSES = {"new", "in_progress", "resolved"}  # inquiries.status CHECK 와 동일


# =========================================================================
# 시설(POI) CRUD — components/admin/FacilityTable.tsx
# =========================================================================

class FacilityCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    type: str
    capacity: int = Field(ge=1, le=100000)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class FacilityUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    capacity: int | None = Field(default=None, ge=1, le=100000)


@router.post("/facilities")
async def create_facility(req: FacilityCreate):
    if req.type not in FACILITY_TYPES:
        raise HTTPException(status_code=422, detail=f"type 은 {sorted(FACILITY_TYPES)} 중 하나여야 합니다.")
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("facilities").insert(req.model_dump()).execute
        )
        if not res.data:
            raise HTTPException(status_code=500, detail="시설 등록에 실패했습니다.")
        logger.info("admin_facility_created", facility_id=res.data[0].get("id"), name=req.name)
        return res.data[0]
    except HTTPException:
        raise
    except Exception as e:
        logger.error("admin_facility_create_failed", error=str(e))
        raise HTTPException(status_code=500, detail="시설 등록에 실패했습니다.")


@router.patch("/facilities/{facility_id}")
async def update_facility(facility_id: str, req: FacilityUpdate):
    fields = {k: v for k, v in req.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=422, detail="수정할 필드가 없습니다.")
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("facilities").update(fields).eq("id", facility_id).execute
        )
        if not res.data:
            raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.")
        logger.info("admin_facility_updated", facility_id=facility_id, fields=list(fields))
        return res.data[0]
    except HTTPException:
        raise
    except Exception as e:
        logger.error("admin_facility_update_failed", facility_id=facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="시설 수정에 실패했습니다.")


@router.delete("/facilities/{facility_id}")
async def delete_facility(facility_id: str):
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("facilities").delete().eq("id", facility_id).execute
        )
        if not res.data:
            raise HTTPException(status_code=404, detail="해당 시설을 찾을 수 없습니다.")
        logger.info("admin_facility_deleted", facility_id=facility_id)
        return {"success": True, "deleted_id": facility_id}
    except HTTPException:
        raise
    except Exception as e:
        # recommendations FK(ON DELETE SET NULL)·congestion_logs CASCADE 는 스키마가 처리한다.
        logger.error("admin_facility_delete_failed", facility_id=facility_id, error=str(e))
        raise HTTPException(status_code=500, detail="시설 삭제에 실패했습니다.")


# =========================================================================
# 시스템 설정 — app/admin/settings/page.tsx (system_settings 단일 행 id=1)
# =========================================================================

class SettingsUpdate(BaseModel):
    maintenance_mode: bool
    notice_text: str = Field(max_length=500)
    congestion_threshold: int = Field(ge=0, le=100)
    coldstart_weight: int = Field(ge=0, le=100)


@router.get("/settings")
async def get_settings():
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("system_settings").select("*").eq("id", 1).limit(1).execute
        )
        # 행이 없으면 null — 프런트가 기본값으로 폴백한다(마이그레이션 미적용 환경).
        return res.data[0] if res.data else None
    except Exception as e:
        logger.error("admin_settings_fetch_failed", error=str(e))
        raise HTTPException(status_code=500, detail="시스템 설정 조회에 실패했습니다.")


@router.put("/settings")
async def update_settings(req: SettingsUpdate):
    try:
        payload = req.model_dump()
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        res = await asyncio.to_thread(
            supabase_admin.table("system_settings").update(payload).eq("id", 1).execute
        )
        if not res.data:
            raise HTTPException(status_code=404, detail="system_settings 행이 없습니다. 마이그레이션 적용이 필요합니다.")
        logger.info("admin_settings_updated")
        return res.data[0]
    except HTTPException:
        raise
    except Exception as e:
        logger.error("admin_settings_update_failed", error=str(e))
        raise HTTPException(status_code=500, detail="시스템 설정 저장에 실패했습니다.")


# =========================================================================
# 문의(inquiries) — app/admin/support/page.tsx (PII 포함 → RLS 강화 후 admin API 전용)
# =========================================================================

class InquiryStatusUpdate(BaseModel):
    status: str


@router.get("/inquiries")
async def list_inquiries(limit: int = 500):
    limit = max(1, min(limit, 1000))
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("inquiries")
            .select("*")
            .order("created_at", desc=True)
            .limit(limit)
            .execute
        )
        return res.data or []
    except Exception as e:
        logger.error("admin_inquiries_fetch_failed", error=str(e))
        raise HTTPException(status_code=500, detail="문의 목록 조회에 실패했습니다.")


@router.patch("/inquiries/{inquiry_id}")
async def update_inquiry_status(inquiry_id: str, req: InquiryStatusUpdate):
    if req.status not in INQUIRY_STATUSES:
        raise HTTPException(status_code=422, detail=f"status 는 {sorted(INQUIRY_STATUSES)} 중 하나여야 합니다.")
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("inquiries").update({"status": req.status}).eq("id", inquiry_id).execute
        )
        if not res.data:
            raise HTTPException(status_code=404, detail="해당 문의를 찾을 수 없습니다.")
        logger.info("admin_inquiry_status_updated", inquiry_id=inquiry_id, status=req.status)
        return res.data[0]
    except HTTPException:
        raise
    except Exception as e:
        logger.error("admin_inquiry_update_failed", inquiry_id=inquiry_id, error=str(e))
        raise HTTPException(status_code=500, detail="문의 상태 변경에 실패했습니다.")


# =========================================================================
# 대시보드/리포트 지표 — anon 열람이 막힌 recommendations/user_feedback 의 비식별 지표 제공
# (admin/dashboard: 최근 7일 수락률·오늘 DAU / admin/reports: 최근 28일 수락 추이)
# =========================================================================

@router.get("/metrics")
async def get_metrics(days: int = 28):
    days = max(1, min(days, 90))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    try:
        recs_res, fb_res = await asyncio.gather(
            asyncio.to_thread(
                supabase_admin.table("recommendations")
                .select("accepted, created_at")
                .gte("created_at", since)
                .limit(5000)
                .execute
            ),
            asyncio.to_thread(
                supabase_admin.table("user_feedback")
                .select("user_id, timestamp")
                .gte("timestamp", since)
                .limit(5000)
                .execute
            ),
        )
        return {
            "since": since,
            "recommendations": recs_res.data or [],
            "feedback": fb_res.data or [],
        }
    except Exception as e:
        logger.error("admin_metrics_fetch_failed", error=str(e))
        raise HTTPException(status_code=500, detail="지표 조회에 실패했습니다.")
