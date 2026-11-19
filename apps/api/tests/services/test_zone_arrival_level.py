"""구역 근거의 도착 시각 혼잡(congestion_evidence.zone_arrival_level) — 서울 S3 engine_design.

규칙(벽시계 W = wall_now, 관측 O = observed_at, 도착 A):
  · persistence — 0 ≤ A − O ≤ 30분 그리고 0 ≤ W − O ≤ 30분.
  · 공급원 예측 — W − O(발행 나이) ≤ 90분, 단계가 있는 예측점 중 A 에 가장 가까운 점의 |대상 − A| ≤ 30분.
  · 둘 다 되면 시간상 가까운 쪽(동점은 persistence).
  · 여러 구역이면 도착 시각의 최댓값. 음의 지평(A < O)은 말하지 않는다.

다른 테스트 모듈(test_spot_zone_evidence · 라우터 테스트)이 이 파일의 빌더를 함께 쓴다.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.services import congestion_evidence as ce
from app.services.congestion_evidence import (
    ZoneArrival,
    evidence_is_current,
    own_model_zone_level,
    rankable_measured_level,
    zone_arrival_level,
)
from app.services.crowd.zone_evidence import (
    ZONE_EVIDENCE_TIER,
    ZoneReading,
    band_for_level,
    zone_evidence_dict,
)

W = datetime(2026, 10, 31, 3, 0, tzinfo=timezone.utc)  # 12:00 KST
SCALE = "seoul_congest_4"


def minutes(n: float) -> timedelta:
    return timedelta(minutes=n)


def reading(
    zone_id: str = "seoul:POI078",
    *,
    observed: datetime,
    level: float,
    forecast: tuple[tuple[datetime, float | None], ...] = (),
    name: str | None = None,
    usual: str | None = None,
    scale: str = SCALE,
) -> ZoneReading:
    """zone_evidence.ZoneReading — 라벨이 없으면 단계 값으로 단계 이름을 정한다(실제 적재와 같은 규칙)."""
    return ZoneReading(
        zone_id=zone_id,
        zone_name=name or {"seoul:POI078": "인사동", "seoul:POI012": "창덕궁·종묘"}.get(zone_id, zone_id),
        cluster="jongno",
        provider="seoul_citydata",
        level=level,
        level_band=band_for_level(level, scale),
        level_scale=scale,
        observed_at=observed,
        fetched_at=observed + minutes(2),
        population_min=1000,
        population_max=2000,
        forecast=tuple(
            (target, value, band_for_level(value, scale) if value is not None else None)
            for target, value in sorted(forecast, key=lambda point: point[0])
        ),
        usual_comparison=usual,
    )


def zone_evidence(*readings: ZoneReading, wall_now: datetime = W) -> dict:
    """build_candidate_evidence 가 만드는 것과 같은 모양(zone_evidence_dict + estimate/is_current)."""
    evidence = zone_evidence_dict(readings, wall_now=wall_now)
    return {**evidence, "estimate": None, "is_current": evidence_is_current(evidence, now=wall_now)}


def arrive(evidence: dict, arrival: datetime, wall_now: datetime = W) -> ZoneArrival | None:
    return zone_arrival_level(evidence, arrival, wall_now=wall_now)


# ── persistence 창 ────────────────────────────────────────────────────────────


def test_persistence_accepts_30_minutes_after_the_observation_and_rejects_31():
    ev = zone_evidence(reading(observed=W, level=0.375))
    at_30 = arrive(ev, W + minutes(30))
    assert at_30 is not None and at_30.basis == "persistence" and at_30.level == 0.375
    assert at_30.band == "normal"
    assert arrive(ev, W + minutes(31)) is None


def test_persistence_needs_a_wall_clock_age_of_at_most_30_minutes():
    # 도착 = 지금(관측 후 30분) — 지평도 나이도 30분이면 된다.
    assert arrive(zone_evidence(reading(observed=W - minutes(30), level=0.375)), W).basis == "persistence"
    # 나이 31분 — 지평이 0이어도(도착 = 관측 시각) 지금을 말할 수 없다.
    stale = zone_evidence(reading(observed=W - minutes(31), level=0.375))
    assert arrive(stale, W - minutes(31)) is None


# ── 공급원 예측 창 ────────────────────────────────────────────────────────────


def test_forecast_issue_age_90_minutes_is_usable_and_91_is_not():
    arrival = W + minutes(60)
    fresh = zone_evidence(reading(observed=W - minutes(90), level=0.125, forecast=((arrival, 0.625),)))
    got = arrive(fresh, arrival)
    assert got is not None and got.basis == "provider_forecast" and got.level == 0.625
    assert got.forecast_target_at == arrival.isoformat()
    old = zone_evidence(reading(observed=W - minutes(91), level=0.125, forecast=((arrival, 0.625),)))
    assert arrive(old, arrival) is None


def test_forecast_gap_30_minutes_matches_and_31_does_not():
    arrival = W + minutes(90)
    at_30 = zone_evidence(reading(observed=W, level=0.125, forecast=((arrival + minutes(30), 0.875),)))
    assert arrive(at_30, arrival).level == 0.875
    at_31 = zone_evidence(reading(observed=W, level=0.125, forecast=((arrival - minutes(31), 0.875),)))
    assert arrive(at_31, arrival) is None


def test_forecast_point_without_a_level_is_skipped_for_the_nearest_point_with_one():
    arrival = W + minutes(60)
    ev = zone_evidence(reading(
        observed=W, level=0.125,
        forecast=((arrival, None), (arrival + minutes(20), 0.625)),
    ))
    got = arrive(ev, arrival)
    assert got.basis == "provider_forecast" and got.level == 0.625


# ── persistence vs 예측: 시간상 가까운 쪽 ─────────────────────────────────────


def test_tie_between_persistence_and_forecast_goes_to_persistence():
    arrival = W + minutes(10)  # gap_p = 10
    ev = zone_evidence(reading(observed=W, level=0.375, forecast=((arrival + minutes(10), 0.875),)))
    got = arrive(ev, arrival)
    assert got.basis == "persistence" and got.level == 0.375


def test_one_minute_either_side_of_the_tie():
    arrival = W + minutes(10)  # gap_p = 10
    closer = zone_evidence(reading(observed=W, level=0.375, forecast=((arrival + minutes(9), 0.875),)))
    assert arrive(closer, arrival).basis == "provider_forecast"
    farther = zone_evidence(reading(observed=W, level=0.375, forecast=((arrival + minutes(11), 0.875),)))
    assert arrive(farther, arrival).basis == "persistence"


def test_course_stops_at_plus_60_and_plus_120_use_a_forecast_issued_10_minutes_ago():
    issued = W - minutes(10)
    ev = zone_evidence(reading(
        observed=issued, level=0.125,
        forecast=(
            (issued + minutes(60), 0.375), (issued + minutes(70), 0.625),
            (issued + minutes(120), 0.875), (issued + minutes(130), 0.625),
        ),
    ))
    stop2 = arrive(ev, W + minutes(60))
    stop3 = arrive(ev, W + minutes(120))
    assert stop2.basis == stop3.basis == "provider_forecast"
    assert stop2.forecast_target_at == (issued + minutes(70)).isoformat() and stop2.level == 0.625
    assert stop3.forecast_target_at == (issued + minutes(130)).isoformat() and stop3.level == 0.625


def test_assumed_time_three_hours_ahead_can_rank_only_through_a_forecast():
    arrival = W + minutes(180)
    no_forecast = zone_evidence(reading(observed=W - minutes(5), level=0.875))
    assert arrive(no_forecast, arrival) is None  # 지금 관측을 세 시간 뒤로 복사하지 않는다
    with_forecast = zone_evidence(reading(
        observed=W - minutes(5), level=0.875, forecast=((arrival + minutes(15), 0.375),),
    ))
    got = arrive(with_forecast, arrival)
    assert got.basis == "provider_forecast" and got.level == 0.375


def test_two_zones_with_crossing_forecasts_take_the_max_at_arrival():
    falling = reading(
        "seoul:POI078", observed=W, level=0.875,
        forecast=((W + minutes(60), 0.125),),
    )
    rising = reading(
        "seoul:POI012", observed=W, level=0.125,
        forecast=((W + minutes(60), 0.625),),
    )
    ev = zone_evidence(falling, rising)
    now_arrival = arrive(ev, W + minutes(5))
    assert (now_arrival.zone_id, now_arrival.level, now_arrival.basis) == ("seoul:POI078", 0.875, "persistence")
    later = arrive(ev, W + minutes(60))
    assert (later.zone_id, later.level, later.basis) == ("seoul:POI012", 0.625, "provider_forecast")
    assert later.zone_name == "창덕궁·종묘"


def test_negative_horizon_is_rejected():
    ev = zone_evidence(reading(
        observed=W, level=0.375, forecast=((W + minutes(10), 0.875),),
    ))
    assert arrive(ev, W - minutes(1)) is None


def test_future_observation_from_clock_skew_is_not_evidence():
    ev = zone_evidence(reading(observed=W + minutes(2), level=0.375), wall_now=W + minutes(5))
    assert arrive(ev, W + minutes(3), wall_now=W) is None


# ── 경계 밖 ───────────────────────────────────────────────────────────────────


def test_non_zone_evidence_has_no_arrival_level():
    measured = {
        "level": 0.4, "source": "measured", "evidence_tier": "verified",
        "timestamp": W.isoformat(), "is_stale": False,
    }
    assert zone_arrival_level(measured, W, wall_now=W) is None
    assert zone_arrival_level(None, W, wall_now=W) is None
    assert zone_arrival_level({"source": "none"}, W, wall_now=W) is None


def test_zone_evidence_never_passes_the_trusted_measurement_gate():
    """순위의 신뢰 실측 문은 그대로다 — 구역 근거는 도착 시각 규칙으로만 들어간다."""
    ev = zone_evidence(reading(observed=W, level=0.375))
    assert ev["evidence_tier"] == ZONE_EVIDENCE_TIER
    assert rankable_measured_level(ev, now=W) is None
    assert ce.TRUSTED_EVIDENCE_TIERS == {"verified", "corroborated"}


def test_evidence_is_current_delegates_the_zone_tier_to_the_30_minute_zone_rule():
    assert evidence_is_current(zone_evidence(reading(observed=W - minutes(30), level=0.2)), now=W) is True
    assert evidence_is_current(zone_evidence(reading(observed=W - minutes(31), level=0.2)), now=W) is False
    # 미래 관측은 지금이 아니다
    assert evidence_is_current(
        zone_evidence(reading(observed=W + minutes(1), level=0.2), wall_now=W + minutes(1)), now=W
    ) is False


def test_own_model_hook_is_an_explicit_no_op():
    assert own_model_zone_level({"id": "seoul:POI078"}, W) is None


@pytest.mark.parametrize("level,band", [(0.125, "relaxed"), (0.375, "normal"), (0.625, "slightly_busy"), (0.875, "busy")])
def test_arrival_band_follows_the_provider_scale(level, band):
    assert arrive(zone_evidence(reading(observed=W, level=level)), W).band == band


def test_one_zone_that_cannot_speak_at_arrival_blocks_the_max():
    """두 구역 중 하나가 낡아(45분 · 예측 없음) 도착 시각을 말하지 못하면, 남은 조용한 구역만으로 최댓값을 내지 않는다."""
    stale = reading("seoul:POI078", observed=W - minutes(45), level=0.875)
    quiet = reading("seoul:POI012", observed=W - minutes(2), level=0.125)
    ev = zone_evidence(stale, quiet)
    assert arrive(ev, W + minutes(5)) is None
    assert arrive(zone_evidence(quiet), W + minutes(5)).level == 0.125  # 한 구역뿐이면 그대로 말한다
