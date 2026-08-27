"""역할 기반 접근 제어(RBAC) — 사장님 콘솔·관리자 대시보드·개발자 콘솔의 단일 가드.

계획: docs/MERCHANT_CONSOLE_RBAC_PLAN.md (로컬 전용)

## 무엇을 대체하는가

기존에는 세 앱이 서로 다른 인증을 썼다:
  · 관광객 — Supabase JWT (실제 인증)
  · 사장님 — X-Merchant-Token 공유 토큰 (데모 게이트)
  · 관리자 — X-Admin-Authorization 공유 토큰 (데모 게이트)

뒤 둘은 비밀번호가 프런트 번들에 들어가는 클라이언트 게이트라 실제 보안 경계가 아니었다.
이제 셋 다 **Supabase JWT + public.users.role** 하나로 통일한다.

## 소유권은 역할과 별개다

`merchant` 역할은 "콘솔에 들어갈 수 있다"만 뜻한다. **어느 가게를 다루는가**는
`facility_owners` 가 정한다. `require_facility_owner` 가 그 검사다 — 이게 없으면
누구나 아무 가게의 좌석 상태를 방송할 수 있고, 그 방송은 `evidence_tier='verified'` 로
학습 데이터에 들어간다(CONGESTION_TRUST_SPEC).

## 역할 판정은 DB 조회 + 짧은 캐시

JWT 커스텀 클레임(Auth Hook)을 쓰지 않는다. 토큰 갱신(최대 1시간)까지 구 역할이 남으면
**권한 회수가 늦어지기** 때문이다 — 오염 방송을 즉시 끊는 게 더 중요하다.
대신 30초 TTL 캐시를 두고, 임명/회수 API 가 해당 사용자 캐시를 즉시 무효화한다.
"""
import asyncio
import time

import structlog
from fastapi import Depends, HTTPException, Request, status

from app.core.supabase import get_current_user, supabase_admin, verify_supabase_token

logger = structlog.get_logger()

# 역할 값(public.users.role CHECK 와 동일 집합).
ROLE_TOURIST = "tourist"
ROLE_MERCHANT = "merchant"
ROLE_ADMIN = "admin"
ROLE_DEVELOPER = "developer"
VALID_ROLES = (ROLE_TOURIST, ROLE_MERCHANT, ROLE_ADMIN, ROLE_DEVELOPER)

# 역할 조회 캐시 수명. 짧게 잡는 이유는 위 모듈 주석 참조(회수 즉시성 > 조회 절감).
_PROFILE_TTL_SECONDS = 30.0

# {user_id: (expires_at, profile)}
_profile_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = asyncio.Lock()


def invalidate_profile_cache(user_id: str | None = None) -> None:
    """역할·소유권이 바뀌면 호출한다. user_id 가 없으면 전체를 비운다.

    임명/회수 API 가 응답을 돌려주기 전에 반드시 부른다 — 안 부르면 최대 30초 동안
    구 권한으로 요청이 통과한다.
    """
    if user_id is None:
        _profile_cache.clear()
    else:
        _profile_cache.pop(user_id, None)


async def _load_profile(user_id: str) -> dict:
    """public.users 의 role 과 활성 소유 가게를 읽는다(service_role — RLS 우회)."""
    role = ROLE_TOURIST
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("users").select("role").eq("id", user_id).limit(1).execute
        )
        if res.data:
            candidate = str(res.data[0].get("role") or ROLE_TOURIST)
            # 알 수 없는 값이면 최소 권한으로 떨어뜨린다(fail-closed).
            role = candidate if candidate in VALID_ROLES else ROLE_TOURIST
    except Exception as exc:
        # 프로필 조회 실패를 '권한 있음' 으로 오인하지 않는다. tourist 로 두면
        # 콘솔 접근은 막히고 관광객 기능은 그대로 동작한다(무해 폴백).
        logger.warning("authz_profile_lookup_failed", user_id=user_id, error=str(exc))
        return {"role": ROLE_TOURIST, "facility_ids": frozenset()}

    facility_ids: frozenset[str] = frozenset()
    # 소유권 조회는 콘솔을 쓸 수 있는 역할에만 필요하다 — 관광객 요청마다 표를 두드리지 않는다.
    if role in (ROLE_MERCHANT, ROLE_DEVELOPER):
        try:
            owned = await asyncio.to_thread(
                supabase_admin.table("facility_owners")
                .select("facility_id")
                .eq("user_id", user_id)
                .is_("revoked_at", "null")
                .execute
            )
            facility_ids = frozenset(
                str(row["facility_id"]) for row in (owned.data or []) if row.get("facility_id")
            )
        except Exception as exc:
            logger.warning("authz_ownership_lookup_failed", user_id=user_id, error=str(exc))
    return {"role": role, "facility_ids": facility_ids}


async def _build_profile(user_id: str, email: str | None, payload: dict) -> dict:
    """캐시를 거쳐 role·소유 가게를 붙인 프로필을 만든다."""
    cached = _profile_cache.get(user_id)
    if cached and cached[0] > time.monotonic():
        loaded = cached[1]
    else:
        async with _cache_lock:
            # 락 안에서 다시 확인 — 동시 요청이 같은 조회를 중복 실행하지 않게(single-flight).
            cached = _profile_cache.get(user_id)
            if cached and cached[0] > time.monotonic():
                loaded = cached[1]
            else:
                loaded = await _load_profile(user_id)
                _profile_cache[user_id] = (time.monotonic() + _PROFILE_TTL_SECONDS, loaded)
    return {
        "id": user_id,
        "email": email,
        # 익명 세션은 상위 역할을 가질 수 없다(단말에 묶여 있고 신원 확인이 불가능).
        "is_anonymous": bool(payload.get("is_anonymous")),
        "role": loaded["role"],
        "facility_ids": loaded["facility_ids"],
    }


async def get_current_profile(current_user: dict = Depends(get_current_user)) -> dict:
    """JWT 검증 결과에 role·소유 가게를 붙인다(일반 FastAPI 의존성 경로).

    반환: {id, email, is_anonymous, role, facility_ids}
    """
    return await _build_profile(
        current_user["id"], current_user.get("email"), current_user.get("payload") or {}
    )


def _extract_bearer(request: Request) -> str | None:
    """Authorization / 프록시 경유 헤더에서 Bearer 토큰을 꺼낸다.

    get_current_user 와 같은 헤더 우선순위를 따르되, **의존성 주입 없이** 호출할 수 있어야
    하는 경로(레거시 토큰과 JWT 를 한 엔드포인트에서 함께 받는 이행기)를 위해 따로 둔다.
    """
    for header in ("x-forwarded-authorization", "x-supabase-authorization", "authorization"):
        value = request.headers.get(header) or ""
        if value.startswith("Bearer "):
            token = value.split(" ", 1)[1].strip()
            if token:
                return token
    return None


async def load_profile_from_request(request: Request) -> dict | None:
    """요청에서 직접 프로필을 만든다. 토큰이 없거나 무효면 None(401 을 던지지 않는다).

    이행기 동안 레거시 공유 토큰 경로와 JWT 경로가 한 엔드포인트에 공존하므로,
    "토큰이 없다" 를 즉시 실패로 만들지 않고 호출부가 판단하게 한다.
    """
    token = _extract_bearer(request)
    if not token:
        return None
    try:
        payload = verify_supabase_token(token)
    except HTTPException:
        return None
    user_id = payload.get("sub")
    if not user_id:
        return None
    return await _build_profile(str(user_id), payload.get("email"), payload)


def assert_role(profile: dict, *allowed: str) -> None:
    """프로필이 허용 역할인지 검사한다(의존성이 아닌 함수 형태 — require_role 과 같은 규칙)."""
    role = profile["role"]
    if role == ROLE_DEVELOPER:
        return
    if role not in frozenset(allowed):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="이 기능에 접근할 권한이 없습니다.",
        )
    if profile["is_anonymous"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="게스트 세션으로는 사용할 수 없습니다. 계정으로 로그인해 주세요.",
        )


def require_role(*allowed: str):
    """지정한 역할만 통과시키는 의존성. developer 는 항상 통과한다.

    익명 세션은 tourist 외 어떤 역할도 될 수 없으므로, 상위 역할을 요구하는 경로에서 거부한다.
    """
    allowed_set = frozenset(allowed)

    async def _guard(profile: dict = Depends(get_current_profile)) -> dict:
        assert_role(profile, *allowed_set)
        return profile

    return _guard


def owns_facility(profile: dict, facility_id: str) -> bool:
    """이 사용자가 해당 가게를 다룰 수 있는가.

    developer 만 소유권을 우회한다. **admin 은 우회하지 않는다** — 관리자 대시보드와
    사장님 콘솔은 완전히 분리한다는 결정이다(관리자는 /merchant 에 tourist 와 동일하게 취급).
    """
    if profile["role"] == ROLE_DEVELOPER:
        return True
    return str(facility_id) in profile["facility_ids"]


def require_facility_owner(profile: dict, facility_id: str) -> None:
    """소유권 검사. 실패하면 403 — 존재 여부를 흘리지 않도록 404 와 구분하지 않는다."""
    if not owns_facility(profile, facility_id):
        logger.warning(
            "merchant_facility_ownership_denied",
            user_id=profile["id"],
            role=profile["role"],
            facility_id=facility_id,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="내 가게가 아닙니다.",
        )


async def require_merchant_console_enabled() -> None:
    """사고 시 콘솔 전체를 즉시 닫는 스위치(system_settings.merchant_console_enabled).

    설정 조회 자체가 실패하면 **열어 둔다** — 설정 표 장애로 정상 사장님을 막는 것이
    더 나쁘다. 차단은 운영자가 명시적으로 FALSE 를 넣었을 때만 일어난다.
    """
    try:
        res = await asyncio.to_thread(
            supabase_admin.table("system_settings")
            .select("merchant_console_enabled")
            .eq("id", 1)
            .limit(1)
            .execute
        )
    except Exception as exc:
        logger.warning("merchant_console_flag_unavailable", error=str(exc))
        return
    rows = res.data or []
    if rows and rows[0].get("merchant_console_enabled") is False:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="사장님 콘솔이 일시 중단되었습니다. 잠시 후 다시 시도해 주세요.",
        )


def log_role_audit(
    *,
    actor_id: str | None,
    target_id: str,
    action: str,
    from_value: str | None = None,
    to_value: str | None = None,
    reason: str | None = None,
) -> None:
    """권한 변경 감사 기록. 실패해도 주 작업을 되돌리지 않되 경고로 남긴다.

    (삭제 API 는 만들지 않는다 — 감사 로그는 지워지지 않아야 의미가 있다.)
    """
    try:
        supabase_admin.table("role_audit_log").insert(
            {
                "actor_id": actor_id,
                "target_id": target_id,
                "action": action,
                "from_value": from_value,
                "to_value": to_value,
                "reason": reason,
            }
        ).execute()
    except Exception as exc:
        logger.error(
            "role_audit_log_write_failed",
            actor_id=actor_id, target_id=target_id, action=action, error=str(exc),
        )
