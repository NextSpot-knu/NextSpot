# 여행 임팩트 카드 라우터 테스트 — 실제 DB/네트워크 없이 인증 가드·집계 로직·빈 데이터를 검증.
#  · main.py 는 소유 파일 밖(배선은 별도 작업)이라, 이 라우터만 얹은 로컬 FastAPI 앱으로 테스트한다
#    (app.main.app 에는 아직 include_router(impact.router) 가 없을 수 있음 — 다른 라우터 테스트의
#    TestClient(app.main.app) 패턴과 달리 여기서는 격리된 앱을 쓴다).
#  · 인증: get_current_user 는 dependency_overrides 로 고정 사용자 대체(가드 자체는 원본 의존성 실경로).
#  · DB: supabase_admin 을 canned 데이터 FakeSupabase 로 패치 — PostgREST 호출이 발생하지 않는다.
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import impact
from app.core.supabase import get_current_user

# test_routers.py 의 공용 Fake(체이닝 흡수 + table별 canned)를 재사용한다.
from tests.routers.test_routers import FakeSupabase

AUTH_USER_ID = "u-1"


def _make_app() -> FastAPI:
    test_app = FastAPI()
    test_app.include_router(impact.router)
    return test_app


@pytest.fixture
def client():
    # 인증 없는 클라이언트(가드 자체를 검증할 때 사용)
    with TestClient(_make_app()) as c:
        yield c


@pytest.fixture
def auth_client():
    test_app = _make_app()
    test_app.dependency_overrides[get_current_user] = lambda: {
        "id": AUTH_USER_ID,
        "email": "tourist@example.com",
        "role": "authenticated",
    }
    with TestClient(test_app) as c:
        yield c


# =========================================================================
# 인증 가드 — 토큰 없으면 401 (get_current_user 실경로)
# =========================================================================

def test_impact_summary_requires_auth(client):
    res = client.get("/api/v1/impact/summary")
    assert res.status_code == 401


# =========================================================================
# 정상 케이스 — accepted/congestionAvoided/coupons/waitSaved 집계 검증
# =========================================================================

def test_impact_summary_happy_path(auth_client):
    recommendations = [
        # A: 수락 + 혼잡 회피(incentive_relief>0) + 대기 절감(20분→5분 = 15분 절감)
        {
            "accepted": True,
            "score_breakdown": {
                "incentive_relief": 0.4,
                "wait_time": 5.0,
                "original_wait_time": 20.0,
            },
        },
        # B: 수락했지만 혼잡 회피 없음(incentive_relief=0), 대기는 오히려 늘어남(음수 절감 → 집계 제외)
        {
            "accepted": True,
            "score_breakdown": {
                "incentive_relief": 0.0,
                "wait_time": 10.0,
                "original_wait_time": 8.0,
            },
        },
        # C: 미수락 — accepted 집계에서도 제외
        {
            "accepted": False,
            "score_breakdown": {"incentive_relief": 0.9},
        },
        # D: 수락했지만 breakdown 이 비어있음(/recommendations/accept 직접수락 경로) — accepted 만 +1
        {
            "accepted": True,
            "score_breakdown": {},
        },
    ]
    coupons = [
        {"status": "issued"},
        {"status": "used"},
        {"status": "used"},
    ]

    with patch(
        "app.routers.impact.supabase_admin",
        new=FakeSupabase({"recommendations": recommendations, "user_coupons": coupons}),
    ):
        res = auth_client.get("/api/v1/impact/summary")

    assert res.status_code == 200
    body = res.json()
    assert body["accepted"] == 3  # A, B, D (C 는 미수락이라 제외)
    assert body["congestion_avoided"] == 1  # A만 incentive_relief>0
    assert body["coupons_issued"] == 3
    assert body["coupons_used"] == 2
    assert body["wait_saved_minutes"] == 15  # A만 양수 절감(B는 음수라 제외)


# =========================================================================
# 빈 데이터(신규 사용자) — 전부 0
# =========================================================================

def test_impact_summary_empty_new_user(auth_client):
    with patch(
        "app.routers.impact.supabase_admin",
        new=FakeSupabase({"recommendations": [], "user_coupons": []}),
    ):
        res = auth_client.get("/api/v1/impact/summary")

    assert res.status_code == 200
    body = res.json()
    assert body == {
        "accepted": 0,
        "congestion_avoided": 0,
        "coupons_issued": 0,
        "coupons_used": 0,
        "wait_saved_minutes": 0,
    }
