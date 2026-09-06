"""소유 증명된 익명 세션 데이터를 현재 계정으로 승계한다."""
import asyncio
import uuid as uuid_module

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.authz import get_current_profile
from app.core.supabase import get_current_user, supabase_admin, verify_supabase_token
from app.core.verification_evidence import clear_verification_evidence

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


class VerificationRequestPatch(BaseModel):
    """대기 중인 신청의 수정 — 전 필드 선택.

    **requested_role 은 받지 않는다.** 역할을 바꾸는 것은 같은 신청의 수정이 아니라 다른
    신청이다. 심사자는 역할별 큐(GET /dev/verification-requests?requested_role=...)로 나눠
    보고 있어서, 큐에 떠 있는 신청의 역할이 밑에서 바뀌면 심사자가 보던 화면과 실제가
    어긋난다 — 역할을 바꾸려면 철회하고 새로 내야 한다.

    None 은 '지움' 이지 '안 보냄' 이 아니다. 둘의 구분은 model_fields_set 이 한다
    (아래 update_verification_request 참조).
    """

    # store_name/contact 는 NOT NULL 칼럼이다 — 명시적 null 은 빈 문자열과 함께 422 로 막는다.
    store_name: str | None = Field(default=None, max_length=200)
    contact: str | None = Field(default=None, max_length=200)
    business_number_last4: str | None = Field(default=None, pattern=r"^[0-9]{4}$")
    facility_id: str | None = None
    document_path: str | None = None


def _reject_foreign_document_path(document_path: str, user_id: str) -> None:
    """증빙 경로는 반드시 **자기 폴더** 여야 한다.

    스토리지 정책(20260904200000)은 남의 uid 폴더에 파일을 **올리는** 것만 막는다. 이미 있는
    남의 경로를 본문에 적어 보내는 것은 막지 못한다 — 그러면 심사자 화면에는 남의 사업자
    등록증이 이 신청서의 증빙으로 붙어 보인다. 경로 규약이 '<uid>/<파일명>' 이라는 사실이
    여기서 검사 근거가 된다. (신규 신청과 수정이 같은 규칙을 써야 해서 함수로 뺐다 —
    한쪽만 고쳐지면 수정 경로가 곧 우회로가 된다.)
    """
    owner = str(document_path).split("/", 1)[0]
    if owner != str(user_id):
        logger.warning(
            "verification_document_path_rejected",
            user_id=user_id,
            claimed_owner=owner,
        )
        raise HTTPException(status_code=422, detail="증빙 경로가 올바르지 않습니다.")


async def _ensure_facility_selectable(facility_id: str) -> None:
    """신청에 붙일 가게가 실존하고 영업 중(is_active)인지 확인한다.

    검사하지 않으면 없는 uuid 는 FK 위반으로 터지고, 그 실패는 _insert_failure 를 거쳐
    503 "저장하지 못했어요" 로 나간다 — 사용자가 고칠 수 있는 문제(가게를 다시 고르면 된다)가
    우리 쪽 장애처럼 보여서, 사용자는 같은 요청을 계속 다시 보낸다.

    조회 자체가 실패하면 422 가 아니라 503 이다. '못 찾았다' 로 뭉뚱그리면 우리 쪽 장애가
    사용자 입력 오류로 둔갑하고, 화면은 멀쩡한 가게를 없는 가게라고 말한다.
    """
    try:
        # uuid 가 아니면 조회 자체가 22P02 로 터진다 — 그건 입력 오류지 장애가 아니므로 먼저 거른다.
        uuid_module.UUID(str(facility_id))
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(status_code=422, detail="선택한 가게를 찾을 수 없습니다.") from None

    try:
        res = await asyncio.to_thread(
            supabase_admin.table("facilities")
            .select("id")
            .eq("id", str(facility_id))
            .eq("is_active", True)
            .limit(1)
            .execute
        )
    except Exception as exc:
        logger.error(
            "verification_facility_lookup_failed", facility_id=str(facility_id), error=str(exc)
        )
        raise HTTPException(
            status_code=503,
            detail="가게 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.",
        ) from None
    if not res.data:
        raise HTTPException(status_code=422, detail="선택한 가게를 찾을 수 없습니다.")


async def _load_own_request(request_id: str, user_id: str) -> dict:
    """본인 신청 한 건을 읽는다. 없거나 **남의 것이면 404** 다.

    소유 조건을 조회에 **같이** 건다(.eq("id").eq("user_id")). id 로 먼저 읽고 나서 user_id 를
    비교해 403 을 주면, 그 403 자체가 "그 id 의 신청은 존재한다" 는 확인이 된다. 남의 신청이
    있는지 없는지는 알려 줄 이유가 없는 정보라 두 경우를 같은 404 로 합친다.

    조회 실패는 404 가 아니라 503 이다 — 신청이 사라졌다고 답하면 사용자는 다시 신청서를
    쓰게 되고, 실제로는 pending 이 남아 있어 중복(409)에 부딪힌다.
    """
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("business_verification_requests")
            .select("*")
            .eq("id", request_id)
            .eq("user_id", user_id)
            .limit(1)
            .execute
        )
    except Exception as exc:
        logger.error(
            "verification_request_lookup_failed",
            request_id=request_id,
            user_id=user_id,
            error=str(exc),
        )
        raise HTTPException(
            status_code=503,
            detail="신청을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.",
        ) from None
    if not res.data:
        raise HTTPException(status_code=404, detail="해당 신청을 찾을 수 없습니다.")
    return dict(res.data[0])


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

    if body.document_path:
        _reject_foreign_document_path(body.document_path, profile["id"])
    # 프런트가 실제로 가게를 골라 보내기 시작했다 — 저장 전에 그 가게가 있는지 확인한다.
    if body.facility_id:
        await _ensure_facility_selectable(body.facility_id)
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


async def _facility_names(facility_ids: list[str]) -> dict[str, str | None]:
    """신청에 연결된 가게 이름을 **두 번째 쿼리로** 따로 가져온다.

    PostgREST 임베드(select("*, facilities(name)"))로 한 번에 붙이지 않는 이유: 임베드가
    실패하는 날 — 관계 캐시가 안 잡혔거나, 조인 권한이 막히거나 — 목록 **전체**가 같이
    죽는다. 이 화면의 본문은 "내가 무엇을 신청했고 지금 어떤 상태인가" 이고 가게 이름은
    부가 정보다. 부가 정보 때문에 본문을 못 보게 되는 것은 값이 맞지 않아서, 이름 조회는
    실패해도 None 으로 두고 목록은 그대로 내려보낸다(심사자 큐는 반대로 임베드를 쓴다 —
    거기서는 이름 대조가 승인의 근거라 없으면 안 된다).
    """
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("facilities").select("id, name").in_("id", facility_ids).execute
        )
    except Exception as exc:
        logger.warning("verification_mine_facility_names_failed", error=str(exc))
        return {}
    return {str(row["id"]): row.get("name") for row in (res.data or []) if row.get("id")}


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

    # reviewed_at/contact/document_path 는 최초 마이그레이션(20260827140000)부터 있던 칼럼이라
    # requested_role 과 달리 '컬럼 없음' 폴백이 필요 없다.
    base = (
        "id, store_name, facility_id, status, review_note, created_at, "
        "reviewed_at, contact, document_path"
    )
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
    items: list[dict] = []
    linked_ids: list[str] = []
    for row in res.data or []:
        item = {"requested_role": "merchant", **dict(row)}
        # 증빙 **경로는 절대 응답에 넣지 않는다** — 첨부 여부(bool)만 내려준다.
        # 버킷은 비공개이고 정책상 본인 폴더만 읽히지만, 경로를 알려 주는 순간 그 정책을
        # 뚫어 볼 실마리(파일명 규칙·다른 uid 폴더의 존재)를 함께 넘겨 주는 셈이 된다.
        # 화면이 필요로 하는 것은 "서류를 냈던가?" 뿐이라 bool 로 충분하다.
        item["has_document"] = bool(item.pop("document_path", None))
        item["facility_name"] = None
        if item.get("facility_id"):
            linked_ids.append(str(item["facility_id"]))
        items.append(item)

    if linked_ids:
        names = await _facility_names(sorted(set(linked_ids)))
        for item in items:
            item["facility_name"] = names.get(str(item.get("facility_id") or ""))
    return {"items": items}


@router.post("/verification-requests/{request_id}/withdraw")
async def withdraw_verification_request(
    request_id: str, profile: dict = Depends(get_current_profile)
):
    """신청자 본인이 대기 중인 신청을 철회한다.

    감사 로그(role_audit_log)에는 남기지 않는다. action 칼럼 CHECK 가
    ('role_change','owner_grant','owner_revoke','verification_review') 라 새 값에는
    마이그레이션이 필요한데, 철회는 애초에 **심사가 아니다** — 행 자체가 남는다
    (status='withdrawn' + reviewed_at). 흔적이 이미 있는 일을 위해 사람 손이 필요한
    DDL 을 늘리지 않는다. 대신 structlog 로 남겨 사후 추적을 가능하게 한다.
    """
    if profile["is_anonymous"]:
        raise HTTPException(
            status_code=403,
            detail="게스트 세션으로는 신청을 철회할 수 없습니다.",
        )

    row = await _load_own_request(request_id, profile["id"])
    if row.get("status") != "pending":
        raise HTTPException(status_code=409, detail="이미 심사가 끝난 신청입니다.")

    # 아래 상태 갱신이 document_path 를 NULL 로 만들기 때문에 지금 붙잡아 둔다
    # (dev.py 승인/반려와 같은 함정 — 갱신 뒤에 다시 읽으면 언제나 None 이라 파일이 안 지워진다).
    document_path = row.get("document_path")

    try:
        await asyncio.to_thread(
            supabase_admin.table("business_verification_requests").update({
                "status": "withdrawn",
                "reviewed_at": "now()",
                # 증빙은 보관하지 않는다 — 철회도 '심사 종료' 의 한 형태다.
                "document_path": None,
                "business_number_last4": None,
                # reviewed_by 는 건드리지 않는다. 철회는 심사가 아니라서 심사자가 없다 —
                # 본인 id 를 넣으면 심사 이력에서 사용자가 자기 신청을 심사한 것처럼 보인다.
            }).eq("id", request_id).eq("user_id", profile["id"]).execute
        )
    except Exception as exc:
        logger.error(
            "verification_request_withdraw_failed",
            request_id=request_id,
            user_id=profile["id"],
            error=str(exc),
        )
        raise HTTPException(
            status_code=503,
            detail="신청을 철회하지 못했어요. 잠시 후 다시 시도해 주세요.",
        ) from None

    # 파일 삭제는 상태 갱신 **뒤**다. 먼저 지우면 갱신이 실패했을 때 신청은 pending 인 채로
    # 증빙만 사라져, 심사자가 볼 서류가 없는 신청이 큐에 남는다(dev.py 승인/반려와 같은 판단).
    # 경로는 갱신 전에 읽어 둔 값을 넘긴다 — 갱신이 그 칼럼을 이미 NULL 로 만들었다.
    await clear_verification_evidence(request_id, document_path)
    logger.info(
        "verification_request_withdrawn", request_id=request_id, user_id=profile["id"]
    )
    return {"withdrawn": True, "id": request_id}


def _update_failure(user_id: str, exc: Exception) -> HTTPException:
    """신청 수정 실패를 정직한 상태 코드로 옮긴다.

    _insert_failure 와 같은 정신이되 문구가 다르다(신청은 그대로 남아 있으므로 "저장하지
    못했어요" 가 아니다). 여기서 409 가 나는 경우는 하나다: 같은 사람이 pending 신청을
    둘 이상 갖고 있는데, 한쪽을 다른 쪽과 같은 가게/이름으로 바꾸려 한 것
    (bvr_pending_facility_uq / bvr_pending_freeform_uq).
    """
    if _is_duplicate_pending(exc):
        logger.info("verification_request_update_duplicate", user_id=user_id)
        return HTTPException(
            status_code=409, detail="같은 내용으로 심사를 기다리는 신청이 이미 있습니다."
        )
    logger.error("verification_request_update_failed", user_id=user_id, error=str(exc))
    return HTTPException(
        status_code=503,
        detail="신청을 수정하지 못했어요. 잠시 후 다시 시도해 주세요.",
    )


@router.patch("/verification-requests/{request_id}", response_model=VerificationRequestView)
async def update_verification_request(
    request_id: str,
    body: VerificationRequestPatch,
    profile: dict = Depends(get_current_profile),
):
    """대기 중인 신청의 내용을 고친다.

    수정을 '철회 후 재신청' 으로 대신하게 하면 증빙을 다시 올려야 한다 — 연락처 오타 하나
    고치려고 사업자등록증을 다시 찍어 오게 만드는 셈이라 별도 경로를 둔다.
    """
    if profile["is_anonymous"]:
        raise HTTPException(
            status_code=403,
            detail="게스트 세션으로는 신청을 수정할 수 없습니다.",
        )

    # '보내지 않음' 과 '명시적 null' 을 반드시 갈라야 한다. model_dump() 는 안 보낸 필드도
    # None 으로 채워 내려주므로 그대로 쓰면 연락처만 고치려던 요청이 facility_id 연결까지
    # 함께 끊는다. exclude_unset=True 는 실제로 본문에 있던 키만 남긴다 — 그래서
    # facility_id: null 은 '연결 해제', 키 자체가 없으면 '그대로 둠' 이 된다.
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=422, detail="변경할 내용이 없습니다.")

    for key in ("store_name", "contact"):
        if key in fields:
            value = str(fields[key] or "").strip()
            if not value:
                # NOT NULL 칼럼이다. 빈 값으로 지우게 두면 심사자가 누구에게 연락할지 모르는
                # 신청서가 큐에 남는다.
                raise HTTPException(status_code=422, detail="빈 값으로는 바꿀 수 없습니다.")
            fields[key] = value

    if fields.get("document_path"):
        _reject_foreign_document_path(fields["document_path"], profile["id"])
    if fields.get("facility_id"):
        await _ensure_facility_selectable(fields["facility_id"])

    row = await _load_own_request(request_id, profile["id"])
    if row.get("status") != "pending":
        raise HTTPException(status_code=409, detail="이미 심사가 끝난 신청입니다.")

    # 갱신이 이 칼럼을 덮어쓰기 전에 붙잡아 둔다(철회·심사와 같은 이유).
    previous_document_path = row.get("document_path")

    try:
        res = await asyncio.to_thread(
            supabase_admin.table("business_verification_requests")
            .update(fields)
            .eq("id", request_id)
            .eq("user_id", profile["id"])
            .execute
        )
    except Exception as exc:
        raise _update_failure(profile["id"], exc) from None

    updated = {**row, **fields}
    if getattr(res, "data", None):
        # DB 가 돌려준 행이 있으면 그쪽이 진실이다(우리가 모르는 기본값·트리거 결과 포함).
        updated.update(dict(res.data[0]))

    # 증빙을 갈아 끼운 경우에만, 갱신에 성공한 **뒤** 옛 파일을 지운다. 순서가 반대면 갱신
    # 실패 시 신청서는 옛 경로를 가리키는데 그 파일은 이미 없다. 같은 경로로 덮어쓴 경우
    # (재업로드)는 지우면 안 된다 — 방금 올린 파일을 지우는 꼴이다.
    if (
        "document_path" in fields
        and previous_document_path
        and previous_document_path != fields.get("document_path")
    ):
        await clear_verification_evidence(request_id, previous_document_path)

    logger.info(
        "verification_request_updated",
        request_id=request_id,
        user_id=profile["id"],
        fields=sorted(fields),
    )
    return VerificationRequestView(
        id=str(updated.get("id") or request_id),
        store_name=updated.get("store_name") or "",
        facility_id=updated.get("facility_id"),
        status=updated.get("status") or "pending",
        review_note=updated.get("review_note"),
        created_at=updated.get("created_at"),
        requested_role=updated.get("requested_role") or "merchant",
    )


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
