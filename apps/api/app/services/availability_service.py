"""Short-lived, corroborated opening-status evidence for recommendation eligibility."""

import asyncio
from datetime import datetime, timezone

import structlog

from app.core.supabase import supabase_admin

logger = structlog.get_logger()


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def is_effective_availability_evidence(
    evidence: dict | None,
    *,
    at: datetime | None = None,
) -> bool:
    """Only fresh, two-user corroborated evidence may affect recommendations."""
    if not evidence or evidence.get("evidence_tier") != "corroborated":
        return False
    if evidence.get("status") not in {"open", "closed"}:
        return False
    if int(evidence.get("corroborating_count") or 0) < 2:
        return False
    expires_at = _parse_timestamp(evidence.get("expires_at"))
    if expires_at is None:
        return False
    current = at or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return expires_at > current


async def fetch_effective_availability_map(facility_ids: list[str]) -> dict[str, dict]:
    """Fetch the newest unexpired corroborated report per facility in one query."""
    unique_ids = list(dict.fromkeys(str(fid) for fid in facility_ids if fid))
    if not unique_ids:
        return {}
    now = datetime.now(timezone.utc)
    try:
        result = await asyncio.to_thread(
            supabase_admin.table("facility_availability_reports")
            .select(
                "facility_id,status,evidence_tier,corroborating_count,reported_at,expires_at"
            )
            .in_("facility_id", unique_ids)
            .eq("evidence_tier", "corroborated")
            .gt("expires_at", now.isoformat())
            .order("reported_at", desc=True)
            .execute
        )
    except Exception as exc:
        # Migration-first deployment is preferred, but an unavailable evidence table must not
        # take the whole recommendation service down.
        logger.warning("availability_evidence_unavailable", error=str(exc))
        return {}

    evidence_by_id: dict[str, dict] = {}
    for row in result.data or []:
        facility_id = str(row.get("facility_id") or "")
        if facility_id and facility_id not in evidence_by_id and is_effective_availability_evidence(
            row, at=now
        ):
            evidence_by_id[facility_id] = row
    return evidence_by_id


def attach_availability_evidence(
    facilities: list[dict], evidence_by_id: dict[str, dict]
) -> list[dict]:
    """Return isolated facility dictionaries with optional evidence attached."""
    return [
        {
            **facility,
            "availability_evidence": evidence_by_id.get(str(facility.get("id"))),
        }
        for facility in facilities
    ]
