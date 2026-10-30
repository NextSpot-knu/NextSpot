from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.services.travel_context import (
    TIER_FILL_POOL_FACTOR,
    TravelContext,
    closed_day_status,
    facility_indoor_evidence,
    facility_is_indoor_eligible,
    facility_is_stroller_friendly,
    facility_matches_context,
    is_recommendable_at_arrival,
    open_status_at_arrival,
    recommendation_eligibility_tier,
    select_eligibility_tiers,
)

KST = timezone(timedelta(hours=9))


def test_context_validates_server_enums_and_ranges():
    with pytest.raises(ValidationError):
        TravelContext(max_walk_minutes=3)
    with pytest.raises(ValidationError):
        TravelContext(required_attributes=["wheelchair_maybe"])
    # 웹과의 계약 문자열은 정확히 'stroller' 다.
    assert TravelContext(required_attributes=["stroller"]).required_attributes == ["stroller"]


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


def test_rain_safe_culture_classes_are_indoor_with_an_evidence_marker():
    # 비 오는 날 '실내만' 이 박물관을 빼던 문제(평가 T5). TourAPI 문화시설 분류(cat3)가 건물인 곳만 실내다.
    museum = {"id": "m", "type": "culture", "features": {"source": "tourapi", "cat3": "A02060100"}}
    gallery = {"id": "g", "type": "culture", "features": {"cat3": "A02060500"}}
    context = TravelContext(required_attributes=["indoor"])
    for facility in (museum, gallery):
        assert facility_is_indoor_eligible(facility)
        assert facility_matches_context(facility, context)
        assert facility_indoor_evidence(facility) == "tourapi_culture_class"
    # 다른 근거는 다른 이름으로 남는다 — 음식점 기본값과 시설에 적힌 근거를 섞어 부르지 않는다.
    assert facility_indoor_evidence({"type": "cafe", "features": {}}) == "food_establishment_default"
    assert facility_indoor_evidence(
        {"type": "restaurant", "features": {"indoor": True, "indoor_evidence": "fixed_food_establishment"}}
    ) == "fixed_food_establishment"


def test_outdoor_or_unclassified_culture_is_never_marked_indoor():
    for cat3 in (
        "A02060600",  # 공연장 — 야외 공연장이 같은 분류
        "A02061100",  # 문화전수시설 — 마당·공방
        "A02010700",  # 사적지(관광지 분류)
        None, "",
    ):
        facility = {"id": str(cat3), "type": "culture", "features": {"cat3": cat3}}
        assert not facility_is_indoor_eligible(facility), cat3
    # 이름이 '박물관' 이어도 분류가 없으면 근거가 아니다(야외 전시장·유적 전시관 터).
    assert not facility_is_indoor_eligible({"name": "야외 박물관", "type": "culture", "features": {}})
    # 관광지는 분류가 박물관이어도 실내로 올리지 않는다(종류를 사람이 관광지로 고친 행).
    assert not facility_is_indoor_eligible({"type": "attraction", "features": {"cat3": "A02060100"}})
    # 사람이 야외로 바로잡은 값(indoor_verified=false)이 분류보다 먼저다.
    assert not facility_is_indoor_eligible(
        {"type": "culture", "features": {"cat3": "A02060100", "indoor_verified": False}}
    )


def test_stroller_is_a_separate_fail_closed_attribute():
    context = TravelContext(required_attributes=["stroller"])
    rental = {"id": "r", "type": "attraction", "features": {"chk_babycarriage": "유모차 대여 가능"}}
    no_rental = {"id": "n", "type": "attraction", "features": {"chk_babycarriage": "없음"}}
    unknown = {"id": "u", "type": "culture", "features": {"chk_babycarriage": "Y"}}
    empty = {"id": "e", "type": "cafe", "features": {}}
    assert facility_matches_context(rental, context)
    for facility in (no_rental, unknown, empty):
        assert not facility_matches_context(facility, context), facility["id"]
    # 밤 적재가 적은 칸(또는 사람이 고친 값)이 원문보다 먼저다.
    assert facility_is_stroller_friendly({"features": {"stroller": True}})
    assert not facility_is_stroller_friendly({"features": {"stroller": False, "chk_babycarriage": "가능"}})


def test_wheelchair_and_stroller_evidence_do_not_stand_in_for_each_other():
    wheelchair = {"id": "w", "type": "culture", "barrier_free": True, "features": {}}
    stroller = {"id": "s", "type": "culture", "features": {"stroller": True}}
    assert not facility_matches_context(wheelchair, TravelContext(required_attributes=["stroller"]))
    assert not facility_matches_context(stroller, TravelContext(required_attributes=["accessible"]))
    both = TravelContext(required_attributes=["indoor", "accessible", "stroller"])
    assert facility_matches_context(
        {"type": "culture", "barrier_free": True, "features": {"cat3": "A02060100", "stroller": True}}, both
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


def test_best_tier_alone_when_it_meets_the_limit():
    candidates = [
        ("unknown-route", 1.0, 3),
        ("verified-a", 4.0, 0),
        ("verified-b", 6.0, 0),
        ("known-estimate", 2.0, 1),
    ]
    selected = select_eligibility_tiers(candidates, 2, fill_weaker=True)
    assert [candidate[0] for candidate in selected] == ["verified-a", "verified-b"]


def test_weaker_tiers_fill_only_what_the_best_tier_cannot():
    # 확인된 곳이 하나라도 있으면 영업시간이 빈 카카오·LocalData 행이 통째로 빠지던 문제(P1-4).
    candidates = [
        ("verified", 9.0, 0),
        ("estimate", 5.0, 1),
        *[(f"unknown-{index}", float(index), 2) for index in range(30)],
    ]
    selected = select_eligibility_tiers(
        candidates, 5, fill_weaker=True, fill_order=lambda candidate: candidate[1]
    )
    names = [candidate[0] for candidate in selected]
    # 강한 등급 전부(1 + 1) 다음, 모자란 3곳 × 배수만 가까운 순으로 — 반경의 미확인 30곳을 다 채점하지 않는다.
    assert names[:2] == ["verified", "estimate"]
    assert names[2:] == [f"unknown-{index}" for index in range(3 * TIER_FILL_POOL_FACTOR)]


def test_without_the_fill_flag_only_the_best_tier_is_kept():
    # 등급 순으로 그리지 않는 구 번들(요청에 fill_weaker_tiers 없음)은 종전 그대로 가장 강한 등급만 받는다 —
    # 채운 미확인 카드가 그 화면에서 점수로 맨 앞에 서지 않게.
    candidates = [("verified", 9.0, 0), ("estimate", 5.0, 1), ("unknown", 1.0, 2)]
    assert [c[0] for c in select_eligibility_tiers(candidates, 5, fill_weaker=False)] == ["verified"]


def test_tier_fill_with_no_verified_place_keeps_the_whole_best_tier():
    # 가장 강한 등급이 미확인이면 종전처럼 그 등급 전부를 채점한다(그 안에서 점수로 고른다).
    candidates = [(f"unknown-{index}", float(index), 2) for index in range(8)] + [("route-unknown", 0.0, 3)]
    for fill in (True, False):
        selected = select_eligibility_tiers(candidates, 5, fill_weaker=fill)
        assert [candidate[0] for candidate in selected] == [f"unknown-{index}" for index in range(8)]
    assert select_eligibility_tiers([], 5, fill_weaker=True) == []


def test_sunday_no_longer_closes_every_weekday_closure():
    # 2026-10-31 재현: '요일' 의 '일' 이 일요일 토큰에 걸렸다. 2026-11-01 은 일요일.
    sunday_noon = datetime(2026, 11, 1, 12, tzinfo=KST)
    for closed in ("매주 월요일 휴무", "매주 화요일", "월,화 휴무", "월·화요일", "1월 1일, 설날 및 추석 당일"):
        facility = {"type": "restaurant", "operating_hours": {"open": "09:00~21:00", "closed": closed}}
        assert open_status_at_arrival(facility, sunday_noon) == "open_expected", closed
    sunday_only = {"type": "restaurant", "operating_hours": {"open": "09:00~21:00", "closed": "일요일 휴무"}}
    assert open_status_at_arrival(sunday_only, sunday_noon) == "closed_confirmed"


def test_concatenated_closed_day_text_is_read_again():
    # 검토(2026-10-31) 회귀: 붙여 쓴 휴무 문구가 '규칙 없음' 으로 떨어져 월요일에도 영업 확인(0등급)이었다.
    monday_noon = datetime(2026, 11, 2, 12, tzinfo=KST)
    for closed in ("매주월요일", "정기휴무:매주월요일", "휴무월요일", "매주월,화요일"):
        facility = {"type": "restaurant", "operating_hours": {"open": "09:00~18:00", "closed": closed}}
        assert open_status_at_arrival(facility, monday_noon) == "closed_confirmed", closed
        assert recommendation_eligibility_tier(facility, monday_noon, "osm_pedestrian") is None, closed
    # 붙여 쓴 '당일' 의 '일' 은 여전히 일요일이 아니다.
    sunday = {"type": "restaurant", "operating_hours": {"open": "09:00~18:00", "closed": "설날 당일, 월요일"}}
    assert open_status_at_arrival(sunday, datetime(2026, 11, 1, 12, tzinfo=KST)) == "open_expected"


def test_pathological_text_finishes_without_catastrophic_backtracking():
    # 검증(2026-10-31): 예전 서수 이음 꼴은 '1 1 1 … x' 12개에 4.5초, 14개에 20초가 넘게 걸렸다(이벤트 루프 정지).
    # 결과를 단언하고 시간은 넉넉한 상한만 둔다 — 지수적으로 되돌아가면 이 크기에서 수십 초가 걸린다.
    import time

    monday = datetime(2026, 11, 2, 12, tzinfo=KST)
    started = time.monotonic()
    for raw in ("1 " * 14 + "x", "1st " * 14 + "x", "첫째 " * 14 + "x", "1st and " * 14 + "x", "1 " * 400 + "x"):
        assert closed_day_status(raw, monday) is None
    for raw in ("입장마감" + " " * 200 + "x", "브레이크" + " " * 200 + "x"):
        assert open_status_at_arrival({"operating_hours": {"open": raw}}, monday) == "needs_confirmation"
    assert time.monotonic() - started < 2.0


def test_weekday_runs_written_without_separators_are_read():
    # 검토(2026-10-31): '토일 휴무' 를 못 읽으면 영업으로 떨어져, 주말에 닫는 가게가 가장 붐비는 주말에 추천됐다.
    saturday = datetime(2026, 10, 31, 12, tzinfo=KST)
    for closed in ("매주 토일 휴무", "토일 휴무", "휴무: 토일", "토일요일 휴무", "토일 및 공휴일 휴무", "토일공휴일 휴무", "금토일 휴무"):
        facility = {"type": "restaurant", "operating_hours": {"open": "09:00~18:00", "closed": closed}}
        assert open_status_at_arrival(facility, saturday) == "closed_confirmed", closed
    # 요일 순서가 아니거나 뒤가 낱말이면 목록이 아니다 — '금일' 은 '오늘' 이다.
    for text in ("금일 휴무", "화목한 분위기", "휴무일", "공휴일", "평일", "매주일", "생년월일", "12월 25일"):
        assert closed_day_status(text, saturday) is None, text


def test_glued_ordinal_week_and_weekday_is_a_monthly_rule():
    # '첫째주일요일' 은 첫째 주 일요일이다 — 예전(HEAD 포함)에는 매주 일요일을 닫았다.
    facility = {"type": "cafe", "operating_hours": {"open": "10:00~20:00", "closed": "첫째주일요일 휴무"}}
    assert open_status_at_arrival(facility, datetime(2026, 11, 1, 12, tzinfo=KST)) == "closed_confirmed"
    assert open_status_at_arrival(facility, datetime(2026, 11, 8, 12, tzinfo=KST)) == "open_expected"


def test_last_entry_is_the_effective_close():
    # 입장 마감 뒤에 도착하면 들어갈 수 없다 — 닫는 시각(18:00)이 아니라 입장 마감(17:00)이 기준이다.
    museum = {"type": "culture", "operating_hours": {"open": "09:00~18:00 (입장 마감 17:00)"}}
    assert open_status_at_arrival(museum, datetime(2026, 11, 3, 17, 20, tzinfo=KST)) == "closed_confirmed"
    assert not is_recommendable_at_arrival(museum, datetime(2026, 11, 3, 16, 40, tzinfo=KST))
    assert is_recommendable_at_arrival(museum, datetime(2026, 11, 3, 16, tzinfo=KST))


def test_monthly_sunday_closure_closes_only_its_own_sundays():
    facility = {"type": "cafe", "operating_hours": {"open": "10:00~20:00", "closed": "매월 둘째·넷째 일요일"}}
    statuses = {
        day: open_status_at_arrival(facility, datetime(2026, 11, day, 12, tzinfo=KST))
        for day in (1, 8, 15, 22, 29)
    }
    assert statuses == {
        1: "open_expected", 8: "closed_confirmed", 15: "open_expected", 22: "closed_confirmed", 29: "open_expected",
    }
    # 서수를 읽을 수 없는 규칙은 그 요일만 '확인 필요' — 닫혔다고도 열었다고도 하지 않는다.
    vague = {"type": "cafe", "operating_hours": {"open": "10:00~20:00", "closed": "격주 일요일"}}
    assert open_status_at_arrival(vague, datetime(2026, 11, 1, 12, tzinfo=KST)) == "needs_confirmation"
    assert open_status_at_arrival(vague, datetime(2026, 11, 2, 12, tzinfo=KST)) == "open_expected"


def test_break_time_is_a_closed_interval_and_midnight_close_is_accepted():
    lunch_break = {"type": "restaurant", "operating_hours": {"open": "11:00~21:00 (15:00~17:00)"}}
    assert open_status_at_arrival(lunch_break, datetime(2026, 11, 3, 16, tzinfo=KST)) == "closed_confirmed"
    assert open_status_at_arrival(lunch_break, datetime(2026, 11, 3, 14, 45, tzinfo=KST)) == "closing_soon"
    assert not is_recommendable_at_arrival(lunch_break, datetime(2026, 11, 3, 16, tzinfo=KST))
    labelled = {"type": "restaurant", "operating_hours": {"open": "11:00~21:00 브레이크타임 15:00~17:00"}}
    assert open_status_at_arrival(labelled, datetime(2026, 11, 3, 16, tzinfo=KST)) == "closed_confirmed"
    midnight = {"type": "cafe", "operating_hours": {"open": "10:00~24:00"}}
    assert open_status_at_arrival(midnight, datetime(2026, 11, 3, 23, tzinfo=KST)) == "open_expected"
    assert recommendation_eligibility_tier(midnight, datetime(2026, 11, 3, 23, tzinfo=KST), "osm_pedestrian") == 0


def test_corroborated_availability_overrides_static_hours_until_expiry():
    arrival = datetime(2026, 8, 25, 3, tzinfo=timezone.utc)
    facility = {
        "type": "cafe",
        "operating_hours": {"open": "09:00~22:00"},
        "availability_evidence": {
            "status": "closed",
            "evidence_tier": "corroborated",
            "corroborating_count": 2,
            "expires_at": "2026-08-25T03:30:00+00:00",
        },
    }
    assert open_status_at_arrival(facility, arrival) == "closed_confirmed"
    facility["availability_evidence"]["expires_at"] = "2026-08-25T02:59:59+00:00"
    assert open_status_at_arrival(facility, arrival) == "open_expected"


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
