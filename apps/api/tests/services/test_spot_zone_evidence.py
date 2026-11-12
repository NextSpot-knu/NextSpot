"""SPOT 채점의 구역 근거(서울 S3) — score.py 의 구역 분기·지역 게이트.

  · 구역 근거는 measured_rules / 'measured' 로 들어간다(새 scoring_mode 없음).
  · 도착 단계가 눈금의 최상단('붐빔')이면 기존 컷오프 강등을 탄다. '약간 붐빔' 은 아니다.
  · 같은 구역의 재배치 기여는 0(같은 도착 시각의 출발지와 비교 — 반사실).
  · '평소보다' 는 화면 문구 전용이다 — 점수·순위가 바뀌지 않는다.
  · 구역 근거가 아닌 후보의 breakdown 키 집합은 변경 전 목록 그대로다.
  · 경주가 아닌 지역은 주변 수요·경주 학습 모델·업종 로그 기준선을 부르지 않는다.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.services.spot import score as score_module
from app.services.spot.ranking import (
    CROWDED_EVIDENCE_CUTOFF,
    WEAKEST_EVIDENCE_TIER,
    scoring_evidence_tier,
    spot_ranking_sort_key,
)
from app.services.spot.score import calculate_spot_score
from tests.services.test_zone_arrival_level import W, minutes, reading, zone_evidence

SEOUL = "seoul"

# 구역 근거 도입 **전** score.py 의 breakdown 키(문자 그대로). 경주 후보는 이 집합에서 한 개도 늘거나 줄지 않는다.
PRE_CHANGE_BREAKDOWN_KEYS = frozenset({
    "preference", "tourapi_related_rank", "tourapi_related_prior", "wait_time", "travel_time",
    "travel_distance_m", "travel_source", "ranking_wait_time", "ranking_congestion",
    "industry_baseline_congestion", "industry_baseline_wait_time", "congestion_input_source",
    "incentive", "incentive_coupon", "incentive_relief", "event_boost", "event_title",
    "tourapi_concentration_prior", "area_demand_level", "area_demand_mode", "area_demand_confidence",
    "area_demand_sources", "area_demand_observed_at", "area_demand_radius_m", "area_demand_components",
    "area_demand_parking_evidence", "area_demand_tourism_evidence", "area_demand_penalty_minutes",
    "scoring_mode", "model_version", "prediction_source",
})
ZONE_BREAKDOWN_KEYS = frozenset({
    "congestion_arrival_basis", "zone_id", "zone_name", "zone_level_band", "zone_arrival_level_band",
    "zone_observed_at", "zone_forecast_target_at", "zone_usual_comparison", "zone_is_current", "zone_partial",
})


def _candidate(fid: str = "seoul-cafe", ftype: str = "cafe") -> dict:
    return {
        "id": fid, "type": ftype, "latitude": 37.5738, "longitude": 126.9860, "capacity": 40,
        "features": {"average_processing_time": 10}, "coupon_rate": 0.0,
    }


@pytest.fixture
def isolated_inputs():
    """선호·이동만 고정한다(대기 공식은 실제로 돈다). 경주 전용 입력은 불리면 실패한다."""
    explode_area = AsyncMock(side_effect=AssertionError("area demand must not be called for seoul"))
    explode_model = AssertionError("gyeongju model must not be called for seoul")

    def _model(*_args, **_kwargs):
        raise explode_model

    explode_baseline = AsyncMock(side_effect=AssertionError("industry baseline must not be called for seoul"))
    with patch.object(score_module, "calculate_preference_similarity", new=AsyncMock(return_value=0.6)), \
         patch.object(score_module, "get_area_demand_signal", new=explode_area), \
         patch.object(score_module, "predict_congestion_detailed", new=_model), \
         patch.object(score_module, "get_industry_baseline_congestion", new=explode_baseline), \
         patch.object(score_module, "get_model_info", return_value={"trained": True, "version": "gj-v9"}):
        yield {"area": explode_area, "baseline": explode_baseline}


async def _score(evidence: dict | None, *, travel: float = 10.0, origin: float | None = None,
                 origin_zone: dict | None = None, depart=None, fid: str = "seoul-cafe") -> dict:
    result = await calculate_spot_score(
        user_id="dev",
        preferred_categories=["cafe"],
        original_congestion_level=origin,
        candidate_facility=_candidate(fid),
        user_lat=37.5735, user_lng=126.9855,
        user_vector=[1.0] * 8,
        depart_time=depart,
        congestion_evidence=evidence,
        travel_time_override=travel,
        travel_distance_override=travel * 70,
        travel_source="estimated",
        region=SEOUL,
        evidence_now=W,
        origin_zone_evidence=origin_zone,
    )
    return {"score": result.score, **result.breakdown}


@pytest.mark.asyncio
async def test_current_zone_evidence_scores_as_measured_rules(isolated_inputs):
    bd = await _score(zone_evidence(reading(observed=W - minutes(5), level=0.375)), depart=W)
    assert bd["scoring_mode"] == "measured_rules"
    assert bd["prediction_source"] == "measured"
    assert bd["congestion_input_source"] == "measured"
    assert bd["congestion_arrival_basis"] == "persistence"
    assert bd["zone_id"] == "seoul:POI078" and bd["zone_name"] == "인사동"
    assert bd["zone_level_band"] == bd["zone_arrival_level_band"] == "normal"
    # measured_rules 의 의미는 그대로 — 대기는 순위 비용에만, 화면 대기는 없음, 주변 수요 패널티 0
    assert bd["wait_time"] is None and bd["ranking_wait_time"] > 0
    assert bd["area_demand_penalty_minutes"] == 0.0 and bd["area_demand_level"] is None
    assert bd["model_version"] is None  # 경주 모델은 서울 점수에 쓰이지 않는다
    assert set(bd) - {"score"} == PRE_CHANGE_BREAKDOWN_KEYS | ZONE_BREAKDOWN_KEYS
    isolated_inputs["area"].assert_not_called()


@pytest.mark.asyncio
async def test_busy_arrival_is_demoted_to_the_weakest_tier_but_slightly_busy_is_not(isolated_inputs):
    busy = await _score(zone_evidence(reading(observed=W, level=0.875)), depart=W)
    slightly = await _score(zone_evidence(reading(observed=W, level=0.625)), depart=W)
    assert busy["zone_arrival_level_band"] == "busy"
    assert busy["ranking_congestion"] == pytest.approx(max(0.875, CROWDED_EVIDENCE_CUTOFF))
    assert scoring_evidence_tier(busy["scoring_mode"], busy["ranking_congestion"]) == WEAKEST_EVIDENCE_TIER
    assert slightly["zone_arrival_level_band"] == "slightly_busy"
    assert slightly["ranking_congestion"] == pytest.approx(0.625)
    assert scoring_evidence_tier(slightly["scoring_mode"], slightly["ranking_congestion"]) == 0


@pytest.mark.asyncio
async def test_busy_forecast_at_arrival_is_demoted_even_when_it_is_relaxed_now(isolated_inputs):
    ev = zone_evidence(reading(observed=W, level=0.125, forecast=((W + minutes(60), 0.875),)))
    bd = await _score(ev, travel=60.0, depart=W)
    assert bd["congestion_arrival_basis"] == "provider_forecast"
    assert bd["zone_level_band"] == "relaxed" and bd["zone_arrival_level_band"] == "busy"
    assert scoring_evidence_tier(bd["scoring_mode"], bd["ranking_congestion"]) == WEAKEST_EVIDENCE_TIER


@pytest.mark.asyncio
async def test_same_zone_relief_is_zero_even_with_a_falling_forecast(isolated_inputs):
    falling = reading(observed=W, level=0.875, forecast=((W + minutes(30), 0.375),))
    origin = zone_evidence(falling)
    candidate = zone_evidence(falling)
    bd = await _score(candidate, travel=30.0, depart=W, origin=0.875, origin_zone=origin)
    assert bd["congestion_arrival_basis"] == "provider_forecast"
    assert bd["incentive_relief"] == 0.0
    # 대조: 출발지 구역 근거 없이 '지금' 값(0.875)만 주면 종전 의미대로 0.5 의 기여가 붙는다.
    legacy = await _score(candidate, travel=30.0, depart=W, origin=0.875)
    assert legacy["incentive_relief"] == pytest.approx(0.5)


@pytest.mark.asyncio
async def test_relief_compares_the_origin_at_the_candidates_arrival_time(isolated_inputs):
    origin = zone_evidence(reading(
        "seoul:POI012", observed=W, level=0.375, forecast=((W + minutes(30), 0.875),),
    ))
    candidate = zone_evidence(reading(observed=W, level=0.125, forecast=((W + minutes(30), 0.375),)))
    bd = await _score(candidate, travel=30.0, depart=W, origin=0.375, origin_zone=origin)
    assert bd["incentive_relief"] == pytest.approx(0.5)  # 0.875(그 시각 출발지) − 0.375(도착 시 후보)


@pytest.mark.asyncio
async def test_usual_comparison_never_changes_the_score(isolated_inputs):
    results = []
    for usual in (None, "busier", "usual", "quieter"):
        bd = await _score(zone_evidence(reading(observed=W, level=0.375, usual=usual)), depart=W)
        assert bd["zone_usual_comparison"] == usual
        results.append({k: v for k, v in bd.items() if k != "zone_usual_comparison"})
    assert all(result == results[0] for result in results)


@pytest.mark.asyncio
async def test_stale_zone_evidence_without_arrival_level_is_degraded_and_never_model(isolated_inputs):
    stale = zone_evidence(reading(observed=W - minutes(50), level=0.375))
    bd = await _score(stale, depart=W)
    assert bd["scoring_mode"] == "degraded_rules"
    assert bd["prediction_source"] == "unavailable"
    assert bd["congestion_arrival_basis"] is None and bd["zone_arrival_level_band"] is None
    assert bd["zone_observed_at"] == (W - minutes(50)).isoformat()  # 'N분 전 관측' 은 그대로 싣는다
    assert bd["industry_baseline_congestion"] is None
    isolated_inputs["baseline"].assert_not_called()
    isolated_inputs["area"].assert_not_called()


@pytest.mark.asyncio
async def test_seoul_without_any_evidence_never_uses_the_gyeongju_model(isolated_inputs):
    bd = await _score(None, depart=W)
    assert bd["scoring_mode"] == "degraded_rules"
    assert bd["model_version"] is None
    assert set(bd) - {"score"} == PRE_CHANGE_BREAKDOWN_KEYS  # 구역 근거가 아니면 구역 키도 없다


@pytest.mark.asyncio
async def test_non_zone_breakdown_key_set_equals_the_pre_change_list():
    """경주 기본 호출(새 인자 없음) — breakdown 키 집합이 변경 전 목록과 같다."""
    with patch.object(score_module, "calculate_preference_similarity", new=AsyncMock(return_value=0.6)), \
         patch.object(score_module, "predict_congestion_detailed", new=lambda *a, **k: (0.5, "registry")), \
         patch.object(score_module, "get_model_info", return_value={"trained": True, "version": "gj-v9"}):
        result = await calculate_spot_score(
            user_id="u", preferred_categories=["cafe"], original_congestion_level=0.9,
            candidate_facility={**_candidate("gj"), "latitude": 35.836, "longitude": 129.21},
            user_lat=35.8355, user_lng=129.2095, user_vector=[1.0] * 8,
            travel_time_override=8.0, travel_distance_override=500.0, travel_source="osm",
        )
    assert set(result.breakdown) == PRE_CHANGE_BREAKDOWN_KEYS
    assert result.breakdown["scoring_mode"] == "model"
    assert result.breakdown["model_version"] == "gj-v9"


@pytest.mark.asyncio
async def test_in_zone_current_candidates_share_tier_zero_and_are_ordered_by_score(isolated_inputs):
    scored = []
    for fid, level, travel in (("a", 0.125, 12.0), ("b", 0.375, 4.0), ("c", 0.625, 8.0), ("d", 0.125, 3.0)):
        ev = zone_evidence(reading(observed=W - minutes(3), level=level))
        bd = await _score(ev, travel=travel, depart=W, fid=fid)
        scored.append((fid, bd))
    assert {scoring_evidence_tier(bd["scoring_mode"], bd["ranking_congestion"]) for _, bd in scored} == {0}
    ordered = sorted(
        scored,
        key=lambda item: spot_ranking_sort_key(
            item[1]["scoring_mode"], item[1]["score"], item[1]["travel_distance_m"], item[0],
            item[1]["ranking_congestion"],
        ),
    )
    scores = [bd["score"] for _, bd in ordered]
    assert scores == sorted(scores, reverse=True)
    assert ordered[0][0] == "d"  # 가장 가깝고 가장 한산 — 같은 등급 안에서 점수로만 겨룬다


def test_zone_reason_wording_by_band_and_non_zone_templates_unchanged():
    from app.services.reason_service import _build_template

    base = {"recommended_facility_name": "한옥카페", "travel_time": 4.2, "congestion_evidence_tier": "zone_measured",
            "zone_name": "인사동", "candidate_congestion": None, "congestion_source": "none"}
    # 단계 이름은 앱 공통 혼잡 등급(한산·여유·보통·혼잡)이다 — 칩·지도 핀(단계 중앙값 → congestionKey)과 같은 말.
    relaxed = _build_template({**base, "zone_band": "normal", "zone_usual_comparison": "quieter"})
    assert relaxed == "한옥카페 추천: 도보 5분, 인사동 권역 여유 수준입니다. 평소 이 시간보다 한산한 편이에요."
    moderate = _build_template({**base, "zone_band": "slightly_busy"})
    assert moderate == "한옥카페 추천: 도보 5분, 인사동 권역 보통 수준입니다."
    busy = _build_template({**base, "zone_band": "busy"})
    assert busy == "한옥카페: 도보 5분, 인사동 권역 혼잡 수준으로 도착할 즈음 붐벼 대기가 길 수 있어요."
    assert "%" not in relaxed + moderate + busy
    # 단계를 모르면 혼잡을 말하지 않는 종전 문장으로 내려간다.
    assert _build_template({**base, "zone_band": None}) == "한옥카페 추천: 도보 5분 수준입니다."
    # 구역이 아닌 근거 — 종전 문장 그대로(문자 그대로 잠근다).
    measured = {"recommended_facility_name": "한옥카페", "travel_time": 4.2, "candidate_congestion": 0.3,
                "congestion_source": "measured"}
    assert _build_template(measured) == "한옥카페 추천: 도보 5분, 혼잡도 30% 수준으로 여유가 있습니다."


def test_zone_reason_claims_arrival_crowding_only_with_an_arrival_level():
    """엔진이 도착 단계를 내지 못했는데(관측 25분 전 + 도보 8분 → 지평 초과) '지금' 단계로 '도착할 즈음 붐벼' 를 말하지 않는다.

    코스 정차 사유(도착 단계 없으면 혼잡 주장 없음)와 어긋나지 않게 — '지금' 단계는 현재형으로만 말한다.
    """
    from app.routers.recommendations import _zone_reason_ctx
    from app.services.reason_service import _build_template

    base = {"recommended_facility_name": "한옥카페", "travel_time": 8.0}
    now_only = _zone_reason_ctx({
        "congestion_evidence": {"is_current": True},
        "breakdown": {"zone_arrival_level_band": None, "zone_level_band": "busy", "zone_name": "인사동"},
    })
    text_now = _build_template({**base, **now_only})
    assert "도착" not in text_now
    assert text_now == "한옥카페: 도보 8분, 인사동 권역 혼잡 수준이라 지금 붐비는 편이에요."

    arrival = _zone_reason_ctx({
        "congestion_evidence": {"is_current": True},
        "breakdown": {"zone_arrival_level_band": "busy", "zone_level_band": "normal", "zone_name": "인사동"},
    })
    text_arrival = _build_template({**base, **arrival})
    assert text_arrival == "한옥카페: 도보 8분, 인사동 권역 혼잡 수준으로 도착할 즈음 붐벼 대기가 길 수 있어요."


def test_zone_band_words_match_the_web_congestion_vocabulary():
    """서버 사유·코스 문장의 단계 이름 = 웹 ko 의 congestion.* (단계 중앙값이 웹 congestionKey 로 가는 등급).

    같은 관측을 구역 줄은 '보통', 칩은 '여유' 로 말하던 어긋남을 막는다(DESIGN_PRINCIPLES 7 — 단계마다 이름 하나).
    """
    import json
    from pathlib import Path

    from app.routers.courses import _ZONE_BAND_LABEL as COURSE_LABEL
    from app.services.crowd.zone_evidence import band_for_level
    from app.services.reason_service import _ZONE_BAND_LABEL as REASON_LABEL

    ko = json.loads(
        (Path(__file__).resolve().parents[4] / "apps/web/lib/i18n/messages/ko.json").read_text(encoding="utf-8")
    )["congestion"]

    def web_key(level: float) -> str:  # apps/web/lib/congestionScale.ts congestionKey(기본 경계 0.75)
        return "busy" if level >= 0.75 else "moderate" if level >= 0.5 else "relaxed" if level >= 0.25 else "quiet"

    for level in (0.125, 0.375, 0.625, 0.875):
        band = band_for_level(level, "seoul_congest_4")
        assert REASON_LABEL[band] == ko[web_key(level)] == COURSE_LABEL[band], band
