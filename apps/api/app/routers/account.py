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


# 신청으로 얻을 수 있는 역할. **developer 는 없다** — 팀 내부 권한이라 신청 대상이 아니고,
# 신청 경로를 열어 두면 심사 실수 한 번이 곧 전체 권한 위임이 된다(/dev 콘솔에서 직접 임명).
REQUESTABLE_ROLES = ("merchant", "admin")


def _is_duplicate_pending(exc: Exception) -> bool:
    """이미 대기 중인 신청이 있어 부분 유니크 인덱스가 막은 경우인가.

    bvr_pending_facility_uq / bvr_pending_freeform_uq (20260827140000) 가 같은 사람의
    중복 신청을 막는다. 그 경우만 409 다.

    가려내지 않으면 **모든** 삽입 실패가 "이미 심사를 기다리는 신청이 있습니다" 가 된다 —
    커넥션이 끊겨도, RLS 가 막아도, 컬럼이 없어도 같은 문구다. 그러면 사용자는 신청이
    접수돼 있다고 믿고 기다리는데 심사 큐에는 아무것도 없다. 양쪽 다 이상하다고 느끼지
    못하는 게 이 오분류의 가장 나쁜 점이다.
    """
    text = str(exc).lower()
    return (
        "23505" in text
        or "duplicate key" in text
        or "bvr_pending_facility_uq" in text
        or "bvr_pending_freeform_uq" in text
    )


def _is_missing_requested_role(exc: Exception) -> bool:
    """requested_role 컬럼이 아직 없는 DB인가.

    마이그레이션(20260902130000)은 원격 SQL Editor 에서 사람이 적용한다 — 백엔드 배포가
    먼저 나가는 순서가 실제로 가능하다. 그때 사업자 신청까지 같이 죽으면 안 되므로
    이 오류만 골라내 컬럼 없이 한 번 더 시도한다. 마이그레이션 적용을 확인하면 지워도 된다.
    """
    text = str(exc).lower()
    return "requested_role" in text and (
        "pgrst204" in text or "column" in text or "schema cache" in text
    )


class VerificationRequestCreate(BaseModel):
    store_name: str = Field(min_length=1, max_length=200)
    # 연락처는 필수다 — 카카오 계정은 이메일이 없을 수 있고, 심사는 사람이 연락해서 진행한다.
    contact: str = Field(min_length=1, max_length=200)
    facility_id: str | None = None
    business_number_last4: str | None = Field(default=None, pattern=r"^[0-9]{4}$")
    document_path: str | None = None
    # 기본값은 merchant — 이 필드가 생기기 전 클라이언트(구 번들)가 보내는 요청과 같은 뜻이다.
    requested_role: str = "merchant"


class VerificationRequestView(BaseModel):
    id: str
    store_name: str
    facility_id: str | None = None
    status: str
    review_note: str | None = None
    created_at: str | None = None
    requested_role: str = "merchant"


def _insert_failure(user_id: str, exc: Exception) -> HTTPException:
    """신청 저장 실패를 정직한 상태 코드로 옮긴다.

    중복만 409 다. 나머지는 사용자 잘못이 아니라 우리 쪽 장애이므로 503 으로 알리고
    다시 시도하게 한다 — 409 로 뭉뚱그리면 '접수됐다' 는 오해를 남기고, 그 오해는
    심사 큐가 비어 있는 것으로도 드러나지 않는다.
    """
    if _is_duplicate_pending(exc):
        logger.info("verification_request_duplicate", user_id=user_id)
        return HTTPException(status_code=409, detail="이미 심사를 기다리는 신청이 있습니다.")
    logger.error("verification_request_insert_failed", user_id=user_id, error=str(exc))
    return HTTPException(
        status_code=503,
        detail="신청을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.",
    )


@router.post("/verification-requests", response_model=VerificationRequestView)
async def create_verification_request(
    body: VerificationRequestCreate, profile: dict = Depends(get_current_profile)
):
    if profile["is_anonymous"]:
        raise HTTPException(
            status_code=403,
            detail="게스트 세션으로는 신청할 수 없습니다. 먼저 계정을 만들어 주세요.",
        )
    if body.requested_role not in REQUESTABLE_ROLES:
        raise HTTPException(status_code=422, detail="신청할 수 없는 역할입니다.")
    payload = {
        "user_id": profile["id"],
        "store_name": body.store_name.strip(),
        "contact": body.contact.strip(),
        "facility_id": body.facility_id,
        "business_number_last4": body.business_number_last4,
        "document_path": body.document_path,
        "status": "pending",
        "requested_role": body.requested_role,
    }

    def _insert(data: dict):
        return supabase_admin.table("business_verification_requests").insert(data).execute()

    try:
        res = await asyncio.to_thread(_insert, payload)
    except Exception as exc:
        if _is_missing_requested_role(exc):
            if body.requested_role != "merchant":
                # 관리자 신청을 사업자 신청으로 조용히 바꿔 저장하면 심사자가 잘못된 권한을 준다.
                logger.error("verification_request_role_column_missing", user_id=profile["id"])
                raise HTTPException(
                    status_code=503,
                    detail="관리자 권한 신청은 아직 준비 중입니다. 잠시 후 다시 시도해 주세요.",
                ) from None
            logger.warning("verification_request_legacy_schema", user_id=profile["id"])
            payload.pop("requested_role", None)
            try:
                res = await asyncio.to_thread(_insert, payload)
            except Exception as retry_exc:
                raise _insert_failure(profile["id"], retry_exc) from None
        else:
            raise _insert_failure(profile["id"], exc) from None
    row = (res.data or [{}])[0]
    return VerificationRequestView(
        id=str(row.get("id")),
        store_name=row.get("store_name") or body.store_name,
        facility_id=row.get("facility_id"),
        status=row.get("status") or "pending",
        review_note=row.get("review_note"),
        created_at=row.get("created_at"),
        requested_role=row.get("requested_role") or body.requested_role,
    )


@router.get("/verification-requests/mine")
async def my_verification_requests(profile: dict = Depends(get_current_profile)):
    if profile["is_anonymous"]:
        return {"items": []}
    def _select(columns: str):
        return (
            supabase_admin.table("business_verification_requests")
            .select(columns)
            .eq("user_id", profile["id"])
            .order("created_at", desc=True)
            .limit(20)
            .execute()
        )

    base = "id, store_name, facility_id, status, review_note, created_at"
    try:
        res = await asyncio.to_thread(_select, base + ", requested_role")
    except Exception as exc:
        if _is_missing_requested_role(exc):
            # 컬럼이 없는 DB — 신청 이력 자체는 보여 줘야 한다(전부 사업자 신청이다).
            try:
                res = await asyncio.to_thread(_select, base)
            except Exception as retry_exc:
                logger.warning(
                    "verification_mine_failed", user_id=profile["id"], error=str(retry_exc)
                )
                return {"items": []}
        else:
            # 표 미배포 환경에서도 화면이 깨지지 않게 빈 목록으로 폴백한다.
            logger.warning("verification_mine_failed", user_id=profile["id"], error=str(exc))
            return {"items": []}
    items = [{"requested_role": "merchant", **dict(row)} for row in (res.data or [])]
    return {"items": items}


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
