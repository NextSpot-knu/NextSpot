"""서울 검증 지표(CONGESTION_ENGINE_PLAN §6) — 정의·경계·표본 부족·실패 노출을 잠근다."""

from datetime import datetime, timedelta, timezone

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
    assert spearman["status"] == m.STATUS_PASS and spearman["value"] > 0.9


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


def test_forecast_mae_compares_against_persistence_on_same_sample():
    # 실측이 30분마다 크게 튀는데 추정은 평균에 머문다 → 지속 모델이 더 나쁘다.
    rows = []
    for i in range(60):
        mid = 10000 if (i // 3) % 2 == 0 else 2000
        rows.append(_row(i, "보통", mid, 0.6))
    mae = _metric(m.summarize_place(rows), "forecast_mae_30m")
    # t 와 t+30 은 3버킷 차 → 실측은 항상 반대편: 지속 모델 오차 = 0.8
    assert mae["baseline_mae"] == pytest.approx(0.8)
    assert mae["value"] == pytest.approx(0.4)
    assert mae["n"] == 57
    assert mae["status"] == m.STATUS_PASS


def test_forecast_mae_ties_do_not_count_as_beating_persistence():
    rows = [_row(i, "보통", 5000, 1.0) for i in range(50)]  # 정규화 실측이 늘 1.0 — 둘 다 오차 0
    mae = _metric(m.summarize_place(rows), "forecast_mae_30m")
    assert mae["value"] == 0.0 and mae["baseline_mae"] == 0.0
    assert mae["status"] == m.STATUS_FAIL


def test_forecast_skips_pairs_with_missing_future_bucket():
    rows = [_row(i, "보통", 5000, 0.5) for i in (0, 1, 2, 4)]  # t=0 → t+30 = 3 이 없다
    mae = _metric(m.summarize_place(rows), "forecast_mae_30m")
    assert mae["n"] == 1  # 1 → 4 만 짝이 된다


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
