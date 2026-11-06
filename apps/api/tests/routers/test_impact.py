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
        "arrivals_confirmed": 0,
        "congestion_avoided": 0,
        "coupons_issued": 0,
        "coupons_used": 0,
        "wait_saved_minutes": 0,
    }


# =========================================================================
# 누적 합계는 **전량**이어야 한다
# =========================================================================

def test_impact_summary_counts_every_recommendation(auth_client):
    """1,000행 캡 너머의 수락 기록까지 합계에 들어오는가.

    이 화면이 내는 것은 누적 합계다. 한 페이지에서 잘리면 0 이 되는 게 아니라 **그럴듯하게
    작은 값**이 되므로 화면만 봐서는 축소 보고를 알아챌 수 없다. 사용자 한 명당 상한이 없는
    표라 실제로 넘는다 — 2026-09-07 프로덕션에서 가장 많이 쓴 계정이 이미 1,123건이다.

    (공용 FakeSupabase 가 PostgREST 캡을 실제로 강제하므로, 단발 `.execute()` 로 되돌리면
     여기서 1,000건까지만 세어 실패한다.)
    """
    rows = [
        {
            "id": f"r-{i:05d}",
            "accepted": True,
            "score_breakdown": {"incentive_relief": 0.2, "original_wait_time": 20, "wait_time": 10},
        }
        for i in range(1123)
    ]
    with patch.object(impact, "supabase_admin", FakeSupabase({"recommendations": rows, "user_coupons": []})):
        res = auth_client.get("/api/v1/impact/summary")

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["accepted"] == 1123, f"수락 건수가 캡에서 잘렸다: {body['accepted']}건만 세었다"
    assert body["congestion_avoided"] == 1123
    assert body["wait_saved_minutes"] == 1123 * 10


# =========================================================================
# 같은 날 같은 곳은 한 번 — 한 번의 결정이 여러 번으로 세어지지 않는다(P0-5 b)
# =========================================================================

def _accept(row_id: str, facility: str, created_at: str, breakdown: dict | None = None, accepted: bool = True) -> dict:
    return {
        "id": row_id,
        "accepted": accepted,
        "score_breakdown": breakdown if breakdown is not None else {},
        "recommended_facility_id": facility,
        "created_at": created_at,
    }


def test_impact_summary_counts_a_place_once_per_kst_day(auth_client):
    """예전 /main '바로 갈래요' 는 누를 때마다(도보·자동차·영업 확인 뒤) 수락 행을 새로 넣었다 — 한 번으로 센다."""
    recommendations = [
        # 같은 곳 · 같은 날 세 번(도보 → 자동차 → 다시 도보) — 한 번.
        _accept("r1", "f-cafe", "2026-10-30T03:00:00+00:00"),
        _accept("r2", "f-cafe", "2026-10-30T03:01:00+00:00"),
        _accept("r3", "f-cafe", "2026-10-30T03:05:00Z"),
        # 같은 곳이라도 다음 날이면 다시 한 번.
        _accept("r4", "f-cafe", "2026-10-31T03:00:00+00:00"),
        # KST 날짜로 가른다 — 14:30Z(=10-30 23:30 KST)와 15:30Z(=10-31 00:30 KST)는 다른 날이다.
        _accept("r5", "f-museum", "2026-10-30T14:30:00+00:00"),
        _accept("r6", "f-museum", "2026-10-30T15:30:00+00:00"),
        # 수락하지 않은 행은 세지 않는다.
        _accept("r7", "f-park", "2026-10-30T05:00:00+00:00", accepted=False),
    ]
    with patch.object(impact, "supabase_admin", FakeSupabase({"recommendations": recommendations, "user_coupons": []})):
        res = auth_client.get("/api/v1/impact/summary")

    assert res.status_code == 200, res.text
    assert res.json()["accepted"] == 4  # f-cafe 10-30 · f-cafe 10-31 · f-museum 10-30 · f-museum 10-31


def test_impact_summary_merges_evidence_within_one_trip(auth_client):
    """같은 출발로 묶인 행 중 근거가 있는 행의 값을 한 번만 쓴다 — 빈 직접수락 행이 근거를 지우거나 두 번 세지 않는다."""
    recommendations = [
        _accept("r1", "f-a", "2026-10-30T03:00:00Z",
                {"incentive_relief": 0.3, "original_wait_time": 25.0, "wait_time": 10.0}),
        _accept("r2", "f-a", "2026-10-30T03:02:00Z", {}),
        _accept("r3", "f-a", "2026-10-30T03:03:00Z",
                {"incentive_relief": 0.3, "original_wait_time": 25.0, "wait_time": 10.0}),
    ]
    with patch.object(impact, "supabase_admin", FakeSupabase({"recommendations": recommendations, "user_coupons": []})):
        body = auth_client.get("/api/v1/impact/summary").json()

    assert body["accepted"] == 1
    assert body["congestion_avoided"] == 1
    assert body["wait_saved_minutes"] == 15, "같은 출발의 대기 차이를 두 번 더했다"


def test_impact_summary_has_no_wait_or_relief_without_evidence(auth_client):
    """원본 대기·혼잡 비교가 없는 수락(직접수락·by-type)만 있으면 '줄인 예상 대기'·'혼잡 회피' 는 0 — 화면은 그리지 않는다."""
    recommendations = [
        _accept("r1", "f-a", "2026-10-30T03:00:00Z", {}),
        _accept("r2", "f-b", "2026-10-30T04:00:00Z", {"wait_time": 5.0, "incentive_relief": None}),
    ]
    with patch.object(impact, "supabase_admin", FakeSupabase({"recommendations": recommendations, "user_coupons": []})):
        body = auth_client.get("/api/v1/impact/summary").json()

    assert body["accepted"] == 2
    assert body["congestion_avoided"] == 0
    assert body["wait_saved_minutes"] == 0


# =========================================================================
# 도착 확인 — recommendation_outcomes.arrival_confirmed_at, 같은 규칙으로 한 번씩
# =========================================================================

def test_impact_summary_counts_confirmed_arrivals(auth_client):
    recommendations = [
        _accept("r1", "f-cafe", "2026-10-30T03:00:00Z"),
        _accept("r2", "f-cafe", "2026-10-30T03:01:00Z"),
        # 예전 /main 경로: 도착은 노출된 by-type 행(수락 표시 없음)에 붙고, 수락은 새 행에 들어갔다 — 도착은 그대로 센다.
        _accept("r3", "f-museum", "2026-10-30T05:00:00Z", accepted=False),
        _accept("r4", "f-park", "2026-10-30T06:00:00Z"),
    ]
    outcomes = [
        {"recommendation_id": "r1", "arrival_confirmed_at": "2026-10-30T03:20:00Z"},
        # 같은 곳 · 같은 날의 두 번째 도착은 한 번으로.
        {"recommendation_id": "r2", "arrival_confirmed_at": "2026-10-30T03:25:00Z"},
        {"recommendation_id": "r3", "arrival_confirmed_at": "2026-10-30T05:30:00Z"},
        # 길안내만 시작하고 도착은 확인하지 않았다 — 세지 않는다.
        {"recommendation_id": "r4", "arrival_confirmed_at": None},
        # 추천 행을 못 찾는 도착(다른 경로로 지워진 추천)도 그 추천 하나로 센다.
        {"recommendation_id": "r-gone", "arrival_confirmed_at": "2026-10-29T03:00:00Z"},
    ]
    fake = FakeSupabase({"recommendations": recommendations, "user_coupons": [], "recommendation_outcomes": outcomes})
    with patch.object(impact, "supabase_admin", fake):
        body = auth_client.get("/api/v1/impact/summary").json()

    assert body["arrivals_confirmed"] == 3  # f-cafe · f-museum · r-gone
    assert body["accepted"] == 2  # f-cafe · f-park


class _OutcomesDownSupabase(FakeSupabase):
    """recommendation_outcomes 조회만 실패하는 DB(마이그레이션 전 환경·일시 장애)."""

    def table(self, name: str):
        if name == "recommendation_outcomes":
            raise RuntimeError("relation recommendation_outcomes does not exist")
        return super().table(name)


def test_impact_summary_unknown_arrivals_are_null_not_zero(auth_client):
    """도착 조회만 실패하면 화면 전체를 실패시키지 않되, 도착을 0 으로 지어내지 않는다(None)."""
    recommendations = [_accept("r1", "f-a", "2026-10-30T03:00:00Z")]
    with patch.object(impact, "supabase_admin", _OutcomesDownSupabase({"recommendations": recommendations, "user_coupons": []})):
        res = auth_client.get("/api/v1/impact/summary")

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["arrivals_confirmed"] is None
    assert body["accepted"] == 1
