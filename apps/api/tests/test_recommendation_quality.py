import asyncio
from pathlib import Path

from scripts.recommendation_quality import evaluate_fixture


def test_twelve_golden_recommendation_scenarios():
    fixture = Path(__file__).parent / "fixtures" / "recommendation_quality.json"
    report = asyncio.run(evaluate_fixture(fixture))
    assert report["scenario_count"] == 12
    assert report["hard_failures"] == []
