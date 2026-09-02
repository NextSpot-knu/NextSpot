"""조회에 실패해서 만든 프로필은 캐시하지 않는다.

실패값(role=tourist / 빈 소유 집합)은 '권한이 없다' 와 **구분되지 않는다**. 그래서 캐시에
넣으면 커넥션이 한 번 끊긴 대가로 30초 동안 사장님이 자기 콘솔에서 잠긴다. 이번 요청을
막는 것 자체는 맞다(fail-closed) — 굳히지 않는 것이 요점이다.

프런트에서 같은 모양의 버그를 이미 겪었다(lib/account.tsx 의 sticky null).
"""
import pytest
from unittest.mock import AsyncMock, patch

from app.core import authz

PAYLOAD = {"is_anonymous": False}
UID = "u-1"


@pytest.fixture(autouse=True)
def _clear_cache():
    authz._profile_cache.clear()
    yield
    authz._profile_cache.clear()


@pytest.mark.asyncio
async def test_a_degraded_profile_is_not_cached():
    degraded = {"role": "tourist", "facility_ids": frozenset(), "degraded": True}
    with patch.object(authz, "_load_profile", new=AsyncMock(return_value=degraded)):
        await authz._build_profile(UID, None, PAYLOAD)
    assert UID not in authz._profile_cache, "실패로 만든 프로필이 30초간 굳었다"


@pytest.mark.asyncio
async def test_the_next_request_retries_after_a_failure():
    good = {"role": "merchant", "facility_ids": frozenset({"f-1"})}
    loader = AsyncMock(side_effect=[
        {"role": "tourist", "facility_ids": frozenset(), "degraded": True},
        good,
    ])
    with patch.object(authz, "_load_profile", new=loader):
        first = await authz._build_profile(UID, None, PAYLOAD)
        second = await authz._build_profile(UID, None, PAYLOAD)
    assert first["role"] == "tourist"
    assert second["role"] == "merchant", "실패값을 물려받아 재조회하지 않았다"
    assert second["facility_ids"] == frozenset({"f-1"})
    assert loader.await_count == 2


@pytest.mark.asyncio
async def test_a_healthy_profile_is_still_cached():
    """캐시 자체는 살아 있어야 한다 — 요청마다 두 번씩 조회하면 그것대로 문제다."""
    good = {"role": "merchant", "facility_ids": frozenset({"f-1"})}
    loader = AsyncMock(return_value=good)
    with patch.object(authz, "_load_profile", new=loader):
        await authz._build_profile(UID, None, PAYLOAD)
        await authz._build_profile(UID, None, PAYLOAD)
    assert loader.await_count == 1
    assert UID in authz._profile_cache


@pytest.mark.asyncio
async def test_the_degraded_marker_never_reaches_the_caller():
    """내부 신호다. 프로필 응답에 새어 나가면 호출부가 그걸 권한처럼 읽을 수 있다."""
    degraded = {"role": "tourist", "facility_ids": frozenset(), "degraded": True}
    with patch.object(authz, "_load_profile", new=AsyncMock(return_value=degraded)):
        profile = await authz._build_profile(UID, None, PAYLOAD)
    assert "degraded" not in profile
    assert set(profile) == {"id", "email", "is_anonymous", "role", "facility_ids"}


# ── assert_role — 익명 세션은 어떤 상위 역할도 가질 수 없다 ────────────────

def _profile(role: str, anonymous: bool) -> dict:
    return {
        "id": UID, "email": None, "is_anonymous": anonymous,
        "role": role, "facility_ids": frozenset(),
    }


@pytest.mark.parametrize("role", ["merchant", "admin", "developer"])
def test_an_anonymous_session_holds_no_elevated_role(role):
    """developer 가 특히 중요하다 — 조기 통과가 익명 검사보다 앞에 있으면 **가장 강한
    역할만** 이 규칙을 비껴간다. /dev 콘솔은 uid 정확일치로 게스트도 찾아 주므로
    게스트 uid 에 실수로 developer 를 찍는 일이 실제로 가능하다."""
    with pytest.raises(Exception) as err:
        authz.assert_role(_profile(role, anonymous=True), "merchant", "admin")
    assert getattr(err.value, "status_code", None) == 403


@pytest.mark.parametrize("role", ["merchant", "admin", "developer"])
def test_a_real_account_still_passes(role):
    authz.assert_role(_profile(role, anonymous=False), "merchant", "admin")
