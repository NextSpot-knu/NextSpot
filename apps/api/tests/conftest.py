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

    # 업종 기준선(근거 없는 후보 전용, spot/industry_baseline.py)도 같은 이유로 차단한다.
    # 열어 두면 채점 테스트가 placeholder Supabase 로 실조회를 시도하고(느리고 환경 의존),
    # 프로덕션 로그가 쌓일 때마다 단위 테스트 기대값이 흔들린다. 기본은 '기준선 없음'
    # (= 2026-09-07 프로덕션 현재 상태)이고, 기준선이 필요한 테스트는 이 위에 다시 패치한다.
    from app.services.spot import industry_baseline, score

    async def _no_industry_baseline(_facility_type):
        return None

    industry_baseline.reset_cache()
    monkeypatch.setattr(score, "get_industry_baseline_congestion", _no_industry_baseline)

    # 카드 표시용 '업종 예측 기준선'(industry_baseline.get_predicted_baseline_congestion,
    # recommendations.build_candidate_evidence 가 실측·모델·추정이 모두 없을 때 'predicted' 로
    # 얹는다)도 기본은 꺼 둔다. 이 값은 시각·요일에 따라 달라지는 순수 함수라 켜 두면 '근거 없음
    # → none' 을 검증하던 기존 라우터/코스 테스트에 예측 카드가 끼어든다. 세 관광객 경로가 이 한
    # 참조를 공유하므로(코스는 build_candidate_evidence 를 import) 여기 한 곳만 막으면 된다.
    # 기준선 표시가 필요한 테스트는 이 위에 실제 함수로 다시 패치한다(가정 시각 검증 테스트).
    from app.routers import recommendations as _recommendations

    monkeypatch.setattr(
        _recommendations, "get_predicted_baseline_congestion", lambda _facility_type, _now=None: None
    )

    # 추정 모드(congestion_estimator_service)도 기본은 '추정 없음' 이다. 열어 두면 추천·코스·지도
    # 라우터 테스트가 placeholder Supabase 로 스냅샷을 읽으려 하고(느리고 환경 의존), 기존 기대값에
    # 없던 congestion_estimate 가 끼어든다. 추정이 필요한 테스트는 이 위에 다시 패치한다
    # (congestion_evidence.load_current_estimates 가 이 모듈 속성 한 곳을 부른다).
    from app.services import congestion_estimator_service

    async def _no_estimates(*, now=None):
        return {
            "available": False, "reason": "test_isolation", "observed_at": None,
            "bucket_at": None, "lot_count": 0, "estimates": {},
        }

    monkeypatch.setattr(congestion_estimator_service, "current_estimates", _no_estimates)

    # 관리자 대시보드의 하루 추정 집계도 같은 이유로 막는다 — 라우터는 예외를 `estimated: null`
    # 로 삼키므로, 실패시키는 것이 '추정 없음' 을 가장 싸게 재현한다. 필요한 테스트는 다시 패치한다.
    async def _no_day_aggregate(date_kst, *, now=None):
        raise RuntimeError("test_isolation")

    monkeypatch.setattr(congestion_estimator_service, "estimated_day_aggregate", _no_day_aggregate)
    yield
    industry_baseline.reset_cache()


@pytest.fixture(autouse=True)
def _isolate_admin_cache(monkeypatch):
    """관리자 집계 캐시(60초, app/core/admin_cache.py)도 테스트에서는 끈다 — 같은 엔드포인트를 가짜 데이터만
    바꿔 여러 번 부르는 테스트가 첫 답을 돌려받지 않게. 캐시 동작 자체는 tests/core/test_admin_cache.py."""
    from app.core import admin_cache

    admin_cache.invalidate()
    monkeypatch.setattr(admin_cache._cache, "ttl_seconds", 0.0)
    yield
    admin_cache.invalidate()


@pytest.fixture(autouse=True)
def _isolate_response_cache(monkeypatch):
    """by-type·코스 응답 캐시(180초)를 테스트에서는 기본으로 **끈다**.

    프로덕션 계약은 "같은 질문에는 180초 동안 같은 답" 이다. 그런데 테스트는 바로 그 '같은
    질문' 을 일부러 여러 번 던지면서 사이사이 세계를 바꿔 끼운다(예:
    test_solar_state_never_changes_candidates_scores_or_rank 는 동일 본문을 세 번 보내면서
    generate_reason_with_source 만 갈아 낀다). 캐시를 켜 두면 두 번째부터는 첫 번째 답이
    돌아와, 검증하려던 차이가 사라진다 — 게다가 테스트 사이로도 새어 나간다.

    그래서 TTL 을 0 으로 떨어뜨려(= 저장하자마자 만료) 캐시가 없던 시절과 동일하게 돌린다.
    캐시 자체의 동작은 tests/routers/test_response_cache.py 가 TTL 을 되돌려 검증한다.
    """
    from app.routers import courses, recommendations

    caches = (recommendations._by_type_cache, courses._course_cache)
    for cache in caches:
        cache.clear()
        monkeypatch.setattr(cache, "ttl_seconds", 0.0)
    yield
    for cache in caches:
        cache.clear()


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
