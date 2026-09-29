# app/services/batch/city_photo.py — 경주시 음식점 사진과 출처의 한 쌍 규칙(PM 승인 2026-09-29).
#
# 규칙: 사진은 출처 없이 저장되지 않고, 출처는 그 사진 없이 남지 않는다. 다른 사진(TourAPI 등)은 덮지 않는다.
# 개별 경우는 tests/scripts/test_ingest_gyeongju_restaurants.py·test_ingest_tourapi_upsert.py 가 배치 경로로 본다.
# 여기서는 입력 조합 전체에서 불변식이 깨지지 않는지 본다.

import itertools

import pytest

from app.services.batch.city_photo import (
    CITY_PHOTO_KEY,
    city_photo_credit,
    plan_city_photo,
    retire_superseded_city_photo,
    stored_city_photo,
)

CITY = "https://www.gyeongju.go.kr/upload/content/thumb/a.jpg"
CITY_NEW = "https://www.gyeongju.go.kr/upload/content/thumb/b.jpg"
TOUR = "https://tong.visitkorea.or.kr/cms/resource/1_image2_1.jpg"
TOUR_G = "https://tong.visitkorea.or.kr/cms/resource/2_image2_1.jpg"

_IMAGE_URLS = [None, "", TOUR]
_GALLERIES = [[], [CITY], [TOUR_G], [TOUR_G, CITY], [CITY, TOUR_G]]
_CREDITS = [None, CITY, CITY_NEW]
_API_URLS = [None, CITY, CITY_NEW]


def _after(facility: dict, changes: dict) -> tuple[str | None, list[str], dict | None]:
    """plan 을 적용한 뒤 DB 모습(image_url, gallery_images, city_photo)."""
    gallery = changes.get("gallery_images", facility.get("gallery_images") or [])
    features = dict(facility.get("features") or {})
    if CITY_PHOTO_KEY in changes:
        features[CITY_PHOTO_KEY] = changes[CITY_PHOTO_KEY]
    return facility.get("image_url"), gallery, stored_city_photo(features)


def _assert_paired(image_url, gallery, credit, *, before_gallery, before_image):
    city_in_gallery = [u for u in gallery if u in (CITY, CITY_NEW)]
    if credit is None:
        # 출처가 없으면 새로 넣은 경주시 사진도 없다(저장돼 있던 출처 없는 사진은 이 규칙이 만든 게 아니다).
        assert not [u for u in city_in_gallery if u not in before_gallery]
    else:
        assert credit["url"] in gallery, "출처가 가리키는 사진이 갤러리에 있어야 한다"
        # 경주시 사진은 다른 사진이 없을 때만 산다.
        assert not image_url and gallery == [credit["url"]]
    # 다른 사진은 하나도 지우지 않는다.
    for url in before_gallery:
        if url not in (CITY, CITY_NEW):
            assert url in gallery
    assert image_url == before_image


@pytest.mark.parametrize(
    ("image_url", "gallery", "credit_url", "api_url"),
    list(itertools.product(_IMAGE_URLS, _GALLERIES, _CREDITS, _API_URLS)),
)
def test_plan_keeps_photo_and_credit_paired_for_every_combination(image_url, gallery, credit_url, api_url):
    features = {"menu": "x"}
    if credit_url:
        features[CITY_PHOTO_KEY] = city_photo_credit(credit_url)
    facility = {"image_url": image_url, "gallery_images": list(gallery), "features": features}
    changes, status = plan_city_photo(facility, api_url)
    after_image, after_gallery, after_credit = _after(facility, changes)
    _assert_paired(after_image, after_gallery, after_credit, before_gallery=gallery, before_image=image_url)
    assert status


@pytest.mark.parametrize(
    ("row_image", "row_gallery", "cleared", "prev_image", "prev_gallery", "credit_url"),
    list(itertools.product(
        [None, TOUR], [None, [TOUR_G]], [False, True], [None, TOUR], [[], [CITY], [TOUR_G, CITY]], [None, CITY],
    )),
)
def test_tourapi_retire_keeps_photo_and_credit_paired(row_image, row_gallery, cleared, prev_image, prev_gallery,
                                                     credit_url):
    features = {CITY_PHOTO_KEY: city_photo_credit(credit_url)} if credit_url else {}
    prev = {"image_url": prev_image, "gallery_images": list(prev_gallery), "features": features}
    row = {"contentid": "1", "features": {"source": "tourapi"}}
    if row_image:
        row["image_url"] = row_image
    if row_gallery is not None:
        row["gallery_images"] = list(row_gallery)
    retire_superseded_city_photo(row, prev, image_cleared=cleared)

    image_after = row.get("image_url") or (None if cleared else prev_image)
    gallery_after = row["gallery_images"] if "gallery_images" in row else prev_gallery
    merged = {**features, **row["features"]}
    credit_after = stored_city_photo(merged)
    if credit_after is not None:
        assert credit_after["url"] in gallery_after
        assert not image_after and gallery_after == [credit_after["url"]]
    elif credit_url:
        assert CITY not in gallery_after, "출처를 걷었으면 경주시 사진도 함께 빠져야 한다"
    # TourAPI 사진은 하나도 지우지 않는다.
    for url in (row_gallery if row_gallery is not None else prev_gallery):
        if url != CITY:
            assert url in gallery_after


def test_retire_is_noop_without_a_stored_city_photo():
    row = {"contentid": "1", "image_url": TOUR, "features": {"source": "tourapi"}}
    retire_superseded_city_photo(row, {"gallery_images": [TOUR_G], "features": {}})
    assert row == {"contentid": "1", "image_url": TOUR, "features": {"source": "tourapi"}}


def test_credit_record_shape_is_separate_from_the_wikimedia_credit():
    credit = city_photo_credit(CITY, caption="황남밀면 메뉴", con_uid=93)
    assert credit == {
        "url": CITY,
        "provider": "경주시",
        "source_url": "https://www.gyeongju.go.kr/tour/",
        "license": "공공데이터포털 15114465 경주시_경주문화관광_메뉴별음식점 · 이용허락범위 제한 없음",
        "caption": "황남밀면 메뉴",
        "con_uid": 93,
    }
    # Wikimedia 출처(features.image_source)의 키 모양(artist)과 겹치지 않는다.
    assert "artist" not in credit


@pytest.mark.parametrize("bad", [None, {}, {"url": ""}, {"url": None}, "https://x", []])
def test_stored_city_photo_requires_a_url(bad):
    assert stored_city_photo({CITY_PHOTO_KEY: bad}) is None
