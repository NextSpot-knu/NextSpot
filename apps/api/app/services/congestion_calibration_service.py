"""서울 실측으로 경주 추정을 **보정**한다 — `docs/CONGESTION_ENGINE_PLAN.md` §5.3-5·6(결정 D5).

## 왜 이것이 필요한가 (정직한 틀)

경주에는 실시간 유동인구가 없다. 통신사 B2B 데이터는 지금 살 수 없어서(`CONGESTION_DATA.md` §3.1),
추정 모드는 **공영주차 점유율**을 인파의 대리 지표로 쓴다. 이건 임시 방편(stopgap)이고 문서마다
그렇게 적혀 있다. 주차가 "얼마나 찼는가" 는 사실이지만 "사람이 얼마나 많은가" 는 아니다.

서울시 실시간 도시데이터는 같은 질문의 **정답**을 무료로 준다 — 통신사 기지국 5분 집계에서 나온
인구다. 그리고 서울 121곳 중 **실시간 주차 대수까지 같이 주는 곳은 사실상 두 곳뿐**이다:
명동 관광특구(5곳) · 동대문 관광특구(8곳). 이 두 곳은 경주(ITS 3~4곳)와 같은 조건 — 주차 신호와
실측 인파가 **동시에** 있는 유일한 자리다. 여기서 "주차 점유율 x 가 실제로는 인파 y 였다" 를 배워
경주 추정에 그대로 얹는 것이 이 모듈이다.

    f: **주차 성분**(0~1)  →  보정된 주차 성분(0~1),  단조 비감소
       (서울 대상지에는 관광 앵커가 없어 x 가 주차 단독이다 — 적용도 주차 성분에만 한다)

## 어떻게 적합하는가

  1. 쌍 만들기 — 보정 대상지(CALIBRATION_PLACES)의 10분 버킷마다
     x = `parking_level`(비어 있지 않은 것만), y = (ppltn_min+ppltn_max)/2 를 **그 대상지의 창 안
     최대 중앙값**으로 나눈 0~1. 서울 인구는 인원수, 우리 추정은 상대 수준이라 최대 대비로 눌러야
     같은 축에 선다(engine_validation_metrics 의 정규화와 같은 규칙).
  2. 등장회귀(isotonic) — x 를 [0,1] 균등 20구간으로 묶어 구간 평균(x̄, ȳ, n)을 만들고, PAVA
     (pool-adjacent-violators)로 ȳ 를 **단조 비감소**로 눌러 꺾은선 knot 으로 노출한다.
     scipy 없이 순수 파이썬이다(새 의존성 금지).
  3. 품질 관문 — 아래 "관문" 참조. 통과 전에는 **절대 적용하지 않는다**(f = 항등).

구간을 [0,1] 고정 폭으로 자르는 이유: x 는 이미 0~1 점유율이다. 관측 범위에 맞춰 폭을 잡으면
극단값 하나가 들어올 때마다 모든 knot 의 x 가 흔들려, 어제 보정한 값과 오늘 보정한 값이 데이터가
아니라 **구간 경계 때문에** 달라진다.

## 관문 — 이 셋을 모두 넘기 전에는 항등이다

  · 서로 다른 KST 날짜 ≥ 3일        (하루짜리 우연을 곡선으로 굳히지 않는다)
  · 짝지어진 버킷 ≥ 300개           (10분 버킷 300 = 50시간)
  · **홀드아웃 MAE 가 항등보다 엄격히 낮을 것**

학습·평가는 `area_demand_forecast_service` 와 같은 규칙으로 **KST 날짜 단위**로 가른다 —
앞 날짜로 적합하고 뒤 날짜로 채점한다. 같은 날 안에서 섞으면 10분 버킷끼리 거의 같은 값이라
어떤 곡선이든 이기고, 그 성적은 "내일도 맞는다" 를 뜻하지 않는다(시간 순서 누수).

## 단조성·클램프 — "붐빔을 여유로" 를 만들지 않는 근거

세 겹이다.

  1. **PAVA 자체가 단조 비감소를 보장**한다. 주차가 더 찬 구간의 보정값이 덜 찬 구간보다 낮아지는
     일은 정의상 없다. 즉 f 는 순위를 절대 뒤집지 않는다 — 등급이 내려가도 **순서**는 그대로다.
  2. 관측 범위 **밖에서는 항등**이다. 관측된 x 범위를 [x₀, xₙ] 이라 하면
        x < x₀ : f(x) = min(x, y₀)      — 아래쪽은 원래 값을 그대로 쓰되, 가장 낮은 적합값을 넘지
                                          않게만 눌러 단조성을 지킨다(작은 값은 어차피 '여유').
        x > xₙ : f(x) = max(x, yₙ)      — **위쪽은 절대 깎지 않는다.** 데이터가 본 적 없는 높은
                                          주차 수치를 "사실은 한산했다" 로 내리는 것이 바로 이 보정이
                                          만들 수 있는 최악의 사고다. 그래서 위쪽 바깥은 원값과
                                          경계 적합값 중 **큰 쪽**을 쓴다(= 항등 이상).
     두 식 모두 전 구간에서 단조 비감소이고 [0,1] 로 클램프된다.
  3. 관문을 넘기 전에는 아예 적용하지 않는다. 실패·예외는 전부 항등으로 떨어진다(요청 경로를 죽이지
     않는다).

## 시간대 모양(hour_shape)은 **적용하지 않는다** — 보여 주기만 한다

시(hour)별 평균 인파 모양을 서울(실측)과 경주(주차)에서 각각 뽑아 화면에서 비교할 수 있게 둔다.
하지만 그 모양을 f 위에 한 번 더 곱하지 않는다: **주차 성분이 이미 시간대 변동을 통째로 싣고 있다.**
오전 10시의 주차 점유율과 오후 3시의 주차 점유율이 다른 것이 곧 시간대 모양이다. 거기에 "오후엔
평균 1.3배" 를 더 곱하면 같은 변동을 두 번 세고, 피크 시간대가 항상 만점(1.0)으로 눌려 구역 간
차이가 사라진다. 시간대 보정은 주차가 **없는** 곳에 값을 만들 때 쓸 도구이지, 주차가 있는 곳의
값을 다시 흔드는 도구가 아니다.

## 순위 관문(rank_gate) — 보고 전용, 적용 판정에 쓰지 않는다 (SEOUL_TESTBED_PLAN 부록 · S4)

세 관문은 "홀드아웃 MAE 가 항등보다 낮다" 만 본다. 그런데 x 가 y 의 순서를 전혀 모르는 경우에도(예: 주차와 인파가
무관) PAVA 는 거의 평평한 곡선을 배워 모든 값을 평균 쪽으로 끌어당기고, 그것만으로 항등보다 MAE 가 낮아질 수
있다 — 순위 정보 없이 관문을 넘는다. 그래서 `rank_gate(pairs)` 가 같은 날짜 분할의 홀드아웃에서 (1) 항등(보정 전)
x 와 y 의 **대상지 안** Spearman ρ(대상지별 ρ 의 표본 가중 평균) ≥ 0.30, (2) 학습 날짜로 적합한 곡선의 MAE 가
'대상지별 학습 평균 상수' 의 MAE 보다 낮은지, (3) 학습 날짜 시간대 평균(대상지 · **10분 칸** · 평일/주말)을 x·y 양쪽에서
뺀 이상치 ρ(`anomaly_rho`) ≥ 0.10 이고 그 95% 하한(`anomaly_rho_ci_low`, 홀드아웃 날짜 잭나이프 — 엔진 검증 Spearman
관문과 같은 식) > 0 인지를 잰다. 하한이 없으면 날짜 안 자기상관 때문에 정보 없는 x 도 21일 창에서 넷 중 하나꼴로
ρ ≥ 0.10 을 넘었다(S4 검토 3차). (1)·(2)는 하루 모양만 따라 그리는 x(시각의 함수)도 넘는다 — 대상지 안
ρ 가 높고 상수도 이긴다. 그런 x 는 그날 고유의 정보가 없으므로 (3)이 막는다(S4 검토 2차). 칸은 데이터 해상도(10분 버킷)로
잡는다 — 한 시간 칸이면 시간 안의 오르내림이 남아 시각만의 x 도 이상치 ρ 가 양수로 나온다. 대상지를 섞은
ρ(`pooled_spearman`)는 대상지끼리의 수준 차이만으로도 높아지므로 참고로만 싣는다.
ρ 는 PAVA 전 순위로 잰다 — PAVA 는 동률을 더할 뿐이라 ρ 를 낮추기만 한다. 홀드아웃이 36점·5일 미만이면 판정하지 않는다. **이 관문은 `assess()`·
`active_calibration()` 에 들어가지 않는다**(`enforced: false`) — 관리자 리포트(`build_report`)에서만 계산하고,
실패해도 None 으로 떨어진다. 경주 추정에 거는 일은 별도 결정이다(Q-S4-3).

## 표는 새로 만들지 않는다

추정기와 같은 철학이다(읽을 때 계산). 적합은 `seoul_citydata_snapshots` 의 결정적 함수라 따로
쌓을 이유가 없고, 쌓으면 "어느 날 적합한 곡선인지" 를 다시 관리해야 한다. 6시간 캐시면 충분하다 —
표본은 10분에 한 줄씩만 는다.
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog

from app.core.supabase import fetch_all_rows, supabase_admin
from app.services.engine_validation_metrics import (
    SPEARMAN_ANOMALY_CI_METHOD,
    SPEARMAN_ANOMALY_SLOT_MINUTES,
    MIN_SAMPLES,
    _day_jackknife,
    parse_time,
    population_midpoint,
    spearman_rho,
)
from app.services.kst_calendar import climatology
from app.services.parking_derived_congestion_service import SNAPSHOT_SOURCE

logger = structlog.get_logger()

TABLE = "seoul_citydata_snapshots"
MIGRATION = "20260920120000_seoul_citydata_snapshots.sql"
GYEONGJU_TABLE = "area_demand_snapshots"
GYEONGJU_LOT_TABLE = "area_demand_snapshot_lots"

# 보정에 쓰는 대상지. **주차 신호와 실측 인파가 둘 다 있는 곳만** 들어간다(2026-09-20 실측:
# 동대문 8곳 · 명동 5곳, 그 밖은 0~1곳). 홍대·연남동·합정역은 실시간 주차가 0곳이라 x 가 없어
# 여기 넣어도 쌍이 만들어지지 않는다 — 목록에 두면 "표본이 있는 줄" 오해만 부른다.
CALIBRATION_PLACES: tuple[str, ...] = ("명동 관광특구", "동대문 관광특구")

DEFAULT_WINDOW_DAYS = 28
MAX_WINDOW_DAYS = 28

# 적합 구간 수. 20이면 구간 폭 0.05 — 주차 점유율의 의미 있는 최소 단위(주차장 100면 중 5면)다.
BIN_COUNT = 20

# 관문(§5.3-5). 세 개 전부 넘어야 적용한다.
MIN_PAIRED_BUCKETS = 300
MIN_DAYS = 3
MUST_BEAT_IDENTITY = True

METHOD = "isotonic_pava_binned_piecewise_linear"

STATE_NOT_MIGRATED = "not_migrated"
STATE_EMPTY = "empty"
STATE_INSUFFICIENT = "insufficient"
STATE_READY = "ready"

# 화면 라벨. 값 옆에 항상 붙는 짧은 한국어 근거다.
BASIS_NOT_APPLIED = "보정 전(서울 표본 부족)"
_PLACE_LABEL = "·".join(name.replace(" 관광특구", "") for name in CALIBRATION_PLACES)

_KST = timezone(timedelta(hours=9))
_CACHE_TTL_SECONDS = 6 * 3600.0
# 실패(표 없음·DB 순단)는 짧게만 기억한다. 6시간을 들고 있으면 마이그레이션을 적용한 뒤에도
# 반나절 동안 '보정 전' 이 유지된다.
_FAILURE_TTL_SECONDS = 600.0
_SNAPSHOT_ID_BATCH = 200

_TABLE_MISSING_SIGNALS = ("pgrst205", "42p01", "could not find the table")


class CalibrationTableMissing(RuntimeError):
    """`seoul_citydata_snapshots` 가 아직 없다(마이그레이션 미적용). 장애가 아니라 남은 할 일이다."""


def is_missing_table(exc: BaseException) -> bool:
    """테이블 부재 신호만 참. 컬럼 부재(42703)는 **아니다** — 그건 스키마 불일치라 조치가 다르다."""
    code = str(getattr(exc, "code", "") or "").lower()
    if code in {"pgrst205", "42p01"}:
        return True
    text = str(getattr(exc, "message", None) or exc).lower()
    if any(signal in text for signal in _TABLE_MISSING_SIGNALS):
        return True
    return "relation" in text and "does not exist" in text and "column" not in text


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def _to_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


# ── 순수 함수: 쌍 만들기 ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class Pair:
    """한 버킷의 (주차 수준, 정규화 실측 인파) 쌍."""

    area_nm: str
    bucket_at: datetime
    date_kst: str
    hour_kst: int
    weekend: bool
    x: float  # parking_level 0~1
    y: float  # 정규화 실측 인파 0~1


def build_pairs(rows: list[dict[str, Any]]) -> list[Pair]:
    """행 → 쌍. 대상지별로 최대 중앙값을 따로 잡는다(명동과 동대문의 인구 규모가 다르다).

    ``parking_level`` 이 없는 버킷은 **버린다** — 실시간 주차장이 하나도 없던 시각이라 x 자체가
    존재하지 않는다. 0 으로 채우면 "주차가 비어 있었다" 는 거짓 관측이 된다.
    """
    by_place: dict[str, list[tuple[datetime, float, float]]] = {}
    seen: set[tuple[str, datetime]] = set()
    for row in rows:
        area_nm = " ".join(str(row.get("area_nm") or "").split())
        bucket = parse_time(row.get("bucket_at"))
        x = _to_float(row.get("parking_level"))
        midpoint = population_midpoint(row.get("ppltn_min"), row.get("ppltn_max"))
        if not area_nm or bucket is None or x is None or midpoint is None or midpoint <= 0:
            continue
        key = (area_nm, bucket)
        if key in seen:  # 표에 유니크 키가 있지만, 입력이 섞여 와도 한 버킷은 한 쌍이어야 한다
            continue
        seen.add(key)
        by_place.setdefault(area_nm, []).append((bucket, _clamp01(x), midpoint))

    pairs: list[Pair] = []
    for area_nm, entries in by_place.items():
        max_mid = max(midpoint for _, _, midpoint in entries)
        if max_mid <= 0:
            continue
        for bucket, x, midpoint in entries:
            local = bucket.astimezone(_KST)
            pairs.append(
                Pair(
                    area_nm=area_nm,
                    bucket_at=bucket,
                    date_kst=local.date().isoformat(),
                    hour_kst=local.hour,
                    weekend=local.weekday() >= 5,
                    x=x,
                    y=_clamp01(midpoint / max_mid),
                )
            )
    pairs.sort(key=lambda pair: (pair.bucket_at, pair.area_nm))
    return pairs


# ── 순수 함수: 등장회귀 ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class Knot:
    x: float
    y: float


@dataclass(frozen=True)
class Curve:
    """꺾은선으로 노출한 단조 보정 곡선. knot 의 x 는 **엄격히 증가**한다."""

    knots: tuple[Knot, ...]
    fitted_at: str
    method: str = METHOD
    bins: int = BIN_COUNT
    sample_count: int = 0

    def apply(self, level: float | None) -> float | None:
        return apply_curve(self.knots, level)

    def to_dict(self) -> dict[str, Any]:
        return {
            "method": self.method,
            "knots": [{"x": knot.x, "y": knot.y} for knot in self.knots],
            "fitted_at": self.fitted_at,
        }


def pool_adjacent_violators(values: list[float], weights: list[float]) -> list[float]:
    """가중 PAVA — 입력과 같은 길이의 **단조 비감소** 값을 돌려준다.

    인접한 두 블록의 평균이 뒤집혀 있으면 두 블록을 합쳐 가중 평균으로 바꾼다. 더 합칠 것이
    없을 때까지 반복하면 L2 최적 단조 적합이 된다(표준 알고리즘, scipy 없이 20줄).
    """
    blocks: list[list[float]] = []  # [weight, weighted_sum, span]
    for value, weight in zip(values, weights):
        if weight <= 0:
            continue
        blocks.append([weight, value * weight, 1.0])
        while len(blocks) > 1 and blocks[-2][1] / blocks[-2][0] > blocks[-1][1] / blocks[-1][0]:
            weight_b, sum_b, span_b = blocks.pop()
            blocks[-1][0] += weight_b
            blocks[-1][1] += sum_b
            blocks[-1][2] += span_b
    out: list[float] = []
    for weight, weighted_sum, span in blocks:
        out.extend([weighted_sum / weight] * int(span))
    return out


def bin_pairs(pairs: list[Pair], *, bins: int = BIN_COUNT) -> list[tuple[float, float, int]]:
    """x 를 [0,1] 균등 구간으로 묶어 (구간 평균 x, 구간 평균 y, 표본 수). 빈 구간은 나오지 않는다."""
    if bins <= 0:
        return []
    buckets: dict[int, list[float]] = {}
    sums: dict[int, list[float]] = {}
    for pair in pairs:
        index = min(bins - 1, int(pair.x * bins))
        buckets.setdefault(index, []).append(pair.x)
        sums.setdefault(index, []).append(pair.y)
    out: list[tuple[float, float, int]] = []
    for index in sorted(buckets):
        xs = buckets[index]
        ys = sums[index]
        out.append((sum(xs) / len(xs), sum(ys) / len(ys), len(xs)))
    return out


def fit_curve(pairs: list[Pair], *, bins: int = BIN_COUNT, fitted_at: str) -> Curve | None:
    """쌍 → 단조 곡선. 쌍이 없으면 None(빈 곡선을 만들지 않는다)."""
    binned = bin_pairs(pairs, bins=bins)
    if not binned:
        return None
    fitted = pool_adjacent_violators([y for _, y, _ in binned], [float(n) for _, _, n in binned])
    knots: list[Knot] = []
    for (x_mean, _, _), y_fit in zip(binned, fitted):
        x = round(_clamp01(x_mean), 4)
        y = round(_clamp01(y_fit), 4)
        # 반올림으로 x 가 겹치면 뒤 knot 이 이긴다(PAVA 결과라 y 는 이미 비감소다).
        if knots and knots[-1].x == x:
            knots[-1] = Knot(x, max(knots[-1].y, y))
            continue
        knots.append(Knot(x, y))
    return Curve(
        knots=tuple(knots), fitted_at=fitted_at, method=METHOD, bins=bins, sample_count=len(pairs)
    )


def apply_curve(knots: tuple[Knot, ...], level: float | None) -> float | None:
    """f(level). 관측 범위 **밖은 항등 쪽**으로 둔다 — 모듈 독스트링 "단조성·클램프" 참조."""
    if level is None:
        return None
    value = _to_float(level)
    if value is None:
        return None
    x = _clamp01(value)
    if not knots:
        return round(x, 4)
    if x < knots[0].x:
        # 아래쪽 바깥: 원값 그대로, 단 가장 낮은 적합값을 넘지 않게(단조성 유지).
        return round(_clamp01(min(x, knots[0].y)), 4)
    if x > knots[-1].x:
        # 위쪽 바깥: 원값과 가장 높은 적합값 중 **큰 쪽**. 데이터가 못 본 높은 값을 깎지 않는다.
        return round(_clamp01(max(x, knots[-1].y)), 4)
    for left, right in zip(knots, knots[1:]):
        if left.x <= x <= right.x:
            span = right.x - left.x
            if span <= 0:
                return round(_clamp01(right.y), 4)
            ratio = (x - left.x) / span
            return round(_clamp01(left.y + ratio * (right.y - left.y)), 4)
    return round(_clamp01(knots[-1].y), 4)


# ── 순수 함수: 관문 ───────────────────────────────────────────────────────────


def split_by_date(pairs: list[Pair]) -> tuple[list[Pair], list[Pair], list[str]]:
    """KST 날짜로 학습·홀드아웃을 가른다(뒤쪽 1/3, 최소 1일). 날짜가 2개 미만이면 가를 수 없다."""
    dates = sorted({pair.date_kst for pair in pairs})
    if len(dates) < 2:
        return [], [], []
    holdout_count = max(1, len(dates) // 3)
    holdout_dates = dates[-holdout_count:]
    holdout_set = set(holdout_dates)
    train = [pair for pair in pairs if pair.date_kst not in holdout_set]
    holdout = [pair for pair in pairs if pair.date_kst in holdout_set]
    if not train or not holdout:
        return [], [], []
    return train, holdout, holdout_dates


def _mae(predictions: list[float], truths: list[float]) -> float | None:
    if not predictions:
        return None
    return sum(abs(p - t) for p, t in zip(predictions, truths)) / len(predictions)


def evaluate(curve: Curve, pairs: list[Pair]) -> dict[str, Any]:
    """홀드아웃 채점. 항등(f(x)=x)과 보정을 **같은 표본**에서 비교한다."""
    xs = [pair.x for pair in pairs]
    ys = [pair.y for pair in pairs]
    calibrated = [apply_curve(curve.knots, x) or 0.0 for x in xs]
    mae_identity = _mae(xs, ys)
    mae_calibrated = _mae(calibrated, ys)
    improved = (
        mae_identity is not None and mae_calibrated is not None and mae_calibrated < mae_identity
    )
    return {
        "holdout_days": len(sorted({pair.date_kst for pair in pairs})),
        "holdout_samples": len(pairs),
        "mae_identity": None if mae_identity is None else round(mae_identity, 4),
        "mae_calibrated": None if mae_calibrated is None else round(mae_calibrated, 4),
        "spearman_identity": _round_or_none(spearman_rho(xs, ys)),
        # 보정은 **단조**라 순위를 바꾸지 않는다 — 동률이 새로 생기지 않는 한 두 ρ 는 같다.
        # 같게 나오는 것이 정상이고, 그것이 "보정이 순서를 뒤집지 않는다" 의 수치 증거다.
        "spearman_calibrated": _round_or_none(spearman_rho(calibrated, ys)),
        "improved": bool(improved),
    }


def _round_or_none(value: float | None) -> float | None:
    return None if value is None else round(value, 4)


def assess(pairs: list[Pair], *, now: datetime) -> dict[str, Any]:
    """쌍 → 판정. 곡선은 관문을 못 넘어도 **보여 준다**(적용만 하지 않는다 — 지표를 감추지 않는다)."""
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
            "state": STATE_EMPTY, "applied": False, "curve": None, "quality": None,
            "sample": sample,
            "reason": "보정 대상지(명동·동대문)의 주차·인구 쌍이 아직 한 건도 없다 — 수집 시작 전이다.",
        }

    curve = fit_curve(pairs, fitted_at=fitted_at)
    train, holdout, _holdout_dates = split_by_date(pairs)
    # 채점용 곡선은 **앞 날짜만** 으로 적합한다(누수 금지). 적용 곡선은 관문을 넘은 뒤 전체로 다시
    # 적합한 위의 curve 다 — 관문이 검증하는 것은 '방법' 이고, 쓰는 것은 표본이 더 많은 쪽이다.
    train_curve = fit_curve(train, fitted_at=fitted_at) if train else None
    quality = evaluate(train_curve, holdout) if train_curve is not None and holdout else None

    reason: str | None = None
    if len(dates) < MIN_DAYS:
        reason = f"서로 다른 KST 날짜가 {len(dates)}일 — 최소 {MIN_DAYS}일이 필요하다."
    elif len(pairs) < MIN_PAIRED_BUCKETS:
        reason = f"짝지어진 버킷 {len(pairs)}개 — 최소 {MIN_PAIRED_BUCKETS}개가 필요하다."
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
        "state": STATE_READY if applied else STATE_INSUFFICIENT,
        "applied": applied,
        "curve": curve,
        "quality": quality,
        "sample": sample,
        "reason": reason,
    }


# ── 순수 함수: 순위 관문(보고 전용) ──────────────────────────────────────────

# [제안] 기준(Q-S4-3·Q-S4-10). 적용 판정(assess)에는 들어가지 않는다.
RANK_GATE_MIN_HOLDOUT_SPEARMAN = 0.30
RANK_GATE_MIN_HOLDOUT_SAMPLES = MIN_SAMPLES
RANK_GATE_MIN_HOLDOUT_DAYS = 5
# 학습 날짜 시간대 평균(10분 칸)을 뺀 이상치 ρ 의 하한 — 하루 모양만 따라 그리는 x 를 거른다.
RANK_GATE_MIN_ANOMALY_RHO = 0.10

_RANK_GATE_DEFINITION = (
    "적용 판정과 같은 날짜 분할(뒤쪽 1/3 날짜 = 홀드아웃)에서 잰다. 통과 = 보정 전(항등) 주차 수준과 실측 인파의 "
    f"대상지 안 Spearman ρ(대상지별 ρ 를 표본 수로 가중 평균) ≥ {RANK_GATE_MIN_HOLDOUT_SPEARMAN:.2f} 이고, 학습 날짜로 "
    "적합한 곡선의 MAE 가 대상지별 학습 평균 상수의 MAE 보다 낮고 — 대상지끼리의 수준 차이만으로는 넘지 못한다 — "
    f"이상치 ρ(학습 날짜의 시간대 평균 — 대상지·{SPEARMAN_ANOMALY_SLOT_MINUTES}분 칸·평일/주말 — 을 양쪽에서 뺀 값끼리의 ρ) "
    f"≥ {RANK_GATE_MIN_ANOMALY_RHO:.2f} 이고 그 95% 하한(홀드아웃 {SPEARMAN_ANOMALY_CI_METHOD}) > 0 일 것 — "
    "하루 모양(시각)만 따라 그리는 주차 수준으로는 넘지 못하고, 날짜 몇 개의 우연으로 생긴 ρ 도 하한에서 걸린다. "
    "대상지를 섞은 ρ 는 참고로 싣는다. "
    "ρ 는 PAVA 전 순위로 잰다(PAVA 는 동률을 더할 뿐이라 ρ 를 낮추기만 한다). "
    f"홀드아웃 {RANK_GATE_MIN_HOLDOUT_SAMPLES}점 · {RANK_GATE_MIN_HOLDOUT_DAYS}일 미만이면 판정하지 않는다. "
    "보고 전용 — 보정 적용 여부를 바꾸지 않는다"
)


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _holdout_anomaly_rho(
    train: list[Pair], holdout: list[Pair]
) -> tuple[float | None, float | None, float | None]:
    """학습 날짜 시간대 평균(대상지 · 10분 칸 · 평일/주말)을 x·y 양쪽에서 뺀 홀드아웃 이상치끼리의 ρ. 칸이 비면 그 점을 뺀다.

    칸은 데이터 해상도(10분 버킷)다 — 한 시간 칸이면 시간 안의 오르내림이 이상치에 남아, 시각만의 함수인 x 도
    양수 ρ 를 받는다(S4 검토 2차). x 가 시각만의 함수면 이상치가 모두 0 이라 ρ 가 정의되지 않는다(None).

    돌려주는 값: (ρ, SE, 95% 하한). SE·하한은 홀드아웃 날짜 잭나이프다 — 엔진 검증 Spearman 관문
    (`engine_validation_metrics._day_jackknife`)과 같은 식이다. 같은 날 안의 점들은 서로 닮아(자기상관) 점 수만큼의
    정보가 없으므로, 날짜 단위 불확실성 없이 ρ ≥ 0.10 만 보면 정보 없는 x 도 우연히 넘는다(S4 검토 3차).
    """
    if not train or not holdout:
        return None, None, None
    train_dates = sorted({pair.date_kst for pair in train})
    common: dict[str, Any] = {
        "time": lambda pair: pair.bucket_at,
        "mode": "train_dates",
        "train_dates": train_dates,
        "min_samples": 1,
        "group": lambda pair: pair.area_nm,
        "slot_minutes": SPEARMAN_ANOMALY_SLOT_MINUTES,
    }
    clim_x = climatology(train, value=lambda pair: pair.x, **common)
    clim_y = climatology(train, value=lambda pair: pair.y, **common)
    xs: list[float] = []
    ys: list[float] = []
    day_of_point: list[str] = []
    for pair in holdout:
        base_x = clim_x(pair)
        base_y = clim_y(pair)
        if base_x is None or base_y is None:
            continue
        # 평균을 빼고 남은 부동소수 찌꺼기가 순위를 만들지 않게 자른다(engine_validation_metrics 와 같은 자릿수).
        xs.append(round(pair.x - base_x, 9))
        ys.append(round(pair.y - base_y, 9))
        day_of_point.append(pair.date_kst)
    rho = spearman_rho(xs, ys) if len(xs) >= 2 else None
    se, ci_low = _day_jackknife(xs, ys, day_of_point, rho)
    return rho, se, ci_low


def _within_site_spearman(holdout: list[Pair]) -> tuple[float | None, int]:
    """대상지별 홀드아웃 ρ 를 표본 수로 가중 평균한다. ρ 가 정의되는 대상지가 없으면 (None, 0).

    대상지를 섞어 잰 ρ 는 "B 가 A 보다 x 도 y 도 높다" 는 대상지 차이만으로 높아진다 — 그 추정기는
    어느 대상지인지만 알 뿐 순위를 모른다(S4 검토). 그래서 판정 ρ 는 대상지 안에서 잰다.
    """
    by_site: dict[str, list[Pair]] = {}
    for pair in holdout:
        by_site.setdefault(pair.area_nm, []).append(pair)
    weighted = 0.0
    weight = 0
    sites = 0
    for site in sorted(by_site):
        members = by_site[site]
        if len(members) < 2:
            continue
        rho = spearman_rho([pair.x for pair in members], [pair.y for pair in members])
        if rho is None:
            continue
        weighted += rho * len(members)
        weight += len(members)
        sites += 1
    return (weighted / weight if weight else None), sites


def _site_constant_predictions(train: list[Pair], holdout: list[Pair]) -> list[float] | None:
    """홀드아웃 각 점에 그 대상지의 학습 평균을 준다(학습에 없는 대상지는 전역 학습 평균)."""
    global_mean = _mean([pair.y for pair in train])
    if global_mean is None:
        return None
    sums: dict[str, list[float]] = {}
    for pair in train:
        sums.setdefault(pair.area_nm, []).append(pair.y)
    site_mean = {site: sum(values) / len(values) for site, values in sums.items()}
    return [site_mean.get(pair.area_nm, global_mean) for pair in holdout]


def rank_gate(pairs: list[Pair]) -> dict[str, Any] | None:
    """보정 곡선이 **순위 정보**를 담는지 홀드아웃에서 잰다 — 보고 전용(`enforced: False`).

    순수 함수다. 쌍이 없으면 None. 날짜가 하나뿐이거나(학습 비어 있음) x 가 상수라 ρ 가 정의되지 않으면
    ``status='insufficient'`` 와 이유를 담은 dict 를 준다. `assess()` 와 `active_calibration()` 은 이 함수를 부르지
    않는다 — 경주 추정은 이 함수와 무관하다.
    """
    if not pairs:
        return None
    train, holdout, holdout_dates = split_by_date(pairs)
    xs = [pair.x for pair in holdout]
    ys = [pair.y for pair in holdout]
    pooled_spearman = spearman_rho(xs, ys) if len(holdout) >= 2 else None
    holdout_spearman, holdout_sites = _within_site_spearman(holdout)
    constant = _site_constant_predictions(train, holdout) if holdout else None
    mae_constant = _mae(constant, ys) if constant is not None and ys else None
    train_curve = fit_curve(train, fitted_at="") if train else None
    mae_calibrated = (
        _mae([apply_curve(train_curve.knots, x) or 0.0 for x in xs], ys)
        if train_curve is not None and ys
        else None
    )
    beats_constant = (
        mae_calibrated is not None and mae_constant is not None and mae_calibrated < mae_constant
    )
    anomaly_rho, anomaly_se, anomaly_ci_low = _holdout_anomaly_rho(train, holdout)
    holdout_days = len(holdout_dates)

    reason: str | None = None
    if not holdout:
        status = "insufficient"
        reason = "날짜로 학습·홀드아웃을 가를 수 없다(날짜가 하나뿐이다)."
    elif len(holdout) < RANK_GATE_MIN_HOLDOUT_SAMPLES or holdout_days < RANK_GATE_MIN_HOLDOUT_DAYS:
        status = "insufficient"
        reason = (
            f"홀드아웃 {len(holdout)}점 · {holdout_days}일 — 최소 {RANK_GATE_MIN_HOLDOUT_SAMPLES}점 · "
            f"{RANK_GATE_MIN_HOLDOUT_DAYS}일이 필요하다(뒤쪽 1/3 날짜가 홀드아웃이다)."
        )
    elif holdout_spearman is None:
        status = "insufficient"
        reason = "홀드아웃에서 주차 수준이나 실측 인파가 변하지 않아 순위 상관이 정의되지 않는다."
    elif (
        holdout_spearman >= RANK_GATE_MIN_HOLDOUT_SPEARMAN
        and beats_constant
        and anomaly_rho is not None
        and anomaly_rho >= RANK_GATE_MIN_ANOMALY_RHO
        and anomaly_ci_low is not None
        and anomaly_ci_low > 0
    ):
        status = "pass"
    else:
        status = "fail"
        failed: list[str] = []
        if holdout_spearman < RANK_GATE_MIN_HOLDOUT_SPEARMAN:
            failed.append(f"홀드아웃 ρ {holdout_spearman:.4f} < {RANK_GATE_MIN_HOLDOUT_SPEARMAN:.2f}")
        if not beats_constant:
            failed.append("보정 곡선이 대상지별 학습 평균 상수보다 MAE 가 낮지 않다")
        if anomaly_rho is None:
            failed.append(
                "시간대 평균을 뺀 ρ 가 정의되지 않는다 — 주차 수준이 하루 모양(시각)만 따라 그려 그날 고유의 정보가 없다"
            )
        elif anomaly_rho < RANK_GATE_MIN_ANOMALY_RHO:
            failed.append(f"시간대 평균을 뺀 ρ {anomaly_rho:.4f} < {RANK_GATE_MIN_ANOMALY_RHO:.2f}")
        elif anomaly_ci_low is None:
            failed.append("시간대 평균을 뺀 ρ 의 95% 하한을 계산할 수 없다(홀드아웃 날짜 부족)")
        elif anomaly_ci_low <= 0:
            failed.append(f"시간대 평균을 뺀 ρ 의 95% 하한(날짜 잭나이프) {anomaly_ci_low:.4f} ≤ 0")
        reason = " · ".join(failed)

    return {
        "status": status,
        "enforced": False,
        "holdout_spearman": _round_or_none(holdout_spearman),
        "pooled_spearman": _round_or_none(pooled_spearman),
        "holdout_sites": holdout_sites,
        "anomaly_rho": _round_or_none(anomaly_rho),
        "anomaly_rho_se": _round_or_none(anomaly_se),
        "anomaly_rho_ci_low": _round_or_none(anomaly_ci_low),
        "anomaly_ci_method": SPEARMAN_ANOMALY_CI_METHOD,
        "min_anomaly_rho": RANK_GATE_MIN_ANOMALY_RHO,
        "anomaly_slot_minutes": SPEARMAN_ANOMALY_SLOT_MINUTES,
        "min_holdout_spearman": RANK_GATE_MIN_HOLDOUT_SPEARMAN,
        "mae_constant": _round_or_none(mae_constant),
        "mae_calibrated": _round_or_none(mae_calibrated),
        "beats_constant": bool(beats_constant),
        "holdout_samples": len(holdout),
        "holdout_days": holdout_days,
        "min_holdout_samples": RANK_GATE_MIN_HOLDOUT_SAMPLES,
        "min_holdout_days": RANK_GATE_MIN_HOLDOUT_DAYS,
        "definition": _RANK_GATE_DEFINITION,
        "reason": reason,
    }


def _safe_rank_gate(pairs: list[Pair]) -> dict[str, Any] | None:
    """리포트 전용 래퍼. 어떤 예외도 올리지 않는다 — 관문 계산이 깨져도 리포트 나머지는 그대로 나간다."""
    try:
        return rank_gate(pairs)
    except Exception as exc:  # noqa: BLE001 — 보고 전용 필드다. 리포트 전체를 죽이지 않는다
        logger.warning("congestion_calibration_rank_gate_failed", error_type=type(exc).__name__)
        return None


# ── 순수 함수: 시간대 모양(표시 전용) ─────────────────────────────────────────


def hour_shape(samples: list[tuple[int, bool, float]]) -> list[dict[str, Any]]:
    """(KST 시, 주말 여부, 값) → 24행. 평일·주말 평균과 표본 수.

    **적용하지 않는다** — 모듈 독스트링 "시간대 모양" 참조(주차 성분이 이미 시간대 변동을 싣는다).
    """
    weekday: dict[int, list[float]] = {}
    weekend: dict[int, list[float]] = {}
    for hour, is_weekend, value in samples:
        (weekend if is_weekend else weekday).setdefault(int(hour), []).append(float(value))
    rows: list[dict[str, Any]] = []
    for hour in range(24):
        day_values = weekday.get(hour, [])
        end_values = weekend.get(hour, [])
        rows.append({
            "hour": hour,
            "weekday_mean": round(sum(day_values) / len(day_values), 4) if day_values else None,
            "weekend_mean": round(sum(end_values) / len(end_values), 4) if end_values else None,
            "n": len(day_values) + len(end_values),
            # 계약(hour/weekday_mean/weekend_mean/n) 위에 칸별 표본 수를 덧붙인다 — 평균 하나가
            # 표본 2개인지 200개인지 모르면 두 도시의 모양을 비교할 수 없다.
            "weekday_n": len(day_values),
            "weekend_n": len(end_values),
        })
    return rows


def curve_effect(curve: Curve | None, levels: list[float]) -> dict[str, Any] | None:
    """경주 주차 수준 분포에 곡선을 걸면 값이 얼마나 움직이는가(표시 전용).

    ``samples`` 는 관측 분포의 **십분위**다 — 임의의 0.1 간격 격자가 아니라 실제로 자주 나오는
    값에서 얼마나 움직이는지 보여야 "화면 색이 바뀌는가" 를 판단할 수 있다.
    """
    if curve is None or not levels:
        return None
    ordered = sorted(_clamp01(level) for level in levels)
    samples: list[dict[str, Any]] = []
    seen: set[float] = set()
    for step in range(11):
        index = min(len(ordered) - 1, round(step / 10 * (len(ordered) - 1)))
        raw = round(ordered[index], 4)
        if raw in seen:
            continue
        seen.add(raw)
        samples.append({"raw": raw, "calibrated": apply_curve(curve.knots, raw)})
    shifts = sorted((apply_curve(curve.knots, level) or 0.0) - level for level in ordered)
    middle = len(shifts) // 2
    median_shift = shifts[middle] if len(shifts) % 2 else (shifts[middle - 1] + shifts[middle]) / 2
    return {"samples": samples, "median_shift": round(median_shift, 4)}


# ── DB 읽기(쓰기 없음) ───────────────────────────────────────────────────────

_SEOUL_COLUMNS = "area_nm,bucket_at,ppltn_min,ppltn_max,parking_level"


def _load_seoul_rows(since_iso: str) -> list[dict[str, Any]]:
    try:
        return fetch_all_rows(
            supabase_admin,
            TABLE,
            select=_SEOUL_COLUMNS,
            apply_filters=lambda query: query.in_("area_nm", list(CALIBRATION_PLACES))
            .gte("bucket_at", since_iso)
            .order("bucket_at"),
        )
    except Exception as exc:
        if is_missing_table(exc):
            raise CalibrationTableMissing(MIGRATION) from exc
        raise


def load_pairs(days: int, *, now: datetime) -> list[Pair]:
    """보정 대상지의 창 안 쌍. 표가 없으면 ``CalibrationTableMissing``."""
    since = (now.astimezone(timezone.utc) - timedelta(days=days)).isoformat()
    return build_pairs(_load_seoul_rows(since))


def _load_gyeongju_levels(days: int, *, now: datetime) -> list[tuple[datetime, float]]:
    """경주 주차 스냅샷별 (버킷 시각, 정원 가중 점유율). 화면 비교용이라 격자를 잡지 않는다.

    추정기는 격자 중심에서 거리 가중으로 재지만, 여기서 필요한 것은 "하루 안에서 주차가 어떻게
    오르내리는가" 하나뿐이다. 정원 가중 점유율(Σ(정원-잔여)/Σ정원)은 중심점 선택 없이 같은 모양을
    주고, 좌표를 읽지 않으니 응답도 훨씬 가볍다.
    """
    since = (now.astimezone(timezone.utc) - timedelta(days=days)).isoformat()
    parents = fetch_all_rows(
        supabase_admin,
        GYEONGJU_TABLE,
        select="id,bucket_at",
        apply_filters=lambda query: query.eq("source", SNAPSHOT_SOURCE)
        .gte("bucket_at", since)
        .order("bucket_at"),
    )
    buckets: dict[str, datetime] = {}
    for row in parents:
        bucket = parse_time(row.get("bucket_at"))
        snapshot_id = str(row.get("id") or "")
        if snapshot_id and bucket is not None:
            buckets[snapshot_id] = bucket
    ids = list(buckets)
    totals: dict[str, list[float]] = {}
    for offset in range(0, len(ids), _SNAPSHOT_ID_BATCH):
        batch = ids[offset:offset + _SNAPSHOT_ID_BATCH]
        for row in fetch_all_rows(
            supabase_admin,
            GYEONGJU_LOT_TABLE,
            select="snapshot_id,total_spaces,available_spaces",
            apply_filters=lambda query, chunk=batch: query.in_("snapshot_id", chunk),
        ):
            total = _to_float(row.get("total_spaces"))
            available = _to_float(row.get("available_spaces"))
            snapshot_id = str(row.get("snapshot_id") or "")
            if snapshot_id not in buckets or total is None or available is None:
                continue
            if total <= 0 or not 0 <= available <= total:
                continue
            entry = totals.setdefault(snapshot_id, [0.0, 0.0])
            entry[0] += total
            entry[1] += total - available
    out = [
        (buckets[snapshot_id], _clamp01(occupied / capacity))
        for snapshot_id, (capacity, occupied) in totals.items()
        if capacity > 0
    ]
    out.sort(key=lambda item: item[0])
    return out


# ── 공개 API: 적용 상태(추정기가 부른다) ──────────────────────────────────────


@dataclass(frozen=True)
class CalibrationState:
    """추정기가 들고 다니는 보정 상태. ``applied=False`` 면 ``apply`` 는 **항등**이다."""

    applied: bool
    state: str
    curve: Curve | None
    days: int
    paired_buckets: int
    basis: str
    reason: str | None

    def apply(self, level: float | None) -> float | None:
        if not self.applied or self.curve is None:
            return level
        return self.curve.apply(level)

    def to_dict(self) -> dict[str, Any]:
        return {
            "applied": self.applied,
            "state": self.state,
            "basis": self.basis,
            "places": list(CALIBRATION_PLACES),
            "days": self.days,
            "paired_buckets": self.paired_buckets,
            "method": METHOD if self.applied else None,
            "fitted_at": self.curve.fitted_at if (self.applied and self.curve) else None,
            "reason": self.reason,
        }


def _identity_state(state: str, reason: str | None) -> CalibrationState:
    return CalibrationState(
        applied=False, state=state, curve=None, days=0, paired_buckets=0,
        basis=BASIS_NOT_APPLIED, reason=reason,
    )


IDENTITY = _identity_state(STATE_EMPTY, "서울 표본이 아직 없다.")

_cache_lock = threading.Lock()
_cache: tuple[float, CalibrationState] | None = None


def reset_caches() -> None:
    """테스트용."""
    global _cache
    with _cache_lock:
        _cache = None


def _build_state(*, now: datetime) -> CalibrationState:
    pairs = load_pairs(DEFAULT_WINDOW_DAYS, now=now)
    verdict = assess(pairs, now=now)
    days = verdict["sample"]["days"]
    paired = verdict["sample"]["paired_buckets"]
    applied = bool(verdict["applied"])
    return CalibrationState(
        applied=applied,
        state=verdict["state"],
        curve=verdict["curve"] if applied else None,
        days=days,
        paired_buckets=paired,
        basis=(
            f"서울 실측으로 보정({_PLACE_LABEL}, {days}일 · {paired}표본)"
            if applied
            else BASIS_NOT_APPLIED
        ),
        reason=verdict["reason"],
    )


def active_calibration(*, now: datetime | None = None) -> CalibrationState:
    """지금 적용할 보정 상태. **어떤 실패도 예외로 올리지 않는다** — 항등으로 떨어진다.

    6시간 캐시. 표본은 10분에 한 줄씩만 늘어 그 사이에 곡선이 의미 있게 바뀌지 않는다.
    """
    global _cache
    moment = now or datetime.now(timezone.utc)
    with _cache_lock:
        monotonic_now = time.monotonic()
        if _cache is not None and monotonic_now < _cache[0]:
            return _cache[1]
        try:
            state = _build_state(now=moment)
            ttl = _CACHE_TTL_SECONDS if state.applied else _FAILURE_TTL_SECONDS
        except CalibrationTableMissing:
            state = _identity_state(STATE_NOT_MIGRATED, f"마이그레이션 {MIGRATION} 미적용")
            ttl = _FAILURE_TTL_SECONDS
        except Exception as exc:  # noqa: BLE001 — 보정은 부가 기능이다. 추천·지도를 죽이지 않는다
            logger.warning("congestion_calibration_unavailable", error_type=type(exc).__name__)
            state = _identity_state(STATE_EMPTY, "보정 표본을 읽지 못했다")
            ttl = _FAILURE_TTL_SECONDS
        _cache = (monotonic_now + ttl, state)
        return state


# ── 공개 API: 관리자 리포트 ───────────────────────────────────────────────────

REQUIREMENT = {
    "min_paired_buckets": MIN_PAIRED_BUCKETS,
    "min_days": MIN_DAYS,
    "must_beat_identity": MUST_BEAT_IDENTITY,
}


def _envelope(state: str, *, days: int, now: datetime) -> dict[str, Any]:
    return {
        "state": state,
        "applied": False,
        "places": list(CALIBRATION_PLACES),
        "window_days": days,
        "generated_at": now.astimezone(timezone.utc).isoformat(),
        "sample": {"paired_buckets": 0, "days": 0, "first_bucket_at": None, "last_bucket_at": None},
        "requirement": dict(REQUIREMENT),
        "curve": None,
        "quality": None,
        "hour_shape": {"seoul": hour_shape([]), "gyeongju_parking": hour_shape([])},
        "gyeongju_effect": None,
        "reason": None,
        # 순위 관문(보고 전용). 계산할 수 없으면 None — `rank_gate()` 참조.
        "rank_gate": None,
    }


def build_report(days: int = DEFAULT_WINDOW_DAYS, *, now: datetime | None = None) -> dict[str, Any]:
    """관리자 엔드포인트의 동기 본체(테스트가 직접 부른다).

    표가 없으면 ``state='not_migrated'`` 로 **정상 응답**한다(배포 순서상 흔히 거치는 단계다).
    그 밖의 조회 실패는 그대로 올려 라우터가 503 으로 옮긴다.
    """
    moment = now or datetime.now(timezone.utc)
    try:
        pairs = load_pairs(days, now=moment)
    except CalibrationTableMissing:
        envelope = _envelope(STATE_NOT_MIGRATED, days=days, now=moment)
        envelope["reason"] = f"마이그레이션 {MIGRATION} 이 아직 적용되지 않았다."
        return envelope

    verdict = assess(pairs, now=moment)
    envelope = _envelope(verdict["state"], days=days, now=moment)
    envelope["applied"] = verdict["applied"]
    envelope["sample"] = verdict["sample"]
    curve: Curve | None = verdict["curve"]
    envelope["curve"] = curve.to_dict() if curve is not None else None
    envelope["quality"] = verdict["quality"]
    envelope["reason"] = verdict["reason"]
    # 적용 판정(verdict)이 다 정해진 **뒤에** 따로 계산한다 — 관문 결과가 applied 를 바꾸지 않는다.
    envelope["rank_gate"] = _safe_rank_gate(pairs)

    seoul_samples = [(pair.hour_kst, pair.weekend, pair.y) for pair in pairs]
    try:
        gyeongju = _load_gyeongju_levels(days, now=moment)
    except Exception as exc:  # noqa: BLE001 — 비교용 모양이다. 없으면 빈 칸으로 둔다
        logger.warning("congestion_calibration_gyeongju_shape_failed", error_type=type(exc).__name__)
        gyeongju = []
    # 경주 주차는 인원수가 아니라 점유율이라 눈금이 이미 0~1 이지만, 서울 y 가 '창 안 최대 대비'
    # 이므로 같은 방식으로 한 번 더 눌러야 두 모양을 겹쳐 볼 수 있다.
    max_level = max((level for _, level in gyeongju), default=0.0)
    gyeongju_samples = [
        (bucket.astimezone(_KST).hour, bucket.astimezone(_KST).weekday() >= 5, level / max_level)
        for bucket, level in gyeongju
    ] if max_level > 0 else []
    envelope["hour_shape"] = {
        "seoul": hour_shape(seoul_samples),
        "gyeongju_parking": hour_shape(gyeongju_samples),
    }
    envelope["gyeongju_effect"] = curve_effect(curve, [level for _, level in gyeongju])
    return envelope
