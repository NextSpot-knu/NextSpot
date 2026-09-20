"""조회에 실패해서 만든 프로필은 캐시하지 않는다.

실패값(role=tourist / 빈 소유 집합)은 '권한이 없다' 와 **구분되지 않는다**. 그래서 캐시에
넣으면 커넥션이 한 번 끊긴 대가로 30초 동안 사장님이 자기 콘솔에서 잠긴다. 이번 요청을
막는 것 자체는 맞다(fail-closed) — 굳히지 않는 것이 요점이다.

프런트에서 같은 모양의 버그를 이미 겪었다(lib/account.tsx 의 sticky null).
"""
import pytest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.core import authz

PAYLOAD = {"is_anonymous": False}
UID = "u-1"


@pytest.fixture(autouse=True)
def _clear_cache():
    authz._profile_cache.clear()
    yield
    authz._profile_cache.clear()


DEGRADED = {"role": "tourist", "facility_ids": frozenset(), "degraded": True}


@pytest.mark.asyncio
async def test_a_degraded_profile_is_not_cached():
    with patch.object(authz, "_load_profile", new=AsyncMock(return_value=DEGRADED)):
        with pytest.raises(HTTPException):
            await authz._build_profile(UID, None, PAYLOAD)
    assert UID not in authz._profile_cache, "실패로 만든 프로필이 30초간 굳었다"


@pytest.mark.asyncio
async def test_a_lookup_failure_is_503_not_a_silent_demotion():
    """조회 실패를 tourist 로 돌려주면 우리 쪽 장애가 '권한 없음' 으로 둔갑한다.

    그 모양이 실제로 나가던 응답이다 — 관리자는 403, 사장님은 "내 가게가 아닙니다",
    /account/me 는 **오류도 아닌** 200 role=tourist. 마지막 것이 가장 나쁘다: 프런트가
    실패로 보지 않으니 재시도도 없이 화면이 관광객 모드로 내려앉는다.
    """
    with patch.object(authz, "_load_profile", new=AsyncMock(return_value=DEGRADED)):
        with pytest.raises(HTTPException) as err:
            await authz._build_profile(UID, None, PAYLOAD)
    assert err.value.status_code == 503
    # 401 이면 프런트가 '로그인이 풀렸다' 로 읽고 로그아웃시킨다 — 그것도 거짓말이다.
    assert err.value.status_code != 401


@pytest.mark.asyncio
async def test_the_degraded_detail_carries_no_exception_text():
    """드라이버 예외 문구에는 URL·헤더 조각이 섞여 들어올 수 있다 — 고정 문구여야 한다."""
    async def _boom(_user_id: str) -> dict:
        return DEGRADED

    with patch.object(authz, "_load_profile", new=_boom):
        with pytest.raises(HTTPException) as err:
            await authz._build_profile(UID, None, PAYLOAD)
    assert err.value.detail == authz._PROFILE_UNAVAILABLE_DETAIL


@pytest.mark.asyncio
async def test_the_next_request_retries_after_a_failure():
    good = {"role": "merchant", "facility_ids": frozenset({"f-1"})}
    loader = AsyncMock(side_effect=[DEGRADED, good])
    with patch.object(authz, "_load_profile", new=loader):
        with pytest.raises(HTTPException):
            await authz._build_profile(UID, None, PAYLOAD)
        second = await authz._build_profile(UID, None, PAYLOAD)
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
    """내부 신호다. 프로필 응답에 새어 나가면 호출부가 그걸 권한처럼 읽을 수 있다.

    이제 degraded 는 애초에 프로필이 되지 못하고 503 으로 끊긴다. 정상 경로의 키 집합이
    그대로인지는 여전히 잠가 둔다 — 여기에 키가 늘면 호출부가 권한으로 오독할 수 있다.
    """
    good = {"role": "merchant", "facility_ids": frozenset({"f-1"})}
    with patch.object(authz, "_load_profile", new=AsyncMock(return_value=good)):
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
