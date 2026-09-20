# 서울 실측 → 경주 추정 보정(docs/CONGESTION_ENGINE_PLAN.md §5.3-5·6, D5)의 순수 함수.
#
# 여기서 잠그는 것 — 전부 "잘못 켜지면 사용자에게 거짓말이 되는" 자리다:
#   · 곡선은 **단조 비감소**다. 주차가 더 찼는데 더 한산하다고 말하는 일이 없다.
#   · 관측 범위 **위쪽 바깥은 절대 깎지 않는다**(항등 이상). 높은 주차를 '여유' 로 내리는 사고 방지.
#   · 관문(3일 · 300버킷 · 홀드아웃 MAE 개선)을 하나라도 못 넘으면 applied=False → 추정기는 항등.
#   · 학습·평가는 **KST 날짜**로 가른다(시간 순서 누수 금지 — area_demand_forecast_service 와 같은 규칙).
#   · 어떤 실패도 예외로 새지 않는다(active_calibration 은 항등으로 떨어진다).

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
