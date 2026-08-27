from scripts.ingest_kakao_places import (
    CENTER_LAT,
    CENTER_LNG,
    GRID_AXIS,
    GRID_STEP_M,
    _grid_points,
    _merge_features,
    select_candidates,
)


def _row(place_id: str, rank: int, query: str, kind: str = "cafe"):
    return {
        "id": place_id,
        "place_name": "테라로사 경주점" if place_id == "1526605585" else f"장소 {place_id}",
        "road_address_name": "경북 경주시 포석로 988",
        "address_name": "경북 경주시 황남동",
        "x": "129.209947126629",
        "y": "35.8296691510212",
        "category_group_code": "CE7" if kind == "cafe" else "FD6",
        "category_name": "음식점 > 카페",
        "place_url": f"https://place.map.kakao.com/{place_id}",
        "phone": "",
        "discovery_query": query,
        "discovery_type": kind,
        "discovery_rank": rank,
    }


def test_top_or_repeated_relevant_places_are_selected():
    rows = [
        _row("1526605585", 7, "경주 카페"),
        _row("repeat", 22, "경주 카페"),
        _row("repeat", 25, "황리단길 카페"),
        _row("weak", 30, "경주 카페"),
    ]
    selected = select_candidates(rows)
    ids = {row["kakao_place_id"] for row in selected}
    assert ids == {"1526605585", "repeat"}
    terarosa = next(row for row in selected if row["kakao_place_id"] == "1526605585")
    assert terarosa["name"] == "테라로사 경주점"


def test_non_gyeongju_and_wrong_categories_are_rejected():
    outside = _row("outside", 1, "경주 카페")
    outside["road_address_name"] = "서울 강남구"
    wrong = _row("wrong", 1, "경주 카페")
    wrong["category_group_code"] = "CS2"
    assert select_candidates([outside, wrong]) == []


def test_category_grid_covers_all_81_centers_symmetrically():
    points = _grid_points()

    assert len(points) == len(GRID_AXIS) ** 2 == 81
    assert (CENTER_LAT, CENTER_LNG) in points
    assert min(lat for lat, _ in points) == CENTER_LAT - 4 * GRID_STEP_M / 111_000.0
    assert max(lat for lat, _ in points) == CENTER_LAT + 4 * GRID_STEP_M / 111_000.0
    assert min(lng for _, lng in points) == CENTER_LNG - 4 * GRID_STEP_M / 90_000.0
    assert max(lng for _, lng in points) == CENTER_LNG + 4 * GRID_STEP_M / 90_000.0


def test_grid_discovery_is_selected_even_below_keyword_top_15():
    grid = _row("grid-only", 45, "category_grid:cafe")
    grid["category_grid"] = True

    selected = select_candidates([grid])

    assert [row["kakao_place_id"] for row in selected] == ["grid-only"]
    assert selected[0]["discovery_source"] == "category_grid"


def test_same_kakao_place_from_overlapping_cells_is_emitted_once():
    first = _row("overlap", 5, "category_grid:cafe")
    first["category_grid"] = True
    second = _row("overlap", 2, "경주 카페")

    selected = select_candidates([first, second])

    assert len(selected) == 1
    assert selected[0]["kakao_place_id"] == "overlap"
    assert selected[0]["best_rank"] == 2
    assert selected[0]["appearance_count"] == 2
    assert selected[0]["discovery_source"] == "category_grid"


def test_kakao_category_is_preserved_as_recommendation_filter_tags():
    candidate = select_candidates([
        {
            **_row("bar", 1, "category_grid:restaurant", "restaurant"),
            "category_grid": True,
            "category_name": "음식점 > 술집 > 호프,요리주점",
        }
    ])[0]
    features = _merge_features(None, candidate)
    assert features["kakao_category_name"] == "음식점 > 술집 > 호프,요리주점"
    assert features["cuisine_tags"] == ["술집", "호프,요리주점"]
