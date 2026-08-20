"""Rules for deciding which observed congestion may influence ranking."""
from datetime import datetime, timedelta, timezone

TRUSTED_EVIDENCE_TIERS = {"verified", "corroborated"}
RANKING_FRESHNESS = timedelta(minutes=30)


def _parse_timestamp(value: object) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def rankable_measured_level(evidence: dict | None, *, now: datetime | None = None) -> float | None:
    """Return a measured level only when it is recent and independently trustworthy."""
    if not evidence or evidence.get("source") != "measured":
        return None
    if evidence.get("evidence_tier") not in TRUSTED_EVIDENCE_TIERS:
        return None
    timestamp = _parse_timestamp(evidence.get("timestamp"))
    if timestamp is None:
        return None
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    age = current - timestamp
    if age < timedelta(0) or age > RANKING_FRESHNESS:
        return None
    try:
        return max(0.0, min(1.0, float(evidence.get("level"))))
    except (TypeError, ValueError):
        return None
