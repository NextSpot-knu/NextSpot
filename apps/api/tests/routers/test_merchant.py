# 머천트 콘솔(소상공인 '내 가게 대시보드') 라우터 테스트 — 실제 DB/네트워크 없이
# require_merchant 가드·성적표 집계·타임세일 발행/취소·좌석 상태 방송을 검증한다.
#  · 인증: require_merchant 는 실제 헤더 경로(X-Merchant-Token)를 그대로 태운다(관리자 가드와 별도 체계).
#  · DB: supabase_admin 은 test_routers.py 의 공용 FakeSupabase(canned 데이터)로 대체 — PostgREST 호출 없음.
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import merchant

# test_routers.py 의 공용 Fake(체이닝 흡수 + table별 canned)를 재사용한다.
from tests.routers.test_routers import FakeSupabase

# merchant.py 의 기본 토큰(MERCHANT_API_TOKEN 미설정 시 폴백값)과 동일 — .env 는 이 값을 채우지 않는다
# (apps/api 앱 모듈은 dotenv 를 로드하지 않으므로 테스트 환경에서 os.environ 은 비어 있다).
MERCHANT_TOKEN = "nextspot-merchant-local"


def _merchant_headers(token: str | None = None) -> dict:
    return {"X-Merchant-Token": token or MERCHANT_TOKEN}


# 이 라우터는 아직 app/main.py 에 등록되지 않았다(통합 단계에서 배선 예정 — docs 참고).
# 등록 여부와 무관하게 라우터 자체를 검증하기 위해, merchant.router 만 얹은 독립 테스트 앱을 쓴다.
@pytest.fixture
def client():
    test_app = FastAPI()
    test_app.include_router(merchant.router)
    with TestClient(test_app) as c:
        yield c


# =========================================================================
# 1. require_merchant 가드 — 헤더 없음/오답 토큰 → 401
# =========================================================================


def test_merchant_stats_no_header_401(client):
    res = client.get("/api/v1/merchant/stats", params={"facility_id": "f-1"})
    assert res.status_code == 401


def test_merchant_stats_wrong_token_401(client):
    res = client.get(
        "/api/v1/merchant/stats", params={"facility_id": "f-1"}, headers=_merchant_headers("wrong-token")
    )
    assert res.status_code == 401


def test_merchant_seat_status_no_header_401(client):
    res = client.post("/api/v1/merchant/seat-status", json={"facility_id": "f-1", "level": "low"})
    assert res.status_code == 401


def test_merchant_timesale_create_no_header_401(client):
    res = client.post(
        "/api/v1/merchant/timesale", json={"facility_id": "f-1", "rate": 0.15, "duration_minutes": 60}
    )
    assert res.status_code == 401


# =========================================================================
# 2. 성적표(GET /api/v1/merchant/stats) — 집계 산식 + 정직한 미집계 항목
# =========================================================================


def test_merchant_stats_aggregation(client):
    coupons = [
        {"status": "issued", "issued_at": "2026-07-14T01:00:00+00:00"},
        {"status": "used", "issued_at": "2026-07-13T01:00:00+00:00"},
        {"status": "used", "issued_at": "2026-07-12T01:00:00+00:00"},
    ]
    reports = [
        {"id": "log-1", "timestamp": "2026-07-14T02:00:00+00:00"},
    ]
    recs = [
        {"accepted": True, "created_at": "2026-07-14T03:00:00+00:00"},
        {"accepted": False, "created_at": "2026-07-13T03:00:00+00:00"},
        {"accepted": True, "created_at": "2026-07-12T03:00:00+00:00"},
    ]
    with patch(
        "app.routers.merchant.supabase_admin",
        new=FakeSupabase({"user_coupons": coupons, "congestion_logs": reports, "recommendations": recs}),
    ):
        res = client.get(
            "/api/v1/merchant/stats", params={"facility_id": "f-1"}, headers=_merchant_headers()
        )

    assert res.status_code == 200
    body = res.json()
    assert body["facility_id"] == "f-1"
    assert body["coupons_issued"] == 3
    assert body["coupons_used"] == 2
    assert body["congestion_reports"] == 1
    assert body["recommendations_exposed"] == 3
    assert body["recommendations_accepted"] == 2
    # 방문확인은 서버 미집계 — 지어내지 않고 null + 사유 문구
    assert body["visit_confirmations"] is None
    assert "로컬" in body["visit_confirmations_note"]


def test_merchant_stats_empty(client):
    with patch(
        "app.routers.merchant.supabase_admin",
        new=FakeSupabase({"user_coupons": [], "congestion_logs": [], "recommendations": []}),
    ):
        res = client.get(
            "/api/v1/merchant/stats", params={"facility_id": "f-1"}, headers=_merchant_headers()
        )
    assert res.status_code == 200
    body = res.json()
    assert body["coupons_issued"] == 0
    assert body["recommendations_accepted"] == 0


# =========================================================================
# 3. 셀프 타임세일 — 발행(POST)/목록(GET)/취소(POST)
# =========================================================================


def test_merchant_timesale_create_invalid_rate_422(client):
    # rate 는 Literal[0.15, 0.20, 0.30] — 그리드 밖 값은 라우터 진입 전 422
    res = client.post(
        "/api/v1/merchant/timesale",
        headers=_merchant_headers(),
        json={"facility_id": "f-1", "rate": 0.5, "duration_minutes": 60},
    )
    assert res.status_code == 422


def test_merchant_timesale_create_facility_404(client):
    with patch("app.routers.merchant.supabase_admin", new=FakeSupabase({"facilities": []})):
        res = client.post(
            "/api/v1/merchant/timesale",
            headers=_merchant_headers(),
            json={"facility_id": "ghost", "rate": 0.15, "duration_minutes": 60},
        )
    assert res.status_code == 404


def test_merchant_timesale_create_happy_path(client):
    facility = {"id": "f-1", "name": "시설-f-1"}
    inserted = {
        "id": "ts-1", "facility_id": "f-1", "rate": 0.2,
        "starts_at": "2026-07-15T01:00:00+00:00", "ends_at": "2026-07-15T03:00:00+00:00",
    }
    with patch(
        "app.routers.merchant.supabase_admin",
        new=FakeSupabase({"facilities": [facility], "merchant_timesales": [inserted]}),
    ):
        res = client.post(
            "/api/v1/merchant/timesale",
            headers=_merchant_headers(),
            json={"facility_id": "f-1", "rate": 0.2, "duration_minutes": 120},
        )
    assert res.status_code == 200
    body = res.json()
    assert body["facility_id"] == "f-1"
    assert body["rate"] == 0.2


def test_merchant_timesale_list_active(client):
    active = [
        {"id": "ts-1", "facility_id": "f-1", "rate": 0.15, "ends_at": "2099-01-01T00:00:00+00:00",
         "canceled_at": None, "created_at": "2026-07-15T01:00:00+00:00"},
    ]
    with patch("app.routers.merchant.supabase_admin", new=FakeSupabase({"merchant_timesales": active})):
        res = client.get(
            "/api/v1/merchant/timesale", params={"facility_id": "f-1"}, headers=_merchant_headers()
        )
    assert res.status_code == 200
    assert res.json() == active


def test_merchant_timesale_cancel_happy_path(client):
    canceled = {"id": "ts-1", "facility_id": "f-1", "canceled_at": "2026-07-15T04:00:00+00:00"}
    with patch("app.routers.merchant.supabase_admin", new=FakeSupabase({"merchant_timesales": [canceled]})):
        res = client.post(
            "/api/v1/merchant/timesale/cancel",
            headers=_merchant_headers(),
            json={"id": "ts-1", "facility_id": "f-1"},
        )
    assert res.status_code == 200
    assert res.json()["canceled_at"] == "2026-07-15T04:00:00+00:00"


def test_merchant_timesale_cancel_not_found_404(client):
    with patch("app.routers.merchant.supabase_admin", new=FakeSupabase({"merchant_timesales": []})):
        res = client.post(
            "/api/v1/merchant/timesale/cancel",
            headers=_merchant_headers(),
            json={"id": "ghost", "facility_id": "f-1"},
        )
    assert res.status_code == 404


# =========================================================================
# 4. 좌석 상태 방송(POST /api/v1/merchant/seat-status) — features jsonb 병합
# =========================================================================


def test_merchant_seat_status_facility_404(client):
    with patch("app.routers.merchant.supabase_admin", new=FakeSupabase({"facilities": []})):
        res = client.post(
            "/api/v1/merchant/seat-status",
            headers=_merchant_headers(),
            json={"facility_id": "ghost", "level": "full"},
        )
    assert res.status_code == 404


def test_merchant_seat_status_invalid_level_422(client):
    res = client.post(
        "/api/v1/merchant/seat-status",
        headers=_merchant_headers(),
        json={"facility_id": "f-1", "level": "medium"},
    )
    assert res.status_code == 422


def test_merchant_seat_status_happy_path(client):
    # FakeTable 은 select/update 호출 모두 동일 canned 데이터를 돌려준다(실제 병합은 검증 대상이 아님 —
    # 응답 바디는 라우터가 직접 구성해 반환하므로 canned 데이터는 '존재/비어있지 않음' 신호로만 쓰인다).
    facility = {"id": "f-1", "features": {"average_processing_time": 10}}
    with patch(
        "app.routers.merchant.supabase_admin",
        new=FakeSupabase({"facilities": [facility]}),
    ):
        res = client.post(
            "/api/v1/merchant/seat-status",
            headers=_merchant_headers(),
            json={"facility_id": "f-1", "level": "full"},
        )
    assert res.status_code == 200
    body = res.json()
    assert body["facility_id"] == "f-1"
    assert body["level"] == "full"
    assert "updated_at" in body
