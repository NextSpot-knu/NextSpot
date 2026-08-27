from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from app.routers import recommendations

from app.services.availability_service import (
    attach_availability_evidence,
    is_effective_availability_evidence,
)


def test_only_fresh_corroborated_evidence_is_effective():
    now = datetime(2026, 8, 25, 3, tzinfo=timezone.utc)
    base = {
        "status": "open",
        "evidence_tier": "corroborated",
        "corroborating_count": 2,
        "expires_at": (now + timedelta(minutes=10)).isoformat(),
    }
    assert is_effective_availability_evidence(base, at=now)
    assert not is_effective_availability_evidence(
        {**base, "evidence_tier": "single_report"}, at=now
    )
    assert not is_effective_availability_evidence(
        {**base, "corroborating_count": 1}, at=now
    )
    assert not is_effective_availability_evidence(
        {**base, "expires_at": (now - timedelta(seconds=1)).isoformat()}, at=now
    )


def test_attach_evidence_does_not_mutate_cached_facilities():
    facilities = [{"id": "f1", "name": "one"}, {"id": "f2", "name": "two"}]
    evidence = {"f1": {"status": "closed"}}
    attached = attach_availability_evidence(facilities, evidence)
    assert "availability_evidence" not in facilities[0]
    assert attached[0]["availability_evidence"] == {"status": "closed"}
    assert attached[1]["availability_evidence"] is None


@pytest.mark.asyncio
async def test_recommendation_cache_never_caches_short_lived_availability(monkeypatch):
    cached_facilities = [{"id": "f1", "name": "one"}]
    cached = AsyncMock(return_value=cached_facilities)
    evidence = AsyncMock(
        side_effect=[
            {},
            {
                "f1": {
                    "status": "open",
                    "evidence_tier": "corroborated",
                    "corroborating_count": 2,
                }
            },
        ]
    )
    monkeypatch.setattr(recommendations, "get_facilities_cached", cached)
    monkeypatch.setattr(recommendations, "fetch_effective_availability_map", evidence)

    first = await recommendations.fetch_all_facilities()
    second = await recommendations.fetch_all_facilities()

    assert first[0]["availability_evidence"] is None
    assert second[0]["availability_evidence"]["status"] == "open"
    assert "availability_evidence" not in cached_facilities[0]
    assert evidence.await_count == 2
