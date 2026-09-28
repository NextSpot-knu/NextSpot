"""주차 이력 행렬 저장소(app/services/parking_history.py) — 자료구조·병합·창·세대 번호(순수 함수, I/O 없음).

스펙 §8 의 T1-T3, T5, T6 과, 같은 순수 함수를 잠그는 보조 시험. 적재 루프(T4, T7-T18)는 다음 커밋에서 붙는다.
"""

from __future__ import annotations

import itertools
import random
from datetime import date, datetime, timedelta, timezone

import pytest

from app.services import area_demand_forecast_service as forecast_svc
from app.services import parking_history as ph
from app.services.spot.travel import calculate_haversine_distance
from tests.services._parking_fixture import (
    EDGE_BUCKET,
    EDGE_SINCE,
    LOTS,
    MOVE_DAY,
    MOVED_LOT_COORDS,
    MOVED_LOT_ID,
    NOW_EDGE,
    START,
    fixture_56d,
    pg_round_distance,
)

UTC = timezone.utc
_CENTER = (35.8361, 129.2105)


def _parse(rows):
    return ph.parse_page(rows, aware=forecast_svc._aware)


def _full(now=NOW_EDGE):
    return ph.merge(None, _parse(fixture_56d().rows), now=now)


def _cells_by_bucket(snapshot):
    return {
        bucket: (snapshot.observed_us[i], ph._cells_at(snapshot, i))
        for i, bucket in enumerate(snapshot.bucket_us)
    }


def _db_row(bucket: datetime, observed: datetime, lots):
    return {
        "bucket_at": bucket.isoformat(),
        "observed_at": observed.isoformat(),
        "area_demand_snapshot_lots": [
            {"source_lot_id": lot_id, "latitude": lat, "longitude": lng,
             "total_spaces": total, "available_spaces": available}
            for lot_id, lat, lng, total, available in lots
        ],
    }


class _CountingGeneration:
    """세대 번호를 몇 번 받았는지 센다(바뀐 것 없는 병합은 번호를 쓰면 안 된다)."""

    def __init__(self, start: int = 1_000_000):
        self._counter = itertools.count(start)
        self.calls = 0

    def __call__(self) -> int:
        self.calls += 1
        return next(self._counter)


# ── T1 ───────────────────────────────────────────────────────────────────────


def test_merge_is_idempotent_by_bucket():
    rows = fixture_56d().rows
    first = ph.merge(None, _parse(rows), now=NOW_EDGE)
    assert first is not None and len(first.observed) > 7_000

    counting = _CountingGeneration()
    for offset in range(0, len(rows), 1000):  # 적재 쿼리의 쪽 단위로 다시 읽어도
        assert ph.merge(first, _parse(rows[offset:offset + 1000]), now=NOW_EDGE, new_generation=counting) is None
    assert ph.merge(first, _parse(rows), now=NOW_EDGE, new_generation=counting) is None
    assert counting.calls == 0, "바뀐 것 없는 병합이 세대 번호를 썼다"

    # 같은 내용은 같은 digest — 한 번에 넣든 쪽마다 병합하든.
    again = ph.merge(None, _parse(rows), now=NOW_EDGE)
    assert again.digest == first.digest and again.generation > first.generation
    paged = None
    for offset in range(0, len(rows), 1000):
        paged = ph.merge(paged, _parse(rows[offset:offset + 1000]), now=NOW_EDGE)
    assert paged.digest == first.digest
    assert paged.columns == first.columns
    assert list(paged.observed_us) == list(first.observed_us)
    assert paged.observed == first.observed


def test_unchanged_rows_keep_their_datetime_objects_across_merges():
    rows = fixture_56d().rows
    base = ph.merge(None, _parse(rows[:-3]), now=NOW_EDGE)
    merged = ph.merge(base, _parse(rows[-3:]), now=NOW_EDGE)
    assert merged is not None and len(merged.observed) == len(base.observed) + 3
    by_us = {us: dt for us, dt in zip(base.observed_us, base.observed)}
    shared = [dt for us, dt in zip(merged.observed_us, merged.observed) if us in by_us]
    assert shared and all(dt is by_us[ph.to_us(dt)] for dt in shared)


# ── T2 ───────────────────────────────────────────────────────────────────────


def test_db_row_replaces_bucket_whole():
    snapshot = _full()
    # 주차장 칸이 3개 이상인 가운데 행 하나를 고른다.
    index = next(i for i in range(len(snapshot.observed) // 2, len(snapshot.observed))
                 if len(ph._cells_at(snapshot, i)) >= 3)
    bucket = ph.from_us(snapshot.bucket_us[index])
    newer = snapshot.observed[index] + timedelta(seconds=30, microseconds=5)
    lot_id, lat, lng, total = LOTS[1]
    replacement = _db_row(bucket, newer, [(lot_id, lat, lng, total, 7)])

    before = _cells_by_bucket(snapshot)
    merged = ph.merge(snapshot, _parse([replacement]), now=NOW_EDGE)
    assert merged is not None
    assert merged.generation > snapshot.generation
    after = _cells_by_bucket(merged)
    assert len(after) == len(before)
    assert after[snapshot.bucket_us[index]] == (
        ph.to_us(newer), {ph.LotColumn(lot_id, lat, lng): (total, 7)}
    ), "더 적은 주차장을 가진 새 행이 버킷을 통째로 바꾸지 않았다"
    del before[snapshot.bucket_us[index]], after[snapshot.bucket_us[index]]
    assert after == before
    # 관측 시각 정렬은 유지된다.
    assert list(merged.observed_us) == sorted(merged.observed_us)


def test_replaced_bucket_drops_a_column_that_only_it_used_and_inserts_missing_buckets():
    b1 = datetime(2026, 9, 20, 3, 0, tzinfo=UTC)
    b2 = b1 + timedelta(minutes=10)
    b3 = b2 + timedelta(minutes=10)
    now = b3 + timedelta(hours=1)
    lot_a = ("gyeongju-its:87", 35.84031213, 129.21243696, 95)
    lot_x = ("gyeongju-its:99", 35.81, 129.20, 40)
    rows = [
        _db_row(b1, b1 + timedelta(seconds=20), [(*lot_a, 10)]),
        _db_row(b2, b2 + timedelta(seconds=20), [(*lot_a, 11), (*lot_x, 3)]),
    ]
    snapshot = ph.merge(None, _parse(rows), now=now)
    assert [c.lot_id for c in snapshot.columns] == ["gyeongju-its:87", "gyeongju-its:99"]

    retry = _db_row(b2, b2 + timedelta(seconds=380), [(*lot_a, 12)])  # :06 재시도가 버킷을 갈아 끼운다
    inserted = _db_row(b3, b3 + timedelta(seconds=9), [(*lot_a, 13)])
    merged = ph.merge(snapshot, _parse([retry, inserted]), now=now)
    assert [c.lot_id for c in merged.columns] == ["gyeongju-its:87"]
    assert list(merged.total[0]) == [95, 95, 95]
    assert list(merged.avail[0]) == [10, 12, 13]
    assert list(merged.bucket_us) == [ph.to_us(b1), ph.to_us(b2), ph.to_us(b3)]


def test_same_observed_at_with_different_cells_is_replaced():
    """DB 행이 정본이다 — observed_at 이 같아도 칸이 다르면(손으로 고친 행 등) DB 쪽으로 바꾼다."""
    b1 = datetime(2026, 9, 20, 3, 0, tzinfo=UTC)
    observed = b1 + timedelta(seconds=20)
    now = b1 + timedelta(hours=1)
    lot = ("gyeongju-its:87", 35.84031213, 129.21243696, 95)
    snapshot = ph.merge(None, _parse([_db_row(b1, observed, [(*lot, 10)])]), now=now)
    merged = ph.merge(snapshot, _parse([_db_row(b1, observed, [(*lot, 11)])]), now=now)
    assert merged is not None and list(merged.avail[0]) == [11]
    assert merged.digest != snapshot.digest


def test_rows_arrive_out_of_bucket_order_and_sort_by_observed_at():
    b1 = datetime(2026, 9, 20, 3, 0, tzinfo=UTC)
    b2 = b1 + timedelta(minutes=10)
    lot = ("gyeongju-its:87", 35.84031213, 129.21243696, 95)
    # b1 의 관측이 b2 의 관측보다 늦다(옛 15분 행·지연 수집) — RPC 는 observed_at 순서로 낸다.
    rows = [
        _db_row(b1, b1 + timedelta(seconds=890), [(*lot, 1)]),
        _db_row(b2, b2 + timedelta(seconds=8), [(*lot, 2)]),
    ]
    snapshot = ph.merge(None, _parse(rows), now=b2 + timedelta(hours=1))
    assert list(snapshot.bucket_us) == [ph.to_us(b2), ph.to_us(b1)]
    assert list(snapshot.avail[0]) == [2, 1]


# ── T3 ───────────────────────────────────────────────────────────────────────


def test_window_start_and_lookback_constant():
    assert ph.LOOKBACK.days == ph.LOOKBACK_DAYS == forecast_svc._LOOKBACK_DAYS

    fixture = fixture_56d()
    snapshot = _full()

    # bucket_at < since ≤ observed_at 인 행은 창 안이다(SQL 은 observed_at 으로 거른다).
    start = ph.window_start(snapshot, EDGE_SINCE)
    assert snapshot.bucket_us[start] == ph.to_us(EDGE_BUCKET) < ph.to_us(EDGE_SINCE)
    assert snapshot.observed[start] == forecast_svc._aware(fixture.edge_row["observed_at"])

    # SQL `observed_at >= p_since` 와 같은 집합.
    expected = sorted(
        forecast_svc._aware(row["observed_at"]) for row in fixture.rows
        if forecast_svc._aware(row["observed_at"]) >= EDGE_SINCE
    )
    assert list(snapshot.observed[start:]) == expected

    # 정확히 since 인 행은 들어가고, since 가 1µs 늦으면 빠진다.
    for index in (start, start + 1, len(snapshot.observed) // 2, len(snapshot.observed) - 1):
        exact = snapshot.observed[index]
        assert ph.window_start(snapshot, exact) == index
        assert ph.window_start(snapshot, exact + timedelta(microseconds=1)) == index + 1
    # 다른 시간대로 표기한 같은 순간도 같은 경계.
    exact = snapshot.observed[start + 1]
    assert ph.window_start(snapshot, exact.astimezone(timezone(timedelta(hours=9)))) == start + 1
    with pytest.raises(TypeError):
        ph.window_start(snapshot, exact.replace(tzinfo=None))


def test_merge_trims_outside_lookback_plus_margin_and_sets_floor():
    fixture = fixture_56d()
    snapshot = _full()
    cutoff = NOW_EDGE - ph.LOOKBACK - ph.WINDOW_MARGIN
    assert snapshot.floor_us == ph.to_us(cutoff)
    kept = [
        row for row in fixture.rows
        if forecast_svc._aware(row["observed_at"]) >= cutoff
    ]
    assert len(snapshot.observed) == len(kept) < len(fixture.rows), "56일 경계가 합성 자료를 가르지 않는다"
    assert snapshot.observed_us[0] >= snapshot.floor_us

    # 시간이 흐르면 뒤의 병합이 앞을 잘라 낸다(바뀐 것 = 잘라 낸 것뿐이어도 새 스냅샷).
    later = NOW_EDGE + timedelta(days=1)
    trimmed = ph.merge(snapshot, [], now=later)
    assert trimmed is not None and trimmed.generation > snapshot.generation
    assert trimmed.floor_us == ph.to_us(later - ph.LOOKBACK - ph.WINDOW_MARGIN)
    assert trimmed.observed_us[0] >= trimmed.floor_us
    assert len(trimmed.observed) < len(snapshot.observed)
    # 자를 것이 없으면 floor 만 움직이는 병합은 하지 않는다.
    assert ph.merge(trimmed, [], now=later) is None


def test_full_load_of_an_empty_window_is_a_snapshot():
    empty = ph.merge(None, [], now=NOW_EDGE)
    assert empty is not None
    assert empty.columns == () and len(empty.observed) == 0 and len(empty.observed_us) == 0
    assert ph.window_start(empty, EDGE_SINCE) == 0


# ── 파싱: 무효 칸·열 ─────────────────────────────────────────────────────────


def test_invalid_cells_match_aggregate_nearby_points_skip_set():
    fixture = fixture_56d()
    counts: dict[str, int] = {}
    snapshot = ph.merge(None, ph.parse_page(fixture.rows, aware=forecast_svc._aware, counts=counts),
                        now=NOW_EDGE)
    assert counts.get("invalid_cells", 0) > 0 and "skipped_rows" not in counts

    # 기존 파이썬 기준 구현이 센 주차장 수(lot_count)와 행렬의 유효 칸 수가 행마다 같다.
    lat, lng = _CENTER
    near = [j for j, c in enumerate(snapshot.columns)
            if calculate_haversine_distance(lat, lng, c.latitude, c.longitude) <= forecast_svc._RADIUS_M]
    assert len(near) >= 3
    reference = forecast_svc.aggregate_nearby_points(list(fixture.parents), list(fixture.lots), lat, lng)
    matrix = {}
    for i, observed in enumerate(snapshot.observed):
        count = sum(1 for j in near if snapshot.total[j][i] > 0)
        if count:
            matrix[observed] = count
    floor = ph.from_us(snapshot.floor_us)
    assert {p.observed_at: p.lot_count for p in reference if p.observed_at >= floor} == matrix


def test_moved_lot_becomes_a_new_column():
    snapshot = _full()
    moved = [c for c in snapshot.columns if c.lot_id == MOVED_LOT_ID]
    assert [(c.latitude, c.longitude) for c in moved] == sorted(
        [(LOTS[2][1], LOTS[2][2]), MOVED_LOT_COORDS]
    )
    assert list(snapshot.columns) == sorted(snapshot.columns)
    move_us = ph.to_us(START + timedelta(days=MOVE_DAY))
    new_j = snapshot.columns.index(ph.LotColumn(MOVED_LOT_ID, *MOVED_LOT_COORDS))
    old_j = snapshot.columns.index(ph.LotColumn(MOVED_LOT_ID, LOTS[2][1], LOTS[2][2]))
    for i, bucket in enumerate(snapshot.bucket_us):
        if bucket >= move_us:
            assert snapshot.total[old_j][i] == 0
        else:
            assert snapshot.total[new_j][i] == 0
    assert any(snapshot.total[new_j]) and any(snapshot.total[old_j])


def test_unparseable_rows_are_skipped_and_counted():
    good = _db_row(datetime(2026, 9, 20, 3, 0, tzinfo=UTC), datetime(2026, 9, 20, 3, 0, 9, tzinfo=UTC),
                   [("gyeongju-its:87", 35.84, 129.21, 95, 4)])
    bad_time = {**good, "observed_at": "not-a-time"}
    no_bucket = {k: v for k, v in good.items() if k != "bucket_at"}
    bad_lots = {**good, "area_demand_snapshot_lots": "oops"}
    no_lots = {**good, "area_demand_snapshot_lots": None}
    counts: dict[str, int] = {}
    rows = ph.parse_page([good, bad_time, no_bucket, bad_lots, "junk", no_lots],
                         aware=forecast_svc._aware, counts=counts)
    assert counts == {"skipped_rows": 4}
    assert [len(r.cells) for r in rows] == [1, 0]
    # 칸이 하나도 없는 행도 행으로 남는다(DB 행 수 대조용) — 열은 생기지 않는다.
    snapshot = ph.merge(None, rows[1:], now=datetime(2026, 9, 20, 4, 0, tzinfo=UTC))
    assert len(snapshot.observed) == 1 and snapshot.columns == ()


def test_observed_at_is_normalized_to_utc():
    row = _db_row(datetime(2026, 9, 20, 3, 0, tzinfo=UTC), datetime(2026, 9, 20, 3, 0, 9, tzinfo=UTC),
                  [("gyeongju-its:87", 35.84, 129.21, 95, 4)])
    row["observed_at"] = "2026-09-20T12:00:09+09:00"
    parsed = ph.parse_page([row], aware=forecast_svc._aware)[0]
    assert parsed.observed_dt.tzinfo is timezone.utc
    assert parsed.observed_dt.isoformat() == "2026-09-20T03:00:09+00:00"


# ── T5 ───────────────────────────────────────────────────────────────────────


def _reference_micros(value: datetime) -> int:
    """datetime 뺄셈 없이 서수·필드로 따로 센 epoch µs(독립 구현)."""
    naive = value.replace(tzinfo=None) - value.utcoffset()
    days = naive.toordinal() - date(1970, 1, 1).toordinal()
    seconds = days * 86_400 + naive.hour * 3_600 + naive.minute * 60 + naive.second
    return seconds * 1_000_000 + naive.microsecond


def test_epoch_micros_exact():
    rng = random.Random(5)
    zones = [UTC, timezone(timedelta(hours=9)), timezone(timedelta(hours=-7)),
             timezone(timedelta(hours=5, minutes=30))]
    base = datetime(2026, 8, 1, tzinfo=UTC)
    span = 60 * 86_400 * 10**6
    for _ in range(200_000):
        value = (base + timedelta(microseconds=rng.randrange(span))).astimezone(rng.choice(zones))
        micros = ph.to_us(value)
        assert micros == _reference_micros(value)
        assert ph.from_us(micros) == value
    with pytest.raises(TypeError):
        ph.to_us(datetime(2026, 8, 1))


# ── T6 ───────────────────────────────────────────────────────────────────────


def _level(lots):
    """aggregate_nearby_points(:266-278)와 같은 식 — [(total, available, distance_m)]."""
    weighted = weight_total = 0.0
    for total, available, distance_m in lots:
        occupancy = 1.0 - available / total
        weight = min(total, 500) / (1.0 + distance_m / 500.0)
        weighted = weighted + occupancy * weight
        weight_total = weight_total + weight
    return forecast_svc._clamp(weighted / weight_total)


def test_distance_tie_residual_is_bounded():
    """R11: 파이썬(짝수 반올림, 이진값 기준)과 Postgres(%.15g 뒤 사사오입)는 .x5 바로 아래 ~5e-12m 띠에서만 갈린다.

    그 띠에서 거리 차는 0.1m, 수준 차는 1e-4 이하다. 반경 2000m 경계에서는 주차장 하나의 포함 여부가 갈린다 —
    재현하지 않기로 한 잔여 위험(스펙 §5.2.2)이며, 이 시험은 그 크기를 기록한다.
    """
    ties = [100.04999999999998, 1234.5499999999997, 1999.9499999999998]
    for raw in ties:
        python_m = round(raw, 1)  # calculate_haversine_distance(travel.py:39)의 마지막 단계
        pg_m = pg_round_distance(raw)
        assert python_m != pg_m, f"{raw!r} 은 반올림 띠에 있지 않다"
        assert abs(python_m - pg_m) <= 0.1 + 1e-9
        for total_a, total_b in [(95, 221), (17, 564), (221, 564)]:
            for occ_a, occ_b in [(0, 1), (1, 0), (0.3, 0.8)]:
                avail_a, avail_b = round(total_a * (1 - occ_a)), round(total_b * (1 - occ_b))
                for other_m in (0.0, 800.0, 1999.0):
                    left = _level([(total_a, avail_a, python_m), (total_b, avail_b, other_m)])
                    right = _level([(total_a, avail_a, pg_m), (total_b, avail_b, other_m)])
                    assert abs(left - right) <= 1e-4

    # 반경 경계: 파이썬은 2000.0(안), Postgres 는 2000.1(밖) — 주차장 하나의 포함 여부가 갈린다.
    raw = 2000.0499999999997
    assert round(raw, 1) == 2000.0 <= forecast_svc._RADIUS_M
    assert pg_round_distance(raw) == 2000.1 > forecast_svc._RADIUS_M

    # 띠 밖에서는 두 반올림이 같다.
    rng = random.Random(6)
    for _ in range(20_000):
        raw = rng.uniform(0.0, 3000.0)
        if round(raw, 1) != pg_round_distance(raw):
            assert abs((raw * 10) % 1 - 0.5) < 1e-8, f"띠 밖에서 반올림이 갈렸다: {raw!r}"
