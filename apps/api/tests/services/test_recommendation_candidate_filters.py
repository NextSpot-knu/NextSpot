from app.routers.recommendations import _is_bar_facility


def test_bar_facility_is_detected_from_kakao_category_tags():
    assert _is_bar_facility({"features": {"cuisine_tags": ["술집", "호프,요리주점"]}})
    assert not _is_bar_facility({"features": {"cuisine_tags": ["한식", "국밥"]}})
