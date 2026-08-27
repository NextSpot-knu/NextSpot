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
    recommendation_outcomes: int
    saved_facilities: int
    user_coupons: int
    congestion_reports: int
    inquiries: int
    availability_reports: int = 0
    preference_vector_moved: bool


class DeleteAccountResponse(BaseModel):
    deleted: bool


def _merge(guest_uid: str, target_uid: str) -> MergeGuestResponse:
    response = supabase_admin.rpc(
        "merge_guest_account_data",
        {"p_guest_user_id": guest_uid, "p_target_user_id": target_uid},
    ).execute()
    payload = response.data or {}
    if not isinstance(payload, dict):
        raise RuntimeError("merge_guest_account_data returned an invalid payload")
    return MergeGuestResponse(**payload)


@router.post("/merge-guest", response_model=MergeGuestResponse)
async def merge_guest(body: MergeGuestRequest, current_user: dict = Depends(get_current_user)):
    payload = verify_supabase_token(body.guest_token)
    if payload.get("is_anonymous") is not True:
        raise HTTPException(status_code=403, detail="익명 세션 토큰만 병합할 수 있습니다.")
    guest_uid, target_uid = payload["sub"], current_user["id"]
    if guest_uid == target_uid:
        return MergeGuestResponse(
            recommendations=0,
            user_feedback=0,
            recommendation_outcomes=0,
            saved_facilities=0,
            user_coupons=0,
            congestion_reports=0,
            inquiries=0,
            availability_reports=0,
            preference_vector_moved=False,
        )
    try:
        result = await asyncio.to_thread(_merge, guest_uid, target_uid)
        logger.info("guest_data_merged", guest_uid=guest_uid, target_uid=target_uid)
        return result
    except Exception:
        logger.exception("guest_data_merge_failed", guest_uid=guest_uid, target_uid=target_uid)
        raise HTTPException(status_code=500, detail="게스트 데이터를 병합하지 못했습니다.")


@router.delete("/me", response_model=DeleteAccountResponse)
async def delete_my_account(current_user: dict = Depends(get_current_user)):
    """현재 JWT 주체의 Supabase Auth 계정을 삭제한다.

    auth.users 삭제가 public.users 및 사용자 소유 행의 FK CASCADE를 시작한다. 브라우저가 보내는
    user_id는 받지 않아 다른 계정 삭제가 불가능하다.
    """
    user_id = current_user["id"]
    try:
        await asyncio.to_thread(supabase_admin.auth.admin.delete_user, user_id)
        logger.info("account_deleted", user_id=user_id)
        return DeleteAccountResponse(deleted=True)
    except Exception:
        logger.exception("account_delete_failed", user_id=user_id)
        raise HTTPException(status_code=500, detail="계정을 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.")
