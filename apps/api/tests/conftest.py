# 라우터 통합 테스트용 환경 부트스트랩.
# app 임포트 시점에 Settings(app/core/config.py)가 필수 시크릿을 요구하므로,
# 어떤 테스트 모듈이 app 을 임포트하기 전에 placeholder 를 채운다.
# setdefault 라서 CI/셸이 이미 설정한 실제 값이 있으면 그 값이 우선한다.
import os

import pytest

os.environ.setdefault("SUPABASE_URL", "https://placeholder.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "placeholder-anon")
os.environ.setdefault("JWT_SECRET", "placeholder-jwt-secret")
os.environ.setdefault("ADMIN_API_TOKEN", "placeholder-admin")


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
    yield
