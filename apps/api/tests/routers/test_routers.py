# FastAPI 라우터 통합 테스트 — 실제 DB/네트워크 없이 라우터 계층(인증 가드·검증·직렬화)을 검증한다.
#  · 인증: get_current_user 는 dependency_overrides 로 대체(워커 경로),
#         관리자 가드(require_role(ROLE_ADMIN))는 실제 JWT 검증 경로(conftest 의 admin_headers)를 그대로 태운다.
#  · DB: 라우터 헬퍼(fetch_user 등)는 AsyncMock 으로, supabase 클라이언트는 체이닝을 흡수하는
#        FakeSupabase(canned 데이터) 로 대체 — PostgREST 호출이 전혀 발생하지 않는다.
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from tests.conftest import (
    ADMIN_USER_ID,  # noqa: F401 — 하위 테스트에서 참조
    admin_headers as conftest_admin_headers,
)
from fastapi.testclient import TestClient

from app.main import app
from app.core.config import settings
from app.core.supabase import get_current_user
from app.services.preference_vector_service import preference_vector_service
from app.routers.recommendations import resolve_congestion_evidence
from app.routers.infrastructures import (
    _SIMULATE_INSERT_CHUNK,
    _SIMULATE_NORMAL_RATIO,
    _SIMULATE_RELAXED_RATIO,
    _exact_current_count,
)
from app.services.spot.travel import WalkingRoute, calculate_haversine_distance

# --- 공통 상수 (경주 황리단길 좌표 기준 — 기존 서비스 테스트와 통일) ---
BASE_LAT, BASE_LNG = 35.8360, 129.2100
AUTH_USER_ID = "u-1"
BREAKDOWN_KEYS = (
    "preference", "wait_time", "travel_time", "incentive", "incentive_coupon", "incentive_relief",
    "original_wait_time",  # 분산 효과 집계용 스냅샷(원본 예상대기) — /admin/impact 가 소비
)


@pytest.mark.asyncio
async def test_measured_congestion_remains_visible_without_trained_model():
    log = {
        "level": 0.2,
        "source": "user_report",
        "evidence_tier": "corroborated",
        "is_stale": False,
        "timestamp": "2026-08-20T03:00:00+00:00",
    }
    with patch("app.routers.recommendations.get_model_info", return_value={"trained": False}):
        evidence = await resolve_congestion_evidence({"type": "cafe"}, log)
    assert evidence["source"] == "measured"
    assert evidence["level"] == pytest.approx(0.2)
    assert evidence["log_source"] == "user_report"
    assert evidence["evidence_tier"] == "corroborated"


def test_qualitative_reports_never_expose_estimated_headcount():
    """체감 단계는 보여주되 capacity 환산값을 실제 인원으로 내보내지 않는다."""
    assert _exact_current_count({"source": "user_report", "current_count": 40}) is None
    assert _exact_current_count({"source": "merchant_report", "current_count": 20}) is None
    assert _exact_current_count({"source": "event", "current_count": 30}) is None
    assert _exact_current_count({"source": "traffic_cctv", "current_count": 17}) == 17


def _admin_headers(sub: str | None = None) -> dict:
    # 관리자 판정은 JWT + users.role 이다(공유 토큰 가드는 폐지).
    # sub 를 넘기면 그 사용자의 역할로 평가된다 — 권한 없는 계정 테스트에 쓴다.
    return conftest_admin_headers(sub)


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
# 추천·코스 라우터의 후보 자격 판정은 **도착 시각**에 의존한다:
#   · 도착 후 30분 안에 닫히면 제외(closing_soon)
#   · 심야(22:00~06:00 KST)에는 영업 미확인 식당·카페를 제외
# 실행 시각에 따라 결과가 달라지면 CI 가 간헐 실패한다(실측 2026-08-27 23:26 KST:
# 코스 3건이 빈 배열, 추천이 5개 대신 2~4개 — 실행마다 숫자가 달랐다).
# 그래서 라우터가 읽는 datetime.now 를 낮 시각으로 고정한다.
_FROZEN_UTC = datetime(2026, 8, 27, 3, 0, tzinfo=timezone.utc)  # = 12:00 KST


def _frozen_datetime():
    """now() 만 고정한 datetime 대체 클래스. timedelta·timezone 사용부는 그대로 동작한다."""

    class _Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return _FROZEN_UTC.astimezone(tz) if tz else _FROZEN_UTC.replace(tzinfo=None)

    return _Frozen


@pytest.fixture(autouse=True)
def _freeze_router_clock():
    """추천·코스 라우터의 now() 를 낮 12:00 KST 로 고정한다.

    이 파일의 테스트는 후보 자격 판정(closing_soon·심야 규칙)을 거치므로 실행 시각에 따라
    결과가 달라진다. 고정하지 않으면 CI 가 밤에만 깨진다.
    """
    frozen = _frozen_datetime()
    with patch("app.routers.courses.datetime", frozen),          patch("app.routers.recommendations.datetime", frozen):
        yield


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
        # 추천 테스트의 카페·식당은 영업이 확인된 후보라는 계약을 명시한다.
        # ⚠️ 이 표기만으로는 실행 시각 독립이 되지 않는다 — 어떤 24시간 표기를 써도
        #    '도착 후 30분 내 마감'(closing_soon) 규칙에 걸리는 구간이 반드시 생긴다
        #    (실측: 00:00~23:59 는 23:29~23:59 도착에서 closing_soon 이 되어 전부 탈락).
        #    그래서 시각 자체를 _frozen_now 로 고정한다. 아래 _FROZEN_UTC 참조.
        "operating_hours": {"open": "00:00~23:59, 23:58~00:01", "closed": "연중무휴"},
    }


def _cong(level: float, *, source: str = "seed", is_stale: bool = False) -> dict:
    """fetch_congestion_map / fetch_latest_congestion_for_all 의 로그 info 계약
    (CONGESTION_TRUST_SPEC — 로그 없는 시설은 맵에서 누락, 0.0 합성 금지)."""
    return {
        "level": level,
        "current_count": round(level * 50),
        "timestamp": "2026-07-18T00:00:00+00:00",
        "source": source,
        "is_stale": is_stale,
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


def test_recommendation_explain_uses_owned_snapshot(auth_client):
    recommendation_id = "11111111-1111-1111-1111-111111111111"
    row = {
        "id": recommendation_id,
        "user_id": AUTH_USER_ID,
        "recommendation_snapshot": {
            "facility_name": "첨성대", "spot_score": 0.91, "rank": 1,
            "breakdown": {"travel_time": 8, "wait_time": 3}, "tourapi_facts": {},
        },
    }
    with patch("app.routers.recommendations.supabase_client", new=FakeSupabase({"recommendations": [row]})), \
         patch("app.routers.recommendations.explain_snapshot", new=AsyncMock(return_value=("고정 설명", ["SPOT 근거 설명"], "disabled"))):
        res = auth_client.post(
            f"/api/v1/recommendations/{recommendation_id}/explain", json={"question": "why_first"}
        )
    assert res.status_code == 200
    assert res.json() == {"answer": "고정 설명", "source_labels": ["SPOT 근거 설명"], "llm_status": "disabled"}


def test_recommendation_explain_rejects_other_owner(auth_client):
    recommendation_id = "11111111-1111-1111-1111-111111111111"
    row = {"id": recommendation_id, "user_id": "other-user", "recommendation_snapshot": {}}
    with patch("app.routers.recommendations.supabase_client", new=FakeSupabase({"recommendations": [row]})):
        res = auth_client.post(
            f"/api/v1/recommendations/{recommendation_id}/explain", json={"question": "why_first"}
        )
    assert res.status_code == 403


def test_recommendation_explain_rejects_freeform_question(auth_client):
    recommendation_id = "11111111-1111-1111-1111-111111111111"
    res = auth_client.post(
        f"/api/v1/recommendations/{recommendation_id}/explain",
        json={"question": "새 점수로 순위를 바꿔줘"},
    )
    assert res.status_code == 422


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
    congestion_map = {f["id"]: _cong(0.1 * (i + 1)) for i, f in enumerate(near)}

    with patch("app.routers.recommendations.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.recommendations.fetch_facility", new=AsyncMock(return_value=ORIGIN_ROW)), \
         patch("app.routers.recommendations.fetch_all_facilities", new=AsyncMock(return_value=[ORIGIN_ROW] + near + far)), \
         patch("app.routers.recommendations.fetch_congestion_map", new=AsyncMock(return_value=congestion_map)), \
         patch("app.routers.recommendations.get_model_info", return_value={"trained": True}), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)), \
         patch("app.routers.recommendations.generate_reason_with_source", new=AsyncMock(return_value=("사유", "template"))), \
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
        # 후보 eligibility는 150m 직선 반경이고, 응답 distance_m은 OSM 실제 보행로라
        # 도로 형태에 따라 200m도 넘을 수 있다. 선정 반경 자체를 좌표로 검증한다.
        facility = item["facility"]
        straight_distance = calculate_haversine_distance(
            BASE_LAT, BASE_LNG, facility["latitude"], facility["longitude"]
        )
        assert straight_distance <= 150.0
        assert item["distance_m"] >= straight_distance
        assert item["reason"] == "사유"
        assert item["reason_source"] == "template"
        assert item["recommendation_id"] == "rec-1"  # _persist 가 INSERT 결과 id 를 매핑
        # 혼잡 단계는 표시하지만 정성/seed 로그의 환산 인원은 실제 잔여석으로 노출하지 않는다.
        fid = item["facility"]["id"]
        assert item["congestion_source"] == "measured"
        assert item["congestion_level"] == pytest.approx(congestion_map[fid]["level"])
        assert item["congestion_log_source"] == "seed"
        assert item["congestion_is_stale"] is False
        assert item["facility"]["current_count"] is None


def test_discovery_recommendations_keep_reference_but_limit_alternative_type(auth_client):
    candidates = [
        _facility("cafe-1", "cafe", 0.0002),
        _facility("attraction-1", "attraction", 0.0003),
        _facility("culture-1", "culture", 0.0004),
    ]
    candidates[0]["features"]["category"] = "한옥 카페"
    with patch("app.routers.recommendations.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.recommendations.fetch_facility", new=AsyncMock(return_value=ORIGIN_ROW)), \
         patch("app.routers.recommendations.fetch_all_facilities", new=AsyncMock(return_value=[ORIGIN_ROW] + candidates)), \
         patch("app.routers.recommendations.fetch_congestion_map", new=AsyncMock(return_value={})), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)), \
         patch("app.routers.recommendations.generate_reason_with_source", new=AsyncMock(return_value=("사유", "template"))):
        body = {
            **_reco_body(),
            "candidate_types": ["cafe"],
            "discovery_theme": "hanok_cafe",
            "preference_intent": "한옥 감성 카페 디저트",
        }
        response = auth_client.post("/api/v1/recommendations", json=body)

    assert response.status_code == 200
    items = response.json()
    assert [item["facility"]["id"] for item in items] == ["cafe-1"]
    assert items[0]["facility"]["type"] == "cafe"


def test_discovery_recommendations_reject_unknown_theme(auth_client):
    response = auth_client.post("/api/v1/recommendations", json={
        **_reco_body(), "candidate_types": ["cafe"], "discovery_theme": "made_up"
    })
    assert response.status_code == 422


def test_recommendations_no_log_untrained_model_reports_none(auth_client):
    # 혼잡 로그 0건 + 모델 미학습(0.5 평탄 폴백): 0.0/0.5 를 실측·예측처럼 팔지 않는다 —
    # congestion_source='none', current_count=None, 사유에 혼잡 수치(%) 없음(CONGESTION_TRUST_SPEC).
    near = [_facility("f-1", "cafe", 0.0002), _facility("f-2", "restaurant", 0.0004)]

    with patch("app.routers.recommendations.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.recommendations.fetch_facility", new=AsyncMock(return_value=ORIGIN_ROW)), \
         patch("app.routers.recommendations.fetch_all_facilities", new=AsyncMock(return_value=[ORIGIN_ROW] + near)), \
         patch("app.routers.recommendations.fetch_congestion_map", new=AsyncMock(return_value={})), \
         patch("app.routers.recommendations.predict_congestion_detailed", return_value=(0.5, "default")), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)), \
         patch("app.routers.recommendations.supabase_client", new=FakeSupabase({"recommendations": [{"id": "rec-1"}]})):
        res = auth_client.post("/api/v1/recommendations", json=_reco_body())

    assert res.status_code == 200
    items = res.json()
    assert len(items) == 2
    for item in items:
        assert item["congestion_source"] == "none"
        assert item["congestion_level"] is None
        assert item["congestion_log_source"] is None
        assert item["facility"]["current_count"] is None  # '잔여석=정원 전체' 합성 금지
        # 실제 템플릿 사유(LLM 은 conftest 로 비활성): 혼잡 수치를 말하지 않고 준비 중임을 밝힌다.
        assert "%" not in item["reason"]
        assert "준비 중" in item["reason"]


def test_recommendations_no_log_trained_model_reports_predicted(auth_client):
    # 혼잡 로그 0건 + 모델이 실제로 학습됨: AI 예측으로 정직 표시 —
    # congestion_source='predicted', 예측값 동봉, current_count=None, 사유에 'AI 예측' 명시.
    near = [_facility("f-1", "cafe", 0.0002)]

    with patch("app.routers.recommendations.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.recommendations.fetch_facility", new=AsyncMock(return_value=ORIGIN_ROW)), \
         patch("app.routers.recommendations.fetch_all_facilities", new=AsyncMock(return_value=[ORIGIN_ROW] + near)), \
         patch("app.routers.recommendations.fetch_congestion_map", new=AsyncMock(return_value={})), \
         patch("app.routers.recommendations.predict_congestion_detailed", return_value=(0.42, "registry")), \
         patch("app.routers.recommendations.get_model_info", return_value={"trained": True}), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)), \
         patch("app.routers.recommendations.supabase_client", new=FakeSupabase({"recommendations": [{"id": "rec-1"}]})):
        res = auth_client.post("/api/v1/recommendations", json=_reco_body())

    assert res.status_code == 200
    items = res.json()
    assert len(items) == 1
    item = items[0]
    assert item["congestion_source"] == "predicted"
    assert item["congestion_level"] == pytest.approx(0.42)
    assert item["facility"]["current_count"] is None
    assert "AI 예측" in item["reason"]
    assert "예상 혼잡도 42%" in item["reason"]


# --- 2-1. 사장님 오버레이(머천트 랭킹 연동)가 메인 추천에도 걸리는지 -------------------
# 배경: apply_merchant_boosts 호출부가 by-type/코스/쿠폰 발급 3곳에만 있어서, 사장님이 건
# 타임세일이 **메인 분산 추천(POST /recommendations) 랭킹에는 전혀 반영되지 않았다**.
# 아래 두 테스트가 그 회귀를 잠근다 — 오버레이가 '점수 계산 전에' 걸려야만 통과한다.


def _timesale_row(facility_id: str, rate: float) -> dict:
    """merchant_timesales 의 활성 세일 1행.

    활성 판정(now ∈ [starts_at, ends_at] · canceled_at is null)은 PostgREST 필터로 나가고
    FakeSupabase 는 그 체이닝을 전부 흡수하므로, 여기서는 facility_id·rate 만 의미가 있다.
    """
    return {
        "facility_id": facility_id,
        "rate": rate,
        "starts_at": "2026-08-27T00:00:00+00:00",
        "ends_at": "2026-08-28T00:00:00+00:00",
        "canceled_at": None,
    }


def _run_main_reco(auth_client, facilities: list[dict], tables: dict, congestion_map: dict) -> dict:
    """메인 추천을 1회 호출하고 시설 id → 응답 항목 맵을 돌려준다."""
    with patch("app.routers.recommendations.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.recommendations.fetch_facility", new=AsyncMock(return_value=ORIGIN_ROW)), \
         patch("app.routers.recommendations.fetch_all_facilities", new=AsyncMock(return_value=[ORIGIN_ROW] + facilities)), \
         patch("app.routers.recommendations.fetch_congestion_map", new=AsyncMock(return_value=congestion_map)), \
         patch("app.routers.recommendations.get_model_info", return_value={"trained": True}), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)), \
         patch("app.routers.recommendations.generate_reason_with_source", new=AsyncMock(return_value=("사유", "template"))), \
         patch("app.routers.recommendations.supabase_client", new=FakeSupabase(tables)):
        res = auth_client.post("/api/v1/recommendations", json=_reco_body())
    assert res.status_code == 200
    return {item["facility"]["id"]: item for item in res.json()}


def test_main_recommendations_apply_active_timesale_boost(auth_client):
    """활성 타임세일이 메인 추천의 점수·응답 쿠폰율에 반영된다(같은 후보로 유/무 2회 비교).

    쿠폰율은 score.py 의 인센티브 항 입력이므로, 오버레이가 스코어링 **전에** 걸려야만
    spot_score 가 올라간다. 점수 계산 뒤에 얹으면 coupon_rate 표기만 바뀌고 점수는 그대로다.
    """
    near = [_facility("c-1", "cafe", 0.0002), _facility("c-2", "cafe", 0.0004)]
    congestion_map = {f["id"]: _cong(0.2) for f in near}
    recommendations_table = {"recommendations": [{"id": "rec-1"}]}

    baseline = _run_main_reco(
        auth_client, near, {**recommendations_table, "merchant_timesales": []}, congestion_map
    )
    boosted = _run_main_reco(
        auth_client, near,
        {**recommendations_table, "merchant_timesales": [_timesale_row("c-2", 0.25)]},
        congestion_map,
    )

    assert set(baseline) == set(boosted) == {"c-1", "c-2"}
    # 세일을 건 시설만 유효 쿠폰율이 갈아끼워지고 배지용 timesale_rate 가 붙는다.
    assert baseline["c-2"]["facility"]["coupon_rate"] == pytest.approx(0.0)
    assert boosted["c-2"]["facility"]["coupon_rate"] == pytest.approx(0.25)
    assert boosted["c-2"]["facility"]["timesale_rate"] == pytest.approx(0.25)
    # 점수에 실제로 반영된다(= 스코어링 전에 얹혔다).
    assert boosted["c-2"]["spot_score"] > baseline["c-2"]["spot_score"]
    assert boosted["c-2"]["breakdown"]["incentive_coupon"] > baseline["c-2"]["breakdown"]["incentive_coupon"]
    # 세일 없는 이웃은 점수·쿠폰율 모두 그대로 — 오버레이가 후보 전체를 물들이지 않는다.
    assert boosted["c-1"]["spot_score"] == pytest.approx(baseline["c-1"]["spot_score"])
    assert "timesale_rate" not in boosted["c-1"]["facility"]
    # 랭킹까지 뒤집힌다: c-2 는 c-1 보다 멀지만(거리 항 손해) 25% 세일이 그 손해를 넘어선다.
    # baseline 에서는 가까운 c-1 이 1위였다 — 즉 이 뒤집힘 자체가 '세일이 랭킹에 반영됨'의 증거다.
    assert baseline["c-1"]["rank"] == 1
    assert boosted["c-2"]["rank"] == 1


def test_main_recommendations_use_fresh_seat_status_as_measured_congestion(auth_client):
    """30분 이내 좌석 상태 방송은 메인 추천에서도 '실측'으로 쓰이고, 내부 키는 새지 않는다.

    by-type 의 _score 와 동일한 근거 dict(source=measured / log_source=merchant_seat)를 만들어야
    두 추천 경로가 같은 혼잡 근거를 말한다. 내부 전용 오버레이 키는 응답에 노출되면 안 된다.
    """
    fresh = _facility("seat-1", "cafe", 0.0002)
    # merchant_boost 는 실제 시각으로 신선도를 재므로(라우터 시계 고정과 무관) 실시간 기준 5분 전.
    fresh["features"] = {
        **fresh["features"],
        "seat_status": {
            "level": "full",
            "updated_at": (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(),
        },
    }
    plain = _facility("seat-2", "cafe", 0.0004)

    items = _run_main_reco(
        auth_client, [fresh, plain],
        {"recommendations": [{"id": "rec-1"}], "merchant_timesales": []},
        {},  # 혼잡 로그 0건 — 오버레이가 없으면 congestion_source='none' 이 된다
    )

    assert items["seat-1"]["congestion_source"] == "measured"
    assert items["seat-1"]["congestion_log_source"] == "merchant_seat"
    assert items["seat-1"]["congestion_level"] == pytest.approx(0.9)  # full
    assert items["seat-1"]["congestion_is_stale"] is False
    assert items["seat-1"]["facility"]["seat_status_fresh"]["level"] == "full"
    # 방송이 없는 이웃은 종전대로 '근거 없음'
    assert items["seat-2"]["congestion_source"] == "none"
    # 내부 전용 오버레이 키는 응답 payload 에 실리지 않는다.
    assert all("_merchant_congestion_override" not in item["facility"] for item in items.values())


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
    congestion_map = {f["id"]: _cong(0.2) for f in cafes}

    with patch("app.routers.recommendations.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.recommendations.fetch_all_facilities", new=AsyncMock(return_value=cafes + others)), \
         patch("app.routers.recommendations.fetch_congestion_map", new=AsyncMock(return_value=congestion_map)), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)), \
         patch("app.routers.recommendations.generate_reason_with_source", new=AsyncMock(return_value=("사유", "template"))):
        res = auth_client.post("/api/v1/recommendations/by-type", json={
            "user_id": AUTH_USER_ID,
            "facility_type": "cafe",
            "user_lat": BASE_LAT,
            "user_lng": BASE_LNG,
        })

    assert res.status_code == 200
    items = res.json()
    assert len(items) == 4  # cafe 후보 전부(기본 limit 5 이내)
    # 요청한 타입만 + DB 저장 실패 시 명시적 추적 불가 ID
    assert all(item["facility"]["type"] == "cafe" for item in items)
    assert all(item["recommendation_id"] == "mock-rec-id" for item in items)
    scores = [item["spot_score"] for item in items]
    assert scores == sorted(scores, reverse=True)
    assert [item["rank"] for item in items] == [1, 2, 3, 4]


def test_recommend_by_type_never_falls_back_outside_walk_limit(auth_client):
    cafes = [_facility("inside", "cafe", 0.0002), _facility("outside", "cafe", 0.0004)]
    fetch_all = AsyncMock(return_value=cafes)
    with patch("app.routers.recommendations.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.recommendations.fetch_all_facilities", new=fetch_all), \
         patch("app.routers.recommendations.get_walking_routes", new=AsyncMock(return_value=[
             WalkingRoute(4.0, 260.0, "estimated"), WalkingRoute(6.0, 400.0, "estimated"),
         ])), \
         patch("app.routers.recommendations.fetch_congestion_map", new=AsyncMock(return_value={})), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)), \
         patch("app.routers.recommendations.generate_reason_with_source", new=AsyncMock(return_value=("사유", "template"))):
        res = auth_client.post("/api/v1/recommendations/by-type", json={
            "user_id": AUTH_USER_ID, "facility_type": "cafe", "user_lat": BASE_LAT, "user_lng": BASE_LNG,
            "context": {"max_walk_minutes": 5},
        })

    assert res.status_code == 200
    assert [item["facility"]["id"] for item in res.json()] == ["inside"]
    assert fetch_all.await_count == 1


def test_recommend_by_type_does_not_fill_from_weaker_eligibility_tier(auth_client):
    cafes = [
        _facility("verified-a", "cafe", 0.0002),
        _facility("verified-b", "cafe", 0.0004),
        _facility("weaker", "cafe", 0.0006),
    ]
    tier_by_id = {"verified-a": 0, "verified-b": 0, "weaker": 2}
    with patch("app.routers.recommendations.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.recommendations.fetch_all_facilities", new=AsyncMock(return_value=cafes)), \
         patch("app.routers.recommendations.get_walking_routes", new=AsyncMock(return_value=[
             WalkingRoute(2.0, 130.0, "osm_pedestrian"),
             WalkingRoute(3.0, 195.0, "osm_pedestrian"),
             WalkingRoute(1.0, 65.0, "osm_pedestrian"),
         ])), \
         patch(
             "app.routers.recommendations.recommendation_eligibility_tier",
             side_effect=lambda facility, _arrival, _source: tier_by_id[facility["id"]],
         ), \
         patch("app.routers.recommendations.fetch_congestion_map", new=AsyncMock(return_value={})), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)), \
         patch("app.routers.recommendations.generate_reason_with_source", new=AsyncMock(return_value=("사유", "template"))):
        response = auth_client.post("/api/v1/recommendations/by-type", json={
            "user_id": AUTH_USER_ID,
            "facility_type": "cafe",
            "user_lat": BASE_LAT,
            "user_lng": BASE_LNG,
            "limit": 3,
        })

    assert response.status_code == 200
    items = response.json()
    assert {item["facility"]["id"] for item in items} == {"verified-a", "verified-b"}
    assert len(items) == 2
    assert all(item["eligibility_tier"] == "verified_open_route" for item in items)


def test_solar_state_never_changes_candidates_scores_or_rank(auth_client):
    cafes = [
        _facility("solar-a", "cafe", 0.0002),
        _facility("solar-b", "cafe", 0.0004, coupon_rate=0.1),
        _facility("solar-c", "cafe", 0.0006),
    ]
    congestion_map = {facility["id"]: _cong(0.2) for facility in cafes}
    request = {
        "user_id": AUTH_USER_ID,
        "facility_type": "cafe",
        "user_lat": BASE_LAT,
        "user_lng": BASE_LNG,
    }

    def run(reason_result):
        with patch("app.routers.recommendations.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
             patch("app.routers.recommendations.fetch_all_facilities", new=AsyncMock(return_value=cafes)), \
             patch("app.routers.recommendations.fetch_congestion_map", new=AsyncMock(return_value=congestion_map)), \
             patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)), \
             patch("app.routers.recommendations.generate_reason_with_source", new=AsyncMock(return_value=reason_result)):
            response = auth_client.post("/api/v1/recommendations/by-type", json=request)
        assert response.status_code == 200
        return response.json()

    disabled = run(("결정적 템플릿", "template"))
    enabled = run(("Solar가 다듬은 문장", "llm"))
    timeout = run(("타임아웃 폴백", "template"))

    def ranking(items):
        return [(item["facility"]["id"], item["spot_score"], item["rank"]) for item in items]

    assert ranking(disabled) == ranking(enabled) == ranking(timeout)
    assert [item["reason_source"] for item in disabled] == ["template"] * 3
    assert [item["reason_source"] for item in enabled] == ["llm"] * 3
    assert [item["reason_source"] for item in timeout] == ["template"] * 3


# =========================================================================
# 4. 피드백(POST /api/v1/feedback) — 소유권 가드·입력 검증·액션별 학습 계약
# =========================================================================

REC_ID = "99999999-9999-4999-8999-999999999999"
FEEDBACK_FACILITY = _facility("f-1", "cafe", 0.0002)


def _rec_row(user_id: str = AUTH_USER_ID) -> dict:
    return {
        "id": REC_ID,
        "user_id": user_id,
        "recommended_facility_id": FEEDBACK_FACILITY["id"],
        "recommended_facility": FEEDBACK_FACILITY,
    }


def _feedback_db(user_feedback: list[dict] | None = None, user_id: str = AUTH_USER_ID) -> FakeSupabase:
    return FakeSupabase({
        "recommendations": [_rec_row(user_id)],
        "user_feedback": user_feedback or [],
    })


def _decision_row(action: str, **overrides) -> dict:
    """이미 존재하는 결정 행(부분 UNIQUE 인덱스상 추천당 1개) — 멱등 경로 검증용."""
    row = {
        "id": "fb-existing",
        "user_id": AUTH_USER_ID,
        "recommendation_id": REC_ID,
        "action": action,
        "reason_status": "none",
        "learning_scope": "none",
        "learning_applied_at": None,
    }
    row.update(overrides)
    return row


def _post_feedback(client, action: str, db: FakeSupabase):
    with patch("app.routers.recommendations.supabase_client", new=db), \
         patch("app.routers.recommendations.issue_coupon_if_partner", new=AsyncMock(return_value={"coupon_issued": False})):
        return client.post("/api/v1/feedback", json={"recommendation_id": REC_ID, "action": action})


def test_feedback_ownership_guard(auth_client):
    # 타인 user_id 의 추천 기록에 피드백 → 403 (선호벡터 오염 차단)
    # recommendation_id 는 실제로 uuid 컬럼이므로 유효 UUID 를 쓴다(비-UUID 는 형식 가드로 404 처리).
    db = _feedback_db(user_id="other-user")
    res = _post_feedback(auth_client, "accepted_visit_intent", db)
    assert res.status_code == 403


def test_feedback_synthetic_bytype_id_404(auth_client):
    # by-type 브라우즈 랭킹의 합성 id("bytype-…", DB 미저장·비-UUID)는 uuid 캐스팅 500 대신 깔끔한 404.
    res = auth_client.post(
        "/api/v1/feedback",
        json={
            "recommendation_id": "bytype-f1000000-0000-0000-0000-000000000001",
            "action": "accepted_visit_intent",
        },
    )
    assert res.status_code == 404


def test_feedback_invalid_action_422(auth_client):
    # action 은 신규 어휘 Literal — 목록 밖 값은 라우터 진입 전 422
    res = auth_client.post("/api/v1/feedback", json={"recommendation_id": REC_ID, "action": "loved"})
    assert res.status_code == 422


@pytest.mark.parametrize("legacy_action", ["accepted", "ignored"])
def test_feedback_rejects_legacy_actions_422(auth_client, legacy_action):
    # legacy 어휘는 기존 행 보존용으로 DB CHECK 에만 남는다 — API 입력에서는 제외.
    res = auth_client.post("/api/v1/feedback", json={"recommendation_id": REC_ID, "action": legacy_action})
    assert res.status_code == 422


def test_feedback_action_literal_matches_service_vocabulary():
    # 라우터 Literal ↔ feedback_service.API_ACTIONS 패리티 — 한쪽만 바뀌면 즉시 실패한다.
    from typing import get_args

    from app.routers.recommendations import FeedbackRequest
    from app.services import feedback_service as fs

    literal = set(get_args(FeedbackRequest.model_fields["action"].annotation))
    assert literal == set(fs.API_ACTIONS)


def test_feedback_accepted_visit_intent_learns_and_issues_coupon(auth_client):
    db = _feedback_db()
    adjust = AsyncMock()
    coupon = AsyncMock(return_value={"coupon_issued": True})
    with patch("app.routers.recommendations.supabase_client", new=db), \
         patch("app.routers.recommendations.issue_coupon_if_partner", new=coupon), \
         patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=adjust):
        res = auth_client.post(
            "/api/v1/feedback", json={"recommendation_id": REC_ID, "action": "accepted_visit_intent"}
        )

    assert res.status_code == 200
    assert res.json()["updated_vector"] is True
    # 실제 방문 수락만 쿠폰을 현물화하고, 벡터는 강화(+10%) 방향으로 움직인다.
    coupon.assert_awaited_once()
    assert adjust.await_count == 1
    assert adjust.await_args.kwargs["action"] == "accepted"


def test_feedback_decision_is_idempotent(auth_client):
    # 같은 추천·같은 액션 재요청: 결정 행이 이미 있으면 재학습하지 않는다(중복 학습 금지).
    db = _feedback_db([_decision_row("accepted_visit_intent", learning_applied_at="2026-07-15T00:00:00+00:00")])
    adjust = AsyncMock()
    with patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=adjust):
        res = _post_feedback(auth_client, "accepted_visit_intent", db)

    assert res.status_code == 200
    assert res.json()["updated_vector"] is False
    adjust.assert_not_awaited()


def test_feedback_rejected_defers_learning_to_lab(auth_client):
    # 명시 거절은 pending 으로만 적재된다 — 왜 싫었는지 모르는 채로 취향을 깎지 않는다.
    db = _feedback_db()
    adjust = AsyncMock()
    with patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=adjust):
        res = _post_feedback(auth_client, "rejected", db)

    assert res.status_code == 200
    body = res.json()
    assert body["reason_status"] == "pending"
    assert body["updated_vector"] is False
    adjust.assert_not_awaited()


@pytest.mark.parametrize("action", ["skipped", "dismissed_batch", "unsaved"])
def test_feedback_non_learning_actions_never_touch_vector(auth_client, action):
    # '다음'/'다른 대안 보기'/저장 해제는 취향 표명이 아니다 — 기존 일괄 -5% 오학습의 진원지.
    db = _feedback_db()
    adjust = AsyncMock()
    with patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=adjust):
        res = _post_feedback(auth_client, action, db)

    assert res.status_code == 200
    assert res.json()["updated_vector"] is False
    adjust.assert_not_awaited()


@pytest.mark.parametrize("action", ["helpful", "not_helpful"])
def test_feedback_quality_signal_touches_nothing(auth_client, action):
    # 만족도는 품질 신호 전용 — 쿠폰·수락 지표·벡터 어느 것도 건드리지 않는다.
    db = _feedback_db()
    adjust = AsyncMock()
    coupon = AsyncMock(return_value={"coupon_issued": True})
    with patch("app.routers.recommendations.supabase_client", new=db), \
         patch("app.routers.recommendations.issue_coupon_if_partner", new=coupon), \
         patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=adjust):
        res = auth_client.post("/api/v1/feedback", json={"recommendation_id": REC_ID, "action": action})

    assert res.status_code == 200
    assert res.json()["updated_vector"] is False
    adjust.assert_not_awaited()
    coupon.assert_not_awaited()


# =========================================================================
# 5. 관리자 가드(require_role(ROLE_ADMIN)) — Supabase JWT + users.role 단일 경로
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


def test_admin_inquiries_non_admin_account_403(client):
    """로그인은 됐지만 role 이 admin 이 아니면 403(401 이 아니다 — 인증 자체는 성공했다)."""
    res = client.get(
        "/api/v1/admin/inquiries",
        headers=_admin_headers("00000000-0000-4000-8000-000000000000"),  # tourist
    )
    assert res.status_code == 403


def test_admin_inquiries_ok(client):
    with patch("app.routers.admin.supabase_admin", new=FakeSupabase({"inquiries": []})):
        res = client.get("/api/v1/admin/inquiries", headers=_admin_headers())
    assert res.status_code == 200
    assert res.json() == []


def test_admin_simulate_peak_no_header_401(client):
    # infrastructures 라우터의 관리자 엔드포인트도 동일 가드로 보호된다
    res = client.post("/api/v1/admin/simulate-peak")
    assert res.status_code == 401


# --- 5-1. 피크타임 모의 발생(POST /api/v1/admin/simulate-peak) — 비율 배정·배치 INSERT ---
# 배경: 구간 배정이 절대 인덱스(idx<15 여유 / idx<30 보통 / 나머지 혼잡)였다. 시설이 40곳이던
# 시절엔 균형 잡힌 시연 그림이었지만 2026-09-03 실측 1,660곳에서는 1,630곳(98%)이 혼잡으로
# 찍혔다. 아래 테스트가 '시설 수가 늘어도 비율이 유지된다'를 잠근다.


class _RecordingAdminSupabase:
    """congestion_logs INSERT 를 청크 단위 그대로 기록하는 fake service_role 클라이언트."""

    def __init__(self):
        self.chunks: list[list[dict]] = []
        self._pending: list[dict] = []

    def table(self, name: str):
        assert name == "congestion_logs"  # simulate_peak 이 쓰는 유일한 쓰기 테이블
        return self

    def insert(self, rows):
        self._pending = list(rows)
        self.chunks.append(self._pending)
        return self

    def execute(self):
        # 라우터가 삽입 건수를 res.data 길이로 센다 — INSERT 반환 계약을 그대로 흉내 낸다.
        return _FakeResult(self._pending)


def _sim_facilities(count: int) -> list[dict]:
    return [{"id": f"sim-{i}", "name": f"시설-{i}", "type": "cafe", "capacity": 50} for i in range(count)]


def _sim_band(level: float) -> str:
    """혼잡 레벨을 구간 이름으로 되돌린다(세 구간의 값 범위는 서로 겹치지 않는다)."""
    if level <= 0.28:
        return "relaxed"   # 0.05 ~ 0.28
    if level <= 0.65:
        return "normal"    # 0.35 ~ 0.65
    return "crowded"       # 0.72 ~ 0.95


def _run_simulate_peak(client, facility_count: int) -> _RecordingAdminSupabase:
    admin_client = _RecordingAdminSupabase()
    with patch("app.routers.infrastructures.supabase_client", new=FakeSupabase({"facilities": _sim_facilities(facility_count)})), \
         patch("app.routers.infrastructures.supabase_admin", new=admin_client):
        res = client.post("/api/v1/admin/simulate-peak", headers=_admin_headers())
    assert res.status_code == 200
    return admin_client


def _band_counts(admin_client: _RecordingAdminSupabase) -> dict:
    counts = {"relaxed": 0, "normal": 0, "crowded": 0}
    for chunk in admin_client.chunks:
        for row in chunk:
            counts[_sim_band(row["congestion_level"])] += 1
    return counts


def test_simulate_peak_splits_bands_by_ratio_not_absolute_index(client):
    # 100곳 → 40/35/25. 옛 절대 인덱스였다면 15/15/70 이 됐다.
    counts = _band_counts(_run_simulate_peak(client, 100))
    assert counts == {"relaxed": 40, "normal": 35, "crowded": 25}


def test_simulate_peak_keeps_ratio_as_facility_count_grows(client):
    # 시설이 12배로 늘어도 비율은 그대로다(= 혼잡이 전체를 삼키지 않는다).
    total = 1200
    counts = _band_counts(_run_simulate_peak(client, total))
    assert counts["relaxed"] == int(total * _SIMULATE_RELAXED_RATIO)
    assert counts["normal"] == int(total * _SIMULATE_NORMAL_RATIO)
    assert counts["crowded"] == total - counts["relaxed"] - counts["normal"]
    # 혼잡 비중이 사실상 전부였던 회귀를 직접 잠근다(옛 코드에서는 1,170/1,200 = 97.5%).
    assert counts["crowded"] / total == pytest.approx(0.25, abs=0.01)


def test_simulate_peak_inserts_in_large_batches(client):
    # 1,200행이 10행씩이면 순차 120 왕복이다. Render 무료 인스턴스에서 그 왕복이 비용의 전부라
    # 굵은 배치로 묶는다 — 청크당 상한은 지키되(_SIMULATE_INSERT_CHUNK) 왕복은 3회로 준다.
    admin_client = _run_simulate_peak(client, 1200)
    assert len(admin_client.chunks) == 3
    assert [len(chunk) for chunk in admin_client.chunks] == [500, 500, 200]
    assert all(len(chunk) <= _SIMULATE_INSERT_CHUNK for chunk in admin_client.chunks)


def test_simulate_peak_survives_tiny_facility_count(client):
    # 시연용 소규모 환경(시설 3곳)에서도 인덱스가 깨지지 않고 세 구간이 하나씩 나온다.
    assert _band_counts(_run_simulate_peak(client, 3)) == {"relaxed": 1, "normal": 1, "crowded": 1}
    # 1곳뿐이어도 500 에러가 아니라 로그 1건이 나간다(경계식이 음수/역전되지 않는다).
    single = _run_simulate_peak(client, 1)
    assert sum(len(chunk) for chunk in single.chunks) == 1


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
# 6-1. 관리자 수동 혼잡도 설정(POST /api/v1/admin/facilities/{id}/congestion)
# =========================================================================

def test_admin_congestion_override_no_header_401(client):
    # 관리자 가드(require_role(ROLE_ADMIN)) — 인증 헤더 없으면 401
    res = client.post("/api/v1/admin/facilities/f-1/congestion", json={"level": 0.8})
    assert res.status_code == 401


def test_admin_congestion_override_invalid_level_422(client):
    # level 은 DB CHECK 와 동일한 0~1 범위 — 초과 값은 라우터 진입 전 422
    res = client.post(
        "/api/v1/admin/facilities/f-1/congestion", headers=_admin_headers(), json={"level": 1.5}
    )
    assert res.status_code == 422


def test_admin_congestion_override_facility_404(client):
    # 존재하지 않는 시설 → 404 (유령 로그/FK 위반 방지)
    with patch("app.routers.admin.supabase_admin", new=FakeSupabase({"facilities": []})):
        res = client.post(
            "/api/v1/admin/facilities/ghost/congestion", headers=_admin_headers(), json={"level": 0.8}
        )
    assert res.status_code == 404


def test_admin_congestion_override_happy_path(client):
    # capacity(50)×level(0.8)=40, source='event' 로 congestion_logs 1행 기록 후 그 행 반환.
    # FakeSupabase 는 facilities 조회와 congestion_logs INSERT 둘 다 canned 로 응답.
    facility = _facility("f-1", "cafe", 0.0002)  # capacity=50
    inserted = {
        "id": "log-1",
        "facility_id": "f-1",
        "congestion_level": 0.8,
        "current_count": 40,
        "source": "event",
        "timestamp": "2026-07-10T05:00:00+00:00",
    }
    with patch(
        "app.routers.admin.supabase_admin",
        new=FakeSupabase({"facilities": [facility], "congestion_logs": [inserted]}),
    ):
        res = client.post(
            "/api/v1/admin/facilities/f-1/congestion", headers=_admin_headers(), json={"level": 0.8}
        )
    assert res.status_code == 200
    body = res.json()
    assert body["congestion_level"] == 0.8
    assert body["current_count"] == 40
    assert body["source"] == "event"  # congestion_logs.source CHECK 허용값


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
        self._neq = []  # [(column, value), ...]
        self._gte = []  # [(column, value), ...]

    def eq(self, column, value):
        self._eq.append((column, value))
        return self

    def gte(self, column, value):
        self._gte.append((column, value))
        return self

    def neq(self, column, value):
        self._neq.append((column, value))
        return self

    def __getattr__(self, _name):
        def _chain(*_args, **_kwargs):
            return self

        return _chain

    def execute(self):
        rows = list(self._data)
        for column, value in self._eq:
            rows = [r for r in rows if r.get(column) == value]
        for column, value in self._neq:
            rows = [r for r in rows if r.get(column, "spot") != value]
        for column, value in self._gte:
            rows = [r for r in rows if _as_dt(r.get(column)) >= _as_dt(value)]
        return _FakeResult(rows)


class FilteringFakeSupabase:
    """table(name) → FilteringFakeTable. (공유 FakeSupabase 와 분리)"""

    def __init__(self, tables: dict):
        self._tables = tables

    def table(self, name: str) -> FilteringFakeTable:
        return FilteringFakeTable(self._tables.get(name, []))


def test_admin_metrics_excludes_browse_from_acceptance_denominator(client):
    now = datetime.now(timezone.utc).isoformat()
    rows = [
        {"source": "spot", "accepted": True, "created_at": now},
        {"source": "browse", "accepted": False, "created_at": now},
    ]
    with patch("app.routers.admin.supabase_admin", new=FilteringFakeSupabase({"recommendations": rows})):
        res = client.get("/api/v1/admin/metrics", headers=_admin_headers())
    assert res.status_code == 200
    assert res.json()["recommendations"] == [{"source": "spot", "accepted": True, "created_at": now}]


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
# 7-4. 30일 분산 추이(GET /api/v1/admin/metrics/trend) — E3 지표 리얼리티
# =========================================================================

def test_admin_metrics_trend_no_header_401(client):
    res = client.get("/api/v1/admin/metrics/trend")
    assert res.status_code == 401


def test_admin_metrics_trend_aggregation(client):
    # KST 일 단위 버킷팅 검증 — 날짜 창이 '오늘' 기준 롤링이라 상대 타임스탬프로 생성한다.
    # 공유 FakeSupabase 는 gte 를 흡수하지만, daily 는 날짜 키 매칭이라 창 밖 행은 어차피 떨어진다.
    now = datetime.now(timezone.utc)
    t_today = now.isoformat()
    t_yesterday = (now - timedelta(days=1)).isoformat()
    logs = [
        {"congestion_level": 0.8, "timestamp": t_today},
        {"congestion_level": 0.6, "timestamp": t_today},
        {"congestion_level": 0.4, "timestamp": t_yesterday},
    ]
    recs = [
        {"accepted": True, "created_at": t_today},
        {"accepted": False, "created_at": t_today},
        {"accepted": True, "created_at": t_yesterday},
    ]
    with patch("app.routers.admin.supabase_admin",
               new=FakeSupabase({"congestion_logs": logs, "recommendations": recs})):
        res = client.get("/api/v1/admin/metrics/trend?days=7", headers=_admin_headers())

    assert res.status_code == 200
    body = res.json()
    assert body["days"] == 7
    assert len(body["daily"]) == 7
    assert body["truncated"] is False

    # 마지막 원소 = KST 오늘: 평균 (0.8+0.6)/2 = 0.7, 추천 2건 중 1건 수락
    today_kst = (now + timedelta(hours=9)).strftime("%Y-%m-%d")
    last = body["daily"][-1]
    assert last["date"] == today_kst
    assert last["avg_congestion"] == 0.7
    assert last["samples"] == 2
    assert last["rec_total"] == 2
    assert last["rec_accepted"] == 1

    # 직전 원소 = KST 어제: 단일 로그 0.4, 추천 1건 수락
    prev = body["daily"][-2]
    assert prev["avg_congestion"] == 0.4
    assert prev["rec_total"] == 1
    assert prev["rec_accepted"] == 1

    # 로그 없는 날은 null 센티넬(실측 0.0 과 구분) + 표본 0
    empty_day = body["daily"][0]
    assert empty_day["avg_congestion"] is None
    assert empty_day["samples"] == 0


# =========================================================================
# 7-2. 예측 모델 메타(GET /predict/model-info) — 정확도 배지 데이터
# =========================================================================

def test_predict_model_info(client):
    canned = {
        "trained": True, "version": "v1", "loaded_at": "2026-08-19T00:00:00+00:00",
        "real_data_count": 500, "training_started_at": "2026-01-01T00:00:00+00:00",
        "training_ended_at": "2026-08-10T00:00:00+00:00", "mae": 0.08,
        "baseline_improvement": 0.3, "fallback_state": None, "refresh_error": None,
    }
    with patch("app.routers.predict.get_model_info", return_value=canned):
        res = client.get("/predict/model-info")
    assert res.status_code == 200
    body = res.json()
    assert body["trained"] is True
    assert body["mae"] == 0.08
    assert body["version"] == "v1"


def test_predict_model_info_untrained(client):
    canned = {
        "trained": False, "version": None, "loaded_at": None, "real_data_count": 0,
        "training_started_at": None, "training_ended_at": None, "mae": None,
        "baseline_improvement": None, "fallback_state": "degraded_rules", "refresh_error": "no_active_model",
    }
    with patch("app.routers.predict.get_model_info", return_value=canned):
        res = client.get("/predict/model-info")
    assert res.status_code == 200
    assert res.json()["fallback_state"] == "degraded_rules"


# =========================================================================
# 8. 시설 목록(GET /api/v1/infrastructures) — 혼잡도 병합
# =========================================================================

def test_infrastructures_happy_path(client):
    facilities = [
        {**_facility("f-1", "cafe", 0.0002), "operating_hours": {"open": "09:00"}},
        {**_facility("f-2", "restaurant", 0.0004), "operating_hours": None},
    ]
    congestion = {
        # source/is_stale 는 _fetch_latest_one 이 채우는 신선도 메타(프런트 하위호환 필드 추가).
        "f-1": {"level": 0.4, "current_count": 20, "timestamp": "2026-07-07T09:00:00+00:00",
                "source": "seed", "is_stale": True},
        # f-2 는 혼잡 로그 없음 → congestion=None 이어야 함
    }
    with patch("app.routers.infrastructures.supabase_client", new=FakeSupabase({"facilities": facilities})), \
         patch("app.routers.infrastructures.fetch_latest_congestion_for_all", new=AsyncMock(return_value=congestion)):
        res = client.get("/api/v1/infrastructures")

    assert res.status_code == 200
    items = res.json()
    assert [item["id"] for item in items] == ["f-1", "f-2"]
    assert items[0]["congestion"] == {
        "level": 0.4, "current_count": 20, "timestamp": "2026-07-07T09:00:00+00:00",
        "source": "seed", "is_stale": True,
    }
    assert items[1]["congestion"] is None


def test_infrastructures_detail_fields_passthrough(client):
    # TourAPI 상세 신규 필드(image_url/address/phone/homepage/overview/barrier_free)는
    # DB 에 값이 있으면 그대로 통과, 없으면 None(지어내지 않음 — 프런트 조건부 렌더).
    enriched = {
        **_facility("f-1", "cafe", 0.0002),
        "image_url": "https://tong.visitkorea.or.kr/cms/detail.jpg",
        "address": "경상북도 경주시 포석로 일대",
        "phone": "054-000-0000",
        "homepage": "https://hwangridan.example",
        "overview": "황리단길 대표 한옥카페입니다.",
        "barrier_free": True,
    }
    bare = _facility("f-2", "restaurant", 0.0004)  # 수동 시드 행 — 상세 필드 없음
    with patch("app.routers.infrastructures.supabase_client", new=FakeSupabase({"facilities": [enriched, bare]})), \
         patch("app.routers.infrastructures.fetch_latest_congestion_for_all", new=AsyncMock(return_value={})):
        res = client.get("/api/v1/infrastructures")

    assert res.status_code == 200
    first, second = res.json()
    assert first["image_url"] == "https://tong.visitkorea.or.kr/cms/detail.jpg"
    assert first["address"] == "경상북도 경주시 포석로 일대"
    assert first["phone"] == "054-000-0000"
    assert first["homepage"] == "https://hwangridan.example"
    assert first["overview"] == "황리단길 대표 한옥카페입니다."
    assert first["barrier_free"] is True
    for key in ("image_url", "address", "phone", "homepage", "overview", "barrier_free"):
        assert second[key] is None


# =========================================================================
# 8-1. 데이터 신선도(GET /api/v1/freshness) — 마커 → 추정 폴백 → 전부 null
# =========================================================================

# --- 이 테스트 전용 '.not_ 체이닝' 가짜 ---
# 공유 FakeTable 의 __getattr__ 는 메서드 호출만 흡수해, freshness 폴백 쿼리의
# `.not_.is_(...)` 프로퍼티 접근에서 깨진다 — 여기서만 not_ 을 프로퍼티로 열어준다.
# (공유 FakeSupabase/FakeTable 은 손대지 않아 나머지 테스트가 그대로 통과한다.)
class NotChainFakeTable(FakeTable):
    @property
    def not_(self):
        return self


class NotChainFakeSupabase(FakeSupabase):
    def table(self, name: str) -> NotChainFakeTable:
        return NotChainFakeTable(self._tables.get(name, []))


def test_freshness_event_marker(client):
    # ① app_events 동기화 마커(ingest_tourapi.py 가 적재 후 기록) → source='event' + written.
    marker = {"created_at": "2026-07-13T09:00:00+00:00", "props": {"written": 42, "total": 50}}
    with patch("app.routers.freshness.supabase_admin",
               new=NotChainFakeSupabase({"app_events": [marker]})):
        res = client.get("/api/v1/freshness")
    assert res.status_code == 200
    assert res.json() == {
        "last_tourapi_sync": "2026-07-13T09:00:00+00:00", "source": "event", "written": 42,
    }


def test_freshness_estimate_fallback(client):
    # ② 마커 0건 → TourAPI 적재분 facilities.updated_at 최대값으로 추정(source='estimate', written 없음).
    with patch("app.routers.freshness.supabase_admin", new=NotChainFakeSupabase({
        "app_events": [],
        "facilities": [{"updated_at": "2026-07-12T03:00:00+00:00"}],
    })):
        res = client.get("/api/v1/freshness")
    assert res.status_code == 200
    assert res.json() == {
        "last_tourapi_sync": "2026-07-12T03:00:00+00:00", "source": "estimate", "written": None,
    }


def test_freshness_no_data_all_null(client):
    # ③ 판단 근거 전무 → 전부 null(지어내지 않음) — 200 유지(프런트는 표기 자체를 숨김).
    with patch("app.routers.freshness.supabase_admin", new=NotChainFakeSupabase({})):
        res = client.get("/api/v1/freshness")
    assert res.status_code == 200
    assert res.json() == {"last_tourapi_sync": None, "source": None, "written": None}


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
    assert body["current_count"] is None
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


# =========================================================================
# 9-1. 제보 보상(reward 필드) — 누적 카운트·3배수 쿠폰 발급·다음 보상까지
# =========================================================================

def test_report_congestion_reward_counts_only(auth_client):
    # 누적 1건(3의 배수 아님) → 카운트만, 쿠폰 미발급, 다음 보상까지 2건.
    from app.routers.reports import _last_report_at
    _last_report_at.clear()
    facility = {**_facility("f-1", "restaurant", 0.0002, coupon_rate=0.2)}  # 제휴지만 배수 아님
    users_row = {"id": AUTH_USER_ID, "report_count": 0}  # 제보 후 → 1
    inserted = {
        "id": "log-1", "facility_id": "f-1", "congestion_level": 0.9,
        "current_count": 45, "source": "user_report", "timestamp": "2026-07-10T05:00:00+00:00",
    }
    with patch("app.routers.reports.supabase_admin", new=FakeSupabase(
        {"facilities": [facility], "users": [users_row], "congestion_logs": [inserted]}
    )):
        res = auth_client.post("/api/v1/reports/congestion", json={"facility_id": "f-1", "level": "혼잡"})
    assert res.status_code == 200
    reward = res.json()["reward"]
    assert reward["report_count"] == 1
    assert reward["coupon_issued"] is False
    assert reward["next_reward_in"] == 2


def test_report_congestion_reward_issues_coupon_on_third(auth_client):
    # 누적 3건(3의 배수) + 제휴 시설(coupon_rate>0) → 쿠폰 발급, 다음 보상까지 3건.
    from app.routers.reports import _last_report_at
    _last_report_at.clear()
    facility = {**_facility("f-1", "restaurant", 0.0002, coupon_rate=0.2)}
    users_row = {"id": AUTH_USER_ID, "report_count": 2}  # 제보 후 → 3
    inserted = {
        "id": "log-1", "facility_id": "f-1", "congestion_level": 0.9,
        "current_count": 45, "source": "user_report", "timestamp": "2026-07-10T05:00:00+00:00",
    }
    with patch("app.routers.reports.supabase_admin", new=FakeSupabase(
        {"facilities": [facility], "users": [users_row], "congestion_logs": [inserted],
         "user_coupons": [{"id": "c-1"}]}
    )):
        res = auth_client.post("/api/v1/reports/congestion", json={"facility_id": "f-1", "level": "혼잡"})
    assert res.status_code == 200
    reward = res.json()["reward"]
    assert reward["report_count"] == 3
    assert reward["coupon_issued"] is True
    assert reward["next_reward_in"] == 3


def test_report_congestion_reward_third_no_partner(auth_client):
    # 누적 3건이지만 비제휴(coupon_rate 0) → 카운트만, 쿠폰 미발급.
    from app.routers.reports import _last_report_at
    _last_report_at.clear()
    facility = {**_facility("f-1", "restaurant", 0.0002, coupon_rate=0.0)}
    users_row = {"id": AUTH_USER_ID, "report_count": 2}  # 제보 후 → 3
    inserted = {
        "id": "log-1", "facility_id": "f-1", "congestion_level": 0.9,
        "current_count": 45, "source": "user_report", "timestamp": "2026-07-10T05:00:00+00:00",
    }
    with patch("app.routers.reports.supabase_admin", new=FakeSupabase(
        {"facilities": [facility], "users": [users_row], "congestion_logs": [inserted]}
    )):
        res = auth_client.post("/api/v1/reports/congestion", json={"facility_id": "f-1", "level": "혼잡"})
    assert res.status_code == 200
    reward = res.json()["reward"]
    assert reward["report_count"] == 3
    assert reward["coupon_issued"] is False


# =========================================================================
# 9-2. 영업 상태 확인 — 사용자별 최신 1건은 DB RPC가 원자 처리하고 2명 일치 전엔 단일 제보다.
# =========================================================================

def test_report_availability_requires_auth(client):
    response = client.post(
        "/api/v1/reports/availability",
        json={"facility_id": "f-1", "status": "open"},
    )
    assert response.status_code == 401


def test_report_availability_returns_evidence_state(auth_client):
    from app.routers.reports import _last_availability_report_at

    _last_availability_report_at.clear()

    class AvailabilitySupabase(FakeSupabase):
        def rpc(self, name, params):
            assert name == "record_facility_availability_report"
            assert params["p_reporter_user_id"] == AUTH_USER_ID
            return FakeTable([{
                "facility_id": "f-1",
                "status": "open",
                "evidence_tier": "single_report",
                "corroborating_count": 1,
                "reported_at": "2026-08-25T03:00:00+00:00",
                "expires_at": "2026-08-25T03:30:00+00:00",
            }])

    with patch(
        "app.routers.reports.supabase_admin",
        new=AvailabilitySupabase({"facilities": [{"id": "f-1"}]}),
    ):
        response = auth_client.post(
            "/api/v1/reports/availability",
            json={"facility_id": "f-1", "status": "open"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "success": True,
        "facility_id": "f-1",
        "status": "open",
        "evidence_tier": "single_report",
        "corroborating_count": 1,
        "reported_at": "2026-08-25T03:00:00+00:00",
        "expires_at": "2026-08-25T03:30:00+00:00",
    }


# =========================================================================
# 10. 추천 수락(POST /api/v1/recommendations/accept) — 인증·404·쿠폰 발급
# =========================================================================

def test_accept_recommendation_requires_auth(client):
    res = client.post("/api/v1/recommendations/accept", json={"facility_id": "f-1"})
    assert res.status_code == 401


def test_accept_recommendation_facility_404(auth_client):
    with patch("app.routers.recommendations.supabase_client", new=FakeSupabase({"facilities": []})):
        res = auth_client.post("/api/v1/recommendations/accept", json={"facility_id": "nope"})
    assert res.status_code == 404


def test_accept_recommendation_issues_coupon(auth_client):
    # 제휴 시설(coupon_rate>0) 수락 → 쿠폰 발급(coupon_issued True, expires_at 세팅).
    facility = _facility("f-1", "restaurant", 0.0002, coupon_rate=0.2)
    with patch("app.routers.recommendations.supabase_client", new=FakeSupabase(
        {"facilities": [facility], "recommendations": [{"id": "rec-1"}], "user_coupons": [{"id": "c-1"}]}
    )):
        res = auth_client.post("/api/v1/recommendations/accept", json={"facility_id": "f-1"})
    assert res.status_code == 200
    body = res.json()
    assert body["success"] is True
    assert body["coupon_issued"] is True
    assert body["coupon_rate"] == 0.2
    assert body["expires_at"] is not None


def test_accept_recommendation_no_partner(auth_client):
    # 비제휴(coupon_rate 0) 수락 → 발급 없음(coupon_issued False, expires_at None).
    facility = _facility("f-1", "restaurant", 0.0002, coupon_rate=0.0)
    with patch("app.routers.recommendations.supabase_client", new=FakeSupabase(
        {"facilities": [facility], "recommendations": [{"id": "rec-1"}]}
    )):
        res = auth_client.post("/api/v1/recommendations/accept", json={"facility_id": "f-1"})
    assert res.status_code == 200
    body = res.json()
    assert body["success"] is True
    assert body["coupon_issued"] is False
    assert body["coupon_rate"] == 0.0
    assert body["expires_at"] is None


class RejectRecordingTable(FakeTable):
    def __init__(self, db, name):
        super().__init__([])
        self.db = db
        self.name = name

    def insert(self, payload):
        self.db.inserted.append(payload)
        self._data = [{"id": "browse-rec-1", **payload}]
        return self

    def execute(self):
        if self.name == "recommendations" and not self._data:
            return _FakeResult(self.db.existing)
        return super().execute()


class RejectRecordingSupabase:
    def __init__(self, existing=None):
        self.existing = existing or []
        self.inserted = []

    def table(self, name):
        return RejectRecordingTable(self, name)


def _decision(feedback_id="fb-1"):
    return {
        "row": {"id": feedback_id, "reason_status": "pending"},
        "created": True,
        "should_learn_vector": False,
    }


def test_reject_recommendation_creates_owned_browse_pending(auth_client):
    db = RejectRecordingSupabase()
    record = AsyncMock(return_value=_decision())
    with patch("app.routers.recommendations.fetch_facility", new=AsyncMock(return_value=_facility("f-1", "cafe", 0))), \
         patch("app.routers.recommendations.feedback_service.record_decision", new=record), \
         patch("app.routers.recommendations.supabase_client", new=db):
        res = auth_client.post(
            "/api/v1/recommendations/reject",
            json={"facility_id": "f-1", "user_id": "attacker", "spot_score": 99, "congestion": 1},
        )

    assert res.status_code == 200
    assert res.json()["feedback_id"] == "fb-1"
    assert db.inserted == [{
        "user_id": AUTH_USER_ID,
        "original_facility_id": "f-1",
        "recommended_facility_id": "f-1",
        "spot_score": 0.0,
        "score_breakdown": {},
        "accepted": False,
        "source": "browse",
    }]
    assert record.await_args.kwargs == {
        "user_id": AUTH_USER_ID,
        "recommendation_id": "browse-rec-1",
        "action": "rejected",
    }


def test_reject_recommendation_facility_404(auth_client):
    with patch("app.routers.recommendations.fetch_facility", new=AsyncMock(side_effect=__import__("fastapi").HTTPException(404))), \
         patch("app.routers.recommendations.supabase_client", new=RejectRecordingSupabase()):
        res = auth_client.post("/api/v1/recommendations/reject", json={"facility_id": "missing"})
    assert res.status_code == 404


def test_reject_recommendation_reuses_pending_row(auth_client):
    existing = [{"id": "existing-rec", "user_feedback": [{"id": "fb-old", "reason_status": "pending"}]}]
    db = RejectRecordingSupabase(existing)
    record = AsyncMock(return_value=_decision("fb-old"))
    with patch("app.routers.recommendations.fetch_facility", new=AsyncMock(return_value=_facility("f-1", "cafe", 0))), \
         patch("app.routers.recommendations.feedback_service.record_decision", new=record), \
         patch("app.routers.recommendations.supabase_client", new=db):
        res = auth_client.post("/api/v1/recommendations/reject", json={"facility_id": "f-1"})
    assert res.status_code == 200
    assert res.json()["recommendation_id"] == "existing-rec"
    assert db.inserted == []


# =========================================================================
# 11. 혼잡 신선도 헬퍼(_is_stale) — 나이>24h 판정
# =========================================================================

def test_congestion_is_stale_helper():
    from datetime import datetime, timedelta, timezone

    from app.routers.infrastructures import _is_stale

    now = datetime(2026, 7, 10, 12, 0, 0, tzinfo=timezone.utc)
    fresh = (now - timedelta(hours=1)).isoformat()
    old = (now - timedelta(hours=30)).isoformat()
    assert _is_stale(fresh, now=now) is False
    assert _is_stale(old, now=now) is True
    assert _is_stale(None, now=now) is False        # 미상은 오탐 방지로 False
    assert _is_stale("not-a-date", now=now) is False


# =========================================================================
# 12. 분산 코스 — 순서 지정(sequence): 정류지 종류가 요청 순서를 따른다
# =========================================================================

def _course_mocks(facilities):
    """courses 라우터의 외부 의존을 전부 결정적 목으로 대체하는 patch 컨텍스트 목록."""
    from types import SimpleNamespace

    return [
        patch("app.routers.courses.fetch_user", new=AsyncMock(return_value=USER_ROW)),
        patch("app.routers.courses.fetch_all_facilities", new=AsyncMock(return_value=facilities)),
        patch("app.routers.courses.fetch_congestion_map", new=AsyncMock(return_value={f["id"]: _cong(0.3) for f in facilities})),
        patch("app.routers.courses.get_travel_time_and_distance", new=AsyncMock(return_value=(5.0, 400.0))),
        # asyncio.to_thread(predict_congestion, ...) — 동기 함수라 plain 값 반환이면 충분.
        patch("app.routers.courses.predict_congestion", new=lambda *_a, **_k: 0.2),
        patch("app.routers.courses.calculate_spot_score", new=AsyncMock(return_value=SimpleNamespace(score=0.8))),
        patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)),
    ]


def _course_body(sequence=None):
    body = {"user_id": AUTH_USER_ID, "user_lat": BASE_LAT, "user_lng": BASE_LNG}
    if sequence is not None:
        body["sequence"] = sequence
    return body


def test_course_sequence_orders_stop_types(auth_client):
    # 종류별 후보가 섞여 있어도 정류지 종류가 sequence 순서(카페→관광지→식당)를 따른다.
    facs = [
        _facility("c-1", "cafe", 0.0002),
        _facility("c-2", "cafe", 0.0004),
        _facility("a-1", "attraction", 0.0003),
        _facility("a-2", "attraction", 0.0005),
        _facility("r-1", "restaurant", 0.0006),
        _facility("r-2", "restaurant", 0.0007),
    ]
    import contextlib

    with contextlib.ExitStack() as stack:
        for p in _course_mocks(facs):
            stack.enter_context(p)
        res = auth_client.post("/api/v1/courses/recommend", json=_course_body(["cafe", "attraction", "restaurant"]))

    assert res.status_code == 200
    stops = res.json()
    assert [s["facility"]["type"] for s in stops] == ["cafe", "attraction", "restaurant"]
    assert [s["order"] for s in stops] == [1, 2, 3]


def test_course_sequence_filters_invalid_types(auth_client):
    # 무효 종류는 걸러지고 유효 항목만 순서대로 사용된다(['cafe','xxx','restaurant'] → 2정류지).
    facs = [
        _facility("c-1", "cafe", 0.0002),
        _facility("r-1", "restaurant", 0.0006),
        _facility("a-1", "attraction", 0.0003),
    ]
    import contextlib

    with contextlib.ExitStack() as stack:
        for p in _course_mocks(facs):
            stack.enter_context(p)
        res = auth_client.post("/api/v1/courses/recommend", json=_course_body(["cafe", "xxx", "restaurant"]))

    assert res.status_code == 200
    stops = res.json()
    assert [s["facility"]["type"] for s in stops] == ["cafe", "restaurant"]


def test_course_sequence_skips_exhausted_type(auth_client):
    # 요청 종류(카페) 후보가 1곳뿐인데 같은 종류를 두 슬롯 요청 → 두 번째 슬롯은 건너뛴다
    # (명시한 종류를 몰래 다른 종류로 대체하지 않는 정직한 저하 — 코스가 짧아질 뿐).
    facs = [
        _facility("c-1", "cafe", 0.0002),
        _facility("r-1", "restaurant", 0.0006),
    ]
    import contextlib

    with contextlib.ExitStack() as stack:
        for p in _course_mocks(facs):
            stack.enter_context(p)
        res = auth_client.post("/api/v1/courses/recommend", json=_course_body(["cafe", "cafe"]))

    assert res.status_code == 200
    stops = res.json()
    assert len(stops) == 1
    assert stops[0]["facility"]["type"] == "cafe"


# =========================================================================
# /infrastructures 응답 슬리밍
# =========================================================================
# 지도 화면이 한 줄도 읽지 않는 파이프라인 출처 기록이 방문자마다 내려가고 있었다.
# 응답이 무거워 2.5초를 넘기면 프런트가 Supabase 직접 읽기로 폴백하는데, 그 경로에는
# 시설이 조용히 누락되는 알려진 결함이 있다 — 그래서 응답 크기가 정확도 문제로 이어진다.
def test_map_response_drops_pipeline_provenance():
    from app.routers.infrastructures import _slim_features

    slim = _slim_features({
        "cuisine_tags": ["한식"],
        "seat_status": {"level": "low"},
        "kakao_place_url": "https://place.map.kakao.com/1",
        "discovery_queries": ["황리단길 맛집"] * 5,
        "capacity_evidence": {"source": "kakao", "raw": "…"},
        "indoor_evidence": {"source": "tourapi"},
        "tagging_source": "batch",
    })
    # 화면이 읽는 값은 남는다.
    assert slim["cuisine_tags"] == ["한식"]
    assert slim["seat_status"] == {"level": "low"}
    assert slim["kakao_place_url"].startswith("https://")
    # 출처 기록은 빠진다.
    for gone in ("discovery_queries", "capacity_evidence", "indoor_evidence", "tagging_source"):
        assert gone not in slim


def test_map_response_slimming_is_a_denylist_not_an_allowlist():
    """새 키가 생겼을 때 조용히 사라지면 안 된다 — 모르는 키는 그대로 통과시킨다."""
    from app.routers.infrastructures import _slim_features

    slim = _slim_features({"some_future_key": 1, "discovery_source": "kakao"})
    assert slim["some_future_key"] == 1
    assert "discovery_source" not in slim


def test_map_response_slimming_tolerates_missing_or_odd_features():
    from app.routers.infrastructures import _slim_features

    assert _slim_features(None) is None
    assert _slim_features({}) == {}
    assert _slim_features("not-a-dict") == "not-a-dict"
