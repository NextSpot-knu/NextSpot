"""혼잡 추정기 **서울 검증 지표** — 순수 함수만 둔다(DB·네트워크 없음).

`docs/CONGESTION_ENGINE_PLAN.md` §6 의 표를 대상지 1곳(홍대 관광특구, §4 반영 2026-09-20)에 맞춰 옮겼다.
입력은 `seoul_citydata_snapshots` 행(10분 버킷)이고, 각 행에 서울시 실측(`congest_lvl`·`ppltn_min/max`·
`fcst`)과 같은 버킷에서 돌린 우리 추정(`level_est`)이 함께 있다(§5.3-3 — 정답과 같은 행에 둔다).

## 정답과 추정을 같은 눈금에 놓는 법

- 실측 등급: 서울시 4등급 문자열 → 여유 0 · 보통 1 · 약간 붐빔 2 · 붐빔 3.
- 추정 등급: `level_est`(0~1)를 저장소의 혼잡 경계(75 = 혼잡, 마이그레이션 20260908090000)로 자른다 —
  < 0.25 → 0 · < 0.50 → 1 · < 0.75 → 2 · ≥ 0.75 → 3.
- 정규화 실측: 인구 범위 중앙값 (min+max)/2 를 **그 대상지의 창 안 최대 중앙값**으로 나눈 0~1.
  서울 인구는 인원수이고 우리 추정은 상대 수준이라 그대로 비교할 수 없다. 최대 대비로 눌러야 같은 축에 선다.
  창 안 최대를 쓰므로 창을 바꾸면 값이 조금 바뀐다 — 보고용 정규화이고 학습 정답이 아니다.

## 지표는 감추지 않는다

§6 "통과 못 하면 통과 못 한 대로 대시보드에 남긴다". 그래서 모든 지표는 값·표본 수·기준·판정을 **항상**
돌려준다. 판정은 네 가지다:

    pass          기준 통과
    fail          기준 미달 — 그대로 보여 준다
    insufficient  표본이 최소치에 못 미쳐 판정하지 않는다(값은 계산되면 같이 준다 — 숨기지 않는다)
    report        기준이 없는 보고용 지표(커버리지·서울시 예측 대비)

"구분 가능률"(인접 대상지 3곳 등급 비교)은 대상지가 1곳이라 **정의상 계산할 수 없다** — 0 이나 빈칸으로
두지 않고 `omitted` 에 이유와 함께 명시한다(§4 반영 4).
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

GRADE_LABELS: tuple[str, ...] = ("여유", "보통", "약간 붐빔", "붐빔")
_GRADE_INDEX = {label: index for index, label in enumerate(GRADE_LABELS)}
DANGER_GRADE = 3  # 붐빔
SAFE_GRADES = (0, 1)  # 여유·보통 — 붐빔을 여기로 보이면 위험 오분류다

# 추정 등급 경계. 저장소 혼잡 경계(0.75 = 혼잡)와 같은 간격이다.
ESTIMATE_GRADE_EDGES: tuple[float, float, float] = (0.25, 0.50, 0.75)

# 판정 최소 표본(10분 버킷 36개 = 6시간). 이보다 적으면 한 시간대의 우연이 비율을 좌우한다.
MIN_SAMPLES = 36
# 위험 오분류는 분모가 '실측 붐빔' 버킷뿐이라 드물다. 36을 요구하면 한 달 내내 판정이 안 날 수 있어
# 12(= 붐빔 2시간)로 따로 둔다. 이 크기에서는 한 번만 놓쳐도 8%라 5% 기준을 넘는다 — 관대한 기준이 아니다.
MIN_DANGER_SAMPLES = 12

FORECAST_HORIZON = timedelta(minutes=30)
# 서울시 FCST_PPLTN 은 정시 간격이라 t+30분과 정확히 맞는 항목이 없을 수 있다. 가장 가까운 항목을
# 쓰되 이 거리 안에서만 인정한다(보고용 비교라 허용폭을 적어 둔다).
SEOUL_FORECAST_TOLERANCE = timedelta(minutes=30)

THRESHOLDS: dict[str, float] = {
    "grade_exact": 0.50,
    "grade_within_one": 0.85,
    "spearman": 0.50,
    "danger_misclassification": 0.05,
}

_KST = timezone(timedelta(hours=9))

STATUS_PASS = "pass"
STATUS_FAIL = "fail"
STATUS_INSUFFICIENT = "insufficient"
STATUS_REPORT = "report"

OMITTED_METRICS: tuple[dict[str, str], ...] = (
    {
        "key": "distinguishability",
        "label": "구분 가능률",
        "reason": (
            "인접 대상지 3곳의 등급이 모두 같지 않은 비율이라 대상지가 3곳 이상 있어야 정의된다. "
            "검증 대상지가 홍대 관광특구 1곳뿐이라 계산하지 않는다(CONGESTION_ENGINE_PLAN §4 반영 4)."
        ),
    },
)


# ---------------------------------------------------------------------------
# 값 변환
# ---------------------------------------------------------------------------


def actual_grade(congest_lvl: Any) -> int | None:
    """서울시 등급 문자열 → 0~3. 모르는 값은 None(지어내지 않는다). 공백 차이는 흡수한다."""
    if not isinstance(congest_lvl, str):
        return None
    text = " ".join(congest_lvl.split())
    if text in _GRADE_INDEX:
        return _GRADE_INDEX[text]
    compact = text.replace(" ", "")
    for label, index in _GRADE_INDEX.items():
        if label.replace(" ", "") == compact:
            return index
    return None


def estimated_grade(level: float | None) -> int | None:
    """추정 수준(0~1) → 0~3. None·NaN 은 None."""
    if level is None or not math.isfinite(level):
        return None
    for index, edge in enumerate(ESTIMATE_GRADE_EDGES):
        if level < edge:
            return index
    return len(ESTIMATE_GRADE_EDGES)


def _to_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(str(value).replace(",", "")) if isinstance(value, str) else float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def population_midpoint(ppltn_min: Any, ppltn_max: Any) -> float | None:
    """인구 범위 중앙값. 한쪽만 있으면 그 값, 둘 다 없으면 None."""
    low = _to_float(ppltn_min)
    high = _to_float(ppltn_max)
    if low is None and high is None:
        return None
    if low is None:
        return high
    if high is None:
        return low
    return (low + high) / 2.0


def parse_time(value: Any) -> datetime | None:
    """ISO 문자열/datetime → tz-aware. 시간대가 없으면 KST 로 본다(서울시 FCST_TIME 이 'YYYY-MM-DD HH:MM')."""
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        text = value.strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
    else:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=_KST)


def _iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if value is not None else None


# ---------------------------------------------------------------------------
# 통계
# ---------------------------------------------------------------------------


def average_ranks(values: list[float]) -> list[float]:
    """동률은 평균 순위(1부터). Spearman 의 표준 처리."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    start = 0
    while start < len(order):
        end = start
        while end + 1 < len(order) and values[order[end + 1]] == values[order[start]]:
            end += 1
        rank = (start + end) / 2.0 + 1.0
        for position in range(start, end + 1):
            ranks[order[position]] = rank
        start = end + 1
    return ranks


def pearson(xs: list[float], ys: list[float]) -> float | None:
    """피어슨 상관. 어느 한쪽이 상수면 정의되지 않으므로 None."""
    n = len(xs)
    if n < 2 or n != len(ys):
        return None
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    sxx = sum((x - mean_x) ** 2 for x in xs)
    syy = sum((y - mean_y) ** 2 for y in ys)
    if sxx <= 0 or syy <= 0:
        return None
    sxy = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    return sxy / math.sqrt(sxx * syy)


def spearman_rho(xs: list[float], ys: list[float]) -> float | None:
    """Spearman ρ = 평균 순위에 대한 피어슨 상관(동률 보정 포함)."""
    if len(xs) != len(ys) or len(xs) < 2:
        return None
    return pearson(average_ranks(xs), average_ranks(ys))


# ---------------------------------------------------------------------------
# 지표 결과
# ---------------------------------------------------------------------------


def _metric(
    key: str,
    *,
    label: str,
    value: float | None,
    n: int,
    min_n: int,
    threshold: float | None,
    direction: str,
    unit: str,
    definition: str,
    reason: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """지표 한 개. direction: 'gte'(이상이면 통과) · 'lte'(이하) · 'report'(기준 없음)."""
    if direction == "report":
        status = STATUS_REPORT
    elif n < min_n or value is None:
        status = STATUS_INSUFFICIENT
        if reason is None:
            reason = f"표본 {n}개 — 최소 {min_n}개가 쌓여야 판정한다" if n < min_n else "값을 계산할 수 없다"
    elif direction == "gte":
        status = STATUS_PASS if value >= threshold else STATUS_FAIL  # type: ignore[operator]
    else:
        status = STATUS_PASS if value <= threshold else STATUS_FAIL  # type: ignore[operator]
    result: dict[str, Any] = {
        "key": key,
        "label": label,
        "value": None if value is None else round(value, 4),
        "n": n,
        "min_n": min_n,
        "threshold": threshold,
        "direction": direction,
        "unit": unit,
        "status": status,
        "definition": definition,
        "reason": reason,
    }
    if extra:
        result.update(extra)
    return result


@dataclass(frozen=True)
class Point:
    """한 버킷의 실측·추정 쌍."""

    bucket_at: datetime
    observed_at: datetime | None
    congest_lvl: str | None
    actual_grade: int | None
    ppltn_min: float | None
    ppltn_max: float | None
    midpoint: float | None
    normalized_actual: float | None
    level_est: float | None
    estimated_grade: int | None
    parking_level: float | None
    tourism_level: float | None
    fcst: Any


def _dedupe_by_bucket(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """같은 버킷이 두 번 들어왔으면 가장 늦게 받은 행을 쓴다(재수집·재시도 대비)."""
    chosen: dict[datetime, tuple[datetime, dict[str, Any]]] = {}
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    for row in rows:
        bucket = parse_time(row.get("bucket_at"))
        if bucket is None:
            continue
        stamp = parse_time(row.get("fetched_at")) or parse_time(row.get("observed_at")) or epoch
        current = chosen.get(bucket)
        if current is None or stamp >= current[0]:
            chosen[bucket] = (stamp, row)
    return [chosen[bucket][1] for bucket in sorted(chosen)]


def build_points(rows: list[dict[str, Any]]) -> tuple[list[Point], dict[str, Any]]:
    """행 → 버킷 순서의 Point 목록 + 정규화 근거(최대 중앙값과 그 시각)."""
    deduped = _dedupe_by_bucket(rows)
    midpoints = [population_midpoint(row.get("ppltn_min"), row.get("ppltn_max")) for row in deduped]
    max_mid: float | None = None
    max_at: datetime | None = None
    for row, mid in zip(deduped, midpoints):
        if mid is not None and (max_mid is None or mid > max_mid):
            max_mid = mid
            max_at = parse_time(row.get("bucket_at"))
    points: list[Point] = []
    for row, mid in zip(deduped, midpoints):
        normalized = mid / max_mid if mid is not None and max_mid and max_mid > 0 else None
        level = _to_float(row.get("level_est"))
        if level is not None:
            level = min(1.0, max(0.0, level))
        points.append(
            Point(
                bucket_at=parse_time(row.get("bucket_at")),  # type: ignore[arg-type]
                observed_at=parse_time(row.get("observed_at")),
                congest_lvl=row.get("congest_lvl") if isinstance(row.get("congest_lvl"), str) else None,
                actual_grade=actual_grade(row.get("congest_lvl")),
                ppltn_min=_to_float(row.get("ppltn_min")),
                ppltn_max=_to_float(row.get("ppltn_max")),
                midpoint=mid,
                normalized_actual=normalized,
                level_est=level,
                estimated_grade=estimated_grade(level),
                parking_level=_to_float(row.get("parking_level")),
                tourism_level=_to_float(row.get("tourism_level")),
                fcst=row.get("fcst"),
            )
        )
    normalization = {
        "method": "midpoint_over_window_max",
        "max_midpoint": max_mid,
        "max_midpoint_bucket_at": _iso(max_at),
    }
    return points, normalization


def _forecast_entries(fcst: Any) -> list[dict[str, Any]]:
    """fcst JSONB → 항목 목록. 리스트가 정상 형태이고, {'FCST_PPLTN': [...]} 로 감싼 형태도 받는다."""
    if isinstance(fcst, dict):
        fcst = fcst.get("FCST_PPLTN") or fcst.get("fcst_ppltn")
    if not isinstance(fcst, list):
        return []
    return [entry for entry in fcst if isinstance(entry, dict)]


def seoul_forecast_midpoint(fcst: Any, target: datetime) -> float | None:
    """서울시 자체 예측에서 target 에 가장 가까운 항목의 인구 중앙값(허용폭 밖이면 None)."""
    best: tuple[timedelta, float] | None = None
    for entry in _forecast_entries(fcst):
        when = parse_time(entry.get("FCST_TIME"))
        mid = population_midpoint(entry.get("FCST_PPLTN_MIN"), entry.get("FCST_PPLTN_MAX"))
        if when is None or mid is None:
            continue
        gap = abs(when - target)
        if gap > SEOUL_FORECAST_TOLERANCE:
            continue
        if best is None or gap < best[0]:
            best = (gap, mid)
    return best[1] if best else None


# ---------------------------------------------------------------------------
# 지표 계산
# ---------------------------------------------------------------------------


def grade_metrics(points: list[Point]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """등급 일치율 · ±1 일치율 · 위험 오분류율."""
    paired = [(p.actual_grade, p.estimated_grade) for p in points if p.actual_grade is not None and p.estimated_grade is not None]
    n = len(paired)
    exact = sum(1 for a, e in paired if a == e)
    within = sum(1 for a, e in paired if abs(a - e) <= 1)
    danger = [e for a, e in paired if a == DANGER_GRADE]
    missed = sum(1 for e in danger if e in SAFE_GRADES)
    exact_metric = _metric(
        "grade_exact",
        label="등급 일치율",
        value=exact / n if n else None,
        n=n,
        min_n=MIN_SAMPLES,
        threshold=THRESHOLDS["grade_exact"],
        direction="gte",
        unit="ratio",
        definition="서울시 4등급과 추정 등급(0.25·0.50·0.75 경계)이 정확히 같은 버킷 비율",
    )
    within_metric = _metric(
        "grade_within_one",
        label="인접 등급 일치율",
        value=within / n if n else None,
        n=n,
        min_n=MIN_SAMPLES,
        threshold=THRESHOLDS["grade_within_one"],
        direction="gte",
        unit="ratio",
        definition="추정 등급이 실측 등급과 ±1등급 이내인 버킷 비율",
    )
    danger_metric = _metric(
        "danger_misclassification",
        label="위험 오분류율",
        value=missed / len(danger) if danger else None,
        n=len(danger),
        min_n=MIN_DANGER_SAMPLES,
        threshold=THRESHOLDS["danger_misclassification"],
        direction="lte",
        unit="ratio",
        definition="실측 '붐빔' 버킷 가운데 추정이 '여유'·'보통'으로 보인 비율",
        reason=None if danger else "실측 '붐빔' 버킷이 아직 없다 — 분모가 0이라 판정하지 않는다",
        extra={"missed": missed},
    )
    return exact_metric, within_metric, danger_metric


def spearman_metric(points: list[Point]) -> dict[str, Any]:
    """한 대상지의 **시간 흐름**에 대한 순위 상관(§4 반영 4 — 대상지 간 비교가 아니다)."""
    paired = [(p.level_est, p.normalized_actual) for p in points if p.level_est is not None and p.normalized_actual is not None]
    n = len(paired)
    rho = spearman_rho([x for x, _ in paired], [y for _, y in paired]) if n >= 2 else None
    reason = None
    if n >= MIN_SAMPLES and rho is None:
        reason = "한쪽 값이 창 안에서 변하지 않아 순위 상관이 정의되지 않는다"
    return _metric(
        "spearman",
        label="순위 상관 (Spearman ρ)",
        value=rho,
        n=n,
        min_n=MIN_SAMPLES,
        threshold=THRESHOLDS["spearman"],
        direction="gte",
        unit="rho",
        definition="시간 순 버킷에서 추정 수준과 정규화 실측 인구의 Spearman 순위 상관(동률은 평균 순위)",
        reason=reason,
    )


def forecast_metrics(points: list[Point], normalization: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """30분 전망 MAE(우리 vs 지속 모델) + 서울시 FCST_PPLTN 대비(보고용).

    우리 추정기는 Δ≤30분이면 현재값을 그대로 도착 시점 값으로 쓴다(§5.1). 그래서 t 의 level_est 가
    곧 t+30 예측이다. 지속 모델은 t 의 정규화 실측을 그대로 t+30 예측으로 쓴다. 두 모델을 **같은 표본**
    (t 의 추정·t 의 실측·t+30 의 실측이 모두 있는 버킷)에서 비교해야 공정하다.
    """
    by_bucket = {p.bucket_at: p for p in points}
    ours_errors: list[float] = []
    persistence_errors: list[float] = []
    seoul_ours: list[float] = []
    seoul_errors: list[float] = []
    max_mid = normalization.get("max_midpoint")
    for point in points:
        future = by_bucket.get(point.bucket_at + FORECAST_HORIZON)
        if future is None or future.normalized_actual is None:
            continue
        if point.level_est is None or point.normalized_actual is None:
            continue
        ours = abs(point.level_est - future.normalized_actual)
        ours_errors.append(ours)
        persistence_errors.append(abs(point.normalized_actual - future.normalized_actual))
        if max_mid:
            seoul_mid = seoul_forecast_midpoint(point.fcst, future.bucket_at)
            if seoul_mid is not None:
                seoul_errors.append(abs(seoul_mid / max_mid - future.normalized_actual))
                seoul_ours.append(ours)
    n = len(ours_errors)
    ours_mae = sum(ours_errors) / n if n else None
    persistence_mae = sum(persistence_errors) / n if n else None
    # 통과 기준은 '지속 모델보다 낮을 것'. _metric 의 lte 판정에 지속 모델 MAE 를 기준값으로 넘기되,
    # 같으면 이긴 것이 아니므로 아래에서 엄격 비교로 다시 판정한다.
    mae_metric = _metric(
        "forecast_mae_30m",
        label="30분 전망 오차 (MAE)",
        value=ours_mae,
        n=n,
        min_n=MIN_SAMPLES,
        threshold=None if persistence_mae is None else round(persistence_mae, 4),
        direction="lte",
        unit="mae",
        definition=(
            "t 의 추정을 t+30분 예측으로 보고 t+30분 정규화 실측과의 평균 절대 오차. "
            "기준선 = 지속 모델(t 의 정규화 실측을 그대로 유지). 지속 모델보다 낮아야 통과"
        ),
        extra={"baseline_label": "지속 모델", "baseline_mae": None if persistence_mae is None else round(persistence_mae, 4)},
    )
    if mae_metric["status"] in (STATUS_PASS, STATUS_FAIL):
        mae_metric["status"] = STATUS_PASS if ours_mae < persistence_mae else STATUS_FAIL  # type: ignore[operator]
    seoul_n = len(seoul_errors)
    seoul_mae = sum(seoul_errors) / seoul_n if seoul_n else None
    seoul_metric = _metric(
        "seoul_forecast_mae_30m",
        label="서울시 자체 예측 대비 (보고용)",
        value=seoul_mae,
        n=seoul_n,
        min_n=MIN_SAMPLES,
        threshold=None,
        direction="report",
        unit="mae",
        definition=(
            "서울시 FCST_PPLTN 중 t+30분에 가장 가까운 항목(±30분 이내)의 인구 중앙값을 같은 최대값으로 "
            "정규화해 t+30분 실측과 비교한 MAE. 서울시 예측은 정시 간격이라 시계가 정확히 30분이 아닐 수 있다"
        ),
        reason=None if seoul_n else "서울시 예측(fcst)에서 t+30분 ±30분 이내 항목을 찾지 못했다",
        extra={
            "ours_mae_same_sample": round(sum(seoul_ours) / seoul_n, 4) if seoul_n else None,
        },
    )
    return mae_metric, seoul_metric


def coverage_metric(points: list[Point]) -> dict[str, Any]:
    """추정을 만들 수 있던 버킷 비율(보고용). 분모는 수집된 버킷 전부."""
    n = len(points)
    covered = sum(1 for p in points if p.level_est is not None)
    return _metric(
        "coverage",
        label="커버리지",
        value=covered / n if n else None,
        n=n,
        min_n=0,
        threshold=None,
        direction="report",
        unit="ratio",
        definition="수집된 버킷 가운데 추정(level_est)을 만들 수 있던 비율 — 주차·관광 신호가 모두 없으면 추정하지 않는다",
        extra={"covered": covered},
    )


def confusion_matrix(points: list[Point]) -> dict[str, Any]:
    """행 = 실측 등급, 열 = 추정 등급. 합계와 함께."""
    counts: Counter[tuple[int, int]] = Counter(
        (p.actual_grade, p.estimated_grade)
        for p in points
        if p.actual_grade is not None and p.estimated_grade is not None
    )
    size = len(GRADE_LABELS)
    matrix = [[counts.get((a, e), 0) for e in range(size)] for a in range(size)]
    return {"labels": list(GRADE_LABELS), "matrix": matrix, "total": sum(counts.values())}


def _series(points: list[Point]) -> list[dict[str, Any]]:
    return [
        {
            "bucket_at": _iso(p.bucket_at),
            "normalized_actual": None if p.normalized_actual is None else round(p.normalized_actual, 4),
            "level_est": None if p.level_est is None else round(p.level_est, 4),
            "actual_grade": p.actual_grade,
            "estimated_grade": p.estimated_grade,
            "congest_lvl": p.congest_lvl,
            "ppltn_min": p.ppltn_min,
            "ppltn_max": p.ppltn_max,
            "parking_level": p.parking_level,
            "tourism_level": p.tourism_level,
        }
        for p in points
    ]


def _latest_version_rows(rows: list[dict[str, Any]]) -> tuple[str | None, list[dict[str, Any]], int]:
    """가장 최근 버킷의 estimator_version 행만 남긴다.

    산식이 바뀌면 버전을 올린다(마이그레이션 주석) — 옛 산식의 추정과 새 산식의 추정을 한 비율에
    섞으면 어느 산식의 성적인지 말할 수 없다. 버려진 행 수는 응답에 남겨 숨기지 않는다.
    """
    dated = [(parse_time(row.get("bucket_at")), row) for row in rows]
    dated = [(when, row) for when, row in dated if when is not None]
    if not dated:
        return None, [], len(rows)
    latest_row = max(dated, key=lambda item: item[0])[1]
    version = latest_row.get("estimator_version")
    kept = [row for _, row in dated if row.get("estimator_version") == version]
    return (str(version) if version is not None else None), kept, len(rows) - len(kept)


def summarize_place(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """한 대상지의 행 → 지표·혼동표·시계열·기간 요약(최신 추정기 버전 행만)."""
    all_versions = sorted({str(row["estimator_version"]) for row in rows if row.get("estimator_version")})
    version, rows, excluded = _latest_version_rows(rows)
    points, normalization = build_points(rows)
    first = points[0].bucket_at if points else None
    last = points[-1].bucket_at if points else None
    observed = [p.observed_at for p in points if p.observed_at is not None]
    exact, within, danger = grade_metrics(points)
    mae, seoul = forecast_metrics(points, normalization)
    metrics = [exact, within, spearman_metric(points), danger, mae, seoul, coverage_metric(points)]
    sample = rows[-1] if rows else {}
    days = sorted({p.bucket_at.astimezone(_KST).date().isoformat() for p in points})
    judged = [m for m in metrics if m["direction"] != "report"]
    return {
        "area_cd": sample.get("area_cd"),
        "area_nm": sample.get("area_nm"),
        "row_count": len(rows),
        "bucket_count": len(points),
        "first_bucket_at": _iso(first),
        "last_bucket_at": _iso(last),
        "first_observed_at": _iso(min(observed)) if observed else None,
        "last_observed_at": _iso(max(observed)) if observed else None,
        "hours_covered": round((last - first).total_seconds() / 3600.0, 2) if first and last else 0.0,
        "days_covered": len(days),
        "kst_dates": days,
        "estimator_version": version,
        "estimator_versions_in_window": all_versions,
        "excluded_other_version_rows": excluded,
        "latest_live_lot_count": sample.get("live_lot_count"),
        "zero_live_lot_buckets": sum(1 for row in rows if row.get("live_lot_count") == 0),
        "sufficient": any(m["status"] != STATUS_INSUFFICIENT for m in judged),
        "normalization": normalization,
        "metrics": metrics,
        "omitted_metrics": list(OMITTED_METRICS),
        "confusion": confusion_matrix(points),
        "series": _series(points),
    }


def place_key(row: dict[str, Any]) -> str:
    """대상지 식별. 테이블 유니크 키가 (area_nm, bucket_at)이고 area_cd 는 비어 올 수 있어 이름이 먼저다."""
    return str(row.get("area_nm") or row.get("area_cd") or "unknown")


def summarize(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """전체 행 → 대상지별 요약(행이 많은 대상지 먼저)."""
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(place_key(row), []).append(row)
    places = [summarize_place(group) for group in groups.values()]
    places.sort(key=lambda place: (-place["row_count"], str(place.get("area_nm") or "")))
    return places
