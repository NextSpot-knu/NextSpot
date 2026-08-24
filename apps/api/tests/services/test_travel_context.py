from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app.services.travel_context import (
    TravelContext,
    facility_is_indoor_eligible,
    facility_matches_context,
    is_recommendable_at_arrival,
    keep_best_eligibility_tier,
    open_status_at_arrival,
    recommendation_eligibility_tier,
)


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


def test_indoor_eligibility_infers_food_venues_but_honors_explicit_false():
    context = TravelContext(required_attributes=["indoor"])
    for facility_type in ("restaurant", "cafe"):
        facility = {"id": facility_type, "type": facility_type, "features": {}}
        assert facility_is_indoor_eligible(facility)
        assert facility_matches_context(facility, context)
        facility["features"] = {"indoor_verified": False}
        assert not facility_is_indoor_eligible(facility)
        assert not facility_matches_context(facility, context)


def test_indoor_eligibility_keeps_culture_and_attraction_fail_closed():
    for facility_type in ("culture", "attraction"):
        facility = {"id": facility_type, "type": facility_type, "features": {}}
        assert not facility_is_indoor_eligible(facility)
        facility["features"] = {"indoor_verified": True}
        assert facility_is_indoor_eligible(facility)


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


def test_food_with_unknown_hours_is_not_recommended_but_known_open_is():
    arrival = datetime(2026, 7, 20, 17, tzinfo=timezone.utc)  # 02:00 KST
    assert not is_recommendable_at_arrival(
        {"type": "cafe", "operating_hours": {}}, arrival
    )
    assert not is_recommendable_at_arrival(
        {"type": "restaurant", "operating_hours": {"open": "09:00~22:00"}}, arrival
    )
    assert is_recommendable_at_arrival(
        {"type": "cafe", "operating_hours": {"open": "18:00~03:00"}}, arrival
    )


def test_unknown_food_is_confirmation_only_by_day_and_excluded_late_at_night():
    unknown = {"type": "cafe", "operating_hours": {}}
    noon_kst = datetime(2026, 7, 20, 3, tzinfo=timezone.utc)
    two_am_kst = datetime(2026, 7, 20, 17, tzinfo=timezone.utc)
    assert is_recommendable_at_arrival(unknown, noon_kst)
    assert recommendation_eligibility_tier(unknown, noon_kst, "osm_pedestrian") == 2
    assert recommendation_eligibility_tier(unknown, two_am_kst, "osm_pedestrian") is None


def test_closing_soon_is_not_a_destination_candidate():
    facility = {"type": "restaurant", "operating_hours": {"open": "09:00~18:00"}}
    arrival = datetime(2026, 7, 20, 8, 40, tzinfo=timezone.utc)
    assert open_status_at_arrival(facility, arrival) == "closing_soon"
    assert not is_recommendable_at_arrival(facility, arrival)
    assert recommendation_eligibility_tier(facility, arrival, "osm_pedestrian") is None


def test_best_candidate_tier_never_fills_from_weaker_tiers():
    candidates = [
        ("unknown-route", object(), 3),
        ("verified-a", object(), 0),
        ("verified-b", object(), 0),
        ("known-estimate", object(), 1),
    ]
    selected = keep_best_eligibility_tier(candidates)
    assert [candidate[0] for candidate in selected] == ["verified-a", "verified-b"]


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


def test_seed_weekday_weekend_and_english_closed_day():
    facility = {
        "operating_hours": {
            "closed": "monday",
            "weekday": "10:00-18:00",
            "weekend": "10:00-19:00",
        }
    }
    monday_noon = datetime(2026, 7, 20, 3, 0, tzinfo=timezone.utc)
    saturday_evening = datetime(2026, 7, 18, 9, 30, tzinfo=timezone.utc)
    assert open_status_at_arrival(facility, monday_noon) == "closed_confirmed"
    assert open_status_at_arrival(facility, saturday_evening) == "closing_soon"
