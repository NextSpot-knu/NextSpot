import asyncio
from pathlib import Path

from scripts.recommendation_quality import classify_culture_indoor_evidence, evaluate_fixture


def test_twelve_golden_recommendation_scenarios():
    fixture = Path(__file__).parent / "fixtures" / "recommendation_quality.json"
    report = asyncio.run(evaluate_fixture(fixture))
    assert report["scenario_count"] == 12
    assert report["hard_failures"] == []


def test_culture_indoor_evidence_distinguishes_missing_from_verified_non_indoor():
    facilities = [
        {"id": "indoor", "type": "culture", "features": {"indoor_verified": True}},
        {"id": "outdoor", "type": "culture", "features": {"indoor_verified": False}},
        {"id": "missing", "type": "culture", "features": {}},
        {"id": "cafe", "type": "cafe", "features": {}},
    ]

    assert classify_culture_indoor_evidence(facilities) == {
        "culture_without_indoor_evidence_ids": ["missing"],
        "culture_verified_non_indoor_ids": ["outdoor"],
    }
