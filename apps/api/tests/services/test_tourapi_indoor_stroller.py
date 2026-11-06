"""TourAPI 적재 규칙 — 실내 문화시설 근거 표시 · 유모차(chk_babycarriage)를 휠체어와 다른 칸으로(P1-6).

적재가 features 에 적는 값과 추천 판정(travel_context)이 읽는 값이 같은 규칙이어야 한다 — 밤 적재 전에
적재된 행은 판정이 원문(cat3 · chk_babycarriage)을 직접 읽고, 적재 뒤에는 적힌 칸을 읽는다. 어느 쪽이든 답이 같다.
"""
import pytest

from app.services.tourapi.transform import (
    INDOOR_CULTURE_CAT3,
    INDOOR_CULTURE_EVIDENCE,
    extract_intro_extra_features,
    transform_poi,
)
from app.services.travel_context import facility_is_indoor_eligible, facility_is_stroller_friendly

_BASE = {"title": "시설", "contentid": "1", "mapx": "129.21", "mapy": "35.83"}


@pytest.mark.parametrize("cat3", sorted(INDOOR_CULTURE_CAT3))
def test_indoor_culture_classes_get_an_indoor_marker(cat3):
    row = transform_poi({**_BASE, "contenttypeid": 14, "cat1": "A02", "cat2": "A0206", "cat3": cat3})
    assert row["type"] == "culture"
    assert row["features"]["indoor"] is True
    assert row["features"]["indoor_evidence"] == INDOOR_CULTURE_EVIDENCE
    assert facility_is_indoor_eligible(row)


@pytest.mark.parametrize("item", [
    {"contenttypeid": 14, "cat3": "A02060600"},  # 공연장 — 야외 공연장이 같은 분류
    {"contenttypeid": 14, "cat3": "A02061100"},  # 문화전수시설
    {"contenttypeid": 14, "cat3": ""},           # 신분류만 있는 2023년 이후 등록분
    {"contenttypeid": 12, "cat3": "A02060100"},  # 관광지는 분류가 박물관이어도 아니다
])
def test_other_rows_get_no_indoor_key_at_all(item):
    # '모름' 을 False(야외)로 적지 않는다 — 키를 넣지 않아 기존 값(사람이 확인한 indoor_verified)도 덮지 않는다.
    row = transform_poi({**_BASE, **item})
    assert "indoor" not in row["features"]
    assert "indoor_evidence" not in row["features"]


def test_unclassified_culture_row_is_not_indoor_before_or_after_ingest():
    row = transform_poi({**_BASE, "contenttypeid": 14})
    assert not facility_is_indoor_eligible(row)


@pytest.mark.parametrize(("raw", "expected"), [
    ("유모차 대여 가능", True),
    ("가능(무료)", True),
    ("대여 불가", False),
    ("없음", False),
    ("Y", False),
    ("문의", False),
])
def test_stroller_is_read_into_its_own_feature(raw, expected):
    for content_type_id, field in ((12, "chkbabycarriage"), (14, "chkbabycarriageculture")):
        features = extract_intro_extra_features({field: raw}, content_type_id)
        assert features["chk_babycarriage"] == raw  # 원문은 그대로 남긴다
        # '가능' 만 True 를 적고, 그 밖은 null — '대여 없음' 을 '유모차 불가(False)' 로 적지 않는다.
        assert features["stroller"] is (True if expected else None)
        # 적재 뒤(칸 있음)와 적재 전(원문만) 판정이 같다.
        assert facility_is_stroller_friendly({"features": features}) is expected
        assert facility_is_stroller_friendly({"features": {"chk_babycarriage": raw}}) is expected
        # 휠체어 칸은 건드리지 않는다.
        assert "barrier_free" not in features and "accessible_verified" not in features


def test_null_clears_yesterdays_true_when_tourapi_changes_its_answer():
    # 밤 적재는 features 를 {**기존, **새 값} 으로 합친다 — null 이 전날 True 를 지워야 원문과 판정이 어긋나지 않는다.
    yesterday = {"chk_babycarriage": "유모차 대여 가능", "stroller": True}
    today = extract_intro_extra_features({"chkbabycarriage": "없음"}, 12)
    merged = {**yesterday, **today}
    assert merged["stroller"] is None
    assert not facility_is_stroller_friendly({"features": merged})


def test_blank_stroller_text_writes_nothing():
    features = extract_intro_extra_features({"chkbabycarriage": ""}, 12)
    assert "stroller" not in features and "chk_babycarriage" not in features
    assert not facility_is_stroller_friendly({"features": features})


def test_restaurants_have_no_stroller_field_in_tourapi():
    # 음식점(39) 상세에는 유모차 칸이 없다 — 유모차 조건은 관광지·문화시설만 맞을 수 있다(웹 칩 안내 근거).
    features = extract_intro_extra_features({"chkbabycarriage": "가능", "firstmenu": "국밥"}, 39)
    assert "stroller" not in features
