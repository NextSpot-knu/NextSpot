from app.services.restroom_service import _distance_m


def test_distance_is_zero_for_same_point():
    assert _distance_m(35.8361, 129.2105, 35.8361, 129.2105) == 0


def test_distance_is_symmetric():
    forward = _distance_m(35.8361, 129.2105, 35.8347, 129.2191)
    reverse = _distance_m(35.8347, 129.2191, 35.8361, 129.2105)
    assert forward == reverse
    assert 700 < forward < 900
