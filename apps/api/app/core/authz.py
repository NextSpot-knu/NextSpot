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

## 세션이 없는 호출자 — 기계는 예외다

스케줄러(GitHub Actions, Supabase pg_cron)는 Supabase 세션을 가질 수 없다. 이들에게는
`require_machine_or_role` 로 공유 토큰 경로를 **딱 필요한 엔드포인트에만** 남긴다.
폐지한 것과 다른 점이 중요하다: 폐지된 X-Admin-Authorization 은 브라우저 번들에 토큰이
박혀 있어 누구나 관리자 API 전체를 쓸 수 있었다. 여기 토큰은 프런트에 절대 나가지 않고,
서버 대 서버 한 경로(수집 트리거)에만 유효하다.

## 역할 판정은 DB 조회 + 짧은 캐시

JWT 커스텀 클레임(Auth Hook)을 쓰지 않는다. 토큰 갱신(최대 1시간)까지 구 역할이 남으면
**권한 회수가 늦어지기** 때문이다 — 오염 방송을 즉시 끊는 게 더 중요하다.
대신 30초 TTL 캐시를 두고, 임명/회수 API 가 해당 사용자 캐시를 즉시 무효화한다.
"""
import asyncio
import hmac
import time

import structlog
from fastapi import Depends, HTTPException, Request, status

from app.core.config import settings
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
        return {"role": ROLE_TOURIST, "facility_ids": frozenset(), "degraded": True}

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
            # 빈 집합은 '가진 가게가 없다' 와 **똑같은 값**이다. 그래서 조회가 실패했을 뿐인데
            # 사장님이 자기 가게에 403 "내 가게가 아닙니다" 를 받는다. 이번 요청을 막는 것
            # 자체는 맞다(fail-closed) — 문제는 이 값이 캐시에 들어가 30초를 가는 것이다.
            logger.warning("authz_ownership_lookup_failed", user_id=user_id, error=str(exc))
            return {"role": role, "facility_ids": facility_ids, "degraded": True}
    return {"role": role, "facility_ids": facility_ids}


# 역할을 읽지 못했을 때 돌려줄 문구. 고정 상수다 — 예외 메시지를 그대로 싣지 않는다
# (드라이버 예외에는 URL·헤더 조각이 섞여 들어올 수 있다).
_PROFILE_UNAVAILABLE_DETAIL = "권한 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요."


async def _build_profile(user_id: str, email: str | None, payload: dict) -> dict:
    """캐시를 거쳐 role·소유 가게를 붙인 프로필을 만든다.

    조회가 실패하면 프로필을 만들지 않고 **503** 을 던진다. 예전에는 tourist + 빈 소유 집합을
    그대로 돌려줬는데, 그 값은 '권한이 없다' 와 글자 하나 다르지 않아서 우리 쪽 장애가
    사용자에게 **권한 문제로 둔갑**했다. 실제로 나가던 응답이 이랬다:
      · 관리자 → 403 "이 기능에 접근할 권한이 없습니다."
      · 사장님 → 403 "내 가게가 아닙니다."  (소유권 조회만 실패해도)
      · GET /account/me → 200 role="tourist"  ← 가장 나쁘다. 오류가 아니어서 프런트가
        재시도하지도 않고, 화면이 조용히 관광객 모드로 내려앉는다(심사 중이면 '미완성' 이다).
    503 이면 셋 다 "잠시 후 다시" 가 되고, 프런트(lib/account.tsx)는 401 이 아닌 실패를
    알던 계정을 유지한 채 2.5초 뒤 한 번 재시도한다 — 콜드 스타트가 정확히 이 모양이다.

    막는 것 자체는 그대로다(fail-closed). 바뀐 것은 **거부의 이유를 정직하게 말하는 것**뿐이다.
    """
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
                # 조회에 실패해서 만든 프로필은 캐시하지 않는다. 실패값은 '권한 없음' 과
                # 구분되지 않으므로, 캐시에 넣으면 커넥션 한 번 끊긴 대가로 30초 동안
                # 사장님이 자기 콘솔에서 잠긴다 — 다음 요청이 다시 물어보게 둔다.
                # (프런트에서 같은 모양의 버그를 이미 겪었다: lib/account.tsx 의 sticky null)
                if not loaded.get("degraded"):
                    _profile_cache[user_id] = (time.monotonic() + _PROFILE_TTL_SECONDS, loaded)
    if loaded.get("degraded"):
        # 위 독스트링 참조. 여기서 끊어야 '역할 없음' 이 호출부로 흘러가지 않는다.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=_PROFILE_UNAVAILABLE_DETAIL,
        )
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
    """요청에서 직접 프로필을 만든다. 토큰이 없거나 **인증에 실패하면** None.

    이행기 동안 레거시 공유 토큰 경로와 JWT 경로가 한 엔드포인트에 공존하므로,
    "토큰이 없다" 를 즉시 실패로 만들지 않고 호출부가 판단하게 한다.

    ⚠️ None 은 "이 요청은 인증되지 않았다" 만 뜻한다. 호출부(merchant_context,
    require_machine_or_role)는 None 을 보면 **무조건 401** 로 바꾼다 — 그러므로 401 이 아닌
    실패를 None 으로 뭉개면 안 된다. verify_supabase_token 은 JWKS 를 읽지 못할 때 503 을
    던지는데(콜드 스타트 첫 요청·Supabase Auth 장애), 예전 코드는 HTTPException 을 통째로
    삼켜 그 503 까지 401 로 바꿨다. 프런트는 401 을 '아직 로그인 전' 으로 읽고 재시도 없이
    게스트로 떨어지므로(lib/api-client.ts AuthError, lib/account.tsx), 서버가 잠깐 못 읽은
    것이 **사장님이 로그아웃당한 것**으로 보인다. 인증 실패가 아닌 것은 그대로 올려보낸다.
    """
    token = _extract_bearer(request)
    if not token:
        return None
    try:
        # 동기 함수다 — JWKS 콜드 페치가 최대 4.2초 걸린다(app/core/supabase.py 상수).
        # async 의존성에서 직접 부르면 그 시간 동안 이벤트 루프가 통째로 멈춰, 콜드 스타트
        # 첫 요청 하나가 같은 워커의 다른 모든 요청을 함께 지연시킨다.
        payload = await asyncio.to_thread(verify_supabase_token, token)
    except HTTPException as exc:
        if exc.status_code == status.HTTP_401_UNAUTHORIZED:
            return None
        raise
    user_id = payload.get("sub")
    if not user_id:
        return None
    return await _build_profile(str(user_id), payload.get("email"), payload)


def assert_role(profile: dict, *allowed: str) -> None:
    """프로필이 허용 역할인지 검사한다(의존성이 아닌 함수 형태 — require_role 과 같은 규칙)."""
    role = profile["role"]
    # 익명 세션은 tourist 외 어떤 역할도 가질 수 없다 — 단말에 묶여 있고 신원 확인이 불가능하다.
    # 이 검사가 developer 조기 통과보다 **앞에** 있어야 한다. 뒤에 두면 가장 강한 역할만
    # 이 규칙을 비껴간다. 게스트 uid 에 실수로 developer 를 찍는 일은 실제로 가능하다 —
    # /dev 콘솔이 uid 정확일치로는 게스트도 찾아 주기 때문이다.
    if profile["is_anonymous"] and role != ROLE_TOURIST:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="게스트 세션으로는 사용할 수 없습니다. 계정으로 로그인해 주세요.",
        )
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


# ── 기계(machine-to-machine) 인증 ─────────────────────────────────────────────
# 스케줄러는 사람 계정이 없다. 세션 대신 공유 토큰을 제시하고, 그 토큰은 프런트로 절대
# 나가지 않는다(config.MACHINE_API_TOKEN 주석 참고).

def _machine_token_from_request(request: Request) -> str | None:
    """기계 호출자가 제시한 공유 토큰을 꺼낸다.

    X-Service-Token 이 이 용도의 정식 헤더다. X-Admin-Authorization 은 이미 배포된
    호출자(Actions 워크플로, pg_cron 마이그레이션)가 쓰고 있어 함께 받는다 — 이 헤더가
    사람용 인증으로 다시 쓰이는 일은 없다(라우터가 이 가드를 건 경로에서만 읽는다).
    """
    direct = (request.headers.get("x-service-token") or "").strip()
    if direct:
        return direct
    value = request.headers.get("x-admin-authorization") or ""
    if value.startswith("Bearer "):
        return value.split(" ", 1)[1].strip() or None
    return None


def is_machine_caller(request: Request) -> bool:
    """유효한 기계 토큰을 제시했는가. 비교는 타이밍 공격에 안전하게 한다."""
    presented = _machine_token_from_request(request)
    if not presented:
        return False
    expected = settings.MACHINE_API_TOKEN
    if not expected:
        return False
    return hmac.compare_digest(presented, expected)


def require_machine_or_role(*allowed: str):
    """기계 토큰 **또는** 지정 역할을 통과시키는 의존성.

    수집 트리거처럼 스케줄러와 사람이 함께 두드리는 엔드포인트에 쓴다. 사람 경로는
    require_role 과 완전히 같은 규칙을 따른다(익명 거부, developer 통과 포함).
    반환값은 사람이면 프로필, 기계면 None 이다.
    """
    allowed_set = frozenset(allowed)

    async def _guard(request: Request) -> dict | None:
        if is_machine_caller(request):
            return None
        profile = await load_profile_from_request(request)
        if profile is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="인증이 필요합니다. 로그인하거나 서비스 토큰을 제시해 주세요.",
                headers={"WWW-Authenticate": "Bearer"},
            )
        assert_role(profile, *allowed_set)
        return profile

    return _guard
