from scripts.reconcile_kakao_coordinates import (
    coordinate_change_distance,
    is_coordinate_changed,
)


def test_sub_meter_serialization_difference_is_not_a_change():
    before = {"latitude": 35.83454894858, "longitude": 129.212458216488}
    after = {"latitude": 35.83454894858, "longitude": 129.21245821648847}

    assert coordinate_change_distance(before, after) < 0.001
    assert is_coordinate_changed(before, after) is False


def test_actual_coordinate_move_is_a_change():
    before = {"latitude": 35.8345, "longitude": 129.2124}
    after = {"latitude": 35.8355, "longitude": 129.2124}

    assert coordinate_change_distance(before, after) > 100
    assert is_coordinate_changed(before, after) is True
