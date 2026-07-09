# 내 쿠폰함(인센티브 지갑) 라우터 테스트 — 실제 DB/네트워크 없이 인증 가드·발급 규칙·직렬화 검증.
#  · 인증: get_current_user 는 dependency_overrides 로 고정 사용자 대체(가드 자체 검증은 원본 client).
#  · DB: supabase_admin 을 canned 데이터 FakeSupabase 로 패치 — PostgREST 호출이 발생하지 않는다.
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.core.supabase import get_current_user

# test_routers.py 의 공용 Fake(체이닝 흡수 + table별 canned)를 재사용한다.
from tests.routers.test_routers import FakeSupabase

AUTH_USER_ID = "u-1"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def auth_client():
    app.dependency_overrides[get_current_user] = lambda: {
        "id": AUTH_USER_ID,
        "email": "tourist@example.com",
        "role": "authenticated",
    }
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.pop(get_current_user, None)


# =========================================================================
# 인증 가드 — 토큰 없으면 401 (get_current_user 실경로)
# =========================================================================

def test_coupons_mine_requires_auth(client):
    res = client.get("/api/v1/coupons/mine")
    assert res.status_code == 401


def test_coupons_issue_requires_auth(client):
    res = client.post("/api/v1/coupons/issue", json={"facility_id": "f-1"})
    assert res.status_code == 401


# =========================================================================
# GET /mine — 본인 쿠폰 목록(시설 조인 직렬화)
# =========================================================================

def test_coupons_mine_happy_path(auth_client):
    rows = [
        {
            "id": "c-1",
            "user_id": AUTH_USER_ID,
            "facility_id": "f-1",
            "coupon_rate": 0.2,
            "status": "issued",
            "issued_at": "2026-07-10T01:00:00+00:00",
            "used_at": None,
            "facility": {"name": "황리단길 한우국밥", "type": "restaurant"},
        },
        # 조인이 list 형태로 와도 안전 추출되는지 겸사겸사 검증
        {
            "id": "c-2",
            "user_id": AUTH_USER_ID,
            "facility_id": "f-2",
            "coupon_rate": 0.1,
            "status": "used",
            "issued_at": "2026-07-09T01:00:00+00:00",
            "used_at": "2026-07-09T05:00:00+00:00",
            "facility": [{"name": "월정교", "type": "attraction"}],
        },
    ]
    with patch("app.routers.coupons.supabase_admin", new=FakeSupabase({"user_coupons": rows})):
        res = auth_client.get("/api/v1/coupons/mine")

    assert res.status_code == 200
    items = res.json()
    assert len(items) == 2
    # snake_case → camelCase 는 프런트 api-client 가 처리 — 백엔드 응답은 snake_case 유지.
    assert items[0]["facility_name"] == "황리단길 한우국밥"
    assert items[0]["facility_type"] == "restaurant"
    assert items[0]["coupon_rate"] == 0.2
    assert items[1]["facility_name"] == "월정교"  # list 조인에서 추출
    assert items[1]["status"] == "used"


def test_coupons_mine_empty(auth_client):
    with patch("app.routers.coupons.supabase_admin", new=FakeSupabase({"user_coupons": []})):
        res = auth_client.get("/api/v1/coupons/mine")
    assert res.status_code == 200
    assert res.json() == []


# =========================================================================
# POST /issue — 발급 규칙(제휴 없는 시설 거부·미존재 404·행복 경로)
# =========================================================================

def test_coupons_issue_happy_path(auth_client):
    facility = {"id": "f-1", "name": "황리단길 한우국밥", "coupon_rate": 0.2}
    issued = {
        "id": "c-1",
        "facility_id": "f-1",
        "coupon_rate": 0.2,
        "status": "issued",
        "issued_at": "2026-07-10T02:00:00+00:00",
    }
    with patch("app.routers.coupons.supabase_admin",
               new=FakeSupabase({"facilities": [facility], "user_coupons": [issued]})):
        res = auth_client.post("/api/v1/coupons/issue", json={"facility_id": "f-1"})

    assert res.status_code == 200
    body = res.json()
    assert body["facility_id"] == "f-1"
    assert body["facility_name"] == "황리단길 한우국밥"
    assert body["coupon_rate"] == 0.2
    assert body["status"] == "issued"


def test_coupons_issue_no_partnership_422(auth_client):
    # coupon_rate <= 0(제휴 없음) → 422 (발급 거부)
    facility = {"id": "f-1", "name": "일반 시설", "coupon_rate": 0.0}
    with patch("app.routers.coupons.supabase_admin",
               new=FakeSupabase({"facilities": [facility], "user_coupons": []})):
        res = auth_client.post("/api/v1/coupons/issue", json={"facility_id": "f-1"})
    assert res.status_code == 422


def test_coupons_issue_facility_not_found_404(auth_client):
    with patch("app.routers.coupons.supabase_admin",
               new=FakeSupabase({"facilities": [], "user_coupons": []})):
        res = auth_client.post("/api/v1/coupons/issue", json={"facility_id": "nope"})
    assert res.status_code == 404
