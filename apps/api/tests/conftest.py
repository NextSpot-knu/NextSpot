# 라우터 통합 테스트용 환경 부트스트랩.
# app 임포트 시점에 Settings(app/core/config.py)가 필수 시크릿을 요구하므로,
# 어떤 테스트 모듈이 app 을 임포트하기 전에 placeholder 를 채운다.
# setdefault 라서 CI/셸이 이미 설정한 실제 값이 있으면 그 값이 우선한다.
import os
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import jwt
import pytest

os.environ.setdefault("SUPABASE_URL", "https://placeholder.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "placeholder-anon")
# 32바이트 이상 — 테스트가 실제 HS256 검증 경로를 타므로(관리자 JWT), 짧은 키는
# PyJWT 가 InsecureKeyLengthWarning 을 낸다.
os.environ.setdefault("JWT_SECRET", "placeholder-jwt-secret-at-least-32-bytes")
os.environ.setdefault("ADMIN_API_TOKEN", "placeholder-admin")
# 머천트 토큰은 Settings 경유(.env 도 읽힘)라, 로컬 .env 에 값이 있으면 테스트가 환경에 좌우된다.
# env var 가 .env 보다 우선하므로 데모 기본값으로 고정한다(테스트가 가정하는 값과 일치).
os.environ.setdefault("MERCHANT_API_TOKEN", "nextspot-merchant-local")
# LLM(Upstage Solar) 테스트 격리 — 로컬 .env 에 실키가 있어도 env var 가 .env 보다 우선하므로
# 빈 값으로 고정해 is_enabled()=False(전 테스트 LLM 네트워크 차단). LLM 경로가 필요한 테스트는
# llm_client 함수를 개별 monkeypatch 한다(TOURAPI 차단 픽스처와 동일 원칙).
os.environ.setdefault("UPSTAGE_API_KEY", "")


@pytest.fixture(autouse=True)
def _isolate_event_boost(monkeypatch):
    """행사 혼잡 보정(A4)의 TourAPI 조회를 전 테스트에서 차단 + 모듈 캐시 격리.

    로컬 개발기에는 apps/api/.env 의 실 TOURAPI_KEY 가 로드돼 있어, score/batch 테스트가
    보정 경로를 타면 실 네트워크 호출이 섞인다(CI 는 키 미설정이라 무해 폴백 — 환경별로
    결과가 갈리는 것 자체가 문제). 기본은 '키 미설정' 시나리오로 고정하고,
    test_event_boost.py 처럼 축제 데이터가 필요한 테스트는 이 위에 다시 패치한다.
    """
    from app.services import event_boost

    async def _no_key(_today):
        raise RuntimeError("TOURAPI_KEY not configured (test isolation)")

    monkeypatch.setattr(event_boost, "_fetch_ongoing_festivals", _no_key)
    monkeypatch.setattr(event_boost, "_cache", None)
    from app.services import area_demand_service

    async def _no_parking(_latitude, _longitude):
        return None

    async def _no_weather(_now=None):
        return None

    async def _no_history(*_args, **_kwargs):
        return None

    monkeypatch.setattr(area_demand_service, "get_nearby_parking_signal", _no_parking)
    monkeypatch.setattr(area_demand_service, "get_gyeongju_weather", _no_weather)
    monkeypatch.setattr(area_demand_service, "get_historical_area_demand_forecast", _no_history)
    yield


# =========================================================================
# 관리자·역할 인증(RBAC) 테스트 지원
# =========================================================================
# 구 관리자 가드는 공유 토큰(X-Admin-Authorization) 하나만 봤지만, 이제 Supabase JWT +
# public.users.role 로 판정한다(app/core/authz.py). 테스트는 **실제 JWT 검증 경로를 그대로
# 태우고**(HS256 + JWT_SECRET), DB 조회(_load_profile)만 목으로 대체한다.

ADMIN_USER_ID = "aaaaaaaa-0000-4000-8000-00000000adm1"
DEVELOPER_USER_ID = "dddddddd-0000-4000-8000-00000000dev1"

# uid → 역할. 여기 없는 사용자는 tourist 로 떨어진다(서버와 같은 fail-closed 방향).
_TEST_ROLES = {
    ADMIN_USER_ID: "admin",
    DEVELOPER_USER_ID: "developer",
}


def make_test_jwt(sub: str) -> str:
    """테스트용 Supabase 호환 액세스 토큰(HS256 — get_current_user 의 legacy 경로)."""
    from app.core.config import settings

    return jwt.encode(
        {
            "sub": sub,
            "aud": "authenticated",
            "role": "authenticated",
            "exp": datetime.now(timezone.utc) + timedelta(hours=1),
        },
        settings.JWT_SECRET,
        algorithm="HS256",
    )


def admin_headers(sub: str | None = None) -> dict:
    """관리자 권한으로 요청을 태우는 헤더. sub 를 바꾸면 그 사용자의 역할로 평가된다."""
    return {"Authorization": f"Bearer {make_test_jwt(sub or ADMIN_USER_ID)}"}


@pytest.fixture(autouse=True)
def _authz_role_source():
    """역할 조회를 DB 대신 _TEST_ROLES 로 대체하고, 테스트 간 캐시를 격리한다.

    authz 는 30초 TTL 캐시를 쓰므로 비워 주지 않으면 앞 테스트의 역할이 새어 나온다.
    """
    from app.core import authz

    async def _fake_load(user_id: str) -> dict:
        return {
            "role": _TEST_ROLES.get(user_id, "tourist"),
            "facility_ids": frozenset(),
        }

    authz.invalidate_profile_cache()
    with patch.object(authz, "_load_profile", new=AsyncMock(side_effect=_fake_load)):
        yield
    authz.invalidate_profile_cache()
