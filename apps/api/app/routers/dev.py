"""개발자 콘솔 API — 역할 임명 · 가게 소유권 · 사업자 인증 심사 · 감사 로그.

계획: docs/MERCHANT_CONSOLE_RBAC_PLAN.md (로컬 전용)

## 왜 /admin 이 아니라 /dev 인가

`/admin` 은 정부기관 관계자가 보는 관제 화면이다. 거기에 "이 계정을 사장님으로 임명" 같은
운영 도구가 섞이면 화면이 산만해지고 사고 위험도 커진다. 권한 운영은 팀(개발자) 전용이므로
경로부터 분리한다.

## 원칙

- **모든 쓰기는 role_audit_log 에 남는다.** 로그 삭제 API 는 만들지 않는다 — 지워지는 감사
  기록은 의미가 없다.
- **마지막 developer 는 강등할 수 없다.** 자기 자신이라도 마찬가지다(아무도 권한을 못 주는
  잠김 상태 방지).
- **익명 세션은 상위 역할이 될 수 없다.** 단말에 묶여 있고 신원 확인이 불가능하다.
- **증빙은 심사 결정과 같은 호출에서 지운다.** 사업자등록번호 전체는 어느 시점에도 저장하지
  않으며, 뒤 4자리·서류 경로도 결정 즉시 비운다.
"""
import asyncio

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.authz import (
    ROLE_DEVELOPER,
    VALID_ROLES,
    get_current_profile,
    invalidate_profile_cache,
    log_role_audit,
    require_role,
)
from app.core.supabase import supabase_admin

logger = structlog.get_logger()

router = APIRouter(
    prefix="/api/v1/dev",
    tags=["dev"],
    dependencies=[Depends(require_role(ROLE_DEVELOPER))],
)


def _mask_email(email: str | None) -> str | None:
    """개인정보 최소 노출 — 개발자 화면에도 원문을 그대로 뿌리지 않는다."""
    if not email or "@" not in email:
        return email
    local, _, domain = email.partition("@")
    head = local[:2] if len(local) > 2 else local[:1]
    return f"{head}***@{domain}"


async def _developer_count() -> int:
    res = await asyncio.to_thread(
        supabase_admin.table("users").select("id", count="exact").eq("role", ROLE_DEVELOPER).limit(1).execute
    )
    return int(res.count or 0)


# =========================================================================
# 사용자 검색 · 역할 임명
# =========================================================================
@router.get("/users")
async def search_users(q: str = "", limit: int = 20):
    """닉네임 부분일치 또는 uid 정확일치로 찾는다.

    이메일로는 찾지 않는다 — auth.users 는 PostgREST 로 조회할 수 없고, 개인정보를
    검색 키로 쓰지 않는 편이 낫다. 개발자는 사용자에게 uid 를 받아 조회한다.
    """
    query = supabase_admin.table("users").select("id, nickname, role, created_at")
    term = (q or "").strip()
    if term:
        # uuid 형태면 정확일치, 아니면 닉네임 부분일치.
        if len(term) == 36 and term.count("-") == 4:
            query = query.eq("id", term)
        else:
            query = query.ilike("nickname", f"%{term}%")
    res = await asyncio.to_thread(query.order("created_at", desc=True).limit(min(limit, 100)).execute)
    return {"items": res.data or []}


class RoleChange(BaseModel):
    role: str
    reason: str | None = None


@router.patch("/users/{user_id}/role")
async def change_role(user_id: str, body: RoleChange, actor: dict = Depends(get_current_profile)):
    if body.role not in VALID_ROLES:
        raise HTTPException(status_code=422, detail="알 수 없는 역할입니다.")

    res = await asyncio.to_thread(
        supabase_admin.table("users").select("id, role").eq("id", user_id).limit(1).execute
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="해당 사용자를 찾을 수 없습니다.")
    before = str(res.data[0].get("role") or "tourist")
    if before == body.role:
        return {"user_id": user_id, "role": body.role, "changed": False}

    # 마지막 developer 를 강등하면 아무도 권한을 줄 수 없는 잠김 상태가 된다.
    if before == ROLE_DEVELOPER and body.role != ROLE_DEVELOPER and await _developer_count() <= 1:
        raise HTTPException(
            status_code=409,
            detail="마지막 개발자 계정은 강등할 수 없습니다. 다른 개발자를 먼저 임명하세요.",
        )

    await asyncio.to_thread(
        supabase_admin.table("users").update({"role": body.role}).eq("id", user_id).execute
    )
    # 응답을 돌려주기 전에 캐시를 비운다 — 안 그러면 최대 30초 동안 구 권한이 통한다.
    invalidate_profile_cache(user_id)
    log_role_audit(
        actor_id=actor["id"], target_id=user_id, action="role_change",
        from_value=before, to_value=body.role, reason=body.reason,
    )
    logger.info("dev_role_changed", actor=actor["id"], target=user_id, before=before, after=body.role)
    return {"user_id": user_id, "role": body.role, "changed": True}


# =========================================================================
# 가게 소유권
# =========================================================================
class OwnerGrant(BaseModel):
    user_id: str
    facility_id: str
    note: str | None = None


@router.get("/facility-owners")
async def list_facility_owners(facility_id: str | None = None, user_id: str | None = None):
    query = supabase_admin.table("facility_owners").select("*").is_("revoked_at", "null")
    if facility_id:
        query = query.eq("facility_id", facility_id)
    if user_id:
        query = query.eq("user_id", user_id)
    res = await asyncio.to_thread(query.order("granted_at", desc=True).limit(200).execute)
    return {"items": res.data or []}


@router.post("/facility-owners")
async def grant_facility_owner(body: OwnerGrant, actor: dict = Depends(get_current_profile)):
    res = await asyncio.to_thread(
        supabase_admin.table("users").select("id, role").eq("id", body.user_id).limit(1).execute
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="해당 사용자를 찾을 수 없습니다.")

    try:
        inserted = await asyncio.to_thread(
            supabase_admin.table("facility_owners").insert({
                "facility_id": body.facility_id,
                "user_id": body.user_id,
                "granted_by": actor["id"],
                "note": body.note,
            }).execute
        )
    except Exception as exc:
        # 활성 소유 행은 (가게, 사용자) 당 하나뿐이다(부분 유니크 인덱스).
        logger.warning("dev_owner_grant_failed", error=str(exc))
        raise HTTPException(status_code=409, detail="이미 이 가게의 소유자입니다.") from None

    invalidate_profile_cache(body.user_id)
    log_role_audit(
        actor_id=actor["id"], target_id=body.user_id, action="owner_grant",
        to_value=body.facility_id, reason=body.note,
    )
    return {"granted": True, "row": (inserted.data or [{}])[0]}


@router.delete("/facility-owners/{row_id}")
async def revoke_facility_owner(row_id: str, actor: dict = Depends(get_current_profile)):
    res = await asyncio.to_thread(
        supabase_admin.table("facility_owners").select("*").eq("id", row_id).limit(1).execute
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="해당 소유권 기록을 찾을 수 없습니다.")
    row = res.data[0]
    if row.get("revoked_at"):
        return {"revoked": False, "reason": "already_revoked"}

    # 삭제가 아니라 회수 시각을 찍는다 — 누가 언제 관리했는지는 감사 대상이다.
    await asyncio.to_thread(
        supabase_admin.table("facility_owners")
        .update({"revoked_at": "now()"})
        .eq("id", row_id)
        .execute
    )
    invalidate_profile_cache(str(row["user_id"]))
    log_role_audit(
        actor_id=actor["id"], target_id=str(row["user_id"]), action="owner_revoke",
        from_value=str(row["facility_id"]),
    )
    return {"revoked": True}


# =========================================================================
# 사업자 인증 심사
# =========================================================================
class ReviewDecision(BaseModel):
    reason: str | None = None


class RejectDecision(BaseModel):
    reason: str = Field(min_length=1)


@router.get("/verification-requests")
async def list_verification_requests(status_filter: str = "pending", limit: int = 100):
    res = await asyncio.to_thread(
        supabase_admin.table("business_verification_requests")
        .select("*")
        .eq("status", status_filter)
        .order("created_at")
        .limit(min(limit, 200))
        .execute
    )
    items = []
    for row in res.data or []:
        row = dict(row)
        row["contact"] = _mask_email(row.get("contact")) if "@" in str(row.get("contact") or "") else row.get("contact")
        items.append(row)
    return {"items": items}


async def _clear_evidence(request_id: str) -> None:
    """심사가 끝나면 증빙을 지운다 — 인증 완료 후에는 보관하지 않는다는 결정.

    Storage 파일 삭제는 경로가 있을 때만 시도하고, 실패해도 심사 결과를 되돌리지 않는다
    (다만 경고를 남겨 수동 정리가 가능하게 한다).
    """
    res = await asyncio.to_thread(
        supabase_admin.table("business_verification_requests")
        .select("document_path").eq("id", request_id).limit(1).execute
    )
    path = (res.data or [{}])[0].get("document_path")
    if path:
        try:
            await asyncio.to_thread(
                supabase_admin.storage.from_("business-documents").remove, [path]
            )
        except Exception as exc:
            logger.warning("verification_document_delete_failed", request_id=request_id, error=str(exc))


@router.post("/verification-requests/{request_id}/approve")
async def approve_verification(
    request_id: str, body: ReviewDecision, actor: dict = Depends(get_current_profile)
):
    res = await asyncio.to_thread(
        supabase_admin.table("business_verification_requests")
        .select("*").eq("id", request_id).limit(1).execute
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="해당 요청을 찾을 수 없습니다.")
    req = res.data[0]
    if req.get("status") != "pending":
        raise HTTPException(status_code=409, detail="이미 심사가 끝난 요청입니다.")
    if not req.get("facility_id"):
        raise HTTPException(
            status_code=409,
            detail="가게(POI)가 연결되지 않은 요청입니다. 먼저 시설을 매핑하세요.",
        )

    user_id = str(req["user_id"])
    # 역할 승격(이미 merchant 이상이면 유지) + 소유권 부여 + 상태 갱신을 순서대로.
    role_res = await asyncio.to_thread(
        supabase_admin.table("users").select("role").eq("id", user_id).limit(1).execute
    )
    before_role = str((role_res.data or [{}])[0].get("role") or "tourist")
    if before_role == "tourist":
        await asyncio.to_thread(
            supabase_admin.table("users").update({"role": "merchant"}).eq("id", user_id).execute
        )
        log_role_audit(
            actor_id=actor["id"], target_id=user_id, action="role_change",
            from_value=before_role, to_value="merchant", reason="사업자 인증 승인",
        )

    try:
        await asyncio.to_thread(
            supabase_admin.table("facility_owners").insert({
                "facility_id": req["facility_id"],
                "user_id": user_id,
                "granted_by": actor["id"],
                "verification_request_id": request_id,
            }).execute
        )
        log_role_audit(
            actor_id=actor["id"], target_id=user_id, action="owner_grant",
            to_value=str(req["facility_id"]), reason="사업자 인증 승인",
        )
    except Exception as exc:
        # 이미 소유자면 승인 자체는 계속 진행한다(재심사·중복 신청 흡수).
        logger.warning("verification_owner_insert_skipped", request_id=request_id, error=str(exc))

    await _clear_evidence(request_id)
    await asyncio.to_thread(
        supabase_admin.table("business_verification_requests").update({
            "status": "approved",
            "reviewed_by": actor["id"],
            "reviewed_at": "now()",
            "review_note": body.reason,
            "document_path": None,
            "business_number_last4": None,
        }).eq("id", request_id).execute
    )
    invalidate_profile_cache(user_id)
    log_role_audit(
        actor_id=actor["id"], target_id=user_id, action="verification_review",
        to_value="approved", reason=body.reason,
    )
    return {"approved": True, "user_id": user_id, "facility_id": req["facility_id"]}


@router.post("/verification-requests/{request_id}/reject")
async def reject_verification(
    request_id: str, body: RejectDecision, actor: dict = Depends(get_current_profile)
):
    res = await asyncio.to_thread(
        supabase_admin.table("business_verification_requests")
        .select("user_id, status").eq("id", request_id).limit(1).execute
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="해당 요청을 찾을 수 없습니다.")
    if res.data[0].get("status") != "pending":
        raise HTTPException(status_code=409, detail="이미 심사가 끝난 요청입니다.")

    await _clear_evidence(request_id)
    await asyncio.to_thread(
        supabase_admin.table("business_verification_requests").update({
            "status": "rejected",
            "reviewed_by": actor["id"],
            "reviewed_at": "now()",
            "review_note": body.reason,
            "document_path": None,
            "business_number_last4": None,
        }).eq("id", request_id).execute
    )
    log_role_audit(
        actor_id=actor["id"], target_id=str(res.data[0]["user_id"]),
        action="verification_review", to_value="rejected", reason=body.reason,
    )
    return {"rejected": True}


# =========================================================================
# 감사 로그 (읽기 전용 — 삭제 API 는 만들지 않는다)
# =========================================================================
@router.get("/audit-log")
async def list_audit_log(limit: int = 100, target_id: str | None = None):
    query = supabase_admin.table("role_audit_log").select("*")
    if target_id:
        query = query.eq("target_id", target_id)
    res = await asyncio.to_thread(
        query.order("created_at", desc=True).limit(min(limit, 500)).execute
    )
    return {"items": res.data or []}
