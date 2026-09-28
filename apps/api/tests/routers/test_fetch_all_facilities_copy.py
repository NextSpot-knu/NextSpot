"""`fetch_all_facilities` 의 사각형 필터를 깊은 복사 **앞으로** 옮긴 것(P3a3 commit 4)이 결과를 바꾸지 않는지.

예전: 캐시 전체(1,682곳)를 깊은 복사 → 사각형 필터. 지금: 공유 행에 사각형 필터 → 남은 행만 깊은 복사.
같아야 하는 것: 돌려주는 행의 값, 행끼리의 중첩 객체 공유 관계(id 패턴), 캐시와의 완전 분리.
"""

import copy
import math
import random

import pytest

from app.routers import recommendations
from app.services import facility_cache

_CENTER = (35.8361, 129.2105)


@pytest.fixture(autouse=True)
def _clear_cache():
    facility_cache.invalidate_facility_cache()
    yield
    facility_cache.invalidate_facility_cache()


def _fixture_rows(n: int = 300, seed: int = 20260929) -> list[dict]:
    rng = random.Random(seed)
    shared_features = {"indoor": True, "cuisine_tags": ["한식", "국수"]}
    rows: list[dict] = []
    for i in range(n):
        lat = _CENTER[0] + rng.uniform(-0.03, 0.03)
        lng = _CENTER[1] + rng.uniform(-0.03, 0.03)
        row = {
            "id": f"f-{i:03d}",
            "name": f"시설 {i}",
            "type": rng.choice(["cafe", "restaurant", "attraction", "culture"]),
            "latitude": lat if i % 37 else None,
            "longitude": lng if i % 41 else None,
            "capacity": rng.randint(10, 200),
            "coupon_rate": rng.choice([0.0, 0.05, 0.1]),
            "features": {"indoor": bool(i % 2), "tags": [f"t{i % 5}", f"u{i % 3}"]},
            "operating_hours": {"open": "09:00~21:00", "closed": "연중무휴", "breaks": [["15:00", "17:00"]]},
            "gallery_images": [f"https://img.example/{i}/{k}.jpg" for k in range(i % 4)] or None,
        }
        if i % 53 == 7:
            row["latitude"] = str(round(lat, 6))  # 문자열 좌표도 float() 로 판정된다
        rows.append(row)
    # 두 행이 중첩 dict 하나를 공유한다 — 둘 다 중심 근처(같이 살아남음).
    rows[0].update(latitude=_CENTER[0] + 0.001, longitude=_CENTER[1] + 0.001, features=shared_features)
    rows[1].update(latitude=_CENTER[0] - 0.001, longitude=_CENTER[1] - 0.001, features=shared_features)
    # 한 행은 중심 근처, 다른 한 행은 멀리 — 공유 중첩 값의 한쪽만 살아남는다.
    hours = {"open": "10:00~20:00", "closed": "매주 월요일"}
    rows[2].update(latitude=_CENTER[0] + 0.002, longitude=_CENTER[1], operating_hours=hours)
    rows[3].update(latitude=_CENTER[0] + 0.2, longitude=_CENTER[1], operating_hours=hours)
    return rows


def _bboxes(n: int = 20, seed: int = 11) -> list[tuple[float, float, float]]:
    rng = random.Random(seed)
    boxes = [(_CENTER[0], _CENTER[1], 1000.0), (_CENTER[0], _CENTER[1], 2000.0)]
    while len(boxes) < n:
        boxes.append((
            _CENTER[0] + rng.uniform(-0.02, 0.02),
            _CENTER[1] + rng.uniform(-0.02, 0.02),
            rng.choice([300.0, 700.0, 1000.0, 1500.0, 2000.0, 3000.0]),
        ))
    return boxes


def _old_path(cached: list[dict], center_lat: float, center_lng: float, radius_m: float) -> list[dict]:
    """10ea2d4 의 순서 그대로: 캐시 전체 깊은 복사 → 같은 사각형 식으로 필터."""
    facilities = copy.deepcopy(cached)
    lat_delta = radius_m / 111_320.0
    lng_delta = radius_m / max(1.0, 111_320.0 * math.cos(math.radians(center_lat)))
    return [
        f for f in facilities
        if f.get("latitude") is not None and f.get("longitude") is not None
        and center_lat - lat_delta <= float(f["latitude"]) <= center_lat + lat_delta
        and center_lng - lng_delta <= float(f["longitude"]) <= center_lng + lng_delta
    ]


def _id_pattern(rows: list[dict]) -> list[int]:
    """중첩 컨테이너를 결정적 순서로 훑으며 '처음 본 객체 번호' 를 적는다 — 공유 관계가 같으면 같은 목록."""
    seen: dict[int, int] = {}
    pattern: list[int] = []

    def walk(value):
        if isinstance(value, (dict, list)):
            pattern.append(seen.setdefault(id(value), len(seen)))
            children = value.values() if isinstance(value, dict) else value
            for child in children:
                walk(child)

    for row in rows:
        walk(row)
    return pattern


def _containers(value, out: list) -> list:
    if isinstance(value, (dict, list)):
        out.append(value)
        for child in (value.values() if isinstance(value, dict) else value):
            _containers(child, out)
    return out


async def _prime(monkeypatch, rows: list[dict]) -> list[dict]:
    async def _uncached(**_kwargs):
        return rows

    monkeypatch.setattr(recommendations, "_fetch_all_facilities_uncached", _uncached)
    return await facility_cache.get_facilities_cached(("all",), _uncached, isolate=False)


@pytest.mark.asyncio
async def test_bbox_before_deepcopy_returns_the_same_rows_and_aliasing(monkeypatch):
    cached = await _prime(monkeypatch, _fixture_rows())
    survivors_seen = 0
    for center_lat, center_lng, radius_m in _bboxes():
        new = await recommendations.fetch_all_facilities(
            center_lat=center_lat, center_lng=center_lng, radius_m=radius_m, with_availability=False,
        )
        old = _old_path(cached, center_lat, center_lng, radius_m)
        assert new == old
        assert [f["id"] for f in new] == [f["id"] for f in old]
        assert _id_pattern(new) == _id_pattern(old)
        survivors_seen += len(new)
    assert survivors_seen > 100

    # 공유 중첩 값은 둘 다 살아남으면 사본에서도 하나를 공유한다(예전과 같이).
    both = await recommendations.fetch_all_facilities(
        center_lat=_CENTER[0], center_lng=_CENTER[1], radius_m=1000.0, with_availability=False,
    )
    by_id = {f["id"]: f for f in both}
    assert by_id["f-000"]["features"] is by_id["f-001"]["features"]
    assert by_id["f-000"]["features"] is not cached[0]["features"]


@pytest.mark.asyncio
async def test_returned_rows_share_nothing_with_the_cache(monkeypatch):
    cached = await _prime(monkeypatch, _fixture_rows())
    cached_ids = {id(obj) for obj in _containers(cached, [])}
    rows = await recommendations.fetch_all_facilities(
        center_lat=_CENTER[0], center_lng=_CENTER[1], radius_m=2000.0, with_availability=False,
    )
    assert rows
    assert not any(id(obj) in cached_ids for obj in _containers(rows, []))


@pytest.mark.asyncio
async def test_mutating_a_returned_row_leaves_the_cache_unchanged(monkeypatch):
    cached = await _prime(monkeypatch, _fixture_rows())
    before = copy.deepcopy(cached)
    rows = await recommendations.fetch_all_facilities(
        center_lat=_CENTER[0], center_lng=_CENTER[1], radius_m=2000.0, with_availability=False,
    )
    for row in rows:
        row["features"]["indoor"] = "mutated"
        row["operating_hours"]["open"] = "mutated"
        row["name"] = "mutated"
    again = await facility_cache.get_facilities_cached(("all",), recommendations._fetch_all_facilities_uncached, isolate=False)
    assert again == before


@pytest.mark.asyncio
async def test_with_availability_attaches_the_same_evidence(monkeypatch):
    cached = await _prime(monkeypatch, _fixture_rows())
    evidence = {"f-000": {"status": "open", "evidence_tier": "corroborated"}}
    asked: list[list[str]] = []

    async def _evidence(ids):
        asked.append(list(ids))
        return evidence

    monkeypatch.setattr(recommendations, "fetch_effective_availability_map", _evidence)
    new = await recommendations.fetch_all_facilities(center_lat=_CENTER[0], center_lng=_CENTER[1], radius_m=1000.0)
    old = recommendations.attach_availability_evidence(_old_path(cached, _CENTER[0], _CENTER[1], 1000.0), evidence)
    assert new == old
    assert asked == [[str(f["id"]) for f in old]]


@pytest.mark.asyncio
async def test_no_bbox_and_shared_reads_keep_todays_path(monkeypatch):
    cached = await _prime(monkeypatch, _fixture_rows())
    full = await recommendations.fetch_all_facilities(with_availability=False)
    assert full == cached and all(a is not b for a, b in zip(full, cached))
    shared = await recommendations.fetch_all_facilities(
        center_lat=_CENTER[0], center_lng=_CENTER[1], radius_m=1000.0, with_availability=False, copy_rows=False,
    )
    assert shared == _old_path(cached, _CENTER[0], _CENTER[1], 1000.0)
    cached_by_id = {f["id"]: f for f in cached}
    assert all(row is cached_by_id[row["id"]] for row in shared)


@pytest.mark.asyncio
async def test_bbox_call_deep_copies_only_the_survivors(monkeypatch):
    """새 동작: 사각형 호출은 캐시 전체가 아니라 남은 행만 깊은 복사한다."""
    cached = await _prime(monkeypatch, _fixture_rows())
    real_deepcopy = copy.deepcopy
    copied_list_sizes: list[int] = []

    def _spy(value, memo=None, _nil=[]):  # noqa: B006 — copy.deepcopy 의 서명을 그대로 흉내 낸다
        if memo is None and isinstance(value, list):
            copied_list_sizes.append(len(value))
        return real_deepcopy(value, memo) if memo is not None else real_deepcopy(value)

    monkeypatch.setattr(copy, "deepcopy", _spy)
    rows = await recommendations.fetch_all_facilities(
        center_lat=_CENTER[0], center_lng=_CENTER[1], radius_m=1000.0, with_availability=False,
    )
    assert 0 < len(rows) < len(cached)
    assert copied_list_sizes == [len(rows)]
