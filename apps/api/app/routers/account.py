"""소유 증명된 익명 세션 데이터를 현재 계정으로 승계한다."""
import asyncio

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.authz import get_current_profile
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


class OwnedFacility(BaseModel):
    id: str
    name: str
    type: str


class AccountMeResponse(BaseModel):
    """프런트 권한 게이팅의 **단일 출처**.

    화면들이 각자 users 를 직조회하며 역할을 추측하지 않게, 여기 한 곳에서만 내려준다.
    프런트 가드는 UX 이고 보안 경계는 항상 서버다 — 이 응답을 위조해도 API 는 막힌다.
    """

    id: str
    role: str
    is_anonymous: bool
    nickname: str | None = None
    owned_facilities: list[OwnedFacility] = []
    pending_verification: bool = False


@router.get("/me", response_model=AccountMeResponse)
async def get_me(profile: dict = Depends(get_current_profile)):
    nickname: str | None = None
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("users").select("nickname").eq("id", profile["id"]).limit(1).execute
        )
        if res.data:
            nickname = res.data[0].get("nickname")
    except Exception as exc:  # 프로필 이름은 부가 정보 — 실패해도 역할 응답을 막지 않는다.
        logger.warning("account_me_nickname_failed", user_id=profile["id"], error=str(exc))

    owned: list[OwnedFacility] = []
    facility_ids = sorted(profile.get("facility_ids") or ())
    if facility_ids:
        try:
            res = await asyncio.to_thread(
                supabase_admin.table("facilities")
                .select("id, name, type")
                .in_("id", facility_ids)
                .execute
            )
            owned = [
                OwnedFacility(id=str(r["id"]), name=r.get("name") or "", type=r.get("type") or "")
                for r in (res.data or [])
            ]
        except Exception as exc:
            # 소유 목록을 못 읽으면 빈 배열로 둔다. 화면은 '인증 대기' 로 보이고,
            # 실제 권한은 서버가 매 요청 확인하므로 안전 방향으로 어긋난다.
            logger.warning("account_me_owned_failed", user_id=profile["id"], error=str(exc))

    pending = False
    if not profile["is_anonymous"]:
        try:
            res = await asyncio.to_thread(
                supabase_admin.table("business_verification_requests")
                .select("id")
                .eq("user_id", profile["id"])
                .eq("status", "pending")
                .limit(1)
                .execute
            )
            pending = bool(res.data)
        except Exception as exc:
            # 표가 아직 배포되지 않은 환경(마이그레이션 미적용)도 조용히 통과시킨다.
            logger.warning("account_me_pending_failed", user_id=profile["id"], error=str(exc))

    return AccountMeResponse(
        id=profile["id"],
        role=profile["role"],
        is_anonymous=profile["is_anonymous"],
        nickname=nickname,
        owned_facilities=owned,
        pending_verification=pending,
    )


# =========================================================================
# 사업자 인증 요청 — 오프라인 인증(개발자에게 연락)의 '기록' 부분
# =========================================================================
# 실물 증거 확인은 사람이 하되, 누가 어떤 가게를 요청했고 어떻게 결정됐는지는 시스템이 남긴다.
# 승인 한 번으로 역할 임명 + 소유권 부여가 처리되고 감사 이력이 붙는다(dev 라우터).


class VerificationRequestCreate(BaseModel):
    store_name: str = Field(min_length=1, max_length=200)
    # 연락처는 필수다 — 카카오 계정은 이메일이 없을 수 있고, 심사는 사람이 연락해서 진행한다.
    contact: str = Field(min_length=1, max_length=200)
    facility_id: str | None = None
    business_number_last4: str | None = Field(default=None, pattern=r"^[0-9]{4}$")
    document_path: str | None = None


class VerificationRequestView(BaseModel):
    id: str
    store_name: str
    facility_id: str | None = None
    status: str
    review_note: str | None = None
    created_at: str | None = None


@router.post("/verification-requests", response_model=VerificationRequestView)
async def create_verification_request(
    body: VerificationRequestCreate, profile: dict = Depends(get_current_profile)
):
    if profile["is_anonymous"]:
        raise HTTPException(
            status_code=403,
            detail="게스트 세션으로는 신청할 수 없습니다. 먼저 계정을 만들어 주세요.",
        )
    payload = {
        "user_id": profile["id"],
        "store_name": body.store_name.strip(),
        "contact": body.contact.strip(),
        "facility_id": body.facility_id,
        "business_number_last4": body.business_number_last4,
        "document_path": body.document_path,
        "status": "pending",
    }
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("business_verification_requests").insert(payload).execute
        )
    except Exception as exc:
        # 같은 가게에 대기 중인 신청이 이미 있으면 부분 유니크 인덱스가 막는다.
        logger.warning("verification_request_insert_failed", user_id=profile["id"], error=str(exc))
        raise HTTPException(
            status_code=409, detail="이미 심사를 기다리는 신청이 있습니다."
        ) from None
    row = (res.data or [{}])[0]
    return VerificationRequestView(
        id=str(row.get("id")),
        store_name=row.get("store_name") or body.store_name,
        facility_id=row.get("facility_id"),
        status=row.get("status") or "pending",
        review_note=row.get("review_note"),
        created_at=row.get("created_at"),
    )


@router.get("/verification-requests/mine")
async def my_verification_requests(profile: dict = Depends(get_current_profile)):
    if profile["is_anonymous"]:
        return {"items": []}
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("business_verification_requests")
            .select("id, store_name, facility_id, status, review_note, created_at")
            .eq("user_id", profile["id"])
            .order("created_at", desc=True)
            .limit(20)
            .execute
        )
    except Exception as exc:
        # 표 미배포 환경에서도 화면이 깨지지 않게 빈 목록으로 폴백한다.
        logger.warning("verification_mine_failed", user_id=profile["id"], error=str(exc))
        return {"items": []}
    return {"items": res.data or []}


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
