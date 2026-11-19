"""서비스 지역(region) — 경주는 공개, 서울은 내부(개발자) 전용.

`docs/SEOUL_TESTBED_PLAN.md` S3. 서울은 **역할이 developer 인 계정만** 볼 수 있는 두 번째 지역이다.
관리자(admin)는 외부 정부 관제 역할이고 심사위원이 함께 쓰는 계정도 admin 이라 서울을 보지 않는다.
관광객·사장님·게스트도 마찬가지다.

## 격리의 두 겹
  · DB — `facilities` 의 RESTRICTIVE 정책(`facilities_public_region_only`)이 브라우저 역할(anon·authenticated)에
    region='gyeongju' 행만 보여 준다. service_role 은 RLS 를 우회하므로 아래가 필요하다.
  · API — service_role 로 시설을 읽는 곳은 **쿼리 안에서** region 을 건다(`apply_region` · `run_region_scoped`).
    읽은 뒤 dict 로 거르는 방식은 쓰지 않는다. 키가 없는 행(`facility_region(row) is None`)은 공개가 아니다.

## 요청의 지역은 서버가 정한다
웹은 서울 모드일 때만 `X-NextSpot-Region: seoul` 헤더를 보낸다. 서버는 그 헤더를 **믿지 않고** DB 의 역할로
다시 판정한다(`resolve_request_region`). 헤더가 없으면 I/O 0회로 경주다 — 경주 경로는 이 모듈이 생기기 전과
글자 하나 다르지 않게 돈다.

## 컬럼이 아직 없을 때(배포 순서)
API 가 마이그레이션보다 먼저 나가면 region 컬럼이 없어 42703 이 난다. 그때 경주는 필터 없이 다시 읽고
(`facilities_region_column_missing_fallback` 경고), 다른 지역은 빈 결과다 — 순서가 틀려도 경주는 멀쩡하고
서울만 비어 보인다.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from typing import Any, TypeVar

import structlog
from fastapi import Depends, HTTPException, Request, status

from app.core import authz

logger = structlog.get_logger()

PUBLIC_REGION = "gyeongju"
REGION_SEOUL = "seoul"
# 내부 계정만 볼 수 있는 지역.
INTERNAL_REGIONS: frozenset[str] = frozenset({REGION_SEOUL})
# 구역 혼잡(zone_crowd_snapshots)을 근거로 쓰는 지역. 경주는 여기에 없다 — 경주 경로는 구역 표를 읽지 않는다.
ZONE_EVIDENCE_REGIONS: frozenset[str] = frozenset({REGION_SEOUL})
KNOWN_REGIONS: frozenset[str] = frozenset({PUBLIC_REGION}) | INTERNAL_REGIONS

REGION_HEADER = "X-NextSpot-Region"
# /health 의 capabilities.region_isolation. region-guard 워크플로가 이 값이 1 이상인지 본다
# (없으면 지역 격리를 모르는 구 API 가 떠 있다는 뜻 → 서울 행을 끈다).
REGION_ISOLATION_VERSION = 1

# 내부 지역을 볼 수 있는 역할 — developer 하나(2026-10-31 사용자 결정). admin 은 외부 관제 역할이고
# 심사용 공유 계정(authz.JUDGE_ADMIN_EMAIL)도 admin 이라 넣지 않는다. 환경변수로 넓힐 수 없게 상수로 둔다.
INTERNAL_REGION_VIEWER_ROLES: frozenset[str] = frozenset({authz.ROLE_DEVELOPER})

_FORBIDDEN_DETAIL = "이 기능에 접근할 권한이 없습니다."

T = TypeVar("T")


def apply_region(query: Any, region: str) -> Any:
    """PostgREST 쿼리에 지역 필터를 건다. 시설 읽기의 단일 표기(구조 검사가 이 이름을 찾는다)."""
    return query.eq("region", region)


def facility_region(row: Mapping[str, Any] | None) -> str | None:
    """시설 행의 지역. 키가 없거나 비었으면 None — **None 은 공개가 아니다**(fail-closed).

    경주로 간주하는 곳은 컬럼이 없는 42703 분기(`run_region_scoped`) 하나뿐이다.
    """
    if not isinstance(row, Mapping):
        return None
    value = row.get("region")
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def is_public_facility(row: Mapping[str, Any] | None) -> bool:
    return facility_region(row) == PUBLIC_REGION


def normalize_region(value: Any) -> str | None:
    """알려진 지역 이름이면 소문자로, 아니면 None."""
    text = str(value or "").strip().lower()
    return text if text in KNOWN_REGIONS else None


def is_missing_region_column(exc: BaseException) -> bool:
    """facilities.region 컬럼이 아직 없는가(PostgREST 42703 + 메시지에 region).

    is_active 등 다른 컬럼의 42703 과 구분한다 — 그쪽은 각자의 폴백이 있고, 여기서 삼키면 안 된다.
    """
    code = str(getattr(exc, "code", "") or "")
    message = str(getattr(exc, "message", None) or exc).lower()
    if "region" not in message:
        return False
    return code == "42703" or ("column" in message and "does not exist" in message)


def run_region_scoped(make_query: Callable[[bool], T], *, region: str) -> T | list:
    """지역 필터를 건 읽기를 실행한다(동기 — async 경로에서는 to_thread 안에서 부르거나 `arun_region_scoped`).

    ``make_query(True)`` 는 지역 필터를 건 읽기를 실행해 결과(대개 행 목록)를 돌려준다. region 컬럼이 없어
    42703 이 나면:
      · 경주 → ``make_query(False)`` 로 필터 없이 다시 읽는다(컬럼이 없으면 모든 행이 경주다).
      · 그 밖의 지역 → ``[]``(그 지역 행이 존재할 수 없다).
    다른 오류는 그대로 올린다.
    """
    try:
        return make_query(True)
    except Exception as exc:
        if not is_missing_region_column(exc):
            raise
        if region != PUBLIC_REGION:
            logger.warning("facilities_region_column_missing_internal_empty", region=region)
            return []
        logger.warning("facilities_region_column_missing_fallback", region=region)
        return make_query(False)


async def arun_region_scoped(make_query: Callable[[bool], T], *, region: str) -> T | list:
    """`run_region_scoped` 의 async 짝 — 동기 읽기를 워커 스레드에서 돌린다."""
    return await asyncio.to_thread(run_region_scoped, make_query, region=region)


def can_view_internal_regions(profile: Mapping[str, Any] | None) -> bool:
    """이 계정이 내부 지역(서울)을 볼 수 있는가 — **단일 판정점**.

    역할이 developer 이고 게스트(익명 세션)가 아니어야 한다. admin·merchant·tourist 는 언제나 False.
    """
    if not isinstance(profile, Mapping):
        return False
    if profile.get("is_anonymous"):
        return False
    return str(profile.get("role") or "") in INTERNAL_REGION_VIEWER_ROLES


def requested_region(request: Request) -> str | None:
    """요청 헤더가 **내부 지역**을 달라고 하면 그 이름, 아니면 None(경주·빈 값·모르는 값 모두)."""
    raw = request.headers.get(REGION_HEADER)
    if not raw:
        return None
    region = normalize_region(raw)
    return region if region in INTERNAL_REGIONS else None


async def resolve_request_region(request: Request, current_user: Mapping[str, Any] | None) -> str:
    """이 요청이 쓸 지역. 헤더는 요청일 뿐이고 결정은 DB 역할로 한다.

      · 헤더 없음·빈 값·'gyeongju'·모르는 값 → 경주, **I/O 없음**.
      · 내부 지역 헤더 + 사용자 없음 → 경주.
      · 내부 지역 헤더 + 프로필(30초 캐시)이 `can_view_internal_regions` → 그 지역(info 로그).
      · 그 밖 → 경주(info 로그). 프로필을 못 읽어도(503 포함) 예외 없이 경주다(fail-closed).
    """
    region = requested_region(request)
    if region is None:
        return PUBLIC_REGION
    if not current_user or not current_user.get("id"):
        return PUBLIC_REGION
    user_id = str(current_user["id"])
    route = request.url.path
    try:
        profile = await authz._build_profile(
            user_id, current_user.get("email"), current_user.get("payload") or {}
        )
    except Exception as exc:  # noqa: BLE001 — 프로필 장애는 공개 지역으로 닫는다
        logger.warning(
            "region_downgraded", user_id=user_id, route=route, reason="profile_unavailable",
            error_type=type(exc).__name__,
        )
        return PUBLIC_REGION
    if can_view_internal_regions(profile):
        logger.info("internal_region_granted", user_id=user_id, route=route, region=region)
        return region
    logger.info("region_downgraded", user_id=user_id, route=route, reason="not_internal")
    return PUBLIC_REGION


async def require_internal_region_viewer(
    profile: dict = Depends(authz.get_current_profile),
) -> dict:
    """내부 지역 API 의 가드. JWT 가 없으면 401(get_current_user), 내부 계정이 아니면 403."""
    if not can_view_internal_regions(profile):
        logger.info("internal_region_denied", user_id=profile.get("id"), role=profile.get("role"))
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=_FORBIDDEN_DETAIL)
    return profile
