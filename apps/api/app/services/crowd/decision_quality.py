"""결정 품질(S4 · V3) 요약 읽기 — 커밋된 재생 산출물만 화면에 싣는다.

`docs/SEOUL_TESTBED_PLAN.md` §4·§6 S4. 분산 결정 재생(`scripts/crowd_dispersion_replay.py run`)이
`out/decision_quality/<cluster>.json`(스키마 `decision_quality_summary/3`, ≤ 16KB, 결정 행 없음)을 만든다.
사람이 검토한 뒤 그 파일을 **이름 그대로** `data/decision_quality/` 에 커밋하면, 관리자 '엔진 검증' 화면의
`decision_quality` 블록이 이 모듈을 거쳐 그 숫자를 보여 준다. 운영 API 는 재생을 돌리지 않는다 — 원본 반출
CSV 는 저장소·이미지 어디에도 없다(.gitignore · .dockerignore).

돌려주는 모양은 셋뿐이다:

    not_evaluated   요약 파일이 하나도 없다 — S4 전과 **같은 상수**(`NOT_EVALUATED`)를 그대로 준다
    evaluated       파일이 전부 검사를 통과했다 — result.clusters 는 cluster 이름순
    invalid_summary 한 파일이라도 틀렸다 — 숫자를 하나도 싣지 않고 '<파일명>: <문제>' 만 말한다

틀린 파일이 하나라도 있으면 나머지 권역도 싣지 않는다. 일부만 보이면 "홍대만 평가됐다" 로 읽히기 때문이다.
어느 경우든 예외를 올리지 않는다 — 요약 파일 하나 때문에 수집 상태 화면 전체가 5xx 가 되면 안 된다.

배치 모듈(`app.services.batch.*`)은 import 하지 않는다 — 운영 프로세스가 재생 코드를 싣지 않게 하려는 것이다
(`tests/structure/test_crowd_replay_isolation.py`). 그래서 스키마 상수는 여기 따로 둔다(재생 쪽과 같은 값인지는
`tests/services/test_crowd_decision_quality.py` 가 실제 재생 산출물로 확인한다).
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any, Iterable

import structlog

from app.services.crowd import seoul_provider

logger = structlog.get_logger()

SUMMARY_DIR = Path(__file__).resolve().parent / "data" / "decision_quality"
SCHEMA_VERSION = "decision_quality_summary/3"
MAX_BYTES = 16 * 1024
MAX_ARRAY = 16
MAX_NOTES = 8
MAX_DEPTH = 6

# 결정 품질(G2 · V3)의 합격 기준 문장. 요약이 없을 때(S4 전)와 있을 때 모두 화면에 같은 문장이 선다.
CRITERION = (
    "V3 — 붐비는 출발지에서 대안이 2곳 이상인 결정에서, 추천지가 도착 시 1단계 이상 덜 붐빌 확률이 "
    "'가장 가까운 곳' 기준선보다 10%p 이상 높고, 그 차의 판정 하한(일 블록 부트스트랩 95% 하한과 날짜 군집 t "
    "95% 하한 중 작은 쪽) > 0"
)

# S4 전 응답 — 숫자 자리를 비워 두지 않고 상태로만 말한다. 요약 파일이 없으면 지금도 정확히 이것이다.
NOT_EVALUATED: dict[str, Any] = {
    "state": "not_evaluated",
    "stage": "S4",
    "criterion": CRITERION,
    "result": None,
}

RUN_LABELS = frozenset({"pilot", "confirmatory", "exploratory"})
VERDICT_STATUSES = frozenset({"pass", "fail", "insufficient", "not_evaluable"})
CI_LABELS = frozenset({"approximate (blocks < 20)", "percentile_day_block"})
V4_RECOMMENDATIONS = frozenset({"provider_forecast", "persistence", "undetermined"})
HIT_POLICIES = ("engine", "nearest", "climatology_choice", "current_band_greedy", "random", "oracle")
CONTRASTS = ("engine_minus_climatology", "engine_minus_greedy")
# V3 모집단 = 붐비는 출발지 중 대안 2곳 이상인 결정(재생 SUMMARY_POPULATION 과 같은 값). 대안 1곳이면 엔진 = 가장
# 가까운 곳이라 차가 구성상 0 이다 — 그 결정을 섞은 요약(옛 'crowded_origin')은 싣지 않는다.
POPULATION = "crowded_origin_choice_feasible"
# 화면 문구 규칙(AGENTS.md · 계획 generated_text_rule) — 요약 글에 이 말이 있으면 싣지 않는다.
FORBIDDEN_TEXT = re.compile("분산 효과|혼잡 감소|솔직|투명|확실|믿을 수 있")
NO_USERS_MARK = "사용자가 없다"

TOP_LEVEL_KEYS = frozenset({
    "schema_version", "cluster", "zones", "run_label", "criteria_version", "code_version", "period",
    "inputs_sha256", "population", "n_decisions", "days", "episodes", "n_disagree", "headroom",
    "opportunity_rate", "hit_rate", "hit_vs_now", "harm_rate", "verdicts", "contrasts", "thin_cluster",
    "alternatives_per_origin", "notes", "limits",
})
V3_KEYS = frozenset({
    "status", "criterion", "diff", "ci_low", "ci_high", "ci_label", "ci_low_t", "gate_low", "n", "n_distinct",
    "days", "n_disagree", "n_disagree_distinct", "headroom", "criterion_attainable", "reason",
})
V4_KEYS = frozenset({"status", "recommendation", "lead_bin", "mae_provider", "mae_persistence", "n", "days", "reason"})
V2_KEYS = frozenset({"status", "share_crowd_gt_travel"})


class SummaryProblem(ValueError):
    """요약 파일 하나의 문제. 메시지는 화면에 그대로 나가므로 짧은 한국어 + 필드 경로로 쓴다."""


def known_clusters() -> frozenset[str]:
    return frozenset(zone.cluster for zone in seoul_provider.SEOUL_ZONES if zone.cluster)


# ── 값 검사 ─────────────────────────────────────────────────────────────────────


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool)) and math.isfinite(value)


def _require_keys(obj: Any, keys: frozenset[str], where: str) -> dict[str, Any]:
    if not isinstance(obj, dict):
        raise SummaryProblem(f"{where} 가 객체가 아니다")
    missing = sorted(keys - set(obj))
    if missing:
        raise SummaryProblem(f"{where} 에 필드가 없다: {', '.join(missing)}")
    extra = sorted(set(obj) - keys)
    if extra:
        raise SummaryProblem(f"{where} 에 모르는 필드가 있다: {', '.join(extra)}")
    return obj


def _count(value: Any, where: str) -> int:
    if not _is_int(value) or value < 0:
        raise SummaryProblem(f"{where} 는 0 이상의 정수여야 한다")
    return value


def _rate(value: Any, where: str) -> None:
    """비율(0..1) 또는 null. 표본이 없으면 재생이 null 을 쓴다."""
    if value is None:
        return
    if not _is_number(value) or not 0.0 <= value <= 1.0:
        raise SummaryProblem(f"{where} 는 0~1 사이 비율이어야 한다")


def _signed_rate(value: Any, where: str) -> None:
    """적중률의 차(−1..1) 또는 null."""
    if value is None:
        return
    if not _is_number(value) or not -1.0 <= value <= 1.0:
        raise SummaryProblem(f"{where} 는 −1~1 사이여야 한다")


def _mae(value: Any, where: str) -> None:
    """4등급 눈금의 MAE(0..3) 또는 null."""
    if value is None:
        return
    if not _is_number(value) or not 0.0 <= value <= 3.0:
        raise SummaryProblem(f"{where} 는 0~3 사이여야 한다")


def _text(value: Any, where: str, *, nullable: bool = False, max_len: int = 600) -> None:
    if value is None and nullable:
        return
    if not isinstance(value, str) or not value.strip() or len(value) > max_len:
        raise SummaryProblem(f"{where} 는 비어 있지 않은 문자열이어야 한다")


def _enum(value: Any, allowed: frozenset[str], where: str) -> None:
    if value not in allowed:
        raise SummaryProblem(f"{where} 값 {value!r} 은 허용 목록({', '.join(sorted(allowed))})에 없다")


def _text_list(value: Any, where: str, *, limit: int) -> list[str]:
    if not isinstance(value, list) or len(value) > limit:
        raise SummaryProblem(f"{where} 는 {limit}개 이하의 목록이어야 한다")
    for i, item in enumerate(value):
        _text(item, f"{where}[{i}]")
    return value


def _walk_shape(value: Any, where: str, depth: int = 0) -> None:
    """결정 행 같은 큰 payload 를 막는다 — 어느 배열도 16개를 넘지 않고, 중첩이 깊지 않다."""
    if depth > MAX_DEPTH:
        raise SummaryProblem(f"{where} 의 중첩이 너무 깊다")
    if isinstance(value, list):
        if len(value) > MAX_ARRAY:
            raise SummaryProblem(f"{where} 배열이 {len(value)}개 — 최대 {MAX_ARRAY}개(결정 행은 싣지 않는다)")
        for i, item in enumerate(value):
            _walk_shape(item, f"{where}[{i}]", depth + 1)
    elif isinstance(value, dict):
        for key, item in value.items():
            _walk_shape(item, f"{where}.{key}", depth + 1)
    elif isinstance(value, str) and FORBIDDEN_TEXT.search(value):
        raise SummaryProblem(f"{where} 에 화면에 쓰지 않는 표현이 있다")


def validate_summary(summary: Any, *, stem: str) -> dict[str, Any]:
    """`decision_quality_summary/3` 한 건을 검사한다. 문제가 있으면 SummaryProblem."""
    if not isinstance(summary, dict):
        raise SummaryProblem("최상위가 객체가 아니다")
    if summary.get("schema_version") != SCHEMA_VERSION:
        raise SummaryProblem(f"schema_version 이 {SCHEMA_VERSION!r} 가 아니다({summary.get('schema_version')!r})")
    _walk_shape(summary, "$")
    _require_keys(summary, TOP_LEVEL_KEYS, "최상위")

    cluster = summary["cluster"]
    if not isinstance(cluster, str) or cluster != stem:
        raise SummaryProblem(f"cluster {cluster!r} 가 파일 이름({stem!r})과 다르다")
    _enum(cluster, known_clusters(), "cluster")
    zones = _text_list(summary["zones"], "zones", limit=MAX_ARRAY)
    if not zones:
        raise SummaryProblem("zones 가 비어 있다")
    _enum(summary["run_label"], RUN_LABELS, "run_label")
    _text(summary["criteria_version"], "criteria_version", max_len=64)
    _text(summary["code_version"], "code_version", nullable=True, max_len=64)
    _text(summary["inputs_sha256"], "inputs_sha256", max_len=128)
    if summary["population"] != POPULATION:
        raise SummaryProblem(f"population 이 {POPULATION!r} 가 아니다")

    period = _require_keys(summary["period"], frozenset({"first_decision_at", "last_decision_at", "days"}), "period")
    _text(period["first_decision_at"], "period.first_decision_at", nullable=True, max_len=40)
    _text(period["last_decision_at"], "period.last_decision_at", nullable=True, max_len=40)
    _count(period["days"], "period.days")

    for key in ("n_decisions", "days", "episodes", "n_disagree", "alternatives_per_origin"):
        _count(summary[key], key)
    # headroom = 오라클 적중률 − 가장 가까운 곳 적중률(차라서 부호가 있는 범위로 본다).
    _signed_rate(summary["headroom"], "headroom")
    _rate(summary["opportunity_rate"], "opportunity_rate")

    hit = _require_keys(summary["hit_rate"], frozenset(HIT_POLICIES), "hit_rate")
    for policy in HIT_POLICIES:
        _rate(hit[policy], f"hit_rate.{policy}")
    now = _require_keys(summary["hit_vs_now"], frozenset({"engine", "stay"}), "hit_vs_now")
    for policy in ("engine", "stay"):
        _rate(now[policy], f"hit_vs_now.{policy}")
    harm = _require_keys(summary["harm_rate"], frozenset({"engine", "nearest"}), "harm_rate")
    for policy in ("engine", "nearest"):
        _rate(harm[policy], f"harm_rate.{policy}")

    verdicts = _require_keys(summary["verdicts"], frozenset({"V2", "V3", "V4"}), "verdicts")
    v3 = _require_keys(verdicts["V3"], V3_KEYS, "verdicts.V3")
    _enum(v3["status"], VERDICT_STATUSES, "verdicts.V3.status")
    _text(v3["criterion"], "verdicts.V3.criterion")
    # ci_low_t·gate_low: 날짜 군집 t 하한과 판정 하한(둘 중 작은 쪽). 표본이 적으면 −1 아래로 갈 수 있어 수치만 본다.
    for key in ("diff", "ci_low", "ci_high"):
        _signed_rate(v3[key], f"verdicts.V3.{key}")
    for key in ("ci_low_t", "gate_low"):
        if v3[key] is not None and not _is_number(v3[key]):
            raise SummaryProblem(f"verdicts.V3.{key} 는 수 또는 null 이어야 한다")
    if v3["status"] == "fail" and not v3["reason"]:
        raise SummaryProblem("verdicts.V3.status 가 fail 인데 reason 이 없다")
    if v3["ci_label"] is not None:
        _enum(v3["ci_label"], CI_LABELS, "verdicts.V3.ci_label")
    # n_distinct · n_disagree_distinct = 서로 다른 (출발지·버킷) 수 — 최소 표본 판정은 이것으로 한다(결정 수 n 이 아니다).
    for key in ("n", "n_distinct", "days", "n_disagree", "n_disagree_distinct"):
        _count(v3[key], f"verdicts.V3.{key}")
    _signed_rate(v3["headroom"], "verdicts.V3.headroom")
    if v3["n_distinct"] > v3["n"] or v3["n_disagree_distinct"] > v3["n_disagree"]:
        raise SummaryProblem("verdicts.V3 의 서로 다른 (출발지·버킷) 수가 결정 수보다 크다")
    # null = 모집단이 비어 달성 가능 여부를 모른다(headroom 없음).
    if v3["criterion_attainable"] is not None and not isinstance(v3["criterion_attainable"], bool):
        raise SummaryProblem("verdicts.V3.criterion_attainable 는 참/거짓 또는 null 이어야 한다")
    _text(v3["reason"], "verdicts.V3.reason", nullable=True)

    v4 = _require_keys(verdicts["V4"], V4_KEYS, "verdicts.V4")
    _enum(v4["status"], VERDICT_STATUSES, "verdicts.V4.status")
    _enum(v4["recommendation"], V4_RECOMMENDATIONS, "verdicts.V4.recommendation")
    if not _is_int(v4["lead_bin"]) or not 0 < v4["lead_bin"] <= 180:
        raise SummaryProblem("verdicts.V4.lead_bin 은 1~180 분이어야 한다")
    _mae(v4["mae_provider"], "verdicts.V4.mae_provider")
    _mae(v4["mae_persistence"], "verdicts.V4.mae_persistence")
    for key in ("n", "days"):
        if v4[key] is not None:
            _count(v4[key], f"verdicts.V4.{key}")
    _text(v4["reason"], "verdicts.V4.reason", nullable=True)

    v2 = _require_keys(verdicts["V2"], V2_KEYS, "verdicts.V2")
    if v2["status"] != "report":
        raise SummaryProblem("verdicts.V2.status 는 'report' 여야 한다")
    _rate(v2["share_crowd_gt_travel"], "verdicts.V2.share_crowd_gt_travel")

    contrasts = _require_keys(summary["contrasts"], frozenset(CONTRASTS), "contrasts")
    for name in CONTRASTS:
        block = _require_keys(contrasts[name], frozenset({"diff", "ci_low", "ci_high"}), f"contrasts.{name}")
        for key in ("diff", "ci_low", "ci_high"):
            _signed_rate(block[key], f"contrasts.{name}.{key}")

    if not isinstance(summary["thin_cluster"], bool):
        raise SummaryProblem("thin_cluster 는 참/거짓이어야 한다")
    _text_list(summary["notes"], "notes", limit=MAX_NOTES)
    limits = _text_list(summary["limits"], "limits", limit=MAX_NOTES)
    if not limits or NO_USERS_MARK not in limits[0]:
        raise SummaryProblem("limits[0] 이 '서울에는 사용자가 없다' 한계 문장이 아니다")
    return summary


# ── 파일 읽기 ───────────────────────────────────────────────────────────────────


def _reject_constant(token: str) -> Any:
    raise SummaryProblem(f"JSON 에 {token} 이 있다")


def read_summary_file(path: Path) -> dict[str, Any]:
    """파일 하나를 읽어 검사한다. 크기를 먼저 본다 — 큰 파일은 파싱하지 않는다."""
    size = path.stat().st_size
    if size > MAX_BYTES:
        raise SummaryProblem(f"{size}바이트 — 최대 {MAX_BYTES}바이트(16KB)")
    raw = path.read_bytes()
    if len(raw) > MAX_BYTES:
        raise SummaryProblem(f"{len(raw)}바이트 — 최대 {MAX_BYTES}바이트(16KB)")
    try:
        parsed = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
    except UnicodeDecodeError as exc:
        raise SummaryProblem("UTF-8 이 아니다") from exc
    except json.JSONDecodeError as exc:
        raise SummaryProblem(f"JSON 형식 오류({exc.lineno}행 {exc.colno}열)") from exc
    return validate_summary(parsed, stem=path.stem)


def _invalid(name: str, problem: str) -> dict[str, Any]:
    logger.warning("decision_quality_summary_invalid", file=name, problem=problem)
    return {
        "state": "invalid_summary",
        "stage": NOT_EVALUATED["stage"],
        "criterion": CRITERION,
        "result": None,
        "reason": f"{name}: {problem}",
    }


def load_decision_quality_files(paths: Iterable[Path]) -> dict[str, Any]:
    """주어진 요약 파일들 → 화면 블록. 비면 NOT_EVALUATED, 하나라도 틀리면 invalid_summary."""
    clusters: dict[str, dict[str, Any]] = {}
    ordered = sorted(paths, key=lambda p: (p.name, str(p)))
    if not ordered:
        return dict(NOT_EVALUATED)
    for path in ordered:
        try:
            summary = read_summary_file(path)
        except SummaryProblem as exc:
            return _invalid(path.name, str(exc))
        except OSError as exc:
            return _invalid(path.name, f"읽을 수 없다({type(exc).__name__})")
        cluster = summary["cluster"]
        if cluster in clusters:
            return _invalid(path.name, f"cluster {cluster!r} 요약이 둘 이상이다")
        clusters[cluster] = summary
    return {
        "state": "evaluated",
        "stage": NOT_EVALUATED["stage"],
        "criterion": CRITERION,
        "result": {
            "schema_version": SCHEMA_VERSION,
            "clusters": [clusters[name] for name in sorted(clusters)],
        },
    }


def load_decision_quality(directory: Path | None = None) -> dict[str, Any]:
    """`data/decision_quality/*.json` → 화면 블록. 예외를 올리지 않는다."""
    folder = SUMMARY_DIR if directory is None else directory
    try:
        paths = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() == ".json"] if folder.is_dir() else []
    except OSError as exc:
        return _invalid(folder.name, f"폴더를 읽을 수 없다({type(exc).__name__})")
    return load_decision_quality_files(paths)
