"""추정 모드 근거(docs/CONGESTION_ENGINE_PLAN.md §5.2) — 추정이 **어디까지 들어가고 어디서 멈추는가.**

추정은 화면에 '추정' 으로 보이는 옆 칸(evidence["estimate"])까지만 간다. 순위·실측 판정·대기
분·학습은 evidence["source"] / ["level"] 을 보는데, 추정이 붙어도 그 둘은 'none' / None 그대로다.
이 파일이 그 경계를 잠근다:

  1. 우선순위: measured(사장 좌석 포함) > predicted(학습 모델) > estimated > none
  2. 추정은 rankable_measured_level·scoring_mode·시간비용·대기 분에 닿지 않는다. 닿는 곳은 딱 하나 —
     area_stats_rules 후보의 붐빔 판정(ranking_congestion → CROWDED_EVIDENCE_CUTOFF, 강등 전용)
  3. 추정기를 못 쓰면(낡음·실패·지연) 조용히 '추정 없음' — 추천을 죽이지 않는다
  4. 코스의 '지금' 추정은 관측 후 30분 안의 도착에만 붙는다
"""

import asyncio
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

from app.services import congestion_estimator_service
from app.services.congestion_evidence import (
    ESTIMATE_SOURCE,
    attach_estimate,
    estimate_applies_to_arrival,
    estimate_for,
    load_current_estimates,
    rankable_measured_level,
)
from app.services.spot.ranking import (
    EVIDENCE_TIER_BY_SCORING_MODE,
    WEAKEST_EVIDENCE_TIER,
    scoring_evidence_tier,
    spot_ranking_sort_key,
)
from app.services.spot.score import calculate_spot_score

REPO_ROOT = Path(__file__).resolve().parents[4]
NOW = datetime(2026, 9, 20, 5, 0, tzinfo=timezone.utc)  # 14:00 KST
UNIT_VECTOR = [1.0 / (8 ** 0.5)] * 8

_ESTIMATE_ROW = {
    "level": 0.82,
    "parking_level": 0.9,
    "tourism_level": 0.63,
    "zone": "7167:25842",
    "lot_count": 3,
    "nearest_lot_m": 220,
}


def _current(observed_at: datetime = NOW - timedelta(minutes=4), **estimates) -> dict:
    return {
        "available": True,
        "reason": None,
        "observed_at": observed_at.isoformat(),
        "bucket_at": observed_at.replace(minute=0).isoformat(),
        "lot_count": 4,
        "estimates": estimates or {"f-1": dict(_ESTIMATE_ROW)},
    }


_NONE = {"level": None, "source": "none", "log_source": None,
         "evidence_tier": None, "is_stale": None, "timestamp": None}


# =========================================================================
# 1. 우선순위 — 추정은 'none' 자리에만 앉는다
# =========================================================================

def test_estimate_fills_only_the_none_slot():
    evidence = attach_estimate(_NONE, _current(), "f-1", now=NOW)

    # 옆 칸에만 실린다 — source / level 은 '근거 없음' 그대로다.
    assert evidence["source"] == "none"
    assert evidence["level"] is None
    estimate = evidence["estimate"]
    assert estimate["source"] == ESTIMATE_SOURCE == "estimated"
    assert estimate["level"] == pytest.approx(0.82)
    # 화면이 '주차 실측 기반 · HH:MM 관측 · 반경 2km' 를 그릴 재료가 전부 있다.
    assert estimate["observed_at"] == (NOW - timedelta(minutes=4)).isoformat()
    assert estimate["radius_m"] == 2000
    assert estimate["lot_count"] == 3
    assert estimate["parking_level"] == pytest.approx(0.9)
    assert estimate["tourism_level"] == pytest.approx(0.63)
    # 인원수·대기 분은 없다(점유율 → 인원 계수가 없다).
    assert "current_count" not in estimate
    assert not any("wait" in key for key in estimate)


@pytest.mark.parametrize("source", ["measured", "predicted"])
def test_measured_and_predicted_both_beat_the_estimate(source):
    evidence = {**_NONE, "source": source, "level": 0.3}
    out = attach_estimate(evidence, _current(), "f-1", now=NOW)
    assert out["estimate"] is None
    assert out["source"] == source and out["level"] == 0.3


def test_attach_does_not_mutate_the_input_evidence():
    original = dict(_NONE)
    attach_estimate(original, _current(), "f-1", now=NOW)
    assert original == _NONE


def test_no_estimate_for_a_facility_outside_every_parking_radius():
    # 추정기는 반경 2km 에 실시간 주차장이 없는 시설의 키를 만들지 않는다 — 여기서도 지어내지 않는다.
    assert attach_estimate(_NONE, _current(), "far-away", now=NOW)["estimate"] is None


def test_unavailable_bundle_yields_no_estimate():
    stale = {**_current(), "available": False, "reason": "parking_snapshot_stale"}
    assert estimate_for(stale, "f-1", now=NOW) is None
    assert attach_estimate(_NONE, None, "f-1")["estimate"] is None


@pytest.mark.parametrize("bad_level", [1.4, -0.1, "high", None])
def test_malformed_estimate_is_dropped_not_shown(bad_level):
    current = _current(**{"f-1": {**_ESTIMATE_ROW, "level": bad_level}})
    assert estimate_for(current, "f-1", now=NOW) is None


def test_estimate_source_label_matches_the_estimator():
    # 두 모듈이 같은 이름을 써야 화면 분기('estimated')가 한 값으로 맞는다.
    assert ESTIMATE_SOURCE == congestion_estimator_service.ESTIMATE_SOURCE


# =========================================================================
# 2. 순위에 새지 않는다
# =========================================================================

def test_rankable_measured_level_never_accepts_an_estimate():
    evidence = attach_estimate(_NONE, _current(), "f-1", now=NOW)
    assert rankable_measured_level(evidence, now=NOW) is None
    # 누가 실수로 추정 dict 자체를 근거로 넘겨도 통과하지 않는다(source 가 'estimated').
    assert rankable_measured_level(
        {**evidence["estimate"], "evidence_tier": "verified", "timestamp": NOW.isoformat()},
        now=NOW,
    ) is None


def _facility() -> dict:
    return {
        "id": "f-1", "name": "추정 카페", "type": "cafe",
        "latitude": 35.8360, "longitude": 129.2100, "capacity": 40,
        "features": {"average_processing_time": 10}, "coupon_rate": 0.0,
        "tourapi_concentration_rate": 63.0,
    }


async def _score(evidence, *, depart=NOW, predicted=(None, "unavailable")):
    with patch("app.services.spot.score.predict_congestion_detailed", return_value=predicted):
        return await calculate_spot_score(
            user_id="u-1", preferred_categories=["cafe"], original_congestion_level=None,
            candidate_facility=_facility(), user_lat=35.8365, user_lng=129.2100,
            user_vector=UNIT_VECTOR, depart_time=depart, congestion_evidence=evidence,
            travel_time_override=6.0, travel_distance_override=400.0, travel_source="osm_pedestrian",
        )


@pytest.mark.asyncio
async def test_estimate_never_enters_the_time_cost():
    """D2: 추정은 순위에 반영된다 — 단 **시간비용에는 새로 넣지 않는다.**

    같은 주차(반경 2km)·관광 통계 산식이 area_demand_service 를 통해 area_stats_rules 의
    시간비용(패널티)에 이미 들어간다. 추정을 한 번 더 넣으면 이중 계산이다. 그래서 근거에 추정이
    붙어도 점수·모드·대기·패널티는 비트 단위로 같고, 달라지는 것은 붐빔 판정용 ranking_congestion 뿐이다.
    """
    plain = attach_estimate(_NONE, None, "f-1")
    with_estimate = attach_estimate(_NONE, _current(), "f-1", now=NOW)
    assert with_estimate["estimate"] is not None

    a, b = await _score(plain), await _score(with_estimate)
    assert a.score == b.score
    assert {k: v for k, v in a.breakdown.items() if k != "ranking_congestion"} ==         {k: v for k, v in b.breakdown.items() if k != "ranking_congestion"}
    # 관광 통계가 있으니 area_stats_rules — 추정이 없던 때와 같은 모드다.
    assert b.breakdown["scoring_mode"] == "area_stats_rules"
    assert b.breakdown["wait_time"] is None
    assert a.breakdown["ranking_congestion"] is None
    # 붐빔 판정에는 화면에 보이는 바로 그 추정값이 쓰인다(0.82 < 0.9 라 등급은 그대로).
    assert b.breakdown["ranking_congestion"] == pytest.approx(0.82)
    assert scoring_evidence_tier("area_stats_rules", b.breakdown["ranking_congestion"]) == 1


@pytest.mark.asyncio
async def test_an_estimated_crowd_loses_the_tier_advantage_like_a_measured_one():
    """레드팀(2026-09-20) 역전 사례 — '추정 · 매우 혼잡' 이 1위, '실측 · 매우 혼잡' 이 최하 등급.

    컷오프(0.9)는 실측·모델 후보만 강등하고 area_stats_rules 후보는 늘 1등급으로 두었다. 추정이
    화면에 뜨면서 그 비대칭이 보이게 됐다. 이제 같은 선을 같은 방식으로 넘는다.
    """
    crowded = _current(**{"f-1": {**_ESTIMATE_ROW, "level": 0.95}})
    estimated = await _score(attach_estimate(_NONE, crowded, "f-1", now=NOW))
    assert estimated.breakdown["scoring_mode"] == "area_stats_rules"
    assert scoring_evidence_tier("area_stats_rules", estimated.breakdown["ranking_congestion"])         == WEAKEST_EVIDENCE_TIER

    measured = {
        "level": 0.92, "source": "measured", "log_source": "merchant_report",
        "evidence_tier": "verified", "is_stale": False, "timestamp": NOW.isoformat(),
    }
    measured_res = await _score({**measured, "estimate": None})
    assert measured_res.breakdown["scoring_mode"] == "measured_rules"
    # 둘 다 '붐빔 확인' 이라 같은 최하 등급 — 추정이 실측을 등급으로 이기지 못한다.
    assert spot_ranking_sort_key(
        "area_stats_rules", 0.99, 10.0, "est", estimated.breakdown["ranking_congestion"],
    )[0] == spot_ranking_sort_key(
        "measured_rules", 0.10, 900.0, "meas", measured_res.breakdown["ranking_congestion"],
    )[0]


@pytest.mark.asyncio
async def test_a_calm_estimate_never_promotes_and_a_far_arrival_ignores_it():
    calm = _current(**{"f-1": {**_ESTIMATE_ROW, "level": 0.1}})
    res = await _score(attach_estimate(_NONE, calm, "f-1", now=NOW))
    # 강등만 할 수 있다 — 한산 추정이 area_stats_rules 를 실측 등급(0)으로 올리지 않는다.
    assert scoring_evidence_tier(res.breakdown["scoring_mode"], res.breakdown["ranking_congestion"]) == 1

    crowded = _current(**{"f-1": {**_ESTIMATE_ROW, "level": 0.95}})
    later = await _score(
        attach_estimate(_NONE, crowded, "f-1", now=NOW), depart=NOW + timedelta(minutes=50)
    )
    # 도착이 관측 후 30분을 넘으면(코스 뒤 정류지) '지금' 붐빔으로 강등하지 않는다.
    assert later.breakdown["ranking_congestion"] is None


@pytest.mark.asyncio
async def test_a_trained_model_ignores_the_estimate_even_if_one_leaks_in():
    # attach_estimate 는 predicted 근거에 추정을 붙이지 않지만, 누가 붙여도 score 는 모델 값을 쓴다.
    leaked = {**_NONE, "estimate": estimate_for(
        _current(**{"f-1": {**_ESTIMATE_ROW, "level": 0.95}}), "f-1", now=NOW,
    )}
    res = await _score(leaked, predicted=(0.3, "registry"))
    assert res.breakdown["scoring_mode"] == "model"
    assert res.breakdown["ranking_congestion"] == pytest.approx(0.3, abs=0.2)
    assert res.breakdown["ranking_congestion"] < 0.9


def test_estimate_is_not_served_after_the_snapshot_ages_out():
    # 추정기는 계산할 때만 60분을 보고 5분 캐시한다 — 내보낼 때 다시 잰다.
    current = _current(observed_at=NOW - timedelta(minutes=58))
    assert estimate_for(current, "f-1", now=NOW) is not None
    assert estimate_for(current, "f-1", now=NOW + timedelta(minutes=3)) is None
    assert estimate_for(_current(observed_at=NOW + timedelta(minutes=10)), "f-1", now=NOW) is None


def test_no_estimated_scoring_mode_exists_on_either_side():
    """'estimated_rules' 를 만들지 않았다는 결정을 잠근다(이중 계산 방지 — 위 테스트 docstring).

    누군가 모드를 추가하려면 이 테스트를 지우면서 이유를 적어야 한다. 웹 미러
    (apps/web/lib/recommender.ts 의 ScoringMode)와 응답 계약(RecommendItem.scoring_mode)도 같은
    집합이어야 한다 — 한쪽만 늘면 새 모드가 웹에서 '모르는 모드 = 최약체' 로 떨어진다.
    """
    from typing import get_args

    from app.routers.recommendations import RecommendItem

    backend_modes = set(EVIDENCE_TIER_BY_SCORING_MODE)
    response_modes = set(get_args(RecommendItem.model_fields["scoring_mode"].annotation))
    assert backend_modes == response_modes == {
        "model", "measured_rules", "area_stats_rules", "degraded_rules",
    }

    recommender = REPO_ROOT / "apps" / "web" / "lib" / "recommender.ts"
    if not recommender.exists():
        pytest.skip("apps/web/lib/recommender.ts 부재(모노레포 밖 실행)")
    m = re.search(r"export type ScoringMode\s*=\s*([^;]+);", recommender.read_text(encoding="utf-8"))
    assert m, "recommender.ts 에서 ScoringMode 를 찾지 못했다"
    web_modes = set(re.findall(r'"([a-z_]+)"', m.group(1)))
    assert web_modes == backend_modes


def test_congestion_source_contract_is_unchanged_for_old_bundles():
    """배포 시차 가드 — congestion_source 에 'estimated' 를 새 값으로 넣지 않는다.

    구 번들은 source !== 'none' 이면 level 을 실측·예측처럼 칠하고 로컬 SPOT 에도 쓴다.
    추정은 congestion_estimate 옆 칸으로만 나가야 구 번들이 모르고 지나간다.
    """
    from typing import get_args

    from app.routers.recommendations import RecommendItem

    assert set(get_args(RecommendItem.model_fields["congestion_source"].annotation)) == {
        "measured", "predicted", "none",
    }
    assert RecommendItem.model_fields["congestion_estimate"].default is None


# =========================================================================
# 3. 추정기를 못 쓰면 조용히 없다
# =========================================================================

@pytest.mark.asyncio
async def test_load_returns_none_when_the_snapshot_is_stale(monkeypatch):
    async def _stale(*, now=None):
        return {"available": False, "reason": "parking_snapshot_stale", "observed_at": None,
                "bucket_at": None, "lot_count": 0, "estimates": {}}

    monkeypatch.setattr(congestion_estimator_service, "current_estimates", _stale)
    assert await load_current_estimates() is None


@pytest.mark.asyncio
async def test_load_swallows_estimator_failures(monkeypatch):
    async def _boom(*, now=None):
        raise RuntimeError("db down")

    monkeypatch.setattr(congestion_estimator_service, "current_estimates", _boom)
    assert await load_current_estimates() is None


@pytest.mark.asyncio
async def test_load_does_not_hold_the_request_hostage(monkeypatch):
    finished = asyncio.Event()

    async def _slow(*, now=None):
        await asyncio.sleep(0.2)
        finished.set()
        return _current()

    monkeypatch.setattr(congestion_estimator_service, "current_estimates", _slow)
    assert await load_current_estimates(timeout=0.01) is None
    # shield — 이번 응답은 추정 없이 나가도 계산은 끝까지 돌아 캐시를 채운다.
    await asyncio.wait_for(finished.wait(), timeout=2.0)


@pytest.mark.asyncio
async def test_load_passes_through_an_available_bundle(monkeypatch):
    async def _ok(*, now=None):
        return _current()

    monkeypatch.setattr(congestion_estimator_service, "current_estimates", _ok)
    current = await load_current_estimates()
    assert current is not None and "f-1" in current["estimates"]


# =========================================================================
# 4. '지금' 관측은 가까운 도착에만
# =========================================================================

def test_estimate_applies_only_within_thirty_minutes_of_observation():
    estimate = estimate_for(_current(observed_at=NOW), "f-1", now=NOW)
    assert estimate_applies_to_arrival(estimate, NOW + timedelta(minutes=12))
    assert estimate_applies_to_arrival(estimate, NOW + timedelta(minutes=30))
    assert not estimate_applies_to_arrival(estimate, NOW + timedelta(minutes=31))
    # 관측보다 앞선 도착(시계가 어긋난 경우)도 붙이지 않는다.
    assert not estimate_applies_to_arrival(estimate, NOW - timedelta(minutes=1))
    assert not estimate_applies_to_arrival(None, NOW)
    assert not estimate_applies_to_arrival({**estimate, "observed_at": None}, NOW)
