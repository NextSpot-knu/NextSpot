"""SPOT relevance를 보존하면서 상위 대안의 최소 다양성을 확보한다."""

from __future__ import annotations

import re
from typing import Any

from app.services.spot.travel import calculate_haversine_distance

_DIVERSITY_SLOTS = 3
_MAX_SCORE_DROP = 0.03
_SAME_BUILDING_DISTANCE_M = 30.0
_GENERIC_CONCEPTS = {
    "", "카페", "음식점", "식당", "관광지", "문화시설", "restaurant", "cafe",
    "attraction", "culture",
}


def _normalized(value: Any) -> str:
    return re.sub(r"[^0-9a-z가-힣]", "", str(value or "").lower())


def _concepts(item: dict[str, Any]) -> set[str]:
    facility = item.get("facility") or {}
    features = facility.get("features") or {}
    raw: list[Any] = []
    for key in ("cuisine_tags", "cuisine", "category", "cat3"):
        value = features.get(key) if isinstance(features, dict) else None
        raw.extend(value if isinstance(value, list) else [value])
    return {
        token for token in (_normalized(value) for value in raw)
        if token not in _GENERIC_CONCEPTS and len(token) >= 2
    }


def _same_building(left: dict[str, Any], right: dict[str, Any]) -> bool:
    a = left.get("facility") or {}
    b = right.get("facility") or {}
    address_a = _normalized(a.get("address") or (a.get("features") or {}).get("address"))
    address_b = _normalized(b.get("address") or (b.get("features") or {}).get("address"))
    if len(address_a) < 8 or address_a != address_b:
        return False
    try:
        distance = calculate_haversine_distance(
            float(a["latitude"]), float(a["longitude"]),
            float(b["latitude"]), float(b["longitude"]),
        )
    except (KeyError, TypeError, ValueError):
        return False
    return distance <= _SAME_BUILDING_DISTANCE_M


def _repetition_penalty(candidate: dict[str, Any], selected: list[dict[str, Any]]) -> int:
    penalty = 0
    candidate_concepts = _concepts(candidate)
    for previous in selected:
        if _same_building(candidate, previous):
            penalty += 4
        previous_concepts = _concepts(previous)
        if candidate_concepts and previous_concepts and candidate_concepts & previous_concepts:
            penalty += 1
    return penalty


def select_diverse_recommendations(
    sorted_items: list[dict[str, Any]],
    limit: int,
    *,
    diversity_slots: int = _DIVERSITY_SLOTS,
    max_score_drop: float = _MAX_SCORE_DROP,
) -> list[dict[str, Any]]:
    """점수 0.03 이내의 사실상 동급 후보만 재정렬해 Top 3 반복을 줄인다.

    1위는 항상 원래 SPOT 1위를 유지한다. 다양성을 위해 더 낮은 품질의 후보를 끌어올리지
    않도록 각 슬롯의 원래 선두보다 ``max_score_drop`` 이상 낮은 후보는 고려하지 않는다.
    """
    if limit <= 0 or not sorted_items:
        return []

    indexed = list(enumerate(sorted_items))
    first_index, first = indexed.pop(0)
    chosen: list[tuple[int, dict[str, Any]]] = [(first_index, first)]
    target_diverse = min(limit, diversity_slots, len(sorted_items))

    while indexed and len(chosen) < target_diverse:
        baseline_score = float(indexed[0][1].get("spot_score") or 0.0)
        window = [
            pair for pair in indexed
            if float(pair[1].get("spot_score") or 0.0) >= baseline_score - max_score_drop
        ]
        selected_items = [item for _, item in chosen]
        pick = min(
            window,
            key=lambda pair: (_repetition_penalty(pair[1], selected_items), pair[0]),
        )
        chosen.append(pick)
        indexed.remove(pick)

    chosen.extend(indexed[: max(0, limit - len(chosen))])
    result = chosen[:limit]
    for new_rank, (old_index, item) in enumerate(result, start=1):
        breakdown = item.setdefault("breakdown", {})
        breakdown["selection_rank_before_diversity"] = old_index + 1
        breakdown["diversity_adjusted"] = old_index + 1 != new_rank
    return [item for _, item in result]
