"""소유 증명된 익명 세션 데이터를 현재 계정으로 승계한다."""
import asyncio

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.supabase import get_current_user, supabase_admin, verify_supabase_token

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1/account", tags=["account"])


class MergeGuestRequest(BaseModel):
    guest_token: str


class MergeGuestResponse(BaseModel):
    recommendations: int
    user_feedback: int
    saved_facilities: int


def _merge(guest_uid: str, target_uid: str) -> MergeGuestResponse:
    reco = supabase_admin.table("recommendations").update({"user_id": target_uid}).eq("user_id", guest_uid).execute()
    feedback = supabase_admin.table("user_feedback").update({"user_id": target_uid}).eq("user_id", guest_uid).execute()

    existing = supabase_admin.table("saved_facilities").select("facility_id").eq("user_id", target_uid).execute()
    existing_ids = [row["facility_id"] for row in (existing.data or [])]
    if existing_ids:
        supabase_admin.table("saved_facilities").delete().eq("user_id", guest_uid).in_("facility_id", existing_ids).execute()
    saved = supabase_admin.table("saved_facilities").update({"user_id": target_uid}).eq("user_id", guest_uid).execute()
    return MergeGuestResponse(
        recommendations=len(reco.data or []),
        user_feedback=len(feedback.data or []),
        saved_facilities=len(saved.data or []),
    )


@router.post("/merge-guest", response_model=MergeGuestResponse)
async def merge_guest(body: MergeGuestRequest, current_user: dict = Depends(get_current_user)):
    payload = verify_supabase_token(body.guest_token)
    if payload.get("is_anonymous") is not True:
        raise HTTPException(status_code=403, detail="익명 세션 토큰만 병합할 수 있습니다.")
    guest_uid, target_uid = payload["sub"], current_user["id"]
    if guest_uid == target_uid:
        return MergeGuestResponse(recommendations=0, user_feedback=0, saved_facilities=0)
    try:
        result = await asyncio.to_thread(_merge, guest_uid, target_uid)
        logger.info("guest_data_merged", guest_uid=guest_uid, target_uid=target_uid)
        return result
    except Exception:
        logger.exception("guest_data_merge_failed", guest_uid=guest_uid, target_uid=target_uid)
        raise HTTPException(status_code=500, detail="게스트 데이터를 병합하지 못했습니다.")
