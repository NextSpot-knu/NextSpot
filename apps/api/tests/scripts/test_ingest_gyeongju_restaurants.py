import pytest

from scripts.ingest_gyeongju_restaurants import (
    build_actions,
    match_facility,
    merge_features,
)


_NOW = "2026-09-20T00:00:00+00:00"


def _restaurant(**overrides):
    base = {
        "con_uid": 101,
        "name": "황남밀면",
        "address": "경북 경주시 포석로 1",
        "menu": "밀면, 연탄불고기",
        "hours": "11:00-20:00",
        "closed": "인스타공지",
        "parking": "매장 옆 공용주차장 이용",
        "amenities": "카드결제, 포장가능",
        "homepage": "https://example.com",
        "lat": 35.8361,
        "lng": 129.2105,
    }
    base.update(overrides)
    return base


def _facility(**overrides):
    base = {
        "id": "fac-1",
        "name": "황남밀면",
        "latitude": 35.8361,
        "longitude": 129.2105,
        "contenttypeid": 39,
        "type": "restaurant",
        "features": {},
        "operating_hours": {},
        "homepage": None,
    }
    base.update(overrides)
    return base


def test_match_facility_matches_same_name_within_radius():
    facility = _facility()
    assert match_facility(_restaurant(), [facility]) is facility


def test_match_facility_rejects_far_facility():
    far = _facility(latitude=35.90, longitude=129.30)  # ~수 km 떨어짐
    assert match_facility(_restaurant(), [far]) is None


def test_match_facility_rejects_different_name_even_if_close():
    other = _facility(name="전혀다른가게")
    assert match_facility(_restaurant(), [other]) is None


def test_match_facility_ignores_non_food_facilities():
    attraction = _facility(contenttypeid=12, type="attraction")
    assert match_facility(_restaurant(), [attraction]) is None


def test_match_facility_allows_kakao_food_type_without_contenttypeid():
    cafe = _facility(id="fac-cafe", name="황남밀면", contenttypeid=None, type="cafe")
    assert match_facility(_restaurant(), [cafe]) is cafe


def test_merge_features_preserves_tourapi_keys_and_adds_menu():
    existing = {
        "source": "tourapi",
        "first_menu": "TourAPI메뉴",
        "parking": "가능",  # TourAPI 의 주차 키 — 덮이면 안 된다.
        "cat3": "A05020900",
    }
    merged = merge_features(existing, _restaurant(), _NOW)

    # 기존 TourAPI 키는 보존.
    assert merged["source"] == "tourapi"
    assert merged["first_menu"] == "TourAPI메뉴"
    assert merged["parking"] == "가능"
    assert merged["cat3"] == "A05020900"
    # 대표메뉴는 features.menu 로(취향매칭 preference.py 가 읽는 키).
    assert merged["menu"] == "밀면, 연탄불고기"
    # 상세는 네임스페이스로 보존.
    assert merged["gyeongju_food"]["menu"] == "밀면, 연탄불고기"
    assert merged["gyeongju_food"]["parking"] == "매장 옆 공용주차장 이용"
    assert merged["gyeongju_food"]["source"] == "gyeongju_food_15114465"
    assert merged["gyeongju_food"]["synced_at"] == _NOW


def test_build_actions_matches_and_fills_empty_columns():
    update_rows, actions = build_actions([_restaurant()], [_facility()], _NOW)

    assert len(update_rows) == 1
    row = update_rows[0]
    assert row["id"] == "fac-1"
    assert row["features"]["menu"] == "밀면, 연탄불고기"
    # operating_hours 가 비어 있었으므로 채운다.
    assert row["operating_hours"] == {"open": "11:00-20:00", "source": "gyeongju_food", "closed": "인스타공지"}
    # homepage 가 비어 있었으므로 채운다.
    assert row["homepage"] == "https://example.com"

    assert actions[0]["status"] == "matched"
    assert "features" in actions[0]["fields"]


def test_build_actions_does_not_overwrite_existing_hours():
    facility = _facility(operating_hours={"open": "이미있음"})
    update_rows, _ = build_actions([_restaurant()], [facility], _NOW)
    # 기존 operating_hours 는 보존(덮지 않는다).
    assert update_rows[0]["operating_hours"] == {"open": "이미있음"}


def test_build_actions_skips_unmatched_restaurants():
    update_rows, actions = build_actions(
        [_restaurant(name="매칭안됨", lat=35.99, lng=129.40)], [_facility()], _NOW
    )
    assert update_rows == []
    assert actions[0]["status"] == "skipped_no_match"


def test_build_actions_skips_duplicate_facility_match():
    restaurants = [_restaurant(con_uid=1), _restaurant(con_uid=2)]  # 같은 이름·좌표 → 같은 시설
    update_rows, actions = build_actions(restaurants, [_facility()], _NOW)
    assert len(update_rows) == 1
    assert [a["status"] for a in actions] == ["matched", "skipped_duplicate_match"]


# ---------------------------------------------------------------------------
# 경주시 사진(PM 승인 2026-09-29) — 사진이 하나도 없는 행에만, 출처와 한 쌍으로
# ---------------------------------------------------------------------------

_CITY_URL = "https://www.gyeongju.go.kr/upload/content/thumb/20200506/151E08F0791D483C8A2F46AD8BD06FEE.jpg"
_CITY_URL_NEW = "https://www.gyeongju.go.kr/upload/content/thumb/20260101/NEW.jpg"
_TOUR_URL = "https://tong.visitkorea.or.kr/cms/resource/88/2902488_image2_1.jpg"


def _photo_restaurant(**overrides):
    return _restaurant(image_url=_CITY_URL, image_caption="황남밀면 메뉴(비빔밀면)", **overrides)


def _stored_credit(url=_CITY_URL):
    return {"url": url, "provider": "경주시", "source_url": "https://www.gyeongju.go.kr/tour/",
            "license": "공공데이터포털 15114465 경주시_경주문화관광_메뉴별음식점 · 이용허락범위 제한 없음"}


def test_city_photo_fills_only_a_photo_less_row_with_its_credit():
    facility = _facility(image_url=None, gallery_images=[])
    update_rows, actions = build_actions([_photo_restaurant()], [facility], _NOW, city_photo_enabled=True)

    row = update_rows[0]
    assert row["gallery_images"] == [_CITY_URL]
    credit = row["features"]["city_photo"]
    assert credit["url"] == _CITY_URL
    assert credit["provider"] == "경주시"
    assert credit["source_url"] == "https://www.gyeongju.go.kr/tour/"
    assert credit["caption"] == "황남밀면 메뉴(비빔밀면)"
    assert credit["con_uid"] == 101
    # Wikimedia 출처 키와 섞지 않는다(웹·TourAPI 배치가 image_source 를 Wikimedia 로 읽는다).
    assert "image_source" not in row["features"]
    # 대표 사진 열은 이 배치가 쓰지 않는다(TourAPI 몫 — 매일 밤 TourAPI 가 다시 쓴다).
    assert "image_url" not in row
    assert actions[0]["photo"] == "city_photo_added"


@pytest.mark.parametrize(
    "photo_columns",
    [
        {"image_url": _TOUR_URL, "gallery_images": []},
        {"image_url": None, "gallery_images": [_TOUR_URL]},
        {"image_url": _TOUR_URL, "gallery_images": [_TOUR_URL]},
    ],
    ids=["main_photo", "gallery_photo", "both"],
)
def test_city_photo_never_overwrites_an_existing_photo(photo_columns):
    facility = _facility(**photo_columns)
    update_rows, actions = build_actions([_photo_restaurant()], [facility], _NOW)

    row = update_rows[0]
    assert "gallery_images" not in row, "읽은 갤러리를 되쓰거나 바꾸지 않는다"
    assert "image_url" not in row
    assert "city_photo" not in row["features"]
    assert actions[0]["photo"] == "has_photo"


def test_city_photo_is_retired_with_its_credit_when_a_tourapi_photo_arrives():
    # PM 이 Kakao 행에 contentid 를 이어 준 뒤 TourAPI 가 대표 사진을 채웠다 — 경주시 사진과 출처를 함께 뺀다.
    facility = _facility(image_url=_TOUR_URL, gallery_images=[_CITY_URL],
                         features={"city_photo": _stored_credit()})
    update_rows, actions = build_actions([_photo_restaurant()], [facility], _NOW)

    row = update_rows[0]
    assert row["gallery_images"] == []
    assert row["features"]["city_photo"] is None
    assert actions[0]["photo"] == "city_photo_retired"


def test_city_photo_is_retired_when_the_gallery_gains_another_photo():
    facility = _facility(image_url=None, gallery_images=[_TOUR_URL, _CITY_URL],
                         features={"city_photo": _stored_credit()})
    row = build_actions([_photo_restaurant()], [facility], _NOW)[0][0]
    assert row["gallery_images"] == [_TOUR_URL]
    assert row["features"]["city_photo"] is None


def test_credit_without_its_photo_is_dropped():
    # 누가 갤러리를 비웠다 — 출처만 남기지 않는다(오늘 사진을 다시 넣지도 않는다: 다음 밤 빈 행 규칙으로 들어간다).
    facility = _facility(image_url=None, gallery_images=[], features={"city_photo": _stored_credit()})
    update_rows, actions = build_actions([_photo_restaurant()], [facility], _NOW)
    row = update_rows[0]
    assert row["features"]["city_photo"] is None
    assert "gallery_images" not in row
    assert actions[0]["photo"] == "city_photo_credit_dropped"


def test_stored_city_photo_is_kept_when_the_api_has_no_photo_today():
    # 호출 결과에 사진이 없는 날은 저장된 사진·출처를 그대로 둔다(호출 사정으로 지우지 않는다).
    facility = _facility(image_url=None, gallery_images=[_CITY_URL], features={"city_photo": _stored_credit()})
    update_rows, actions = build_actions([_restaurant()], [facility], _NOW)
    row = update_rows[0]
    assert "gallery_images" not in row
    assert row["features"]["city_photo"] == _stored_credit()
    assert actions[0]["photo"] == "city_photo_kept"


def test_changed_city_photo_replaces_photo_and_credit_together():
    facility = _facility(image_url=None, gallery_images=[_CITY_URL], features={"city_photo": _stored_credit()})
    row = build_actions([_restaurant(image_url=_CITY_URL_NEW)], [facility], _NOW, city_photo_enabled=True)[0][0]
    assert row["gallery_images"] == [_CITY_URL_NEW]
    assert row["features"]["city_photo"]["url"] == _CITY_URL_NEW


def test_hidden_row_is_not_matched_so_the_live_duplicate_gets_the_photo():
    # 대구갈비 본점(Kakao, 숨김) 과 진가네대구갈비(TourAPI, 사진 없음)가 2m 거리 — 숨긴 행은 매칭하지 않는다.
    hidden = _facility(id="kakao-dup", name="대구갈비 본점", is_active=False, image_url=None, gallery_images=[])
    live = _facility(id="tour-row", name="[백년가게]진가네대구갈비", latitude=35.83611, is_active=True,
                     image_url=None, gallery_images=[])
    update_rows, actions = build_actions([_photo_restaurant(name="대구갈비")], [hidden, live], _NOW,
                                         city_photo_enabled=True)
    assert [r["id"] for r in update_rows] == ["tour-row"]
    assert update_rows[0]["gallery_images"] == [_CITY_URL]


def test_run_selects_photo_columns(monkeypatch):
    # 사진 판정에 image_url·gallery_images 가 필요하다 — SELECT 에서 빠지면 '사진 없음'으로 잘못 보고 덮는다.
    import asyncio

    import scripts.ingest_gyeongju_restaurants as mod

    captured = {}

    def fake_fetch_all_rows(_client, table, columns, **_kwargs):
        captured["columns"] = columns
        return []

    async def fake_restaurants(**_kwargs):
        return [_photo_restaurant()]

    monkeypatch.setattr(mod.settings, "GYEONGJU_FOOD_API_BASE_URL", "https://example.com")
    monkeypatch.setattr(mod.settings, "GYEONGJU_FOOD_API_KEY", "k")
    monkeypatch.setattr(mod, "get_gyeongju_restaurants", fake_restaurants)
    monkeypatch.setattr("app.core.supabase.fetch_all_rows", fake_fetch_all_rows)
    asyncio.run(mod.run(apply=False))
    columns = {c.strip() for c in captured["columns"].split(",")}
    assert {"image_url", "gallery_images", "is_active", "features"} <= columns


# ---------------------------------------------------------------------------
# 스위치(GYEONGJU_CITY_PHOTO_ENABLED) — 웹 출처가 배포되기 전에는 사진을 넣지 않는다
# ---------------------------------------------------------------------------

def test_city_photo_switch_off_adds_and_refreshes_nothing():
    # 기본은 꺼짐 — 운영 웹이 '사진: 경주시' 출처를 그리기 전에 사진만 뜨지 않게.
    empty = _facility(id="empty", image_url=None, gallery_images=[])
    update_rows, actions = build_actions([_photo_restaurant()], [empty], _NOW)
    assert "gallery_images" not in update_rows[0]
    assert "city_photo" not in update_rows[0]["features"]
    assert actions[0]["photo"] == "city_photo_off"
    assert update_rows[0]["features"]["menu"] == "밀면, 연탄불고기"  # 메뉴 보강은 그대로

    stored = _facility(image_url=None, gallery_images=[_CITY_URL], features={"city_photo": _stored_credit()})
    row = build_actions([_restaurant(image_url=_CITY_URL_NEW)], [stored], _NOW)[0][0]
    assert "gallery_images" not in row
    assert row["features"]["city_photo"] == _stored_credit()


@pytest.mark.parametrize(
    ("photo_columns", "status"),
    [
        ({"image_url": _TOUR_URL, "gallery_images": [_CITY_URL]}, "city_photo_retired"),
        ({"image_url": None, "gallery_images": []}, "city_photo_credit_dropped"),
    ],
    ids=["tourapi_photo_arrived", "credit_without_photo"],
)
def test_city_photo_switch_off_still_retires_photo_and_credit_together(photo_columns, status):
    facility = _facility(features={"city_photo": _stored_credit()}, **photo_columns)
    update_rows, actions = build_actions([_photo_restaurant()], [facility], _NOW)
    assert update_rows[0]["features"]["city_photo"] is None
    assert actions[0]["photo"] == status


@pytest.mark.parametrize(("value", "expected"), [(None, False), ("", False), ("false", False), ("1", False),
                                                 ("true", True), (" TRUE ", True)])
def test_city_photo_switch_reads_the_env(monkeypatch, value, expected):
    import scripts.ingest_gyeongju_restaurants as mod

    if value is None:
        monkeypatch.delenv(mod.CITY_PHOTO_ENABLED_ENV, raising=False)
    else:
        monkeypatch.setenv(mod.CITY_PHOTO_ENABLED_ENV, value)
    assert mod.city_photo_enabled() is expected
