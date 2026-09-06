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

    **facility_id 도 바꿀 수 없다.** 아래 _FACILITY_CHANGE_REJECTED 주석 참조 — 편의 문제가
    아니라 승인이 소유권을 붙이는 값 자체라서 심사 중에는 얼어 있어야 한다. 필드를 아예
    지우지 않고 남겨 둔 이유도 거기 적었다(구 번들이 보내는 값을 조용히 삼키지 않기 위해).

    None 은 '지움' 이지 '안 보냄' 이 아니다. 둘의 구분은 model_fields_set 이 한다
    (아래 update_verification_request 참조).
    """

    # store_name/contact 는 NOT NULL 칼럼이다 — 명시적 null 은 빈 문자열과 함께 422 로 막는다.
    store_name: str | None = Field(default=None, max_length=200)
    contact: str | None = Field(default=None, max_length=200)
    business_number_last4: str | None = Field(default=None, pattern=r"^[0-9]{4}$")
    # 갱신 대상이 아니다 — 받자마자 422 로 되돌린다(update_verification_request 첫머리).
    # 선언을 남겨 두는 것은 '이 필드는 무시된다' 가 아니라 '이 필드는 거절된다' 를 말하기
    # 위해서다. 모델에서 지우면 pydantic 기본값(extra=ignore)이 값을 조용히 버리고 200 을
    # 돌려줘, 프런트는 가게가 바뀐 줄 알고 화면에 반영한다 — 서버 상태와 어긋난 채로.
    facility_id: str | None = None
    document_path: str | None = None


# 신청 수정으로 가게를 바꿀 수 없다 — 바꾸려면 철회하고 다시 낸다.
#
# 왜 '수정 허용' 이 아니라 '철회 후 재신청' 인가:
#
# facility_id 는 승인이 소유권(facility_owners)을 붙이는 **바로 그 값**이다. 심사는 사람이
# 하고, 그 사람이 보는 것은 큐 화면의 정적 스냅샷이다 — 신청서의 가게 이름과 사업자등록증을
# 눈으로 대조하고 승인을 누른다. 그 사이에 신청자가 facility_id 를 다른 가게로 바꿀 수 있으면
# 다음이 성립한다: 자기 가게 A 로 신청하고 A 의 증빙을 붙인다 → 심사자가 A 를 확인한다 →
# 승인 직전에 B(남의 유명 가게)로 바꾼다 → 승인이 B 의 소유권을 준다. 큐는 새로고침 전까지
# 갱신되지 않으니 경쟁 상태도 아니고, facilities 는 anon SELECT 라 B 를 고르는 일도 쉽다.
# 그리고 소유권은 가벼운 자리가 아니다 — 좌석 방송 권한이고, 그 방송은 congestion_logs 에
# verified 로 들어가 추천 모델의 학습 데이터가 된다.
#
# 막는 방법은 여럿이지만(승인 본문에 심사자가 본 facility_id 를 실어 대조하기, 신청서에
# '마지막 수정 시각' 을 두고 승인이 그걸 확인하기) 둘 다 프런트 배포 순서나 새 칼럼에
# 의존한다. 여기서 고르는 것은 그 무엇에도 기대지 않는 쪽이다: **심사 중에는 이 값이 얼어
# 있다.** 가게를 잘못 골랐으면 철회하고 다시 내면 된다(철회 API 가 이미 있고 버튼 한 번이다).
# 잃는 것은 '가게만 바꾸고 증빙은 유지' 라는 한 가지 편의고, 지키는 것은 심사자가 본 것과
# 승인이 쓰는 것이 같다는 보장이다.
#
# 연락처·상호·증빙 교체는 그대로 열려 있다 — 그것들은 승인이 권한을 붙이는 값이 아니다.
_FACILITY_CHANGE_REJECTED = "가게를 바꾸려면 신청을 취소하고 다시 신청해 주세요."


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


async def _discard_uploaded_evidence(user_id: str, path: str | None) -> None:
    """저장에 실패한 신청의 **방금 올린** 증빙을 지운다.

    프런트는 신청서를 만들기 **전에** 증빙을 올린다. 그 순서 자체는 옳다 — 반대로 하면
    업로드가 실패했는데 신청만 접수돼 심사자가 근거 없는 신청을 받는다. 문제는 그 다음이다:
    저장이 실패하면 그 파일을 지울 주체가 아무도 없다. clear_verification_evidence 는 신청
    행에 적힌 경로를 지우는 함수인데 그 행이 없고, 스토리지 정책(20260904200000)은 DELETE
    정책을 **일부러 두지 않아** 브라우저는 자기가 올린 파일조차 못 지운다. 업로드 경로에는
    타임스탬프가 들어가 재시도마다 새 파일이 쌓인다. 그리고 가장 흔한 실패가 409(이미
    pending)와 503(콜드 스타트)이라, 이건 드물게 새는 구멍이 아니라 상시로 새는 구멍이다 —
    남는 물건이 사업자등록증이라 더 그렇다.

    그래서 서버가 치운다. service_role 은 RLS 를 우회하므로 스토리지 정책은 손대지 않는다.
    이 정리는 실패해도 조용하다(clear_verification_evidence 는 예외를 올리지 않는다) —
    사용자에게 돌아가는 오류 응답은 정리 성패와 무관하게 그대로여야 한다.
    """
    if not path:
        return
    # 지운 사실을 남긴다. 사용자가 "분명히 올렸는데 없다" 고 할 때 되짚을 유일한 흔적이다.
    logger.info("verification_evidence_discarded", user_id=user_id, path=path)
    # 신청 행이 없으므로 request_id 가 없다(수정 경로에서는 있다).
    await clear_verification_evidence(None, path)


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

    # 아래 실패 갈래들은 하나같이 "신청 행은 없는데 파일은 올라가 있는" 상태로 끝난다.
    # 그 상태를 남기지 않는 것이 _discard_uploaded_evidence 의 일이다(그 독스트링 참조).
    try:
        res = await asyncio.to_thread(_insert, payload)
    except Exception as exc:
        if _is_missing_requested_role(exc):
            if body.requested_role != "merchant":
                # 관리자 신청을 사업자 신청으로 조용히 바꿔 저장하면 심사자가 잘못된 권한을 준다.
                logger.error("verification_request_role_column_missing", user_id=profile["id"])
                await _discard_uploaded_evidence(profile["id"], body.document_path)
                raise HTTPException(
                    status_code=503,
                    detail="관리자 권한 신청은 아직 준비 중입니다. 잠시 후 다시 시도해 주세요.",
                ) from None
            logger.warning("verification_request_legacy_schema", user_id=profile["id"])
            payload.pop("requested_role", None)
            try:
                res = await asyncio.to_thread(_insert, payload)
            except Exception as retry_exc:
                # 오류를 **먼저** 만든다(로그 순서가 실제 원인 → 정리 순이 되도록).
                failure = _insert_failure(profile["id"], retry_exc)
                await _discard_uploaded_evidence(profile["id"], body.document_path)
                raise failure from None
        else:
            failure = _insert_failure(profile["id"], exc)
            await _discard_uploaded_evidence(profile["id"], body.document_path)
            raise failure from None
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

    **다만 가게(facility_id)만은 예외다** — 이유는 _FACILITY_CHANGE_REJECTED 참조.
    """
    if profile["is_anonymous"]:
        raise HTTPException(
            status_code=403,
            detail="게스트 세션으로는 신청을 수정할 수 없습니다.",
        )

    # 어떤 조회·쓰기보다 **먼저** 막는다. 뒤로 미루면 '거절했는데 갱신은 일어난' 창이 생기고,
    # 그 창 하나가 곧 이 검사의 우회로다. null(연결 해제)도 같은 변경이다 — 연결을 끊고
    # 승인받으면 심사자가 본 가게가 아닌 곳으로 붙을 수 있고, 애초에 승인이 막힌다.
    #
    # 여기서는 방금 올라온 document_path 를 지우지 않는다(아래 저장 실패 경로와 다른 점).
    # 지우려면 그 경로가 **이 신청이 현재 쓰고 있는 파일이 아님**을 먼저 확인해야 하는데,
    # 그 확인은 신청 행을 읽어야 가능하다 — 즉 이 검사를 조회 뒤로 미뤄야 한다. 그러면
    # {facility_id: 아무거나, document_path: 내 신청의 현재 경로} 한 방으로 심사 중인 자기
    # 증빙을 지워 심사자를 눈멀게 할 수 있다. 고아 파일 한 개보다 그쪽이 나쁘다.
    if "facility_id" in body.model_fields_set:
        logger.info(
            "verification_request_facility_change_rejected",
            request_id=request_id,
            user_id=profile["id"],
        )
        raise HTTPException(status_code=422, detail=_FACILITY_CHANGE_REJECTED)

    # '보내지 않음' 과 '명시적 null' 을 반드시 갈라야 한다. model_dump() 는 안 보낸 필드도
    # None 으로 채워 내려주므로 그대로 쓰면 연락처만 고치려던 요청이 사업자번호 뒤 4자리와
    # 증빙까지 함께 지운다. exclude_unset=True 는 실제로 본문에 있던 키만 남긴다 — 그래서
    # business_number_last4: null 은 '지움', 키 자체가 없으면 '그대로 둠' 이 된다.
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
    # facility_id 검증(_ensure_facility_selectable)은 여기 없다 — 위에서 이미 거절했으므로
    # fields 에 들어올 수 없다. 남겨 두면 '수정으로 가게를 바꿀 수 있다' 는 인상을 준다.

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
        failure = _update_failure(profile["id"], exc)
        # 갱신이 실패했으면 이번에 올린 파일은 어느 신청도 가리키지 않는다 — 지운다.
        # 지우는 것은 **이번에 보낸** 경로다. 옛 경로(previous_document_path)는 신청서가
        # 여전히 가리키고 있으므로 건드리면 살아 있는 신청의 증빙을 없애는 셈이 된다.
        # 같은 경로로 다시 올린 경우(재업로드)도 마찬가지라 아래 성공 경로와 같은 조건을 쓴다.
        new_path = fields.get("document_path")
        if new_path and new_path != previous_document_path:
            await _discard_uploaded_evidence(profile["id"], new_path)
        raise failure from None

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


async def _evidence_left_by(user_id: str) -> list[tuple[str, str]]:
    """이 사용자의 신청서에 아직 적혀 있는 증빙 (request_id, 경로) 목록.

    상태로 거르지 않는다. 결정이 끝난 신청은 document_path 가 이미 NULL 이라 어차피 걸리지
    않고(승인·반려·철회가 모두 그 칼럼을 비운다), 그래도 경로가 남아 있는 행이 있다면 그 행
    역시 지금 계정과 함께 사라진다 — 그 뒤로는 그 파일의 주인이 영영 없다. 남아 있는 것은
    전부 지우는 게 맞다.

    최신순으로 받는다. 상한이 있는 조회라 순서를 정하지 않으면 신청 이력이 상한을 넘는
    계정에서 **정작 대기 중인 신청이 페이지 밖으로 밀려날 수 있다**(증빙을 든 행은 언제나
    가장 최근 쪽이다). 조용히 빠뜨린 한 건이 곧 고아 파일 한 개다.

    조회 실패는 삼킨다. 여기서 예외를 올리면 파일 정리 실패가 곧 탈퇴 실패가 되는데,
    그건 아래 delete_my_account 가 고른 우선순위와 정반대다.
    """
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("business_verification_requests")
            .select("id, document_path")
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .limit(50)
            .execute
        )
    except Exception as exc:
        logger.warning("account_delete_evidence_lookup_failed", user_id=user_id, error=str(exc))
        return []
    return [
        (str(row.get("id")), str(row["document_path"]))
        for row in (res.data or [])
        if row.get("document_path")
    ]


@router.delete("/me", response_model=DeleteAccountResponse)
async def delete_my_account(current_user: dict = Depends(get_current_user)):
    """현재 JWT 주체의 Supabase Auth 계정을 삭제한다.

    auth.users 삭제가 public.users 및 사용자 소유 행의 FK CASCADE를 시작한다. 브라우저가 보내는
    user_id는 받지 않아 다른 계정 삭제가 불가능하다.

    ## 증빙을 **먼저** 지우는 이유

    FK CASCADE 는 행만 지운다 — Storage 의 사업자등록증은 CASCADE 대상이 아니다. 심사 대기
    중에 탈퇴하면 business_verification_requests 행은 사라지고 파일만 버킷에 남는데, 그 파일을
    가리키는 행이 없으니 **아무도 그것을 지울 수 없다**(경로를 아는 유일한 곳이 그 행이었다).
    마이그레이션 20260904200000 은 '심사가 끝나면 증빙을 보관하지 않는다' 고 단언한다 —
    탈퇴도 심사가 끝나는 한 형태다.

    순서가 계약이다. 계정을 먼저 지우면 경로를 읽을 방법이 사라진다.

    ## 그 대신 감수하는 것

    파일을 지운 뒤 계정 삭제가 실패하면, 신청은 pending 인 채로 증빙만 없는 상태가 된다
    (dev.py 승인·반려가 굳이 피하는 그 상태다). 그래도 이쪽을 고른다: 저 상태는 사용자가
    신청을 다시 내면 회복되지만, 반대 순서로 생기는 고아 파일은 되돌릴 방법이 아예 없고
    남는 물건이 사업자등록증이다.

    ## 증빙 삭제 실패는 탈퇴를 막지 않는다

    탈퇴는 사용자의 권리다. 우리 쪽 뒷정리가 실패했다고 그 권리를 미룰 수는 없다.
    clear_verification_evidence 는 실패해도 예외를 올리지 않고 경고만 남기므로(경로가 로그에
    남아 수동 정리가 가능하다) 이 호출들은 따로 감싸지 않는다.
    """
    user_id = current_user["id"]
    for request_id, path in await _evidence_left_by(user_id):
        logger.info("account_delete_clears_evidence", user_id=user_id, request_id=request_id)
        await clear_verification_evidence(request_id, path)
    try:
        await asyncio.to_thread(supabase_admin.auth.admin.delete_user, user_id)
        logger.info("account_deleted", user_id=user_id)
        return DeleteAccountResponse(deleted=True)
    except Exception:
        logger.exception("account_delete_failed", user_id=user_id)
        raise HTTPException(status_code=500, detail="계정을 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.")
