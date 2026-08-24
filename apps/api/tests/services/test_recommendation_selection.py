from app.services.recommendation_selection import select_diverse_recommendations


def _item(fid, score, *, address=None, concepts=None, lat=35.836, lng=129.21):
    return {
        "facility": {
            "id": fid,
            "latitude": lat,
            "longitude": lng,
            "address": address,
            "features": {"cuisine_tags": concepts or []},
        },
        "spot_score": score,
        "breakdown": {},
    }


def test_top_one_is_never_changed_and_near_ties_gain_variety():
    rows = [
        _item("top", 0.91, address="경북 경주시 포석로 1", concepts=["한식"]),
        _item("same-building", 0.90, address="경북 경주시 포석로 1", concepts=["한식"]),
        _item("different", 0.89, address="경북 경주시 포석로 3", concepts=["양식"], lat=35.837),
    ]
    selected = select_diverse_recommendations(rows, 3)
    assert [row["facility"]["id"] for row in selected] == ["top", "different", "same-building"]
    assert selected[1]["breakdown"]["diversity_adjusted"] is True


def test_diversity_never_promotes_a_materially_lower_score():
    rows = [
        _item("top", 0.91, concepts=["한식"]),
        _item("similar", 0.90, concepts=["한식"]),
        _item("too-low", 0.85, concepts=["양식"]),
    ]
    selected = select_diverse_recommendations(rows, 3)
    assert [row["facility"]["id"] for row in selected] == ["top", "similar", "too-low"]


def test_empty_and_non_positive_limits_are_safe():
    assert select_diverse_recommendations([], 3) == []
    assert select_diverse_recommendations([_item("one", 1.0)], 0) == []
