"""401 과 5xx 를 섞지 않는다 — 가드가 장애를 '로그인하세요' 로 바꾸지 않아야 한다.

프런트는 401 을 **인증 신호**로 읽는다(lib/api-client.ts 의 AuthError, lib/account.tsx 의
"401 은 장애가 아니라 아직 로그인 전"). 그래서 401 은 두 가지를 동시에 뜻하게 된다:
재시도하지 말 것, 그리고 이 사람은 로그인하지 않았다고 취급할 것. 서버 장애를 401 로
보내면 그 둘이 그대로 발동한다 — 사장님은 콘솔에서 로그아웃된 것처럼 보이고, 재시도도
일어나지 않는다. Render 무료 플랜은 쉬다 깨는 첫 요청에서 정확히 이 조건을 만든다.

이 파일이 잠그는 계약:
  · 토큰 없음 / 서명·만료 불일치  → 401 (진짜 인증 실패)
  · JWKS 를 못 읽음(콜드 스타트·Auth 장애) → 503 그대로 (401 로 바꾸지 않는다)
  · 역할 조회 실패 → 503 (403 도, 조용한 tourist 강등도 아니다)
"""
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.core import authz
from app.core.authz import ROLE_ADMIN, require_machine_or_role

UID = "11111111-1111-4111-8111-111111111111"


def _request(token: str | None = "some.jwt.token") -> Request:
    headers = [(b"authorization", f"Bearer {token}".encode())] if token else []
    return Request({"type": "http", "headers": headers, "method": "GET", "path": "/"})


def _reject(status_code: int, detail: str = "nope"):
    def _raise(_token: str):
        raise HTTPException(status_code=status_code, detail=detail)

    return _raise


# =========================================================================
# load_profile_from_request — None 은 '인증 안 됨' 만 뜻해야 한다
# =========================================================================
@pytest.mark.asyncio
async def test_no_bearer_header_is_simply_unauthenticated():
    assert await authz.load_profile_from_request(_request(None)) is None


@pytest.mark.asyncio
async def test_a_forged_token_is_unauthenticated():
    with patch.object(authz, "verify_supabase_token", _reject(401)):
        assert await authz.load_profile_from_request(_request()) is None


@pytest.mark.asyncio
async def test_a_jwks_outage_is_not_laundered_into_unauthenticated():
    """호출부는 None 을 보면 무조건 401 로 바꾼다 — 503 을 None 으로 뭉개면 안 된다."""
    with patch.object(authz, "verify_supabase_token", _reject(503, "인증 서버 연결 실패")):
        with pytest.raises(HTTPException) as err:
            await authz.load_profile_from_request(_request())
    assert err.value.status_code == 503


@pytest.mark.asyncio
async def test_token_verification_does_not_block_the_event_loop():
    """JWKS 콜드 페치는 최대 4.2초 걸리는 **동기** 호출이다.

    async 의존성에서 직접 부르면 그동안 이벤트 루프가 멈춰, 콜드 스타트 첫 요청 하나가
    같은 워커의 다른 모든 요청을 함께 세운다. 별도 스레드에서 돌아야 한다.
    """
    import threading

    caller_thread = threading.current_thread().ident
    seen: dict[str, int | None] = {}

    def _verify(_token: str) -> dict:
        seen["thread"] = threading.current_thread().ident
        return {"sub": UID, "is_anonymous": False}

    with patch.object(authz, "verify_supabase_token", _verify):
        await authz.load_profile_from_request(_request())
    assert seen["thread"] != caller_thread, "검증이 이벤트 루프 스레드에서 실행됐다"


# =========================================================================
# require_machine_or_role — 같은 규칙이 기계 경로에도 적용된다
# =========================================================================
@pytest.fixture
def machine_guarded_client():
    app = FastAPI()

    @app.get("/guarded", dependencies=[Depends(require_machine_or_role(ROLE_ADMIN))])
    async def _guarded():
        return {"ok": True}

    with TestClient(app) as client:
        yield client


def test_missing_credentials_is_401(machine_guarded_client):
    res = machine_guarded_client.get("/guarded")
    assert res.status_code == 401
    assert res.headers.get("www-authenticate") == "Bearer"


def test_jwks_outage_reaches_the_client_as_503(machine_guarded_client):
    """이 경로가 수집 트리거다. 401 로 나가면 스케줄러·운영자가 '토큰이 틀렸나' 를 본다."""
    with patch.object(authz, "verify_supabase_token", _reject(503, "인증 서버 연결 실패")):
        res = machine_guarded_client.get(
            "/guarded", headers={"Authorization": "Bearer some.jwt.token"}
        )
    assert res.status_code == 503


def test_role_lookup_failure_reaches_the_client_as_503(machine_guarded_client):
    """역할을 못 읽었을 뿐인데 403 "권한이 없습니다" 를 주면 운영자가 권한을 의심한다."""
    degraded = {"role": "tourist", "facility_ids": frozenset(), "degraded": True}
    with patch.object(
        authz, "verify_supabase_token", lambda _t: {"sub": UID, "is_anonymous": False}
    ), patch.object(authz, "_load_profile", new=AsyncMock(return_value=degraded)):
        res = machine_guarded_client.get(
            "/guarded", headers={"Authorization": "Bearer some.jwt.token"}
        )
    assert res.status_code == 503
    assert res.status_code not in (401, 403)


def test_a_wrong_machine_token_alone_is_401_not_500(machine_guarded_client):
    """틀린 서비스 토큰은 JWT 경로로 떨어지고, 거기에도 자격이 없으니 401 이다."""
    res = machine_guarded_client.get("/guarded", headers={"X-Service-Token": "wrong"})
    assert res.status_code == 401


def test_a_valid_machine_token_passes_without_a_session(machine_guarded_client):
    """대조군 — 위 테스트들이 '무조건 401' 구현으로도 통과하지 않게 한다."""
    from app.core.config import settings

    res = machine_guarded_client.get(
        "/guarded", headers={"X-Service-Token": settings.MACHINE_API_TOKEN}
    )
    assert res.status_code == 200


def test_an_unknown_user_gets_no_elevated_role(machine_guarded_client):
    """users 행이 없으면 tourist 다 — admin 가드는 403 으로 닫힌다(fail-closed)."""
    with patch.object(
        authz, "verify_supabase_token", lambda _t: {"sub": "nobody", "is_anonymous": False}
    ):
        res = machine_guarded_client.get(
            "/guarded", headers={"Authorization": "Bearer some.jwt.token"}
        )
    assert res.status_code == 403
