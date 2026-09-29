"""경주시 음식점 사진(data.go.kr 15114465 `CON_IMGFILENAME`) — 사진과 출처를 한 쌍으로 다루는 규칙.

PM 승인(2026-09-29): 경주시 「메뉴별음식점」 API 가 주는 실사진을 **사진이 하나도 없는 음식점**에만 쓴다.
사진은 facilities.gallery_images 에 넣고(image_url 은 TourAPI 대표 사진 자리라 건드리지 않는다), 출처는
features.city_photo 에 둔다. 웹은 **지금 보이는 사진 URL 이 features.city_photo.url 과 같을 때만**
'사진: 경주시' 출처를 붙인다 — 출처는 운영 주체 표기가 아니라 사진 출처일 뿐이다.

왜 features.image_source 가 아닌가: image_source 는 Wikimedia 대체 사진 전용이다. 적재 배치
(scripts/ingest_tourapi.py `_retire_superseded_wikimedia`)와 웹(apps/web/lib/photoCredit.ts)이 그 키를
'Wikimedia 출처'로 읽고 걷어 낸다. 같은 키에 경주시 출처를 섞으면 Wikimedia 규칙이 경주시 출처를 지우거나
Wikimedia 사진 아래에 경주시 출처가 뜰 수 있다. 그래서 별도 키 + URL 로 묶는다.

한 쌍 규칙(Wikimedia 와 같다): 사진은 출처 없이 저장되지 않고, 출처는 그 사진 없이 남지 않는다.
  - 넣기: 행에 사진이 전혀 없을 때만(image_url 비었고 gallery_images 비었을 때) [사진] + 출처를 함께.
  - 걷기: 그 행에 경주시 사진이 아닌 사진(TourAPI 대표·갤러리 등)이 생기면 경주시 사진과 출처를 함께 뺀다.
  - 출처만 남은 행(사진이 갤러리에서 사라짐)은 출처를 지운다.
  - 호출이 실패했거나 오늘 API 가 사진을 주지 않은 날은 저장된 사진·출처를 그대로 둔다(호출 실패로 지우지 않는다).

이 모듈은 순수 함수만 둔다(I/O 없음). 쓰는 곳: scripts/ingest_gyeongju_restaurants.py(넣기·갱신·걷기),
scripts/ingest_tourapi.py(TourAPI 사진이 생긴 밤에 걷기).
"""

from __future__ import annotations

from typing import Any

# features 안의 키. 값: {"url", "provider", "source_url", "license", "caption"?, "con_uid"?} 또는 None(걷어 냄).
CITY_PHOTO_KEY = "city_photo"
CITY_PHOTO_PROVIDER = "경주시"
CITY_PHOTO_SOURCE_URL = "https://www.gyeongju.go.kr/tour/"
CITY_PHOTO_LICENSE = "공공데이터포털 15114465 경주시_경주문화관광_메뉴별음식점 · 이용허락범위 제한 없음"


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def gallery_urls(value: Any) -> list[str]:
    """gallery_images(JSONB 배열) → 비어 있지 않은 문자열 URL 목록(순서 유지)."""
    if not isinstance(value, list):
        return []
    return [u for u in value if isinstance(u, str) and u.strip()]


def stored_city_photo(features: Any) -> dict[str, Any] | None:
    """features 에 저장된 경주시 사진 출처. url 이 없으면 출처로 볼 수 없어 None."""
    if not isinstance(features, dict):
        return None
    credit = features.get(CITY_PHOTO_KEY)
    if isinstance(credit, dict) and _text(credit.get("url")):
        return credit
    return None


def city_photo_credit(url: str, *, caption: str | None = None, con_uid: Any = None) -> dict[str, Any]:
    """경주시 사진 1장의 출처 레코드."""
    credit: dict[str, Any] = {
        "url": url,
        "provider": CITY_PHOTO_PROVIDER,
        "source_url": CITY_PHOTO_SOURCE_URL,
        "license": CITY_PHOTO_LICENSE,
    }
    if _text(caption):
        credit["caption"] = _text(caption)
    if con_uid is not None:
        credit["con_uid"] = con_uid
    return credit


def plan_city_photo(
    facility: dict[str, Any],
    image_url: str | None,
    *,
    caption: str | None = None,
    con_uid: Any = None,
) -> tuple[dict[str, Any], str]:
    """경주시 API 가 오늘 준 사진(image_url)과 저장된 시설 행을 보고 바꿀 값을 정한다.

    반환: (changes, status). changes 에는 바꿀 것만 들어 있다 —
      "gallery_images": 새 갤러리 전체(바꿀 때만), CITY_PHOTO_KEY: 새 출처 dict 또는 None(걷기).
    status 는 감사 로그용 짧은 이름.
    """
    features = facility.get("features") or {}
    stored = stored_city_photo(features)
    gallery = gallery_urls(facility.get("gallery_images"))
    representative = _text(facility.get("image_url"))
    new_url = _text(image_url)

    if stored is not None:
        city_url = _text(stored.get("url"))
        # 경주시 사진이 아닌 사진 — 대표 사진(설령 같은 URL 이어도 대표 자리는 TourAPI 몫) 또는 다른 갤러리 사진.
        others = [u for u in gallery if u != city_url]
        if representative or others:
            changes: dict[str, Any] = {CITY_PHOTO_KEY: None}
            if city_url in gallery:
                changes["gallery_images"] = others
            return changes, "city_photo_retired"
        if city_url not in gallery:
            # 출처만 남았다 — 사진 없는 출처는 두지 않는다.
            return {CITY_PHOTO_KEY: None}, "city_photo_credit_dropped"
        if new_url and new_url != city_url:
            # 시가 사진을 바꿨다 — 사진과 출처를 함께 바꾼다.
            return (
                {"gallery_images": [new_url],
                 CITY_PHOTO_KEY: city_photo_credit(new_url, caption=caption, con_uid=con_uid)},
                "city_photo_refreshed",
            )
        return {}, "city_photo_kept"

    if representative or gallery:
        return {}, "has_photo"
    if not new_url:
        return {}, "no_city_photo"
    return (
        {"gallery_images": [new_url],
         CITY_PHOTO_KEY: city_photo_credit(new_url, caption=caption, con_uid=con_uid)},
        "city_photo_added",
    )


def retire_superseded_city_photo(row: dict[str, Any], prev: dict[str, Any], *, image_cleared: bool = False) -> None:
    """TourAPI 적재 행(row)을 제자리 수정한다 — 오늘 TourAPI 사진이 생겼으면 저장된 경주시 사진과 출처를 함께 뺀다.

    prev 는 DB 에 저장된 행(features·image_url·gallery_images). row 에 gallery_images 가 있으면 그 값이 이번 쓰기 뒤
    갤러리이고, 없으면 저장된 갤러리가 남는다. image_url 도 같다 — 행에 값이 있으면 그 값, 없으면 저장된 값
    (image_cleared: 이번 쓰기가 대표 사진을 지운다).
    """
    stored = stored_city_photo((prev or {}).get("features"))
    if stored is None:
        return
    city_url = _text(stored.get("url"))
    stored_gallery = gallery_urls(prev.get("gallery_images"))
    gallery_after = gallery_urls(row["gallery_images"]) if row.get("gallery_images") is not None else stored_gallery
    if row.get("image_url"):
        image_after = _text(row.get("image_url"))
    elif image_cleared:
        image_after = ""
    else:
        image_after = _text(prev.get("image_url"))
    others = [u for u in gallery_after if u != city_url]
    if image_after or others:
        kept = others
        if kept != gallery_after:
            row["gallery_images"] = kept
        row["features"] = {**(row.get("features") or {}), CITY_PHOTO_KEY: None}
    elif city_url not in gallery_after:
        row["features"] = {**(row.get("features") or {}), CITY_PHOTO_KEY: None}
