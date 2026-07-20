"""Deterministic eligibility and arrival-status rules for recommendations."""
from datetime import datetime, timedelta, timezone
import re
from typing import Literal

from pydantic import BaseModel, Field

from app.services.spot.travel import WALKING_SPEED_M_PER_MIN

KST = timezone(timedelta(hours=9))
VALID_CATEGORIES = {"restaurant", "cafe", "attraction", "culture"}
VALID_ATTRIBUTES = {"indoor", "accessible"}


class TravelContext(BaseModel):
    categories: list[Literal["restaurant", "cafe", "attraction", "culture"]] = Field(default_factory=list)
    max_walk_minutes: Literal[5, 10, 20] | None = None
    available_minutes: Literal[30, 60, 120] | None = None
    required_attributes: list[Literal["indoor", "accessible"]] = Field(default_factory=list)
    exclude_visited: bool = False
    visited_facility_ids: list[str] = Field(default_factory=list, max_length=200)

    @property
    def max_distance_m(self) -> float | None:
        return self.max_walk_minutes * WALKING_SPEED_M_PER_MIN if self.max_walk_minutes else None


def facility_matches_context(facility: dict, context: TravelContext | None) -> bool:
    if context is None:
        return True
    if context.categories and facility.get("type") not in context.categories:
        return False
    if context.exclude_visited and facility.get("id") in set(context.visited_facility_ids):
        return False
    features = facility.get("features") or {}
    for attr in context.required_attributes:
        # Accessibility is fail-closed: a generic `accessible` claim is not verification.
        if attr == "accessible":
            matches = facility.get("barrier_free") is True or features.get("accessible_verified") is True
        else:
            matches = features.get(attr) is True or features.get(f"{attr}_verified") is True
        if not matches:
            return False
    return True


def _minutes(value: str) -> int | None:
    match = re.fullmatch(r"\s*(\d{1,2}):([0-5]\d)\s*", value)
    if not match:
        return None
    hour, minute = map(int, match.groups())
    return hour * 60 + minute if hour < 24 else None


def open_status_at_arrival(facility: dict, arrival_at: datetime) -> str:
    """Return one of open_expected, closing_soon, closed_confirmed, needs_confirmation."""
    local = arrival_at.astimezone(KST)
    hours = facility.get("operating_hours") or {}
    closed_text = str(hours.get("closed") or "")
    weekday_tokens = ("월", "화", "수", "목", "금", "토", "일")
    weekday_names = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
    if "연중무휴" not in closed_text and closed_text:
        token = weekday_tokens[local.weekday()]
        english = weekday_names[local.weekday()]
        if (
            re.search(rf"(?:매주|매월|요일|휴무)[^\n]{{0,12}}{token}|{token}요일", closed_text)
            or re.search(rf"\b{english}\b", closed_text.lower())
        ):
            return "closed_confirmed"

    day_key = "weekday" if local.weekday() < 5 else "weekend"
    raw = str(hours.get(day_key) or hours.get("open") or "")
    ranges = re.findall(
        r"((?:[01]?\d|2[0-3]):[0-5]\d)\s*(?:~|-|–|—)\s*((?:[01]?\d|2[0-3]):[0-5]\d)", raw
    )
    if not ranges:
        return "needs_confirmation"
    now_min = local.hour * 60 + local.minute
    for opened_raw, closed_raw in ranges:
        opened, closed = _minutes(opened_raw), _minutes(closed_raw)
        if opened is None or closed is None:
            continue
        if closed < opened:
            is_open = now_min >= opened or now_min < closed
            remaining = (closed - now_min) % (24 * 60)
        else:
            is_open = opened <= now_min < closed
            remaining = closed - now_min
        if is_open:
            return "closing_soon" if remaining <= 30 else "open_expected"
    return "closed_confirmed"
