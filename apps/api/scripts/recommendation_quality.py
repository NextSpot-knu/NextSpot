"""Deterministic recommendation quality gate and privacy-safe live smoke report."""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import urllib.request
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.services.spot.preference import get_category_average_vector
from app.services.spot.score import calculate_spot_score
from app.services.spot.travel import WALKING_SPEED_M_PER_MIN, calculate_haversine_distance
from app.services.travel_context import (
    TravelContext,
    facility_is_indoor_eligible,
    facility_matches_context,
    open_status_at_arrival,
)

FIXED_NOW = datetime.fromisoformat("2026-07-20T03:00:00+00:00")  # Monday noon KST
DEFAULT_FIXTURE = ROOT / "tests" / "fixtures" / "recommendation_quality.json"


async def evaluate_fixture(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    facilities = payload["facilities"]
    results = []
    hard_failures = []
    with (
        patch("app.services.spot.score.predict_congestion", return_value=0.35),
        patch("app.services.spot.score.get_event_congestion_boost", return_value=(0.0, None)),
    ):
        for scenario in payload["scenarios"]:
            context = TravelContext.model_validate(scenario.get("context") or {})
            origin = scenario["origin"]
            scored = []
            for facility in facilities:
                distance = calculate_haversine_distance(
                    origin["lat"], origin["lng"], facility["latitude"], facility["longitude"]
                )
                arrival = FIXED_NOW + __import__("datetime").timedelta(
                    minutes=distance / WALKING_SPEED_M_PER_MIN
                )
                if not facility_matches_context(facility, context):
                    continue
                if context.max_distance_m is not None and distance > context.max_distance_m:
                    continue
                if open_status_at_arrival(facility, arrival) == "closed_confirmed":
                    continue
                preferred = scenario.get("preferred_categories") or list(context.categories) or [facility["type"]]
                score = await calculate_spot_score(
                    user_id="quality-fixture", preferred_categories=preferred,
                    original_congestion_level=0.7, candidate_facility=facility,
                    user_lat=origin["lat"], user_lng=origin["lng"],
                    user_vector=get_category_average_vector(preferred), depart_time=FIXED_NOW,
                )
                scored.append({"id": facility["id"], "score": score.score, "distance_m": distance})
            scored.sort(key=lambda item: (-item["score"], item["distance_m"], item["id"]))
            actual_ids = [item["id"] for item in scored]
            actual_scores = [item["score"] for item in scored]
            expected_ids = scenario["expected_ids"]
            expected_scores = scenario["expected_scores"]
            failures = []
            if actual_ids != expected_ids:
                failures.append("rank_or_filter")
            if actual_scores != expected_scores:
                failures.append("score")
            if failures:
                hard_failures.append({"scenario": scenario["name"], "failures": failures})
            results.append({
                "name": scenario["name"], "facility_ids": actual_ids,
                "spot_scores": actual_scores, "hard_failures": failures,
            })
    return {"mode": "fixture", "scenario_count": len(results), "hard_failure_count": len(hard_failures),
            "hard_failures": hard_failures, "scenarios": results}


def classify_culture_indoor_evidence(facilities: list[dict]) -> dict[str, list[str]]:
    missing = []
    verified_non_indoor = []
    for row in facilities:
        if row.get("type") != "culture":
            continue
        features = row.get("features") or {}
        if features.get("indoor") is True or features.get("indoor_verified") is True:
            continue
        if features.get("indoor_verified") is False:
            verified_non_indoor.append(row.get("id"))
        else:
            missing.append(row.get("id"))
    return {
        "culture_without_indoor_evidence_ids": missing,
        "culture_verified_non_indoor_ids": verified_non_indoor,
    }


def evaluate_live(base_url: str, bearer: str | None, user_id: str | None) -> dict:
    url = f"{base_url.rstrip('/')}/api/v1/infrastructures"
    with urllib.request.urlopen(url, timeout=30) as response:  # noqa: S310 - explicit CLI URL
        facilities = json.load(response)
    # Privacy boundary: only public landmark coordinates and derived recommendation facts are emitted.
    scenarios_config = [
        ("황리단길 중립", "attraction", 35.8380, 129.2090, {}),
        ("황리단길 음식점", "restaurant", 35.8380, 129.2090, {"categories": ["restaurant"]}),
        ("황리단길 카페", "cafe", 35.8380, 129.2090, {"categories": ["cafe"]}),
        ("첨성대 10분 도보", "attraction", 35.8347, 129.2191, {"max_walk_minutes": 10}),
        ("첨성대 실내 문화", "culture", 35.8347, 129.2191, {"categories": ["culture"], "required_attributes": ["indoor"]}),
        ("첨성대 무장애", "attraction", 35.8347, 129.2191, {"required_attributes": ["accessible"]}),
        ("박물관 권역 중립", "culture", 35.8294, 129.2283, {}),
        ("박물관 권역 카페", "cafe", 35.8294, 129.2283, {"categories": ["cafe"]}),
        ("돼지고기 유형", "restaurant", 35.8380, 129.2090, {"categories": ["restaurant"]}),
        ("조용한 카페 유형", "cafe", 35.8380, 129.2090, {"categories": ["cafe"]}),
        ("비가 와서 실내", "culture", 35.8380, 129.2090, {"required_attributes": ["indoor"]}),
        ("가까운 곳 5분", "cafe", 35.8380, 129.2090, {"max_walk_minutes": 5}),
    ]
    scenarios = []
    hard_failures = []
    warnings = []
    if not (bearer and user_id):
        hard_failures.append({"scenario": "live authentication", "failures": ["missing_bearer_or_user_id"]})
    for name, facility_type, lat, lng, context in scenarios_config:
        ranked = []
        if bearer and user_id:
            body = json.dumps({
                "user_id": user_id, "facility_type": facility_type, "user_lat": lat, "user_lng": lng,
                "exclude_ids": [], "limit": 5, "context": context,
            }).encode()
            request = urllib.request.Request(
                f"{base_url.rstrip('/')}/api/v1/recommendations/by-type", data=body,
                headers={"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 - explicit CLI URL
                ranked = json.load(response)
        scenario_failures = []
        for row in ranked:
            facility = row.get("facility") or {}
            distance = float(row.get("distance_m") or 0)
            if facility.get("type") != facility_type:
                scenario_failures.append("facility_type")
            max_minutes = context.get("max_walk_minutes")
            if max_minutes and distance > max_minutes * WALKING_SPEED_M_PER_MIN + 0.1:
                scenario_failures.append("max_walk_minutes")
            if row.get("open_status_at_arrival") == "closed_confirmed":
                scenario_failures.append("closed_confirmed")
            features = facility.get("features") or {}
            required = context.get("required_attributes") or []
            if "accessible" in required and not (
                facility.get("barrier_free") is True or features.get("accessible_verified") is True
            ):
                scenario_failures.append("unverified_accessibility")
            if "indoor" in required and not facility_is_indoor_eligible(facility):
                scenario_failures.append("not_indoor")
            if row.get("congestion_source") == "none" and row.get("congestion_level") is not None:
                scenario_failures.append("unsupported_congestion_measurement")
        expected_order = sorted(
            ranked,
            key=lambda row: (
                -float(row.get("spot_score") or 0), float(row.get("distance_m") or 0),
                str((row.get("facility") or {}).get("id") or ""),
            ),
        )
        if ranked != expected_order:
            scenario_failures.append("spot_tie_break")
        scenario_failures = sorted(set(scenario_failures))
        if scenario_failures:
            hard_failures.append({"scenario": name, "failures": scenario_failures})
        if bearer and user_id and not ranked:
            warnings.append({"scenario": name, "warning": "no_eligible_recommendations"})
        scenarios.append({
            "name": name,
            "hard_failures": scenario_failures,
            "items": [{
                "facility_id": row.get("facility", {}).get("id"),
                "facility_type": row.get("facility", {}).get("type"),
                "spot_score": row.get("spot_score"), "distance_m": row.get("distance_m"),
                "open_evidence": row.get("open_status_at_arrival") or "none",
                "congestion_evidence": row.get("congestion_source") or "none",
            } for row in ranked],
        })
    return {"mode": "live", "scenario_count": len(scenarios), "facility_count": len(facilities),
            "authenticated_recommendations": bool(bearer and user_id),
            "hard_failure_count": len(hard_failures), "hard_failures": hard_failures,
            "warning_count": len(warnings), "warnings": warnings,
            "data_gaps": classify_culture_indoor_evidence(facilities),
            "scenarios": scenarios}


def write_report(report: dict, output: Path | None) -> None:
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("fixture", "live"))
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--base-url", default="https://nextspot-api.onrender.com")
    parser.add_argument("--bearer", help="Anonymous/user JWT; never written to the report")
    parser.add_argument("--user-id", help="User id matching the JWT; never written to the report")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = (asyncio.run(evaluate_fixture(args.fixture)) if args.mode == "fixture"
              else evaluate_live(args.base_url, args.bearer, args.user_id))
    write_report(report, args.output)
    return 1 if report["hard_failure_count"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
