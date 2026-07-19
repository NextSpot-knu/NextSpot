from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app.services.travel_context import TravelContext, facility_matches_context, open_status_at_arrival


def test_context_validates_server_enums_and_ranges():
    with pytest.raises(ValidationError):
        TravelContext(max_walk_minutes=3)
    with pytest.raises(ValidationError):
        TravelContext(required_attributes=["wheelchair_maybe"])


def test_required_attribute_is_fail_closed():
    context = TravelContext(required_attributes=["accessible"])
    assert not facility_matches_context({"id": "unknown", "features": {}}, context)
    assert not facility_matches_context(
        {"id": "unverified-claim", "features": {"accessible": True}}, context
    )
    assert facility_matches_context(
        {"id": "verified", "features": {"accessible_verified": True}}, context
    )
    assert facility_matches_context(
        {"id": "tourapi-verified", "barrier_free": True, "features": {}}, context
    )


def test_exclude_visited_and_category_are_eligibility_only():
    context = TravelContext(
        categories=["culture"], exclude_visited=True, visited_facility_ids=["seen"]
    )
    assert not facility_matches_context({"id": "seen", "type": "culture"}, context)
    assert not facility_matches_context({"id": "new", "type": "cafe"}, context)
    assert facility_matches_context({"id": "new", "type": "culture"}, context)


def test_unknown_hours_are_not_treated_as_closed():
    facility = {"operating_hours": {"open": "문의 필요"}}
    assert open_status_at_arrival(facility, datetime(2026, 7, 20, 4, tzinfo=timezone.utc)) == "needs_confirmation"


def test_arrival_status_open_closing_and_closed():
    facility = {"operating_hours": {"open": "09:00~18:00", "closed": "연중무휴"}}
    assert open_status_at_arrival(facility, datetime(2026, 7, 20, 7, tzinfo=timezone.utc)) == "open_expected"
    assert open_status_at_arrival(facility, datetime(2026, 7, 20, 8, 40, tzinfo=timezone.utc)) == "closing_soon"
    assert open_status_at_arrival(facility, datetime(2026, 7, 20, 10, tzinfo=timezone.utc)) == "closed_confirmed"


def test_multiple_ranges_and_overnight_hours():
    split = {"operating_hours": {"open": "09:00~12:00, 13:00~18:00"}}
    assert open_status_at_arrival(split, datetime(2026, 7, 20, 5, tzinfo=timezone.utc)) == "open_expected"
    overnight = {"operating_hours": {"open": "18:00~02:00"}}
    assert open_status_at_arrival(overnight, datetime(2026, 7, 20, 16, tzinfo=timezone.utc)) == "open_expected"
