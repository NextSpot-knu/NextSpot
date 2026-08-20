from app.services.area_demand_decision_service import (
    annotate_arrival_actions,
    annotate_relative_demand,
)


def _item(level, mode="live", confidence=None):
    return {
        "breakdown": {
            "area_demand_level": level,
            "area_demand_mode": mode,
            "area_demand_confidence": confidence,
        }
    }


def test_relative_demand_marks_a_real_comparative_advantage():
    items = [_item(0.25), _item(0.55), _item(0.8)]
    annotate_relative_demand(items)
    first = items[0]["breakdown"]
    assert first["area_demand_rank"] == 1
    assert first["area_demand_percentile"] == 100.0
    assert first["area_demand_delta_vs_median"] == -0.3
    assert first["area_demand_distinguishable"] is True


def test_nearly_identical_area_signals_are_not_sold_as_crowd_alternatives():
    items = [_item(0.50), _item(0.53), _item(0.55)]
    annotate_relative_demand(items)
    annotate_arrival_actions(items, [None, None, None])
    assert all(not item["breakdown"]["area_demand_distinguishable"] for item in items)
    assert all(item["breakdown"]["arrival_action"] != "choose_calmer" for item in items)


def test_wait_action_requires_a_supported_meaningful_improvement():
    item = _item(0.72)
    annotate_relative_demand([item])
    annotate_arrival_actions([
        item
    ], [{"level": 0.50, "mode": "forecast", "confidence": "medium"}])
    breakdown = item["breakdown"]
    assert breakdown["arrival_action"] == "wait_then_go"
    assert breakdown["recommended_departure_delay_minutes"] == 30
    assert breakdown["delayed_area_demand_level"] == 0.5
