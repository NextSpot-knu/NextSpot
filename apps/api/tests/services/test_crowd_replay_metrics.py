"""S4 분산 결정 재생 — 결정 · 정보 집합(미래 누수 없음) · 기준선 · 지표 · 부트스트랩 · 판정 · V2 · V4 · 글.

엔진을 바꿔 끼운 단위 시험(가짜 엔진은 받은 관측을 기록한다)과, 실제 엔진으로 합성 반출 하나를 끝까지 돌리는 시험이 있다.
"""

from __future__ import annotations

import asyncio
import json
import math
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone

import pytest

from app.services.batch import crowd_dispersion_replay as replay
from app.services.batch.crowd_dispersion_replay import (
    Bootstrap,
    Decision,
    DaySeries,
    ReplayConfig,
    Scored,
    build_populations,
    disagreement_cause,
    policy_outcome,
    v3_verdict,
    v4_verdict,
)
from app.services.batch.crowd_replay_data import ReplayInputError, cluster_zones, load_replay_inputs
from app.services.batch.crowd_replay_engine import CandidateResult, EngineResult, pseudo_id
from app.services.kst_calendar import service_day
from app.services.seoul_alternatives_service import crowd_wait_minutes, grade_level
from tests.fixtures.crowd_replay.synthetic import (
    KST,
    fcst_row,
    memory_inputs,
    obs_row,
    steady_rows,
    write_export,
)

HONG, YEON, HAP = "seoul:POI007", "seoul:POI073", "seoul:POI053"
B0 = datetime(2026, 9, 21, 14, 0, tzinfo=KST)  # 월요일 14:00 KST


def _cand(zone_id: str, *, mode="measured_rules", tier=0, relief=0.1, basis="persistence", score=0.5,
          wait=None, travel=19.0) -> CandidateResult:
    return CandidateResult(
        zone_id=zone_id, facility_id=pseudo_id(zone_id), score=score, scoring_mode=mode, ranking_tier=tier,
        ranking_congestion=None, congestion_arrival_basis=basis, zone_arrival_band=None, incentive_relief=relief,
        ranking_wait_time=wait, travel_time=travel, route_m=travel * 66.67, sort_key=(tier, -score, travel, zone_id),
    )


def _decision(engine_order, *, b_now=3, tau=None, choices=None, t=None) -> Decision:
    t = t or B0.astimezone(timezone.utc)
    tau = tau or {HAP: 21, YEON: 19}
    route = {c: m * 66.67 for c, m in tau.items()}
    ranked = tuple(engine_order)
    decision = Decision(
        origin=HONG, bucket_at=t, phase=10, t=t, t_nominal=t, day=service_day(t), delay_minutes=0.0, b_now=b_now,
        alternatives=tuple(sorted(tau)), tau=tau, route=route, origin_reading=None, readings={}, block=None,
        engine=EngineResult(origin_level=0.875, ranked=ranked),
    )
    nearest = min(tau, key=lambda c: (tau[c], route[c], c))
    decision.choices = {"engine": ranked[0].zone_id, "nearest": nearest, "stay": None,
                        "climatology_choice": nearest, "current_band_greedy": nearest,
                        "engine_gated": ranked[0].zone_id, **(choices or {})}
    return decision


def _scored(decision: Decision, b_origin: dict, b_alt: dict) -> Scored:
    gains = {c: b_origin[c] - b_alt[c] for c in decision.alternatives}
    return Scored(decision, b_origin, b_alt, gains, [], [])


# ── 손으로 맞춘 장면 ────────────────────────────────────────────────────────────


def test_hand_checked_scenario_origin_busy_far_alternative_relaxed():
    # 출발 홍대(붐빔) · 합정역(21분, 도착 때 여유) · 연남동(19분, 가장 가까움, 도착 때 붐빔). 엔진은 합정역.
    d = _decision([_cand(HAP), _cand(YEON)])
    sc = _scored(d, {HAP: 3, YEON: 3}, {HAP: 0, YEON: 3})
    assert d.nearest == YEON
    assert replay._oracle(sc) == HAP
    engine = policy_outcome(sc, "engine")
    nearest = policy_outcome(sc, "nearest")
    rnd = policy_outcome(sc, "random")
    stay = policy_outcome(sc, "stay")
    oracle = policy_outcome(sc, "oracle")
    assert (engine["hit"], engine["harm"], engine["gap"], engine["loss"], engine["extra_travel"]) == (1, 0, 3, 0, 2)
    assert (nearest["hit"], nearest["harm"], nearest["gap"], nearest["loss"], nearest["extra_travel"]) == (0, 0, 0, 3, 0)
    assert (rnd["hit"], rnd["gap"], rnd["loss"], rnd["extra_travel"]) == (0.5, 1.5, 1.5, 1.0)
    assert (stay["hit"], stay["loss"], stay["extra_travel"]) == (0, 3, None)
    assert oracle["hit"] == 1 and oracle["loss"] == 0
    assert engine["gain_3"] == 1 and nearest["gain_0"] == 1 and rnd["gain_3"] == 0.5 and rnd["gain_0"] == 0.5
    assert engine["hit_vs_now"] == 1 and stay["hit_vs_now"] == 0
    hour = (d.t + timedelta(minutes=21)).astimezone(KST).hour
    expected_wait = crowd_wait_minutes(grade_level(3), hour) - crowd_wait_minutes(grade_level(0), hour)
    assert engine["avoided_wait"] == pytest.approx(expected_wait)
    assert engine["net_model"] == pytest.approx(expected_wait - 2)

    days = [d.day]
    pops = build_populations([sc], {d.day: 0}, len(days))
    crowded = pops["crowded"].series
    assert crowded["engine.hit"].value() == 1.0 and crowded["nearest.hit"].value() == 0.0
    assert crowded["engine_minus_nearest.hit"].value() == 1.0
    assert crowded["opportunity_any"].value() == 1.0


def test_engine_gated_stays_without_relief():
    d = _decision([_cand(HAP, relief=0.0), _cand(YEON)], choices={"engine_gated": None})
    sc = _scored(d, {HAP: 3, YEON: 3}, {HAP: 0, YEON: 3})
    assert policy_outcome(sc, "engine_gated")["hit"] == 0  # 머문다


# ── 불일치 원인 ────────────────────────────────────────────────────────────────


def test_disagreement_causes_and_measured_only_subset():
    availability = _decision([_cand(HAP, tier=0), _cand(YEON, mode="degraded_rules", tier=2, basis=None)])
    cutoff = _decision([_cand(HAP, tier=0), _cand(YEON, tier=2)])
    same = _decision([_cand(HAP, tier=0, score=0.6), _cand(YEON, tier=0, score=0.5)])
    assert disagreement_cause(availability) == "tier_availability"
    assert disagreement_cause(cutoff) == "tier_crowded_cutoff"
    assert disagreement_cause(same) == "score_same_tier"
    scored = [_scored(d, {HAP: 3, YEON: 3}, {HAP: 0, YEON: 3}) for d in (availability, cutoff, same)]
    pops = build_populations(scored, {scored[0].decision.day: 0}, 1)
    assert pops["crowded"].n == 3
    assert pops["measured_only"].n == 2
    assert availability not in [s.decision for s in pops["measured_only"].members]


# ── V3 판정 ───────────────────────────────────────────────────────────────────

_OK = dict(n=100, days=10, episodes=20, n_disagree=30, disagree_days=5, headroom=0.3,
           forecasts_enabled=True, empty_share=0.0, blocks=25, ci_low_t=0.9)  # t 하한이 넉넉하면 부트스트랩 하한이 판정한다


def test_v3_passes_on_the_boundary_and_fails_at_zero_ci_low():
    assert v3_verdict(diff=0.10, ci_low=0.001, ci_high=0.2, **_OK)["status"] == "pass"
    assert v3_verdict(diff=0.10, ci_low=0.0, ci_high=0.2, **_OK)["status"] == "fail"
    assert v3_verdict(diff=0.0999, ci_low=0.01, ci_high=0.2, **_OK)["status"] == "fail"
    assert v3_verdict(diff=0.2, ci_low=0.05, ci_high=0.3, **_OK)["ci_label"] == replay.CI_LABEL_OK


@pytest.mark.parametrize("field,value,token", [
    ("n", 99, "n_distinct<100"), ("days", 9, "crowded_days"), ("episodes", 19, "episodes"),
    ("n_disagree", 29, "n_disagree_distinct<30"), ("disagree_days", 4, "disagree_days"),
    ("forecasts_enabled", False, "forecasts_disabled"), ("empty_share", 0.02, "empty_replicates"),
])
def test_v3_insufficient_for_each_minimum(field, value, token):
    verdict = v3_verdict(diff=0.5, ci_low=0.3, ci_high=0.6, **{**_OK, field: value})
    assert verdict["status"] == "insufficient" and token in verdict["reason"]


def test_v3_headroom_below_ten_points_is_unattainable_and_small_blocks_are_approximate():
    verdict = v3_verdict(diff=0.05, ci_low=0.01, ci_high=0.08,
                         **{**_OK, "headroom": 0.08, "blocks": 12, "ci_low_t": 0.005})
    assert verdict["status"] == "fail"
    assert verdict["criterion_attainable"] is False
    assert verdict["reason"] == "diff<0.10; unattainable_by_construction"
    assert verdict["ci_label"] == replay.CI_LABEL_APPROX


def test_v3_fail_always_names_the_blocking_condition():
    """부트스트랩 하한 > 0 · 차 ≥ 0.10 인데 날짜 군집 t 하한이 막으면 — 사유가 그것을 말한다(S4 검토 2차).

    전에는 reason=None 이라 화면이 '미달 · 95% CI [+2.0, +30.0]' 만 보여 주어 기준과 모순으로 읽혔다.
    """
    t_blocked = v3_verdict(diff=0.15, ci_low=0.02, ci_high=0.30, **{**_OK, "blocks": 15, "days": 15, "ci_low_t": -0.01})
    assert t_blocked["status"] == "fail"
    assert t_blocked["reason"] == "gate_low<=0(day_cluster_t)" and t_blocked["gate_low"] == -0.01
    boot_blocked = v3_verdict(diff=0.15, ci_low=-0.02, ci_high=0.30, **{**_OK, "ci_low_t": 0.01})
    assert boot_blocked["reason"] == "gate_low<=0(bootstrap)"
    both = v3_verdict(diff=0.05, ci_low=-0.02, ci_high=0.30, **{**_OK, "ci_low_t": -0.03})
    assert both["reason"] == "diff<0.10; gate_low<=0(day_cluster_t)"
    for verdict in (t_blocked, boot_blocked, both):
        assert "," not in verdict["reason"], "화면은 쉼표·세미콜론으로 토큰을 자른다"
    assert v3_verdict(diff=0.2, ci_low=0.05, ci_high=0.3, **_OK)["reason"] is None


def test_v3_gate_uses_the_smaller_of_bootstrap_and_day_cluster_t_lows():
    """백분위 부트스트랩 하한만으로 통과하지 않는다(S4 검토 — 블록이 적으면 하한이 과하게 좁다)."""
    small = {**_OK, "blocks": 14, "days": 14}
    assert v3_verdict(diff=0.2, ci_low=0.05, ci_high=0.3, **{**small, "ci_low_t": -0.01})["status"] == "fail"
    passed = v3_verdict(diff=0.2, ci_low=0.05, ci_high=0.3, **{**small, "ci_low_t": 0.02})
    assert passed["status"] == "pass" and passed["gate_low"] == 0.02 and passed["ci_low_t"] == 0.02
    missing = v3_verdict(diff=0.2, ci_low=0.05, ci_high=0.3, **{**small, "ci_low_t": None})
    assert missing["status"] == "insufficient" and "no_day_cluster_interval" in missing["reason"]
    big = v3_verdict(diff=0.2, ci_low=0.05, ci_high=0.3, **{**_OK, "ci_low_t": -0.01})
    assert big["status"] == "fail", "블록이 많아도 같은 규칙이다"


def test_day_cluster_t_interval_is_the_linearized_ratio_interval():
    series = _series([(3.0, 10.0), (1.0, 10.0), (2.0, 10.0)])  # 비율 0.2, 날짜별 잔차 1, -1, 0
    out = replay.day_cluster_t_interval(series, 0.95)
    se = math.sqrt(3 / 2 * 2.0) / 30.0
    assert out["df"] == 2 and out["se"] == pytest.approx(se)
    assert out["lo"] == pytest.approx(0.2 - 4.3027 * se) and out["hi"] == pytest.approx(0.2 + 4.3027 * se)
    assert replay.day_cluster_t_interval(_series([(1.0, 2.0), (0.0, 0.0)]), 0.95)["lo"] is None
    with pytest.raises(ValueError):
        replay.day_cluster_t_interval(series, 0.9)


# ── V4 판정 ───────────────────────────────────────────────────────────────────


def test_v4_verdict_rules():
    base = dict(n_paired=200, days=12, forecasts_enabled=True, diff_ci_low_t=0.04)
    good = v4_verdict(mae_provider=0.3, mae_persistence=0.5, diff_ci_low=0.05, exact_provider=0.7,
                      exact_persistence=0.6, **base)
    assert (good["status"], good["recommendation"]) == ("pass", "provider_forecast")
    assert good["gate_low"] == 0.04, "날짜 12개 < 20 — 부트스트랩·t 하한 중 작은 쪽"
    guarded = v4_verdict(mae_provider=0.3, mae_persistence=0.5, diff_ci_low=0.05, exact_provider=0.7,
                         exact_persistence=0.6, **{**base, "diff_ci_low_t": -0.01})
    assert (guarded["status"], guarded["recommendation"]) == ("fail", "persistence")
    assert guarded["reason"] == "gate_low<=0(day_cluster_t)"
    assert good["reason"] is None
    worse_exact = v4_verdict(mae_provider=0.3, mae_persistence=0.5, diff_ci_low=0.05, exact_provider=0.5,
                             exact_persistence=0.6, **base)
    assert (worse_exact["status"], worse_exact["recommendation"]) == ("fail", "persistence")
    assert worse_exact["reason"] == "exact_provider<exact_persistence"
    worse_mae = v4_verdict(mae_provider=0.6, mae_persistence=0.5, diff_ci_low=-0.05, exact_provider=0.7,
                           exact_persistence=0.6, **{**base, "diff_ci_low_t": -0.06})
    assert worse_mae["reason"] == "mae_provider>=mae_persistence; gate_low<=0(day_cluster_t)"
    none = v4_verdict(n_paired=0, days=0, mae_provider=None, mae_persistence=None, diff_ci_low=None,
                      exact_provider=None, exact_persistence=None, forecasts_enabled=True)
    assert (none["status"], none["recommendation"]) == ("not_evaluable", "undetermined")
    thin = v4_verdict(mae_provider=0.3, mae_persistence=0.5, diff_ci_low=0.05, exact_provider=0.7,
                      exact_persistence=0.6, n_paired=99, days=12, forecasts_enabled=True)
    assert thin["status"] == "insufficient"
    off = v4_verdict(n_paired=500, days=20, mae_provider=None, mae_persistence=None, diff_ci_low=None,
                     exact_provider=None, exact_persistence=None, forecasts_enabled=False)
    assert off["reason"] == "forecasts_disabled"


# ── 부트스트랩 ────────────────────────────────────────────────────────────────


def _series(values):
    series = DaySeries(len(values))
    for i, (num, den) in enumerate(values):
        series.add(i, num, den)
    return series


def test_bootstrap_common_random_numbers_and_dummy_metric_invariance():
    a = Bootstrap(12, replicates=300, seed=20261101, ci=0.95)
    b = Bootstrap(12, replicates=300, seed=20261101, ci=0.95)
    assert a.samples == b.samples
    s1 = _series([(i % 3, 2) for i in range(12)])
    first = a.interval(s1)
    a.interval(_series([(1, 1)] * 12))  # 지표를 하나 더 계산해도
    assert a.interval(s1) == first == b.interval(s1)  # 기존 구간은 그대로


def test_bootstrap_empty_replicates_are_counted():
    boot = Bootstrap(20, replicates=500, seed=1, ci=0.95)
    sparse = _series([(1, 1)] + [(0, 0)] * 19)  # 하루에만 표본
    result = boot.interval(sparse)
    assert result["empty_share"] > 0.01


def test_service_day_boundary_is_05_kst():
    before = datetime(2026, 9, 21, 4, 59, tzinfo=KST)
    after = datetime(2026, 9, 21, 5, 0, tzinfo=KST)
    assert service_day(before) == date(2026, 9, 20) and service_day(after) == date(2026, 9, 21)


# ── 결정 · 정보 집합 ────────────────────────────────────────────────────────────


class Recorder:
    """가짜 엔진 — 받은 관측을 기록하고, 등급이 낮은 대안(없으면 맨 뒤) → 가까운 곳 순으로 고른다."""

    def __init__(self):
        self.calls = []

    async def __call__(self, origin, alternatives, *, origin_reading, alt_readings, t, travel, block=None):
        index = len(self.calls)
        self.calls.append({"t": t, "origin": origin.zone_id, "readings": dict(alt_readings), "travel": dict(travel)})

        def key(zone):
            reading = alt_readings.get(zone.zone_id)
            band = replay.band_index(reading.level_band) if reading is not None else 9
            return (band, travel[zone.zone_id][0], zone.zone_id)

        ordered = sorted(alternatives, key=key)
        ranked = tuple(
            _cand(z.zone_id, mode="measured_rules" if alt_readings.get(z.zone_id) else "degraded_rules",
                  tier=0 if alt_readings.get(z.zone_id) else 2, travel=travel[z.zone_id][0])
            for z in ordered
        )
        return EngineResult(origin_level=float(index), ranked=ranked)


def _run(data, engine, *, ablations=False, detour=1.18, engine_travel=None):
    """``detour`` 는 채점 이동(정답 도착 시각)만 바꾼다. 대안 자격·엔진 입력은 라우터 이동(``engine_travel``, 기본은
    ``router_travel_matrix`` — 홍대 관광특구 → 연남동 15.2분 · 합정역 17.4분)이다. 상한 규칙은 `test_walk_cap_*` 가 본다."""
    clim = replay.climatology(
        [r for r in data.records() if r.replaced is not True], value=lambda r: r.band, time=lambda r: r.observed_at,
        mode="trailing", min_samples=4, group=lambda r: r.zone_id,
    )
    travel = replay.check_travel_config(data.zones, detour)
    return asyncio.run(replay._run_decisions(
        data, travel, engine, clim=clim, seed=1, with_ablations=ablations, engine_travel=engine_travel,
    ))


def test_walk_cap_uses_the_routers_travel_not_the_conservative_truth_travel():
    """기본 우회 1.4(채점): 홍대↔연남 19분 · 홍대↔합정 21분. 라우터(1.18, 0.1분): 15.2 · 17.4분 — 상한 20분 안.

    운영 라우터는 홍대 관광특구에서 합정역을 내고 합정역에서 홍대 관광특구를 낸다 — 재생도 같은 대안 집합으로 결정한다
    (S4 검토 2차: 1.4 로 상한을 걸어 합정역 출발 결정을 전부 '상한 안 대안 없음' 으로 빼던 결함). 엔진에는 라우터 분을,
    정답에는 보수적 τ 를 준다.
    """
    rows = steady_rows("hongdae", B0, 6, {"홍대 관광특구": 3, "연남동": 3, "합정역": 3})
    rec = Recorder()
    run = _run(_data(rows), rec, detour=1.4)
    by_origin = {}
    for d in run.decisions:
        by_origin.setdefault(d.origin, set()).add(d.alternatives)
    assert by_origin[HONG] == {(HAP, YEON)} and by_origin[YEON] == {(HONG,)} and by_origin[HAP] == {(HONG,)}
    assert run.skipped.get(replay.SKIP_NO_ELIGIBLE, 0) == 0
    hong_calls = [call for call in rec.calls if call["origin"] == HONG]
    assert hong_calls and all(call["travel"] == {HAP: (17.4, 1157.9), YEON: (15.2, 1016.1)} for call in hong_calls)
    for d in run.decisions:
        assert set(d.choices.values()) - {None} <= set(d.alternatives)
        assert d.random_draw in d.alternatives
        if d.origin == HONG:
            assert d.tau == {HAP: 21, YEON: 19}, "정답 도착 시각은 보수적 이동(1.4 · 올림)"


def test_walk_cap_skips_an_origin_whose_router_travel_exceeds_the_cap():
    """라우터 이동이 상한을 넘으면(같으면 남는다) 어느 정책도 그 대안을 고르지 않고, 대안이 없는 출발지는 결정이 없다."""
    rows = steady_rows("hongdae", B0, 6, {"홍대 관광특구": 3, "연남동": 3, "합정역": 3})
    base = replay.engine_mod.router_travel_matrix(cluster_zones("hongdae"))
    legs = dict(base)
    for pair in ((HONG, HAP), (HAP, HONG)):
        legs[pair] = replace(base[pair], minutes=20.1)
    legs[(HONG, YEON)] = replace(base[(HONG, YEON)], minutes=20.0)  # 상한과 같으면 라우터도 남긴다
    rec = Recorder()
    run = _run(_data(rows), rec, detour=1.4, engine_travel=legs)
    by_origin = {}
    for d in run.decisions:
        by_origin.setdefault(d.origin, set()).add(d.alternatives)
    assert by_origin[HONG] == {(YEON,)} and by_origin[YEON] == {(HONG,)}
    assert HAP not in by_origin, "합정역에서 상한 안 대안이 없다 — 결정하지 않는다"
    assert run.skipped[replay.SKIP_NO_ELIGIBLE] > 0
    assert all(call["origin"] != HAP for call in rec.calls)


def _data(rows, fc=()):
    return load_replay_inputs("hongdae", **memory_inputs(rows, fc))


def test_alternative_row_fetched_after_t_is_never_seen_and_does_not_change_the_choice():
    base = steady_rows("hongdae", B0, 9, {"홍대 관광특구": 3, "연남동": 0, "합정역": 0})
    future = obs_row("연남동", B0 + timedelta(minutes=30), 3, fetched_offset_s=0)  # 아래에서 받은 시각을 바꾼다
    t = (B0 + timedelta(minutes=30)).astimezone(timezone.utc)  # 홍대 버킷 B0+20 의 결정 시각
    late = {**future, "fetched_at": (t + timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "observed_at": (t - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "bucket_at": (t - timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ")}
    base_wo = [r for r in base if not (r["area_nm"] == "연남동" and r["bucket_at"] == late["bucket_at"])]
    early = {**late, "fetched_at": (t - timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")}

    def decision_at(rows):
        rec = Recorder()
        run = _run(_data(rows), rec)
        match = [d for d in run.decisions if d.origin == HONG and d.t == t]
        call = next(c for c in rec.calls if c["origin"] == HONG and c["t"] == t)
        return match, call

    without, call_without = decision_at(base_wo)
    with_late, call_late = decision_at(base_wo + [late])
    with_early, call_early = decision_at(base_wo + [early])
    assert call_late["readings"][YEON] == call_without["readings"][YEON]
    assert call_late["readings"][YEON].level_band == "relaxed"
    assert [d.choices["engine"] for d in with_late] == [d.choices["engine"] for d in without]
    assert call_early["readings"][YEON].level_band == "busy"  # t − 1초에 받은 행은 보인다
    assert with_early[0].choices["engine"] == HAP  # 그리고 선택을 바꿀 수 있다
    assert without[0].choices["engine"] == YEON


def test_origin_row_late_delays_the_decision_and_late_alternative_rows_are_counted():
    rows = steady_rows("hongdae", B0, 8, {"연남동": 0, "합정역": 0, "홍대 관광특구": 3})
    late_hong = (B0 + timedelta(minutes=10)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = [r for r in rows if not (r["area_nm"] == "홍대 관광특구" and r["bucket_at"] == late_hong)]
    rows.append(obs_row("홍대 관광특구", B0 + timedelta(minutes=10), 3, fetched_offset_s=630))
    rec = Recorder()
    run = _run(_data(rows), rec)
    times = sorted(d.t for d in run.decisions if d.origin == HONG)
    late_bucket = (B0 + timedelta(minutes=10)).astimezone(timezone.utc)
    assert late_bucket + timedelta(minutes=11) in times  # b + 10분 30초 → b + 11분
    assert 1.0 in run.delayed

    rows = steady_rows("hongdae", B0, 8, {"홍대 관광특구": 3, "합정역": 0, "연남동": 0})
    rows = [r for r in rows if not (r["area_nm"] == "연남동" and r["bucket_at"] == late_hong)]
    rows.append(obs_row("연남동", B0 + timedelta(minutes=10), 3, fetched_offset_s=620))
    rec = Recorder()
    run = _run(_data(rows), rec)
    t = (B0 + timedelta(minutes=20)).astimezone(timezone.utc)
    call = next(c for c in rec.calls if c["origin"] == HONG and c["t"] == t)
    assert call["readings"][YEON].level_band == "relaxed"  # b+10분 20초에 온 연남동 행은 t=b+10분에 없다
    assert run.alt_not_yet >= 1


def test_greedy_uses_only_the_information_set_and_climatology_falls_back_without_history():
    rows = steady_rows("hongdae", B0, 4, {"홍대 관광특구": 3, "연남동": 2, "합정역": 0})
    run = _run(_data(rows), Recorder())
    d = next(d for d in run.decisions if d.origin == HONG)
    assert d.choices["current_band_greedy"] == HAP
    assert d.clim_fallback is True and d.choices["climatology_choice"] == d.nearest


def test_climatology_choice_uses_only_earlier_service_days():
    days = []
    for offset in range(3):
        day = B0 + timedelta(days=offset)
        days += steady_rows("hongdae", day, 6, {"홍대 관광특구": 3, "연남동": 3 if offset < 2 else 0, "합정역": 1})
    data = _data(days)
    run = _run(data, Recorder())
    third = [d for d in run.decisions if d.origin == HONG and d.day == service_day(B0 + timedelta(days=2))]
    assert third and all(d.choices["climatology_choice"] == HAP for d in third)  # 앞선 이틀엔 연남동이 붐볐다
    # 셋째 날 연남동 정답을 바꿔도(미래) 선택은 그대로다
    altered = [dict(r) for r in days]
    for r in altered:
        if r["area_nm"] == "연남동" and r["bucket_at"] >= (B0 + timedelta(days=2)).astimezone(timezone.utc).strftime("%Y-%m-%dT"):
            r["congest_lvl"] = "붐빔"
    run2 = _run(_data(altered), Recorder())
    third2 = [d for d in run2.decisions if d.origin == HONG and d.day == service_day(B0 + timedelta(days=2))]
    assert [d.choices["climatology_choice"] for d in third2] == [d.choices["climatology_choice"] for d in third]


# ── V2 ────────────────────────────────────────────────────────────────────────


def test_lagged_ablation_uses_rows_fetched_seven_days_earlier_and_excludes_the_first_week():
    rows = steady_rows("hongdae", B0, 4, {"홍대 관광특구": 3, "연남동": 1, "합정역": 0})
    rows += steady_rows("hongdae", B0 + timedelta(days=7), 4, {"홍대 관광특구": 3, "연남동": 2, "합정역": 2})
    rec = Recorder()
    run = _run(_data(rows), rec, ablations=True)
    first_week = [d for d in run.decisions if d.origin == HONG and d.t < (B0 + timedelta(days=7)).astimezone(timezone.utc)]
    later = [d for d in run.decisions if d.origin == HONG and d.t > (B0 + timedelta(days=7)).astimezone(timezone.utc)]
    assert first_week and all(d.ablations["lagged_7d"] is None for d in first_week)
    assert later
    for d in later:
        lagged_call = rec.calls[int(d.ablations["lagged_7d"].origin_level)]
        for zone_id, reading in lagged_call["readings"].items():
            assert reading is not None
            original_fetch = reading.fetched_at - timedelta(days=7)
            assert original_fetch <= d.t - timedelta(days=7)
            assert reading.level_band == {"seoul:POI073": "normal", "seoul:POI053": "relaxed"}[zone_id]
        persistence_call = rec.calls[int(d.ablations["persistence_only"].origin_level)]
        assert all(r.forecast == () for r in persistence_call["readings"].values() if r is not None)
        assert rec.calls[int(d.ablations["none"].origin_level)]["readings"] == {}


# ── 실제 엔진 끝까지 ────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def real_report(tmp_path_factory):
    from scripts.crowd_dispersion_replay import discover, read_csv

    folder = tmp_path_factory.mktemp("hongdae")
    write_export(folder, "hongdae", days=2)
    found = discover(folder)
    data = load_replay_inputs(
        "hongdae", observations=[read_csv(p) for p in found["obs"]], forecasts=[read_csv(p) for p in found["fcst"]],
        counts=read_csv(found["counts"]),
    )
    report, trace = replay.run_replay(data, ReplayConfig(cluster="hongdae", code_version="test", sensitivity=False))
    return report, trace


def test_none_ablation_is_nearest_on_the_real_path(real_report):
    report, _ = real_report
    none = report["v2"]["ablations"]["none"]
    assert none["n"] > 0
    assert none["top1_changed_rate"] == pytest.approx(1 - report["engine_diagnostics"]["engine_equals_nearest_rate"], abs=1e-4)


def test_real_report_shape_and_text_rules(real_report):
    report, trace = real_report
    assert report["schema_version"] == "crowd_dispersion_replay/2"
    assert report["limits"][0] == replay.NO_USERS_LIMIT
    assert report["thin_cluster"]["flag"] is True
    # 라우터 이동(1.18 · 0.1분) + 도보 상한 20분: 홍대 관광특구는 대안 2곳(연남동 15.2 · 합정역 17.4분), 나머지는
    # 홍대 관광특구 1곳 — 운영 라우터가 내는 집합과 같다(S4 검토 2차). 합정역 출발 결정도 빠지지 않는다.
    assert report["thin_cluster"]["alternatives_per_origin"] == 2
    assert report["thin_cluster"]["note"] == replay.THIN_NOTE
    assert {o["origin"]: o["eligible_alternatives"] for o in report["per_origin"]} == {
        "홍대 관광특구": ["합정역", "연남동"], "합정역": ["홍대 관광특구"], "연남동": ["홍대 관광특구"],
    }
    assert report["decisions"]["skipped"].get(replay.SKIP_NO_ELIGIBLE, 0) == 0
    assert report["verdicts"]["V3"]["n_disagree"] > 0, "홍대 관광특구 출발에서 엔진이 가장 가까운 곳과 갈릴 수 있다"
    legs = {(row["from"], row["to"]): row for row in report["travel_matrix"]}
    assert legs[("홍대 관광특구", "합정역")]["minutes"] == 21 and legs[("홍대 관광특구", "합정역")]["engine_minutes"] == 17.4
    assert legs[("홍대 관광특구", "합정역")]["within_walk_cap"] is True
    assert report["config"]["travel"]["max_walk_minutes"] == 20
    assert report["run"]["criteria_version"] == replay.criteria_version()
    assert report["v4"]["own_model"] == "not_available"
    assert report["verdicts"]["V3"]["status"] in {"pass", "fail", "insufficient"}
    markdown = replay.render_markdown(report)
    assert len(markdown.splitlines()) <= 50
    summary = replay.build_decision_quality_summary(report)
    text = json.dumps(summary, ensure_ascii=False)
    assert len(text.encode("utf-8")) <= 16 * 1024
    for blob in (markdown, text):
        assert not replay.contains_forbidden_text(blob), blob
    assert summary["limits"][0] == replay.NO_USERS_LIMIT
    assert summary["schema_version"] == "decision_quality_summary/3" and summary["cluster"] == "hongdae"
    v3 = report["verdicts"]["V3"]
    assert summary["verdicts"]["V3"]["gate_low"] == v3["gate_low"] and summary["verdicts"]["V3"]["ci_low_t"] == v3["ci_low_t"]
    assert summary["verdicts"]["V4"]["reason"] == report["verdicts"]["V4"]["reason"]

    def _max_list(value):
        if isinstance(value, dict):
            return max((_max_list(v) for v in value.values()), default=0)
        if isinstance(value, list):
            return max([len(value)] + [_max_list(v) for v in value])
        return 0

    assert _max_list(summary) <= 16
    assert trace and set(trace[0]) == set(replay.TRACE_COLUMNS)


def test_forbidden_words_regex():
    for word in ("분산 효과", "혼잡 감소", "솔직", "투명", "확실", "믿을 수 있"):
        assert replay.contains_forbidden_text(f"앞 {word} 뒤")
    assert not replay.contains_forbidden_text(replay.NO_USERS_LIMIT)


# ── V4 ────────────────────────────────────────────────────────────────────────


def test_v4_native_alignment_drops_targets_before_observation_and_scores_persistence_at_the_same_target():
    rows, fc = [], []
    for name, band in (("홍대 관광특구", 1), ("연남동", 1), ("합정역", 1)):
        for i in range(12):
            row = obs_row(name, B0 + timedelta(minutes=30 * i), band)  # 30분 주기, 관측 :01 · :31
            rows.append(row)
            observed = B0 + timedelta(minutes=30 * i + 1)
            fc.append(fcst_row(row, observed.replace(minute=0) , 3))  # 관측보다 앞선 대상(버려야 한다)
            hour = observed.replace(minute=0) + timedelta(hours=1)
            while hour <= observed + timedelta(hours=3):
                fc.append(fcst_row(row, hour, 2))  # 공급원은 '약간 붐빔', 실제는 늘 '보통'
                hour += timedelta(hours=1)
    data = _data(rows, fc)
    report, _ = replay.run_replay(data, ReplayConfig(cluster="hongdae", sensitivity=False, ablations=False),
                                  engine=Recorder())
    bins = {b["lead_bin"]: b for b in report["v4"]["native"]["bins"]}
    assert 0 not in bins  # 음의 리드(대상 < 관측)는 하나도 들어가지 않았다
    assert {30, 60} <= set(bins)
    b30 = bins[30]
    assert b30["mae"]["persistence"] == 0.0 and b30["mae"]["provider_forecast"] == 1.0
    assert b30["exact"]["persistence"] == 1.0 and b30["exact"]["provider_forecast"] == 0.0
    assert b30["confusion"]["provider_forecast"][1][2] == b30["n_paired"]
    assert report["verdicts"]["V4"]["recommendation"] in {"persistence", "undetermined"}


def test_v4_not_evaluable_without_pairs_and_insufficient_when_forecasts_disabled():
    rows = steady_rows("hongdae", B0, 3, {"홍대 관광특구": 3, "연남동": 0, "합정역": 1})
    report, _ = replay.run_replay(_data(rows), ReplayConfig(cluster="hongdae", sensitivity=False, ablations=False),
                                  engine=Recorder())
    v4 = report["verdicts"]["V4"]
    assert v4["status"] == "insufficient" and v4["reason"] == "forecasts_disabled"
    assert report["verdicts"]["V3"]["status"] == "insufficient"
    assert "forecasts_disabled" in report["verdicts"]["V3"]["reason"]


def test_lead_bins():
    assert [replay._lead_bin(x) for x in (0, 14.9, 15, 44.9, 45, 74.9, 75)] == [0, 0, 30, 30, 60, 60, 90]


def test_travel_config_beyond_sixty_minutes_is_refused():
    with pytest.raises(ReplayInputError) as info:
        replay.check_travel_config(cluster_zones("hongdae"), 3.0)
    assert info.value.problems[0].code == "config_outside_export_horizon"


def test_criteria_version_is_stable_and_sensitive():
    assert replay.criteria_version() == replay.criteria_version()
    assert len(replay.criteria_version()) == 12
    changed = json.loads(json.dumps(replay.CRITERIA))
    changed["v3"]["min_diff"] = 0.11
    assert replay.criteria_version(changed) != replay.criteria_version()
    assert math.isclose(replay.CRITERIA["travel"]["detour"], 1.4)


# ── S4 검토 3차: V3 모집단 · 결정 시각 · 표본 단위 · 보조 대비 · 글 ─────────────────────


def _single_alt_decision(*, b_now=3) -> Decision:
    """대안 1곳(연남동 출발 → 홍대 관광특구) — 엔진 = 가장 가까운 곳 = 오라클이 구성상 같다."""
    t = B0.astimezone(timezone.utc)
    decision = Decision(
        origin=YEON, bucket_at=t, phase=10, t=t, t_nominal=t, day=service_day(t), delay_minutes=0.0, b_now=b_now,
        alternatives=(HONG,), tau={HONG: 19}, route={HONG: 19 * 66.67}, origin_reading=None, readings={},
        block=None, engine=EngineResult(origin_level=0.875, ranked=(_cand(HONG),)),
    )
    decision.choices = {"engine": HONG, "nearest": HONG, "stay": None, "climatology_choice": HONG,
                        "current_band_greedy": HONG, "engine_gated": HONG}
    return decision


def test_v3_population_excludes_single_alternative_decisions_that_agree_by_construction():
    """홍대(도보 상한): 합정역·연남동 출발은 대안 1곳이라 차가 언제나 0 — 섞으면 V3 차가 그 비율만큼 묽어진다."""
    choice = _scored(_decision([_cand(HAP), _cand(YEON)]), {HAP: 3, YEON: 3}, {HAP: 0, YEON: 3})
    forced = [_scored(_single_alt_decision(), {HONG: 3}, {HONG: 1}) for _ in range(2)]
    assert choice.decision.choice_feasible and not forced[0].decision.choice_feasible
    pops = build_populations([choice, *forced], {choice.decision.day: 0}, 1)
    assert pops["crowded"].n == 3 and pops["crowded_choice"].n == 1
    assert pops["crowded"].series["engine_minus_nearest.hit"].value() == pytest.approx(1 / 3)
    assert pops["crowded_choice"].series["engine_minus_nearest.hit"].value() == 1.0
    assert pops["measured_only"].n == 1, "실측 부분집합도 V3 모집단 안에서"


def test_decision_moments_spread_over_the_cycle_without_look_ahead():
    from types import SimpleNamespace

    b = B0.astimezone(timezone.utc)

    def moments(fetched_offset_s, cadence):
        record = SimpleNamespace(bucket_at=b, fetched_at=b + timedelta(seconds=fetched_offset_s))
        return [(phase, t - b) for phase, _nominal, t in replay.decision_moments(record, cadence)]

    m = timedelta(minutes=1)
    assert moments(60, 10.0) == [(0, 1 * m), (5, 5 * m), (10, 10 * m)]
    assert moments(90, 10.0) == [(0, 2 * m), (5, 5 * m), (10, 10 * m)], "받은 시각은 분 올림"
    assert moments(270, 10.0) == [(0, 5 * m), (10, 10 * m)], "받은 시각 = b+5 면 한 번만(앞 phase)"
    assert moments(450, 10.0) == [(0, 8 * m), (10, 10 * m)], "b+5 에 행이 없으면 받은 시각까지 기다린다"
    assert moments(630, 10.0) == [(0, 11 * m)]
    assert moments(90, 30.0) == [(0, 2 * m), (10, 10 * m), (20, 20 * m)], "30분 주기의 +30 은 언제나 낡아 없다"
    assert moments(90, 20.0) == [(0, 2 * m), (10, 10 * m)]
    for offset in (60, 90, 270, 450, 630):
        for _phase, t in moments(offset, 10.0):
            assert b + t >= b + timedelta(seconds=offset), "출발지 자기 행을 받기 전에는 결정하지 않는다"
    assert "phase 0" in replay.CRITERIA["decision_phases"]["rule"]


def test_decisions_at_fetch_see_fresher_origin_rows_and_dedupe_per_t():
    rows = steady_rows("hongdae", B0, 6, {"홍대 관광특구": 3, "연남동": 1, "합정역": 0})
    rec = Recorder()
    run = _run(_data(rows), rec)
    hong = [d for d in run.decisions if d.origin == HONG]
    assert {d.phase for d in hong} == {0, 5, 10}
    assert len({d.t for d in hong}) == len(hong)
    by_bucket = {}
    for d in hong:
        by_bucket.setdefault(d.bucket_at, []).append(d)
    assert any(len(v) == 3 for v in by_bucket.values()), "한 버킷에 세 결정 시각"
    for d in hong:
        assert d.origin_reading.fetched_at <= d.t
        assert d.situation == (HONG, d.bucket_at)


def test_v3_minimums_count_distinct_situations_not_decision_moments():
    inflated = v3_verdict(diff=0.5, ci_low=0.3, ci_high=0.6, **{**_OK, "n": 300, "n_distinct": 99})
    assert inflated["status"] == "insufficient" and "n_distinct<100" in inflated["reason"]
    assert inflated["n"] == 300 and inflated["n_distinct"] == 99
    few = v3_verdict(diff=0.5, ci_low=0.3, ci_high=0.6, **{**_OK, "n_disagree": 90, "n_disagree_distinct": 29})
    assert few["status"] == "insufficient" and "n_disagree_distinct<30" in few["reason"]
    assert v3_verdict(diff=0.5, ci_low=0.3, ci_high=0.6, **{**_OK, "n_distinct": 100,
                                                             "n_disagree_distinct": 30})["status"] == "pass"


def test_stay_loss_is_never_negative_because_the_oracle_forces_a_move():
    sc = _scored(_decision([_cand(HAP), _cand(YEON)]), {HAP: 0, YEON: 0}, {HAP: 2, YEON: 1})  # 옮기면 모두 악화
    assert sc.max_gain == -1
    assert policy_outcome(sc, "stay")["loss"] == 0.0
    assert policy_outcome(sc, "oracle")["loss"] == 0.0
    assert "moving forced" in replay.CRITERIA["oracle"]


def test_secondary_contrast_uses_the_same_gate_low_as_v3():
    """부트스트랩 하한 > 0 인데 날짜 군집 t 하한 ≤ 0 — '근거 없음' 글은 판정 하한을 따른다(p_note2 의 12일 예)."""
    values = [-0.016, -0.085, 0.11, 0.371, 0.093, -0.088, 0.079, 0.221, -0.074, 0.146, -0.023, 0.203]
    series = DaySeries(len(values))
    for i, v in enumerate(values):
        series.add(i, v * 20, 20)
    pop = replay.Population("x", [], {f"{name}.hit": series for name in replay.CONTRASTS})
    boot = Bootstrap(len(values), replicates=2000, seed=replay.CRITERIA["bootstrap"]["seed"], ci=0.95)
    block = replay._contrast_block(pop, boot)["engine_minus_climatology"]
    assert block["ci"][0] > 0 and block["ci_low_t"] <= 0
    assert block["gate_low"] == block["ci_low_t"]
    assert replay.no_evidence_over(block) is True
    assert replay.no_evidence_over({"gate_low": 0.01}) is False and replay.no_evidence_over({"gate_low": None})


def test_persistence_only_identical_to_none_is_marked_structurally_indistinguishable():
    def with_ablations(persistence_choice):
        d = _decision([_cand(HAP), _cand(YEON)])
        d.ablations = {
            "persistence_only": EngineResult(origin_level=0.0, ranked=(_cand(persistence_choice), )),
            "none": EngineResult(origin_level=0.0, ranked=(_cand(YEON),)),
            "lagged_7d": None,
        }
        return _scored(d, {HAP: 3, YEON: 3}, {HAP: 0, YEON: 3})

    boot = Bootstrap(1, replicates=50, seed=1, ci=0.95)
    from collections import Counter

    same = [with_ablations(YEON), with_ablations(YEON)]
    out = replay._compute_v2(same, boot, {same[0].decision.day: 0}, 1, Counter(), True)
    assert out["ablations"]["persistence_only"]["status"] == "structurally_indistinguishable"
    assert out["ablations"]["persistence_only"]["note"] == replay.V2_PERSISTENCE_INDISTINGUISHABLE
    differs = [with_ablations(YEON), with_ablations(HAP)]
    out = replay._compute_v2(differs, boot, {differs[0].decision.day: 0}, 1, Counter(), True)
    assert out["ablations"]["persistence_only"]["status"] == "measured"
    assert out["ablations"]["lagged_7d"]["status"] == "not_run"


def test_persistence_eligible_window():
    t = B0.astimezone(timezone.utc)
    reading = type("R", (), {"level_band": "busy", "observed_at": t - timedelta(minutes=6)})()
    assert replay.persistence_eligible(reading, t, 15.2) is True  # 6 + 15.2 ≤ 30
    assert replay.persistence_eligible(reading, t, 24.5) is False  # 30.5 > 30
    stale = type("R", (), {"level_band": "busy", "observed_at": t - timedelta(minutes=16)})()
    assert replay.persistence_eligible(stale, t, 15.2) is False
    assert replay.persistence_eligible(None, t, 1.0) is False


def test_real_report_v3_population_forced_agreement_and_phase_basis(real_report):
    report, _ = real_report
    v3 = report["verdicts"]["V3"]
    crowded = report["populations"]["crowded"]
    choice = report["populations"]["crowded_choice"]
    assert v3["population"] == "crowded_choice_feasible" and v3["n"] == choice["n"]
    assert v3["forced_agreement"]["n"] == crowded["n"] - choice["n"] > 0, "홍대: 합정역·연남동 출발"
    assert v3["forced_agreement"]["share"] == pytest.approx((crowded["n"] - choice["n"]) / crowded["n"], abs=1e-4)
    assert v3["pooled_crowded"]["n"] == crowded["n"] and v3["pooled_crowded"]["use"] == "descriptive"
    assert v3["n_distinct"] <= v3["n"] and v3["n_disagree_distinct"] <= v3["n_disagree"]
    assert v3["diff"] == choice["contrasts"]["engine_minus_nearest"]["diff"]
    feasible = {o["origin"]: o["choice_feasible"] for o in report["per_origin"]}
    assert feasible == {"홍대 관광특구": True, "합정역": False, "연남동": False}
    assert "disagreement" in choice and choice["disagreement"]["n"] == v3["n_disagree"]
    dec = report["decisions"]
    assert {"0", "5", "10"} <= set(dec["by_phase"])
    assert dec["distinct_situations"]["crowded_choice"] == v3["n_distinct"]
    diag = report["engine_diagnostics"]
    assert diag["population"] == "crowded_choice"
    assert diag["persistence_eligible_share"] > 0, "받은 시각 결정에서는 관측이 신선해 지속 근거 창에 든다"
    assert diag["arrival_basis_all_candidates"].get("persistence", 0) > 0
    assert report["run"]["source_version"] == replay.source_version()
    markdown = replay.render_markdown(report)
    assert "대안 1곳이라 엔진 = 가장 가까운 곳인 결정" in markdown and "오라클 = 가장 좋은 대안(옮김 강제" in markdown
    summary = replay.build_decision_quality_summary(report)
    assert summary["population"] == replay.SUMMARY_POPULATION
    assert summary["n_decisions"] == v3["n"] and summary["hit_rate"]["engine"] == choice["policies"]["engine"]["hit_rate"]
    assert summary["notes"][0].startswith("V3 모집단 = 붐비는 출발지 중 대안 2곳 이상인 결정")


def test_summary_period_comes_from_untruncated_days_and_missing_numbers_render_as_dash(real_report):
    report, _ = real_report
    report = json.loads(json.dumps(report))
    period = report["decisions"]["scored_period"]
    assert report["decisions"]["per_day_truncated"] is False and period["days"] >= 2
    report["decisions"]["per_day"] = report["decisions"]["per_day"][:1]  # 직렬화에서 잘린 배열
    summary = replay.build_decision_quality_summary(report)
    assert summary["period"] == {"first_decision_at": period["first_day"], "last_decision_at": period["last_day"],
                                 "days": period["days"]}
    con = report["populations"]["crowded_choice"]["contrasts"]
    con["engine_minus_climatology"]["diff"] = None
    report["influence"]["lodo_diff"] = {"min": None, "max": None}
    report["influence"]["special_days_excluded"]["diff"] = None
    markdown = replay.render_markdown(report)
    assert "− 시간대 평균 —%p" in markdown
    assert "하루 빼기 차 범위 [—, —]%p" in markdown and "특별한 날 제외 차 —%p" in markdown


def test_late_origin_row_does_not_claim_a_moment_where_a_newer_row_is_visible():
    """버킷 b+10 행이 b+15 에, b+20 행이 b+22 에 오면 — b+10 의 '받은 시각' 결정(b+15)은 b+10 행으로 하지만, b+20 행이
    이미 보이는 시각은 b+20 버킷의 결정이다(S4 검토 3차 검토: 상황·phase 가 엉뚱하게 붙던 것)."""
    rows = steady_rows("hongdae", B0, 8, {"홍대 관광특구": 3, "연남동": 0, "합정역": 0})
    late = {B0 + timedelta(minutes=10): 900, B0 + timedelta(minutes=20): 120}  # fetched_offset_s
    for bucket, offset in late.items():
        stamp = bucket.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        rows = [r for r in rows if not (r["area_nm"] == "홍대 관광특구" and r["bucket_at"] == stamp)]
        rows.append(obs_row("홍대 관광특구", bucket, 3, fetched_offset_s=offset))
    rec = Recorder()
    run = _run(_data(rows), rec)
    for d in run.decisions:
        if d.origin == HONG:
            assert d.origin_reading.observed_at <= d.t
            own = next(r for r in run_records(rows, d.bucket_at))
            assert d.origin_reading.observed_at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M") == own
    assert run.skipped.get(replay.SKIP_SUPERSEDED, 0) >= 1


def run_records(rows, bucket_at):
    stamp = bucket_at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for r in rows:
        if r["area_nm"] == "홍대 관광특구" and r["bucket_at"] == stamp:
            yield r["observed_at"][:16]


def test_empty_population_leaves_attainability_unknown():
    """모집단이 비면 headroom 이 없다 — '구조상 달성 불가' 로 단정하지 않는다(criterion_attainable=None)."""
    verdict = v3_verdict(diff=None, ci_low=None, ci_high=None,
                         **{**_OK, "n": 0, "days": 0, "episodes": 0, "n_disagree": 0, "disagree_days": 0,
                            "headroom": None, "ci_low_t": None})
    assert verdict["status"] == "insufficient"
    assert verdict["criterion_attainable"] is None
    assert "unattainable_by_construction" not in verdict["reason"]


def test_origin_aged_out_before_the_next_row_is_not_a_candidate():
    """30분 주기 · 관측이 버킷보다 앞섬 — 다음 정규 행이 오기 전에 자기 행이 30분을 넘기면 결정 후보가 아니다.

    빈 구간(다음 행이 없거나 한 주기 넘게 빔)은 그대로 origin_not_current 다.
    """
    from app.services.batch.crowd_replay_data import load_replay_inputs as load
    from tests.fixtures.crowd_replay.synthetic import memory_inputs as mem

    rows = []
    for name, band in (("경복궁", 3), ("북촌한옥마을", 0), ("인사동", 0), ("창덕궁·종묘", 0)):
        for i in range(8):
            if name == "경복궁" and i == 5:
                continue  # 실제 빈 구간 — 버킷 4 다음 행이 한 주기 넘게 없다
            rows.append(obs_row(name, B0 + timedelta(minutes=30 * i), band, observed_offset_min=-12,
                                fetched_offset_s=1500 if (name == "경복궁" and i == 2) else 90))
    data = load("jongno", **mem(rows, ()))
    run = _run_jongno(data)
    assert run.skipped.get(replay.SKIP_AGED_OUT, 0) >= 1, run.skipped
    assert run.skipped.get("origin_not_current", 0) >= 1, "빈 구간은 여전히 origin_not_current"
    assert run.candidates == sum(run.by_phase_candidates.values())


def _run_jongno(data):
    clim = replay.climatology(
        [r for r in data.records() if r.replaced is not True], value=lambda r: r.band, time=lambda r: r.observed_at,
        mode="trailing", min_samples=4, group=lambda r: r.zone_id,
    )
    travel = replay.check_travel_config(data.zones, 1.4)
    return asyncio.run(replay._run_decisions(data, travel, Recorder(), clim=clim, seed=1, with_ablations=False))
