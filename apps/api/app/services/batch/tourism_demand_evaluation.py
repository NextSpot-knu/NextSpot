"""Read-only counterfactual metrics for KTO tourism-demand differentiation."""

from __future__ import annotations

import math
from typing import Any

from app.services.spot.travel import estimate_walking_route
from app.services.tourism_area_prior_service import attach_tourism_area_priors
from app.services.tourism_name_matching import match_tourism_forecasts_to_facilities


_MAX_TOURISM_PENALTY_MIN = 8.0
_DISTINGUISHABLE_SPREAD = 0.08

DEFAULT_EVALUATION_SCENARIOS: tuple[dict[str, Any], ...] = (
    {"name": "황리단길 관광지", "type": "attraction", "lat": 35.8380, "lng": 129.2090},
    {"name": "황리단길 문화시설", "type": "culture", "lat": 35.8380, "lng": 129.2090},
    {"name": "황리단길 음식점", "type": "restaurant", "lat": 35.8380, "lng": 129.2090},
    {"name": "황리단길 카페", "type": "cafe", "lat": 35.8380, "lng": 129.2090},
    {"name": "첨성대 관광지", "type": "attraction", "lat": 35.8347, "lng": 129.2191},
    {"name": "첨성대 문화시설", "type": "culture", "lat": 35.8347, "lng": 129.2191},
    {"name": "첨성대 음식점", "type": "restaurant", "lat": 35.8347, "lng": 129.2191},
    {"name": "첨성대 카페", "type": "cafe", "lat": 35.8347, "lng": 129.2191},
    {"name": "박물관 관광지", "type": "attraction", "lat": 35.8294, "lng": 129.2283},
    {"name": "박물관 문화시설", "type": "culture", "lat": 35.8294, "lng": 129.2283},
    {"name": "박물관 음식점", "type": "restaurant", "lat": 35.8294, "lng": 129.2283},
    {"name": "박물관 카페", "type": "cafe", "lat": 35.8294, "lng": 129.2283},
)


def _rate(row: dict[str, Any]) -> float | None:
    try:
        value = float(row["tourapi_concentration_rate"]) / 100.0
    except (KeyError, TypeError, ValueError, OverflowError):
        return None
    return max(0.0, min(1.0, value)) if math.isfinite(value) else None


def _valid_forecast_rate(row: dict[str, Any]) -> bool:
    try:
        return math.isfinite(float(row["concentration_rate"]))
    except (KeyError, TypeError, ValueError, OverflowError):
        return False


def _ratio(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


def _valid_coordinates(row: dict[str, Any]) -> bool:
    try:
        latitude = float(row["latitude"])
        longitude = float(row["longitude"])
    except (KeyError, TypeError, ValueError, OverflowError):
        return False
    return math.isfinite(latitude) and math.isfinite(longitude)


def attach_and_measure_tourism_coverage(
    facilities: list[dict[str, Any]], forecasts: list[dict[str, Any]]
) -> dict[str, Any]:
    """Attach priors and compare safe aliases with the former exact-name anchors."""
    legacy_names = {
        str(row.get("tourist_attraction_name") or "").strip()
        for row in forecasts
        if row.get("tourist_attraction_name") and _valid_forecast_rate(row)
    }
    legacy_exact = [
        row
        for row in facilities
        if _valid_coordinates(row)
        and str(row.get("name") or "").strip() in legacy_names
    ]
    safe_matches = [
        match
        for match in match_tourism_forecasts_to_facilities(facilities, forecasts)
        if _valid_coordinates(match.facility) and _valid_forecast_rate(match.forecast)
    ]
    safe_alias_matches = [
        match
        for match in safe_matches
        if str(match.facility.get("name") or "").strip()
        != str(match.forecast.get("tourist_attraction_name") or "").strip()
    ]

    attach_tourism_area_priors(facilities, forecasts)
    valid_facilities = [row for row in facilities if _valid_coordinates(row)]
    propagated = [row for row in valid_facilities if _rate(row) is not None]
    return {
        "legacy_exact_direct_anchor_count": len(legacy_exact),
        "safe_direct_anchor_count": len(safe_matches),
        "safe_alias_direct_anchor_count": len(safe_alias_matches),
        "safe_direct_anchor_delta_vs_legacy_exact": len(safe_matches)
        - len(legacy_exact),
        "facility_count_with_coordinates": len(valid_facilities),
        "facility_count_after_2km_propagation": len(propagated),
        "facility_coverage_after_2km_propagation": _ratio(
            len(propagated), len(valid_facilities)
        ),
        "safe_alias_matches": [
            {
                "facility_name": str(match.facility.get("name") or ""),
                "forecast_name": str(
                    match.forecast.get("tourist_attraction_name") or ""
                ),
            }
            for match in safe_alias_matches
        ],
    }


def evaluate_tourism_demand_impact(
    facilities: list[dict[str, Any]],
    scenarios: list[dict[str, Any]]
    | tuple[dict[str, Any], ...] = DEFAULT_EVALUATION_SCENARIOS,
    *,
    candidate_radius_m: float = 3_000.0,
    candidate_limit: int = 30,
) -> dict[str, Any]:
    """Measure ranking differentiation with every non-tourism factor held constant.

    This intentionally does not claim forecast accuracy.  It measures whether the
    currently attached KTO priors can distinguish alternatives at all, using the
    same eight-minute statistical penalty cap as ``area_demand_service``.
    """
    valid_facilities = [
        row
        for row in facilities
        if row.get("id") is not None
        and row.get("latitude") is not None
        and row.get("longitude") is not None
    ]
    facility_covered = sum(_rate(row) is not None for row in valid_facilities)
    controlled_rank_changed = 0
    distinguishable = 0
    distinguishable_denominator = 0
    same_anchor = 0
    same_anchor_denominator = 0
    top3_total = 0
    top3_covered = 0
    reports = []

    for scenario in scenarios:
        candidates = []
        for row in valid_facilities:
            if scenario.get("type") and row.get("type") != scenario["type"]:
                continue
            try:
                route = estimate_walking_route(
                    float(scenario["lat"]),
                    float(scenario["lng"]),
                    float(row["latitude"]),
                    float(row["longitude"]),
                )
            except (KeyError, TypeError, ValueError, OverflowError):
                continue
            if route.distance_m > candidate_radius_m:
                continue
            rate = _rate(row)
            candidates.append(
                {
                    "facility_id": str(row["id"]),
                    "walk_minutes": route.duration_min,
                    "tourism_rate": rate,
                    "tourism_basis": row.get("tourapi_concentration_basis"),
                    "with_tourism_minutes": (
                        route.duration_min + rate * _MAX_TOURISM_PENALTY_MIN
                        if rate is not None
                        else route.duration_min
                    ),
                }
            )

        before = sorted(
            candidates,
            key=lambda row: (row["walk_minutes"], row["facility_id"]),
        )[:candidate_limit]
        after = sorted(
            candidates,
            key=lambda row: (
                row["with_tourism_minutes"],
                row["walk_minutes"],
                row["facility_id"],
            ),
        )[:candidate_limit]
        before_top3 = before[:3]
        after_top3 = after[:3]
        before_ids = [row["facility_id"] for row in before_top3]
        after_ids = [row["facility_id"] for row in after_top3]
        changed = before_ids != after_ids
        controlled_rank_changed += int(changed)

        rates = [
            row["tourism_rate"] for row in after_top3 if row["tourism_rate"] is not None
        ]
        can_compare = len(rates) >= 2
        is_distinguishable = (
            can_compare and max(rates) - min(rates) >= _DISTINGUISHABLE_SPREAD
        )
        distinguishable_denominator += int(can_compare)
        distinguishable += int(is_distinguishable)

        anchors = [
            str(row["tourism_basis"]) for row in after_top3 if row["tourism_basis"]
        ]
        anchor_comparable = len(anchors) >= 2
        shares_one_anchor = anchor_comparable and len(set(anchors)) == 1
        same_anchor_denominator += int(anchor_comparable)
        same_anchor += int(shares_one_anchor)
        top3_total += len(after_top3)
        top3_covered += len(rates)

        reports.append(
            {
                "name": scenario["name"],
                "candidate_count": len(candidates),
                "controlled_before_top3": before_ids,
                "controlled_after_top3": after_ids,
                "controlled_rank_changed": changed,
                "top3_demand_distinguishable": is_distinguishable,
                "top3_all_same_anchor": shares_one_anchor,
                "top3_source_coverage": _ratio(len(rates), len(after_top3)),
                "after_top3_evidence": [
                    {
                        "facility_id": row["facility_id"],
                        "tourism_basis": row["tourism_basis"],
                        "tourism_rate": row["tourism_rate"],
                    }
                    for row in after_top3
                ],
            }
        )

    scenario_count = len(reports)
    return {
        "method": "controlled_walk_time_plus_kto_statistical_penalty",
        "limitations": (
            "추천 정확도나 실시간 매장 혼잡을 측정하지 않는다. 취향·주차·행사·날씨를 고정한 상태에서 "
            "관광공사 일별 통계가 후보를 실제로 구분하는지만 측정한다."
        ),
        "actual_production_rank_comparison": (
            "not_computed_without_user_specific_request_snapshot"
        ),
        "scenario_count": scenario_count,
        "facility_count": len(valid_facilities),
        "facility_source_coverage": _ratio(facility_covered, len(valid_facilities)),
        "top3_source_coverage": _ratio(top3_covered, top3_total),
        "controlled_rank_changed_scenario_rate": _ratio(
            controlled_rank_changed, scenario_count
        ),
        "top3_demand_distinguishable_rate": _ratio(
            distinguishable, distinguishable_denominator
        ),
        "top3_demand_distinguishable_denominator": distinguishable_denominator,
        "top3_all_same_anchor_rate": _ratio(same_anchor, same_anchor_denominator),
        "top3_same_anchor_denominator": same_anchor_denominator,
        "scenarios": reports,
    }
