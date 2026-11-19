"""S4 분산 결정 재생(V3) · 순위 민감도(V2) · 도착 시점 예측 오차(V4) — 결정 · 기준선 · 지표 · 부트스트랩 · 보고.

`docs/SEOUL_TESTBED_PLAN.md` §4 · §6 S4. 입력은 ``crowd_replay_data.load_replay_inputs`` 가 검증한 구역 시계열,
엔진은 ``crowd_replay_engine.rank_alternatives``(실제 추천 경로)를 주입받는다. 이 모듈은 파일·네트워크를 만지지 않는다.

## 결정 규칙(요약)
  · 권역 구역 하나하나가 차례로 출발지 o, 나머지 중 **도보 상한(20분, 라우터 `max_walk_minutes` 최댓값) 안**의
    구역이 대안(모든 정책이 같은 대안 집합). 상한 안 대안이 없는 출발지는 결정하지 않고 사유를 센다.
  · 이동은 두 벌이다. **엔진 쪽**(대안 자격 = 상한 비교, 엔진에 주는 이동 분·m)은 라우터가 서울에서 실제로 쓰는 값
    (``crowd_replay_engine.router_travel_matrix`` = ``spot.travel.estimate_walking_route``: 직선 × 1.18 ÷ 66.67,
    0.1분 반올림). **채점 쪽**(정답 도착 시각 t+τ, 가장 가까운 곳·오라클의 동점 처리, 추가 이동)은 보수적 이동
    (직선 × 1.4 ÷ 66.67, 분 올림)이다 — 엔진이 운영보다 늦게 도착한다고 보고 채점한다.
    결정 시각 t = 출발지 버킷 b 의 자기 행을 받은 시각(분 올림) · b + 5 · b + 10분(30분 주기는 받은 시각 · +10 ·
    +20분). 고정 시각에 출발지 행이 아직 안 왔으면 받은 시각까지 기다리고, 같은 t 는 한 번만 결정한다
    (주기 안에서 관측 나이를 고르게 — b+10 한 번이면 관측이 가장 낡은 때만 재서 지속 근거가 쓰이지 않는다).
  · 정보 집합 = ``fetched_at <= t`` 인 행만. 엔진 시계 = t. 출발지가 '지금'이 아니면 결정 없음.
  · 정답 = 도착 시각 t + 이동(분)에 가장 가까운, t 뒤에 받은 실측(허용 오차 max(5, 주기/2)분). 보간 없음.
  · 한 사람이 옮겨도 혼잡은 변하지 않는다는 가정 아래의 **결정 품질**이다(혼잡이 줄었는지는 재지 않는다).
  · V3 모집단은 붐비는 출발지 중 대안이 2곳 이상인 결정이다. 대안 1곳이면 엔진 = 가장 가까운 곳 = 오라클이라
    차가 구성상 0 이다 — 판정에서 빼고 그 수·비율(forced_agreement)과 섞은 차(pooled_crowded)를 기술 통계로 낸다.
    최소 표본은 서로 다른 (출발지, 버킷) 상황 수로 센다.

## 판정 기준은 한 상수(``CRITERIA``)에만
``criteria_version`` = sha256(json(CRITERIA, sort_keys)) 앞 12자. 홍대 결과는 'pilot'(기준 확정 전),
종로는 고정된 해시로 'confirmatory'. 판정은 반올림 전 값으로 한다(직렬화 때만 소수 4자리).

## 판정 하한 = 부트스트랩과 날짜 군집 t 중 작은 쪽
백분위 날짜 블록 부트스트랩은 블록이 적으면 구간이 좁게 나온다(영가설 모의 3,000회: 하한 > 0 비율이 10일 4.3% ·
14일 3.7% · 20일 3.4% · 40일 2.7% — 명목 2.5%, S4 검토). 그래서 V3·V4 판정의 하한은 부트스트랩 하한과
**날짜 군집 t 구간 하한**(비율 추정의 선형화 분산 × D/(D−1), 자유도 = 블록 − 1) 중 작은 쪽이다(같은 모의에서
10·14일 2.3~2.5%). 블록 20개 미만이면 구간에 'approximate' 표시도 붙는다.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import random
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, Sequence

from app.services.batch import crowd_replay_engine as engine_mod
from app.services.batch.crowd_replay_data import (
    ObsRecord,
    ReplayData,
    ReplayInputError,
    Problem,
    Travel,
    ZoneTimeline,
    band_index,
    ceil_minute,
    flag_stale,
    iso_utc,
    percentile,
    service_days_span,
    travel_matrix,
    zone_summaries,
)
from app.services.crowd.zone_evidence import (
    ZONE_FORECAST_MATCH_WINDOW,
    ZONE_NOW_WINDOW,
    ZoneDefinition,
    ZoneReading,
    zone_reading_is_current,
)
from app.services.engine_validation_metrics import GRADE_LABELS, student_t_975
from app.services.kst_calendar import KST, climatology, service_day

SCHEMA_VERSION = "crowd_dispersion_replay/2"
SUMMARY_SCHEMA_VERSION = "decision_quality_summary/3"
# 요약의 모집단 = V3 모집단(붐비는 출발지 중 대안 2곳 이상). crowd/decision_quality.py 가 같은 값을 요구한다.
SUMMARY_POPULATION = "crowded_origin_choice_feasible"

# ── 판정 기준(사전 등록) — 바꾸면 criteria_version 이 바뀐다 ─────────────────────────
CRITERIA: dict[str, Any] = {
    "crowded_band_min": 2,
    "truth_tolerance_rule": "per zone: max(5, median_cadence_minutes / 2) -> 5 (10-min Hongdae), 15 (30-min Jongno)",
    "truth_pair_max_skew_rule": "|observed_origin_truth - observed_alt_truth| <= max(tol_origin, tol_alt)",
    "travel": {
        "model": "walk_haversine_detour",
        "detour": 1.4,
        "speed_m_per_min": 66.67,
        "rounding": "ceil_minute",
        "max_tau_minutes": 60,
        "max_walk_minutes": 20,
        "engine_model": "router spot.travel.estimate_walking_route (straight x 1.18 / 66.67 m/min, round 0.1 min) "
                        "= get_walking_routes for Seoul centroids (outside the Gyeongju graph)",
        "eligibility": "alternative iff ROUTER minutes <= max_walk_minutes (router: route.duration_min > cap -> drop); "
                       "same set for every policy; origin with none -> skipped no_alternative_within_walk_cap",
        "uses": "router minutes/m -> walk cap + engine travel input; detour minutes (ceil) -> truth arrival t+tau, "
                "nearest/oracle tie-break, extra travel",
    },
    "v3": {
        "population": "crowded origin with >= 2 eligible alternatives (choice-feasible); decisions with one "
                      "alternative (engine == nearest == oracle by construction) are reported as forced agreement "
                      "and the pooled crowded contrast is descriptive only",
        "min_counts_unit": "min_n_crowded and min_disagree count distinct (origin, bucket) situations, "
                           "not decision moments",
        "headroom_population": "same as population",
        "min_diff": 0.1,
        "ci_low_strictly_above": 0.0,
        "min_n_crowded": 100,
        "min_crowded_days": 10,
        "min_crowded_episodes": 20,
        "min_disagree": 30,
        "min_disagree_days": 5,
        "headroom_min": 0.1,
    },
    "v4": {
        "lead_bin": "30 = lead in [15, 45) min",
        "min_paired": 100,
        "min_days": 10,
        "provider_exact_accuracy_not_lower": True,
    },
    "bootstrap": {
        "replicates": 2000,
        "seed": 20261101,
        "ci": 0.95,
        "method": "percentile_nearest_rank",
        "block": "service_day (KST date of t - 5h)",
        "approximate_label_below_blocks": 20,
        "max_empty_replicate_share": 0.01,
        "gate_low": "V3/V4 gate low = min(bootstrap lo, day-cluster ratio t lo with df = blocks - 1); "
                    "secondary contrasts (engine vs climatology/greedy/random) and their notes use the same gate low",
    },
    "decision_phases": {
        "rule": "per origin bucket b whose own row was fetched at f: t in {ceil_minute(f)} + {b + m for m in offsets}; "
                "if f > b + m wait until ceil_minute(f); equal t deduplicated (first phase wins); "
                "phase 0 = at the origin's own fetch; a moment where a newer origin row is already visible "
                "belongs to that newer bucket (skipped for the older one)",
        "offsets_minutes_by_cadence": {"10": [5, 10], "20": [10], "30": [10, 20]},
        "aged_out_rule": "a moment where the origin's own row is no longer current (> 30 min) while the next regular "
                         "row (next bucket within one cadence) has not been fetched yet is skipped as "
                         "origin_aged_out_before_next_row and not counted as a candidate; origin_not_current is "
                         "kept for real gaps",
    },
    "oracle": "best eligible alternative by gain then travel (moving forced, stay excluded); "
              "stay loss_vs_oracle = max(0, max_gain)",
    "v2": {
        "persistence_only_indistinguishable": "if the persistence_only ablation picks the same top-1 as the 'none' "
                                              "ablation on every decision it is reported as structurally "
                                              "indistinguishable, not as a measurement",
    },
    "climatology": {
        "key": "(zone, KST hour, day_type)",
        "day_type": "weekend_or_kr_holiday | weekday",
        "v3_choice_min_samples": 4,
        "trailing_only": True,
    },
    "stale_truth_run_min_buckets": 3,
    "special_days_descriptive": [
        "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-10-03",
        "2026-10-05", "2026-10-09", "2026-10-30", "2026-10-31",
    ],
}

# 엔진이 경로 예측 창(관측 + 90 + τ + 30 ≤ 관측 + 180분, Q2 의 반출 범위)을 넘지 않게 하는 상한.
DETOUR_SENSITIVITY = 1.18  # 엔진 자체의 그래프 밖 보정(spot/travel.FALLBACK_ROUTE_FACTOR) — 기술 통계
LAG_7D = timedelta(days=7)
PER_DAY_MAX = 60
CI_LABEL_APPROX = "approximate (blocks < 20)"
CI_LABEL_OK = "percentile_day_block"
PHASE_AT_FETCH = 0
POLICIES: tuple[str, ...] = (
    "engine", "nearest", "climatology_choice", "current_band_greedy", "random", "stay", "oracle", "engine_gated",
)
CONTRASTS: dict[str, str] = {
    "engine_minus_nearest": "nearest",
    "engine_minus_climatology": "climatology_choice",
    "engine_minus_greedy": "current_band_greedy",
    "engine_minus_random": "random",
}
ABLATIONS: tuple[str, ...] = ("persistence_only", "lagged_7d", "none")
FORBIDDEN_TEXT = re.compile("분산 효과|혼잡 감소|솔직|투명|확실|믿을 수 있")

NO_USERS_LIMIT = (
    "서울에는 NextSpot 사용자가 없다 — '한 사람이 옮겨도 혼잡은 변하지 않는다'는 가정 아래 고른 곳이 도착 때 덜 "
    "붐볐는지만 쟀다. 사람이 옮겨 붐빔이 줄었는지는 재지 않았다(경주 파일럿 P3-1)."
)
FIXED_LIMITS: tuple[str, ...] = (
    NO_USERS_LIMIT,
    "정답은 서울시 4등급(권역 단위, 장소마다 다른 기준)이다 — 등급 차이·MAE 는 등간격을 가정한 값이다.",
    "엔진은 라우터와 같은 이동(구역 중심 간 직선 × 1.18 ÷ 66.67 m/분)을 보고, 정답은 그보다 보수적인 도착 시각"
    "(직선 × 1.4, 분 올림)에서 잰다 — 실제 경로·구역 안 위치는 반영하지 않는다.",
    "대안은 라우터 이동으로 도보 상한 20분(라우터가 받는 최댓값) 안의 구역뿐이다 — 운영 경로가 내놓을 수 없는 곳은 "
    "어느 정책도 고르지 않는다. 상한 안 대안이 없는 출발지는 결정이 없다(decisions.skipped).",
    "대기는 엔진 비용 모델과 같은 구조의 모델 값이다 — 순환이라 판정에 쓰지 않는다.",
    "REPLACE_YN 은 일부 행에만 있다(구역별 비율은 inputs.replace_flags) — 나머지는 대체값을 거르지 못했다.",
    "날짜 블록 부트스트랩은 이웃한 날(날씨·행사)이 독립이라고 본다 — 블록 20개 미만이면 구간은 근사다. 판정 하한은 "
    "부트스트랩과 날짜 군집 t 구간 중 작은 쪽이다.",
    "결정 시각은 버킷마다 출발지 행을 받은 때 · +5 · +10분(30분 주기는 받은 때 · +10 · +20분)뿐이고 시각마다 같은 무게다 — "
    "고르게 들어오는 운영 요청보다 관측이 신선한 결정의 비중이 커서 지속 근거가 창에 드는 비율이 높게 나온다. 한 버킷의 "
    "결정들은 독립이 아니라 최소 표본은 서로 다른 (출발지·버킷)으로 센다.",
)
THIN_NOTE = "도보 상한 안 대안이 출발지마다 2곳 이하라 엔진은 먼 쪽을 고를 때만 가장 가까운 곳과 다르다 — 참고 결과다"
THIN_NOTE_SINGLE = (
    "도보 상한 안 대안이 출발지마다 1곳 이하라 엔진은 언제나 가장 가까운 곳과 같다 — V3 는 이 권역·이동 가정에서 잴 수 없다"
)
SKIP_NO_ELIGIBLE = "no_alternative_within_walk_cap"
SKIP_SUPERSEDED = "origin_row_superseded_by_newer_row"
SKIP_AGED_OUT = "origin_aged_out_before_next_row"
V2_PERSISTENCE_INDISTINGUISHABLE = (
    "persistence_only 는 모든 결정에서 근거 없음(none)과 같은 곳을 골랐다 — 결정 시각에 지속 근거가 도착 창에 들지 "
    "않았거나 순위를 움직이지 못했다는 뜻이라, 측정값으로 읽지 않는다"
)
V2_REFERENCE_TEXT = "경주 추정 모드에서 혼잡 항이 점수를 움직인 폭은 ≤ ~0.05 였다 — 다른 양이다(비교용 글로만)."


def criteria_version(criteria: Mapping[str, Any] = CRITERIA) -> str:
    text = json.dumps(criteria, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


# 재생 결과를 정하는 소스 — 보고서 run.source_version 은 이 파일들의 내용 해시다(줄바꿈은 LF 로 맞춘다).
REPLAY_SOURCE_FILES: tuple[str, ...] = (
    "app/services/batch/crowd_dispersion_replay.py",
    "app/services/batch/crowd_replay_data.py",
    "app/services/batch/crowd_replay_engine.py",
    "app/services/kst_calendar.py",
)
_API_ROOT = Path(__file__).resolve().parents[3]


def source_version(files: Sequence[str] = REPLAY_SOURCE_FILES, root: Path = _API_ROOT) -> str:
    """재생 모듈 소스의 sha256 앞 12자. git 상태와 무관하게 '어떤 코드로 돌렸나'를 남긴다."""
    digest = hashlib.sha256()
    for rel in files:
        digest.update(rel.encode("utf-8") + b"\0")
        digest.update((root / rel).read_bytes().replace(b"\r\n", b"\n"))
        digest.update(b"\0")
    return digest.hexdigest()[:12]


# ── 설정 ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ReplayConfig:
    cluster: str
    run_label: str = "pilot"
    detour: float = CRITERIA["travel"]["detour"]
    truth_tolerance_minutes: float | None = None
    forecasts_enabled: bool = True
    overrides: tuple[str, ...] = ()
    code_version: str | None = None
    sensitivity: bool = True
    ablations: bool = True


EngineFn = Callable[..., Awaitable[Any]]


def check_travel_config(zones: Sequence[ZoneDefinition], detour: float) -> dict[tuple[str, str], Travel]:
    """이동 행렬 + 상한 검사(최대 τ > 60분이면 반출 범위 증명이 깨진다 → 설정 오류)."""
    travel = CRITERIA["travel"]
    matrix = travel_matrix(zones, detour=detour, speed_m_per_min=travel["speed_m_per_min"])
    worst = max((leg.minutes for leg in matrix.values()), default=0)
    if worst > travel["max_tau_minutes"]:
        raise ReplayInputError([Problem(
            "<config>", None, "detour", "config_outside_export_horizon",
            f"최대 이동 {worst}분 > {travel['max_tau_minutes']}분 — 관측+90+τ+30 이 반출 범위(관측+3시간)를 넘는다",
        )])
    return matrix


# ── 결정 ──────────────────────────────────────────────────────────────────────


@dataclass
class Decision:
    origin: str
    bucket_at: datetime
    phase: int
    t: datetime
    t_nominal: datetime
    day: date
    delay_minutes: float
    b_now: int
    alternatives: tuple[str, ...]
    tau: dict[str, int]
    route: dict[str, float]
    origin_reading: ZoneReading
    readings: dict[str, ZoneReading | None]
    block: Any
    engine: Any = None
    choices: dict[str, str | None] = field(default_factory=dict)
    clim_fallback: bool = False
    random_draw: str | None = None
    ablations: dict[str, Any] = field(default_factory=dict)
    # 엔진에 준 이동 {대안: (분, m)} — 라우터 값. 비어 있으면(손으로 만든 결정) τ·route 를 쓴다.
    engine_travel: dict[str, tuple[float, float]] = field(default_factory=dict)

    def engine_travel_input(self) -> dict[str, tuple[float, float]]:
        if self.engine_travel:
            return dict(self.engine_travel)
        return {c: (float(self.tau[c]), self.route[c]) for c in self.alternatives}

    @property
    def crowded(self) -> bool:
        return self.b_now >= CRITERIA["crowded_band_min"]

    @property
    def choice_feasible(self) -> bool:
        """대안이 2곳 이상 — 1곳이면 엔진 = 가장 가까운 곳 = 오라클이 구성상 같다(V3 모집단에서 뺀다)."""
        return len(self.alternatives) >= 2

    @property
    def situation(self) -> tuple[str, datetime]:
        """같은 (출발지, 버킷) — 한 버킷의 여러 결정 시각은 한 상황이다(V3 최소 표본은 이것으로 센다)."""
        return (self.origin, self.bucket_at)

    @property
    def nearest(self) -> str:
        return self.choices["nearest"]  # type: ignore[return-value]


@dataclass
class Scored:
    decision: Decision
    b_origin: dict[str, int]
    b_alt: dict[str, int]
    gains: dict[str, int]
    offsets: list[float]
    skews: list[float]

    @property
    def max_gain(self) -> int:
        return max(self.gains.values())


@dataclass
class RunResult:
    decisions: list[Decision]
    candidates: int
    by_phase_candidates: Counter
    skipped: Counter
    delayed: list[float]
    alt_not_yet: int
    unscorable: Counter
    unscorable_crowded: Counter
    unscorable_by_origin: dict[str, Counter]
    per_day_candidates: Counter
    scored: list[Scored]


def _phases(cadence: float | None) -> list[int]:
    """버킷 뒤 고정 결정 시각(분). 주기 30분 이상 +10·+20, 20분 이상 +10, 그 밖(10분) +5·+10.

    주기의 마지막 시각(30분 주기 +30 · 20분 주기 +20)은 넣지 않는다 — 관측이 버킷보다 앞서면(실데이터: 버킷 =
    받은 시각의 10분 내림, 관측 ≤ 받은 시각) 그때 출발지 관측은 언제나 30분을 넘어 '지금'이 아니다(S4 검토 4차).
    """
    offsets = CRITERIA["decision_phases"]["offsets_minutes_by_cadence"]
    if cadence is not None and cadence >= 30:
        return list(offsets["30"])
    if cadence is not None and cadence >= 20:
        return list(offsets["20"])
    return list(offsets["10"])


def decision_moments(record: ObsRecord, cadence: float | None) -> list[tuple[int, datetime, datetime]]:
    """출발지 버킷 하나의 결정 시각들 → [(phase, t_nominal, t)] (t 오름차순, 같은 t 는 앞 phase 만).

    phase 0 = 출발지 자기 행을 받은 시각(분 올림) — 관측이 가장 신선한 때. 나머지는 버킷 + 고정 분이다.
    출발지 행이 그보다 늦게 왔으면 받은 시각(분 올림)까지 기다린다. 결정 주기 안에서 관측 나이가 고르게 퍼지게
    하려는 것이다(전에는 b+10 한 번 — 관측이 가장 낡은 때라 지속(persistence) 도착 근거가 한 번도 쓰이지 않았다).
    """
    at_fetch = ceil_minute(record.fetched_at)
    moments: list[tuple[int, datetime, datetime]] = [(PHASE_AT_FETCH, at_fetch, at_fetch)]
    for phase in _phases(cadence):
        t_nominal = record.bucket_at + timedelta(minutes=phase)
        t = at_fetch if record.fetched_at > t_nominal else t_nominal
        moments.append((phase, t_nominal, t))
    out: list[tuple[int, datetime, datetime]] = []
    seen: set[datetime] = set()
    for phase, t_nominal, t in sorted(moments, key=lambda m: (m[2], m[0])):
        if t in seen:
            continue
        seen.add(t)
        out.append((phase, t_nominal, t))
    return out


def eligible_alternatives(
    origin: str, zone_ids: Sequence[str], engine_travel: Mapping[tuple[str, str], Any], cap: float,
) -> tuple[str, ...]:
    """출발지에서 도보 상한 안의 대안(라우터 규칙: 분 > 상한이면 뺀다). 모든 정책이 이 집합에서 고른다.

    ``engine_travel`` 은 **라우터의** 이동(``crowd_replay_engine.router_travel_matrix``)이다 — 보수적 채점 이동(1.4)을
    넣으면 운영 라우터가 내는 대안을 뺀다(S4 검토 2차).
    """
    return tuple(z for z in zone_ids if z != origin and engine_travel[(origin, z)].minutes <= cap)


def _nearest(origin: str, alternatives: Sequence[str], tau: Mapping[str, int], route: Mapping[str, float]) -> str:
    return min(alternatives, key=lambda c: (tau[c], route[c], c))


def _scored_truth(
    decision: Decision, timelines: Mapping[str, ZoneTimeline], *, exclude_stale: bool
) -> tuple[Scored | None, str | None]:
    origin_tl = timelines[decision.origin]
    b_origin: dict[str, int] = {}
    b_alt: dict[str, int] = {}
    offsets: list[float] = []
    skews: list[float] = []
    for c in decision.alternatives:
        arrival = decision.t + timedelta(minutes=decision.tau[c])
        hit_o, why_o = origin_tl.truth(arrival, t=decision.t, exclude_stale=exclude_stale)
        if hit_o is None:
            return None, "truth_not_after_decision" if why_o == "not_after_decision" else "truth_missing_origin"
        alt_tl = timelines[c]
        hit_c, why_c = alt_tl.truth(arrival, t=decision.t, exclude_stale=exclude_stale)
        if hit_c is None:
            return None, "truth_not_after_decision" if why_c == "not_after_decision" else "truth_missing_alternative"
        skew = abs(hit_o.record.observed_at - hit_c.record.observed_at)
        if skew > max(origin_tl.tolerance, alt_tl.tolerance):
            return None, "truth_pair_skew"
        b_origin[c] = hit_o.record.band
        b_alt[c] = hit_c.record.band
        offsets += [abs(hit_o.offset_minutes), abs(hit_c.offset_minutes)]
        skews.append(skew.total_seconds() / 60.0)
    gains = {c: b_origin[c] - b_alt[c] for c in decision.alternatives}
    return Scored(decision, b_origin, b_alt, gains, offsets, skews), None


def persistence_eligible(reading: ZoneReading | None, t: datetime, engine_minutes: float) -> bool:
    """지속 근거의 시간 창(`congestion_evidence._zone_arrival`): 0 ≤ 도착 − 관측 ≤ 30분 그리고 0 ≤ t − 관측 ≤ 30분."""
    if reading is None or reading.level_band is None:
        return False
    age = t - reading.observed_at
    horizon = age + timedelta(minutes=engine_minutes)
    return timedelta(0) <= age <= ZONE_NOW_WINDOW and timedelta(0) <= horizon <= ZONE_NOW_WINDOW


def _lagged(reading: ZoneReading | None) -> ZoneReading | None:
    if reading is None:
        return None
    return replace(
        reading,
        observed_at=reading.observed_at + LAG_7D,
        fetched_at=(reading.fetched_at + LAG_7D) if reading.fetched_at is not None else None,
        forecast=tuple((target + LAG_7D, level, band) for target, level, band in reading.forecast),
    )


def _strip_forecast(reading: ZoneReading | None) -> ZoneReading | None:
    return replace(reading, forecast=()) if reading is not None else None


async def _run_decisions(
    data: ReplayData,
    travel: Mapping[tuple[str, str], Travel],
    engine: EngineFn,
    *,
    clim,
    seed: int,
    with_ablations: bool,
    engine_travel: Mapping[tuple[str, str], Any] | None = None,
) -> RunResult:
    """``travel`` = 채점 이동(정답 도착 시각), ``engine_travel`` = 라우터 이동(대안 자격 · 엔진 입력, 기본은 구역 중심 값)."""
    timelines = data.timelines
    zones = {z.zone_id: z for z in data.zones}
    zone_ids = sorted(zones)
    if engine_travel is None:
        engine_travel = engine_mod.router_travel_matrix(data.zones)
    first_fetch = min((r.fetched_at for r in data.records()), default=None)
    decisions: list[Decision] = []
    scored: list[Scored] = []
    skipped: Counter = Counter()
    unscorable: Counter = Counter()
    unscorable_crowded: Counter = Counter()
    unscorable_by_origin: dict[str, Counter] = defaultdict(Counter)
    by_phase_candidates: Counter = Counter()
    per_day_candidates: Counter = Counter()
    delayed: list[float] = []
    alt_not_yet = 0
    candidates = 0
    bucket_index = {
        zid: {r.bucket_at: r for r in timelines[zid].records} for zid in zone_ids
    }
    cap = CRITERIA["travel"]["max_walk_minutes"]
    for origin in zone_ids:
        timeline = timelines[origin]
        alternatives = eligible_alternatives(origin, zone_ids, engine_travel, cap)
        tau = {c: travel[(origin, c)].minutes for c in alternatives}
        route = {c: travel[(origin, c)].route_m for c in alternatives}
        engine_in = {c: (float(engine_travel[(origin, c)].minutes), float(engine_travel[(origin, c)].route_m))
                     for c in alternatives}
        seen_t: set[datetime] = set()
        last_phase = timedelta(minutes=max(_phases(timeline.cadence_minutes)))
        step = timedelta(minutes=timeline.cadence_minutes or 10)
        records = timeline.records
        for index, record in enumerate(records):
            following = next((r for r in records[index + 1:] if r.bucket_at > record.bucket_at), None)
            next_regular = following if following is not None and following.bucket_at - record.bucket_at <= step else None
            # 대기 = 출발지 행이 마지막 고정 시각(b + 최대 phase)보다 늦게 와, 고정 시각이 모두 받은 시각으로 밀린 것.
            last_fixed = record.bucket_at + last_phase
            delay = max(0.0, (ceil_minute(record.fetched_at) - last_fixed).total_seconds() / 60.0)
            if delay > 0:
                delayed.append(delay)
            for phase, t_nominal, t in decision_moments(record, timeline.cadence_minutes):
                if t in seen_t:  # 앞 버킷 행이 늦게 와 같은 t 가 이미 결정됐다
                    continue
                origin_reading = timeline.latest_reading(t)
                if origin_reading is not None and origin_reading.observed_at > record.observed_at:
                    # 이 버킷 행보다 새 출발지 행이 이미 보인다(늦게 온 행) — 그 결정은 새 버킷의 것이다. 여기서 세면
                    # 상황(출발지, 버킷)·phase 가 엉뚱하게 붙고 서로 다른 버킷 수가 부푼다. t 는 새 버킷 몫으로 남긴다.
                    skipped[SKIP_SUPERSEDED] += 1
                    continue
                block = engine_mod.origin_block(origin_reading, t)
                if (
                    block.original_congestion is None and origin_reading is not None
                    and origin_reading.observed_at == record.observed_at
                    and next_regular is not None and next_regular.fetched_at > t
                ):
                    # 자기 행이 30분을 넘겼는데 다음 정규 행이 아직 오지 않았다 — 수집 간격의 구조 문제라 결정 후보가
                    # 아니다. origin_not_current 는 실제로 빈 구간(다음 행이 없거나 한 주기 넘게 빔)만 뜻한다.
                    skipped[SKIP_AGED_OUT] += 1
                    continue
                seen_t.add(t)
                candidates += 1
                by_phase_candidates[phase] += 1
                per_day_candidates[service_day(t)] += 1
                if not alternatives:
                    skipped[SKIP_NO_ELIGIBLE] += 1
                    continue
                if origin_reading is None or block.original_congestion is None:
                    skipped["origin_not_current"] += 1
                    continue
                b_now = band_index(origin_reading.level_band)
                if b_now is None:
                    skipped["origin_band_unknown"] += 1
                    continue
                for c in alternatives:
                    own = bucket_index[c].get(record.bucket_at)
                    if own is not None and own.fetched_at > t:
                        alt_not_yet += 1
                readings = {c: timelines[c].latest_reading(t) for c in alternatives}
                decision = Decision(
                    origin=origin, bucket_at=record.bucket_at, phase=phase, t=t, t_nominal=t_nominal,
                    day=service_day(t), delay_minutes=delay, b_now=b_now, alternatives=alternatives,
                    tau=tau, route=route, origin_reading=origin_reading, readings=readings, block=block,
                    engine_travel=engine_in,
                )
                result, reason = _scored_truth(decision, timelines, exclude_stale=False)
                if result is None:
                    unscorable[reason] += 1
                    unscorable_crowded["crowded" if decision.crowded else "not_crowded"] += 1
                    unscorable_by_origin[origin][reason] += 1
                    continue
                full = await engine(
                    zones[origin], [zones[c] for c in alternatives],
                    origin_reading=origin_reading, alt_readings=readings, t=t,
                    travel=engine_in, block=block,
                )
                if full is None:  # origin_block 이 이미 걸렀다 — 엔진이 다르게 보면 그대로 센다
                    skipped["engine_origin_not_current"] += 1
                    continue
                decision.engine = full
                _choose_baselines(decision, timelines, clim, seed)
                if with_ablations and decision.crowded:
                    await _run_ablations(decision, zones, timelines, engine, first_fetch)
                decisions.append(decision)
                scored.append(result)
    return RunResult(
        decisions=decisions, candidates=candidates, by_phase_candidates=by_phase_candidates, skipped=skipped,
        delayed=delayed, alt_not_yet=alt_not_yet, unscorable=unscorable, unscorable_crowded=unscorable_crowded,
        unscorable_by_origin=dict(unscorable_by_origin), per_day_candidates=per_day_candidates, scored=scored,
    )


def _choose_baselines(decision: Decision, timelines: Mapping[str, ZoneTimeline], clim, seed: int) -> None:
    alts = decision.alternatives
    tau, route = decision.tau, decision.route
    nearest = _nearest(decision.origin, alts, tau, route)
    choices: dict[str, str | None] = {"engine": decision.engine.choice, "nearest": nearest, "stay": None}
    # 시간대 평균 선택 — 도착 시각의 칸, 결정 서비스 날짜보다 앞선 날만(trailing).
    values = {}
    for c in alts:
        arrival = decision.t + timedelta(minutes=tau[c])
        values[c] = clim.value_at(arrival, group=c, day=decision.day)
    if all(v is not None for v in values.values()):
        choices["climatology_choice"] = min(alts, key=lambda c: (values[c], tau[c], route[c], c))
    else:
        choices["climatology_choice"] = nearest
        decision.clim_fallback = True
    # 현재 등급 탐욕 — I_t 의 '지금' 관측 단계가 가장 낮은 곳(없으면 맨 뒤), 동점은 가까운 곳.
    def _greedy_key(c: str):
        reading = decision.readings.get(c)
        current = reading is not None and zone_reading_is_current(reading.observed_at, wall_now=decision.t)
        band = band_index(reading.level_band) if current else None
        return (0 if band is not None else 1, band if band is not None else 9, tau[c], route[c], c)

    choices["current_band_greedy"] = min(alts, key=_greedy_key)
    top = decision.engine.ranked[0] if decision.engine.ranked else None
    choices["engine_gated"] = (
        top.zone_id if top is not None and top.incentive_relief is not None and top.incentive_relief > 0 else None
    )
    decision.choices = choices
    rng = random.Random(f"{seed}:{decision.origin}:{decision.t.isoformat()}")
    decision.random_draw = rng.choice(list(alts))


async def _run_ablations(
    decision: Decision, zones: Mapping[str, ZoneDefinition], timelines: Mapping[str, ZoneTimeline],
    engine: EngineFn, first_fetch: datetime | None,
) -> None:
    alts = decision.alternatives
    travel = decision.engine_travel_input()
    origin = zones[decision.origin]
    alt_defs = [zones[c] for c in alts]
    variants: dict[str, dict[str, ZoneReading | None] | None] = {
        "persistence_only": {c: _strip_forecast(decision.readings[c]) for c in alts},
        "none": {},
    }
    if first_fetch is not None and decision.t - LAG_7D >= first_fetch:
        variants["lagged_7d"] = {c: _lagged(timelines[c].latest_reading(decision.t, lag=LAG_7D)) for c in alts}
    else:
        variants["lagged_7d"] = None
    for name in ABLATIONS:
        readings = variants[name]
        if readings is None:
            decision.ablations[name] = None
            continue
        decision.ablations[name] = await engine(
            origin, alt_defs, origin_reading=decision.origin_reading, alt_readings=readings, t=decision.t,
            travel=travel, block=decision.block,
        )


# ── 정책 결과 ─────────────────────────────────────────────────────────────────


def _wait(band: int, moment: datetime) -> float:
    from app.services.seoul_alternatives_service import crowd_wait_minutes, grade_level

    value = crowd_wait_minutes(grade_level(band), moment.astimezone(KST).hour)
    return float(value or 0.0)


def _target_outcome(sc: Scored, c: str) -> dict[str, float]:
    d = sc.decision
    gain = sc.gains[c]
    arrival = d.t + timedelta(minutes=d.tau[c])
    avoided = _wait(sc.b_origin[c], arrival) - _wait(sc.b_alt[c], arrival)
    extra = d.tau[c] - d.tau[d.nearest]
    out = {
        "hit": 1.0 if gain >= 1 else 0.0,
        "harm": 1.0 if gain <= -1 else 0.0,
        "gap": float(gain),
        "loss": float(sc.max_gain - gain),
        "hit_vs_now": 1.0 if sc.b_alt[c] <= d.b_now - 1 else 0.0,
        "avoided_wait": avoided,
        "extra_travel": float(extra),
        "net_model": avoided - extra,
    }
    for g in range(-3, 4):
        out[f"gain_{g}"] = 1.0 if gain == g else 0.0
    return out


def _stay_outcome(sc: Scored) -> dict[str, float | None]:
    d = sc.decision
    out: dict[str, float | None] = {
        # 오라클은 '옮김을 강제한 가장 좋은 대안'이라 머물기가 더 나으면(max_gain < 0) 손실을 0 으로 둔다.
        "hit": 0.0, "harm": 0.0, "gap": 0.0, "loss": float(max(0, sc.max_gain)),
        "hit_vs_now": 1.0 if sc.b_origin[d.nearest] <= d.b_now - 1 else 0.0,
        "avoided_wait": 0.0, "extra_travel": None, "net_model": None,
    }
    for g in range(-3, 4):
        out[f"gain_{g}"] = 1.0 if g == 0 else 0.0
    return out


def _oracle(sc: Scored) -> str:
    d = sc.decision
    return min(d.alternatives, key=lambda c: (-sc.gains[c], d.tau[c], d.route[c], c))


def policy_outcome(sc: Scored, policy: str, *, choice_override: str | None = None) -> dict[str, float | None]:
    d = sc.decision
    if policy == "random":
        parts = [_target_outcome(sc, c) for c in d.alternatives]
        return {key: sum(p[key] for p in parts) / len(parts) for key in parts[0]}
    if policy == "oracle":
        return _target_outcome(sc, _oracle(sc))
    if policy == "stay":
        return _stay_outcome(sc)
    choice = choice_override if choice_override is not None else d.choices.get(policy)
    if choice is None:
        return _stay_outcome(sc)
    return _target_outcome(sc, choice)


# ── 날짜 블록 집계 · 부트스트랩(CRN) ─────────────────────────────────────────────


class DaySeries:
    """날짜 블록별 (분자 합, 분모 합). 비율 = Σ분자 / Σ분모."""

    def __init__(self, n_days: int):
        self.num = [0.0] * n_days
        self.den = [0.0] * n_days

    def add(self, day_index: int, num: float, den: float = 1.0) -> None:
        self.num[day_index] += num
        self.den[day_index] += den

    @property
    def total_den(self) -> float:
        return math.fsum(self.den)

    def value(self) -> float | None:
        den = math.fsum(self.den)
        return math.fsum(self.num) / den if den > 0 else None

    def days(self) -> int:
        return sum(1 for d in self.den if d > 0)

    def without(self, excluded: set[int]) -> "DaySeries":
        out = DaySeries(len(self.num))
        for i in range(len(self.num)):
            if i not in excluded:
                out.num[i], out.den[i] = self.num[i], self.den[i]
        return out


class Bootstrap:
    """날짜 블록 부트스트랩. 재표본 색인은 실행마다 **한 번** 뽑아 모든 통계에 다시 쓴다(공통 난수)."""

    def __init__(self, n_days: int, *, replicates: int, seed: int, ci: float):
        rng = random.Random(seed)
        self.n_days = n_days
        self.ci_level = ci
        self.samples = [[rng.randrange(n_days) for _ in range(n_days)] for _ in range(replicates)] if n_days else []

    def interval(self, series: DaySeries) -> dict[str, Any]:
        values: list[float] = []
        empty = 0
        for sample in self.samples:
            den = math.fsum(series.den[i] for i in sample)
            if den <= 0:
                empty += 1
                continue
            values.append(math.fsum(series.num[i] for i in sample) / den)
        total = len(self.samples)
        empty_share = (empty / total) if total else 1.0
        if not values:
            return {"lo": None, "hi": None, "empty_share": empty_share, "replicates": 0}
        values.sort()
        tail = (1.0 - self.ci_level) / 2.0
        lo = values[max(1, math.ceil(tail * len(values))) - 1]
        hi = values[max(1, math.ceil((1.0 - tail) * len(values))) - 1]
        return {"lo": lo, "hi": hi, "empty_share": empty_share, "replicates": len(values)}


def ci_label(blocks: int) -> str:
    return CI_LABEL_APPROX if blocks < CRITERIA["bootstrap"]["approximate_label_below_blocks"] else CI_LABEL_OK


def day_cluster_t_interval(series: DaySeries, ci: float) -> dict[str, Any]:
    """비율 Σ분자/Σ분모 의 날짜 군집 t 구간(선형화 분산 × D/(D−1), 자유도 D−1). 표본이 있는 날이 2일 미만이면 None."""
    if not math.isclose(ci, 0.95):
        raise ValueError(f"t 구간은 95% 만 지원한다: {ci}")
    used = [i for i, den in enumerate(series.den) if den > 0]
    estimate = series.value()
    if estimate is None or len(used) < 2:
        return {"lo": None, "hi": None, "se": None, "df": None}
    total = math.fsum(series.den[i] for i in used)
    count = len(used)
    resid = [series.num[i] - estimate * series.den[i] for i in used]
    se = math.sqrt(count / (count - 1) * math.fsum(r * r for r in resid)) / total
    half = student_t_975(count - 1) * se
    return {"lo": estimate - half, "hi": estimate + half, "se": se, "df": count - 1}


def gate_low(boot_lo: float | None, t_lo: float | None) -> float | None:
    """판정 하한 = 부트스트랩·날짜 군집 t 하한 중 작은 쪽(어느 하나라도 없으면 None — 모듈 독스트링)."""
    if boot_lo is None or t_lo is None:
        return None
    return min(boot_lo, t_lo)


def gate_low_source(boot_lo: float | None, t_lo: float | None) -> str | None:
    """판정 하한을 정한 쪽 — 'day_cluster_t'(t 하한이 더 낮음) 또는 'bootstrap'. 하한이 없으면 None."""
    if boot_lo is None or t_lo is None:
        return None
    return "day_cluster_t" if t_lo < boot_lo else "bootstrap"


def gate_low_reason(boot_lo: float | None, t_lo: float | None) -> str:
    """미달 사유 토큰(쉼표·세미콜론 없음 — 화면이 토큰을 그 둘로 자른다)."""
    return f"gate_low<=0({gate_low_source(boot_lo, t_lo) or 'unknown'})"


@dataclass
class Population:
    name: str
    members: list[Scored]
    series: dict[str, DaySeries]

    @property
    def n(self) -> int:
        return len(self.members)


def _population_series(
    members: Sequence[Scored], day_index: Mapping[date, int], n_days: int,
) -> dict[str, DaySeries]:
    series: dict[str, DaySeries] = defaultdict(lambda: DaySeries(n_days))
    for sc in members:
        i = day_index[sc.decision.day]
        series["n"].add(i, 1.0)
        series["opportunity"].add(i, 1.0 if (sc.decision.crowded and sc.max_gain >= 1) else 0.0)
        series["opportunity_any"].add(i, 1.0 if sc.max_gain >= 1 else 0.0)
        hits: dict[str, float] = {}
        for policy in POLICIES:
            out = policy_outcome(sc, policy)
            hits[policy] = float(out["hit"])
            for key, value in out.items():
                if value is None:
                    continue
                series[f"{policy}.{key}"].add(i, float(value))
            series[f"{policy}.cond_hit"].add(i, float(out["hit"]) if sc.max_gain >= 1 else 0.0,
                                             1.0 if sc.max_gain >= 1 else 0.0)
        for name, other in CONTRASTS.items():
            series[f"{name}.hit"].add(i, hits["engine"] - hits[other])
    return series


def build_populations(scored: Sequence[Scored], day_index: Mapping[date, int], n_days: int) -> dict[str, Population]:
    """all · crowded(붐비는 출발지 전부 — 기술 통계) · crowded_choice(그중 대안 2곳 이상 — V3 모집단) ·
    measured_only(V3 모집단 중 엔진 후보가 모두 실측)."""
    crowded = [s for s in scored if s.decision.crowded]
    choice = [s for s in crowded if s.decision.choice_feasible]
    measured = [
        s for s in choice
        if s.decision.engine.ranked and all(c.scoring_mode == "measured_rules" for c in s.decision.engine.ranked)
    ]
    groups = {"all": list(scored), "crowded": crowded, "crowded_choice": choice, "measured_only": measured}
    return {
        name: Population(name, members, _population_series(members, day_index, n_days))
        for name, members in groups.items()
    }


# ── 판정 ──────────────────────────────────────────────────────────────────────

_EPS = 1e-12


def v3_verdict(
    *, diff: float | None, ci_low: float | None, ci_high: float | None, n: int, days: int, episodes: int,
    n_disagree: int, disagree_days: int, headroom: float | None, forecasts_enabled: bool, empty_share: float,
    blocks: int, ci_low_t: float | None = None, n_distinct: int | None = None,
    n_disagree_distinct: int | None = None,
) -> dict[str, Any]:
    """V3 판정(반올림 전 값). 차의 신뢰구간(엔진 − 가장 가까운 곳)으로 본다.

    판정 하한은 부트스트랩 하한과 날짜 군집 t 하한(``ci_low_t``) 중 작은 쪽이다(모듈 독스트링).
    최소 표본(n · 불일치)은 서로 다른 (출발지, 버킷) 상황 수로 센다(``n_distinct`` · ``n_disagree_distinct`` —
    없으면 결정 수). 한 버킷의 여러 결정 시각이 표본을 부풀리지 않게.
    """
    c = CRITERIA["v3"]
    low = gate_low(ci_low, ci_low_t)
    n_distinct = n if n_distinct is None else n_distinct
    n_disagree_distinct = n_disagree if n_disagree_distinct is None else n_disagree_distinct
    missing = []
    if n_distinct < c["min_n_crowded"]:
        missing.append(f"n_distinct<{c['min_n_crowded']}")
    if days < c["min_crowded_days"]:
        missing.append(f"crowded_days<{c['min_crowded_days']}")
    if episodes < c["min_crowded_episodes"]:
        missing.append(f"episodes<{c['min_crowded_episodes']}")
    if n_disagree_distinct < c["min_disagree"]:
        missing.append(f"n_disagree_distinct<{c['min_disagree']}")
    if disagree_days < c["min_disagree_days"]:
        missing.append(f"disagree_days<{c['min_disagree_days']}")
    if not forecasts_enabled:
        missing.append("forecasts_disabled")
    if empty_share > CRITERIA["bootstrap"]["max_empty_replicate_share"]:
        missing.append("empty_replicates>1%")
    if diff is None or ci_low is None:
        missing.append("no_estimate")
    elif low is None:
        missing.append("no_day_cluster_interval")
    # headroom 이 없으면(모집단이 비었다) 달성 가능 여부를 모른다 — None 이고 'unattainable' 사유도 붙이지 않는다.
    attainable = None if headroom is None else headroom + _EPS >= c["headroom_min"]
    if missing:
        status, reason = "insufficient", "insufficient: " + ", ".join(missing)
    else:
        diff_ok = diff + _EPS >= c["min_diff"]
        low_ok = low > c["ci_low_strictly_above"]
        status = "pass" if diff_ok and low_ok else "fail"
        # 미달이면 어느 조건이 막았는지 남긴다 — 화면의 95% CI 는 부트스트랩 구간이라, 판정 하한(t)이 막은 경우
        # 이유가 없으면 'CI 가 0 을 넘는데 미달' 로 읽힌다(S4 검토 2차).
        failed = []
        if not diff_ok:
            failed.append(f"diff<{c['min_diff']:.2f}")
        if not low_ok:
            failed.append(gate_low_reason(ci_low, ci_low_t))
        reason = "; ".join(failed) or None
    if attainable is False and status != "pass":
        reason = "unattainable_by_construction" if reason is None else f"{reason}; unattainable_by_construction"
    return {
        "status": status,
        "criterion": (f"엔진 − 가장 가까운 곳 적중률 ≥ {c['min_diff']:.2f} 그리고 차의 판정 하한 > 0 "
                      "(95% 날짜 블록 부트스트랩·날짜 군집 t 하한 중 작은 쪽)"),
        "diff": diff, "ci_low": ci_low, "ci_high": ci_high, "ci_label": ci_label(blocks),
        "ci_low_t": ci_low_t, "gate_low": low, "blocks": blocks,
        "n": n, "n_distinct": n_distinct, "days": days, "episodes": episodes, "n_disagree": n_disagree,
        "n_disagree_distinct": n_disagree_distinct, "disagree_days": disagree_days,
        "headroom": headroom, "criterion_attainable": attainable, "reason": reason,
        "mins_unit": "distinct (origin, bucket) situations",
        "mins": {
            "n_crowded": c["min_n_crowded"], "crowded_days": c["min_crowded_days"],
            "episodes": c["min_crowded_episodes"], "n_disagree": c["min_disagree"],
            "disagree_days": c["min_disagree_days"],
        },
    }


def v4_verdict(
    *, n_paired: int, days: int, mae_provider: float | None, mae_persistence: float | None,
    diff_ci_low: float | None, exact_provider: float | None, exact_persistence: float | None,
    forecasts_enabled: bool, empty_share: float = 0.0, blocks: int | None = None, diff_ci_low_t: float | None = None,
) -> dict[str, Any]:
    """V4 판정. 차의 하한은 부트스트랩·날짜 군집 t 하한 중 작은 쪽이다(``blocks`` 는 보고용)."""
    c = CRITERIA["v4"]
    low = gate_low(diff_ci_low, diff_ci_low_t)
    base = {"lead_bin": 30, "n": n_paired, "days": days, "mae_provider": mae_provider,
            "mae_persistence": mae_persistence}
    if not forecasts_enabled:
        return {**base, "status": "insufficient", "recommendation": "undetermined", "reason": "forecasts_disabled"}
    if n_paired == 0:
        return {**base, "status": "not_evaluable", "recommendation": "undetermined", "reason": "no_paired_sample"}
    missing = []
    if n_paired < c["min_paired"]:
        missing.append(f"n_paired<{c['min_paired']}")
    if days < c["min_days"]:
        missing.append(f"days<{c['min_days']}")
    if empty_share > CRITERIA["bootstrap"]["max_empty_replicate_share"]:
        missing.append("empty_replicates>1%")
    if missing:
        return {**base, "status": "insufficient", "recommendation": "undetermined",
                "reason": "insufficient: " + ", ".join(missing)}
    failed = []
    if not (mae_provider is not None and mae_persistence is not None and mae_provider < mae_persistence):
        failed.append("mae_provider>=mae_persistence")
    if not (low is not None and low > 0):
        failed.append(gate_low_reason(diff_ci_low, diff_ci_low_t))
    if not (exact_provider is not None and exact_persistence is not None
            and exact_provider + _EPS >= exact_persistence):
        failed.append("exact_provider<exact_persistence")
    passed = not failed
    return {**base, "status": "pass" if passed else "fail", "gate_low": low,
            "recommendation": "provider_forecast" if passed else "persistence",
            "reason": "; ".join(failed) or None}


# ── 보조 계산 ─────────────────────────────────────────────────────────────────


def _episodes(members: Sequence[Scored], timelines: Mapping[str, ZoneTimeline]) -> int:
    by_origin: dict[str, list[datetime]] = defaultdict(list)
    for sc in members:
        by_origin[sc.decision.origin].append(sc.decision.bucket_at)
    count = 0
    for origin, moments in by_origin.items():
        step = timedelta(minutes=timelines[origin].cadence_minutes or 10)
        moments.sort()
        previous = None
        for moment in moments:
            if previous is None or moment - previous > step:
                count += 1
            previous = moment
    return count


def _disagreement(crowded: Sequence[Scored]) -> tuple[list[Scored], dict[str, list[Scored]]]:
    members = [s for s in crowded if s.decision.choices["engine"] != s.decision.nearest]
    causes: dict[str, list[Scored]] = {"tier_availability": [], "tier_crowded_cutoff": [], "score_same_tier": []}
    for sc in members:
        causes[disagreement_cause(sc.decision)].append(sc)
    return members, causes


def disagreement_cause(decision: Decision) -> str:
    """엔진 1위 ≠ 가장 가까운 곳의 원인: 근거 유무 / 붐빔 강등 / 같은 등급 안 점수."""
    chosen = decision.engine.candidate(decision.choices["engine"])
    nearest = decision.engine.candidate(decision.nearest)
    if chosen is None or nearest is None or chosen.ranking_tier == nearest.ranking_tier:
        return "score_same_tier"
    if chosen.scoring_mode != nearest.scoring_mode or "measured_rules" not in (chosen.scoring_mode, nearest.scoring_mode):
        return "tier_availability"
    return "tier_crowded_cutoff"


def _hit_diff(members: Sequence[Scored]) -> float | None:
    if not members:
        return None
    total = math.fsum(
        policy_outcome(s, "engine")["hit"] - policy_outcome(s, "nearest")["hit"] for s in members  # type: ignore[operator]
    )
    return total / len(members)


def _kendall(order_a: Sequence[str], order_b: Sequence[str]) -> float | None:
    items = list(order_a)
    if len(items) < 3 or set(items) != set(order_b):
        return None
    pos_b = {z: i for i, z in enumerate(order_b)}
    concordant = discordant = 0
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            if pos_b[items[i]] < pos_b[items[j]]:
                concordant += 1
            else:
                discordant += 1
    pairs = concordant + discordant
    return (concordant - discordant) / pairs if pairs else None


def _err_stats(pairs: Sequence[tuple[int, float]]) -> dict[str, Any]:
    """(정답, 예측) 쌍 → MAE · 정확 · ±1 · 붐빔 놓침 · 과소/과대 · 혼동표(행 정답, 열 예측)."""
    if not pairs:
        return {"n": 0, "mae": None, "exact": None, "within_one": None, "top_band_under_call": None,
                "under_call": None, "over_call": None, "confusion": [[0] * 4 for _ in range(4)]}
    confusion = [[0] * 4 for _ in range(4)]
    abs_err, exact, within, under, over = [], 0, 0, 0, 0
    top_total = top_miss = 0
    for truth, pred in pairs:
        abs_err.append(abs(pred - truth))
        rounded = max(0, min(3, int(math.floor(pred + 0.5))))
        confusion[truth][rounded] += 1
        exact += rounded == truth
        within += abs(rounded - truth) <= 1
        under += rounded < truth
        over += rounded > truth
        if truth == 3:
            top_total += 1
            top_miss += rounded < 3
    n = len(pairs)
    return {
        "n": n, "mae": math.fsum(abs_err) / n, "exact": exact / n, "within_one": within / n,
        "top_band_under_call": (top_miss / top_total) if top_total else None,
        "under_call": under / n, "over_call": over / n, "confusion": confusion,
    }


def _lead_bin(lead_minutes: float) -> int:
    return int(math.floor((lead_minutes + 15.0) / 30.0)) * 30


def _nearest_point(reading: ZoneReading, target: datetime) -> tuple[datetime, int] | None:
    best = None
    for point_target, _level, band in reading.forecast:
        index = band_index(band)
        if index is None or point_target < reading.observed_at:
            continue
        gap = abs(point_target - target)
        if gap > ZONE_FORECAST_MATCH_WINDOW:
            continue
        key = (gap, point_target)
        if best is None or key < best[0]:
            best = (key, point_target, index)
    return (best[1], best[2]) if best is not None else None


class _TruthIndex:
    """V4 정답 조회 가속 — 관측 시각 정렬 색인으로 허용 오차 창만 훑는다."""

    def __init__(self, timeline: ZoneTimeline):
        from bisect import bisect_left, bisect_right

        self._bl, self._br = bisect_left, bisect_right
        self.timeline = timeline
        self.records = sorted(timeline.records, key=lambda r: (r.observed_at, r.fetched_at))
        self.times = [r.observed_at for r in self.records]

    def find(self, target: datetime, after: datetime, *, exclude_stale: bool) -> ObsRecord | None:
        tol = self.timeline.tolerance
        lo = self._bl(self.times, target - tol)
        hi = self._br(self.times, target + tol)
        best, best_key = None, None
        for record in self.records[lo:hi]:
            if record.observed_at <= after or record.replaced is True or (exclude_stale and record.stale):
                continue
            key = (abs(record.observed_at - target), -record.observed_at.timestamp(), -record.fetched_at.timestamp())
            if best_key is None or key < best_key:
                best, best_key = record, key
        return best


# ── V4 ────────────────────────────────────────────────────────────────────────


def compute_v4(
    data: ReplayData, scored: Sequence[Scored], clim, boot: Bootstrap, day_index: Mapping[date, int],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """(v4 블록, V4 판정)."""
    from app.services.congestion_evidence import own_model_zone_level

    n_days = boot.n_days
    indexes = {zid: _TruthIndex(tl) for zid, tl in data.timelines.items()}

    def _native(exclude_stale: bool) -> dict[int, list[tuple[date, int, int, int, float | None]]]:
        bins: dict[int, list] = defaultdict(list)
        for zid in sorted(data.timelines):
            index = indexes[zid]
            for issue in data.timelines[zid].records:
                if issue.replaced is True or issue.reading is None:
                    continue
                for point_target, _level, band in issue.reading.forecast:
                    pred = band_index(band)
                    if pred is None or point_target < issue.observed_at:
                        continue
                    lead = (point_target - issue.observed_at).total_seconds() / 60.0
                    truth = index.find(point_target, issue.observed_at, exclude_stale=exclude_stale)
                    if truth is None:
                        continue
                    day = service_day(issue.observed_at)
                    clim_value = clim.value_at(point_target, group=zid, day=day)
                    bins[_lead_bin(lead)].append((day, truth.band, issue.band, pred, clim_value))
        return bins

    native = _native(False) if data.forecasts_supplied else {}
    bins_out = []
    verdict_inputs: dict[str, Any] = {}
    for lead_bin in sorted(native):
        rows = native[lead_bin]
        pers = _err_stats([(t, float(p)) for _, t, p, _, _ in rows])
        prov = _err_stats([(t, float(q)) for _, t, _, q, _ in rows])
        clim_rows = [(t, c) for _, t, _, _, c in rows if c is not None]
        clim_stats = _err_stats(clim_rows)
        series = DaySeries(n_days)
        for day, t, p, q, _ in rows:
            if day in day_index:
                series.add(day_index[day], abs(p - t) - abs(q - t))
        ci = boot.interval(series)
        t_ci = day_cluster_t_interval(series, boot.ci_level)
        days = len({row[0] for row in rows})
        status_block = v4_verdict(
            n_paired=len(rows), days=days, mae_provider=prov["mae"], mae_persistence=pers["mae"],
            diff_ci_low=ci["lo"], exact_provider=prov["exact"], exact_persistence=pers["exact"],
            forecasts_enabled=data.forecasts_supplied, empty_share=ci["empty_share"],
            blocks=series.days(), diff_ci_low_t=t_ci["lo"],
        )
        entry = {
            "lead_bin": lead_bin, "lead_range_minutes": [lead_bin - 15, lead_bin + 15] if lead_bin else [0, 15],
            "status": status_block["status"], "n_paired": len(rows), "days": days,
            "mae": {"persistence": pers["mae"], "provider_forecast": prov["mae"], "trailing_climatology": clim_stats["mae"]},
            "exact": {"persistence": pers["exact"], "provider_forecast": prov["exact"], "trailing_climatology": clim_stats["exact"]},
            "within_one": {"persistence": pers["within_one"], "provider_forecast": prov["within_one"],
                           "trailing_climatology": clim_stats["within_one"]},
            "top_band_under_call": {"persistence": pers["top_band_under_call"],
                                    "provider_forecast": prov["top_band_under_call"],
                                    "trailing_climatology": clim_stats["top_band_under_call"]},
            "under_call": {"persistence": pers["under_call"], "provider_forecast": prov["under_call"]},
            "over_call": {"persistence": pers["over_call"], "provider_forecast": prov["over_call"]},
            "confusion": {"persistence": pers["confusion"], "provider_forecast": prov["confusion"],
                          "trailing_climatology": clim_stats["confusion"]},
            "trailing_climatology_coverage": (len(clim_rows) / len(rows)) if rows else None,
            "diff_ci": {"diff": (pers["mae"] - prov["mae"]) if rows else None, "lo": ci["lo"], "hi": ci["hi"],
                        "ci_label": ci_label(days), "empty_share": ci["empty_share"]},
        }
        bins_out.append(entry)
        if lead_bin == 30:
            verdict_inputs = {"rows": rows, "pers": pers, "prov": prov, "ci": ci, "days": days,
                              "blocks": series.days(), "t_lo": t_ci["lo"]}
    if verdict_inputs:
        verdict = v4_verdict(
            n_paired=len(verdict_inputs["rows"]), days=verdict_inputs["days"],
            mae_provider=verdict_inputs["prov"]["mae"], mae_persistence=verdict_inputs["pers"]["mae"],
            diff_ci_low=verdict_inputs["ci"]["lo"], exact_provider=verdict_inputs["prov"]["exact"],
            exact_persistence=verdict_inputs["pers"]["exact"], forecasts_enabled=data.forecasts_supplied,
            empty_share=verdict_inputs["ci"]["empty_share"], blocks=verdict_inputs["blocks"],
            diff_ci_low_t=verdict_inputs["t_lo"],
        )
        verdict["diff_ci"] = {"lo": verdict_inputs["ci"]["lo"], "hi": verdict_inputs["ci"]["hi"],
                              "lo_t": verdict_inputs["t_lo"], "ci_label": ci_label(verdict_inputs["days"])}
        verdict["exact_provider"] = verdict_inputs["prov"]["exact"]
        verdict["exact_persistence"] = verdict_inputs["pers"]["exact"]
    else:
        verdict = v4_verdict(
            n_paired=0, days=0, mae_provider=None, mae_persistence=None, diff_ci_low=None,
            exact_provider=None, exact_persistence=None, forecasts_enabled=data.forecasts_supplied,
        )

    # 결정 정렬(보고) — 엔진이 실제로 겪는 것(관측 지연 + 이동).
    engine_pairs, pers_pairs, prov_pairs, common = [], [], [], {"engine_rule": [], "persistence": [], "provider_forecast": []}
    for sc in scored:
        d = sc.decision
        for c in d.alternatives:
            truth = sc.b_alt[c]
            cand = d.engine.candidate(c)
            rule = band_index(cand.zone_arrival_band) if cand is not None else None
            reading = d.readings.get(c)
            pers = band_index(reading.level_band) if reading is not None else None
            arrival = d.t + timedelta(minutes=d.tau[c])
            point = _nearest_point(reading, arrival) if reading is not None and data.forecasts_supplied else None
            prov = point[1] if point is not None else None
            if rule is not None:
                engine_pairs.append((truth, float(rule)))
            if pers is not None:
                pers_pairs.append((truth, float(pers)))
            if prov is not None:
                prov_pairs.append((truth, float(prov)))
            if rule is not None and pers is not None and prov is not None:
                common["engine_rule"].append((truth, float(rule)))
                common["persistence"].append((truth, float(pers)))
                common["provider_forecast"].append((truth, float(prov)))

    def _brief(stats: dict[str, Any]) -> dict[str, Any]:
        return {"n": stats["n"], "mae": stats["mae"], "exact": stats["exact"], "within_one": stats["within_one"]}

    decision_aligned = {
        "own_coverage": {
            "engine_rule": _brief(_err_stats(engine_pairs)),
            "persistence": _brief(_err_stats(pers_pairs)),
            "provider_forecast": _brief(_err_stats(prov_pairs)),
        },
        "common_subset": {name: _brief(_err_stats(pairs)) for name, pairs in common.items()},
        "pairs_total": sum(len(sc.decision.alternatives) for sc in scored),
    }

    # 격자(보조) — T = 관측 + h, h = 10..60.
    grid = []
    if data.forecasts_supplied:
        for h in range(10, 61, 10):
            pers_rows, prov_rows = [], []
            for zid in sorted(data.timelines):
                index = indexes[zid]
                for issue in data.timelines[zid].records:
                    if issue.replaced is True or issue.reading is None:
                        continue
                    target = issue.observed_at + timedelta(minutes=h)
                    truth = index.find(target, issue.observed_at, exclude_stale=False)
                    if truth is None:
                        continue
                    pers_rows.append((truth.band, float(issue.band)))
                    point = _nearest_point(issue.reading, target)
                    if point is not None:
                        prov_rows.append((truth.band, float(point[1])))
            grid.append({
                "h_minutes": h, "n": len(pers_rows), "n_provider": len(prov_rows),
                "mae_persistence": _err_stats(pers_rows)["mae"], "mae_provider": _err_stats(prov_rows)["mae"],
            })

    stale_bins = _native(True) if data.forecasts_supplied else {}
    stale_30 = stale_bins.get(30, [])
    stale_excluded = {
        "lead_bin": 30, "n_paired": len(stale_30),
        "mae_persistence": _err_stats([(t, float(p)) for _, t, p, _, _ in stale_30])["mae"],
        "mae_provider": _err_stats([(t, float(q)) for _, t, _, q, _ in stale_30])["mae"],
    }
    own_available = any(
        own_model_zone_level({"id": z.zone_id}, data.period_from or datetime(2026, 1, 1, tzinfo=KST)) is not None
        for z in data.zones
    )
    block = {
        "native": {"bins": bins_out},
        "decision_aligned": decision_aligned,
        "grid": {"bins": grid, "note": "보조 — 판정에 쓰지 않는다(초안과 비교용)"},
        "own_model": "available" if own_available else "not_available",
        "stale_excluded": stale_excluded,
        "forecast": "supplied" if data.forecasts_supplied else "disabled",
    }
    return block, verdict


# ── 보고서 ────────────────────────────────────────────────────────────────────


def _round(value: Any) -> Any:
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        rounded = round(value, 4)
        return 0.0 if rounded == 0 else rounded
    if isinstance(value, dict):
        return {str(k): _round(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_round(v) for v in value]
    if isinstance(value, datetime):
        return iso_utc(value)
    if isinstance(value, date):
        return value.isoformat()
    return value


def _policy_block(pop: Population, boot: Bootstrap) -> dict[str, Any]:
    out = {}
    for policy in POLICIES:
        s = pop.series
        hit = s[f"{policy}.hit"]
        ci = boot.interval(hit)
        out[policy] = {
            "hit_rate": hit.value(),
            "hit_rate_ci": [ci["lo"], ci["hi"]],
            "harm_rate": s[f"{policy}.harm"].value(),
            "level_gap": s[f"{policy}.gap"].value(),
            "gain_distribution": {str(g): math.fsum(s[f"{policy}.gain_{g}"].num) for g in range(-3, 4)},
            "loss_vs_oracle": s[f"{policy}.loss"].value(),
            "conditional_hit_rate": s[f"{policy}.cond_hit"].value(),
            "hit_vs_now": s[f"{policy}.hit_vs_now"].value(),
            "hit_vs_now_n": int(s[f"{policy}.hit_vs_now"].total_den),
            "avoided_wait_model_min": s[f"{policy}.avoided_wait"].value(),
            "extra_travel_min": s[f"{policy}.extra_travel"].value() if f"{policy}.extra_travel" in s else None,
            "net_model_min": s[f"{policy}.net_model"].value() if f"{policy}.net_model" in s else None,
        }
    return out


def _contrast_block(pop: Population, boot: Bootstrap) -> dict[str, Any]:
    """정책 대비(엔진 − 기준선). ``gate_low`` = 부트스트랩·날짜 군집 t 하한 중 작은 쪽(V3 와 같은 규칙)."""
    out = {}
    for name in CONTRASTS:
        series = pop.series[f"{name}.hit"]
        ci = boot.interval(series)
        t_ci = day_cluster_t_interval(series, boot.ci_level)
        out[name] = {"diff": series.value(), "ci": [ci["lo"], ci["hi"]], "ci_label": ci_label(series.days()),
                     "ci_low_t": t_ci["lo"], "gate_low": gate_low(ci["lo"], t_ci["lo"]),
                     "empty_share": ci["empty_share"]}
    return out


def no_evidence_over(contrast: Mapping[str, Any]) -> bool:
    """대비의 판정 하한이 0 이하이거나 없으면 참 — '엔진이 이 기준선보다 낫다는 근거가 없다'."""
    low = contrast.get("gate_low")
    return low is None or low <= 0


def _paired_series(members: Sequence[Scored], day_index, n_days, value_fn) -> DaySeries:
    series = DaySeries(n_days)
    for sc in members:
        series.add(day_index[sc.decision.day], value_fn(sc))
    return series


def _v3_headline(scored: Sequence[Scored], timelines, boot, day_index, n_days) -> dict[str, Any]:
    """민감도용 V3 머리 숫자 — V3 와 같은 모집단(붐비는 출발지 · 대안 2곳 이상)."""
    crowded = [s for s in scored if s.decision.crowded and s.decision.choice_feasible]
    diff = _paired_series(
        crowded, day_index, n_days,
        lambda s: policy_outcome(s, "engine")["hit"] - policy_outcome(s, "nearest")["hit"],
    )
    ci = boot.interval(diff)
    return {
        "n": len(crowded), "days": diff.days(),
        "hit_engine": (math.fsum(policy_outcome(s, "engine")["hit"] for s in crowded) / len(crowded)) if crowded else None,
        "hit_nearest": (math.fsum(policy_outcome(s, "nearest")["hit"] for s in crowded) / len(crowded)) if crowded else None,
        "diff": diff.value(), "ci_low": ci["lo"], "ci_high": ci["hi"], "ci_label": ci_label(diff.days()),
    }


async def replay_async(
    data: ReplayData, config: ReplayConfig, *, engine: EngineFn | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """재생 실행 → (보고서 dict(반올림됨), 결정 추적 행). 판정은 반올림 전에 끝난다."""
    engine = engine or engine_mod.rank_alternatives
    criteria = CRITERIA
    seed = criteria["bootstrap"]["seed"]
    travel = check_travel_config(data.zones, config.detour)
    engine_travel = engine_mod.router_travel_matrix(data.zones)
    cap = criteria["travel"]["max_walk_minutes"]
    # 낡은 정답 표시는 판정 기준 상수의 길이로 다시 매긴다(기준이 바뀌면 여기만 따라온다).
    for timeline in data.timelines.values():
        for record in timeline.records:
            record.stale = False
        flag_stale(timeline.records, criteria["stale_truth_run_min_buckets"])
    clim_points = [r for r in data.records() if r.replaced is not True]
    clim = climatology(
        clim_points, value=lambda r: r.band, time=lambda r: r.observed_at, mode="trailing",
        min_samples=criteria["climatology"]["v3_choice_min_samples"], group=lambda r: r.zone_id,
    )
    days = service_days_span(data, service_day)
    day_index = {d: i for i, d in enumerate(days)}
    n_days = len(days)
    boot = Bootstrap(n_days, replicates=criteria["bootstrap"]["replicates"], seed=seed, ci=criteria["bootstrap"]["ci"])

    run = await _run_decisions(data, travel, engine, clim=clim, seed=seed, with_ablations=config.ablations,
                               engine_travel=engine_travel)
    for sc in run.scored:  # 결정 시각이 기간 끝을 넘으면(지연) 블록을 늘리지 않고 마지막 날에 둔다
        if sc.decision.day not in day_index:
            raise ReplayInputError([Problem("<replay>", None, None, "decision_outside_day_span", str(sc.decision.day))])
    pops = build_populations(run.scored, day_index, n_days)
    crowded = pops["crowded"]
    # V3 모집단 = 붐비는 출발지 중 대안 2곳 이상(선택이 있는 결정). 대안 1곳이면 엔진 = 가장 가까운 곳 = 오라클이라
    # 차가 구성상 0 — 섞으면 차가 그 비율만큼 묽어진다(홍대: 합정역·연남동 출발). 섞은 차는 기술 통계로만 낸다.
    choice = pops["crowded_choice"]
    disagree, causes = _disagreement(choice.members)
    episodes = _episodes(choice.members, data.timelines)
    choice_days = choice.series["n"].days()
    crowded_days = crowded.series["n"].days()
    disagree_days = len({s.decision.day for s in disagree})
    contrast = choice.series["engine_minus_nearest.hit"]
    contrast_ci = boot.interval(contrast)
    contrast_t = day_cluster_t_interval(contrast, boot.ci_level)
    oracle_hit = choice.series["oracle.hit"].value()
    nearest_hit = choice.series["nearest.hit"].value()
    headroom = (oracle_hit - nearest_hit) if oracle_hit is not None and nearest_hit is not None else None
    v3 = v3_verdict(
        diff=contrast.value(), ci_low=contrast_ci["lo"], ci_high=contrast_ci["hi"], n=choice.n,
        days=choice_days, episodes=episodes, n_disagree=len(disagree), disagree_days=disagree_days,
        headroom=headroom, forecasts_enabled=data.forecasts_supplied and config.forecasts_enabled,
        empty_share=contrast_ci["empty_share"], blocks=choice_days, ci_low_t=contrast_t["lo"],
        n_distinct=len({s.decision.situation for s in choice.members}),
        n_disagree_distinct=len({s.decision.situation for s in disagree}),
    )
    forced_n = crowded.n - choice.n
    pooled = crowded.series["engine_minus_nearest.hit"]
    pooled_ci = boot.interval(pooled)
    v3["population"] = "crowded_choice_feasible"
    v3["forced_agreement"] = {"n": forced_n, "share": (forced_n / crowded.n) if crowded.n else None}
    v3["pooled_crowded"] = {"n": crowded.n, "diff": pooled.value(), "ci": [pooled_ci["lo"], pooled_ci["hi"]],
                            "use": "descriptive"}

    populations_out: dict[str, Any] = {}
    for name, pop in pops.items():
        populations_out[name] = {
            "n": pop.n, "days": pop.series["n"].days(),
            "opportunity_rate": pop.series["opportunity"].value() if name == "all" else pop.series["opportunity_any"].value(),
            "policies": _policy_block(pop, boot),
            "contrasts": _contrast_block(pop, boot),
        }
    populations_out["crowded_choice"]["disagreement"] = {
        "n": len(disagree), "n_distinct": v3["n_disagree_distinct"], "days": disagree_days,
        "rate": (len(disagree) / choice.n) if choice.n else None,
        "causes": {name: {"n": len(members), "diff": _hit_diff(members)} for name, members in causes.items()},
    }
    for name, pop in (("crowded", crowded), ("crowded_choice", choice)):
        populations_out[name]["climatology_fallback_share"] = (
            sum(1 for s in pop.members if s.decision.clim_fallback) / pop.n if pop.n else None
        )

    # 결정 요약
    offsets = [o for s in run.scored for o in s.offsets]
    skews = [k for s in run.scored for k in s.skews]
    per_day_scorable = Counter(s.decision.day for s in run.scored)
    per_day_crowded = Counter(s.decision.day for s in crowded.members)
    scored_days = [d for d in days if per_day_scorable.get(d, 0) > 0]
    by_phase: dict[str, Any] = {}
    for phase in sorted(run.by_phase_candidates):
        members = [s for s in choice.members if s.decision.phase == phase]
        by_phase[str(phase)] = {
            "candidates": run.by_phase_candidates[phase],
            "scorable": sum(1 for s in run.scored if s.decision.phase == phase),
            "crowded": sum(1 for s in crowded.members if s.decision.phase == phase),
            "crowded_choice": len(members),
            "hit_engine": (math.fsum(policy_outcome(s, "engine")["hit"] for s in members) / len(members)) if members else None,
            "hit_nearest": (math.fsum(policy_outcome(s, "nearest")["hit"] for s in members) / len(members)) if members else None,
        }
    decisions_out = {
        "candidates": run.candidates,
        "phase_rule": CRITERIA["decision_phases"]["rule"],
        "by_phase": by_phase,
        "distinct_situations": {"scorable_all": len({s.decision.situation for s in run.scored}),
                                "crowded": len({s.decision.situation for s in crowded.members}),
                                "crowded_choice": v3["n_distinct"]},
        "delayed_to_origin_fetch": {"n": len(run.delayed), "p99_minutes": percentile(run.delayed, 0.99)},
        "alt_own_bucket_not_yet_available": run.alt_not_yet,
        "skipped": dict(sorted(run.skipped.items())),
        "scorable_all": len(run.scored),
        "scorable_crowded": crowded.n,
        "scorable_crowded_choice": choice.n,
        "crowded_days": crowded_days,
        "crowded_choice_days": choice_days,
        "crowded_choice_episodes": episodes,
        "unscorable": {
            **dict(sorted(run.unscorable.items())),
            "by_crowded": {"crowded": run.unscorable_crowded.get("crowded", 0),
                           "not_crowded": run.unscorable_crowded.get("not_crowded", 0)},
            "by_origin": {o: dict(sorted(c.items())) for o, c in sorted(run.unscorable_by_origin.items())},
        },
        "truth_offset_minutes": {"p50": percentile(offsets, 0.5), "p90": percentile(offsets, 0.9)},
        "pair_skew_minutes": {"p50": percentile(skews, 0.5), "p90": percentile(skews, 0.9)},
        "per_day": [
            {"day": d.isoformat(), "candidates": run.per_day_candidates.get(d, 0),
             "scorable": per_day_scorable.get(d, 0), "crowded": per_day_crowded.get(d, 0)}
            for d in days
        ][:PER_DAY_MAX],
        "per_day_truncated": len(days) > PER_DAY_MAX,
        # 기간은 잘리지 않은 날 목록에서 센다(per_day 는 직렬화할 때만 앞 60일로 자른다).
        "scored_period": {"first_day": scored_days[0].isoformat() if scored_days else None,
                          "last_day": scored_days[-1].isoformat() if scored_days else None,
                          "days": len(scored_days)},
    }

    # 출발지별
    names = {z.zone_id: z.name for z in data.zones}
    per_origin = []
    for zone in data.zones:
        members = [s for s in crowded.members if s.decision.origin == zone.zone_id]
        all_members = [s for s in run.scored if s.decision.origin == zone.zone_id]
        unscorable_n = sum(run.unscorable_by_origin.get(zone.zone_id, Counter()).values())
        eligible = set(eligible_alternatives(zone.zone_id, sorted(names), engine_travel, cap))
        alts = [z for z in data.zones if z.zone_id in eligible]
        nearest_zone = min(alts, key=lambda z: (travel[(zone.zone_id, z.zone_id)].minutes,
                                                travel[(zone.zone_id, z.zone_id)].route_m, z.zone_id)) if alts else None
        per_origin.append({
            "origin": zone.name,
            "eligible_alternatives": [z.name for z in alts],
            "choice_feasible": len(alts) >= 2,
            "nearest_zone": nearest_zone.name if nearest_zone else None,
            "n_crowded": len(members),
            "n_disagree": sum(1 for s in members if s.decision.choices["engine"] != s.decision.nearest),
            "hit_rate_engine": (math.fsum(policy_outcome(s, "engine")["hit"] for s in members) / len(members)) if members else None,
            "hit_rate_nearest": (math.fsum(policy_outcome(s, "nearest")["hit"] for s in members) / len(members)) if members else None,
            "opportunity_rate": (sum(1 for s in members if s.max_gain >= 1) / len(members)) if members else None,
            "unscorable_rate": (unscorable_n / (unscorable_n + len(all_members))) if (unscorable_n + len(all_members)) else None,
        })

    # 엔진 진단(V3 모집단 — 붐비는 출발지 · 대안 2곳 이상)
    mode_counts: Counter = Counter()
    basis_counts: Counter = Counter()
    basis_mix: Counter = Counter()
    pers_pairs = pers_eligible = 0
    for sc in choice.members:
        d = sc.decision
        chosen = d.engine.candidate(d.choices["engine"])
        if chosen is not None:
            mode_counts[chosen.scoring_mode or "none"] += 1
            basis_counts[chosen.congestion_arrival_basis or "none"] += 1
        for cand in d.engine.ranked:
            basis_mix[cand.congestion_arrival_basis or "none"] += 1
        travel_in = d.engine_travel_input()
        for c in d.alternatives:
            pers_pairs += 1
            pers_eligible += persistence_eligible(d.readings.get(c), d.t, travel_in[c][0])
    equals_nearest = (
        sum(1 for s in choice.members if s.decision.choices["engine"] == s.decision.nearest) / choice.n
        if choice.n else None
    )
    engine_diag = {
        "population": "crowded_choice",
        "scoring_mode_counts": dict(sorted(mode_counts.items())),
        "arrival_basis_counts": dict(sorted(basis_counts.items())),
        "arrival_basis_all_candidates": dict(sorted(basis_mix.items())),
        # 지속 근거가 시간 창(0 ≤ 도착 − 관측 ≤ 30분 · 0 ≤ t − 관측 ≤ 30분)에 드는 (결정, 대안) 비율 — 실제로 지속이
        # 쓰였는지는 arrival_basis_* 가 말한다(예보가 도착에 더 가까우면 예보가 이긴다).
        "persistence_eligible_share": (pers_eligible / pers_pairs) if pers_pairs else None,
        "persistence_eligible_pairs": pers_pairs,
        "engine_without_measured_evidence_rate": (
            sum(v for k, v in mode_counts.items() if k != "measured_rules") / choice.n if choice.n else None
        ),
        "engine_equals_nearest_rate": equals_nearest,
        "delayed_to_origin_fetch": len(run.delayed),
        "alt_own_bucket_not_yet_available": run.alt_not_yet,
    }

    # V2
    v2 = _compute_v2(choice.members, boot, day_index, n_days, basis_mix, config.ablations)

    # V4
    v4_block, v4 = compute_v4(data, run.scored, clim, boot, day_index)

    # 영향
    influence = _influence(choice.members, boot, day_index, n_days, days)

    # 민감도
    sensitivity: dict[str, Any] = {}
    stale_scored = []
    for sc in run.scored:
        rescored, _ = _scored_truth(sc.decision, data.timelines, exclude_stale=True)
        if rescored is not None:
            stale_scored.append(rescored)
    sensitivity["stale_excluded"] = {
        "v3": _v3_headline(stale_scored, data.timelines, boot, day_index, n_days),
        "v4": v4_block["stale_excluded"],
    }
    if config.sensitivity:
        try:
            travel_118 = check_travel_config(data.zones, DETOUR_SENSITIVITY)
            run_118 = await _run_decisions(data, travel_118, engine, clim=clim, seed=seed, with_ablations=False,
                                           engine_travel=engine_travel)
            sensitivity["detour_1_18"] = {"detour": DETOUR_SENSITIVITY,
                                          **_v3_headline(run_118.scored, data.timelines, boot, day_index, n_days)}
        except ReplayInputError:
            sensitivity["detour_1_18"] = None
    else:
        sensitivity["detour_1_18"] = None

    zone_ids_all = sorted(names)
    eligible_counts = [
        len(eligible_alternatives(o, zone_ids_all, engine_travel, cap)) for o in zone_ids_all
    ]
    alternatives_per_origin = max(eligible_counts, default=0)
    thin = alternatives_per_origin <= 2
    verdicts = {
        "V2": {"status": "report", "share_crowd_gt_travel": v2["crowd_vs_travel"]["share_crowd_gt_travel"]},
        "V3": v3,
        "V4": v4,
    }
    zones_out = zone_summaries(data)
    report = {
        "schema_version": SCHEMA_VERSION,
        "cluster": data.cluster,
        "zones": zones_out,
        "inputs": data.inputs,
        "config": {
            "period": {
                "from": iso_utc(data.period_from), "to": iso_utc(data.period_to),
                "from_kst_date": data.period_from.astimezone(KST).date().isoformat() if data.period_from else None,
                "to_kst_date": data.period_to.astimezone(KST).date().isoformat() if data.period_to else None,
            },
            "decision_rule": (
                "출발지 버킷 b 마다 t = 출발지 자기 행을 받은 시각(분 올림) · b + 5 · b + 10분(30분 주기는 받은 시각 · "
                "+10 · +20분), 고정 시각보다 행이 늦으면 받은 시각까지 기다림 · 같은 t 는 한 번 · 출발지가 "
                "'지금'(30분)이 아니면 결정 없음(다음 정규 행 전에 낡은 것은 origin_aged_out_before_next_row 로 따로) · "
                "엔진 1위 = SPOT 정렬 키 최소"
            ),
            "info_set_rule": "fetched_at <= t 인 행만, 구역별 bucket_at >= t − 2h 최신순(운영 _read_latest_rows 와 같음)",
            "truth_rule": "도착 t+τ 에 가장 가까운 관측, t 에 보이던 마지막 관측보다 뒤 · t 뒤에 받음 · |오차| ≤ 허용 오차, 동점은 늦은 것",
            "truth_tolerance_minutes": {z["name"]: z["truth_tolerance_minutes"] for z in zones_out},
            "crowded_band_min": criteria["crowded_band_min"],
            "v3_population": criteria["v3"]["population"],
            "oracle_rule": "오라클 = 가장 좋은 대안(옮김 강제 — 머물기는 후보가 아니다). 머물기의 오라클 대비 손실은 "
                           "max(0, 최대 이득)",
            "travel": {"model": "haversine_detour_walk", "detour": config.detour,
                       "speed_m_per_min": criteria["travel"]["speed_m_per_min"], "rounding": "ceil_minute",
                       "max_walk_minutes": cap,
                       "engine_model": "router_estimate_walking_route (x1.18, round 0.1 min)",
                       "uses": criteria["travel"]["uses"]},
            "engine": {
                "path": ("recommendations.build_candidate_evidence -> spot.score.calculate_spot_score -> "
                         "spot.ranking.spot_ranking_sort_key"),
                "region": "seoul", "preference": "neutral", "facility_type": "attraction", "coupon_rate": 0,
            },
            "bootstrap": {"block": "service_day_kst_05h", "replicates": criteria["bootstrap"]["replicates"],
                          "seed": seed, "ci": criteria["bootstrap"]["ci"], "blocks_total": n_days},
            "code_version": config.code_version,
        },
        "travel_matrix": [
            {"from": names[o], "to": names[c], "straight_m": leg.straight_m, "route_m": leg.route_m,
             "minutes": leg.minutes, "engine_minutes": engine_travel[(o, c)].minutes,
             "engine_route_m": engine_travel[(o, c)].route_m,
             "within_walk_cap": engine_travel[(o, c)].minutes <= cap}
            for (o, c), leg in sorted(travel.items())
        ],
        "decisions": decisions_out,
        "populations": populations_out,
        "per_origin": per_origin,
        "engine_diagnostics": engine_diag,
        "v2": v2,
        "v4": v4_block,
        "verdicts": verdicts,
        "thin_cluster": {"flag": thin, "alternatives_per_origin": alternatives_per_origin,
                         "note": (THIN_NOTE_SINGLE if alternatives_per_origin <= 1 else THIN_NOTE) if thin else None},
        "limits": list(FIXED_LIMITS),
        "run": {"run_label": config.run_label, "criteria_version": criteria_version(), "criteria": criteria,
                "code_version": config.code_version, "source_version": source_version(),
                "overrides": list(config.overrides)},
        "influence": influence,
        "sensitivity": sensitivity,
    }
    trace = _trace_rows(run.scored, names)
    return _round(report), trace


def _compute_v2(
    crowded: Sequence[Scored], boot: Bootstrap, day_index, n_days, basis_mix: Counter, enabled: bool,
) -> dict[str, Any]:
    from app.services.spot.score import INCENTIVE_COUPON_SHARE, W2, W3

    ablations_out: dict[str, Any] = {}
    kendall: dict[str, list[float]] = defaultdict(list)
    for name in ABLATIONS:
        members = [s for s in crowded if s.decision.ablations.get(name) is not None] if enabled else []
        if not members:
            ablations_out[name] = {"n": 0, "excluded": len(crowded), "top1_changed_rate": None, "hit_rate": None,
                                   "hit_rate_full": None, "diff_vs_full": None, "ci": [None, None]}
            continue
        changed = 0
        series = DaySeries(n_days)
        hits = []
        full_hits = []
        for sc in members:
            alt = sc.decision.ablations[name]
            choice = alt.choice
            changed += choice != sc.decision.choices["engine"]
            hit_alt = float(policy_outcome(sc, "engine", choice_override=choice)["hit"])
            hit_full = float(policy_outcome(sc, "engine")["hit"])
            hits.append(hit_alt)
            full_hits.append(hit_full)
            series.add(day_index[sc.decision.day], hit_alt - hit_full)
            full_order = [c.zone_id for c in sc.decision.engine.ranked]
            alt_order = [c.zone_id for c in alt.ranked]
            tau_k = _kendall(full_order, alt_order)
            if tau_k is not None:
                kendall[name].append(tau_k)
        ci = boot.interval(series)
        ablations_out[name] = {
            "n": len(members), "excluded": len(crowded) - len(members),
            "top1_changed_rate": changed / len(members),
            "hit_rate": math.fsum(hits) / len(hits), "hit_rate_full": math.fsum(full_hits) / len(full_hits),
            "diff_vs_full": series.value(), "ci": [ci["lo"], ci["hi"]], "ci_label": ci_label(series.days()),
        }
    ablations_out["lagged_7d"]["label"] = "시간 이동 근거(7일 전 같은 시각)"
    for name in ABLATIONS:
        ablations_out[name]["status"] = "measured" if ablations_out[name]["n"] else "not_run"
    paired = [s for s in crowded
              if s.decision.ablations.get("persistence_only") is not None and s.decision.ablations.get("none") is not None]
    if enabled and paired and all(
        s.decision.ablations["persistence_only"].choice == s.decision.ablations["none"].choice for s in paired
    ):
        # 예보를 뺀 근거가 근거를 모두 뺀 것과 모든 결정에서 같은 1위 — 측정이 아니라 구성상 구별이 안 된다는 뜻이다.
        ablations_out["persistence_only"]["status"] = "structurally_indistinguishable"
        ablations_out["persistence_only"]["note"] = V2_PERSISTENCE_INDISTINGUISHABLE
    crowd_terms, travel_terms = [], []
    for sc in crowded:
        ranked = sc.decision.engine.ranked
        if len(ranked) < 2:
            continue
        a, b = ranked[0], ranked[1]
        d_wait = (a.ranking_wait_time or 0.0) - (b.ranking_wait_time or 0.0)
        d_relief = (a.incentive_relief or 0.0) - (b.incentive_relief or 0.0)
        crowd_terms.append(abs(W2 * d_wait / 60.0 + W3 * (1.0 - INCENTIVE_COUPON_SHARE) * d_relief))
        travel_terms.append(W2 * abs(a.travel_time - b.travel_time) / 60.0)
    share = (
        sum(1 for c, t in zip(crowd_terms, travel_terms) if c > t) / len(crowd_terms) if crowd_terms else None
    )
    kendall_out = (
        {name: (math.fsum(v) / len(v)) for name, v in sorted(kendall.items()) if v} or None
    )
    return {
        "population": "crowded_choice",
        "ablations": ablations_out,
        "crowd_vs_travel": {
            "n": len(crowd_terms), "share_crowd_gt_travel": share,
            "crowd_p50": percentile(crowd_terms, 0.5), "crowd_p90": percentile(crowd_terms, 0.9),
            "travel_p50": percentile(travel_terms, 0.5), "travel_p90": percentile(travel_terms, 0.9),
        },
        "kendall_tau": kendall_out,
        "basis_mix": dict(sorted(basis_mix.items())),
        "reference_text": V2_REFERENCE_TEXT,
    }


def _influence(crowded: Sequence[Scored], boot: Bootstrap, day_index, n_days, days: Sequence[date]) -> dict[str, Any]:
    if not crowded:
        return {"per_day_contribution": [], "lodo_diff": {"min": None, "max": None},
                "special_days_excluded": {"diff": None, "ci": [None, None], "n": 0}}
    series = _paired_series(
        crowded, day_index, n_days,
        lambda s: policy_outcome(s, "engine")["hit"] - policy_outcome(s, "nearest")["hit"],
    )
    total_n = series.total_den
    contributions = [
        {"day": days[i].isoformat(), "diff_contribution": series.num[i] / total_n}
        for i in range(n_days) if series.den[i] > 0
    ]
    if len(contributions) > 60:
        keep = sorted(contributions, key=lambda r: (-abs(r["diff_contribution"]), r["day"]))[:60]
        contributions = sorted(keep, key=lambda r: r["day"])
    lodo = [series.without({i}).value() for i in range(n_days) if series.den[i] > 0]
    lodo = [v for v in lodo if v is not None]
    special = {date.fromisoformat(d) for d in CRITERIA["special_days_descriptive"]}
    excluded = {day_index[d] for d in special if d in day_index}
    without = series.without(excluded)
    ci = boot.interval(without)
    return {
        "per_day_contribution": contributions,
        "lodo_diff": {"min": min(lodo) if lodo else None, "max": max(lodo) if lodo else None},
        "special_days_excluded": {"diff": without.value(), "ci": [ci["lo"], ci["hi"]], "n": int(without.total_den),
                                  "days_excluded": sorted(d.isoformat() for d in special if d in day_index)},
    }


TRACE_COLUMNS: tuple[str, ...] = (
    "origin", "t_utc", "phase", "service_day", "delay_minutes", "b_now", "crowded", "engine", "nearest",
    "climatology_choice", "current_band_greedy", "engine_gated", "random_draw", "oracle", "gains",
    "engine_scoring_modes", "engine_basis",
)


def _trace_rows(scored: Sequence[Scored], names: Mapping[str, str]) -> list[dict[str, Any]]:
    rows = []
    for sc in scored:
        d = sc.decision

        def _n(zone_id: str | None) -> str:
            return names.get(zone_id, "") if zone_id else "stay"

        rows.append({
            "origin": names[d.origin], "t_utc": iso_utc(d.t), "phase": d.phase, "service_day": d.day.isoformat(),
            "delay_minutes": d.delay_minutes, "b_now": d.b_now, "crowded": int(d.crowded),
            "engine": _n(d.choices["engine"]), "nearest": _n(d.nearest),
            "climatology_choice": _n(d.choices["climatology_choice"]),
            "current_band_greedy": _n(d.choices["current_band_greedy"]),
            "engine_gated": _n(d.choices["engine_gated"]), "random_draw": _n(d.random_draw),
            "oracle": _n(_oracle(sc)),
            "gains": ";".join(f"{names[c]}={sc.gains[c]}" for c in d.alternatives),
            "engine_scoring_modes": ";".join(f"{names[c.zone_id]}={c.scoring_mode}" for c in d.engine.ranked),
            "engine_basis": ";".join(f"{names[c.zone_id]}={c.congestion_arrival_basis}" for c in d.engine.ranked),
        })
    return rows


def run_replay(
    data: ReplayData, config: ReplayConfig, *, engine: EngineFn | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """동기 진입점 — 한 asyncio.run 안에서 결정 순서대로 차례로 기다린다(결정적)."""
    return asyncio.run(replay_async(data, config, engine=engine))


# ── 글(마크다운 · 결정 품질 요약) ───────────────────────────────────────────────

_STATUS_KO = {"pass": "통과", "fail": "미달", "insufficient": "표본 부족", "not_evaluable": "평가 불가", "report": "보고"}
_LABEL_KO = {"pilot": "예비 — 기준 확정 전", "confirmatory": "확인", "exploratory": "탐색"}
_POLICY_KO = {
    "engine": "엔진", "nearest": "가장 가까운 곳", "climatology_choice": "시간대 평균 선택",
    "current_band_greedy": "현재 등급 탐욕", "random": "무작위(기대값)", "stay": "머물기", "oracle": "오라클",
}


def _pct(value: Any) -> str:
    return "—" if value is None else f"{value * 100:.1f}%"


def _num(value: Any, digits: int = 2) -> str:
    return "—" if value is None else f"{value:.{digits}f}"


def _ci(pair: Any) -> str:
    if not pair or pair[0] is None:
        return "[—]"
    return f"[{pair[0] * 100:+.1f}, {pair[1] * 100:+.1f}]%p"


def _pp(value: Any) -> str:
    """비율의 차 → '%p' 숫자(없으면 '—'). 값이 없을 때 0.0 으로 보이지 않게."""
    return "—" if value is None else f"{value * 100:.1f}"


def forced_agreement_text(v3: Mapping[str, Any]) -> str:
    """V3 옆에 서는 한 줄 — 대안 1곳이라 엔진 = 가장 가까운 곳인 결정 수·비율과 섞은 차(기술 통계)."""
    forced = v3.get("forced_agreement") or {}
    pooled = v3.get("pooled_crowded") or {}
    return (
        f"V3 모집단 = 붐비는 출발지 중 대안 2곳 이상인 결정(n={v3['n']} · 서로 다른 버킷 {v3.get('n_distinct')}). "
        f"대안 1곳이라 엔진 = 가장 가까운 곳인 결정 {forced.get('n', 0)}건({_pct(forced.get('share'))})은 판정에서 뺐다 — "
        f"섞으면 차 {_pp(pooled.get('diff'))}%p(n={pooled.get('n', 0)}, 참고)"
    )


def render_markdown(report: Mapping[str, Any]) -> str:
    """한국어 요약(≤ 50줄). 첫 한계 줄은 언제나 '사용자 없음'."""
    v = report["verdicts"]
    v3, v4 = v["V3"], v["V4"]
    run = report["run"]
    period = report["config"]["period"]
    choice = report["populations"]["crowded_choice"]
    pol = choice["policies"]
    con = choice["contrasts"]
    dis = choice["disagreement"]
    thin = report["thin_cluster"]
    unattainable = " · 구조상 달성 불가" if v3["criterion_attainable"] is False else ""
    lines = [
        f"# S4 분산 결정 재생 — {report['cluster']} ({period.get('from_kst_date') or '—'}~{period.get('to_kst_date') or '—'}) · "
        f"{_LABEL_KO.get(run['run_label'], run['run_label'])} · 기준 {run['criteria_version']} · 소스 {run.get('source_version')}",
        "",
        f"판정: V3 {_STATUS_KO.get(v3['status'], v3['status'])}{unattainable} · V4 {_STATUS_KO.get(v4['status'], v4['status'])}"
        f"(권장 {v4['recommendation']}) · V2 보고",
        "",
        f"표본: 결정 n={v3['n']}(서로 다른 버킷 {v3.get('n_distinct')}) · {v3['days']}일 · 에피소드 {v3['episodes']} · "
        f"엔진≠가장 가까운 곳 {v3['n_disagree']}건(버킷 {v3.get('n_disagree_distinct')}) · 여유(headroom) {_pct(v3['headroom'])}"
        + (f" · {thin['note']}" if thin["note"] else ""),
        forced_agreement_text(v3),
    ]
    if v3.get("reason"):
        lines.append(f"사유: {v3['reason']}")
    lines.append(
        f"V3 판정 하한 {_num(v3.get('gate_low'), 4)} = min(부트스트랩 {_num(v3.get('ci_low'), 4)}, "
        f"날짜 군집 t {_num(v3.get('ci_low_t'), 4)}) · 블록 {v3.get('blocks')}"
    )
    lines += [
        "",
        "| 정책 | 적중률(95% CI) | 악화율 | 단계 차(등간격 가정) | 오라클 대비 손실 | 추가 이동(분) |",
        "|---|---|---|---|---|---|",
    ]
    for policy in ("engine", "nearest", "climatology_choice", "current_band_greedy", "random", "stay", "oracle"):
        p = pol[policy]
        ci = p["hit_rate_ci"]
        ci_text = "[—]" if not ci or ci[0] is None else f"[{ci[0] * 100:.1f}, {ci[1] * 100:.1f}]"
        lines.append(
            f"| {_POLICY_KO[policy]} | {_pct(p['hit_rate'])} {ci_text} | {_pct(p['harm_rate'])} | "
            f"{_num(p['level_gap'])} | {_num(p['loss_vs_oracle'])} | {_num(p['extra_travel_min'], 1)} |"
        )
    lines += [
        "",
        "오라클 = 가장 좋은 대안(옮김 강제 — 머물기는 후보가 아니다). 머물기의 손실은 max(0, 최대 이득)이다.",
        f"엔진 − 가장 가까운 곳 {_pp(con['engine_minus_nearest']['diff'])}%p "
        f"{_ci(con['engine_minus_nearest']['ci'])} · − 시간대 평균 {_pp(con['engine_minus_climatology']['diff'])}%p "
        f"{_ci(con['engine_minus_climatology']['ci'])}(판정 하한 {_num(con['engine_minus_climatology'].get('gate_low'), 4)}) · "
        f"− 현재 등급 {_pp(con['engine_minus_greedy']['diff'])}%p "
        f"{_ci(con['engine_minus_greedy']['ci'])}(판정 하한 {_num(con['engine_minus_greedy'].get('gate_low'), 4)}) "
        f"({v3['ci_label']})",
    ]
    if no_evidence_over(con["engine_minus_climatology"]):
        lines.append("실시간 혼잡이 시간대 평균보다 나은 선택을 만들었다는 근거는 없다(판정 하한 기준).")
    causes = dis["causes"]
    measured = report["populations"]["measured_only"]
    lines += [
        f"불일치 원인: 근거 유무 {causes['tier_availability']['n']} / 붐빔 강등 {causes['tier_crowded_cutoff']['n']} / "
        f"같은 등급 안 점수 {causes['score_same_tier']['n']} · 모두 실측인 부분집합 n={measured['n']} 차 "
        f"{_pp(measured['contrasts']['engine_minus_nearest']['diff'])}%p",
    ]
    diag = report["engine_diagnostics"]
    abl = report["v2"]["ablations"]
    persistence_only = abl["persistence_only"]
    pers_text = (
        "구성상 근거 없음과 구별되지 않음"
        if persistence_only.get("status") == "structurally_indistinguishable"
        else f"1위 바뀜 {_pct(persistence_only.get('top1_changed_rate'))}"
    )
    lines += [
        f"도착 근거(엔진 1위): {diag['arrival_basis_counts']} · 지속 근거 시간 창 안 {_pct(diag.get('persistence_eligible_share'))} · "
        f"V2 persistence_only: {pers_text}",
        "",
    ]
    bin30 = next((b for b in report["v4"]["native"]["bins"] if b["lead_bin"] == 30), None)
    if bin30 is not None:
        lines.append(
            f"V4 리드 30분(고유 정렬): MAE 공급원 {_num(bin30['mae']['provider_forecast'])} vs 지속 "
            f"{_num(bin30['mae']['persistence'])} (차 [{_num(bin30['diff_ci']['lo'])}, {_num(bin30['diff_ci']['hi'])}], "
            f"정확도 {_pct(bin30['exact']['provider_forecast'])} vs {_pct(bin30['exact']['persistence'])}, "
            f"n={bin30['n_paired']}, {bin30['days']}일) — 등간격 가정"
        )
    else:
        lines.append(f"V4 리드 30분: 짝 표본 없음({v4.get('reason')})")
    inf = report["influence"]
    special = inf["special_days_excluded"]
    lines += [
        f"영향: 하루 빼기 차 범위 [{_pp(inf['lodo_diff']['min'])}, "
        f"{_pp(inf['lodo_diff']['max'])}]%p · 특별한 날 제외 차 "
        f"{_pp(special['diff'])}%p (n={special['n']})",
        "",
        "데이터:",
    ]
    replace_flags = report["inputs"]["replace_flags"]["per_zone"]
    for zone in report["zones"]:
        flags = replace_flags.get(zone["zone_id"], {})
        lines.append(
            f"- {zone['name']}: {zone['rows']}행 · 주기 {_num(zone['cadence_minutes_median'], 0)}분 · 채움 {_pct(zone['fill_rate'])} · "
            f"지연 p50 {_num(zone['lag_minutes_p50'], 1)}분 · REPLACE_YN 표시 행 {_pct(flags.get('coverage'))}"
        )
    dec = report["decisions"]
    lines += [
        f"- 결정 {dec['candidates']} · 채점 {dec['scorable_all']} · 정답 오프셋 p50/p90 "
        f"{_num(dec['truth_offset_minutes']['p50'], 1)}/{_num(dec['truth_offset_minutes']['p90'], 1)}분 · "
        f"출발지 행 대기 {dec['delayed_to_origin_fetch']['n']}건 · 도보 상한 {report['config']['travel'].get('max_walk_minutes')}분 "
        f"안 대안이 없어 결정 없음 {dec['skipped'].get(SKIP_NO_ELIGIBLE, 0)}건",
        "",
        "한계:",
    ]
    lines += [f"- {text}" for text in report["limits"]]
    return "\n".join(lines[:50]) + "\n"


def build_decision_quality_summary(report: Mapping[str, Any], *, inputs_sha256: str | None = None) -> dict[str, Any]:
    """화면용 결정 품질 요약(≤ 16KB · 결정 행 없음 · 배열 ≤ 16). 숫자는 V3 모집단(대안 2곳 이상)의 것이다."""
    v = report["verdicts"]
    v3, v4 = v["V3"], v["V4"]
    choice = report["populations"]["crowded_choice"]
    pol = choice["policies"]
    con = choice["contrasts"]
    period = report["decisions"]["scored_period"]
    if inputs_sha256 is None:
        files = (report["inputs"]["observation_files"] + report["inputs"]["forecast_files"]
                 + list(report["inputs"].get("replaced_files") or [])
                 + [f for f in (report["inputs"]["counts_file"], report["inputs"].get("replaced_counts_file")) if f])
        joined = "\n".join(f"{f['name']}:{f['sha256']}" for f in sorted(files, key=lambda f: f["name"]))
        inputs_sha256 = hashlib.sha256(joined.encode("utf-8")).hexdigest()
    notes = [forced_agreement_text(v3)]
    if report["thin_cluster"]["note"]:
        notes.append(report["thin_cluster"]["note"])
    if v3["ci_label"] == CI_LABEL_APPROX:
        notes.append("날짜 블록이 20개 미만이라 신뢰구간은 근사다")
    clim_ci = con["engine_minus_climatology"]["ci"]
    if no_evidence_over(con["engine_minus_climatology"]):
        notes.append("실시간 혼잡이 시간대 평균보다 나은 선택을 만들었다는 근거는 없다(판정 하한 기준)")
    if v3.get("reason"):
        notes.append(f"V3 사유: {v3['reason']}")
    if report["v2"]["ablations"]["persistence_only"].get("status") == "structurally_indistinguishable":
        notes.append("V2 persistence_only 는 근거 없음과 구성상 구별되지 않아 측정값으로 읽지 않는다")
    notes.append("적중 = 도착 때 출발지에 머문 것보다 1단계 이상 덜 붐빔(같은 도착 시각)")
    summary = {
        "schema_version": SUMMARY_SCHEMA_VERSION,
        "cluster": report["cluster"],
        "zones": [z["name"] for z in report["zones"]][:16],
        "run_label": report["run"]["run_label"],
        "criteria_version": report["run"]["criteria_version"],
        "code_version": report["run"]["code_version"],
        "period": {
            "first_decision_at": period["first_day"],
            "last_decision_at": period["last_day"],
            "days": period["days"],
        },
        "inputs_sha256": inputs_sha256,
        "population": SUMMARY_POPULATION,
        "n_decisions": v3["n"],
        "days": v3["days"],
        "episodes": v3["episodes"],
        "n_disagree": v3["n_disagree"],
        "headroom": v3["headroom"],
        "opportunity_rate": choice["opportunity_rate"],
        "hit_rate": {p: pol[p]["hit_rate"] for p in
                     ("engine", "nearest", "climatology_choice", "current_band_greedy", "random", "oracle")},
        "hit_vs_now": {"engine": pol["engine"]["hit_vs_now"], "stay": pol["stay"]["hit_vs_now"]},
        "harm_rate": {"engine": pol["engine"]["harm_rate"], "nearest": pol["nearest"]["harm_rate"]},
        "verdicts": {
            # ci_low·ci_high = 부트스트랩 구간(보여 주는 값), gate_low = 판정 하한(부트스트랩·날짜 군집 t 중 작은 쪽).
            "V3": {k: v3[k] for k in ("status", "criterion", "diff", "ci_low", "ci_high", "ci_label", "ci_low_t",
                                      "gate_low", "n", "n_distinct", "days", "n_disagree", "n_disagree_distinct",
                                      "headroom", "criterion_attainable",
                                      "reason")},
            "V4": {"status": v4["status"], "recommendation": v4["recommendation"], "lead_bin": 30,
                   "mae_provider": v4.get("mae_provider"), "mae_persistence": v4.get("mae_persistence"),
                   "n": v4.get("n"), "days": v4.get("days"), "reason": v4.get("reason")},
            "V2": {"status": "report", "share_crowd_gt_travel": v["V2"]["share_crowd_gt_travel"]},
        },
        "contrasts": {
            "engine_minus_climatology": {"diff": con["engine_minus_climatology"]["diff"],
                                         "ci_low": clim_ci[0] if clim_ci else None,
                                         "ci_high": clim_ci[1] if clim_ci else None},
            "engine_minus_greedy": {"diff": con["engine_minus_greedy"]["diff"],
                                    "ci_low": con["engine_minus_greedy"]["ci"][0],
                                    "ci_high": con["engine_minus_greedy"]["ci"][1]},
        },
        "thin_cluster": report["thin_cluster"]["flag"],
        "alternatives_per_origin": report["thin_cluster"]["alternatives_per_origin"],
        "notes": notes[:8],
        "limits": list(report["limits"])[:8],
    }
    return _round(summary)


def contains_forbidden_text(text: str) -> bool:
    return FORBIDDEN_TEXT.search(text) is not None


def grade_labels() -> tuple[str, ...]:
    return GRADE_LABELS
