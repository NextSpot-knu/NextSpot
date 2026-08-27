"""추천 후보의 주변 수요를 상대 비교하고 사용자 행동으로 번역한다."""

from __future__ import annotations

import statistics
from typing import Any

_DISTINGUISHABLE_SPREAD = 0.08
_MEANINGFUL_DELTA = 0.08
_WAIT_IMPROVEMENT = 0.10


def _confidence(breakdown: dict[str, Any]) -> str:
    explicit = breakdown.get("area_demand_confidence")
    if explicit in {"high", "medium", "low"}:
        return explicit
    mode = breakdown.get("area_demand_mode")
    if mode == "live":
        return "high"
    if mode in {"forecast", "statistical"}:
        return "medium"
    if mode == "contextual":
        return "low"
    return "none"


def annotate_relative_demand(items: list[dict[str, Any]]) -> None:
    """후보 전체를 비교해 순위·중앙값 차이·구분 가능 여부를 breakdown에 추가한다."""
    comparable = [
        (index, float(item["breakdown"]["area_demand_level"]))
        for index, item in enumerate(items)
        if isinstance(item.get("breakdown", {}).get("area_demand_level"), (int, float))
    ]
    levels = [level for _, level in comparable]
    median = statistics.median(levels) if levels else None
    spread = max(levels) - min(levels) if len(levels) >= 2 else 0.0
    distinguishable = len(levels) >= 2 and spread >= _DISTINGUISHABLE_SPREAD
    ordered = sorted(comparable, key=lambda pair: (pair[1], pair[0]))
    rank_by_index = {index: rank for rank, (index, _) in enumerate(ordered, start=1)}
    total = len(comparable)

    for index, item in enumerate(items):
        breakdown = item["breakdown"]
        level = breakdown.get("area_demand_level")
        breakdown["area_demand_confidence"] = _confidence(breakdown)
        breakdown["area_demand_comparable_count"] = total
        breakdown["area_demand_distinguishable"] = distinguishable
        if not isinstance(level, (int, float)) or median is None:
            breakdown["area_demand_rank"] = None
            breakdown["area_demand_percentile"] = None
            breakdown["area_demand_delta_vs_median"] = None
            continue
        rank = rank_by_index[index]
        percentile = 100.0 if total == 1 else (total - rank) / (total - 1) * 100.0
        breakdown["area_demand_rank"] = rank
        breakdown["area_demand_percentile"] = round(percentile, 1)
        breakdown["area_demand_delta_vs_median"] = round(float(level) - median, 4)


def annotate_arrival_actions(
    items: list[dict[str, Any]],
    delayed_signals: list[dict[str, Any] | None],
    *,
    delay_minutes: int = 30,
) -> None:
    """현재와 지연 출발 근거를 비교해 과장 없는 하나의 행동 라벨을 부여한다."""
    for item, delayed in zip(items, delayed_signals):
        breakdown = item["breakdown"]
        current = breakdown.get("area_demand_level")
        delayed_level = delayed.get("level") if delayed else None
        delayed_confidence = delayed.get("confidence") if delayed else None
        if isinstance(delayed_level, (int, float)):
            breakdown["delayed_area_demand_level"] = round(float(delayed_level), 4)
            breakdown["delayed_area_demand_mode"] = delayed.get("mode")
            breakdown["delayed_area_demand_confidence"] = delayed_confidence
        else:
            breakdown["delayed_area_demand_level"] = None
            breakdown["delayed_area_demand_mode"] = None
            breakdown["delayed_area_demand_confidence"] = None

        confidence = breakdown.get("area_demand_confidence")
        delta = breakdown.get("area_demand_delta_vs_median")
        distinguishable = bool(breakdown.get("area_demand_distinguishable"))
        if (
            isinstance(current, (int, float))
            and isinstance(delayed_level, (int, float))
            and delayed_confidence in {"high", "medium"}
            and float(current) - float(delayed_level) >= _WAIT_IMPROVEMENT
        ):
            action = "wait_then_go"
            recommended_delay = delay_minutes
        elif (
            isinstance(delta, (int, float))
            and distinguishable
            and float(delta) <= -_MEANINGFUL_DELTA
            and confidence in {"high", "medium"}
        ):
            action = "choose_calmer"
            recommended_delay = 0
        elif isinstance(current, (int, float)) and float(current) <= 0.5 and confidence in {"high", "medium"}:
            action = "go_now"
            recommended_delay = 0
        else:
            action = "no_clear_advantage"
            recommended_delay = None
        breakdown["arrival_action"] = action
        breakdown["recommended_departure_delay_minutes"] = recommended_delay
