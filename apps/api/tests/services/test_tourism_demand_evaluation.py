from app.services.batch.tourism_demand_evaluation import (
    attach_and_measure_tourism_coverage,
    evaluate_tourism_demand_impact,
)


def _facility(facility_id, latitude, rate, basis):
    return {
        "id": facility_id,
        "type": "cafe",
        "latitude": latitude,
        "longitude": 129.0,
        "tourapi_concentration_rate": rate,
        "tourapi_concentration_basis": basis,
    }


def test_evaluation_reports_rank_change_differentiation_and_coverage():
    facilities = [
        _facility("near-busy", 35.0005, 100, "바쁜 관광지"),
        _facility("middle-quiet", 35.0010, 0, "여유 관광지"),
        _facility("far-normal", 35.0015, 50, "보통 관광지"),
    ]
    scenarios = [{"name": "test", "type": "cafe", "lat": 35.0, "lng": 129.0}]

    report = evaluate_tourism_demand_impact(facilities, scenarios)

    assert report["facility_source_coverage"] == 1.0
    assert report["top3_source_coverage"] == 1.0
    assert report["controlled_rank_changed_scenario_rate"] == 1.0
    assert report["top3_demand_distinguishable_rate"] == 1.0
    assert report["top3_all_same_anchor_rate"] == 0.0
    assert report["scenarios"][0]["controlled_before_top3"][0] == "near-busy"
    assert report["scenarios"][0]["controlled_after_top3"][0] == "middle-quiet"


def test_evaluation_marks_same_anchor_and_missing_source_without_inventing_values():
    facilities = [
        _facility("a", 35.0005, 55, "대릉원"),
        _facility("b", 35.0010, 54, "대릉원"),
        {
            "id": "c",
            "type": "cafe",
            "latitude": 35.0015,
            "longitude": 129.0,
        },
    ]
    scenarios = [{"name": "test", "type": "cafe", "lat": 35.0, "lng": 129.0}]

    report = evaluate_tourism_demand_impact(facilities, scenarios)

    assert report["facility_source_coverage"] == 0.6667
    assert report["top3_source_coverage"] == 0.6667
    assert report["top3_demand_distinguishable_rate"] == 0.0
    assert report["top3_all_same_anchor_rate"] == 1.0


def test_coverage_compares_legacy_exact_safe_aliases_and_propagation():
    facilities = [
        {
            "id": "anchor",
            "name": "대릉원",
            "type": "attraction",
            "latitude": 35.0,
            "longitude": 129.0,
        },
        {
            "id": "nearby",
            "name": "카페",
            "type": "cafe",
            "latitude": 35.001,
            "longitude": 129.0,
        },
        {
            "id": "far",
            "name": "식당",
            "type": "restaurant",
            "latitude": 36.0,
            "longitude": 129.0,
        },
    ]
    forecasts = [
        {"tourist_attraction_name": "경주 대릉원 일원", "concentration_rate": 75}
    ]

    metrics = attach_and_measure_tourism_coverage(facilities, forecasts)

    assert metrics["legacy_exact_direct_anchor_count"] == 0
    assert metrics["safe_direct_anchor_count"] == 1
    assert metrics["safe_alias_direct_anchor_count"] == 1
    assert metrics["safe_direct_anchor_delta_vs_legacy_exact"] == 1
    assert metrics["facility_count_after_2km_propagation"] == 2
    assert metrics["facility_coverage_after_2km_propagation"] == 0.6667
