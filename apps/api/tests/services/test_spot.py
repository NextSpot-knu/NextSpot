import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from unittest.mock import AsyncMock, patch

# 테스트 대상 모듈 임포트
from app.services.spot.score import (
    calculate_spot_score, W1, W2, W3, INCENTIVE_COUPON_SHARE, COUPON_RATE_CAP,
)
from app.services.spot.wait_time import calculate_predicted_wait_time
from app.services.spot.travel import FALLBACK_ROUTE_FACTOR, calculate_haversine_distance, estimate_walking_route
from app.services.spot.preference import calculate_preference_similarity, get_category_average_vector
from app.services.congestion_evidence import rankable_measured_level

@pytest.mark.asyncio
async def test_category_average_vector():
    # 1. 온보딩 선호 카테고리 벡터 생성 테스트 (관광 카테고리)
    pref_cats = ["restaurant", "cafe"]
    avg_vec = get_category_average_vector(pref_cats)

    # 8차원 벡터이고 L2 norm 크기가 1인지 검사
    assert len(avg_vec) == 8
    sq_sum = sum(x**2 for x in avg_vec)
    assert pytest.approx(sq_sum, 0.01) == 1.0


@pytest.mark.asyncio
async def test_calculate_predicted_wait_time():
    # 2. 예측 대기 시간 산출 공식 검증 (점심/오후 피크 보정 동작 검사)
    # 처리시간 20분 * 혼잡도 0.8 = 16분 (시간대 보정이 1.0일 경우)
    wait_time = await calculate_predicted_wait_time(
        facility_type="restaurant",
        congestion_level=0.8,
        facility_features={"average_processing_time": 20}
    )

    # 시간에 따라 1.0 또는 1.3 또는 1.2의 보정이 들어간 값이 나와야 함
    assert wait_time > 0
    assert wait_time in [16.0, 20.8, 19.2]  # 16 * 1.0, 16 * 1.3, 16 * 1.2


@pytest.mark.asyncio
async def test_wait_time_peak_uses_supplied_kst_hour():
    lunch = await calculate_predicted_wait_time("restaurant", 0.8, {"average_processing_time": 20}, hour=12)
    evening = await calculate_predicted_wait_time("restaurant", 0.8, {"average_processing_time": 20}, hour=19)
    assert lunch == 20.8
    assert evening == 16.0


@pytest.mark.asyncio
async def test_haversine_distance():
    # 3. 직선 거리 연산 검증 (경주 황리단길 기준)
    # 동일 지점은 거리 0
    dist = calculate_haversine_distance(35.8360, 129.2100, 35.8360, 129.2100)
    assert dist == 0.0

    # 특정 인접 지점 간 거리 양수
    dist_diff = calculate_haversine_distance(35.8360, 129.2100, 35.8372, 129.2096)
    assert dist_diff > 0.0
    route = estimate_walking_route(35.8360, 129.2100, 35.8372, 129.2096)
    assert route.source == "estimated"
    assert route.distance_m == pytest.approx(dist_diff * FALLBACK_ROUTE_FACTOR, abs=0.1)


@pytest.mark.asyncio
@patch("app.services.spot.preference.preference_vector_service")
async def test_calculate_spot_score(mock_pref):
    # 4. SPOT 종합 추천 점수 계산 테스트 (출력 구조 + 결합형 인센티브 성분)
    # 선호 벡터 저장소 조회 시 모의 8차원 정규 벡터 반환 모킹
    mock_pref.get_user_vector = AsyncMock(return_value=[1.0 / 3.0] * 8)

    candidate = {
        "id": "test-poi-1",
        "type": "restaurant",
        "latitude": 35.8372,
        "longitude": 129.2096,
        "capacity": 100,
        "features": {"average_processing_time": 15},
        "coupon_rate": 0.20,  # 20% 제휴 → 쿠폰강도 만점(1.0)
    }

    result = await calculate_spot_score(
        user_id="test-user-id",
        preferred_categories=["restaurant"],
        original_congestion_level=0.9,
        candidate_facility=candidate,
        user_lat=35.8360,
        user_lng=129.2100
    )

    # 출력 구조 검증 (인센티브 구성 성분 포함)
    assert result.score >= 0.0 and result.score <= 1.0
    for key in ("preference", "wait_time", "travel_time", "incentive", "incentive_coupon", "incentive_relief"):
        assert key in result.breakdown

    # D1 재결정: incentive = 0.5·쿠폰강도 + 0.5·재배치기여.
    # 쿠폰강도는 결정적으로 1.0 (0.20/0.20 캡), 재배치기여는 예측 혼잡에 따라 [0,1].
    assert result.breakdown["incentive_coupon"] == 1.0
    assert 0.5 <= result.breakdown["incentive"] <= 1.0

    # 쿠폰 미보유(컬럼 부재 포함) → 쿠폰강도 0, 인센티브는 재배치기여 절반만
    no_coupon = {k: v for k, v in candidate.items() if k != "coupon_rate"}
    result2 = await calculate_spot_score(
        user_id="test-user-id",
        preferred_categories=["restaurant"],
        original_congestion_level=0.9,
        candidate_facility=no_coupon,
        user_lat=35.8360,
        user_lng=129.2100
    )
    assert result2.breakdown["incentive_coupon"] == 0.0
    assert result2.breakdown["incentive"] <= 0.5


@pytest.mark.asyncio
async def test_spot_score_exact_value_weight_regression():
    # 5. 가중치 회귀 방지: 하위 산출을 전부 모킹해 '정확한 점수'를 검증한다.
    #    가중치가 제안서 값(0.40/0.40/0.20)에서 벗어나면 이 테스트가 실패한다.
    #    (과거 테스트는 범위만 검사해 가중치를 바꿔도 통과하는 회귀 미탐지 문제가 있었다.)
    candidate = {
        "id": "test-poi-2",
        "type": "cafe",
        "latitude": 35.8366,
        "longitude": 129.2099,
        "capacity": 40,
        "features": {},
        "coupon_rate": 0.20,
    }
    with patch("app.services.spot.score.calculate_preference_similarity", new=AsyncMock(return_value=1.0)), \
         patch("app.services.spot.score.get_travel_time_and_distance", new=AsyncMock(return_value=(10.0, 800.0))), \
         patch("app.services.spot.score.calculate_predicted_wait_time", new=AsyncMock(return_value=20.0)), \
         patch("app.services.spot.score.predict_congestion_detailed", new=lambda *a, **k: (0.5, "registry")), \
         patch("app.services.spot.score.get_model_info", return_value={"version": "test-v1"}):
        result = await calculate_spot_score(
            user_id="test-user-id",
            preferred_categories=["cafe"],
            original_congestion_level=0.9,
            candidate_facility=candidate,
            user_lat=35.8360,
            user_lng=129.2100,
            user_vector=[1.0 / (8 ** 0.5)] * 8,
        )
    # time_cost = (20 + 10) / 60 = 0.5, preference = 1.0
    # incentive = 0.5·(0.20/0.20) + 0.5·max(0, 0.9 − 0.5[예측혼잡 모킹]) = 0.5 + 0.2 = 0.7
    # spot = 0.40*1.0 - 0.40*0.5 + 0.20*0.7 = 0.34 → 정규화 (0.34+0.40)/1.00 = 0.74
    assert result.breakdown["incentive"] == pytest.approx(0.7, abs=1e-3)
    assert result.score == pytest.approx(0.740, abs=1e-3)
    # 산식 성분으로도 명시 검증(가중치/구성비 자체가 바뀌면 위 기대값과 함께 이중으로 실패)
    assert (W1, W2, W3) == (0.40, 0.40, 0.20)
    assert (INCENTIVE_COUPON_SHARE, COUPON_RATE_CAP) == (0.5, 0.20)


@pytest.mark.asyncio
async def test_degraded_rules_excludes_congestion_wait_and_relief_but_keeps_weights():
    candidate = {
        "id": "degraded", "type": "cafe", "latitude": 35.8366, "longitude": 129.2099,
        "capacity": 40, "features": {}, "coupon_rate": 0.1,
    }
    with patch("app.services.spot.score.calculate_preference_similarity", new=AsyncMock(return_value=0.8)), \
         patch("app.services.spot.score.get_travel_time_and_distance", new=AsyncMock(return_value=(10.0, 800.0))), \
         patch("app.services.spot.score.predict_congestion_detailed", return_value=(None, "unavailable")), \
         patch("app.services.spot.score.get_model_info", return_value={"version": None}):
        result = await calculate_spot_score(
            user_id="test", preferred_categories=["cafe"], original_congestion_level=0.9,
            candidate_facility=candidate, user_lat=35.836, user_lng=129.21,
            user_vector=[1.0 / (8 ** 0.5)] * 8,
        )
    assert result.breakdown["scoring_mode"] == "degraded_rules"
    assert result.breakdown["wait_time"] is None
    assert result.breakdown["incentive_relief"] is None
    assert result.breakdown["prediction_source"] == "unavailable"
    assert result.breakdown["incentive"] == pytest.approx(0.25)


@pytest.mark.asyncio
async def test_area_stats_rules_ranks_public_demand_without_fake_wait_or_congestion():
    candidate = {
        "id": "area", "type": "cafe", "latitude": 35.8366, "longitude": 129.2099,
        "capacity": 40, "features": {}, "coupon_rate": 0.1,
    }
    signal = {
        "level": 0.7,
        "mode": "live",
        "sources": ["parking", "tourism"],
        "observed_at": "2026-08-20T01:00:00+00:00",
        "components": {"parking": 0.8, "tourism": 0.4},
        "ranking_penalty_minutes": 5.6,
        "event_boost": 0.0,
        "event_title": None,
    }
    with patch("app.services.spot.score.calculate_preference_similarity", new=AsyncMock(return_value=0.8)), \
         patch("app.services.spot.score.get_travel_time_and_distance", new=AsyncMock(return_value=(10.0, 800.0))), \
         patch("app.services.spot.score.predict_congestion_detailed", return_value=(None, "unavailable")), \
         patch("app.services.spot.score.get_model_info", return_value={"version": None}), \
         patch("app.services.spot.score.get_area_demand_signal", new=AsyncMock(return_value=signal)):
        result = await calculate_spot_score(
            user_id="test", preferred_categories=["cafe"], original_congestion_level=0.9,
            candidate_facility=candidate, user_lat=35.836, user_lng=129.21,
            user_vector=[1.0 / (8 ** 0.5)] * 8,
        )
    assert result.breakdown["scoring_mode"] == "area_stats_rules"
    assert result.breakdown["wait_time"] is None
    assert result.breakdown["ranking_wait_time"] is None
    assert result.breakdown["incentive_relief"] is None
    assert result.breakdown["prediction_source"] == "unavailable"
    assert result.breakdown["area_demand_level"] == 0.7
    assert result.breakdown["area_demand_penalty_minutes"] == 5.6


def test_only_recent_corroborated_or_verified_measurement_can_rank():
    now = datetime(2026, 8, 20, 1, 0, tzinfo=timezone.utc)
    base = {"source": "measured", "level": 0.2, "timestamp": (now - timedelta(minutes=10)).isoformat()}
    assert rankable_measured_level({**base, "evidence_tier": "corroborated"}, now=now) == 0.2
    assert rankable_measured_level({**base, "evidence_tier": "verified"}, now=now) == 0.2
    assert rankable_measured_level({**base, "evidence_tier": "single_report"}, now=now) is None
    assert rankable_measured_level(
        {**base, "evidence_tier": "verified", "timestamp": (now - timedelta(minutes=31)).isoformat()}, now=now
    ) is None


@pytest.mark.asyncio
async def test_fresh_measured_congestion_changes_ranking_without_exposing_fake_wait():
    now = datetime(2026, 8, 20, 1, 0, tzinfo=timezone.utc)
    candidate = {"id": "measured", "name": "현장 식당", "type": "restaurant", "latitude": 35.836, "longitude": 129.21, "features": {}}
    common = dict(
        user_id="u", preferred_categories=["restaurant"], original_congestion_level=None,
        candidate_facility=candidate, user_lat=35.836, user_lng=129.21,
        user_vector=[1.0 / (8 ** 0.5)] * 8, depart_time=now,
        travel_time_override=5.0, travel_distance_override=330.0, travel_source="estimated",
    )
    with patch("app.services.spot.score.calculate_preference_similarity", new=AsyncMock(return_value=0.8)), \
         patch("app.services.spot.score.predict_congestion_detailed", side_effect=AssertionError("model must not run")), \
         patch("app.services.spot.score.get_model_info", return_value={"version": None}):
        quiet = await calculate_spot_score(**common, congestion_evidence={
            "source": "measured", "level": 0.2, "evidence_tier": "verified", "timestamp": (now - timedelta(minutes=5)).isoformat(),
        })
        busy = await calculate_spot_score(**common, congestion_evidence={
            "source": "measured", "level": 0.8, "evidence_tier": "verified", "timestamp": (now - timedelta(minutes=5)).isoformat(),
        })
    assert quiet.score > busy.score
    assert quiet.breakdown["scoring_mode"] == "measured_rules"
    assert quiet.breakdown["wait_time"] is None
    assert quiet.breakdown["ranking_wait_time"] is not None
    assert quiet.breakdown["prediction_source"] == "measured"


@pytest.mark.asyncio
async def test_restaurant_preference_intent_uses_menu_and_cuisine_facts():
    vector = [1.0 / (8 ** 0.5)] * 8
    matched = await calculate_preference_similarity(
        "u", "restaurant", ["restaurant"], {"cuisine_tags": ["한식", "육류,고기"], "first_menu": "숯불갈비"},
        vector, facility_name="갈비집", preference_intent="고기",
    )
    unmatched = await calculate_preference_similarity(
        "u", "restaurant", ["restaurant"], {"cuisine_tags": ["카페,디저트"], "first_menu": "케이크"},
        vector, facility_name="디저트집", preference_intent="고기",
    )
    assert matched > unmatched


def test_spot_weights_parity_with_shared_types():
    # 6. 프론트 공유 상수(packages/shared-types/spot.ts)와 백엔드 가중치 정합성 검증 (D5).
    #    한쪽만 수정하면 CI 가 여기서 실패한다. (Docker 등 모노레포 밖 실행 시엔 skip)
    repo_root = Path(__file__).resolve().parents[4]
    spot_ts = repo_root / "packages" / "shared-types" / "spot.ts"
    if not spot_ts.exists():
        pytest.skip("packages/shared-types/spot.ts 부재(모노레포 밖 실행) — 패리티 검증 생략")

    text = spot_ts.read_text(encoding="utf-8")
    def _read(key: str) -> float:
        m = re.search(rf"{key}:\s*([0-9.]+)", text)
        assert m, f"shared-types spot.ts 에서 {key} 가중치를 찾지 못했습니다"
        return float(m.group(1))

    assert _read("preference") == pytest.approx(W1)
    assert _read("time") == pytest.approx(W2)
    assert _read("incentive") == pytest.approx(W3)
    # 인센티브 내부 구성비도 정합 검증 (SPOT_INCENTIVE)
    assert _read("couponShare") == pytest.approx(INCENTIVE_COUPON_SHARE)
    assert _read("couponRateCap") == pytest.approx(COUPON_RATE_CAP)
