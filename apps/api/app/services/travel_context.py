"""Deterministic eligibility and arrival-status rules for recommendations."""
from datetime import datetime, timedelta, timezone
import re
from typing import Literal

from pydantic import BaseModel, Field

from app.services.availability_service import is_effective_availability_evidence
from app.services.spot.travel import WALKING_SPEED_M_PER_MIN

KST = timezone(timedelta(hours=9))
VALID_CATEGORIES = {"restaurant", "cafe", "attraction", "culture"}
VALID_ATTRIBUTES = {"indoor", "accessible"}
DEFAULT_INDOOR_TYPES = {"restaurant", "cafe"}
FOOD_TYPES = {"restaurant", "cafe"}
LATE_NIGHT_START_MINUTE = 22 * 60
LATE_NIGHT_END_MINUTE = 6 * 60

# 후보 자격은 SPOT 점수보다 먼저 적용한다. 숫자가 작을수록 근거가 강하며, 한 요청에서는
# 가장 강한 비어 있지 않은 tier 하나만 사용한다. 따라서 낮은 신뢰도 후보로 Top N을 억지로
# 채우지 않고, 선택된 tier 안에서는 기존 SPOT 원점수 순서를 그대로 유지할 수 있다.
RECOMMENDATION_ELIGIBILITY_LABELS = {
    0: "verified_open_route",
    1: "verified_open_estimated_route",
    2: "hours_confirmation_required_route",
    3: "hours_and_route_confirmation_required",
}


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


def facility_is_indoor_eligible(facility: dict) -> bool:
    """Return rain-safe indoor eligibility without claiming inferred evidence is verified."""
    features = facility.get("features") or {}
    if features.get("indoor") is False or features.get("indoor_verified") is False:
        return False
    if features.get("indoor") is True or features.get("indoor_verified") is True:
        return True
    return facility.get("type") in DEFAULT_INDOOR_TYPES


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
            matches = facility_is_indoor_eligible(facility)
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
    availability = facility.get("availability_evidence")
    if is_effective_availability_evidence(availability, at=arrival_at):
        return "open_expected" if availability["status"] == "open" else "closed_confirmed"
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


def is_recommendable_at_arrival(facility: dict, arrival_at: datetime) -> bool:
    """Return whether the place can enter any honest recommendation tier."""
    status = open_status_at_arrival(facility, arrival_at)
    # 도착 후 30분 안에 닫히는 곳도 이동 목적지로 권하지 않는다.
    if status in {"closed_confirmed", "closing_soon"}:
        return False
    if status == "needs_confirmation" and facility.get("type") in FOOD_TYPES:
        local = arrival_at.astimezone(KST)
        minute = local.hour * 60 + local.minute
        # 심야에는 미확인 식당·카페를 '확인 필요' 후보로도 보내지 않는다.
        if minute >= LATE_NIGHT_START_MINUTE or minute < LATE_NIGHT_END_MINUTE:
            return False
    return True


def recommendation_eligibility_tier(
    facility: dict,
    arrival_at: datetime,
    travel_source: str,
) -> int | None:
    """Classify a candidate before SPOT scoring; ``None`` means never recommend.

    Opening-hours evidence is more important than route precision. A verified-open
    place with an honest distance estimate therefore remains preferable to a place
    whose opening hours are unknown. Callers must use only the lowest non-empty tier.
    """
    if not is_recommendable_at_arrival(facility, arrival_at):
        return None
    hours_verified = open_status_at_arrival(facility, arrival_at) == "open_expected"
    route_verified = travel_source == "osm_pedestrian"
    if hours_verified:
        return 0 if route_verified else 1
    return 2 if route_verified else 3


def keep_best_eligibility_tier(candidates: list[tuple]) -> list[tuple]:
    """Keep the strongest non-empty tier without filling from weaker tiers.

    Each tuple must carry its numeric tier as the last item. Its original order is
    preserved so callers can perform the usual SPOT sort afterwards.
    """
    if not candidates:
        return []
    best = min(candidate[-1] for candidate in candidates)
    return [candidate for candidate in candidates if candidate[-1] == best]
