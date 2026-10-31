"""지역 판정(app/core/region.py) — 서울은 developer 전용, 헤더 없는 요청은 I/O 0회로 경주."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.core import authz, region
from tests.conftest import (
    ADMIN_USER_ID,
    DEVELOPER_USER_ID,
    MERCHANT_USER_ID,
    TOURIST_USER_ID,
)


def _request(header: str | None = None, path: str = "/api/v1/recommendations") -> Request:
    headers = []
    if header is not None:
        headers.append((region.REGION_HEADER.lower().encode(), header.encode()))
    return Request({"type": "http", "method": "POST", "path": path, "headers": headers, "query_string": b""})


def _user(user_id: str, *, email: str | None = None, is_anonymous: bool = False) -> dict:
    payload = {"sub": user_id}
    if is_anonymous:
        payload["is_anonymous"] = True
    return {"id": user_id, "email": email, "role": "authenticated", "payload": payload}


def _resolve(request: Request, user: dict | None) -> str:
    return asyncio.run(region.resolve_request_region(request, user))


# ── 헤더 없음 = I/O 0회 ────────────────────────────────────────────────────────


@pytest.mark.parametrize("header", [None, "", "   ", "gyeongju", "GYEONGJU", "busan", "seoul;drop"])
def test_no_internal_header_is_public_without_any_profile_lookup(header):
    with patch.object(authz, "_build_profile", new=AsyncMock()) as build, \
         patch.object(authz, "_load_profile", new=AsyncMock()) as load:
        assert _resolve(_request(header), _user(DEVELOPER_USER_ID)) == region.PUBLIC_REGION
    assert build.await_count == 0
    assert load.await_count == 0


def test_internal_header_without_user_is_public():
    with patch.object(authz, "_build_profile", new=AsyncMock()) as build:
        assert _resolve(_request("seoul"), None) == region.PUBLIC_REGION
    assert build.await_count == 0


# ── 역할별 ─────────────────────────────────────────────────────────────────────


def test_developer_gets_seoul():
    assert _resolve(_request("seoul"), _user(DEVELOPER_USER_ID)) == region.REGION_SEOUL
    assert _resolve(_request(" Seoul "), _user(DEVELOPER_USER_ID)) == region.REGION_SEOUL


@pytest.mark.parametrize("user_id", [ADMIN_USER_ID, MERCHANT_USER_ID, TOURIST_USER_ID])
def test_non_developer_roles_are_downgraded(user_id):
    assert _resolve(_request("seoul"), _user(user_id)) == region.PUBLIC_REGION


def test_judge_admin_is_downgraded():
    judge = _user(ADMIN_USER_ID, email=authz.JUDGE_ADMIN_EMAIL)
    assert _resolve(_request("seoul"), judge) == region.PUBLIC_REGION


def test_anonymous_developer_is_downgraded():
    assert _resolve(_request("seoul"), _user(DEVELOPER_USER_ID, is_anonymous=True)) == region.PUBLIC_REGION


def test_degraded_profile_503_fails_closed_to_public():
    async def _degraded(_user_id):
        return {"role": "developer", "facility_ids": frozenset(), "degraded": True}

    with patch.object(authz, "_load_profile", new=AsyncMock(side_effect=_degraded)):
        assert _resolve(_request("seoul"), _user(DEVELOPER_USER_ID)) == region.PUBLIC_REGION


def test_profile_exception_fails_closed_to_public():
    with patch.object(authz, "_build_profile", new=AsyncMock(side_effect=RuntimeError("db down"))):
        assert _resolve(_request("seoul"), _user(DEVELOPER_USER_ID)) == region.PUBLIC_REGION


def test_unknown_region_header_is_public():
    assert _resolve(_request("busan"), _user(DEVELOPER_USER_ID)) == region.PUBLIC_REGION


# ── 단일 판정점 ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "profile, expected",
    [
        ({"role": "developer", "is_anonymous": False}, True),
        ({"role": "developer", "is_anonymous": True}, False),
        ({"role": "admin", "is_anonymous": False}, False),
        ({"role": "admin", "is_anonymous": False, "email": authz.JUDGE_ADMIN_EMAIL}, False),
        ({"role": "merchant", "is_anonymous": False}, False),
        ({"role": "tourist", "is_anonymous": False}, False),
        ({}, False),
        (None, False),
    ],
)
def test_can_view_internal_regions(profile, expected):
    assert region.can_view_internal_regions(profile) is expected


def test_viewer_roles_are_developer_only():
    assert region.INTERNAL_REGION_VIEWER_ROLES == frozenset({"developer"})


def test_require_internal_region_viewer():
    developer = {"id": "d", "role": "developer", "is_anonymous": False}
    assert asyncio.run(region.require_internal_region_viewer(developer)) is developer
    for role in ("admin", "merchant", "tourist"):
        with pytest.raises(HTTPException) as caught:
            asyncio.run(region.require_internal_region_viewer({"id": "x", "role": role, "is_anonymous": False}))
        assert caught.value.status_code == 403


# ── 행 지역 · 컬럼 부재 ────────────────────────────────────────────────────────


def test_facility_region_missing_key_is_not_public():
    assert region.facility_region({}) is None
    assert region.facility_region({"region": None}) is None
    assert region.facility_region({"region": " "}) is None
    assert region.facility_region(None) is None
    assert region.facility_region({"region": "gyeongju"}) == "gyeongju"
    assert not region.is_public_facility({})
    assert region.is_public_facility({"region": "gyeongju"})


class _MissingRegion(Exception):
    code = "42703"
    message = "column facilities.region does not exist"


def test_run_region_scoped_falls_back_for_gyeongju_only():
    calls: list[bool] = []

    def make(with_region: bool):
        calls.append(with_region)
        if with_region:
            raise _MissingRegion()
        return [{"id": "a"}]

    assert region.run_region_scoped(make, region="gyeongju") == [{"id": "a"}]
    assert calls == [True, False]

    calls.clear()
    assert region.run_region_scoped(make, region="seoul") == []
    assert calls == [True]


def test_run_region_scoped_raises_other_errors():
    class _IsActiveMissing(Exception):
        code = "42703"
        message = "column facilities.is_active does not exist"

    def make_other(_with_region: bool):
        raise _IsActiveMissing()

    with pytest.raises(_IsActiveMissing):
        region.run_region_scoped(make_other, region="gyeongju")

    def make_runtime(_with_region: bool):
        raise RuntimeError("network down")

    with pytest.raises(RuntimeError):
        region.run_region_scoped(make_runtime, region="gyeongju")


def test_arun_region_scoped_matches_sync():
    def make(with_region: bool):
        if with_region:
            raise _MissingRegion()
        return ["ok"]

    assert asyncio.run(region.arun_region_scoped(make, region="gyeongju")) == ["ok"]
    assert asyncio.run(region.arun_region_scoped(make, region="seoul")) == []


def test_apply_region_uses_an_in_query_equality():
    recorded = []

    class _Q:
        def eq(self, column, value):
            recorded.append((column, value))
            return self

    region.apply_region(_Q(), "seoul")
    assert recorded == [("region", "seoul")]
