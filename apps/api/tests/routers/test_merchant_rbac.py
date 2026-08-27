# 사장님 콘솔 RBAC — JWT 역할 + 가게 소유권 강제 테스트.
#
# 이 파일이 잠그는 계약(docs/MERCHANT_CONSOLE_RBAC_PLAN.md P1):
#   · merchant 역할이라도 **소유하지 않은 가게**는 다룰 수 없다(403).
#     이 검사가 없으면 누구나 아무 가게의 좌석 상태를 방송할 수 있고, 그 방송은
#     evidence_tier='verified' 로 모델 학습 데이터에 들어간다(CONGESTION_TRUST_SPEC).
#   · tourist·admin 은 사장님 콘솔에 들어올 수 없다(관리자 대시보드와 완전 분리).
#   · developer 는 소유권을 우회한다(운영 지원).
#   · 익명 세션은 상위 역할이 될 수 없다.
#   · 레거시 공유 토큰은 LEGACY_CONSOLE_TOKENS 가 켜져 있을 때만 통한다.
#
# DB 는 test_routers.py 의 FakeSupabase 로 대체하고, JWT 검증은 authz 의 프로필 로더를
# 패치해 대신한다 — 네트워크 호출이 전혀 없다.
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core import authz
from app.routers import merchant
from tests.routers.test_routers import FakeSupabase

OWNED_FACILITY = "11111111-1111-1111-1111-111111111111"
OTHER_FACILITY = "22222222-2222-2222-2222-222222222222"
USER_ID = "33333333-3333-3333-3333-333333333333"

MERCHANT_TOKEN = "nextspot-merchant-local"


def _profile(role: str, *, facilities=(), anonymous: bool = False) -> dict:
    return {
        "id": USER_ID,
        "email": "owner@example.com",
        "is_anonymous": anonymous,
        "role": role,
        "facility_ids": frozenset(facilities),
    }


@pytest.fixture
def client():
    test_app = FastAPI()
    test_app.include_router(merchant.router)
    with TestClient(test_app) as c:
        yield c


@pytest.fixture(autouse=True)
def _no_db():
    """DB 는 전부 Fake. 콘솔 차단 스위치는 켜진 상태(정상)로 둔다."""
    fake = FakeSupabase(
        {
            "system_settings": [{"id": 1, "merchant_console_enabled": True}],
            "facilities": [{"id": OWNED_FACILITY, "features": {}, "capacity": 40}],
            "congestion_logs": [],
            "merchant_timesales": [],
            "user_coupons": [],
            "recommendations": [],
        }
    )
    with patch.object(merchant, "supabase_admin", fake), patch.object(authz, "supabase_admin", fake):
        yield


def _as(role: str, *, facilities=(), anonymous: bool = False):
    """해당 역할의 JWT 로 들어온 것처럼 프로필 로더를 대체한다."""
    return patch.object(
        merchant,
        "load_profile_from_request",
        new=AsyncMock(return_value=_profile(role, facilities=facilities, anonymous=anonymous)),
    )


def _seat_body(facility_id: str) -> dict:
    return {"facility_id": facility_id, "level": "mid"}


AUTH_HEADERS = {"Authorization": "Bearer fake-jwt"}


# =========================================================================
# 1. 소유권 — 이 개편의 핵심
# =========================================================================
def test_merchant_cannot_broadcast_for_unowned_facility(client):
    """남의 가게 좌석 방송 차단. 이 테스트가 깨지면 학습 데이터 오염 경로가 열린 것이다."""
    with _as("merchant", facilities=[OWNED_FACILITY]):
        res = client.post(
            "/api/v1/merchant/seat-status", json=_seat_body(OTHER_FACILITY), headers=AUTH_HEADERS
        )
    assert res.status_code == 403


def test_merchant_can_broadcast_for_owned_facility(client):
    with _as("merchant", facilities=[OWNED_FACILITY]):
        res = client.post(
            "/api/v1/merchant/seat-status", json=_seat_body(OWNED_FACILITY), headers=AUTH_HEADERS
        )
    assert res.status_code != 403


def test_merchant_cannot_read_unowned_stats(client):
    with _as("merchant", facilities=[OWNED_FACILITY]):
        res = client.get(
            f"/api/v1/merchant/stats?facility_id={OTHER_FACILITY}", headers=AUTH_HEADERS
        )
    assert res.status_code == 403


def test_merchant_cannot_create_timesale_for_unowned_facility(client):
    with _as("merchant", facilities=[OWNED_FACILITY]):
        res = client.post(
            "/api/v1/merchant/timesale",
            json={"facility_id": OTHER_FACILITY, "rate": 0.15, "duration_minutes": 60},
            headers=AUTH_HEADERS,
        )
    assert res.status_code == 403


# =========================================================================
# 2. 역할 — 관리자는 사장님 콘솔과 완전히 분리된다
# =========================================================================
@pytest.mark.parametrize("role", ["tourist", "admin"])
def test_non_merchant_roles_are_rejected(client, role):
    """admin 도 tourist 와 똑같이 막힌다 — '관리자 열람 모드' 같은 예외 경로를 두지 않는다."""
    with _as(role, facilities=[OWNED_FACILITY]):
        res = client.get(
            f"/api/v1/merchant/stats?facility_id={OWNED_FACILITY}", headers=AUTH_HEADERS
        )
    assert res.status_code == 403


def test_developer_bypasses_ownership(client):
    """개발자는 소유하지 않은 가게도 다룰 수 있다(운영 지원). 그 대신 감사 로그가 남는다."""
    with _as("developer", facilities=[]):
        res = client.get(
            f"/api/v1/merchant/stats?facility_id={OTHER_FACILITY}", headers=AUTH_HEADERS
        )
    assert res.status_code != 403


def test_anonymous_session_cannot_hold_merchant_role(client):
    """익명 세션은 단말에 묶여 있고 신원 확인이 불가능하므로 상위 역할을 인정하지 않는다."""
    with _as("merchant", facilities=[OWNED_FACILITY], anonymous=True):
        res = client.get(
            f"/api/v1/merchant/stats?facility_id={OWNED_FACILITY}", headers=AUTH_HEADERS
        )
    assert res.status_code == 403


def test_no_credentials_is_401(client):
    with patch.object(merchant, "load_profile_from_request", new=AsyncMock(return_value=None)):
        res = client.get(f"/api/v1/merchant/stats?facility_id={OWNED_FACILITY}")
    assert res.status_code == 401


# =========================================================================
# 3. 레거시 공유 토큰 — 플래그로만 열린다
# =========================================================================
def test_legacy_token_accepted_while_flag_on(client):
    """이행기 무중단용. 사용자를 특정할 수 없어 소유권은 검사하지 않는다(기존 동작)."""
    res = client.get(
        f"/api/v1/merchant/stats?facility_id={OTHER_FACILITY}",
        headers={"X-Merchant-Token": MERCHANT_TOKEN},
    )
    assert res.status_code != 403


def test_legacy_token_rejected_when_flag_off(client):
    """플래그를 내리면 구 토큰은 더 이상 통하지 않는다 — 소유권 강제가 전 경로로 확대된다."""
    with patch.object(merchant.settings, "LEGACY_CONSOLE_TOKENS", False), patch.object(
        merchant, "load_profile_from_request", new=AsyncMock(return_value=None)
    ):
        res = client.get(
            f"/api/v1/merchant/stats?facility_id={OTHER_FACILITY}",
            headers={"X-Merchant-Token": MERCHANT_TOKEN},
        )
    assert res.status_code == 401


# =========================================================================
# 4. 콘솔 차단 스위치
# =========================================================================
def test_console_disabled_returns_503(client):
    """사고 시 system_settings.merchant_console_enabled 로 콘솔 전체를 즉시 닫는다."""
    fake = FakeSupabase({"system_settings": [{"id": 1, "merchant_console_enabled": False}]})
    with patch.object(authz, "supabase_admin", fake), _as(
        "merchant", facilities=[OWNED_FACILITY]
    ):
        res = client.get(
            f"/api/v1/merchant/stats?facility_id={OWNED_FACILITY}", headers=AUTH_HEADERS
        )
    assert res.status_code == 503


# =========================================================================
# 5. 역할 판정 캐시 — 회수가 즉시 먹어야 한다
# =========================================================================
@pytest.mark.asyncio
async def test_profile_cache_is_invalidated_on_demand():
    """임명/회수 API 가 캐시를 비우지 않으면 최대 30초 동안 구 권한으로 통과한다."""
    authz.invalidate_profile_cache()
    loads = {"n": 0}

    async def _fake_load(user_id: str):
        loads["n"] += 1
        return {"role": "merchant", "facility_ids": frozenset()}

    with patch.object(authz, "_load_profile", new=_fake_load):
        await authz._build_profile(USER_ID, None, {})
        await authz._build_profile(USER_ID, None, {})
        assert loads["n"] == 1  # 두 번째는 캐시 적중

        authz.invalidate_profile_cache(USER_ID)
        await authz._build_profile(USER_ID, None, {})
        assert loads["n"] == 2  # 무효화 후에는 다시 읽는다
    authz.invalidate_profile_cache()


@pytest.mark.asyncio
async def test_unknown_role_falls_back_to_tourist():
    """DB 에 알 수 없는 role 값이 있어도 권한을 주지 않는다(fail-closed)."""
    authz.invalidate_profile_cache()

    class _Res:
        data = [{"role": "superuser"}]

    fake = FakeSupabase({"users": [{"id": USER_ID, "role": "superuser"}]})
    with patch.object(authz, "supabase_admin", fake):
        loaded = await authz._load_profile(USER_ID)
    assert loaded["role"] == "tourist"
    authz.invalidate_profile_cache()
