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

## 지표 설계의 약점 보강 (SEOUL_TESTBED_PLAN 부록 · S4)

지표 키는 늘리지 않았다 — 기존 지표에 필드를 **덧붙이고** 판정만 엄격하게 했다. 시간대 평균(climatology)은
`kst_calendar` 의 정의 하나만 쓴다((KST 칸, 평일/주말) — 공휴일은 주말로 센다. 칸은 #1 만 10분, 나머지는 한 시간).

1. **순위 상관에 기준선이 없었다.** 하루 모양(낮에 붐비고 새벽에 한산)만 따라 그리는 추정기도 ρ ≥ 0.5 를
   넘는다 — 그건 "시계를 볼 줄 안다" 이지 "오늘이 평소보다 붐빈다를 안다" 가 아니다. 그래서 추정과 실측
   양쪽에서 **그 날을 뺀 다른 날들의 같은 칸 평균**(LODO, 칸마다 다른 날짜 3일 이상)을 빼고 남은 이상치끼리의
   ρ(`anomaly_rho`)를 함께 계산한다. 칸은 **(KST 10분 칸, 평일/주말)** — 데이터의 버킷 폭이다. 한 시간 칸이면
   한 시간 안의 오르내림이 양쪽 이상치에 남아 "분 단위 하루 모양" 만 아는 추정도 이상치 ρ 를 얻는다(S4 검토).
   통과 = ρ ≥ 0.50 **이고** 이상치 ρ ≥ 0.10 **이고** 이상치 ρ 의 날짜 잭나이프 95% 하한
   (`anomaly_rho_ci_low` = ρ − t(0.975, 날짜−1) × SE, 날짜 하나씩 빼고 다시 잰 ρ 로 SE)이 0 보다 클 것,
   이상치 표본 36개 · 날짜 5일 이상. 10분 버킷은 서로 강하게 붙어 있어 표본 수로 잰 우연 범위가 너무 좁다 —
   날짜를 단위로 잰 하한이 그 자기상관을 흡수한다(0.10 은 크기 기준일 뿐 유의 기준이 아니다).
   이상치를 계산할 표본이 모자라면 판정하지 않는다. LODO 는 뒤 날짜까지 쓰므로 그 시점에 가질 수 있던 것보다
   강한 기준이다(보수적 시험). `climatology_rho` 는 "시간대 평균만으로" 얻는 ρ 라 비교 기준으로 같이 싣는다.
2. **지속 모델을 기준선으로 썼다.** t 의 **실측**을 t+30 예측으로 쓰는 지속 모델은 추정기가 가질 수 없는 정보
   (지금 이 순간의 정답)를 쓰는 오라클이다. 또 우리 추정은 0~1 상대 수준이라 눈금이 실측 정규화와 달라, 순서가
   맞아도 MAE 가 눈금 차이만큼 벌을 받았다. 이제 KST 날짜 뒤쪽 1/3 을 홀드아웃으로 두고(보정 관문의
   `split_by_date` 와 같은 규칙), 학습 날짜로만 적합한 단조 사상(PAVA)을 거친 추정의 홀드아웃 MAE 를
   **학습 날짜 시간대 평균**(추정기가 가질 수 있는 정보)의 MAE 와 같은 점에서 비교한다. 통과 = 홀드아웃 36개 ·
   3일 이상이고 보정 MAE ≤ 0.95 × 시간대 평균 MAE. 옛 값은 `raw_mae`(전체 표본, 보고용)로, 지속 모델은
   `oracle_reference_mae`(참고 — 추정기는 쓸 수 없는 정보)로 남긴다.
3. **등급 일치율이 우연 일치를 빼지 않았다.** 실측이 늘 '보통' 인 곳에서 늘 '보통' 이라고 답하면 일치율이
   높다. 그래서 우연 일치(`chance_agreement`·`chance_within_one`)와 κ(정확 일치는 Cohen κ, ±1 일치는 선형 가중
   κ)를 싣고, 통과는 비율 기준 **과** κ ≥ 0.20 을 함께 요구한다. 눈금 문제(0.25 간격 경계가 서울 4등급 분포와
   다르다)는 판정에 넣지 않고 `rank_mapped_*` 로 보여 준다 — 학습 날짜에서 실측 등급 분포를 재현하는 분위 경계로
   추정을 등급화해 홀드아웃에서 잰 일치율이다(보고 전용).
4. 보정 관문의 순위 정보 문제는 `congestion_calibration_service.rank_gate` 가 맡는다(보고 전용).
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from app.services.kst_calendar import climatology, kst_date

GRADE_LABELS: tuple[str, ...] = ("여유", "보통", "약간 붐빔", "붐빔")
_GRADE_INDEX = {label: index for index, label in enumerate(GRADE_LABELS)}
DANGER_GRADE = 3  # 붐빔
SAFE_GRADES = (0, 1)  # 여유·보통 — 붐빔을 여기로 보이면 위험 오분류다

# 추정 등급 경계. 저장소 혼잡 경계(0.75 = 혼잡)와 같은 간격이다.
ESTIMATE_GRADE_EDGES: tuple[float, float, float] = (0.25, 0.50, 0.75)

# 판정 최소 표본 — **버킷 수**다(10분 주기면 36개 = 6시간). 이보다 적으면 한 시간대의 우연이 비율을 좌우한다.
# 대상지별 주기(S2)가 들어온 뒤로 36개가 덮는 시간은 주기마다 다르다(20분 = 12시간 · 30분 = 18시간). 개수 기준을
# 그대로 두는 이유: 성긴 주기의 버킷끼리는 덜 붙어 있어 표본 하나의 정보가 줄지 않는다. 대신 대상지 요약에
# 실제 간격(`median_bucket_gap_minutes`)을 실어 화면이 '36개 = 몇 시간' 을 사실대로 말하게 한다.
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

# 약점 보강 기준(SEOUL_TESTBED_PLAN 부록 · S4) — 모두 [제안] 값이다(Q-S4-10).
# 1) 순위 상관: 시간대 평균(다른 날)을 뺀 이상치 ρ 의 고정 여유, 판정에 필요한 날짜 수, LODO 칸의 최소 다른 날짜 수.
SPEARMAN_ANOMALY_MIN_RHO = 0.10
SPEARMAN_ANOMALY_MIN_DATES = 5
LODO_MIN_OTHER_DATES = 3
# 이상치 칸 폭(분) — 서울 시민데이터 버킷 폭. 30분 주기 대상지도 버킷 시각은 10분 격자 위에 있다.
SPEARMAN_ANOMALY_SLOT_MINUTES = 10
SPEARMAN_ANOMALY_CI_METHOD = "날짜 잭나이프 · t(0.975, 날짜−1)"
SPEARMAN_BASELINE_LABEL = "시간대 평균(다른 날)"
# 2) 30분 전망: 보정 MAE 가 학습 날짜 시간대 평균 MAE 의 95% 이하, 홀드아웃 날짜 3일 이상.
FORECAST_CLIMATOLOGY_MARGIN = 0.95
FORECAST_MIN_HOLDOUT_DATES = 3
FORECAST_BASELINE_LABEL = "시간대 평균(학습 날짜)"
FORECAST_ORACLE_LABEL = "실측 지속 — 참고: 추정기는 쓸 수 없는 정보"
# 3) 등급: κ 최소치(정확 일치는 Cohen κ, ±1 일치는 선형 가중 κ).
MIN_KAPPA = 0.20

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


# 양측 95% Student t 임계값(0.975 분위). df 1~30 은 표, 그 위는 Cornish-Fisher 전개(df ≥ 31 에서 소수 4자리까지 같다).
_T975_TABLE: tuple[float, ...] = (
    12.7062, 4.3027, 3.1824, 2.7764, 2.5706, 2.4469, 2.3646, 2.3060, 2.2622, 2.2281,
    2.2010, 2.1788, 2.1604, 2.1448, 2.1314, 2.1199, 2.1098, 2.1009, 2.0930, 2.0860,
    2.0796, 2.0739, 2.0687, 2.0639, 2.0595, 2.0555, 2.0518, 2.0484, 2.0452, 2.0423,
)
_Z975 = 1.959963984540054


def student_t_975(df: int) -> float:
    """Student t 분포의 0.975 분위(양측 95% 구간 반폭 계수). 표준 라이브러리만 쓴다."""
    if df < 1:
        raise ValueError(f"자유도는 1 이상: {df}")
    if df <= len(_T975_TABLE):
        return _T975_TABLE[df - 1]
    z = _Z975
    g1 = (z ** 3 + z) / 4
    g2 = (5 * z ** 5 + 16 * z ** 3 + 3 * z) / 96
    g3 = (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / 384
    return z + g1 / df + g2 / df ** 2 + g3 / df ** 3


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


_GRADE_COUNT = len(GRADE_LABELS)


def grade_distribution(grades: list[int]) -> list[float] | None:
    """등급(0~3) 목록 → 등급별 비율 4칸. 빈 목록이면 None."""
    if not grades:
        return None
    counts = Counter(grades)
    return [counts.get(grade, 0) / len(grades) for grade in range(_GRADE_COUNT)]


def _round_list(values: list[float] | None) -> list[float] | None:
    return None if values is None else [round(value, 4) for value in values]


def chance_agreement(actual: list[int], estimated: list[int], *, within: int = 0) -> float | None:
    """두 등급 열의 주변 분포만으로 기대되는 일치 확률. ``within=1`` 이면 ±1 이내를 일치로 센다."""
    pa = grade_distribution(actual)
    pe = grade_distribution(estimated)
    if pa is None or pe is None or len(actual) != len(estimated):
        return None
    return sum(
        pa[i] * pe[j]
        for i in range(_GRADE_COUNT)
        for j in range(_GRADE_COUNT)
        if abs(i - j) <= within
    )


def cohen_kappa(actual: list[int], estimated: list[int]) -> float | None:
    """Cohen κ(가중 없음) = (관측 일치 − 우연 일치) / (1 − 우연 일치). 우연 일치가 1이면(두 쪽 모두 한 등급뿐) None."""
    n = len(actual)
    if n == 0 or n != len(estimated):
        return None
    observed = sum(1 for a, e in zip(actual, estimated) if a == e) / n
    expected = chance_agreement(actual, estimated)
    if expected is None or expected >= 1.0 - 1e-12:
        return None
    return (observed - expected) / (1.0 - expected)


def weighted_kappa_linear(actual: list[int], estimated: list[int]) -> float | None:
    """선형 가중 κ. 일치 가중치 w(i,j) = 1 − |i−j|/3 — 한 등급 차이는 2/3 만큼, 세 등급 차이는 0 으로 친다."""
    n = len(actual)
    if n == 0 or n != len(estimated):
        return None
    span = float(_GRADE_COUNT - 1)

    def weight(i: int, j: int) -> float:
        return 1.0 - abs(i - j) / span

    observed = sum(weight(a, e) for a, e in zip(actual, estimated)) / n
    pa = grade_distribution(actual)
    pe = grade_distribution(estimated)
    expected = sum(pa[i] * pe[j] * weight(i, j) for i in range(_GRADE_COUNT) for j in range(_GRADE_COUNT))  # type: ignore[index]
    if expected >= 1.0 - 1e-12:
        return None
    return (observed - expected) / (1.0 - expected)


def _holdout_split(dates: list[str]) -> tuple[set[str], list[str]] | None:
    """KST 날짜(ISO) → (학습 날짜, 홀드아웃 날짜). 규칙은 보정 관문의 ``split_by_date`` **그 자체**다.

    같은 규칙을 두 곳에 따로 쓰면 언젠가 갈라진다. 그래서 날짜마다 대표 쌍 하나를 만들어 그 함수에 넘긴다.
    보정 모듈이 이 모듈을 모듈 수준에서 import 하므로 여기서는 함수 안에서 import 한다(순환 방지).
    가를 수 없으면(날짜 2개 미만) None.
    """
    from app.services.congestion_calibration_service import Pair, split_by_date

    stamp = datetime(2000, 1, 1, tzinfo=timezone.utc)
    marker = [
        Pair(area_nm="", bucket_at=stamp, date_kst=day, hour_kst=0, weekend=False, x=0.0, y=0.0)
        for day in sorted(set(dates))
    ]
    train, _holdout, holdout_dates = split_by_date(marker)
    if not train or not holdout_dates:
        return None
    return {pair.date_kst for pair in train}, list(holdout_dates)


def _rank_mapped_cut_points(train_levels: list[float], train_actual: list[int]) -> list[float | None]:
    """학습 날짜의 추정 수준을 정렬해, 실측 등급 누적 개수 자리에서 자른다. 경계값과 같으면 아래 등급(≤).

    컷 k 는 "등급 ≤ k" 의 상한이다. 누적 개수가 0 이면 그 등급 이하로 갈 점이 없어 None(−∞ 로 읽는다).
    동률이 있으면 ≤ 규칙 때문에 재현한 분포가 목표와 달라질 수 있다 — 두 분포를 같이 보고한다.
    """
    ordered = sorted(train_levels)
    counts = Counter(train_actual)
    cuts: list[float | None] = []
    cumulative = 0
    for grade in range(_GRADE_COUNT - 1):
        cumulative += counts.get(grade, 0)
        cuts.append(ordered[cumulative - 1] if cumulative >= 1 else None)
    return cuts


def _apply_cut_points(level: float, cuts: list[float | None]) -> int:
    for grade, cut in enumerate(cuts):
        if cut is not None and level <= cut:
            return grade
    return len(cuts)


_RANK_MAPPED_EMPTY: dict[str, Any] = {
    "rank_mapped_value": None,
    "rank_mapped_chance": None,
    "rank_mapped_n": 0,
    "rank_mapped_holdout_days": 0,
    "rank_mapped_cut_points": None,
    "rank_mapped_target_distribution": None,
    "rank_mapped_achieved_distribution": None,
    "train_actual_distribution": None,
    "holdout_actual_distribution": None,
}


def rank_mapped_grades(points: list[Point]) -> dict[str, Any]:
    """눈금을 뺀 등급 일치율(보고 전용) — 학습 날짜 분위 경계로 등급화해 홀드아웃에서 잰다.

    경계는 **학습 날짜만**으로 정한다(홀드아웃 값을 바꿔도 움직이지 않는다). 홀드아웃 날짜의 분포가 학습과 다르면
    그대로 드러나도록 두 날짜 묶음의 실측 등급 분포를 함께 싣는다. 계산할 수 없으면 값 필드는 None.
    """
    paired = [p for p in points if p.actual_grade is not None and p.level_est is not None]
    split = _holdout_split([kst_date(p.bucket_at).isoformat() for p in paired])
    if split is None:
        return dict(_RANK_MAPPED_EMPTY)
    train_dates, holdout_dates = split
    holdout_set = set(holdout_dates)
    train = [p for p in paired if kst_date(p.bucket_at).isoformat() in train_dates]
    holdout = [p for p in paired if kst_date(p.bucket_at).isoformat() in holdout_set]
    train_actual = [p.actual_grade for p in train]  # type: ignore[misc]
    cuts = _rank_mapped_cut_points([p.level_est for p in train], train_actual)  # type: ignore[misc]
    achieved = [_apply_cut_points(p.level_est, cuts) for p in train]  # type: ignore[arg-type]
    holdout_actual = [p.actual_grade for p in holdout]  # type: ignore[misc]
    holdout_mapped = [_apply_cut_points(p.level_est, cuts) for p in holdout]  # type: ignore[arg-type]
    agree = sum(1 for a, e in zip(holdout_actual, holdout_mapped) if a == e)
    chance = chance_agreement(holdout_actual, holdout_mapped)  # type: ignore[arg-type]
    return {
        "rank_mapped_value": round(agree / len(holdout), 4) if holdout else None,
        "rank_mapped_chance": None if chance is None else round(chance, 4),
        "rank_mapped_n": len(holdout),
        "rank_mapped_holdout_days": len(holdout_dates),
        "rank_mapped_cut_points": [None if cut is None else round(cut, 4) for cut in cuts],
        "rank_mapped_target_distribution": _round_list(grade_distribution(train_actual)),  # type: ignore[arg-type]
        "rank_mapped_achieved_distribution": _round_list(grade_distribution(achieved)),
        "train_actual_distribution": _round_list(grade_distribution(train_actual)),  # type: ignore[arg-type]
        "holdout_actual_distribution": _round_list(grade_distribution(holdout_actual)),  # type: ignore[arg-type]
    }


_KAPPA_UNDEFINED_REASON = (
    "실측·추정 등급이 모두 한 가지뿐이라 우연 일치를 뺀 κ 가 정의되지 않는다 — 우연 이상으로 맞혔다는 근거가 없어 통과로 치지 않는다"
)


def _gate_on_kappa(metric: dict[str, Any], kappa: float | None) -> dict[str, Any]:
    """비율 판정 위에 κ ≥ MIN_KAPPA 를 더 건다. 표본 부족은 그대로 둔다.

    κ 가 정의되지 않으면(두 쪽 모두 한 등급뿐 — 우연 일치 = 1) 'κ ≥ 0.20' 을 만족하지 못한 것으로 보고 미달이다.
    표본은 이미 최소치를 넘었으므로 '쌓이면 판정' 이 아니라 '우연 이상의 근거가 없다' 가 맞는 말이다.
    """
    if metric["status"] not in (STATUS_PASS, STATUS_FAIL):
        return metric
    if kappa is None:
        metric["status"] = STATUS_FAIL
        metric["reason"] = _KAPPA_UNDEFINED_REASON
        return metric
    value_ok = metric["status"] == STATUS_PASS
    metric["status"] = STATUS_PASS if value_ok and kappa >= MIN_KAPPA else STATUS_FAIL
    return metric


def grade_metrics(points: list[Point]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """등급 일치율 · ±1 일치율 · 위험 오분류율. 앞의 둘은 우연 일치를 뺀 κ 도 함께 통과해야 한다."""
    paired = [(p.actual_grade, p.estimated_grade) for p in points if p.actual_grade is not None and p.estimated_grade is not None]
    n = len(paired)
    exact = sum(1 for a, e in paired if a == e)
    within = sum(1 for a, e in paired if abs(a - e) <= 1)
    danger = [e for a, e in paired if a == DANGER_GRADE]
    missed = sum(1 for e in danger if e in SAFE_GRADES)
    actual_list = [a for a, _ in paired]
    estimated_list = [e for _, e in paired]
    chance_exact = chance_agreement(actual_list, estimated_list)  # type: ignore[arg-type]
    chance_within = chance_agreement(actual_list, estimated_list, within=1)  # type: ignore[arg-type]
    kappa = cohen_kappa(actual_list, estimated_list)  # type: ignore[arg-type]
    kappa_linear = weighted_kappa_linear(actual_list, estimated_list)  # type: ignore[arg-type]
    exact_metric = _metric(
        "grade_exact",
        label="등급 일치율",
        value=exact / n if n else None,
        n=n,
        min_n=MIN_SAMPLES,
        threshold=THRESHOLDS["grade_exact"],
        direction="gte",
        unit="ratio",
        definition=(
            "서울시 4등급과 추정 등급(0.25·0.50·0.75 경계)이 정확히 같은 버킷 비율. "
            f"우연 일치(두 등급 분포만으로 기대되는 일치)를 뺀 Cohen κ 가 {MIN_KAPPA:.2f} 이상이어야 통과. "
            "rank_mapped_* 는 학습 날짜의 실측 등급 분포를 재현하는 분위 경계로 등급화해 홀드아웃 날짜에서 잰 일치율(보고 전용)"
        ),
        extra={
            "chance_agreement": None if chance_exact is None else round(chance_exact, 4),
            "cohen_kappa": None if kappa is None else round(kappa, 4),
            "kappa_threshold": MIN_KAPPA,
            **rank_mapped_grades(points),
        },
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
        definition=(
            "추정 등급이 실측 등급과 ±1등급 이내인 버킷 비율. "
            f"우연히 ±1 이내일 확률을 뺀 선형 가중 κ 가 {MIN_KAPPA:.2f} 이상이어야 통과"
        ),
        extra={
            "chance_within_one": None if chance_within is None else round(chance_within, 4),
            "weighted_kappa_linear": None if kappa_linear is None else round(kappa_linear, 4),
            "kappa_threshold": MIN_KAPPA,
        },
    )
    _gate_on_kappa(exact_metric, kappa)
    _gate_on_kappa(within_metric, kappa_linear)
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


# 이상치 계산에서 부동소수 찌꺼기(평균을 빼고 남은 1e-17 같은 값)가 순위를 만들지 않게 자르는 자릿수.
_ANOMALY_DIGITS = 9

SPEARMAN_ANOMALY_REASON = "시간대 평균(다른 날)을 뺀 순위 상관을 계산할 표본이 부족하다"
SPEARMAN_ANOMALY_CI_REASON = (
    "시간대 평균(다른 날)을 뺀 순위 상관의 날짜 잭나이프 95% 하한이 0 이하다 — 날마다 다른 우연과 구별되지 않는다"
)
SPEARMAN_FLAT_ESTIMATE_REASON = (
    "추정에서 시간대 평균(다른 날)을 빼면 남는 것이 없다 — 추정이 시각·평일/주말만으로 정해져 그날 고유의 변화를 담지 않는다"
)


def _day_jackknife(est: list[float], actual: list[float], day_of_point: list[str], rho: float | None) -> tuple[float | None, float | None]:
    """이상치 ρ 의 날짜 잭나이프 (SE, 95% 하한). 날짜가 2일 미만이거나 빼고 잰 ρ 가 정의되지 않으면 (None, None)."""
    if rho is None:
        return None, None
    days = sorted(set(day_of_point))
    if len(days) < 2:
        return None, None
    leave_out: list[float] = []
    for day in days:
        keep = [i for i, d in enumerate(day_of_point) if d != day]
        if len(keep) < 2:
            return None, None
        value = spearman_rho([est[i] for i in keep], [actual[i] for i in keep])
        if value is None:
            return None, None
        leave_out.append(value)
    count = len(leave_out)
    mean = math.fsum(leave_out) / count
    se = math.sqrt((count - 1) / count * math.fsum((v - mean) ** 2 for v in leave_out))
    return se, rho - student_t_975(count - 1) * se


def anomaly_spearman(points: list[Point]) -> tuple[dict[str, Any], float | None, float | None]:
    """시간대 평균(LODO — 그 날을 뺀 다른 날들의 같은 칸 평균)을 양쪽에서 뺀 이상치끼리의 순위 상관.

    칸 = (KST 10분 칸, 평일/주말 — 공휴일은 주말). 칸마다 다른 날짜가 ``LODO_MIN_OTHER_DATES`` 일 이상 있어야 그 점을
    쓴다. ``climatology_rho`` 는 같은 점에서 "시간대 평균만으로" 얻는 ρ(실측 시간대 평균 vs 실측)다.
    ``anomaly_rho_ci_low`` 는 날짜 잭나이프 95% 하한이다(모듈 독스트링 "약점 보강" 1).
    돌려주는 값: (응답에 덧붙일 필드, 반올림 전 이상치 ρ, 반올림 전 잭나이프 하한 — 둘 다 판정용). 추정 쪽 이상치가 전부 같으면(추정이 칸 평균과
    같다 — 시각·평일/주말만으로 정해지는 추정) anomaly_flat_estimate 가 참이다. 이때 ρ 는 정의되지 않지만
    '표본 부족' 이 아니라 '그날 고유의 정보가 없다' 이므로 판정은 미달이다.
    """
    paired = [p for p in points if p.level_est is not None and p.normalized_actual is not None]
    common: dict[str, Any] = {
        "time": lambda p: p.bucket_at,
        "mode": "lodo",
        "min_samples": 1,
        "min_dates": LODO_MIN_OTHER_DATES,
        "slot_minutes": SPEARMAN_ANOMALY_SLOT_MINUTES,
    }
    clim_est = climatology(paired, value=lambda p: p.level_est, **common)
    clim_actual = climatology(paired, value=lambda p: p.normalized_actual, **common)
    est_anomaly: list[float] = []
    actual_anomaly: list[float] = []
    baseline: list[float] = []
    actual: list[float] = []
    day_of_point: list[str] = []
    for point in paired:
        base_est = clim_est(point)
        base_actual = clim_actual(point)
        if base_est is None or base_actual is None:
            continue
        est_anomaly.append(round(point.level_est - base_est, _ANOMALY_DIGITS))  # type: ignore[operator]
        actual_anomaly.append(round(point.normalized_actual - base_actual, _ANOMALY_DIGITS))  # type: ignore[operator]
        baseline.append(base_actual)
        actual.append(point.normalized_actual)  # type: ignore[arg-type]
        day_of_point.append(kst_date(point.bucket_at).isoformat())
    anomaly_rho = spearman_rho(est_anomaly, actual_anomaly) if len(est_anomaly) >= 2 else None
    climatology_rho = spearman_rho(baseline, actual) if len(baseline) >= 2 else None
    anomaly_se, anomaly_ci_low = _day_jackknife(est_anomaly, actual_anomaly, day_of_point, anomaly_rho)
    fields = {
        "anomaly_rho": None if anomaly_rho is None else round(anomaly_rho, 4),
        "anomaly_rho_se": None if anomaly_se is None else round(anomaly_se, 4),
        "anomaly_rho_ci_low": None if anomaly_ci_low is None else round(anomaly_ci_low, 4),
        "anomaly_ci_method": SPEARMAN_ANOMALY_CI_METHOD,
        "anomaly_slot_minutes": SPEARMAN_ANOMALY_SLOT_MINUTES,
        "anomaly_n": len(est_anomaly),
        "anomaly_dates": len(set(day_of_point)),
        "climatology_rho": None if climatology_rho is None else round(climatology_rho, 4),
        "baseline_label": SPEARMAN_BASELINE_LABEL,
        "anomaly_threshold": SPEARMAN_ANOMALY_MIN_RHO,
        "anomaly_min_dates": SPEARMAN_ANOMALY_MIN_DATES,
        "anomaly_flat_estimate": len(est_anomaly) >= 2 and len(set(est_anomaly)) == 1,
    }
    return fields, anomaly_rho, anomaly_ci_low


def spearman_metric(points: list[Point]) -> dict[str, Any]:
    """한 대상지의 **시간 흐름**에 대한 순위 상관(§4 반영 4 — 대상지 간 비교가 아니다).

    `value` 는 예전 그대로 전체 표본의 ρ 다. 통과는 시간대 평균(다른 날)을 뺀 이상치 ρ 도 함께 넘어야 한다
    (모듈 독스트링 "약점 보강" 1).
    """
    paired = [(p.level_est, p.normalized_actual) for p in points if p.level_est is not None and p.normalized_actual is not None]
    n = len(paired)
    rho = spearman_rho([x for x, _ in paired], [y for _, y in paired]) if n >= 2 else None
    reason = None
    if n >= MIN_SAMPLES and rho is None:
        reason = "한쪽 값이 창 안에서 변하지 않아 순위 상관이 정의되지 않는다"
    anomaly, anomaly_rho, anomaly_ci_low = anomaly_spearman(points)
    metric = _metric(
        "spearman",
        label="순위 상관 (Spearman ρ)",
        value=rho,
        n=n,
        min_n=MIN_SAMPLES,
        threshold=THRESHOLDS["spearman"],
        direction="gte",
        unit="rho",
        definition=(
            "시간 순 버킷에서 추정 수준과 정규화 실측 인구의 Spearman 순위 상관(동률은 평균 순위). "
            f"통과하려면 양쪽에서 시간대 평균(그 날을 뺀 다른 날들의 같은 {SPEARMAN_ANOMALY_SLOT_MINUTES}분 칸·평일/주말 평균, "
            f"다른 날 {LODO_MIN_OTHER_DATES}일 이상)을 뺀 이상치끼리의 ρ 도 {SPEARMAN_ANOMALY_MIN_RHO:.2f} 이상이고, "
            "그 ρ 의 날짜 잭나이프 95% 하한이 0 보다 커야 한다"
            f"(이상치 표본 {MIN_SAMPLES}개 · {SPEARMAN_ANOMALY_MIN_DATES}일 이상). 하루 모양만 따라 그리는 추정을 거르는 기준이다"
        ),
        reason=reason,
        extra=anomaly,
    )
    if metric["status"] in (STATUS_PASS, STATUS_FAIL):
        enough = anomaly["anomaly_n"] >= MIN_SAMPLES and anomaly["anomaly_dates"] >= SPEARMAN_ANOMALY_MIN_DATES
        if enough and anomaly["anomaly_flat_estimate"]:
            metric["status"] = STATUS_FAIL
            metric["reason"] = SPEARMAN_FLAT_ESTIMATE_REASON
        elif not enough or anomaly_rho is None or anomaly_ci_low is None:
            metric["status"] = STATUS_INSUFFICIENT
            metric["reason"] = SPEARMAN_ANOMALY_REASON
        else:
            sized = rho >= THRESHOLDS["spearman"] and anomaly_rho >= SPEARMAN_ANOMALY_MIN_RHO  # type: ignore[operator]
            passed = sized and anomaly_ci_low > 0
            metric["status"] = STATUS_PASS if passed else STATUS_FAIL
            if sized and not passed:
                metric["reason"] = SPEARMAN_ANOMALY_CI_REASON
    return metric


def calibrated_forecast(points: list[Point], pairs: list[tuple[Point, Point]]) -> dict[str, Any]:
    """홀드아웃 날짜에서 '학습 날짜 단조 사상(PAVA)을 거친 추정' 과 '학습 날짜 시간대 평균' 의 30분 전망 MAE.

    ``pairs`` 는 (t 의 점, t+30 의 점) — 둘 다 값이 있는 것만 들어온다. 날짜는 **목표 시각(t+30)의 KST 날짜**로
    가른다: 학습 쪽 정답(t+30 실측)이 홀드아웃 날짜에 하나도 없게 하려는 것이다. 규칙은 보정 관문의
    ``split_by_date`` 그대로다(뒤쪽 1/3 날짜, 최소 1일). 시간대 평균은 학습 날짜의 정규화 실측 **모든 점**으로
    만든다(추정기가 가질 수 있던 정보 — 짝이 안 된 점도 쓴다). 같은 칸에 학습 표본이 없는 홀드아웃 점은 두 모델
    모두에서 뺀다(같은 점에서 비교).
    """
    from app.services.congestion_calibration_service import Pair, apply_curve, fit_curve, split_by_date

    empty: dict[str, Any] = {
        "ours_mae": None, "baseline_mae": None, "holdout_n": 0, "holdout_dates": 0, "split": False,
    }
    if not pairs:
        return empty
    as_pairs = [
        Pair(
            area_nm="",
            bucket_at=future.bucket_at,
            date_kst=kst_date(future.bucket_at).isoformat(),
            hour_kst=0,
            weekend=False,
            x=point.level_est,  # type: ignore[arg-type]
            y=future.normalized_actual,  # type: ignore[arg-type]
        )
        for point, future in pairs
    ]
    train, holdout, _holdout_dates = split_by_date(as_pairs)
    if not train or not holdout:
        return empty
    curve = fit_curve(train, fitted_at="")
    train_dates = sorted({pair.date_kst for pair in train})
    clim = climatology(
        [p for p in points if p.normalized_actual is not None],
        value=lambda p: p.normalized_actual,
        time=lambda p: p.bucket_at,
        mode="train_dates",
        train_dates=train_dates,
        min_samples=1,
    )
    ours_errors: list[float] = []
    baseline_errors: list[float] = []
    dates: set[str] = set()
    for pair in holdout:
        base = clim.value_at(pair.bucket_at)
        mapped = apply_curve(curve.knots, pair.x) if curve is not None else None
        if base is None or mapped is None:
            continue
        ours_errors.append(abs(mapped - pair.y))
        baseline_errors.append(abs(base - pair.y))
        dates.add(pair.date_kst)
    n = len(ours_errors)
    return {
        "ours_mae": sum(ours_errors) / n if n else None,
        "baseline_mae": sum(baseline_errors) / n if n else None,
        "holdout_n": n,
        "holdout_dates": len(dates),
        "split": True,
    }


def forecast_metrics(points: list[Point], normalization: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """30분 전망 MAE(학습 날짜 사상 + 홀드아웃 vs 학습 날짜 시간대 평균) + 서울시 FCST_PPLTN 대비(보고용).

    우리 추정기는 Δ≤30분이면 현재값을 그대로 도착 시점 값으로 쓴다(§5.1). 그래서 t 의 level_est 가
    곧 t+30 예측이다. 짝은 t 의 추정·t 의 실측·t+30 의 실측이 모두 있는 버킷이다.

    판정(모듈 독스트링 "약점 보강" 2): 지속 모델(t 의 실측 유지)은 추정기가 쓸 수 없는 정보를 쓰는 오라클이라
    기준선에서 내리고 참고값(`oracle_reference_mae`)으로만 남긴다. 판정 값은 학습 날짜로 적합한 단조 사상을 거친
    추정의 홀드아웃 MAE, 기준은 학습 날짜 시간대 평균 MAE 의 95% 다. 옛 값(눈금 차이까지 벌받는 전체 표본 MAE)은
    `raw_mae` 로 남긴다.
    """
    by_bucket = {p.bucket_at: p for p in points}
    ours_errors: list[float] = []
    persistence_errors: list[float] = []
    seoul_ours: list[float] = []
    seoul_errors: list[float] = []
    pairs: list[tuple[Point, Point]] = []
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
        pairs.append((point, future))
        if max_mid:
            seoul_mid = seoul_forecast_midpoint(point.fcst, future.bucket_at)
            if seoul_mid is not None:
                seoul_errors.append(abs(seoul_mid / max_mid - future.normalized_actual))
                seoul_ours.append(ours)
    n = len(ours_errors)
    raw_mae = sum(ours_errors) / n if n else None
    persistence_mae = sum(persistence_errors) / n if n else None
    judged = calibrated_forecast(points, pairs)
    ours_mae = judged["ours_mae"]
    baseline_mae = judged["baseline_mae"]
    holdout_n = judged["holdout_n"]
    holdout_dates = judged["holdout_dates"]
    # 짝이 하나도 없을 때 '표본 0개 — 쌓이면 판정' 이라고만 쓰면 기다리면 될 것처럼 읽힌다. 주기가 30분을
    # 나누지 않으면(예: 20분 — t 와 t+30 이 서로 다른 차례) **영원히** 짝이 생기지 않으므로 이유를 가른다.
    mae_reason = None
    if n == 0 and points:
        has_partner = any(point.bucket_at + FORECAST_HORIZON in by_bucket for point in points)
        if not has_partner:
            mae_reason = (
                "t+30분 버킷이 한 번도 없다 — 이 대상지의 수집 주기가 30분을 나누지 않으면(예: 20분) "
                "짝이 생기지 않아 이 지표는 판정할 수 없다"
            )
        else:
            mae_reason = "t 와 t+30분 실측 짝은 있지만 그 시각의 추정값이 없다 — 실시간 주차 신호가 없는 대상지다"
    elif n and not judged["split"]:
        mae_reason = "짝이 있는 날짜가 하루뿐이라 학습 날짜와 홀드아웃 날짜로 가를 수 없다"
    elif n and holdout_dates < FORECAST_MIN_HOLDOUT_DATES:
        mae_reason = (
            f"홀드아웃 날짜 {holdout_dates}일 — 최소 {FORECAST_MIN_HOLDOUT_DATES}일이 필요하다"
            f"(뒤쪽 1/3 날짜가 홀드아웃이라 짝이 있는 날짜가 {FORECAST_MIN_HOLDOUT_DATES * 3}일 이상 쌓여야 한다)"
        )
    elif n and holdout_n < MIN_SAMPLES:
        mae_reason = f"홀드아웃 표본 {holdout_n}개 — 최소 {MIN_SAMPLES}개가 쌓여야 판정한다"
    threshold = None if baseline_mae is None else baseline_mae * FORECAST_CLIMATOLOGY_MARGIN
    mae_metric = _metric(
        "forecast_mae_30m",
        label="30분 전망 오차 (MAE)",
        value=ours_mae,
        n=holdout_n,
        min_n=MIN_SAMPLES,
        threshold=None if threshold is None else round(threshold, 4),
        direction="lte",
        unit="mae",
        definition=(
            "t 의 추정을 t+30분 예측으로 보고, KST 날짜 뒤쪽 1/3(홀드아웃)에서 잰 평균 절대 오차. 추정은 학습 날짜로만 "
            "적합한 단조 사상(PAVA)을 거친다 — 눈금이 달라도 순서가 맞으면 벌받지 않는다. 기준선 = 학습 날짜의 시간대 평균"
            "(같은 시·평일/주말 칸의 정규화 실측 평균, 같은 홀드아웃 점). "
            f"홀드아웃 {MIN_SAMPLES}개 · {FORECAST_MIN_HOLDOUT_DATES}일 이상에서 기준선 MAE 의 "
            f"{FORECAST_CLIMATOLOGY_MARGIN:.2f}배 이하여야 통과. 실측 지속 모델은 추정기가 쓸 수 없는 정보라 참고로만 싣는다"
        ),
        extra={
            "baseline_label": FORECAST_BASELINE_LABEL,
            "baseline_mae": None if baseline_mae is None else round(baseline_mae, 4),
            "raw_mae": None if raw_mae is None else round(raw_mae, 4),
            "raw_n": n,
            "oracle_reference_label": FORECAST_ORACLE_LABEL,
            "oracle_reference_mae": None if persistence_mae is None else round(persistence_mae, 4),
            "holdout_n": holdout_n,
            "holdout_dates": holdout_dates,
            "margin": FORECAST_CLIMATOLOGY_MARGIN,
        },
    )
    if mae_reason is not None:
        mae_metric["status"] = STATUS_INSUFFICIENT
        mae_metric["reason"] = mae_reason
    elif mae_metric["status"] in (STATUS_PASS, STATUS_FAIL):
        # 기준선이 0 이면 0.95배도 0 이다 — 둘 다 0 인 '동률' 은 이긴 것이 아니므로 엄격 비교를 함께 건다.
        passed = ours_mae <= threshold and ours_mae < baseline_mae  # type: ignore[operator]
        mae_metric["status"] = STATUS_PASS if passed else STATUS_FAIL
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


def median_bucket_gap_minutes(points: list[Point]) -> float | None:
    """연속한 버킷 사이 간격의 중앙값(분). 수집 누락이 섞여도 중앙값은 주기에 붙는다. 버킷이 2개 미만이면 None."""
    gaps = sorted(
        (later.bucket_at - earlier.bucket_at).total_seconds() / 60.0
        for earlier, later in zip(points, points[1:])
        if later.bucket_at > earlier.bucket_at
    )
    if not gaps:
        return None
    middle = len(gaps) // 2
    value = gaps[middle] if len(gaps) % 2 else (gaps[middle - 1] + gaps[middle]) / 2
    return round(value, 1)


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
        # 실제 버킷 간격(분) — 최소 표본 36개가 몇 시간인지, 시계열의 '끊김' 을 어디서 볼지 이 값으로 정한다.
        "median_bucket_gap_minutes": median_bucket_gap_minutes(points),
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
