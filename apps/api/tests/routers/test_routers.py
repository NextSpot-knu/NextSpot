# FastAPI 라우터 통합 테스트 — 실제 DB/네트워크 없이 라우터 계층(인증 가드·검증·직렬화)을 검증한다.
#  · 인증: get_current_user 는 dependency_overrides 로 대체(워커 경로),
#         관리자 가드(require_admin)는 실제 헤더 경로(X-Admin-Authorization)를 그대로 태운다.
#  · DB: 라우터 헬퍼(fetch_user 등)는 AsyncMock 으로, supabase 클라이언트는 체이닝을 흡수하는
#        FakeSupabase(canned 데이터) 로 대체 — PostgREST 호출이 전혀 발생하지 않는다.
from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.core.config import settings
from app.core.supabase import get_current_user
from app.services.preference_vector_service import preference_vector_service

# --- 공통 상수 (경주 황리단길 좌표 기준 — 기존 서비스 테스트와 통일) ---
BASE_LAT, BASE_LNG = 35.8360, 129.2100
AUTH_USER_ID = "u-1"
BREAKDOWN_KEYS = (
    "preference", "wait_time", "travel_time", "incentive", "incentive_coupon", "incentive_relief",
    "original_wait_time",  # 분산 효과 집계용 스냅샷(원본 예상대기) — /admin/impact 가 소비
)


def _admin_headers(token: str | None = None) -> dict:
    # require_admin 은 X-Admin-Authorization 헤더만 읽는다(일반 Authorization 폴백 제거됨).
    return {"X-Admin-Authorization": f"Bearer {token or settings.ADMIN_API_TOKEN}"}


# --- 재사용 Fake: supabase 쿼리 빌더 체이닝(.select().eq().order().limit()...)을 전부 흡수 ---
class _FakeResult:
    def __init__(self, data):
        self.data = data


class FakeTable:
    """어떤 체이닝 메서드 호출이든 self 를 반환하고, execute() 에서 canned 데이터를 준다."""

    def __init__(self, data):
        self._data = data

    def __getattr__(self, _name):
        def _chain(*_args, **_kwargs):
            return self

        return _chain

    def execute(self):
        return _FakeResult(self._data)


class FakeSupabase:
    """table(name) → 해당 테이블의 canned 데이터를 돌려주는 FakeTable."""

    def __init__(self, tables: dict):
        self._tables = tables

    def table(self, name: str) -> FakeTable:
        return FakeTable(self._tables.get(name, []))


# --- 클라이언트 픽스처 ---
@pytest.fixture
def client():
    # 인증 없는 원본 앱 클라이언트(가드 자체를 검증할 때 사용)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def auth_client():
    # 워커(JWT) 인증 우회: get_current_user 를 고정 사용자로 대체
    app.dependency_overrides[get_current_user] = lambda: {
        "id": AUTH_USER_ID,
        "email": "tourist@example.com",
        "role": "authenticated",
    }
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.pop(get_current_user, None)


# --- 테스트 데이터 헬퍼 ---
def _facility(fid: str, ftype: str, lat_offset: float, coupon_rate: float = 0.0) -> dict:
    return {
        "id": fid,
        "name": f"시설-{fid}",
        "type": ftype,
        "latitude": BASE_LAT + lat_offset,
        "longitude": BASE_LNG,
        "capacity": 50,
        "features": {"average_processing_time": 10},
        "coupon_rate": coupon_rate,
    }


USER_ROW = {"id": AUTH_USER_ID, "preferred_categories": ["cafe", "restaurant"]}
ORIGIN_ROW = _facility("orig-1", "restaurant", 0.0)
UNIT_VECTOR = [1.0 / (8 ** 0.5)] * 8  # 정규화된 8차원 선호 벡터


# =========================================================================
# 1. 헬스체크
# =========================================================================

def test_health_check(client):
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "healthy"
    assert body["project"] == settings.PROJECT_NAME


# =========================================================================
# 2. 추천(POST /api/v1/recommendations) — 인증·IDOR 가드·행복 경로
# =========================================================================

def _reco_body(user_id: str = AUTH_USER_ID) -> dict:
    return {
        "user_id": user_id,
        "original_facility_id": "orig-1",
        "user_lat": BASE_LAT,
        "user_lng": BASE_LNG,
    }


def test_recommendations_requires_auth(client):
    # 인증 헤더 없음 → 401 (get_current_user 실경로)
    res = client.post("/api/v1/recommendations", json=_reco_body())
    assert res.status_code == 401


def test_recommendations_idor_guard(auth_client):
    # 본문 user_id ≠ 토큰 주체 → 403 (타인 선호벡터 조회/이력 INSERT 차단)
    res = auth_client.post("/api/v1/recommendations", json=_reco_body(user_id="someone-else"))
    assert res.status_code == 403


def test_recommendations_happy_path(auth_client):
    # 반경 150m 이내 후보 6개(쿠폰 제휴 1개 포함) + 반경 밖 1개 → 상위 5개 추천
    near = [
        _facility("f-1", "cafe", 0.0002),
        _facility("f-2", "restaurant", 0.0004),
        _facility("f-3", "cafe", 0.0006, coupon_rate=0.2),  # 20% 제휴 → 쿠폰강도 만점
        _facility("f-4", "attraction", 0.0008),
        _facility("f-5", "cafe", 0.0010),
        _facility("f-6", "restaurant", 0.0012),
    ]
    far = [_facility("f-far", "cafe", 0.01)]  # 약 1.1km — 150m 컷오프에서 제외돼야 함
    congestion_map = {f["id"]: 0.1 * (i + 1) for i, f in enumerate(near)}

    with patch("app.routers.recommendations.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.recommendations.fetch_facility", new=AsyncMock(return_value=ORIGIN_ROW)), \
         patch("app.routers.recommendations.fetch_all_facilities", new=AsyncMock(return_value=[ORIGIN_ROW] + near + far)), \
         patch("app.routers.recommendations.fetch_latest_congestion", new=AsyncMock(return_value=0.9)), \
         patch("app.routers.recommendations.fetch_congestion_map", new=AsyncMock(return_value=congestion_map)), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)), \
         patch("app.routers.recommendations.generate_reason", new=AsyncMock(return_value="사유")), \
         patch("app.routers.recommendations.supabase_client", new=FakeSupabase({"recommendations": [{"id": "rec-1"}]})):
        res = auth_client.post("/api/v1/recommendations", json=_reco_body())

    assert res.status_code == 200
    items = res.json()
    # 후보 6개 중 상위 5개만 응답(반경 밖 f-far 는 후보에서 제외)
    assert len(items) == 5
    assert all(item["total_candidates"] == 6 for item in items)
    assert all(item["facility"]["id"] != "f-far" for item in items)

    # 점수 내림차순 정렬 + rank 1..5 연속
    scores = [item["spot_score"] for item in items]
    assert scores == sorted(scores, reverse=True)
    assert [item["rank"] for item in items] == [1, 2, 3, 4, 5]

    for item in items:
        # 인센티브 성분(incentive_coupon/incentive_relief) 포함한 breakdown 구조 검증
        for key in BREAKDOWN_KEYS:
            assert key in item["breakdown"]
        assert item["distance_m"] <= 150.0
        assert item["reason"] == "사유"
        assert item["recommendation_id"] == "rec-1"  # _persist 가 INSERT 결과 id 를 매핑


# =========================================================================
# 3. 타입별 추천(POST /api/v1/recommendations/by-type)
# =========================================================================

def test_recommend_by_type_happy_path(auth_client):
    cafes = [
        _facility("c-1", "cafe", 0.0002),
        _facility("c-2", "cafe", 0.0004, coupon_rate=0.1),
        _facility("c-3", "cafe", 0.0006),
        _facility("c-4", "cafe", 0.0008),
    ]
    others = [_facility("r-1", "restaurant", 0.0003), _facility("a-1", "attraction", 0.0005)]
    congestion_map = {f["id"]: 0.2 for f in cafes}

    with patch("app.routers.recommendations.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.recommendations.fetch_all_facilities", new=AsyncMock(return_value=cafes + others)), \
         patch("app.routers.recommendations.fetch_congestion_map", new=AsyncMock(return_value=congestion_map)), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)), \
         patch("app.routers.recommendations.generate_reason", new=AsyncMock(return_value="사유")):
        res = auth_client.post("/api/v1/recommendations/by-type", json={
            "user_id": AUTH_USER_ID,
            "facility_type": "cafe",
            "user_lat": BASE_LAT,
            "user_lng": BASE_LNG,
        })

    assert res.status_code == 200
    items = res.json()
    assert len(items) == 4  # cafe 후보 전부(기본 limit 5 이내)
    # 요청한 타입만 + 합성 recommendation_id(브라우즈 랭킹은 DB 미기록)
    assert all(item["facility"]["type"] == "cafe" for item in items)
    assert all(item["recommendation_id"].startswith("bytype-") for item in items)
    scores = [item["spot_score"] for item in items]
    assert scores == sorted(scores, reverse=True)
    assert [item["rank"] for item in items] == [1, 2, 3, 4]


# =========================================================================
# 4. 피드백(POST /api/v1/feedback) — 소유권 가드·입력 검증
# =========================================================================

def test_feedback_ownership_guard(auth_client):
    # 타인 user_id 의 추천 기록에 피드백 → 403 (선호벡터 오염 차단)
    other_rec = [{"id": "rec-9", "user_id": "other-user", "recommended_facility_id": "f-1"}]
    with patch("app.routers.recommendations.supabase_client", new=FakeSupabase({"recommendations": other_rec})):
        res = auth_client.post("/api/v1/feedback", json={"recommendation_id": "rec-9", "action": "accepted"})
    assert res.status_code == 403


def test_feedback_invalid_action_422(auth_client):
    # action 은 Literal[accepted/rejected/ignored] — 잘못된 값은 라우터 진입 전 422
    res = auth_client.post("/api/v1/feedback", json={"recommendation_id": "rec-1", "action": "loved"})
    assert res.status_code == 422


# =========================================================================
# 5. 관리자 가드(require_admin) — X-Admin-Authorization 단일 경로
# =========================================================================

def test_admin_inquiries_no_header_401(client):
    res = client.get("/api/v1/admin/inquiries")
    assert res.status_code == 401


def test_admin_inquiries_plain_authorization_header_401(client):
    # 일반 Authorization 헤더 폴백은 제거됨 — 올바른 토큰이라도 401
    res = client.get(
        "/api/v1/admin/inquiries",
        headers={"Authorization": f"Bearer {settings.ADMIN_API_TOKEN}"},
    )
    assert res.status_code == 401


def test_admin_inquiries_wrong_token_401(client):
    res = client.get("/api/v1/admin/inquiries", headers=_admin_headers("wrong-token"))
    assert res.status_code == 401


def test_admin_inquiries_ok(client):
    with patch("app.routers.admin.supabase_admin", new=FakeSupabase({"inquiries": []})):
        res = client.get("/api/v1/admin/inquiries", headers=_admin_headers())
    assert res.status_code == 200
    assert res.json() == []


def test_admin_simulate_peak_no_header_401(client):
    # infrastructures 라우터의 관리자 엔드포인트도 동일 가드로 보호된다
    res = client.post("/api/v1/admin/simulate-peak")
    assert res.status_code == 401


# =========================================================================
# 6. 관리자 시설 CRUD — 입력 검증
# =========================================================================

def test_admin_facility_create_invalid_type_422(client):
    res = client.post(
        "/api/v1/admin/facilities",
        headers=_admin_headers(),
        json={"name": "새 시설", "type": "factory", "capacity": 10, "latitude": BASE_LAT, "longitude": BASE_LNG},
    )
    assert res.status_code == 422


def test_admin_facility_update_no_fields_422(client):
    res = client.patch("/api/v1/admin/facilities/f-1", headers=_admin_headers(), json={})
    assert res.status_code == 422


def test_admin_facility_update_coupon_rate_out_of_range_422(client):
    # coupon_rate 는 DB CHECK 와 동일한 0~1 범위 — 초과 값은 라우터 진입 전 422
    res = client.patch(
        "/api/v1/admin/facilities/f-1", headers=_admin_headers(), json={"coupon_rate": 1.5}
    )
    assert res.status_code == 422


def test_admin_facility_update_coupon_rate_ok(client):
    # 개입 폐루프: 쿠폰 정책 패널이 coupon_rate 만 단독 PATCH 한다(0.0 도 유효한 '제휴 해제').
    updated = {"id": "f-1", "name": "시설-f-1", "coupon_rate": 0.15}
    with patch("app.routers.admin.supabase_admin", new=FakeSupabase({"facilities": [updated]})):
        res = client.patch(
            "/api/v1/admin/facilities/f-1", headers=_admin_headers(), json={"coupon_rate": 0.15}
        )
    assert res.status_code == 200
    assert res.json()["coupon_rate"] == 0.15


# =========================================================================
# 7. 관리자 시스템 설정(PUT /api/v1/admin/settings)
# =========================================================================

SETTINGS_BODY = {
    "maintenance_mode": False,
    "notice_text": "점검 없음",
    "congestion_threshold": 70,
    "coldstart_weight": 50,
}


def test_admin_settings_put_ok(client):
    updated_row = {"id": 1, **SETTINGS_BODY}
    with patch("app.routers.admin.supabase_admin", new=FakeSupabase({"system_settings": [updated_row]})):
        res = client.put("/api/v1/admin/settings", headers=_admin_headers(), json=SETTINGS_BODY)
    assert res.status_code == 200
    assert res.json()["congestion_threshold"] == 70


def test_admin_settings_put_404_when_no_row(client):
    # UPDATE 가 0행이면 404 (마이그레이션 미적용 환경 안내)
    with patch("app.routers.admin.supabase_admin", new=FakeSupabase({"system_settings": []})):
        res = client.put("/api/v1/admin/settings", headers=_admin_headers(), json=SETTINGS_BODY)
    assert res.status_code == 404


# =========================================================================
# 7-1. 분산 효과 집계(GET /api/v1/admin/impact) — 절감 대기시간 산식
# =========================================================================

def test_admin_impact_no_header_401(client):
    res = client.get("/api/v1/admin/impact")
    assert res.status_code == 401


def test_admin_impact_invalid_since_422(client):
    res = client.get("/api/v1/admin/impact?since=not-a-date", headers=_admin_headers())
    assert res.status_code == 422


def test_admin_impact_aggregation(client):
    # 수락 추천 3건: 실측(original_wait_time) 1건 + 레거시 근사(incentive_relief×15분) 1건 + 데이터 없음 1건
    accepted_rows = [
        {"created_at": "2026-07-09T01:00:00+00:00",
         "score_breakdown": {"original_wait_time": 20.0, "wait_time": 5.0}},   # 절감 15.0분(실측)
        {"created_at": "2026-07-09T02:00:00+00:00",
         "score_breakdown": {"incentive_relief": 0.4, "wait_time": 3.0}},      # 절감 0.4×15=6.0분(근사)
        {"created_at": "2026-07-09T03:00:00+00:00", "score_breakdown": {}},    # 절감 산정 불가 — 건수만 집계
    ]
    with patch("app.routers.admin.supabase_admin", new=FakeSupabase({"recommendations": accepted_rows})):
        res = client.get("/api/v1/admin/impact?since=2026-07-09T00:00:00Z", headers=_admin_headers())

    assert res.status_code == 200
    body = res.json()
    assert body["relocations"] == 3
    assert body["saved_wait_minutes"] == 21.0
    assert body["measured"] == 1
    assert body["estimated"] == 1


# --- 이 테스트 전용 '필터 인지' 가짜 ---
# 공유 FakeTable 은 .eq/.gte 를 흡수만 해 accepted·since 필터 회귀를 못 잡는다(집계 산술만 검증).
# 아래 가짜는 .eq/.gte 인자를 기록했다가 execute()에서 canned 행에 파이썬으로 실제 적용한다.
# (공유 FakeSupabase/FakeTable 은 손대지 않아 나머지 테스트가 그대로 통과한다.)
def _as_dt(value):
    # ISO8601 문자열을 비교용 datetime 으로 변환. router 가 since 를 fromisoformat 로
    # 정규화해 넘기고 canned created_at 도 동일 형식이라 파싱이 안전하다.
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


class FilteringFakeTable:
    """.eq/.gte 를 기록해 execute()에서 실제로 필터링하는 FakeTable(이 테스트 전용).

    - eq(col, val)  : row.get(col) == val 인 행만 통과
    - gte(col, val) : _as_dt(row.get(col)) >= _as_dt(val) 인 행만 통과
    - 그 외 체이닝(select/limit 등)은 흡수(self 반환) — 필터와 무관.
    """

    def __init__(self, data):
        self._data = data
        self._eq = []   # [(column, value), ...]
        self._gte = []  # [(column, value), ...]

    def eq(self, column, value):
        self._eq.append((column, value))
        return self

    def gte(self, column, value):
        self._gte.append((column, value))
        return self

    def __getattr__(self, _name):
        def _chain(*_args, **_kwargs):
            return self

        return _chain

    def execute(self):
        rows = list(self._data)
        for column, value in self._eq:
            rows = [r for r in rows if r.get(column) == value]
        for column, value in self._gte:
            rows = [r for r in rows if _as_dt(r.get(column)) >= _as_dt(value)]
        return _FakeResult(rows)


class FilteringFakeSupabase:
    """table(name) → FilteringFakeTable. (공유 FakeSupabase 와 분리)"""

    def __init__(self, tables: dict):
        self._tables = tables

    def table(self, name: str) -> FilteringFakeTable:
        return FilteringFakeTable(self._tables.get(name, []))


def test_admin_impact_filters_accepted_and_since(client):
    # 필터 회귀 방지: /impact 의 .eq("accepted",True)·.gte("created_at",since) 가 실제로 동작해
    # accepted=False 행과 since 이전 행이 집계에서 제외되는지 검증한다.
    rows = [
        # 포함(실측): accepted & since 이후 → 절감 15.0분
        {"accepted": True, "created_at": "2026-07-09T01:00:00+00:00",
         "score_breakdown": {"original_wait_time": 20.0, "wait_time": 5.0}},
        # 포함(근사): accepted & since 이후 → 0.4×15=6.0분
        {"accepted": True, "created_at": "2026-07-09T02:00:00+00:00",
         "score_breakdown": {"incentive_relief": 0.4, "wait_time": 3.0}},
        # 제외: accepted=False(미수락 추천) — 큰 값이라 잘못 포함되면 즉시 드러난다.
        {"accepted": False, "created_at": "2026-07-09T04:00:00+00:00",
         "score_breakdown": {"original_wait_time": 99.0, "wait_time": 1.0}},
        # 제외: since 이전(윈도우 밖) — 역시 큰 값으로 회귀를 노출한다.
        {"accepted": True, "created_at": "2026-07-08T23:00:00+00:00",
         "score_breakdown": {"original_wait_time": 88.0, "wait_time": 1.0}},
    ]
    with patch("app.routers.admin.supabase_admin",
               new=FilteringFakeSupabase({"recommendations": rows})):
        res = client.get("/api/v1/admin/impact?since=2026-07-09T00:00:00Z", headers=_admin_headers())

    assert res.status_code == 200
    body = res.json()
    # 4행 중 accepted & since 이후 2행만 집계 — 나머지 2행(미수락/윈도우 밖)은 제외.
    assert body["relocations"] == 2
    assert body["saved_wait_minutes"] == 21.0
    assert body["measured"] == 1
    assert body["estimated"] == 1


# =========================================================================
# 7-3. 오늘(KST) 혼잡 집계(GET /api/v1/admin/dashboard/today) — 서버측 집계 이관(최적화 #4)
# =========================================================================

def test_admin_dashboard_today_no_header_401(client):
    res = client.get("/api/v1/admin/dashboard/today")
    assert res.status_code == 401


def test_admin_dashboard_today_aggregation(client):
    # 시설 2곳의 오늘 로그(>=5건, 이상 피크 1건 포함). 공유 FakeSupabase 는 gte/lte 를 흡수하므로
    # 어제(변화율) 쿼리도 동일 canned 를 돌려주지만, shape/집계 검증에는 영향이 없다.
    # KST시 환산: 00:00Z→9시, 00:30Z→9시, 01:00Z→10시.
    logs = [
        {"congestion_level": 0.5, "current_count": 25, "timestamp": "2026-07-09T00:00:00+00:00",
         "facility": {"name": "황리단길", "type": "attraction"}},
        {"congestion_level": 0.6, "current_count": 30, "timestamp": "2026-07-09T00:30:00+00:00",
         "facility": {"name": "황리단길", "type": "attraction"}},
        {"congestion_level": 0.95, "current_count": 48, "timestamp": "2026-07-09T01:00:00+00:00",
         "facility": {"name": "황리단길", "type": "attraction"}},
        # 조인이 list 형태로 와도 안전 추출되는지 겸사겸사 검증(_joined_facility)
        {"congestion_level": 0.2, "current_count": 10, "timestamp": "2026-07-09T00:00:00+00:00",
         "facility": [{"name": "대릉원", "type": "culture"}]},
        {"congestion_level": 0.3, "current_count": 15, "timestamp": "2026-07-09T00:00:00+00:00",
         "facility": [{"name": "대릉원", "type": "culture"}]},
    ]
    with patch("app.routers.admin.supabase_admin", new=FakeSupabase({"congestion_logs": logs})):
        res = client.get("/api/v1/admin/dashboard/today", headers=_admin_headers())

    assert res.status_code == 200
    body = res.json()
    assert set(body) == {"hasLogs", "avgCongestion", "anomalyCount", "heatmap", "anomalies"}
    assert body["hasLogs"] is True
    # 평균 (0.5+0.6+0.95+0.2+0.3)/5 = 0.51, 이상(>=0.9) 1건
    assert body["avgCongestion"]["value"] == 0.51
    assert body["anomalyCount"] == 1

    # 히트맵 셀: 황리단길 9시 = (0.5+0.6)/2 = 0.55, 로그 없는 시간대(0시)는 null 센티넬
    cell = next(c for c in body["heatmap"] if c["facility"] == "황리단길" and c["hour"] == 9)
    assert cell["value"] == 0.55
    assert cell["facilityType"] == "attraction"
    empty_cell = next(c for c in body["heatmap"] if c["facility"] == "황리단길" and c["hour"] == 0)
    assert empty_cell["value"] is None

    # 이상 알림: 황리단길 0.95 피크 1건(시설별 최고 1건)
    assert len(body["anomalies"]) == 1
    anomaly = body["anomalies"][0]
    assert anomaly["facilityName"] == "황리단길"
    assert anomaly["congestionLevel"] == 0.95
    assert anomaly["durationMinutes"] == 30
    assert anomaly["id"] == "황리단길-2026-07-09T01:00:00+00:00"


# =========================================================================
# 7-2. 예측 모델 메타(GET /predict/model-info) — 정확도 배지 데이터
# =========================================================================

def test_predict_model_info(client):
    canned = {"trained": True, "metrics": {"mae": 0.08, "baseline_mae": 0.15, "holdout_n": 200}}
    with patch("app.routers.predict.get_model_info", return_value=canned):
        res = client.get("/predict/model-info")
    assert res.status_code == 200
    body = res.json()
    assert body["trained"] is True
    assert body["metrics"]["mae"] == 0.08


def test_predict_model_info_untrained(client):
    # model.pkl 부재(미학습) — trained=False, metrics=None (배지는 '평가 전' 표기)
    with patch("app.routers.predict.get_model_info", return_value={"trained": False, "metrics": None}):
        res = client.get("/predict/model-info")
    assert res.status_code == 200
    assert res.json() == {"trained": False, "metrics": None}


# =========================================================================
# 8. 시설 목록(GET /api/v1/infrastructures) — 혼잡도 병합
# =========================================================================

def test_infrastructures_happy_path(client):
    facilities = [
        {**_facility("f-1", "cafe", 0.0002), "operating_hours": {"open": "09:00"}},
        {**_facility("f-2", "restaurant", 0.0004), "operating_hours": None},
    ]
    congestion = {
        "f-1": {"level": 0.4, "current_count": 20, "timestamp": "2026-07-07T09:00:00+00:00"},
        # f-2 는 혼잡 로그 없음 → congestion=None 이어야 함
    }
    with patch("app.routers.infrastructures.supabase_client", new=FakeSupabase({"facilities": facilities})), \
         patch("app.routers.infrastructures.fetch_latest_congestion_for_all", new=AsyncMock(return_value=congestion)):
        res = client.get("/api/v1/infrastructures")

    assert res.status_code == 200
    items = res.json()
    assert [item["id"] for item in items] == ["f-1", "f-2"]
    assert items[0]["congestion"] == {"level": 0.4, "current_count": 20, "timestamp": "2026-07-07T09:00:00+00:00"}
    assert items[1]["congestion"] is None


# =========================================================================
# 9. 혼잡 제보(POST /api/v1/reports/congestion) — 인증 가드·라벨 매핑·행복 경로
# =========================================================================

def test_report_congestion_requires_auth(client):
    # 인증 헤더 없음 → 401 (get_current_user 실경로 — 익명 대량 조작 1차 차단)
    res = client.post("/api/v1/reports/congestion", json={"facility_id": "f-1", "level": "혼잡"})
    assert res.status_code == 401


def test_report_congestion_facility_not_found_404(auth_client):
    # 존재하지 않는 시설 → 404 (유령 로그/FK 위반 방지)
    with patch("app.routers.reports.supabase_admin", new=FakeSupabase({"facilities": []})):
        res = auth_client.post(
            "/api/v1/reports/congestion", json={"facility_id": "ghost", "level": "보통"}
        )
    assert res.status_code == 404


def test_report_congestion_invalid_label_422(auth_client):
    # 잘못된 라벨(3지선다·수치 아님)은 pydantic union 검증에서 422
    res = auth_client.post(
        "/api/v1/reports/congestion", json={"facility_id": "f-1", "level": "매우혼잡"}
    )
    assert res.status_code == 422


def test_report_congestion_happy_path(auth_client):
    # '혼잡'(→0.9) 제보 → capacity(50)×0.9=45, source='user_report' 로 기록.
    # FakeSupabase 는 facilities 조회와 congestion_logs INSERT 둘 다 canned 로 응답.
    facility = _facility("f-1", "cafe", 0.0002)  # capacity=50
    inserted = {
        "id": "log-1",
        "facility_id": "f-1",
        "congestion_level": 0.9,
        "current_count": 45,
        "source": "user_report",
        "timestamp": "2026-07-10T05:00:00+00:00",
    }
    with patch(
        "app.routers.reports.supabase_admin",
        new=FakeSupabase({"facilities": [facility], "congestion_logs": [inserted]}),
    ):
        res = auth_client.post(
            "/api/v1/reports/congestion", json={"facility_id": "f-1", "level": "혼잡"}
        )

    assert res.status_code == 200
    body = res.json()
    assert body["success"] is True
    assert body["facility_id"] == "f-1"
    assert body["congestion_level"] == 0.9
    assert body["current_count"] == 45
    assert body["source"] == "user_report"


def test_report_congestion_rate_limited_429(auth_client):
    # 같은 사용자·시설로 연속 제보 → 두 번째는 쿨다운(5분)으로 429 (스팸/조작 1차 차단).
    from app.routers.reports import _last_report_at
    _last_report_at.clear()  # 다른 테스트가 남긴 전역 쿨다운 상태 격리
    facility = _facility("f-1", "cafe", 0.0002)
    inserted = {
        "id": "log-1", "facility_id": "f-1", "congestion_level": 0.9,
        "current_count": 45, "source": "user_report", "timestamp": "2026-07-10T05:00:00+00:00",
    }
    with patch(
        "app.routers.reports.supabase_admin",
        new=FakeSupabase({"facilities": [facility], "congestion_logs": [inserted]}),
    ):
        first = auth_client.post("/api/v1/reports/congestion", json={"facility_id": "f-1", "level": "혼잡"})
        second = auth_client.post("/api/v1/reports/congestion", json={"facility_id": "f-1", "level": "혼잡"})
    assert first.status_code == 200
    assert second.status_code == 429
    assert "Retry-After" in second.headers
