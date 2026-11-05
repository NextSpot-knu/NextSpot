# 서울 실측 → 경주 추정 보정(docs/CONGESTION_ENGINE_PLAN.md §5.3-5·6, D5)의 순수 함수.
#
# 여기서 잠그는 것 — 전부 "잘못 켜지면 사용자에게 거짓말이 되는" 자리다:
#   · 곡선은 **단조 비감소**다. 주차가 더 찼는데 더 한산하다고 말하는 일이 없다.
#   · 관측 범위 **위쪽 바깥은 절대 깎지 않는다**(항등 이상). 높은 주차를 '여유' 로 내리는 사고 방지.
#   · 관문(3일 · 300버킷 · 홀드아웃 MAE 개선)을 하나라도 못 넘으면 applied=False → 추정기는 항등.
#   · 학습·평가는 **KST 날짜**로 가른다(시간 순서 누수 금지 — area_demand_forecast_service 와 같은 규칙).
#   · 어떤 실패도 예외로 새지 않는다(active_calibration 은 항등으로 떨어진다).
#   · 순위 관문(rank_gate)은 **보고 전용**이다 — 적용 경로(assess·_build_state·active_calibration)는 S4 이전
#     사본과 같아야 한다(경주 잠금).

import math
from datetime import datetime, timedelta, timezone

import pytest

from app.services import congestion_calibration_service as cal

_KST = timezone(timedelta(hours=9))
NOW = datetime(2026, 10, 20, 3, 0, tzinfo=timezone.utc)


def _pair(bucket: datetime, x: float, y: float, area: str = "명동 관광특구") -> cal.Pair:
    local = bucket.astimezone(_KST)
    return cal.Pair(
        area_nm=area,
        bucket_at=bucket,
        date_kst=local.date().isoformat(),
        hour_kst=local.hour,
        weekend=local.weekday() >= 5,
        x=x,
        y=y,
    )


def _series(days: int, per_day: int, shape) -> list[cal.Pair]:
    """days 일 × per_day 버킷. ``shape(day_index, x) -> y``."""
    pairs: list[cal.Pair] = []
    start = datetime(2026, 10, 1, 1, 0, tzinfo=timezone.utc)  # KST 10:00
    for day in range(days):
        for step in range(per_day):
            x = 0.1 + 0.8 * step / max(1, per_day - 1)
            # 4분 간격 — 하루치가 KST 같은 날짜 안에 머물러야 날짜 분할 테스트가 의도대로 돈다.
            bucket = start + timedelta(days=day, minutes=4 * step)
            pairs.append(_pair(bucket, round(x, 4), shape(day, x)))
    return pairs


# ── PAVA ─────────────────────────────────────────────────────────────────────


def test_pava_leaves_a_monotone_sequence_alone():
    values = [0.1, 0.2, 0.2, 0.9]
    assert cal.pool_adjacent_violators(values, [1.0] * 4) == pytest.approx(values)


def test_pava_pools_violators_into_a_weighted_mean():
    # 0.9 뒤에 0.1 이 오면 뒤집혀 있다 — 두 블록을 합쳐 가중 평균 0.5 로 누른다.
    assert cal.pool_adjacent_violators([0.9, 0.1], [1.0, 1.0]) == pytest.approx([0.5, 0.5])
    # 가중치가 다르면 표본이 많은 쪽으로 끌린다(3:1 → 0.3).
    assert cal.pool_adjacent_violators([0.9, 0.1], [1.0, 3.0]) == pytest.approx([0.3, 0.3])


def test_pava_handles_ties_and_long_cascades():
    assert cal.pool_adjacent_violators([0.5, 0.5, 0.5], [2.0, 2.0, 2.0]) == pytest.approx([0.5] * 3)
    # 마지막 값 하나가 앞의 셋을 전부 끌어내린다(연쇄 병합).
    out = cal.pool_adjacent_violators([0.8, 0.8, 0.8, 0.0], [1.0] * 4)
    assert out == pytest.approx([0.6] * 4)
    assert out == sorted(out), "출력은 언제나 비감소"


def test_pava_empty_and_zero_weight():
    assert cal.pool_adjacent_violators([], []) == []
    assert cal.pool_adjacent_violators([0.3], [0.0]) == []


# ── 적합 ─────────────────────────────────────────────────────────────────────


def test_fit_recovers_a_known_convex_shape():
    """y = x² 를 넣으면 knot 이 x̄² 근처에 앉는다(적합이 실제로 모양을 배운다)."""
    pairs = _series(3, 120, lambda _day, x: round(x * x, 4))
    curve = cal.fit_curve(pairs, fitted_at=NOW.isoformat())

    assert curve is not None
    assert [knot.x for knot in curve.knots] == sorted(knot.x for knot in curve.knots)
    for knot in curve.knots:
        assert knot.y == pytest.approx(knot.x ** 2, abs=0.02)
    # 곡선을 통과시킨 값이 원값보다 MAE 가 낮아야 한다(볼록한 실제 관계를 따라간다).
    identity = sum(abs(p.x - p.y) for p in pairs) / len(pairs)
    calibrated = sum(abs(cal.apply_curve(curve.knots, p.x) - p.y) for p in pairs) / len(pairs)
    assert calibrated < identity


def test_fit_output_is_monotone_even_for_noisy_input():
    noisy = [0.6, 0.1, 0.9, 0.2, 0.95, 0.3]
    pairs = [
        _pair(NOW + timedelta(minutes=10 * i), 0.05 + 0.15 * i, noisy[i])
        for i in range(len(noisy))
    ]
    curve = cal.fit_curve(pairs, fitted_at=NOW.isoformat())

    assert curve is not None
    ys = [knot.y for knot in curve.knots]
    assert ys == sorted(ys), "PAVA 출력이 뒤집히면 '더 찼는데 더 한산' 이 된다"
    grid = [i / 100 for i in range(101)]
    values = [cal.apply_curve(curve.knots, x) for x in grid]
    assert values == sorted(values), "곡선 전 구간이 단조 비감소여야 한다"
    assert all(0.0 <= value <= 1.0 for value in values)


def test_fit_with_a_single_bin_is_one_knot():
    pairs = [_pair(NOW + timedelta(minutes=10 * i), 0.42, 0.9) for i in range(5)]
    curve = cal.fit_curve(pairs, fitted_at=NOW.isoformat())

    assert curve is not None and len(curve.knots) == 1
    assert curve.knots[0] == cal.Knot(0.42, 0.9)
    assert cal.apply_curve(curve.knots, 0.42) == pytest.approx(0.9)


def test_fit_without_pairs_is_none():
    assert cal.fit_curve([], fitted_at=NOW.isoformat()) is None
    assert cal.bin_pairs([]) == []


def test_bins_are_fixed_width_over_zero_to_one():
    """구간 경계가 관측 범위를 따라 움직이면 새 극단값 하나가 모든 knot 을 흔든다."""
    low = _series(1, 20, lambda _d, x: x)
    binned_low = cal.bin_pairs(low, bins=cal.BIN_COUNT)
    wide = low + [_pair(NOW, 0.999, 1.0)]
    binned_wide = cal.bin_pairs(wide, bins=cal.BIN_COUNT)

    assert [round(x, 3) for x, _, _ in binned_low] == [
        round(x, 3) for x, _, _ in binned_wide[: len(binned_low)]
    ]


# ── 범위 밖(보수적 항등) ─────────────────────────────────────────────────────

_KNOTS = (cal.Knot(0.2, 0.1), cal.Knot(0.8, 0.9))


def test_below_support_is_identity_capped_at_the_lowest_fit():
    assert cal.apply_curve(_KNOTS, 0.0) == 0.0
    assert cal.apply_curve(_KNOTS, 0.05) == pytest.approx(0.05), "아래쪽 바깥은 원값 그대로"
    assert cal.apply_curve(_KNOTS, 0.15) == pytest.approx(0.1), "가장 낮은 적합값을 넘지 않는다"


def test_above_support_never_cuts_a_high_reading():
    """데이터가 못 본 높은 주차 수치를 '사실은 한산했다' 로 내리지 않는다 — 이 보정의 최악 사고."""
    shy = (cal.Knot(0.2, 0.1), cal.Knot(0.7, 0.3))
    assert cal.apply_curve(shy, 0.95) == pytest.approx(0.95), "위쪽 바깥은 항등 이상"
    assert cal.apply_curve(shy, 1.0) == 1.0
    # 반대로 곡선이 위로 밀어 올린 경우에는 그 값을 유지한다(안전한 방향).
    bold = (cal.Knot(0.2, 0.1), cal.Knot(0.7, 0.95))
    assert cal.apply_curve(bold, 0.8) == pytest.approx(0.95)


def test_apply_interpolates_and_clamps():
    assert cal.apply_curve(_KNOTS, 0.5) == pytest.approx(0.5)
    assert cal.apply_curve(_KNOTS, 0.2) == pytest.approx(0.1)
    assert cal.apply_curve(_KNOTS, 0.8) == pytest.approx(0.9)
    assert cal.apply_curve((), 0.42) == pytest.approx(0.42), "knot 이 없으면 항등"
    assert cal.apply_curve(_KNOTS, None) is None
    assert cal.apply_curve(_KNOTS, float("nan")) is None
    assert cal.apply_curve(_KNOTS, 1.4) == 1.0 and cal.apply_curve(_KNOTS, -0.3) == 0.0


# ── 쌍 만들기 ────────────────────────────────────────────────────────────────


def _row(bucket: datetime, *, area="명동 관광특구", parking=0.5, low=1000, high=3000) -> dict:
    return {
        "area_nm": area,
        "bucket_at": bucket.isoformat(),
        "ppltn_min": low,
        "ppltn_max": high,
        "parking_level": parking,
    }


def test_pairs_normalize_per_place_and_drop_rows_without_parking():
    base = datetime(2026, 10, 1, 1, 0, tzinfo=timezone.utc)
    rows = [
        _row(base, parking=0.2, low=1000, high=1000),
        _row(base + timedelta(minutes=10), parking=0.9, low=4000, high=4000),  # 명동 최대
        _row(base, area="동대문 관광특구", parking=0.4, low=500, high=500),
        _row(base + timedelta(minutes=10), area="동대문 관광특구", parking=0.8, low=1000, high=1000),
        _row(base + timedelta(minutes=20), parking=None),      # 실시간 주차장이 0곳이던 버킷
        _row(base + timedelta(minutes=30), low=None, high=None),  # 인구 범위가 비었다
    ]
    pairs = cal.build_pairs(rows)

    assert len(pairs) == 4, "x 나 y 가 없는 버킷은 쌍이 되지 않는다(0 으로 채우지 않는다)"
    myeongdong = [p for p in pairs if p.area_nm == "명동 관광특구"]
    dongdaemun = [p for p in pairs if p.area_nm == "동대문 관광특구"]
    # 정규화는 **대상지별** 최대 대비다 — 명동 4000 과 동대문 1000 을 한 눈금에 놓지 않는다.
    assert [p.y for p in myeongdong] == pytest.approx([0.25, 1.0])
    assert [p.y for p in dongdaemun] == pytest.approx([0.5, 1.0])
    assert {p.date_kst for p in pairs} == {"2026-10-01"}
    assert {p.hour_kst for p in pairs} == {10}
    assert all(p.weekend is False for p in pairs), "2026-10-01 은 목요일"


def test_pairs_ignore_duplicate_buckets():
    base = datetime(2026, 10, 1, 1, 0, tzinfo=timezone.utc)
    pairs = cal.build_pairs([_row(base), _row(base)])
    assert len(pairs) == 1


# ── 날짜 분할 ────────────────────────────────────────────────────────────────


def test_split_is_by_kst_date_with_the_last_third_held_out():
    pairs = _series(6, 10, lambda _d, x: x)
    train, holdout, holdout_dates = cal.split_by_date(pairs)

    assert len(holdout_dates) == 2, "6일 → 뒤 2일이 홀드아웃"
    assert {p.date_kst for p in train}.isdisjoint(holdout_dates)
    assert {p.date_kst for p in holdout} == set(holdout_dates)
    assert max(p.date_kst for p in train) < min(p.date_kst for p in holdout), "미래로 학습하지 않는다"


def test_split_needs_two_days():
    assert cal.split_by_date(_series(1, 50, lambda _d, x: x)) == ([], [], [])
    assert cal.split_by_date([]) == ([], [], [])


# ── 관문 ─────────────────────────────────────────────────────────────────────


def test_gate_passes_and_reports_quality():
    pairs = _series(6, 60, lambda _day, x: round(x * x, 4))  # 6일 × 60 = 360 쌍
    verdict = cal.assess(pairs, now=NOW)

    assert verdict["state"] == cal.STATE_READY and verdict["applied"] is True
    assert verdict["reason"] is None
    assert verdict["sample"] == {
        "paired_buckets": 360,
        "days": 6,
        "first_bucket_at": pairs[0].bucket_at.isoformat(),
        "last_bucket_at": pairs[-1].bucket_at.isoformat(),
    }
    quality = verdict["quality"]
    assert quality["holdout_days"] == 2
    assert quality["improved"] is True
    assert quality["mae_calibrated"] < quality["mae_identity"]
    # 보정은 단조라 순위를 바꾸지 않는다 — 두 ρ 가 같게 나오는 것이 정상이다.
    assert quality["spearman_identity"] == pytest.approx(quality["spearman_calibrated"], abs=1e-6)


def test_gate_blocks_when_days_are_too_few():
    pairs = _series(2, 200, lambda _day, x: round(x * x, 4))  # 400 쌍이지만 2일
    verdict = cal.assess(pairs, now=NOW)

    assert verdict["state"] == cal.STATE_INSUFFICIENT and verdict["applied"] is False
    assert "3일" in verdict["reason"]
    assert verdict["curve"] is not None, "적용은 안 해도 곡선은 보여 준다(지표를 감추지 않는다)"


def test_gate_blocks_when_samples_are_too_few():
    pairs = _series(4, 50, lambda _day, x: round(x * x, 4))  # 4일이지만 200 쌍
    verdict = cal.assess(pairs, now=NOW)

    assert verdict["state"] == cal.STATE_INSUFFICIENT and verdict["applied"] is False
    assert str(cal.MIN_PAIRED_BUCKETS) in verdict["reason"]


def test_gate_blocks_when_calibration_does_not_beat_identity():
    """학습 날짜의 관계가 홀드아웃에서 무너지면 켜지 않는다 — 이것이 날짜 분할을 두는 이유다."""

    def shape(day: int, x: float) -> float:
        return 0.2 if day < 4 else round(x, 4)

    verdict = cal.assess(_series(6, 60, shape), now=NOW)

    assert verdict["state"] == cal.STATE_INSUFFICIENT and verdict["applied"] is False
    assert verdict["quality"]["improved"] is False
    assert verdict["quality"]["mae_calibrated"] > verdict["quality"]["mae_identity"]
    assert "항등보다 낫지 않다" in verdict["reason"]


def test_gate_on_empty_pairs_is_the_empty_state():
    verdict = cal.assess([], now=NOW)
    assert verdict["state"] == cal.STATE_EMPTY and verdict["applied"] is False
    assert verdict["curve"] is None and verdict["quality"] is None
    assert verdict["sample"]["paired_buckets"] == 0


# ── 시간대 모양(표시 전용) ───────────────────────────────────────────────────


def test_hour_shape_splits_weekday_and_weekend_with_counts():
    rows = cal.hour_shape([(9, False, 0.2), (9, False, 0.4), (9, True, 1.0), (21, True, 0.5)])

    assert len(rows) == 24 and [row["hour"] for row in rows] == list(range(24))
    nine = rows[9]
    assert nine["weekday_mean"] == pytest.approx(0.3) and nine["weekend_mean"] == pytest.approx(1.0)
    assert nine["n"] == 3 and nine["weekday_n"] == 2 and nine["weekend_n"] == 1
    assert rows[0]["weekday_mean"] is None and rows[0]["n"] == 0


def test_curve_effect_reports_the_median_shift():
    curve = cal.Curve(knots=(cal.Knot(0.2, 0.1), cal.Knot(0.8, 0.5)), fitted_at=NOW.isoformat())
    effect = cal.curve_effect(curve, [0.2, 0.5, 0.8])

    assert effect["median_shift"] == pytest.approx(0.3 - 0.5, abs=1e-6)
    assert all(sample["calibrated"] <= sample["raw"] for sample in effect["samples"])
    assert cal.curve_effect(None, [0.5]) is None
    assert cal.curve_effect(curve, []) is None


# ── 캐시·무해한 실패 ─────────────────────────────────────────────────────────


def test_active_calibration_falls_back_to_identity_when_the_table_is_missing(monkeypatch):
    def _missing(days, *, now):
        raise cal.CalibrationTableMissing(cal.MIGRATION)

    monkeypatch.setattr(cal, "load_pairs", _missing)
    cal.reset_caches()
    try:
        state = cal.active_calibration(now=NOW)
    finally:
        cal.reset_caches()

    assert state.applied is False and state.state == cal.STATE_NOT_MIGRATED
    assert state.basis == cal.BASIS_NOT_APPLIED
    assert state.apply(0.42) == pytest.approx(0.42), "적용되지 않으면 f 는 항등"


def test_active_calibration_never_raises(monkeypatch):
    def _boom(days, *, now):
        raise RuntimeError("connection reset")

    monkeypatch.setattr(cal, "load_pairs", _boom)
    cal.reset_caches()
    try:
        state = cal.active_calibration(now=NOW)
    finally:
        cal.reset_caches()

    assert state.applied is False and state.apply(0.9) == pytest.approx(0.9)


def test_active_calibration_builds_and_caches_the_curve(monkeypatch):
    calls: list[int] = []
    pairs = _series(6, 60, lambda _day, x: round(x * x, 4))

    def _pairs(days, *, now):
        calls.append(days)
        return pairs

    monkeypatch.setattr(cal, "load_pairs", _pairs)
    cal.reset_caches()
    try:
        first = cal.active_calibration(now=NOW)
        second = cal.active_calibration(now=NOW)
    finally:
        cal.reset_caches()

    assert first is second and calls == [cal.DEFAULT_WINDOW_DAYS], "6시간 캐시 — 매 요청 적합하지 않는다"
    assert first.applied is True and first.state == cal.STATE_READY
    assert first.basis == "서울 실측으로 보정(명동·동대문, 6일 · 360표본)"
    assert first.apply(0.5) < 0.5, "y = x² 를 배웠으면 중간값을 아래로 당긴다"
    assert first.to_dict()["method"] == cal.METHOD


# ── 순위 관문(보고 전용 · SEOUL_TESTBED_PLAN 부록 약점 4) ─────────────────────


def test_rank_gate_passes_when_the_curve_carries_rank_information():
    gate = cal.rank_gate(_series(15, 60, lambda _day, x: round(x * x, 4)))  # 15일 → 홀드아웃 5일 × 60

    assert gate is not None and gate["status"] == "pass" and gate["reason"] is None
    assert gate["enforced"] is False
    assert gate["holdout_samples"] == 300 and gate["holdout_days"] == 5
    assert gate["holdout_spearman"] == pytest.approx(1.0)
    assert gate["beats_constant"] is True and gate["mae_calibrated"] < gate["mae_constant"]
    assert gate["min_holdout_spearman"] == 0.30
    assert gate["min_holdout_samples"] == 36 and gate["min_holdout_days"] == 5
    # 날마다 같은 관계라 하루를 빼도 ρ 가 같다 — SE 0, 하한 = ρ.
    assert gate["anomaly_rho_se"] == pytest.approx(0.0) and gate["anomaly_rho_ci_low"] == gate["anomaly_rho"]
    assert gate["anomaly_ci_method"] == cal.SPEARMAN_ANOMALY_CI_METHOD


def test_rank_gate_fails_on_an_anti_correlated_set():
    gate = cal.rank_gate(_series(15, 60, lambda _day, x: round(1.0 - x, 4)))

    assert gate["status"] == "fail"
    assert gate["holdout_spearman"] == pytest.approx(-1.0)
    assert "0.30" in gate["reason"]


def test_rank_gate_reports_the_flat_curve_that_still_beats_identity():
    """주차와 인파가 무관해도 PAVA 는 평균 쪽으로 끌어당겨 항등보다 MAE 가 낮아질 수 있다 — 관문이 잡는 사례."""

    def shape(day: int, x: float) -> float:
        # x 와 무관한 날짜·순서 고유 값(0.4~0.6) — x 의 순서 정보가 없다.
        return round(0.5 + 0.1 * math.sin(day * 7.3 + x * 91.0), 4)

    pairs = _series(15, 60, shape)
    verdict = cal.assess(pairs, now=NOW)
    gate = cal.rank_gate(pairs)

    assert verdict["applied"] is True, "기존 관문은 순위 정보 없이도 통과한다(그래서 이 관문을 보고한다)"
    assert gate["status"] == "fail" and abs(gate["holdout_spearman"]) < 0.30


@pytest.mark.parametrize(
    ("days", "per_day", "samples", "holdout_days"),
    [(12, 60, 240, 4), (15, 5, 25, 5)],  # 날짜 4일 < 5 · 점 25개 < 36
)
def test_rank_gate_is_insufficient_on_a_thin_holdout(days, per_day, samples, holdout_days):
    gate = cal.rank_gate(_series(days, per_day, lambda _day, x: round(x * x, 4)))

    assert gate["status"] == "insufficient"
    assert gate["holdout_samples"] == samples and gate["holdout_days"] == holdout_days
    assert "최소 36점 · 5일" in gate["reason"]


def test_rank_gate_is_none_safe_on_degenerate_input():
    assert cal.rank_gate([]) is None

    single = cal.rank_gate(_series(1, 60, lambda _day, x: x))  # 날짜 하나 — 학습이 비어 있다
    assert single["status"] == "insufficient" and single["holdout_samples"] == 0
    assert single["holdout_spearman"] is None and single["mae_constant"] is None
    assert single["beats_constant"] is False

    start = datetime(2026, 10, 1, 1, 0, tzinfo=timezone.utc)
    constant_x = [
        _pair(start + timedelta(days=day, minutes=4 * step), 0.5, round(0.1 + 0.8 * step / 59, 4))
        for day in range(15)
        for step in range(60)
    ]
    gate = cal.rank_gate(constant_x)
    assert gate["status"] == "insufficient" and gate["holdout_spearman"] is None
    assert "정의되지 않는다" in gate["reason"]


def _hourly_pairs(x_of, y_of, days: int = 15) -> list[cal.Pair]:
    """KST 10~13시 × 15버킷(4분 간격). x·y 는 (날짜, 시)만의 함수 — 한 시간 안에서는 상수다."""
    start = datetime(2026, 10, 1, 1, 0, tzinfo=timezone.utc)  # KST 10:00
    pairs = []
    for day in range(days):
        for step in range(60):
            bucket = start + timedelta(days=day, minutes=4 * step)
            hour = 10 + step // 15
            pairs.append(_pair(bucket, round(x_of(day, hour), 4), round(y_of(day, hour), 4)))
    return pairs


def test_rank_gate_anomaly_rho_uses_train_date_slot_cells():
    base = {10: 0.2, 11: 0.4, 12: 0.6, 13: 0.7}
    # x 가 시각만으로 정해지면 학습 날짜 시간대 평균을 빼고 남는 것이 없다 — 이상치 ρ 는 정의되지 않는다(0 이 아니다).
    flat = cal.rank_gate(_hourly_pairs(lambda d, h: base[h], lambda d, h: base[h] ** 2 + 0.03 * math.sin(d * 3.1 + h)))
    assert flat["anomaly_rho"] is None
    assert flat["holdout_spearman"] > 0.9, "하루 모양만으로도 홀드아웃 ρ 는 높다 — 이상치 ρ 로 판정하는 이유"
    assert flat["status"] == "fail", "하루 모양만으로는 관문을 넘지 못한다"

    # 날마다 x·y 가 함께 오르내리면(그날 고유의 변화) 이상치 ρ 가 양수로 남는다.
    def shift(day: int, hour: int) -> float:
        return 0.08 * math.sin(day * 2.3 + hour * 0.7)

    tracked = cal.rank_gate(
        _hourly_pairs(lambda d, h: base[h] + shift(d, h), lambda d, h: (base[h] + shift(d, h)) ** 2)
    )
    assert tracked["anomaly_rho"] > 0.9


def test_build_report_never_raises_when_the_rank_gate_breaks(monkeypatch):
    monkeypatch.setattr(cal, "load_pairs", lambda days, *, now: _series(15, 60, lambda _d, x: round(x * x, 4)))
    monkeypatch.setattr(cal, "_load_gyeongju_levels", lambda days, *, now: [])

    def _boom(pairs):
        raise ZeroDivisionError("boom")

    good = cal.build_report(28, now=NOW)
    monkeypatch.setattr(cal, "rank_gate", _boom)
    broken = cal.build_report(28, now=NOW)

    assert good["rank_gate"]["status"] == "pass"
    assert broken["rank_gate"] is None
    assert {k: v for k, v in good.items() if k != "rank_gate"} == {
        k: v for k, v in broken.items() if k != "rank_gate"
    }, "관문 계산이 깨져도 리포트의 나머지는 같다"


# ── 경주 잠금: 적용 경로는 S4 이전과 같다 ─────────────────────────────────────
#
# 아래 두 함수는 8e27138(S4 이전)의 `assess()` · `_build_state()` 를 **그대로 옮긴 사본**이다. 순위 관문은
# build_report 에서만 계산되므로 적용 경로(assess → _build_state → active_calibration → 경주 추정)는 바뀌면 안 된다.
# 이 사본과 결과가 달라지면 경주 화면의 보정값이 바뀐 것이다 — 고치기 전에 그 변경이 의도인지 먼저 확인한다.


def _frozen_assess(pairs, *, now):
    fitted_at = now.astimezone(timezone.utc).isoformat()
    dates = sorted({pair.date_kst for pair in pairs})
    sample = {
        "paired_buckets": len(pairs),
        "days": len(dates),
        "first_bucket_at": pairs[0].bucket_at.astimezone(timezone.utc).isoformat() if pairs else None,
        "last_bucket_at": pairs[-1].bucket_at.astimezone(timezone.utc).isoformat() if pairs else None,
    }
    if not pairs:
        return {
            "state": cal.STATE_EMPTY, "applied": False, "curve": None, "quality": None,
            "sample": sample,
            "reason": "보정 대상지(명동·동대문)의 주차·인구 쌍이 아직 한 건도 없다 — 수집 시작 전이다.",
        }
    curve = cal.fit_curve(pairs, fitted_at=fitted_at)
    train, holdout, _holdout_dates = cal.split_by_date(pairs)
    train_curve = cal.fit_curve(train, fitted_at=fitted_at) if train else None
    quality = cal.evaluate(train_curve, holdout) if train_curve is not None and holdout else None
    reason = None
    if len(dates) < 3:
        reason = f"서로 다른 KST 날짜가 {len(dates)}일 — 최소 3일이 필요하다."
    elif len(pairs) < 300:
        reason = f"짝지어진 버킷 {len(pairs)}개 — 최소 300개가 필요하다."
    elif quality is None:
        reason = "날짜로 학습·홀드아웃을 가를 수 없다(날짜가 하나뿐이다)."
    elif not quality["improved"]:
        reason = (
            "홀드아웃에서 보정이 항등보다 낫지 않다"
            f"(MAE 보정 {quality['mae_calibrated']} vs 항등 {quality['mae_identity']}) — 적용하지 않는다."
        )
    elif curve is None:
        reason = "곡선을 적합할 수 없다."
    applied = reason is None
    return {
        "state": cal.STATE_READY if applied else cal.STATE_INSUFFICIENT,
        "applied": applied, "curve": curve, "quality": quality, "sample": sample, "reason": reason,
    }


def _frozen_state(pairs, *, now) -> cal.CalibrationState:
    verdict = _frozen_assess(pairs, now=now)
    days = verdict["sample"]["days"]
    paired = verdict["sample"]["paired_buckets"]
    applied = bool(verdict["applied"])
    return cal.CalibrationState(
        applied=applied,
        state=verdict["state"],
        curve=verdict["curve"] if applied else None,
        days=days,
        paired_buckets=paired,
        basis=f"서울 실측으로 보정(명동·동대문, {days}일 · {paired}표본)" if applied else cal.BASIS_NOT_APPLIED,
        reason=verdict["reason"],
    )


def _constant_x_holdout() -> list[cal.Pair]:
    pairs = _series(6, 60, lambda _day, x: round(x * x, 4))
    holdout_dates = set(cal.split_by_date(pairs)[2])
    return [
        cal.Pair(p.area_nm, p.bucket_at, p.date_kst, p.hour_kst, p.weekend, 0.5, p.y) if p.date_kst in holdout_dates else p
        for p in pairs
    ]


_LOCK_FIXTURES = {
    "convex_ready": lambda: _series(6, 60, lambda _day, x: round(x * x, 4)),
    "long_ready": lambda: _series(15, 60, lambda _day, x: round(x * x, 4)),
    "too_few_days": lambda: _series(2, 200, lambda _day, x: round(x * x, 4)),
    "too_few_samples": lambda: _series(4, 50, lambda _day, x: round(x * x, 4)),
    "does_not_beat_identity": lambda: _series(6, 60, lambda day, x: 0.2 if day < 4 else round(x, 4)),
    "empty": lambda: [],
    "single_date": lambda: _series(1, 400, lambda _day, x: round(x * x, 4)),
    "constant_x_holdout": _constant_x_holdout,
    "anti_correlated": lambda: _series(15, 60, lambda _day, x: round(1.0 - x, 4)),
}


@pytest.mark.parametrize("name", sorted(_LOCK_FIXTURES))
def test_apply_path_is_identical_to_the_frozen_pre_s4_copy(name, monkeypatch):
    pairs = _LOCK_FIXTURES[name]()

    assert cal.assess(pairs, now=NOW) == _frozen_assess(pairs, now=NOW)

    monkeypatch.setattr(cal, "load_pairs", lambda days, *, now: pairs)
    expected = _frozen_state(pairs, now=NOW)
    assert cal._build_state(now=NOW) == expected
    cal.reset_caches()
    try:
        assert cal.active_calibration(now=NOW) == expected
    finally:
        cal.reset_caches()

    # 리포트도 적용 판정 필드는 사본과 같고, 관문은 None 이거나 dict 다.
    monkeypatch.setattr(cal, "_load_gyeongju_levels", lambda days, *, now: [])
    report = cal.build_report(28, now=NOW)
    frozen = _frozen_assess(pairs, now=NOW)
    assert report["applied"] == frozen["applied"] and report["state"] == frozen["state"]
    assert report["quality"] == frozen["quality"] and report["reason"] == frozen["reason"]
    assert report["curve"] == (frozen["curve"].to_dict() if frozen["curve"] is not None else None)
    assert report["requirement"] == {"min_paired_buckets": 300, "min_days": 3, "must_beat_identity": True}
    gate = report["rank_gate"]
    assert gate is None or isinstance(gate, dict)
    if name == "anti_correlated":
        assert gate["status"] == "fail"
    if name in {"empty"}:
        assert gate is None
    if name in {"single_date", "too_few_days", "too_few_samples", "convex_ready", "constant_x_holdout"}:
        assert gate["status"] == "insufficient"


def test_rank_gate_does_not_pass_on_between_site_offsets_alone():
    """대상지마다 x·y 수준만 다르고 대상지 안에서는 x 가 y 순서를 모르면 — 관문은 통과하면 안 된다.

    섞은(pooled) ρ 는 대상지 차이만으로 높게 나오고, 전역 학습 평균 상수는 곡선에 진다. 관문은 대상지 안 ρ 와
    대상지별 학습 평균 상수로 판정한다(SEOUL_TESTBED_PLAN 부록 약점 4 · S4 검토).
    """
    import random

    rng = random.Random(1)
    start = datetime(2026, 10, 1, 1, 0, tzinfo=timezone.utc)  # KST 10:00
    pairs = []
    for day in range(15):
        for hour in range(10):
            bucket = start + timedelta(days=day, hours=hour)
            for site, base in (("A", 0.2), ("B", 0.7)):
                pairs.append(
                    _pair(bucket, base + rng.uniform(-0.1, 0.1), base + rng.uniform(-0.1, 0.1), area=site)
                )

    gate = cal.rank_gate(pairs)

    assert gate["pooled_spearman"] > 0.5, "섞으면 대상지 차이만으로 ρ 가 높다(참고 필드)"
    assert abs(gate["holdout_spearman"]) < 0.30, "판정 ρ 는 대상지 안에서 잰다"
    assert gate["holdout_sites"] == 2
    assert gate["beats_constant"] is False, "비교 상수는 대상지별 학습 평균이다"
    assert gate["status"] == "fail"


def test_rank_gate_within_site_rho_passes_when_each_site_carries_rank():
    start = datetime(2026, 10, 1, 1, 0, tzinfo=timezone.utc)
    pairs = []
    for day in range(15):
        for step in range(60):
            bucket = start + timedelta(days=day, minutes=4 * step)
            x = round(0.1 + 0.8 * ((step * 7 + day) % 60) / 59, 4)
            pairs.append(_pair(bucket, x, round(x * x, 4), area="A"))
            pairs.append(_pair(bucket, round(x * 0.5 + 0.4, 4), round(0.2 + 0.5 * x, 4), area="B"))

    gate = cal.rank_gate(pairs)

    assert gate["status"] == "pass" and gate["holdout_sites"] == 2
    assert gate["holdout_spearman"] == pytest.approx(1.0)
    assert gate["beats_constant"] is True


def _ten_minute_pairs(x_of, y_of, *, days: int = 21, seed: int = 7) -> list[cal.Pair]:
    """KST 하루 전체 10분 버킷(144개) × days 일 × 두 대상지. ``x_of(day, slot, site)`` · ``y_of(day, slot, site, rng)``."""
    import random

    rng = random.Random(seed)
    start = datetime(2026, 9, 30, 15, 0, tzinfo=timezone.utc)  # KST 10-01 00:00
    pairs = []
    for day in range(days):
        for slot in range(144):
            bucket = start + timedelta(days=day, minutes=10 * slot)
            for site in ("A", "B"):
                x = min(1.0, max(0.0, x_of(day, slot, site)))
                y = min(1.0, max(0.0, y_of(day, slot, site, rng)))
                pairs.append(_pair(bucket, round(x, 4), round(y, 4), area=site))
    return pairs


def _clock(slot: int) -> float:
    return 0.5 + 0.4 * math.sin((slot - 54) / 144 * 2 * math.pi)


@pytest.mark.parametrize("seed", [1, 2, 3, 4, 5])
def test_rank_gate_does_not_pass_a_clock_only_estimator(seed):
    """x 가 시각만의 함수(하루 모양)면 대상지 안 ρ 도 높고 대상지 상수도 이긴다 — 그래도 통과하면 안 된다(S4 검토 2차).

    그날 고유의 정보가 없기 때문이다. 이상치 ρ 는 데이터 해상도(10분 칸)로 재므로 시각만의 x 는 이상치가 모두 0 이다.
    """
    pairs = _ten_minute_pairs(
        lambda day, slot, site: _clock(slot),
        lambda day, slot, site, rng: _clock(slot) + 0.1 * math.sin(day * 1.7) + rng.gauss(0, 0.05),
        seed=seed,
    )
    gate = cal.rank_gate(pairs)

    assert gate["holdout_spearman"] >= 0.30 and gate["beats_constant"] is True, "관문 (1)·(2)는 넘는다"
    assert gate["anomaly_rho"] is None, "10분 칸 시간대 평균을 빼면 시각만의 x 는 남는 것이 없다"
    assert gate["status"] == "fail" and "하루 모양" in gate["reason"]
    assert gate["min_anomaly_rho"] == 0.10 and gate["anomaly_slot_minutes"] == 10


def test_rank_gate_passes_when_parking_tracks_day_specific_changes():
    """하루 모양 위에 그날 고유의 변화가 x·y 에 함께 실리면 이상치 ρ 가 남아 통과한다."""

    def day_signal(day: int, slot: int) -> float:
        return 0.12 * math.sin(day * 2.3 + slot * 0.05)

    pairs = _ten_minute_pairs(
        lambda day, slot, site: _clock(slot) + day_signal(day, slot),
        lambda day, slot, site, rng: (_clock(slot) + day_signal(day, slot)) ** 2 + rng.gauss(0, 0.02),
    )
    gate = cal.rank_gate(pairs)

    assert gate["status"] == "pass", gate["reason"]
    assert gate["anomaly_rho"] >= 0.10
    assert gate["anomaly_rho_ci_low"] > 0


# ── 이상치 ρ 의 날짜 잭나이프 하한(S4 검토 3차) ──────────────────────────────
#
# 같은 날 안의 10분 점들은 서로 닮아(자기상관) 점 수만큼의 정보가 없다. ρ ≥ 0.10 만 보면 정보 없는 x 도
# 21일 창(홀드아웃 7일)에서 넷 중 하나꼴로 넘었다(리뷰 프로브: 60시드 중 25%). 엔진 검증 Spearman 관문과 같은
# 날짜 잭나이프 95% 하한 > 0 을 더하면 시드 0~79 에서 4/80(400시드 3.0%), 신호가 있는 x 는 80/80(400시드 99.5%).


def _ar1(rng, n: int, phi: float = 0.95, sd: float = 0.12) -> list[float]:
    value, out = 0.0, []
    step = sd * math.sqrt(1 - phi * phi)
    for _ in range(n):
        value = phi * value + rng.gauss(0, step)
        out.append(value)
    return out


def _null_probe_pairs(seed: int, *, signal: float = 0.0, days: int = 21) -> list[cal.Pair]:
    """KST 08~22시 10분 버킷 × days 일. x·y 는 같은 하루 모양(sin) + 각자 독립인 AR(1) 흔들림.

    signal=0 이면 x 는 y 의 그날 고유 변화를 전혀 모른다(하루 모양만 공유). signal=1 이면 y 의 흔들림을 x 에도 더한다.
    """
    import random

    rng = random.Random(seed)
    start = datetime(2026, 10, 1, tzinfo=_KST)
    slots = list(range(8 * 6, 22 * 6))
    pairs = []
    for day in range(days):
        noise_y = _ar1(rng, len(slots))
        noise_x = _ar1(rng, len(slots))
        for i, slot in enumerate(slots):
            bucket = start + timedelta(days=day, minutes=10 * slot)
            shape = 0.5 + 0.3 * math.sin((slot / 6 - 8) / 14 * math.pi)
            y = min(1.0, max(0.0, shape + noise_y[i]))
            x = min(1.0, max(0.0, shape + noise_x[i] + signal * noise_y[i]))
            pairs.append(_pair(bucket.astimezone(timezone.utc), x, y, area="A"))
    return pairs


_PROBE_SEEDS = range(80)


def test_rank_gate_rarely_passes_an_estimator_without_day_specific_information():
    passed = [seed for seed in _PROBE_SEEDS if cal.rank_gate(_null_probe_pairs(seed))["status"] == "pass"]
    # 측정: 4/80(시드 7·19·21·27). 하한이 없던 규칙은 같은 모양에서 25% 였다. 여유를 두고 10% 로 잠근다.
    assert len(passed) <= len(_PROBE_SEEDS) // 10, passed


def test_rank_gate_still_passes_an_estimator_that_tracks_day_specific_changes():
    passed = [
        seed for seed in _PROBE_SEEDS if cal.rank_gate(_null_probe_pairs(seed, signal=1.0))["status"] == "pass"
    ]
    # 측정: 80/80. 하한이 신호까지 막지 않는지 본다.
    assert len(passed) >= len(_PROBE_SEEDS) * 9 // 10, len(passed)


def test_rank_gate_fails_when_only_the_jackknife_lower_bound_is_below_zero():
    """시드 2: 옛 규칙(대상지 안 ρ · 상수 이김 · 이상치 ρ ≥ 0.10)은 모두 넘지만 날짜 하한이 0 이하다."""
    gate = cal.rank_gate(_null_probe_pairs(2))

    assert gate["holdout_spearman"] >= 0.30 and gate["beats_constant"] is True
    assert gate["anomaly_rho"] >= gate["min_anomaly_rho"], "옛 규칙이면 통과했다"
    assert gate["holdout_days"] == 7
    assert gate["anomaly_rho_se"] > 0
    assert gate["anomaly_rho_ci_low"] <= 0
    assert gate["anomaly_ci_method"] == "날짜 잭나이프 · t(0.975, 날짜−1)"
    assert gate["status"] == "fail"
    assert gate["reason"] == f"시간대 평균을 뺀 ρ 의 95% 하한(날짜 잭나이프) {gate['anomaly_rho_ci_low']:.4f} ≤ 0"


def test_rank_gate_fails_when_the_lower_bound_cannot_be_computed(monkeypatch):
    monkeypatch.setattr(cal, "_day_jackknife", lambda *args: (None, None))
    gate = cal.rank_gate(_series(15, 60, lambda _day, x: round(x * x, 4)))

    assert gate["anomaly_rho"] is not None and gate["anomaly_rho_ci_low"] is None and gate["anomaly_rho_se"] is None
    assert gate["status"] == "fail"
    assert gate["reason"] == "시간대 평균을 뺀 ρ 의 95% 하한을 계산할 수 없다(홀드아웃 날짜 부족)"
