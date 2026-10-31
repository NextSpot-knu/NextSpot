"""서울 검증 지표(CONGESTION_ENGINE_PLAN §6) — 정의·경계·표본 부족·실패 노출을 잠근다."""

import math
import random
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.services import engine_validation_metrics as m

T0 = datetime(2026, 9, 21, 0, 0, tzinfo=timezone.utc)


def _row(i: int, lvl: str, mid: float | None, est: float | None, **extra) -> dict:
    row = {
        "area_cd": "POI014",
        "area_nm": "홍대 관광특구",
        "bucket_at": (T0 + timedelta(minutes=10 * i)).isoformat(),
        "observed_at": (T0 + timedelta(minutes=10 * i - 3)).isoformat(),
        "congest_lvl": lvl,
        "ppltn_min": None if mid is None else mid - 1000,
        "ppltn_max": None if mid is None else mid + 1000,
        "fcst": [],
        "live_lot_count": 3,
        "parking_level": est,
        "tourism_level": None,
        "level_est": est,
        "estimator_version": "v1",
    }
    row.update(extra)
    return row


def _metric(place: dict, key: str) -> dict:
    return next(metric for metric in place["metrics"] if metric["key"] == key)


# --- 등급 변환 -----------------------------------------------------------------


def test_actual_grade_maps_four_seoul_levels_and_rejects_unknown():
    assert [m.actual_grade(x) for x in ("여유", "보통", "약간 붐빔", "붐빔")] == [0, 1, 2, 3]
    assert m.actual_grade("약간붐빔") == 2  # 공백 차이는 흡수
    assert m.actual_grade("매우 붐빔") is None  # 모르는 값을 지어내지 않는다
    assert m.actual_grade(None) is None


@pytest.mark.parametrize(
    ("level", "grade"),
    [(0.0, 0), (0.2499, 0), (0.25, 1), (0.4999, 1), (0.5, 2), (0.7499, 2), (0.75, 3), (1.0, 3), (None, None)],
)
def test_estimated_grade_uses_repo_75_threshold_edges(level, grade):
    assert m.estimated_grade(level) == grade


def test_population_midpoint_and_string_numbers():
    assert m.population_midpoint(1000, 3000) == 2000
    assert m.population_midpoint("1,000", "3,000") == 2000
    assert m.population_midpoint(None, 500) == 500
    assert m.population_midpoint(None, None) is None


# --- Spearman ------------------------------------------------------------------


def test_spearman_handles_ties_with_average_ranks():
    assert m.average_ranks([10, 20, 20, 30]) == [1.0, 2.5, 2.5, 4.0]
    assert m.spearman_rho([1, 2, 3, 4], [10, 20, 30, 40]) == pytest.approx(1.0)
    assert m.spearman_rho([1, 2, 3, 4], [40, 30, 20, 10]) == pytest.approx(-1.0)
    # 동률이 있는 경우의 교과서 값: x=[1,2,2,3], y=[1,3,2,4] → ρ = 0.9487
    assert m.spearman_rho([1, 2, 2, 3], [1, 3, 2, 4]) == pytest.approx(0.9486833, abs=1e-6)


def test_spearman_constant_series_is_undefined_not_zero():
    assert m.spearman_rho([0.5, 0.5, 0.5], [1, 2, 3]) is None


# --- 정규화 --------------------------------------------------------------------


def test_normalized_actual_is_midpoint_over_window_max():
    points, normalization = m.build_points([_row(0, "보통", 5000, 0.3), _row(1, "붐빔", 10000, 0.8)])
    assert normalization["max_midpoint"] == 10000
    assert [p.normalized_actual for p in points] == [0.5, 1.0]


def test_duplicate_bucket_keeps_latest_fetch():
    older = _row(0, "여유", 1000, 0.1, fetched_at="2026-09-21T00:01:00+00:00")
    newer = _row(0, "붐빔", 9000, 0.9, fetched_at="2026-09-21T00:05:00+00:00")
    points, _ = m.build_points([newer, older])
    assert len(points) == 1 and points[0].actual_grade == 3


# --- 표본 부족 -----------------------------------------------------------------


def test_small_sample_is_insufficient_but_value_is_still_shown():
    place = m.summarize_place([_row(i, "보통", 5000, 0.3) for i in range(10)])
    exact = _metric(place, "grade_exact")
    assert exact["status"] == m.STATUS_INSUFFICIENT
    assert exact["n"] == 10 and exact["min_n"] == m.MIN_SAMPLES
    assert exact["value"] == 1.0  # 숨기지 않는다
    assert "36" in exact["reason"]
    assert place["sufficient"] is False


def test_empty_input_is_all_insufficient_not_crash():
    place = m.summarize_place([])
    assert place["bucket_count"] == 0
    assert all(metric["status"] in (m.STATUS_INSUFFICIENT, m.STATUS_REPORT) for metric in place["metrics"])
    assert place["series"] == []


# --- 통과·미달 판정 ------------------------------------------------------------


def _good_rows(n: int = 48) -> list[dict]:
    """추정이 실측을 잘 따라가는 합성 표본: 인구가 오르내리고 level_est 가 같은 방향으로 움직인다."""
    rows = []
    for i in range(n):
        phase = (i % 24) / 23.0  # 0 → 1 반복
        mid = 2000 + 8000 * phase
        norm = mid / 10000
        grade = m.GRADE_LABELS[min(3, int(norm * 4))] if norm < 1 else "붐빔"
        rows.append(_row(i, grade, mid, max(0.0, min(1.0, norm - 0.02))))
    return rows


def test_good_estimator_passes_rate_and_correlation_metrics():
    place = m.summarize_place(_good_rows())
    assert place["sufficient"] is True
    assert _metric(place, "grade_exact")["status"] == m.STATUS_PASS
    assert _metric(place, "grade_within_one")["status"] == m.STATUS_PASS
    spearman = _metric(place, "spearman")
    # 예전에는 하루치 표본으로도 통과였다 — 부록 약점 1(기준선 없는 ρ). 이제 시간대 평균(다른 날)을 뺀 이상치 ρ 를
    # 계산할 날짜가 없으면 판정하지 않는다. 값(전체 표본 ρ)은 그대로 보여 준다.
    assert spearman["value"] > 0.9
    assert spearman["status"] == m.STATUS_INSUFFICIENT
    assert spearman["reason"] == m.SPEARMAN_ANOMALY_REASON
    assert spearman["anomaly_n"] == 0 and spearman["anomaly_rho"] is None


def test_failing_metric_is_reported_as_fail_not_hidden():
    # 추정이 항상 0.1(여유) — 실측은 붐빔. §6: 통과 못 하면 통과 못 한 대로.
    rows = [_row(i, "붐빔", 5000 + (i % 5) * 100, 0.1) for i in range(40)]
    place = m.summarize_place(rows)
    exact = _metric(place, "grade_exact")
    assert exact["status"] == m.STATUS_FAIL and exact["value"] == 0.0
    danger = _metric(place, "danger_misclassification")
    assert danger["status"] == m.STATUS_FAIL
    assert danger["value"] == 1.0 and danger["n"] == 40 and danger["missed"] == 40


def test_danger_misclassification_counts_only_safe_grades_as_misses():
    # 실측 붐빔 20개: 추정 '약간 붐빔'(0.6) 은 오분류가 아니다, '보통'(0.3) 1개만 오분류.
    rows = [_row(i, "붐빔", 9000, 0.6) for i in range(19)] + [_row(19, "붐빔", 9000, 0.3)]
    danger = _metric(m.summarize_place(rows), "danger_misclassification")
    assert danger["missed"] == 1 and danger["n"] == 20
    assert danger["value"] == pytest.approx(0.05)
    assert danger["status"] == m.STATUS_PASS  # ≤ 5%


def test_danger_without_crowded_buckets_says_why():
    danger = _metric(m.summarize_place([_row(i, "여유", 1000, 0.1) for i in range(40)]), "danger_misclassification")
    assert danger["status"] == m.STATUS_INSUFFICIENT and danger["n"] == 0
    assert "붐빔" in danger["reason"]


def test_constant_estimate_makes_spearman_insufficient_with_reason():
    rows = [_row(i, "보통", 3000 + i * 10, 0.4) for i in range(40)]
    spearman = _metric(m.summarize_place(rows), "spearman")
    assert spearman["status"] == m.STATUS_INSUFFICIENT
    assert spearman["value"] is None and "변하지 않아" in spearman["reason"]


# --- 30분 전망 ------------------------------------------------------------------


def test_forecast_mae_keeps_old_numbers_as_raw_and_oracle_reference():
    # 실측이 30분마다 크게 튀는데 추정은 평균에 머문다. 예전에는 지속 모델(0.8)을 기준선으로 '이겼다' 고 통과였다 —
    # 부록 약점 2: 지속 모델은 t 의 **실측**을 쓰는 오라클이다. 옛 두 숫자는 raw_mae · oracle_reference_mae 로 남고,
    # 판정은 학습/홀드아웃 날짜 분할이 필요하다(하루치라 판정하지 않는다).
    rows = []
    for i in range(60):
        mid = 10000 if (i // 3) % 2 == 0 else 2000
        rows.append(_row(i, "보통", mid, 0.6))
    mae = _metric(m.summarize_place(rows), "forecast_mae_30m")
    # t 와 t+30 은 3버킷 차 → 실측은 항상 반대편: 지속 모델 오차 = 0.8
    assert mae["oracle_reference_mae"] == pytest.approx(0.8)
    assert mae["oracle_reference_label"] == m.FORECAST_ORACLE_LABEL
    assert mae["raw_mae"] == pytest.approx(0.4)
    assert mae["raw_n"] == 57
    assert mae["baseline_label"] == m.FORECAST_BASELINE_LABEL
    assert mae["status"] == m.STATUS_INSUFFICIENT
    assert "하루뿐" in mae["reason"]


def test_forecast_mae_ties_do_not_count_as_beating_the_baseline():
    # 정규화 실측이 늘 1.0 — 보정 추정도 시간대 평균도 오차 0. 0 ≤ 0.95 × 0 이지만 동률은 이긴 것이 아니다.
    rows = _multi_day_rows(14, lambda ctx: 1.0, actual_fn=lambda ctx: 1.0)
    mae = _metric(m.summarize_place(rows), "forecast_mae_30m")
    assert mae["holdout_n"] >= m.MIN_SAMPLES and mae["holdout_dates"] >= m.FORECAST_MIN_HOLDOUT_DATES
    assert mae["value"] == 0.0 and mae["baseline_mae"] == 0.0 and mae["threshold"] == 0.0
    assert mae["status"] == m.STATUS_FAIL


def test_forecast_skips_pairs_with_missing_future_bucket():
    rows = [_row(i, "보통", 5000, 0.5) for i in (0, 1, 2, 4)]  # t=0 → t+30 = 3 이 없다
    mae = _metric(m.summarize_place(rows), "forecast_mae_30m")
    assert mae["raw_n"] == 1  # 1 → 4 만 짝이 된다


def test_seoul_forecast_is_report_only_and_matches_nearest_entry():
    rows = []
    for i in range(10):
        bucket = T0 + timedelta(minutes=10 * i)
        target_kst = (bucket + timedelta(minutes=30)).astimezone(timezone(timedelta(hours=9)))
        fcst = [
            {"FCST_TIME": target_kst.strftime("%Y-%m-%d %H:%M"), "FCST_PPLTN_MIN": "4000", "FCST_PPLTN_MAX": "6000"},
            {"FCST_TIME": (target_kst + timedelta(hours=3)).strftime("%Y-%m-%d %H:%M"), "FCST_PPLTN_MIN": 0, "FCST_PPLTN_MAX": 0},
        ]
        rows.append(_row(i, "보통", 10000 if i == 0 else 5000, 0.5, fcst=fcst))
    seoul = _metric(m.summarize_place(rows), "seoul_forecast_mae_30m")
    assert seoul["status"] == m.STATUS_REPORT
    assert seoul["n"] == 7
    assert seoul["value"] == pytest.approx(0.0)  # 5000/10000 = 실측 0.5


def test_seoul_forecast_outside_tolerance_is_ignored():
    far = [{"FCST_TIME": "2030-01-01 00:00", "FCST_PPLTN_MIN": 1, "FCST_PPLTN_MAX": 2}]
    assert m.seoul_forecast_midpoint(far, T0) is None
    assert m.seoul_forecast_midpoint({"FCST_PPLTN": far}, T0) is None
    assert m.seoul_forecast_midpoint("garbage", T0) is None


# --- 커버리지·혼동표·구성 ------------------------------------------------------


def test_coverage_counts_buckets_without_estimate():
    rows = [_row(i, "보통", 5000, 0.4 if i % 4 else None) for i in range(40)]
    coverage = _metric(m.summarize_place(rows), "coverage")
    assert coverage["status"] == m.STATUS_REPORT
    assert coverage["value"] == pytest.approx(0.75) and coverage["covered"] == 30 and coverage["n"] == 40


def test_confusion_matrix_rows_are_actual_columns_are_estimate():
    place = m.summarize_place([_row(0, "붐빔", 9000, 0.1), _row(1, "여유", 1000, 0.1)])
    matrix = place["confusion"]["matrix"]
    assert matrix[3][0] == 1 and matrix[0][0] == 1 and place["confusion"]["total"] == 2


def test_distinguishability_is_omitted_with_reason():
    place = m.summarize_place(_good_rows())
    assert [item["key"] for item in place["omitted_metrics"]] == ["distinguishability"]
    assert "1곳" in place["omitted_metrics"][0]["reason"]
    assert "distinguishability" not in {metric["key"] for metric in place["metrics"]}


def test_only_latest_estimator_version_is_scored():
    rows = [_row(i, "붐빔", 9000, 0.1, estimator_version="v1") for i in range(5)]
    rows += [_row(i, "붐빔", 9000, 0.9, estimator_version="v2") for i in range(5, 10)]
    place = m.summarize_place(rows)
    assert place["estimator_version"] == "v2"
    assert place["excluded_other_version_rows"] == 5
    assert place["estimator_versions_in_window"] == ["v1", "v2"]
    assert place["bucket_count"] == 5


def test_period_summary_and_series_shape():
    place = m.summarize_place(_good_rows(48))
    assert place["hours_covered"] == pytest.approx(47 / 6, abs=0.01)
    assert place["days_covered"] == 1 and place["kst_dates"] == ["2026-09-21"]
    point = place["series"][0]
    assert set(point) >= {"bucket_at", "normalized_actual", "level_est", "actual_grade", "estimated_grade"}


def test_summarize_groups_by_place_name():
    rows = [_row(0, "보통", 1000, 0.3), _row(1, "보통", 1000, 0.3, area_cd=None)]
    rows.append(_row(0, "여유", 1000, 0.1, area_nm="연남동", area_cd="POI999"))
    places = m.summarize(rows)
    assert [place["area_nm"] for place in places] == ["홍대 관광특구", "연남동"]
    assert places[0]["row_count"] == 2


# --- 대상지별 주기(S2)와 지표의 가정 -------------------------------------------------


def test_twenty_minute_cadence_never_pairs_and_says_why():
    # 20분 주기: 버킷 0, 2, 4, … — t+30분(3버킷 뒤)은 늘 차례가 아니다. '쌓이면 판정' 이 아니라 '영원히 없음'.
    rows = [_row(i, "보통", 5000, 0.5) for i in range(0, 120, 2)]
    mae = _metric(m.summarize_place(rows), "forecast_mae_30m")
    assert mae["n"] == 0 and mae["status"] == m.STATUS_INSUFFICIENT
    assert "30분을 나누지 않으면" in mae["reason"]


def test_pairs_without_estimate_say_the_estimate_is_missing():
    rows = [_row(i, "보통", 5000, None) for i in range(10)]
    mae = _metric(m.summarize_place(rows), "forecast_mae_30m")
    assert mae["n"] == 0 and "추정값이 없다" in mae["reason"]


def test_thirty_minute_cadence_still_pairs():
    rows = [_row(i, "보통", 5000 + (i % 7) * 100, 0.5) for i in range(0, 150, 3)]
    mae = _metric(m.summarize_place(rows), "forecast_mae_30m")
    assert mae["raw_n"] == 49
    # 짝은 생긴다 — 판정을 막는 것은 '주기' 가 아니라 날짜 수(25시간 = KST 2일 → 홀드아웃 1일)다.
    assert "30분을 나누지 않으면" not in mae["reason"]
    assert "홀드아웃 날짜 1일" in mae["reason"]


def test_median_bucket_gap_follows_the_cadence_not_the_gaps():
    # 30분 주기 + 수집 누락 한 번(60분 간격) — 중앙값은 주기(30분)에 붙는다.
    rows = [_row(i, "보통", 5000, 0.5) for i in (0, 3, 6, 12, 15, 18)]
    assert m.summarize_place(rows)["median_bucket_gap_minutes"] == 30.0
    assert m.summarize_place([_row(0, "보통", 5000, 0.5)])["median_bucket_gap_minutes"] is None


# --- 지표 설계의 약점 보강(SEOUL_TESTBED_PLAN 부록 · S4) ------------------------------
#
# 여러 날짜가 필요한 판정이라 합성 표본을 날짜 단위로 만든다. 값은 seed 고정 난수라 실행마다 같다.
# 창 2026-10-12(월) ~ 는 공휴일이 없다 — 평일/주말 칸이 요일 그대로 갈린다.

_KST_TZ = timezone(timedelta(hours=9))
_START_KST = datetime(2026, 10, 12, 0, 0, tzinfo=_KST_TZ)


def _profile(hour: int) -> float:
    """시(hour) 안에서는 상수인 하루 모양 — 칸(한 시간) 평균이 모양을 정확히 지운다."""
    return 0.15 + 0.55 * max(0.0, math.sin(math.pi * (hour - 6) / 18)) if 6 <= hour else 0.15


def _multi_day_rows(days: int, est_fn, *, actual_fn=None, seed: int = 7, step_minutes: int = 10) -> list[dict]:
    """days 일 × (24h / step) 버킷. ctx: hour·day·index·weekend·profile·anomaly(날짜×3시간 고유)·actual·noise(±1, 추정용)."""
    rng_anomaly = random.Random(seed)
    rng_actual = random.Random(seed + 1)
    rng_est = random.Random(seed + 2)
    # 이상치는 날짜 × 3시간 블록마다 하나 — 30분 뒤가 같은 블록인 경우가 많아 지속형 추정이 의미를 가진다.
    anomaly = {(d, b): rng_anomaly.uniform(-0.15, 0.15) for d in range(days) for b in range(8)}
    rows = []
    per_day = 24 * 60 // step_minutes
    for day in range(days):
        for index in range(per_day):
            local = _START_KST + timedelta(days=day, minutes=step_minutes * index)
            weekend = local.weekday() >= 5
            ctx = SimpleNamespace(
                hour=local.hour, day=day, index=index, weekend=weekend,
                profile=_profile(local.hour), anomaly=anomaly[(day, local.hour // 3)],
            )
            if actual_fn is None:
                ctx.actual = ctx.profile + (0.1 if weekend else 0.0) + ctx.anomaly + rng_actual.uniform(-0.02, 0.02)
            else:
                ctx.actual = actual_fn(ctx)
            ctx.actual = min(1.0, max(0.02, ctx.actual))
            ctx.noise = rng_est.uniform(-1.0, 1.0)
            level = min(1.0, max(0.0, est_fn(ctx)))
            mid = round(ctx.actual * 10000)
            rows.append({
                "area_cd": "POI014",
                "area_nm": "홍대 관광특구",
                "bucket_at": local.astimezone(timezone.utc).isoformat(),
                "observed_at": local.astimezone(timezone.utc).isoformat(),
                "congest_lvl": m.GRADE_LABELS[min(3, int(ctx.actual * 4))],
                "ppltn_min": mid - 100,
                "ppltn_max": mid + 100,
                "fcst": [],
                "live_lot_count": 0,
                "parking_level": None,
                "tourism_level": level,
                "level_est": level,
                "estimator_version": "v1",
            })
    return rows


# 1) 순위 상관: 시간대 평균(다른 날)을 뺀 이상치 ρ


def test_hour_profile_only_estimator_has_high_rho_but_fails_on_anomaly():
    # 하루 모양만 아는 추정(+ 실측과 무관한 잡음). 전체 ρ 는 0.5 를 훌쩍 넘지만 '오늘이 평소보다' 는 모른다.
    place = m.summarize_place(_multi_day_rows(14, lambda ctx: ctx.profile + 0.05 * ctx.noise))
    spearman = _metric(place, "spearman")
    assert spearman["value"] >= 0.7
    assert spearman["anomaly_n"] >= m.MIN_SAMPLES and spearman["anomaly_dates"] == 14
    assert abs(spearman["anomaly_rho"]) < 0.05
    assert spearman["climatology_rho"] >= 0.9, "시간대 평균만으로도 순위가 거의 맞는다 — 그래서 기준선이 필요하다"
    assert spearman["status"] == m.STATUS_FAIL
    assert spearman["threshold"] == 0.50 and spearman["anomaly_threshold"] == m.SPEARMAN_ANOMALY_MIN_RHO
    assert spearman["baseline_label"] == "시간대 평균(다른 날)"


def test_estimator_that_tracks_day_specific_anomalies_passes():
    place = m.summarize_place(_multi_day_rows(14, lambda ctx: ctx.profile + ctx.anomaly + 0.02 * ctx.noise))
    spearman = _metric(place, "spearman")
    assert spearman["value"] >= 0.9
    assert spearman["anomaly_rho"] >= 0.6
    assert spearman["status"] == m.STATUS_PASS and spearman["reason"] is None


def test_too_few_dates_for_lodo_cells_is_insufficient_with_reason():
    # 3일이면 칸마다 다른 날짜가 2일뿐(최소 3일) — 이상치를 하나도 못 만든다.
    spearman = _metric(m.summarize_place(_multi_day_rows(3, lambda ctx: ctx.profile + ctx.anomaly)), "spearman")
    assert spearman["anomaly_n"] == 0 and spearman["anomaly_rho"] is None
    assert spearman["status"] == m.STATUS_INSUFFICIENT
    assert spearman["reason"] == "시간대 평균(다른 날)을 뺀 순위 상관을 계산할 표본이 부족하다"
    # 평일 4일: 이상치는 계산되지만 날짜가 5일 미만이라 판정하지 않는다.
    spearman = _metric(m.summarize_place(_multi_day_rows(4, lambda ctx: ctx.profile + ctx.anomaly)), "spearman")
    assert spearman["anomaly_n"] > m.MIN_SAMPLES and spearman["anomaly_dates"] == 4
    assert spearman["status"] == m.STATUS_INSUFFICIENT


def test_pure_time_of_day_estimator_is_a_fail_not_insufficient():
    # 잡음조차 없이 시각만으로 정해지는 추정(관광 신호만 있는 대상지가 이렇게 될 수 있다 — 홍대는 실시간 주차가 0곳).
    # 이상치가 전부 0 이라 ρ 는 정의되지 않지만, 이것은 '표본 부족' 이 아니라 '그날 고유의 정보가 없다' 다.
    spearman = _metric(m.summarize_place(_multi_day_rows(14, lambda ctx: 0.5 * ctx.profile)), "spearman")
    assert spearman["value"] >= 0.7
    assert spearman["anomaly_n"] >= m.MIN_SAMPLES and spearman["anomaly_rho"] is None
    assert spearman["anomaly_flat_estimate"] is True
    assert spearman["status"] == m.STATUS_FAIL
    assert spearman["reason"] == m.SPEARMAN_FLAT_ESTIMATE_REASON


def test_flat_actual_anomaly_stays_insufficient():
    # 반대로 실측이 늘 시간대 평균 그대로면(이상치가 없다) 추정을 탓할 수 없다 — 판정하지 않는다.
    rows = _multi_day_rows(14, lambda ctx: ctx.profile + 0.05 * ctx.noise, actual_fn=lambda ctx: ctx.profile)
    spearman = _metric(m.summarize_place(rows), "spearman")
    assert spearman["anomaly_flat_estimate"] is False and spearman["anomaly_rho"] is None
    assert spearman["status"] == m.STATUS_INSUFFICIENT


# 2) 30분 전망: 학습 날짜 사상 + 홀드아웃 vs 학습 날짜 시간대 평균


def _old_forecast_numbers(rows: list[dict]) -> tuple[float, float, int]:
    """S4 이전 정의를 그대로 다시 계산한다(전체 표본 · 추정 그대로 · 지속 모델)."""
    points, _ = m.build_points(rows)
    by_bucket = {p.bucket_at: p for p in points}
    ours, persistence = [], []
    for point in points:
        future = by_bucket.get(point.bucket_at + m.FORECAST_HORIZON)
        if future is None or future.normalized_actual is None or point.level_est is None or point.normalized_actual is None:
            continue
        ours.append(abs(point.level_est - future.normalized_actual))
        persistence.append(abs(point.normalized_actual - future.normalized_actual))
    return sum(ours) / len(ours), sum(persistence) / len(persistence), len(ours)


def test_scale_offset_with_good_order_now_passes_after_monotone_map():
    # 실측의 0.3배 + 0.1 — 순서는 지속 모델과 같지만 눈금이 다르다. 예전 정의는 눈금 차이만큼 벌을 줬다.
    rows = _multi_day_rows(14, lambda ctx: 0.1 + 0.3 * ctx.actual)
    mae = _metric(m.summarize_place(rows), "forecast_mae_30m")
    old_ours, old_persistence, old_n = _old_forecast_numbers(rows)
    assert mae["raw_mae"] == pytest.approx(round(old_ours, 4))
    assert mae["oracle_reference_mae"] == pytest.approx(round(old_persistence, 4))
    assert mae["raw_n"] == old_n
    assert old_ours > old_persistence, "예전 정의로는 미달이었다"
    assert mae["holdout_dates"] == 4 and mae["holdout_n"] == mae["n"] >= m.MIN_SAMPLES
    assert mae["threshold"] == pytest.approx(round(mae["baseline_mae"] * 0.95, 4), abs=1e-4)
    assert mae["value"] < 0.75 * mae["baseline_mae"]
    assert mae["status"] == m.STATUS_PASS and mae["reason"] is None


def test_hour_only_estimator_does_not_beat_train_date_climatology():
    # 시만 아는 추정 — 단조 사상을 거쳐도 평일/주말 차이와 그날의 이상치를 모른다.
    mae = _metric(m.summarize_place(_multi_day_rows(14, lambda ctx: 0.5 * ctx.profile)), "forecast_mae_30m")
    assert mae["holdout_n"] >= m.MIN_SAMPLES
    assert mae["value"] > mae["threshold"]
    assert mae["status"] == m.STATUS_FAIL


def test_fewer_than_three_holdout_dates_is_insufficient():
    # 8일 → 뒤쪽 1/3 = 2일(일·월 — 학습에 토요일이 있어 주말 칸도 채워진다). 표본은 넉넉하지만 날짜가 모자란다.
    mae = _metric(m.summarize_place(_multi_day_rows(8, lambda ctx: 0.1 + 0.3 * ctx.actual)), "forecast_mae_30m")
    assert mae["holdout_dates"] == 2 and mae["holdout_n"] >= m.MIN_SAMPLES
    assert mae["status"] == m.STATUS_INSUFFICIENT
    assert "홀드아웃 날짜 2일" in mae["reason"]


def test_holdout_split_is_the_calibration_rule():
    from app.services import congestion_calibration_service as cal

    dates = [f"2026-10-{day:02d}" for day in range(1, 11)]
    train, holdout = m._holdout_split(dates)
    pairs = [cal.Pair("p", T0, d, 0, False, 0.0, 0.0) for d in dates]
    cal_train, _cal_holdout, cal_holdout_dates = cal.split_by_date(pairs)
    assert holdout == cal_holdout_dates == dates[-3:]
    assert train == {pair.date_kst for pair in cal_train}
    assert m._holdout_split(["2026-10-01"]) is None


# 3) 등급: 우연 일치 · κ · 눈금을 뺀 일치율


def test_constant_modal_estimate_has_zero_kappa_and_does_not_pass():
    # 실측 70% 가 '보통' 인 곳에서 늘 '보통' 이라고 답한다. 예전에는 일치율 0.70 · ±1 일치율 0.95 로 둘 다 통과였다.
    labels = ["보통"] * 28 + ["여유"] * 6 + ["약간 붐빔"] * 4 + ["붐빔"] * 2
    place = m.summarize_place([_row(i, label, 5000, 0.3) for i, label in enumerate(labels)])
    exact = _metric(place, "grade_exact")
    within = _metric(place, "grade_within_one")
    assert exact["value"] == pytest.approx(0.70) and within["value"] == pytest.approx(0.95)
    assert exact["chance_agreement"] == pytest.approx(0.70)
    assert exact["cohen_kappa"] == pytest.approx(0.0)
    assert within["chance_within_one"] == pytest.approx(0.95)
    assert within["weighted_kappa_linear"] == pytest.approx(0.0, abs=1e-9)
    assert exact["status"] == m.STATUS_FAIL and within["status"] == m.STATUS_FAIL
    assert exact["kappa_threshold"] == within["kappa_threshold"] == m.MIN_KAPPA


def test_chance_and_kappa_hand_checked_on_a_small_matrix():
    # (실측, 추정) = (0,0) (0,1) (1,1) (1,1) (2,1) (3,3)
    actual = [0, 0, 1, 1, 2, 3]
    estimated = [0, 1, 1, 1, 1, 3]
    # 주변 분포 실측 [2,2,1,1]/6 · 추정 [1,4,0,1]/6 → 우연 일치 (2·1 + 2·4 + 0 + 1·1)/36 = 11/36
    assert m.chance_agreement(actual, estimated) == pytest.approx(11 / 36)
    # 관측 일치 4/6 → κ = (24/36 − 11/36) / (25/36) = 13/25
    assert m.cohen_kappa(actual, estimated) == pytest.approx(13 / 25)
    # ±1 이내 우연: Σ_{|i−j|≤1} pa_i·pe_j = (10 + 10 + 5 + 1)/36
    assert m.chance_agreement(actual, estimated, within=1) == pytest.approx(26 / 36)
    # 선형 가중(w = 1 − |i−j|/3): 관측 8/9, 기대 35/54 → κw = (8/9 − 35/54)/(1 − 35/54) = 13/19
    assert m.weighted_kappa_linear(actual, estimated) == pytest.approx(13 / 19)
    # 두 쪽 모두 한 등급뿐이면 우연 일치 = 1 → κ 는 정의되지 않는다(0 이 아니다).
    assert m.cohen_kappa([1, 1, 1], [1, 1, 1]) is None
    assert m.weighted_kappa_linear([1, 1, 1], [1, 1, 1]) is None
    assert m.cohen_kappa([], []) is None


def test_single_grade_everywhere_is_not_a_pass():
    # 실측도 추정도 늘 '보통' — 일치율 100% 지만 우연 일치를 뺄 수 없다(κ 정의 안 됨 → κ ≥ 0.20 을 못 넘는다).
    place = m.summarize_place([_row(i, "보통", 5000 + i, 0.3) for i in range(40)])
    exact = _metric(place, "grade_exact")
    within = _metric(place, "grade_within_one")
    assert exact["value"] == 1.0 and exact["cohen_kappa"] is None
    assert exact["status"] == m.STATUS_FAIL and "κ" in exact["reason"]
    assert within["weighted_kappa_linear"] is None and within["status"] == m.STATUS_FAIL
    # 표본이 모자라면 κ 와 무관하게 예전처럼 '표본 부족' 이다.
    thin = _metric(m.summarize_place([_row(i, "보통", 5000, 0.3) for i in range(10)]), "grade_exact")
    assert thin["status"] == m.STATUS_INSUFFICIENT and "36" in thin["reason"]


def test_good_estimator_kappa_passes_on_both_grade_metrics():
    place = m.summarize_place(_good_rows())
    assert _metric(place, "grade_exact")["cohen_kappa"] >= 0.6
    assert _metric(place, "grade_within_one")["weighted_kappa_linear"] >= 0.6


def test_rank_mapped_cut_points_depend_on_train_dates_only():
    rows = _multi_day_rows(14, lambda ctx: 0.5 * ctx.actual)  # 눈금이 반 — 고정 경계로는 등급이 낮게 나온다
    exact = _metric(m.summarize_place(rows), "grade_exact")
    assert exact["rank_mapped_holdout_days"] == 4 and exact["rank_mapped_n"] == 4 * 144
    assert exact["rank_mapped_value"] > exact["value"], "눈금을 빼면 순서 정보가 드러난다"
    assert len(exact["rank_mapped_cut_points"]) == 3
    assert exact["rank_mapped_target_distribution"] == exact["train_actual_distribution"]
    assert sum(exact["holdout_actual_distribution"]) == pytest.approx(1.0, abs=1e-3)

    holdout_dates = {"2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"}
    altered = []
    for row in rows:
        local = m.parse_time(row["bucket_at"]).astimezone(_KST_TZ).date().isoformat()
        if local in holdout_dates:
            row = {**row, "level_est": 0.99, "congest_lvl": "붐빔"}
        altered.append(row)
    moved = _metric(m.summarize_place(altered), "grade_exact")
    for key in ("rank_mapped_cut_points", "rank_mapped_target_distribution",
                "rank_mapped_achieved_distribution", "train_actual_distribution"):
        assert moved[key] == exact[key], key
    assert moved["holdout_actual_distribution"] == [0.0, 0.0, 0.0, 1.0]


def test_rank_mapped_ties_report_achieved_versus_target_distribution():
    # 학습 날짜의 추정이 전부 0.5(동률) — 실측은 여유·보통 반반. '≤' 규칙이라 동률 전부가 아래 등급으로 간다.
    rows = _multi_day_rows(3, lambda ctx: 0.5, actual_fn=lambda ctx: 0.1 if ctx.index % 2 else 0.3)
    exact = _metric(m.summarize_place(rows), "grade_exact")
    assert exact["rank_mapped_target_distribution"] == [0.5, 0.5, 0.0, 0.0]
    assert exact["rank_mapped_achieved_distribution"] == [1.0, 0.0, 0.0, 0.0]
    assert exact["rank_mapped_cut_points"] == [0.5, 0.5, 0.5]
    assert exact["rank_mapped_value"] == pytest.approx(0.5)


def test_rank_mapped_fields_are_none_when_dates_cannot_be_split():
    exact = _metric(m.summarize_place(_good_rows()), "grade_exact")  # 하루치
    assert exact["rank_mapped_value"] is None and exact["rank_mapped_cut_points"] is None
    assert exact["rank_mapped_n"] == 0 and exact["rank_mapped_holdout_days"] == 0


# 계약: 지표 키는 늘지 않고, 옛 필드는 같은 타입으로 남는다(test_engine_validation_admin 의 정확한 키 집합)


_OLD_FIELDS = {
    "key": str, "label": str, "n": int, "min_n": int, "direction": str, "unit": str,
    "status": str, "definition": str,
}


@pytest.mark.parametrize("days", [0, 1, 14])
def test_metric_key_set_and_old_field_types_are_unchanged(days):
    rows = _multi_day_rows(days, lambda ctx: ctx.profile + ctx.anomaly) if days != 1 else _good_rows()
    place = m.summarize_place(rows)
    assert [metric["key"] for metric in place["metrics"]] == [
        "grade_exact", "grade_within_one", "spearman", "danger_misclassification",
        "forecast_mae_30m", "seoul_forecast_mae_30m", "coverage",
    ]
    for metric in place["metrics"]:
        for field, kind in _OLD_FIELDS.items():
            assert isinstance(metric[field], kind), (metric["key"], field)
        assert metric["value"] is None or isinstance(metric["value"], float | int)
        assert metric["threshold"] is None or isinstance(metric["threshold"], float | int)
        assert metric["reason"] is None or isinstance(metric["reason"], str)
    mae = _metric(place, "forecast_mae_30m")
    assert mae["baseline_mae"] is None or isinstance(mae["baseline_mae"], float)
    assert isinstance(mae["baseline_label"], str)
    assert _metric(place, "danger_misclassification")["missed"] >= 0
    assert _metric(place, "seoul_forecast_mae_30m")["ours_mae_same_sample"] is None
    assert isinstance(_metric(place, "coverage")["covered"], int)


def test_summary_is_deterministic():
    rows = _multi_day_rows(10, lambda ctx: ctx.profile + 0.5 * ctx.anomaly + 0.05 * ctx.noise)
    assert m.summarize_place(rows) == m.summarize_place(list(reversed(rows)))


# S4 검토: 이상치 칸은 10분, 통과에는 날짜 잭나이프 하한 > 0 이 함께 필요하다.


def _smooth_points(days: int, *, seed: int, est_fn, actual_fn) -> list[m.Point]:
    """10분 버킷 Point 직접 생성. est_fn·actual_fn(minute_of_day, day, state) → 값."""
    rng = random.Random(seed)
    state = SimpleNamespace(a=0.0, b=0.0, shift=0.0, rng=rng)
    start = datetime(2026, 10, 5, tzinfo=_KST_TZ)  # 월요일 — 창 안에 공휴일(10-05 대체공휴일)이 있어도 칸만 갈린다
    points = []
    for k in range(days * 144):
        when = start + timedelta(minutes=10 * k)
        if k % 144 == 0:
            state.shift = rng.gauss(0, 0.1)
        state.a = 0.95 * state.a + rng.gauss(0, 0.03)
        state.b = 0.95 * state.b + rng.gauss(0, 0.03)
        minute = when.hour * 60 + when.minute
        est = min(1.0, max(0.0, est_fn(minute, state)))
        act = min(1.0, max(0.0, actual_fn(minute, state)))
        points.append(m.Point(
            bucket_at=when, observed_at=when, congest_lvl=None, actual_grade=None, ppltn_min=None, ppltn_max=None,
            midpoint=None, normalized_actual=act, level_est=est, estimated_grade=None,
            parking_level=None, tourism_level=None, fcst=None,
        ))
    return points


def _diurnal(minute: int) -> float:
    return 0.5 + 0.45 * math.sin((minute - 540) / 1440 * 2 * math.pi)


def test_minute_of_day_shape_without_day_information_does_not_pass():
    """한 시간 칸이면 한 시간 안의 오르내림이 양쪽 이상치에 남아 ρ≈0.25 로 통과했다 — 10분 칸은 모양을 지운다."""
    points = _smooth_points(
        14, seed=1,
        est_fn=lambda minute, _s: round(_diurnal(minute), 6),
        actual_fn=lambda minute, s: 0.25 + 0.6 * _diurnal(minute) + s.shift + s.rng.gauss(0, 0.04),
    )
    spearman = m.spearman_metric(points)

    assert spearman["value"] >= 0.5
    assert spearman["anomaly_slot_minutes"] == 10
    assert spearman["status"] == m.STATUS_FAIL
    assert spearman["anomaly_flat_estimate"] is True


def test_anomaly_rho_above_the_fixed_margin_but_not_beyond_day_noise_fails():
    """추정 잡음이 실측과 무관한 AR(1)이면 10분 버킷이 강하게 붙어 있어 ρ ≥ 0.10 이 우연히 나온다 — 잭나이프 하한이 거른다."""

    def shape(minute: int) -> float:
        return 0.2 + 0.6 * math.exp(-(((minute / 60) - 14) / 4) ** 2)

    points = _smooth_points(14, seed=1, est_fn=lambda mi, s: shape(mi) + s.b, actual_fn=lambda mi, s: shape(mi) + s.a)
    spearman = m.spearman_metric(points)

    assert spearman["anomaly_rho"] >= m.SPEARMAN_ANOMALY_MIN_RHO, "옛 규칙(고정 여유 0.10)이면 통과했다"
    assert spearman["anomaly_rho_ci_low"] <= 0
    assert spearman["status"] == m.STATUS_FAIL
    assert spearman["reason"] == m.SPEARMAN_ANOMALY_CI_REASON
    assert spearman["anomaly_ci_method"] == m.SPEARMAN_ANOMALY_CI_METHOD

    tracked = _smooth_points(
        14, seed=1, est_fn=lambda mi, s: shape(mi) + 0.5 * s.a + s.b, actual_fn=lambda mi, s: shape(mi) + s.a
    )
    good = m.spearman_metric(tracked)
    assert good["status"] == m.STATUS_PASS and good["anomaly_rho_ci_low"] > 0


def test_student_t_quantiles():
    assert m.student_t_975(1) == pytest.approx(12.7062)
    assert m.student_t_975(13) == pytest.approx(2.1604)
    assert m.student_t_975(30) == pytest.approx(2.0423)
    assert m.student_t_975(40) == pytest.approx(2.0211, abs=1e-4)
    assert m.student_t_975(120) == pytest.approx(1.9799, abs=1e-4)
    with pytest.raises(ValueError):
        m.student_t_975(0)
