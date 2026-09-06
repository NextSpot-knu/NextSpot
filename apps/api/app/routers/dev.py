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
import time
from typing import Literal, NamedTuple

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.failure_log import recent_failures
from app.core.authz import (
    ROLE_ADMIN,
    ROLE_DEVELOPER,
    ROLE_MERCHANT,
    ROLE_TOURIST,
    VALID_ROLES,
    get_current_profile,
    invalidate_profile_cache,
    log_role_audit,
    require_role,
)
from app.core.supabase import supabase_admin
# 증빙 삭제는 **core 의 한 함수**만 쓴다. 심사(여기)와 철회·교체(account.py)가 같은 약속을
# 각자 구현하면 한쪽만 고쳐지는 날이 온다 — 실제로 이 파일이 한동안 사본을 들고 있었다.
from app.core.verification_evidence import clear_verification_evidence
# 신규 POI 의 capacity 기본값은 적재 파이프라인과 **같은 함수**로 정한다. 여기에 상수를
# 새로 두면 같은 질문("이 업종의 기본 수용 인원은?")에 서로 다른 답이 둘 생기고, 나중에
# 한쪽만 고쳐진다.
from app.services.batch.localdata import capacity_for

logger = structlog.get_logger()

# 심사로 부여할 수 있는 역할. account 라우터의 REQUESTABLE_ROLES 와 같은 집합이어야 한다 —
# 신청은 되는데 승인이 막히는(또는 그 반대) 상태가 생기지 않도록 여기서 한 번 더 검사한다.
REVIEWABLE_ROLES = ("merchant", "admin")


def _is_duplicate_owner(exc: Exception) -> bool:
    """이미 활성 소유권이 있어 facility_owners_active_uq 가 막은 경우인가.

    이 경우만 넘어가도 된다 — 원하던 상태가 이미 성립해 있다는 뜻이므로.
    (20260827140000 의 부분 유니크 인덱스, revoked_at IS NULL 행 한정)
    """
    text = str(exc).lower()
    return (
        "23505" in text
        or "duplicate key" in text
        or "facility_owners_active_uq" in text
    )

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
# 이메일 인덱스 — auth.users 를 PostgREST 로 못 읽는 문제의 우회
# =========================================================================
# public.users 에는 이메일이 없다(auth.users 에만 있고, 그 스키마는 PostgREST 로 노출되지
# 않는다). 그래서 원래 이 화면은 닉네임·uid 로만 찾을 수 있었는데, **OAuth 가 아닌 자체
# 이메일 계정은 닉네임이 NULL 이라 어느 쪽으로도 찾히지 않았다** — 심사용 사업자 계정
# openapi@naver.com 이 정확히 그 경우였다(2026-09-02). 개발자가 아는 유일한 식별자가
# 이메일인데 그걸로는 검색이 안 되니 계정을 영영 못 찾는다.
#
# GoTrue Admin 목록에는 단건 조회나 서버측 필터가 없다. 전체를 한 번 훑어 인덱스를 만들고
# 짧게 캐시한다. 비싸 보이지만 실제로는 622명 중 실계정이 8명뿐이라(나머지 614명이 익명
# 세션) 인덱스는 몇 KB다 — 2026-09-02 실측.
# 같은 순회에서 익명 여부도 같이 담는다(_AuthIndex.real_uids). 목록에서 게스트를 걷어내려면
# 그 정보가 필요한데, public.users 에는 없고 auth.users 에만 있다. 이미 도는 순회에 얹으면
# 왕복이 늘지 않는다.
# scripts/seed_judge_accounts.py 의 _find_user_by_email 과 같은 접근이다.
class _AuthIndex(NamedTuple):
    """auth.users 를 한 번 훑어 만든 부가 정보. PostgREST 로는 볼 수 없는 것들이다.

    emails      — {소문자 이메일: uid}. public.users 에 이메일 칼럼이 없어 검색·표시에 쓴다.
    real_uids   — 익명(게스트) 세션이 **아닌** 계정의 uid. 목록에서 게스트를 걷어내는 데 쓴다.
    guest_count — 걸러낸 게스트 수. 화면에 그대로 보여 준다 — 조용히 줄인 목록을
                  '전부'로 오해하지 않게.
    """

    emails: dict[str, str]
    real_uids: frozenset[str]
    guest_count: int


_EMAIL_INDEX_TTL_SECONDS = 120.0
# 한 페이지 크기. 615명을 200씩 넷으로 나눠 받으면 1.0초, 1000으로 한 번에 받으면 0.34초였다
# (2026-09-02 실측). 왕복 횟수가 그대로 체감 지연이라 크게 잡는다.
_EMAIL_INDEX_PAGE_SIZE = 1000
_EMAIL_INDEX_MAX_PAGES = 10  # 안전장치 — 10,000명까지. 넘으면 그 이후는 못 찾는다.
# 게스트 필터를 포함 목록(id.in.(...))으로 거는 상한. uuid 하나가 37바이트라 500개면 18KB 로,
# 흔한 URL 길이 한도 안이다. 지금은 실계정이 8명이라 300바이트다.
_GUEST_FILTER_MAX_IDS = 500
_auth_index_cache: tuple[float, _AuthIndex] | None = None


def _build_auth_index() -> _AuthIndex:
    emails: dict[str, str] = {}
    real: set[str] = set()
    seen = 0
    page = 1
    while page <= _EMAIL_INDEX_MAX_PAGES:
        users = supabase_admin.auth.admin.list_users(
            page=page, per_page=_EMAIL_INDEX_PAGE_SIZE
        )
        if not users:
            break
        seen += len(users)
        for user in users:
            uid = str(user.id)
            email = (getattr(user, "email", "") or "").strip().lower()
            if email:
                emails[email] = uid
            # is_anonymous 가 정답이다. 다만 이 필드가 없는 구버전 라이브러리에서 전원을
            # 게스트로 판정해 목록을 통째로 비우는 일은 없어야 하므로, 필드가 없으면
            # '이메일이 있으면 실계정' 으로 떨어뜨린다(실측상 두 기준은 일치한다).
            flag = getattr(user, "is_anonymous", None)
            if (flag is False) or (flag is None and email):
                real.add(uid)
        if len(users) < _EMAIL_INDEX_PAGE_SIZE:
            break
        page += 1
    return _AuthIndex(emails, frozenset(real), max(seen - len(real), 0))


async def _auth_index() -> _AuthIndex:
    """인증 인덱스(캐시). 실패해도 예외를 올리지 않는다 — 부가 정보다."""
    global _auth_index_cache
    now = time.monotonic()
    cached = _auth_index_cache
    if cached and cached[0] > now:
        return cached[1]
    try:
        index = await asyncio.to_thread(_build_auth_index)
    except Exception as exc:
        # 인덱스를 못 만들어도 닉네임·uid 검색은 그대로 동작해야 한다.
        logger.warning("dev_email_index_failed", error=str(exc))
        return cached[1] if cached else _AuthIndex({}, frozenset(), 0)
    _auth_index_cache = (now + _EMAIL_INDEX_TTL_SECONDS, index)
    return index


# 운영 대상 역할 — 화면의 하위 메뉴와 같은 집합이다. tourist 는 600명이 넘어 목록으로서
# 의미가 없고 건수도 쓰지 않으므로 세지 않는다(그 덕에 아래 조회가 세 줄짜리로 끝난다).
MANAGED_ROLES = (ROLE_MERCHANT, ROLE_ADMIN, ROLE_DEVELOPER)
_MANAGED_ROLE_SCAN_LIMIT = 1000


def _count_managed_roles_blocking() -> dict[str, int]:
    """사업자·관리자·개발자 인원.

    역할마다 count 쿼리를 날리면 왕복이 네 번이고(실측 2~3초), 동시 요청으로 바꾸면
    Supabase 커넥션이 끊겨 503 이 난다(courses 간헐 실패, 2026-08-28). 그래서 tourist 를
    뺀 행의 role 만 한 번에 받아 파이썬에서 센다 — 지금 세 명이라 응답이 수십 바이트다.
    상한을 넘길 만큼 늘어나면 그때는 역할별 count 쿼리로 되돌리는 게 맞다.
    """
    res = (
        supabase_admin.table("users")
        .select("role")
        .neq("role", ROLE_TOURIST)
        .limit(_MANAGED_ROLE_SCAN_LIMIT)
        .execute()
    )
    counts = {role: 0 for role in MANAGED_ROLES}
    for row in res.data or []:
        role = str(row.get("role") or "")
        if role in counts:
            counts[role] += 1
    return counts


# =========================================================================
# 사용자 검색 · 역할 임명
# =========================================================================
@router.get("/users")
async def search_users(q: str = "", role: str | None = None, limit: int = 20):
    """이메일·닉네임 부분일치 또는 uid 정확일치로 찾는다.

    `role` 을 주면 그 역할만 추린다(개발자 콘솔의 사업자/관리자/개발자 하위 메뉴).
    응답의 `counts` 는 역할별 인원이라 화면이 따로 세지 않아도 된다.

    이메일은 **마스킹해서** 돌려준다(_mask_email). 개발자 화면이라도 원문을 그대로
    뿌리지 않는다는 기존 결정을 따른다 — 도메인이 남아 계정 구분에는 충분하다.

    익명(게스트) 세션은 목록에서 제외한다. 몇 명을 뺐는지는 `hidden_guests` 로 같이 준다.
    uid 를 정확히 넣으면 게스트도 그대로 조회된다.
    """
    if role is not None and role not in VALID_ROLES:
        raise HTTPException(status_code=422, detail="알 수 없는 역할입니다.")

    index = await _auth_index()
    emails = index.emails
    email_by_uid = {uid: email for email, uid in emails.items()}

    query = supabase_admin.table("users").select("id, nickname, role, created_at")
    if role:
        query = query.eq("role", role)

    term = (q or "").strip()
    is_uid_lookup = len(term) == 36 and term.count("-") == 4

    # 게스트(익명 세션)를 목록에서 뺀다. 622명 중 614명이 게스트라(2026-09-02 실측) 최근순 20건이
    # 사실상 전부 "(이름·이메일 없음)" 으로 채워져 목록이 쓸모없다.
    #
    # 제외 목록이 아니라 **포함 목록**으로 거른다: 게스트는 수백 명이지만 실계정은 여덟 명이라
    # id.in.(...) 이 300바이트다. 반대로 하면 URL 이 수만 바이트가 된다.
    #
    # 두 가지 예외:
    #   · uid 정확일치 — 게스트라도 찾아야 한다(신고·리포트 추적). 목록이 아니라 지목이다.
    #   · 인덱스가 비었을 때 — GoTrue 장애로 real_uids 가 비면 필터가 목록을 통째로 비운다.
    #     표시용 필터 때문에 화면이 죽는 편보다 게스트가 섞여 보이는 편이 낫다(페일 오픈).
    if index.real_uids and not is_uid_lookup:
        if len(index.real_uids) <= _GUEST_FILTER_MAX_IDS:
            query = query.in_("id", sorted(index.real_uids))
        else:
            # 실계정이 이만큼 늘면 id.in.(...) 이 URL 길이를 넘겨 조회가 통째로 깨진다.
            # 그리고 그때는 게스트가 다수도 아니라 애초에 이 필터의 전제가 사라진다 —
            # public.users 에 익명 여부 칼럼을 두고 서버측에서 거르도록 바꿀 때다.
            logger.warning("dev_guest_filter_skipped", real_accounts=len(index.real_uids))

    if term:
        if is_uid_lookup:
            query = query.eq("id", term)
        else:
            matched = [uid for email, uid in emails.items() if term.lower() in email]
            if matched:
                # PostgREST or() 는 쉼표·괄호가 구분자다. 좌변은 uuid 뿐이라 안전하고,
                # 닉네임 항은 구분자를 공백으로 바꿔 넣는다(*는 ilike 의 % 자리).
                safe = "".join(" " if c in ',()"' else c for c in term)
                query = query.or_(f"nickname.ilike.*{safe}*,id.in.({','.join(matched)})")
            else:
                query = query.ilike("nickname", f"%{term}%")

    res = await asyncio.to_thread(query.order("created_at", desc=True).limit(min(limit, 100)).execute)
    items = []
    for row in res.data or []:
        row = dict(row)
        row["email"] = _mask_email(email_by_uid.get(str(row.get("id"))))
        items.append(row)

    counts: dict[str, int] = {}
    try:
        counts = await asyncio.to_thread(_count_managed_roles_blocking)
    except Exception as exc:
        # 카운트는 화면 장식이다 — 실패해도 목록은 돌려준다.
        logger.warning("dev_role_counts_failed", error=str(exc))
    return {"items": items, "counts": counts, "hidden_guests": index.guest_count}


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
async def list_facility_owners(
    facility_id: str | None = None, user_id: str | None = None, user_ids: str | None = None
):
    """활성 소유권 목록. `user_ids` 는 쉼표 구분 — 사용자 목록 한 화면분을 한 번에 받는다.

    가게 이름을 임베드해서 내려준다. uuid 만 보여 주면 개발자가 어느 가게인지 알 수 없어
    회수 버튼을 누르기 무섭다(FK 가 있으므로 PostgREST 가 조인해 준다).
    """
    query = (
        supabase_admin.table("facility_owners")
        .select("*, facilities(name, type)")
        .is_("revoked_at", "null")
    )
    if facility_id:
        query = query.eq("facility_id", facility_id)
    if user_id:
        query = query.eq("user_id", user_id)
    if user_ids:
        ids = [x.strip() for x in user_ids.split(",") if x.strip()]
        if not ids:
            return {"items": []}
        query = query.in_("user_id", ids[:100])
    res = await asyncio.to_thread(query.order("granted_at", desc=True).limit(200).execute)
    items = []
    for row in res.data or []:
        row = dict(row)
        facility = row.pop("facilities", None) or {}
        row["facility_name"] = facility.get("name")
        row["facility_type"] = facility.get("type")
        items.append(row)
    return {"items": items}


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
class NewFacilityInput(BaseModel):
    """심사자가 승인하면서 **새로 만들** 가게.

    카카오맵·TourAPI·LocalData 어디에도 없는 가게의 사장님이 신청하는 경우가 실제로 있다.
    그런 신청에 "역할만" 주면 콘솔에는 들어가지는데 관리할 POI 가 없어 모든 요청이 403 인
    막다른 계정이 된다(아래 소유권 부여 실패 주석과 같은 상태다). 그래서 권한이 아니라
    **가게**를 만들어 준다.
    """

    name: str = Field(min_length=1, max_length=200)
    type: Literal["restaurant", "cafe", "attraction", "culture"]
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    address: str | None = None
    phone: str | None = None
    # 비우면 업종 기본값(capacity_for)을 쓴다. facilities.capacity 는 NOT NULL 이라
    # '모름'을 그대로 저장할 수 없다 — 대신 features.capacity_evidence 에 근거를 남긴다.
    capacity: int | None = Field(default=None, ge=1, le=10000)


class ReviewDecision(BaseModel):
    """승인 본문. 가게를 연결하는 길이 둘이고, **동시에 쓸 수는 없다**.

    facility_id  — 이미 등록된 POI 를 연결한다.
    new_facility — 미등록 가게를 이 승인에서 만들어 연결한다.
    """

    reason: str | None = None
    facility_id: str | None = None
    new_facility: NewFacilityInput | None = None


class RejectDecision(BaseModel):
    reason: str = Field(min_length=1)


def _is_missing_requested_role(exc: Exception) -> bool:
    """requested_role 컬럼이 아직 없는 DB인가.

    account.py 에 같은 판정이 있다. 그런데도 여기 한 벌 더 두는 이유: 이건 마이그레이션
    20260902130000 이 원격 SQL Editor 에 수동 적용될 때까지만 사는 **한시적 방어**이고,
    그 하나를 지우려고 심사 큐(dev)가 신청 접수(account)를 import 하면 그 임시 결합이
    코드에 오래 남는다. 마이그레이션 적용을 확인하면 **두 곳을 같이** 지운다.
    """
    text = str(exc).lower()
    return "requested_role" in text and (
        "pgrst204" in text or "column" in text or "schema cache" in text
    )


@router.get("/verification-requests")
async def list_verification_requests(
    status_filter: str = "pending", requested_role: str | None = None, limit: int = 100
):
    """심사 큐. `requested_role` 로 사업자/관리자 하위 메뉴를 가른다.

    developer 는 여기 올 수 없다 — 신청 자체가 만들어지지 않는다(REQUESTABLE_ROLES,
    그리고 DB CHECK). 그래서 값으로도 받지 않는다: 받아 주면 '개발자 심사 큐가 있다'는
    잘못된 인상을 주고, 영원히 빈 목록을 돌려준다.
    """
    if requested_role is not None and requested_role not in REVIEWABLE_ROLES:
        raise HTTPException(status_code=422, detail="심사 대상이 아닌 역할입니다.")

    # 가게 이름을 함께 끌어온다. 심사자가 보던 건 uuid 뿐이었는데, 그 uuid 는 **신청자가
    # 본문에 적어 보낸 값**이라 아무도 대조하지 않으면 승인 한 번이 곧 남의 가게 소유권이
    # 된다. 이름이 보이면 최소한 신청서의 store_name 과 눈으로 맞춰 볼 수 있다.
    # (소유권 회수 화면은 이미 같은 임베드를 쓴다 — list_facility_owners 참고.)
    def _fetch(with_role_filter: bool):
        # 체이닝은 한 번 쓰면 되돌릴 수 없어(필터가 누적된다) 재시도용으로 매번 새로 만든다.
        query = (
            supabase_admin.table("business_verification_requests")
            .select("*, facilities(name, type)")
            .eq("status", status_filter)
        )
        if with_role_filter and requested_role:
            query = query.eq("requested_role", requested_role)
        return query.order("created_at").limit(min(limit, 200)).execute()

    try:
        res = await asyncio.to_thread(_fetch, True)
    except Exception as exc:
        if not (requested_role and _is_missing_requested_role(exc)):
            raise
        # 컬럼이 없는 DB(마이그레이션 미적용). 여기서 그냥 터지면 심사 큐 화면이 통째로
        # 500 이라 **사업자 승인도 같이 막힌다** — 컬럼 하나 때문에 잃기엔 큰 기능이다.
        # 컬럼이 없다 = 모든 신청이 사업자 신청이다(account.py 는 그 DB 에서 관리자 신청
        # 접수를 503 으로 막는다). 필터 없이 다시 받아 파이썬에서 같은 기준으로 거른다.
        logger.warning("verification_queue_legacy_schema", requested_role=requested_role)
        res = await asyncio.to_thread(_fetch, False)

    items = []
    for row in res.data or []:
        row = dict(row)
        if requested_role and (row.get("requested_role") or "merchant") != requested_role:
            # 위 폴백으로 받은 목록에만 걸린다(정상 DB 는 서버측에서 이미 걸러져 있다).
            continue
        # 관리자 신청은 facility_id 가 NULL 이라 임베드가 없다 — or {} 로 흡수한다.
        facility = row.pop("facilities", None) or {}
        row["facility_name"] = facility.get("name")
        row["facility_type"] = facility.get("type")
        row["contact"] = _mask_email(row.get("contact")) if "@" in str(row.get("contact") or "") else row.get("contact")
        items.append(row)
    return {"items": items}


# 증빙 서명 URL 수명. 심사자가 열어 보는 데 필요한 만큼만 — 링크가 새어도 곧 죽는다.
_DOCUMENT_URL_TTL_SECONDS = 300


@router.get("/verification-requests/{request_id}/document")
async def verification_document_url(request_id: str):
    """증빙 서류를 심사자에게 보여 주기 위한 **단기 서명 URL**.

    버킷은 비공개이고 신청자 본인만 자기 폴더를 읽을 수 있다(20260904200000 정책).
    심사자는 그 정책으로는 못 본다 — 여기서 service_role 로 서명 URL 을 만들어 전달한다.
    URL 을 응답에 실어 보내되 저장하지는 않는다(5분 뒤 죽는다).

    심사가 끝난 요청은 document_path 가 NULL 이다(clear_verification_evidence). 그때는 404 다 —
    "보관하지 않는다" 는 결정의 자연스러운 귀결이라 오류가 아니라 정상 상태다.
    """
    res = await asyncio.to_thread(
        supabase_admin.table("business_verification_requests")
        .select("document_path").eq("id", request_id).limit(1).execute
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="해당 요청을 찾을 수 없습니다.")
    path = res.data[0].get("document_path")
    if not path:
        raise HTTPException(status_code=404, detail="첨부된 증빙이 없습니다.")

    try:
        signed = await asyncio.to_thread(
            supabase_admin.storage.from_("business-documents").create_signed_url,
            path,
            _DOCUMENT_URL_TTL_SECONDS,
        )
    except Exception as exc:
        logger.warning("verification_document_sign_failed", request_id=request_id, error=str(exc))
        raise HTTPException(status_code=503, detail="증빙을 여는 데 실패했습니다.") from None

    url = (signed or {}).get("signedURL") or (signed or {}).get("signed_url")
    if not url:
        logger.warning("verification_document_sign_empty", request_id=request_id)
        raise HTTPException(status_code=503, detail="증빙을 여는 데 실패했습니다.")
    return {"url": url, "expires_in": _DOCUMENT_URL_TTL_SECONDS}


async def _require_active_facility(facility_id: str) -> None:
    """심사자가 고른 기존 가게가 실제로 있고 표출 중인지 확인한다.

    확인 없이 소유권을 붙이면 존재하지 않는(또는 폐업 처리된) POI 의 사장님이 만들어진다 —
    콘솔은 열리는데 관리할 대상이 없다. 조회 자체가 실패한 경우는 '없음'이 아니라 우리 쪽
    장애이므로 422 가 아니라 503 이다(없는 가게로 오인해 심사자가 다시 고르게 하면 안 된다).
    """
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("facilities")
            .select("id, is_active").eq("id", facility_id).limit(1).execute
        )
    except Exception as exc:
        logger.warning("verification_facility_lookup_failed", facility_id=facility_id, error=str(exc))
        raise HTTPException(status_code=503, detail="가게 정보를 확인하지 못했습니다.") from None
    row = (res.data or [None])[0]
    # is_active 칼럼이 없는 구 DB에서는 필드가 아예 없다 — '없음'을 '비활성'으로 읽지 않는다.
    if not row or row.get("is_active") is False:
        raise HTTPException(status_code=422, detail="선택한 가게를 찾을 수 없습니다.")


async def _create_facility_for_request(spec: NewFacilityInput, request_id: str) -> str:
    """미등록 가게를 승인 시점에 만든다. 새 facilities.id 를 돌려준다.

    features 에 출처를 남기는 이유: 이 행은 TourAPI/LocalData 검증을 **거치지 않았다.**
    사람이 신청서만 보고 만든 POI 라 좌표·업종·수용 인원 어느 것도 외부 출처로 대조되지
    않았다. 나중에 데이터 품질을 따질 때 이 행들을 구분하지 못하면 적재 파이프라인이 만든
    행과 뒤섞여 **전체 수치를 믿을 수 없게 된다.** 그래서 origin 과 신청서 id 를 박아 둔다.
    contentid/external_id 는 넣지 않는다 — 외부 출처가 없으니 비워 두는 게 사실이다.

    실패는 '가게 없음'으로 뭉뚱그리지 않고 503 으로 끊는다. 신청은 pending 그대로 남아
    심사자가 다시 승인할 수 있다.
    """
    capacity = spec.capacity if spec.capacity is not None else capacity_for(spec.type)
    payload: dict = {
        "name": spec.name,
        "type": spec.type,
        "latitude": spec.latitude,
        "longitude": spec.longitude,
        "capacity": capacity,
        "is_active": True,
        "operating_hours": {},
        "features": {
            "origin": "merchant_request",
            "verification_request_id": request_id,
            # 수용 인원의 근거. 심사자가 직접 적어 넣은 값을 업종 기본값이라고 적으면
            # 그 자체가 잘못된 품질 표시가 된다 — 두 경우를 다른 이름으로 남긴다.
            "capacity_evidence": (
                "synthetic_type_default" if spec.capacity is None else "merchant_request_input"
            ),
        },
    }
    # 없는 값을 빈 문자열로 채우지 않는다 — 주소가 없는 것과 ""는 다르다.
    if spec.address:
        payload["address"] = spec.address
    if spec.phone:
        payload["phone"] = spec.phone

    try:
        res = await asyncio.to_thread(supabase_admin.table("facilities").insert(payload).execute)
    except Exception as exc:
        logger.error("verification_facility_create_failed", request_id=request_id, error=str(exc))
        raise HTTPException(
            status_code=503, detail="가게를 등록하지 못했습니다. 신청은 그대로 두었습니다."
        ) from None

    facility_id = str(((res.data or [{}])[0] or {}).get("id") or "")
    if not facility_id:
        # insert 는 통과했는데 id 를 못 받은 경우. 여기서 계속 진행하면 소유권을 빈 id 에
        # 붙이게 되므로 같은 자리에서 끊는다(행이 남았을 수 있어 로그로 알린다).
        logger.error("verification_facility_create_no_id", request_id=request_id, name=spec.name)
        raise HTTPException(
            status_code=503, detail="가게를 등록하지 못했습니다. 신청은 그대로 두었습니다."
        )
    logger.info(
        "verification_facility_created",
        request_id=request_id, facility_id=facility_id, name=spec.name, type=spec.type,
    )
    return facility_id


async def _link_facility_to_request(request_id: str, facility_id: str) -> None:
    """새로 만든 가게를 **다른 어떤 쓰기보다 먼저** 신청서에 적는다.

    이 순서가 이 기능의 계약이다. 아래 소유권 부여가 실패하면 (옳게) 503 을 내고 요청을
    pending 으로 남긴다 — 심사자는 당연히 다시 승인을 누른다. 그때 신청서에 facility_id 가
    적혀 있지 않으면 **같은 이름의 가게가 한 번 더 만들어진다.** 재시도할수록 지도에 유령
    POI 가 쌓이고, 그중 어느 행에 소유권이 붙었는지 아무도 모르게 된다(둘 다 검증 없이
    만들어진 행이라 나중에 구분할 근거도 없다).

    이 약속은 혼자서는 성립하지 않는다. 신청서에 적어 두더라도 재승인이 그 값을 **읽어야**
    의미가 있어서, _resolve_facility 가 req.facility_id 를 body.new_facility 보다 먼저 보는
    것이 짝이다(그쪽 독스트링에 왜 그 순서인지 적었다). 한동안 순서가 반대여서 여기 적힌
    말이 사실이 아니었다 — 둘 중 하나만 고치면 다시 그렇게 된다.

    재시도 안전성이 이 코드의 유일한 회복 수단이므로, 갱신이 실패하면 진행하지 않고 503 으로
    끊는다. 그 경우 만들어진 가게 id 를 로그에 남긴다 — 연결되지 않은 행이라 사람이 지워야
    한다(자동 롤백은 하지 않는다: 지우는 쪽이 실패하면 같은 문제가 조용히 반복된다).
    """
    try:
        await asyncio.to_thread(
            supabase_admin.table("business_verification_requests")
            .update({"facility_id": facility_id}).eq("id", request_id).execute
        )
    except Exception as exc:
        logger.error(
            "verification_facility_link_failed",
            request_id=request_id, facility_id=facility_id, error=str(exc),
        )
        raise HTTPException(
            status_code=503,
            detail="가게는 등록했지만 신청에 연결하지 못했습니다. 다시 시도하기 전에 개발자에게 알려 주세요.",
        ) from None


async def _resolve_facility(
    request_id: str, req: dict, body: ReviewDecision
) -> tuple[str, bool]:
    """사업자 신청에 붙일 가게를 정한다. (facility_id, 새로 만들었는가) 를 돌려준다.

    순서가 곧 계약이다:

    1. body.facility_id — 심사자가 이번 승인에서 **명시적으로 고른** 정정. 신청자가 적어 보낸
       값보다 뒤에 있으면 화면에서 바로잡은 내용이 조용히 무시된다.
    2. req.facility_id — 신청서에 **이미 적힌** 가게. 여기가 body.new_facility 보다 앞이어야
       한다. 예전에는 반대였고, 그 때문에 _link_facility_to_request 의 독스트링이 약속한
       재시도 안전성이 실제로는 성립하지 않았다: 소유권 부여가 실패하면 503("신청은 그대로
       두었으니 다시 승인해 주세요")으로 끊기는데, 그 시점 신청은 pending + facility_id=F1
       이다. 프런트는 실패해도 목록을 다시 읽지 않아 화면 행은 여전히 facilityId=null 이고
       심사자의 선택({mode:'create'})도 남아 있다. 안내대로 다시 승인하면 본문에 new_facility
       가 또 실려 오고, 옛 순서는 신청서의 F1 을 **읽지도 않은 채** F2 를 만들었다. 소유권은
       F2 에 붙고 F1 은 같은 verification_request_id 를 단 유령 POI 로 지도에 남는다
       (facilities 에는 이름·좌표 유니크 제약이 없어 몇 번이고 쌓인다).
    3. body.new_facility — 미등록 가게를 이 승인에서 만들어 연결한다.

    2와 3이 동시에 오면 만들지 않고 409 로 되돌린다. 조용히 2를 쓰면 심사자는 자기가 입력한
    새 가게가 등록된 줄 알고, 조용히 3을 쓰면 유령 POI 가 다시 생긴다 — 둘 다 사후에
    구분할 근거가 없으므로, 화면이 낡았다는 사실 자체를 알리는 쪽이 맞다.
    """
    if body.facility_id:
        await _require_active_facility(body.facility_id)
        return body.facility_id, False

    existing = req.get("facility_id")
    if existing:
        if body.new_facility:
            raise HTTPException(
                status_code=409,
                detail="이 신청에는 이미 가게가 연결돼 있습니다. 화면을 새로 고친 뒤 다시 승인해 주세요.",
            )
        # 다른 갈래와 **같은 검사**를 받는다. 이 갈래만 검사가 없어서, 비활성(폐업 처리된)
        # POI 에 소유권이 붙었다 — 사장님 콘솔은 열리는데 손님에게는 한 번도 추천되지 않는
        # 막다른 계정이 된다. 게다가 이 값은 신청자가 적어 보낸 값이라 더더욱 그냥 못 쓴다.
        await _require_active_facility(str(existing))
        return str(existing), False

    if body.new_facility:
        facility_id = await _create_facility_for_request(body.new_facility, request_id)
        # 만든 직후, 다른 어떤 쓰기보다 먼저. 이유는 _link_facility_to_request 참조.
        await _link_facility_to_request(request_id, facility_id)
        return facility_id, True

    # 여기까지 왔으면 연결할 가게가 없다. 예전 문구("먼저 시설을 매핑하세요")는 존재하지
    # 않는 화면을 가리켰다 — 매핑 수단이 없어 승인이 영영 불가능했다. 지금은 두 길이 있다.
    raise HTTPException(
        status_code=409,
        detail="가게가 연결되지 않았습니다. 기존 가게를 연결하거나 새 가게로 등록해 주세요.",
    )


@router.post("/verification-requests/{request_id}/approve")
async def approve_verification(
    request_id: str, body: ReviewDecision, actor: dict = Depends(get_current_profile)
):
    # 가게를 연결하는 두 길은 **배타적**이다. 하나를 조용히 이기게 하면 심사자는 새 가게를
    # 만들었다고 믿는데 실제로는 기존 가게에 소유권이 붙는(또는 그 반대) 일이 생긴다.
    # 어떤 쓰기보다도 먼저 막는다 — 잘못된 입력이지 우리 쪽 장애가 아니므로 422 다.
    if body.facility_id and body.new_facility:
        raise HTTPException(status_code=422, detail="가게를 연결할 방법을 하나만 고르세요.")

    res = await asyncio.to_thread(
        supabase_admin.table("business_verification_requests")
        .select("*").eq("id", request_id).limit(1).execute
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="해당 요청을 찾을 수 없습니다.")
    req = res.data[0]
    if req.get("status") != "pending":
        raise HTTPException(status_code=409, detail="이미 심사가 끝난 요청입니다.")

    # 컬럼이 없는 DB(마이그레이션 미적용)에서는 전부 사업자 신청이다 — 기존 동작 그대로.
    requested_role = str(req.get("requested_role") or "merchant")
    if requested_role not in REVIEWABLE_ROLES:
        raise HTTPException(status_code=409, detail="신청 역할을 알 수 없어 승인할 수 없습니다.")

    # 가게 매핑은 **사업자 신청에만** 필요하다. 관리자 신청은 다루는 가게가 없다.
    if requested_role != "merchant" and (body.facility_id or body.new_facility):
        # 조용히 무시하면 심사자는 자기가 가게를 연결했다고 믿는다. 관리자에게는 붙일 곳이
        # 없으니 그 믿음을 정정하는 게 맞다.
        raise HTTPException(
            status_code=422, detail="관리자 신청에는 가게를 연결하지 않습니다."
        )

    # 사업자 신청이면 여기서 가게가 정해진다(필요하면 새로 만들고 신청서에 적는다).
    # 아래 역할 갱신보다 **먼저** 하는 이유: 새 가게를 만든 뒤의 첫 쓰기는 신청서 연결이어야
    # 재시도가 안전하다(_link_facility_to_request 참조).
    facility_id: str | None = None
    created_facility = False
    if requested_role == "merchant":
        facility_id, created_facility = await _resolve_facility(request_id, req, body)

    user_id = str(req["user_id"])
    # 아래 상태 갱신이 document_path 를 NULL 로 만들기 때문에 지금 붙잡아 둔다.
    document_path = req.get("document_path")
    reason = f"{'사업자 인증' if requested_role == 'merchant' else '관리자 권한'} 승인"

    role_res = await asyncio.to_thread(
        supabase_admin.table("users").select("role").eq("id", user_id).limit(1).execute
    )
    before_role = str((role_res.data or [{}])[0].get("role") or "tourist")
    # developer 는 절대 내리지 않는다. merchant↔admin 은 상하 관계가 아니라 **다른 축**이므로
    # (admin 은 사장님 콘솔에 못 들어간다) 심사자가 승인한 쪽으로 그대로 바꾼다 — 감사 로그에
    # 남고 /dev 콘솔에서 언제든 되돌릴 수 있다.
    if before_role != ROLE_DEVELOPER and before_role != requested_role:
        await asyncio.to_thread(
            supabase_admin.table("users").update({"role": requested_role}).eq("id", user_id).execute
        )
        log_role_audit(
            actor_id=actor["id"], target_id=user_id, action="role_change",
            from_value=before_role, to_value=requested_role, reason=reason,
        )

    if requested_role == "merchant":
        try:
            await asyncio.to_thread(
                supabase_admin.table("facility_owners").insert({
                    "facility_id": facility_id,
                    "user_id": user_id,
                    "granted_by": actor["id"],
                    "verification_request_id": request_id,
                }).execute
            )
            log_role_audit(
                actor_id=actor["id"], target_id=user_id, action="owner_grant",
                to_value=str(facility_id), reason=reason,
            )
        except Exception as exc:
            # 이미 소유자면 승인 자체는 계속 진행한다(재심사·중복 신청 흡수).
            if not _is_duplicate_owner(exc):
                # 그 밖의 실패로 계속 진행하면 **소유권 없는 사업자**가 만들어진다:
                # role 은 merchant 라 콘솔에는 들어가지는데 모든 요청이 403 "내 가게가
                # 아닙니다" 이고, 요청은 approved 라 다시 심사할 수도 없다. 증빙까지 아래에서
                # 지워지므로 되돌릴 근거도 사라진다.
                #
                # 그래서 상태 갱신 **전에** 멈춘다. 요청이 pending 으로 남으면 심사자가 다시
                # 승인하면 되고, 역할 갱신은 멱등이라(위에서 before_role 비교) 재시도가 안전하다.
                # 새로 만든 가게도 이미 신청서에 적혀 있어(_link_facility_to_request) 재승인
                # 때 중복 생성되지 않는다 — 그 순서가 여기서 값을 한다.
                # 아래 '증빙 삭제는 상태 갱신 뒤에' 와 같은 이유의 순서 판단이다.
                logger.error(
                    "verification_owner_grant_failed", request_id=request_id, error=str(exc)
                )
                raise HTTPException(
                    status_code=503,
                    detail="가게 소유권 부여에 실패했습니다. 신청은 그대로 두었으니 다시 승인해 주세요.",
                ) from None
            logger.warning("verification_owner_insert_skipped", request_id=request_id, error=str(exc))

    # 증빙 삭제는 **상태 갱신 뒤**에 한다. 먼저 지우면 갱신이 실패했을 때 요청이 pending 인
    # 채로 증빙만 사라져 다시 심사할 수 없다(document_path 는 이미 없는 파일을 가리킨다).
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
    # 경로는 갱신 **전에** 읽어 둔 값을 넘긴다(갱신이 document_path 를 NULL 로 만든다).
    await clear_verification_evidence(request_id, document_path)
    invalidate_profile_cache(user_id)
    log_role_audit(
        actor_id=actor["id"], target_id=user_id, action="verification_review",
        to_value="approved", reason=body.reason,
    )
    return {
        "approved": True,
        "user_id": user_id,
        # 관리자 승인은 None 이다 — 다루는 가게가 없다는 사실을 0/"" 로 뭉개지 않는다.
        "facility_id": facility_id,
        "requested_role": requested_role,
        # 화면이 "새 가게를 등록했습니다" 를 말할 수 있어야 한다. 심사자가 방금 무엇을
        # 만들었는지 모른 채 목록으로 돌아가면 중복 등록을 알아차릴 방법이 없다.
        "created_facility": created_facility,
    }


@router.post("/verification-requests/{request_id}/reject")
async def reject_verification(
    request_id: str, body: RejectDecision, actor: dict = Depends(get_current_profile)
):
    res = await asyncio.to_thread(
        supabase_admin.table("business_verification_requests")
        .select("user_id, status, document_path").eq("id", request_id).limit(1).execute
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="해당 요청을 찾을 수 없습니다.")
    if res.data[0].get("status") != "pending":
        raise HTTPException(status_code=409, detail="이미 심사가 끝난 요청입니다.")
    # 승인과 같은 이유로 갱신 전에 붙잡아 둔다.
    document_path = res.data[0].get("document_path")

    # 승인과 같은 이유로 상태 갱신이 먼저다(증빙을 잃고 pending 에 갇히는 것을 막는다).
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
    await clear_verification_evidence(request_id, document_path)
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


# =========================================================================
# 최근 실패 (진단)
# =========================================================================
@router.get("/failures")
async def list_recent_failures(limit: int = 50):
    """이 프로세스에서 최근에 난 실패를 돌려준다.

    Render 로그에 접근하기 어려울 때 프로덕션 예외의 정체를 확인하는 통로다.
    인메모리라 재시작하면 사라지고, 워커가 여럿이면 이 워커 것만 보인다.
    """
    return {"items": recent_failures(min(limit, 50))}
