"""주차 이력 행렬 저장소(app/services/parking_history.py) — 자료구조·병합·창·세대 번호(순수 함수, I/O 없음).

스펙 §8 의 T1-T3, T5, T6 과, 같은 순수 함수를 잠그는 보조 시험. 뒤쪽은 적재 루프(T4, T7-T11, T13-T18)와
/health 칸(T33 의 health 부분) — 대역 DB(FakeParkingDB)·가짜 시계로 실제 루프 코드를 돌린다.
"""

from __future__ import annotations

import asyncio
import dataclasses
import itertools
import json
import math
import random
import threading
import time
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.core.config import settings
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
    FakeParkingDB,
    db_row,
    fixture_56d,
    pg_round_distance,
)
from tests.services.test_reference_snapshot import _wait_until

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


# =============================================================================
# 적재 루프(스펙 §3.3 Loader · §3.6 · §6 · §7.3) — T4, T7-T11, T13-T18, T33(health 부분)
# =============================================================================


class _Logs:
    """structlog 대신 끼우는 기록기 — (level, event, fields)."""

    def __init__(self, sink: list | None = None) -> None:
        self.events: list[tuple[str, str, dict]] = []
        self.sink = sink

    def _emit(self, level: str):
        def emit(event, **fields):
            self.events.append((level, event, fields))
            if self.sink is not None:
                self.sink.append(event)
        return emit

    def __getattr__(self, name):
        if name in ("debug", "info", "warning", "error", "exception", "critical"):
            return self._emit(name)
        raise AttributeError(name)

    def named(self, event: str) -> list[dict]:
        return [fields for _, name, fields in self.events if name == event]


class _Clock:
    """monotonic 과 벽시계를 함께 움직이는 가짜 시계."""

    def __init__(self, wall: datetime, mono: float = 10_000.0) -> None:
        self.mono0, self.wall0, self.t = mono, wall, mono

    def mono(self) -> float:
        return self.t

    def utcnow(self) -> datetime:
        return self.wall0 + timedelta(seconds=self.t - self.mono0)

    def install(self, monkeypatch) -> "_Clock":
        monkeypatch.setattr(ph, "_mono", self.mono)
        monkeypatch.setattr(ph, "_utcnow", self.utcnow)
        return self


_LOT_A = ("gyeongju-its:87", 35.84031213, 129.21243696, 95)
_LOT_B = ("gyeongju-its:89", 35.8454256, 129.2156901, 221)


def _rows_before(end: datetime, count: int, *, step=timedelta(minutes=10)):
    """end 직전까지 10분 간격 행 count 개(관측 = 버킷 + 37초 + i µs)."""
    first = end - step * count
    rows = []
    for i in range(count):
        bucket = first + step * i
        rows.append(db_row(bucket, bucket + timedelta(seconds=37, microseconds=i),
                           [(*_LOT_A, 10 + i % 50), (*_LOT_B, 100 + i % 90)]))
    return rows


async def _idle_run(self):
    await asyncio.Event().wait()


def _drive(monkeypatch, scenario):
    """루프 태스크 없이(_run 을 멈춰 두고) 시험이 _step 을 직접 돌린다. 적재 스레드·부기는 실제 코드."""
    monkeypatch.setattr(ph._Loader, "_run", _idle_run)

    async def main():
        ph.start()
        try:
            return await scenario(ph._loader)
        finally:
            await ph.stop()

    return asyncio.run(main())


def _full_since(request, now: datetime) -> bool:
    return request.filter("gte", "observed_at") == ph._iso(now - ph.LOOKBACK - ph.WINDOW_MARGIN)


@pytest.fixture
def loader_env(monkeypatch):
    """shadow 모드 + 대역 DB + 기록 로거 + 쉬지 않는 쪽 재시도. 적재 상태는 시험 앞뒤로 비운다."""
    monkeypatch.setattr(settings, "AREA_DEMAND_SOURCE", "shadow")
    db = FakeParkingDB()
    monkeypatch.setattr(ph, "supabase_admin", db)
    logs = _Logs()
    monkeypatch.setattr(ph, "logger", logs)
    sleeps: list[float] = []
    monkeypatch.setattr(ph, "_thread_sleep", sleeps.append)
    monkeypatch.setattr(ph, "_shadow_probe", None)
    monkeypatch.setattr(ph, "_health_extra", None)
    ph.reset_for_tests()
    yield SimpleNamespace(db=db, logs=logs, sleeps=sleeps)
    ph.reset_for_tests()


def test_source_constant_matches_the_forecast_service():
    assert ph.SOURCE == forecast_svc._SOURCE


# ── T4 ───────────────────────────────────────────────────────────────────────


def test_generation_is_process_global_and_strictly_increasing(monkeypatch, loader_env):
    db, logs = loader_env.db, loader_env.logs
    clock = _Clock(NOW_EDGE).install(monkeypatch)
    db.rows = list(fixture_56d().rows)

    async def scenario(loader):
        await loader._step()  # 부팅 전량 적재
        assert loader.ready
        generations = [loader.snapshot.generation]
        first_new = datetime(2026, 9, 28, 5, 0, tzinfo=UTC)  # 합성 자료 끝(00:00) 뒤, now(06:05) 앞
        for k in range(5):
            clock.t += 60
            bucket = first_new + timedelta(minutes=10 * k)
            db.add(db_row(bucket, bucket + timedelta(seconds=41), [(*_LOT_A, k)]))
            ph.kick_tail()
            await loader._step()
            generations.append(loader.snapshot.generation)
        expected = ph.merge(None, _parse(db.rows), now=clock.utcnow())
        assert _cells_by_bucket(loader.snapshot) == _cells_by_bucket(expected)
        assert generations == sorted(set(generations)), generations

        assert await loader._full("test")
        reloaded = loader.snapshot
        assert reloaded.generation > max(generations)
        # 카운터는 프로세스 전체에서 하나다 — 다른 병합도 뒤의 번호를 받는다.
        assert ph.merge(None, [], now=clock.utcnow()).generation > reloaded.generation

        # _apply 는 세대가 되돌아간 스냅샷을 바꿔 끼우지 않는다.
        real_merge = ph.merge
        monkeypatch.setattr(
            ph, "merge",
            lambda prev, rows, *, now: dataclasses.replace(real_merge(prev, rows, now=now), generation=1),
        )
        summary = loader._apply([], full=True, now=clock.utcnow())
        assert summary["changed"] is False and loader.snapshot is reloaded
        assert logs.named("parking_history_generation_regressed")

    _drive(monkeypatch, scenario)


# ── T7 ───────────────────────────────────────────────────────────────────────


def test_deploy_overlap_hole_is_repaired_by_trailing_window(monkeypatch, loader_env):
    db, logs = loader_env.db, loader_env.logs
    b1 = datetime(2026, 9, 20, 3, 0, tzinfo=UTC)
    buckets = [b1 + timedelta(minutes=10 * i) for i in range(5)]
    rows = [
        db_row(b, b + timedelta(seconds=40 + i, microseconds=123 * i), [(*_LOT_A, 10 + i), (*_LOT_B, 50 + i)])
        for i, b in enumerate(buckets)
    ]
    clock = _Clock(buckets[3] + timedelta(minutes=1)).install(monkeypatch)
    db.rows = rows[:3]  # 이 인스턴스가 부팅할 때 DB 에는 B1..B3 만 있다

    async def scenario(loader):
        await loader._step()
        assert len(loader.snapshot.observed) == 3
        db.add(rows[4])  # 다른(옛) 인스턴스가 B5 를 먼저 쓰고
        clock.t += 600
        ph.kick_tail()
        await loader._step()
        assert db.requests[-1].filter("gte", "observed_at") == ph._iso(clock.utcnow() - ph.TAIL_WINDOW)
        db.add(rows[3])  # B4 는 늦게 커밋됐다 — B5 뒤에 구멍
        clock.t = loader.next_sync_due
        await loader._step()  # 5분 꼬리(최근 2시간 다시 읽기)가 구멍을 메운다
        assert db.requests[-1].filter("gte", "observed_at") == ph._iso(clock.utcnow() - ph.TAIL_WINDOW)

        reference = ph.merge(None, _parse(rows), now=clock.utcnow())
        assert _cells_by_bucket(loader.snapshot) == _cells_by_bucket(reference)
        assert loader.snapshot.observed == reference.observed
        assert [s["kind"] for s in logs.named("parking_history_synced")] == ["kick", "tail"]

    _drive(monkeypatch, scenario)


# ── T8 ───────────────────────────────────────────────────────────────────────


def test_tail_window_widens_after_failures_and_reloads_beyond_24h(monkeypatch, loader_env):
    db, logs = loader_env.db, loader_env.logs
    now0 = datetime(2026, 9, 20, 3, 0, tzinfo=UTC)
    clock = _Clock(now0).install(monkeypatch)
    db.rows = _rows_before(now0, 12)

    async def fail_until(loader, span: timedelta, last_ok: datetime):
        db.fail = lambda request: True
        while clock.utcnow() - last_ok < span:
            clock.t = loader.next_sync_due
            await loader._step()
        db.fail = None

    async def scenario(loader):
        await loader._step()
        clock.t = loader.next_sync_due
        await loader._step()  # 정상 꼬리 — 창 2시간
        last_ok = clock.utcnow()
        assert db.requests[-1].filter("gte", "observed_at") == ph._iso(last_ok - ph.TAIL_WINDOW)
        seen = len(db.requests)

        # 5시간 장애: 꼬리가 실패할수록 창이 '마지막 성공 − 1시간' 까지 넓어진다.
        await fail_until(loader, timedelta(hours=5), last_ok)
        failed = logs.named("parking_history_sync_failed")
        assert [f["retry_in_s"] for f in failed[:5]] == [5.0, 15.0, 45.0, 135.0, 300.0]
        assert {f["retry_in_s"] for f in failed[5:]} == {300.0}
        assert all(f["phase"] == "tail" and f["ready"] is True for f in failed)  # 장애 중에는 대조를 쉰다
        tail_sinces = [
            datetime.fromisoformat(r.filter("gte", "observed_at")) for r in db.requests[seen:] if r.count is None
        ]
        assert tail_sinces[-1] == last_ok - ph.TAIL_GAP_MARGIN
        assert all(since <= last_ok - timedelta(minutes=55) for since in tail_sinces)

        assert not [r for r in db.requests[seen:] if r.count is not None]
        clock.t = loader.next_sync_due
        await loader._step()  # 복구 — 넓힌 창 그대로 한 번 읽고, 밀린 대조가 이어서 돈다
        assert loader.failures == 0
        assert db.requests[-1].count is not None
        reads = [r for r in db.requests if r.count is None]
        assert reads[-1].filter("gte", "observed_at") == ph._iso(last_ok - ph.TAIL_GAP_MARGIN)
        assert len(logs.named("parking_history_loaded")) == 1

        # 23시간 넘게 실패하면 창이 24시간을 넘는다 → 꼬리 대신 전량 적재.
        last_ok = clock.utcnow()
        await fail_until(loader, timedelta(hours=23, minutes=1), last_ok)
        clock.t = loader.next_sync_due
        await loader._step()
        assert _full_since([r for r in db.requests if r.count is None][-1], clock.utcnow())
        assert [entry["reason"] for entry in logs.named("parking_history_loaded")] == ["boot", "tail_gap"]
        assert loader.failures == 0

    _drive(monkeypatch, scenario)


# ── T9 ───────────────────────────────────────────────────────────────────────


def test_reconcile_reloads_only_after_two_consecutive_mismatches(monkeypatch, loader_env):
    db, logs = loader_env.db, loader_env.logs
    now0 = datetime(2026, 9, 20, 12, 0, tzinfo=UTC)
    clock = _Clock(now0).install(monkeypatch)
    db.rows = _rows_before(now0 - timedelta(minutes=5), 60)

    def count_requests():
        return [r for r in db.requests if r.count is not None]

    async def scenario(loader):
        await loader._step()
        assert loader.next_reconcile_due == clock.t + ph.RECONCILE_INTERVAL_S

        # 1) 일치 — 세기만 한다.
        clock.t += 60
        await loader._reconcile()
        assert len(count_requests()) == 1 and len(db.requests) == 2
        request = count_requests()[0]
        assert request.select == "bucket_at" and request.orders == [("bucket_at", True)] and request.limit == 1
        assert request.filter("gte", "observed_at") == ph._iso(clock.utcnow() - ph.LOOKBACK)

        # 2) 마지막 꼬리 뒤에 들어온 수집 한 건 — 한 번 어긋남 → 꼬리 → 일치. 전량 재적재 없음.
        bucket = now0 - timedelta(minutes=5)
        db.add(db_row(bucket, bucket + timedelta(seconds=30), [(*_LOT_A, 3)]))
        clock.t += 60
        await loader._reconcile()
        assert ph.to_us(bucket) in loader.snapshot.bucket_us
        assert len(count_requests()) == 3
        assert not logs.named("parking_history_reconcile_mismatch")
        assert len(logs.named("parking_history_loaded")) == 1

        # 3) 꼬리 창 밖(8시간 전)의 구멍 — 꼬리로는 못 메운다 → 두 번 연속 어긋남 → 전량 재적재.
        hole = now0 - timedelta(hours=8, minutes=2)  # 10분 버킷 사이 — 새 행이다
        db.add(db_row(hole, hole + timedelta(seconds=12), [(*_LOT_B, 7)]))
        clock.t += 60
        await loader._reconcile()
        mismatch = logs.named("parking_history_reconcile_mismatch")
        assert len(mismatch) == 1 and mismatch[0]["db_count"] == mismatch[0]["local_count"] + 1
        assert [entry["reason"] for entry in logs.named("parking_history_loaded")] == ["boot", "reconcile"]
        assert ph.to_us(hole) in loader.snapshot.bucket_us

        # 4) 다시 대조하면 일치 — 세기 한 번뿐.
        before = len(db.requests)
        clock.t += 60
        await loader._reconcile()
        assert len(db.requests) == before + 1

    _drive(monkeypatch, scenario)


def test_reconcile_failures_back_off_separately_from_tail_sync(monkeypatch, loader_env):
    """대조만 실패(권한·count 헤더)해도 꼬리 성공이 대조 백오프를 지워 5초마다 세지 않게."""
    db, logs = loader_env.db, loader_env.logs
    now0 = datetime(2026, 9, 20, 12, 0, tzinfo=UTC)
    clock = _Clock(now0).install(monkeypatch)
    db.rows = _rows_before(now0, 30)
    db.fail = lambda request: request.count is not None

    async def scenario(loader):
        await loader._step()
        start = clock.t
        for _ in range(2_000):  # 한 시간 모의(끝이 있게 — 시계가 멈춰도 시험이 매달리지 않는다)
            if clock.t >= start + 3600:
                break
            clock.t = max(clock.t + 1, min(loader.next_sync_due, loader.next_reconcile_due))
            await loader._step()
        failed = logs.named("parking_history_sync_failed")
        assert failed and {f["phase"] for f in failed} == {"reconcile"}
        # 첫 대조(준비 +30분) 뒤 30분: 5·15·45·135·300… — 꼬리 성공이 백오프를 5초로 되돌리지 않는다.
        assert [f["retry_in_s"] for f in failed] == [5.0, 15.0, 45.0, 135.0] + [300.0] * (len(failed) - 4)
        assert len([r for r in db.requests if r.count is not None]) == len(failed) <= 12
        assert loader.failures == 0 and loader.reconcile_failures >= 1

    _drive(monkeypatch, scenario)


# ── T10 ──────────────────────────────────────────────────────────────────────


def _keyset_case():
    rows = list(fixture_56d().rows[:2300])
    now = forecast_svc._aware(rows[-1]["observed_at"]) + timedelta(hours=1)
    return rows, now


def test_boot_load_keysets_by_bucket_at_and_parses_page_by_page(monkeypatch, loader_env):
    db = loader_env.db
    rows, now = _keyset_case()
    db.rows = rows
    parsed_sizes: list[int] = []
    real_parse = ph.parse_page

    def spy(page, **kwargs):
        page = list(page)
        parsed_sizes.append(len(page))
        return real_parse(page, **kwargs)

    monkeypatch.setattr(ph, "parse_page", spy)
    loader = ph._Loader()
    summary = loader._full_load(now)

    since_iso = ph._iso(now - ph.LOOKBACK - ph.WINDOW_MARGIN)
    assert len(db.requests) == 3
    for k, request in enumerate(db.requests):
        expected = [("eq", "source", "gyeongju_its"), ("gte", "observed_at", since_iso)]
        if k:
            last_bucket = forecast_svc._aware(rows[1000 * k - 1]["bucket_at"])
            expected.append(("gt", "bucket_at", ph._iso(last_bucket)))
        assert request.filters == expected
        assert request.select == ph._SELECT and request.count is None
        assert request.orders == [("bucket_at", False)] and request.limit == ph.PAGE_SIZE == 1000
    assert parsed_sizes == [1000, 1000, 300]
    assert summary["pages"] == 3 and summary["page_retries"] == 0 and summary["rows"] == 2300
    assert loader.snapshot.floor_us == ph.to_us(now - ph.LOOKBACK - ph.WINDOW_MARGIN)

    db.ignore_keyset = True  # 서버가 bucket_at=gt 를 무시한다 — 같은 쪽이 되풀이된다
    with pytest.raises(RuntimeError, match="did not advance"):
        ph._Loader()._full_load(now)


def test_page_and_count_queries_render_the_spec_url():
    """실제 postgrest 빌더가 만드는 쿼리 문자열 — 스펙 §3.3 의 적재·대조 쿼리."""
    from app.core.supabase import supabase_admin as real_client

    since = "2026-08-03T00:00:00+00:00"
    first = ph._page_query(real_client, since, None).request
    assert first.params.multi_items() == [
        ("select", ph._SELECT),
        ("source", "eq.gyeongju_its"),
        ("observed_at", f"gte.{since}"),
        ("order", "bucket_at.asc"),
        ("limit", "1000"),
    ]
    assert ph._SELECT == (
        "bucket_at,observed_at,"
        "area_demand_snapshot_lots(source_lot_id,latitude,longitude,total_spaces,available_spaces)"
    )
    later = ph._page_query(real_client, since, "2026-08-10T01:20:00+00:00").request
    assert ("bucket_at", "gt.2026-08-10T01:20:00+00:00") in later.params.multi_items()
    assert "%2B00%3A00" in str(later.params)  # '+' 가 URL 에서 공백으로 바뀌지 않는다

    count = ph._count_query(real_client, since).request
    assert count.params.multi_items() == [
        ("select", "bucket_at"),
        ("source", "eq.gyeongju_its"),
        ("observed_at", f"gte.{since}"),
        ("order", "bucket_at.desc"),
        ("limit", "1"),
    ]
    assert count.headers.get("prefer") == "count=exact"


# ── T11 ──────────────────────────────────────────────────────────────────────


def test_failed_page_is_retried_then_attempt_fails_keeping_previous_snapshot(loader_env):
    db, sleeps = loader_env.db, loader_env.sleeps
    rows, now = _keyset_case()
    db.rows = rows
    page2 = ph._iso(forecast_svc._aware(rows[999]["bucket_at"]))
    page3 = ph._iso(forecast_svc._aware(rows[1999]["bucket_at"]))
    failures = {"left": 2}

    def fail_twice(request):
        if request.filter("gt", "bucket_at") == page2 and failures["left"] > 0:
            failures["left"] -= 1
            return True
        return False

    db.fail = fail_twice
    loader = ph._Loader()
    summary = loader._full_load(now)
    cursors = [r.filter("gt", "bucket_at") for r in db.requests]
    assert cursors == [None, page2, page2, page2, page3], "끝낸 쪽을 다시 읽었거나 실패한 쪽을 덜 읽었다"
    assert sleeps == [2.0, 4.0]
    assert summary["page_retries"] == 2 and summary["rows"] == 2300
    previous = loader.snapshot

    db.requests.clear()
    sleeps.clear()
    db.fail = lambda request: request.filter("gt", "bucket_at") == page2
    with pytest.raises(RuntimeError):
        loader._full_load(now + timedelta(minutes=5))
    assert [r.filter("gt", "bucket_at") for r in db.requests] == [None, page2, page2, page2]
    assert sleeps == [2.0, 4.0]
    assert loader.snapshot is previous


# ── T13 ──────────────────────────────────────────────────────────────────────


def test_boot_failure_backoff_bounds_attempts(monkeypatch, loader_env):
    db, logs = loader_env.db, loader_env.logs
    clock = _Clock(NOW_EDGE).install(monkeypatch)
    db.rows = list(fixture_56d().rows)
    ph._Loader()._full_load(NOW_EDGE)  # 3쪽째 커서를 알아 둔다
    page3 = db.requests[2].filter("gt", "bucket_at")
    db.requests.clear()
    db.fail = lambda request: request.filter("gt", "bucket_at") == page3  # 3쪽째가 늘 실패한다

    async def scenario(loader):
        t0 = clock.t
        for second in range(61):  # 60초 동안 매초 kick_tail
            clock.t = t0 + second
            ph.kick_tail()
            assert loader._tail_requested is False
            await loader._step()
        attempts = [r for r in db.requests if r.filter("gt", "bucket_at") is None]
        assert len(attempts) == 3
        assert len(db.requests) == 3 * (2 + ph.PAGE_RETRIES), "시도마다 실패한 쪽까지만 다시 읽어야 한다"
        failed = logs.named("parking_history_sync_failed")
        assert [f["retry_in_s"] for f in failed] == [5.0, 15.0, 45.0]
        assert all(f["phase"] == "boot" and f["ready"] is False for f in failed)
        assert ph.servable(clock.utcnow() - ph.LOOKBACK) == (None, "not_ready")

        for _ in range(2):  # 준비 전 상한 60초
            clock.t = loader.next_sync_due
            await loader._step()
        assert [f["retry_in_s"] for f in logs.named("parking_history_sync_failed")][3:] == [60.0, 60.0]

        # 준비된 뒤: 꼬리가 실패하는 동안 kick_tail 은 아무것도 앞당기지 않는다.
        db.fail = None
        clock.t = loader.next_sync_due
        await loader._step()
        assert loader.ready
        clock.t = loader.next_sync_due
        db.fail = lambda request: True
        before = len(logs.named("parking_history_sync_failed"))
        t1 = clock.t
        for second in range(61):
            clock.t = t1 + second
            ph.kick_tail()
            if loader.failures > 0:
                assert loader._tail_requested is False
            await loader._step()
        tails = logs.named("parking_history_sync_failed")[before:]
        assert [f["retry_in_s"] for f in tails] == [5.0, 15.0, 45.0]

    _drive(monkeypatch, scenario)


# ── T14 ──────────────────────────────────────────────────────────────────────


def test_kick_tail_queued_behind_slow_full_load_merges_into_reloaded_snapshot(monkeypatch, loader_env):
    db, logs = loader_env.db, loader_env.logs
    monkeypatch.setattr(ph, "_reference_ready", lambda: True)
    now = datetime.now(UTC)
    db.rows = _rows_before(now - timedelta(minutes=2), 18)
    entered, release = threading.Event(), threading.Event()
    full_reads = {"n": 0}

    def after(request):
        since = request.filter("gte", "observed_at")
        if request.count is None and datetime.fromisoformat(since) < now - timedelta(days=50):
            full_reads["n"] += 1
            if full_reads["n"] == 2:  # 두 번째 전량 적재: 다 읽은 뒤 여기서 오래 걸린다
                entered.set()
                release.wait(10)

    db.after = after
    new_bucket = now - timedelta(minutes=1)

    async def scenario():
        ph.start()
        try:
            await _wait_until(lambda: ph._loader.ready)
            loader = ph._loader
            boot_generation = loader.snapshot.generation
            loader.last_ok_sync_wall = datetime.now(UTC) - timedelta(hours=25)  # 다음 꼬리는 전량이 된다
            loader.next_sync_due = 0.0
            loader._wake_up()
            await _wait_until(entered.is_set)
            db.add(db_row(new_bucket, new_bucket + timedelta(seconds=20), [(*_LOT_A, 1)]))  # 수집이 새 행을 저장
            loader._last_kick = -math.inf
            ph.kick_tail()
            assert loader._tail_requested
            release.set()
            await _wait_until(lambda: ph.to_us(new_bucket) in loader.snapshot.bucket_us)
            # 스냅샷은 적재 스레드의 _apply 가 먼저 바꿔 끼우고, 로그는 루프가 그 뒤에 남긴다 — 로그까지 기다린다.
            await _wait_until(lambda: logs.named("parking_history_synced"))
            loaded = logs.named("parking_history_loaded")
            assert [entry["reason"] for entry in loaded] == ["boot", "tail_gap"]
            assert loader.snapshot.generation > loaded[1]["generation"] > boot_generation
            expected = {ph.to_us(forecast_svc._aware(r["bucket_at"])) for r in db.rows}
            assert set(loader.snapshot.bucket_us) == expected
            assert [s["kind"] for s in logs.named("parking_history_synced")] == ["kick"]
        finally:
            release.set()
            await ph.stop()

    asyncio.run(scenario())


# ── T15 ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw, expected",
    [("matrix ", "matrix"), (" Shadow", "shadow"), ("RPC", "rpc"), ("rpc", "rpc"), ("off", "rpc"),
     ("", "rpc"), ("matrixx", "rpc"), (None, "rpc")],
)
def test_mode_parsing(monkeypatch, raw, expected):
    monkeypatch.setattr(settings, "AREA_DEMAND_SOURCE", raw)
    assert ph.mode() == expected


def test_rpc_mode_starts_nothing(monkeypatch, loader_env):
    monkeypatch.setattr(settings, "AREA_DEMAND_SOURCE", "rpc")
    existing = {t.ident for t in threading.enumerate()}

    async def scenario():
        before = asyncio.all_tasks()
        ph.start()
        assert asyncio.all_tasks() == before
        ph.kick_tail()
        ph.ensure_running()
        assert asyncio.all_tasks() == before
        await ph.stop()

    asyncio.run(scenario())
    assert ph._loader._task is None and ph._loader._executor is None and not ph._loader._started
    assert not [t for t in threading.enumerate() if t.name == "nextspot-parking" and t.ident not in existing]
    assert loader_env.db.requests == []
    assert loader_env.logs.events == []
    assert ph.health() == {"mode": "rpc"}
    assert ph.current() is None
    assert ph.servable(datetime.now(UTC)) == (None, "not_ready")


def _quiet_warmup(monkeypatch):
    """lifespan 의 예열이 네트워크(ITS·JWKS·Storage)로 나가지 않게."""
    from app.core import supabase as supabase_module
    from app.routers import recommendations
    from app.services import event_boost, parking_demand_service, predict_service, weather_service

    async def _none(*_args, **_kwargs):
        return None

    async def _no_lots(*_args, **_kwargs):
        return {"lots": [], "source": "test"}

    async def _no_facilities(*_args, **_kwargs):
        return []

    class _NoJwks:
        def get_jwk_set(self):
            raise RuntimeError("offline")

    monkeypatch.setattr(predict_service, "start_model_manager", _none)
    monkeypatch.setattr(predict_service, "stop_model_manager", _none)
    monkeypatch.setattr(predict_service, "get_model_info", lambda: {"trained": False})
    monkeypatch.setattr(supabase_module, "_get_jwks_client", lambda: _NoJwks())
    monkeypatch.setattr(recommendations, "fetch_all_facilities", _no_facilities)
    monkeypatch.setattr(parking_demand_service, "get_nearby_parking_lots", _no_lots)
    monkeypatch.setattr(weather_service, "get_gyeongju_weather", _none)
    monkeypatch.setattr(event_boost, "get_event_congestion_boost", _none)


@pytest.mark.parametrize("source", ["rpc", "shadow"])
def test_lifespan_starts_the_loader_after_warmup_and_stops_it(monkeypatch, loader_env, source):
    from fastapi.testclient import TestClient

    from app import main

    monkeypatch.setattr(settings, "AREA_DEMAND_SOURCE", source)
    _quiet_warmup(monkeypatch)
    order: list[str] = []
    monkeypatch.setattr(main, "_logger", _Logs(sink=order))
    real_start, real_stop = ph.start, ph.stop

    def start():
        order.append("parking_history.start")
        real_start()

    async def stop():
        order.append("parking_history.stop")
        await real_stop()

    monkeypatch.setattr(ph, "start", start)
    monkeypatch.setattr(ph, "stop", stop)
    loader_env.db.rows = _rows_before(datetime.now(UTC), 6)
    existing = {t.ident for t in threading.enumerate()}

    with TestClient(main.app) as client:
        if source == "shadow":
            deadline = time.monotonic() + 10
            while not ph._loader.ready:
                assert time.monotonic() < deadline, "loader never became ready"
                time.sleep(0.02)
            body = client.get("/health").json()["parking_history"]
            assert body["mode"] == "shadow" and body["ready"] is True and body["rows"] == 6
        else:
            assert client.get("/health").json()["parking_history"] == {"mode": "rpc"}
        started = [t for t in threading.enumerate() if t.name == "nextspot-parking" and t.ident not in existing]

    assert order.index("warmup_done") < order.index("parking_history.start") < order.index("parking_history.stop")
    assert ph._loader._task is None and ph._loader._executor is None
    if source == "rpc":
        assert started == [] and loader_env.db.requests == []
    else:
        assert len(started) == 1
        started[0].join(timeout=2)
        assert not started[0].is_alive(), "적재 스레드가 종료 뒤에도 남았다"


# ── T16 ──────────────────────────────────────────────────────────────────────


def test_first_load_waits_for_reference_snapshot(monkeypatch, loader_env):
    db, logs = loader_env.db, loader_env.logs
    db.rows = _rows_before(datetime.now(UTC), 6)
    monkeypatch.setattr(ph, "BOOT_POLL_S", 0.02)
    first: dict[str, float] = {}
    db.before = lambda request: first.setdefault("t", time.monotonic())

    async def first_request_after(ready_after: float | None) -> float:
        first.clear()
        started = time.monotonic()
        monkeypatch.setattr(
            ph, "_reference_ready",
            lambda: ready_after is not None and time.monotonic() - started >= ready_after,
        )
        ph.start()
        try:
            await _wait_until(lambda: "t" in first, timeout=10)
        finally:
            await ph.stop()
            ph.reset_for_tests()
        return first["t"] - started

    # 스펙 값(준비 3초 · 상한 30초)을 줄여서 잰다: 준비 0.3초 · 상한 0.6초.
    monkeypatch.setattr(ph, "BOOT_WAIT_REFERENCE_S", 5.0)
    assert asyncio.run(first_request_after(0.3)) >= 0.3
    assert not logs.named("parking_history_boot_gate_timeout")
    monkeypatch.setattr(ph, "BOOT_WAIT_REFERENCE_S", 0.6)
    waited = asyncio.run(first_request_after(None))
    assert 0.6 <= waited < 1.6
    assert len(logs.named("parking_history_boot_gate_timeout")) == 1


def test_reference_ready_gate_semantics(monkeypatch):
    from app.services import reference_snapshot as rs

    monkeypatch.setattr(settings, "REFERENCE_SNAPSHOT_SERVE", "legacy")
    assert ph._reference_ready() is True  # 참조 스냅샷이 꺼져 있으면(적재 루프 없음) 기다릴 것이 없다
    monkeypatch.setattr(settings, "REFERENCE_SNAPSHOT_SERVE", "snapshot")
    assert ph._reference_ready() is False
    monkeypatch.setattr(rs, "health", lambda: {"serve": "snapshot", "ready": True})
    assert ph._reference_ready() is True

    def boom():
        raise RuntimeError("x")

    monkeypatch.setattr(rs, "health", boom)
    assert ph._reference_ready() is False


def test_parking_boot_does_not_delay_the_reference_snapshot(monkeypatch, loader_env):
    from app.services import reference_snapshot as rs
    from tests.services.test_reference_snapshot import _golden_db, _install

    monkeypatch.setattr(settings, "REFERENCE_SNAPSHOT_SERVE", "snapshot")
    _install(monkeypatch, _golden_db(datetime.now(UTC)))
    loader_env.db.rows = _rows_before(datetime.now(UTC), 6)
    loader_env.db.before = lambda request: time.sleep(0.5)  # 쪽마다 0.5초 느린 주차 이력 읽기

    async def reference_ready_after(with_parking: bool) -> float:
        rs.reset_for_tests()
        ph.reset_for_tests()
        started = time.monotonic()
        rs.start()
        if with_parking:
            ph.start()
        try:
            await _wait_until(lambda: rs.health()["ready"], timeout=10)
            return time.monotonic() - started
        finally:
            await rs.stop()
            await ph.stop()

    without = sorted(asyncio.run(reference_ready_after(False)) for _ in range(3))[1]
    with_loader = sorted(asyncio.run(reference_ready_after(True)) for _ in range(3))[1]
    assert with_loader <= without + 0.05, (with_loader, without)


# ── T17 ──────────────────────────────────────────────────────────────────────


def test_parking_loader_does_not_share_the_reference_thread(monkeypatch, loader_env):
    from app.services import reference_snapshot as rs
    from tests.services.test_reference_snapshot import _golden_db, _install

    ref_db = _golden_db(datetime.now(UTC))
    ref_threads: set[str] = set()
    real_table = ref_db.table

    def table(name):
        ref_threads.add(threading.current_thread().name)
        return real_table(name)

    ref_db.table = table
    _install(monkeypatch, ref_db)
    monkeypatch.setattr(ph, "_reference_ready", lambda: True)
    loader_env.db.rows = _rows_before(datetime.now(UTC), 6)
    entered, release = threading.Event(), threading.Event()

    def block(request):
        entered.set()
        release.wait(10)

    loader_env.db.before = block

    async def scenario():
        ph.start()
        try:
            await _wait_until(entered.is_set)  # 주차 이력 읽기가 매달려 있다
            started = time.monotonic()
            await asyncio.wait_for(rs.refresh_once(), timeout=5)
            assert time.monotonic() - started < 1.0
            assert rs.current_base() is not None
        finally:
            release.set()
            await ph.stop()

    asyncio.run(scenario())
    assert {request.thread for request in loader_env.db.requests} == {"nextspot-parking"}
    assert ref_threads == {"nextspot-ref"}


# ── T18 ──────────────────────────────────────────────────────────────────────


def test_servable_is_pure_and_reasons(monkeypatch, loader_env):
    clock = _Clock(NOW_EDGE).install(monkeypatch)
    loader = ph._loader
    since = NOW_EDGE - ph.LOOKBACK
    assert ph.servable(since) == (None, "not_ready")

    loader.snapshot = _full(NOW_EDGE)
    assert ph.servable(since) == (None, "not_ready")  # 스냅샷이 있어도 부기가 준비 전이면
    loader.ready, loader.last_ok_sync = True, clock.t
    assert ph.servable(since) == (loader.snapshot, "")
    clock.t += ph.SERVABLE_MAX_SYNC_AGE_S
    assert ph.servable(since) == (loader.snapshot, "")
    clock.t += 1
    assert ph.servable(since) == (None, "stale")
    loader.last_ok_sync = clock.t

    floor = ph.from_us(loader.snapshot.floor_us)
    assert ph.servable(floor) == (loader.snapshot, "")
    assert ph.servable(floor - timedelta(microseconds=1)) == (None, "coverage")

    bucket = NOW_EDGE - timedelta(hours=1)

    def lots(n):
        return [(f"lot:{k:02d}", 35.80 + k * 1e-3, 129.20, 50, 10) for k in range(n)]

    loader.snapshot = ph.merge(None, _parse([db_row(bucket, bucket + timedelta(seconds=30), lots(64))]),
                               now=NOW_EDGE)
    assert ph.servable(since) == (loader.snapshot, "")
    loader.snapshot = ph.merge(None, _parse([db_row(bucket, bucket + timedelta(seconds=30), lots(65))]),
                               now=NOW_EDGE)
    assert ph.servable(since) == (None, "columns")

    # 순수 읽기: 이벤트 루프가 없는 스레드에서도 되고, 루프 안에서 불러도 태스크를 만들지 않는다.
    result: dict = {}
    thread = threading.Thread(target=lambda: result.setdefault("r", ph.servable(since)))
    thread.start()
    thread.join()
    assert result["r"] == (None, "columns")

    async def inside():
        before = asyncio.all_tasks()
        ph.servable(since)
        return asyncio.all_tasks() == before

    assert asyncio.run(inside())
    assert loader_env.db.requests == [] and loader._tail_requested is False


# ── 감독 · shadow 탐침 연결 ──────────────────────────────────────────────────


def test_supervisor_survives_a_step_bug_and_ensure_running_restarts_a_dead_task(monkeypatch, loader_env):
    logs = loader_env.logs
    monkeypatch.setattr(ph, "_reference_ready", lambda: True)
    monkeypatch.setattr(ph, "LOOP_ERROR_PAUSE_S", 0.01)
    loader_env.db.rows = _rows_before(datetime.now(UTC), 6)
    real_step = ph._Loader._step
    calls = {"n": 0}

    async def flaky_step(self):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ValueError("bug in one iteration")
        await real_step(self)

    monkeypatch.setattr(ph._Loader, "_step", flaky_step)

    async def scenario():
        ph.start()
        try:
            await _wait_until(lambda: ph._loader.ready)
            assert logs.named("parking_history_loop_error")[0]["error_type"] == "ValueError"
            dead = ph._loader._task
            dead.cancel()
            await asyncio.gather(dead, return_exceptions=True)
            ph.ensure_running()
            assert ph._loader._task is not dead and not ph._loader._task.done()
            assert logs.named("parking_history_loop_error")[-1]["restarted"] is True
        finally:
            await ph.stop()

    asyncio.run(scenario())


def test_loop_never_spins_on_an_overdue_reconcile_or_a_past_deadline(monkeypatch, loader_env):
    """_step 이 쉬는 대조(동기화 실패 중)를 _sleep 이 깰 시각으로 세면 루프가 50ms 마다 헛돈다."""
    clock = _Clock(datetime(2026, 9, 20, 3, 0, tzinfo=UTC)).install(monkeypatch)
    loader_env.db.rows = _rows_before(clock.utcnow(), 6)

    async def scenario(loader):
        await loader._step()
        loader.failures = 1                          # 꼬리가 실패 중이고
        loader.next_sync_due = clock.t + 0.4         # 다음 재시도는 0.4초 뒤
        loader.next_reconcile_due = clock.t - 60     # 대조는 이미 밀렸다
        requests = len(loader_env.db.requests)
        started = time.monotonic()
        await loader._sleep()
        assert time.monotonic() - started >= 0.35, "밀린 대조 때문에 일찍 깼다"
        await loader._step()                         # 재시도 시각 전 — 할 일이 없다
        assert len(loader_env.db.requests) == requests

        loader.next_sync_due = clock.t - 10          # 이미 지난 시각이어도 잠드는 시간에 바닥이 있다
        started = time.monotonic()
        await loader._sleep()
        assert time.monotonic() - started >= ph.MIN_LOOP_SLEEP_S * 0.8

    _drive(monkeypatch, scenario)


@pytest.mark.parametrize("source", ["shadow", "matrix"])
def test_shadow_probe_runs_after_each_successful_tail_only_in_shadow(monkeypatch, loader_env, source):
    db = loader_env.db
    monkeypatch.setattr(settings, "AREA_DEMAND_SOURCE", source)
    now0 = datetime(2026, 9, 20, 3, 0, tzinfo=UTC)
    clock = _Clock(now0).install(monkeypatch)
    db.rows = _rows_before(now0, 12)
    calls: list[tuple[str, int]] = []

    def probe(snapshot):
        calls.append((threading.current_thread().name, snapshot.generation))
        raise RuntimeError("probe failed")  # 탐침 실패는 적재 상태와 무관하다

    ph.register_shadow_probe(probe)

    async def scenario(loader):
        await loader._step()  # 전량 적재 뒤에는 탐침하지 않는다
        assert calls == []
        for _ in range(3):
            clock.t = loader.next_sync_due
            await loader._step()
        db.fail = lambda request: True
        clock.t = loader.next_sync_due
        await loader._step()  # 실패한 꼬리 뒤에는 탐침하지 않는다
        return loader

    loader = _drive(monkeypatch, scenario)
    if source == "shadow":
        assert calls == [("nextspot-parking", loader.snapshot.generation)] * 3
        assert len(loader_env.logs.named("parking_history_shadow_probe_failed")) == 3
    else:
        assert calls == []
    assert loader.ready and loader.failures == 1


# ── T33(health 부분 — shadow 칸은 shadow 커밋에서) ──────────────────────────

_HEALTH_KEYS = {"mode", "ready", "rows", "lots", "generation", "last_sync_age_s", "failures", "last_error_type"}


def _assert_health_values(body: dict) -> None:
    for key, value in body.items():
        if key == "mode":
            assert value in ph.MODES
        elif key == "last_error_type":
            assert value is None or (isinstance(value, str) and len(value) <= 64)
        elif isinstance(value, dict):
            _assert_health_values(value)
        else:
            assert value is None or isinstance(value, (bool, int)), (key, value)


def test_health_block_fields_and_no_error_text(monkeypatch, loader_env):
    from fastapi.testclient import TestClient

    from app.main import app

    db = loader_env.db
    db.rows = _rows_before(datetime.now(UTC), 6)
    secret = "SECRET-xyz at 35.83612"
    db.fail = lambda request: True
    db.fail_message = secret

    async def scenario(loader):
        await loader._step()  # 부팅 적재 실패
        failing = ph.health()
        db.fail = None
        loader.next_sync_due = 0.0
        await loader._step()
        return failing

    failing = _drive(monkeypatch, scenario)
    assert set(failing) == _HEALTH_KEYS
    assert failing["ready"] is False and failing["rows"] == 0 and failing["lots"] == 0
    assert failing["generation"] is None and failing["last_sync_age_s"] is None
    assert failing["failures"] == 1 and failing["last_error_type"] == "RuntimeError"
    healthy = ph.health()
    assert set(healthy) == _HEALTH_KEYS
    assert healthy["mode"] == "shadow" and healthy["ready"] is True
    assert healthy["rows"] == 6 and healthy["lots"] == 2
    assert isinstance(healthy["generation"], int) and 0 <= healthy["last_sync_age_s"] <= 5
    assert healthy["failures"] == 0 and healthy["last_error_type"] == "RuntimeError"
    for body in (failing, healthy):
        _assert_health_values(body)
        text = json.dumps(body)
        assert "SECRET" not in text and "35.83612" not in text
    # 오류 원문은 (내부) 로그에만 남는다.
    assert any(secret in f["error"] for f in loader_env.logs.named("parking_history_sync_failed"))

    # 전망 서비스가 알려 오는 숫자는 정해진 세 칸만 싣는다.
    ph.register_health_extra(lambda: {
        "memo": {"series": 3, "near": 1, "quality": 3}, "fallback_served": 0,
        "shadow": {"compared": 2, "equal": 2}, "coords": [35.83612], "digest": "abc",
    })
    extra = ph.health()
    assert set(extra) == _HEALTH_KEYS | {"memo", "fallback_served", "shadow"}
    _assert_health_values(extra)

    def broken():
        raise RuntimeError(secret)

    ph.register_health_extra(broken)
    assert set(ph.health()) == _HEALTH_KEYS

    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert set(response.json()["parking_history"]) == _HEALTH_KEYS
    assert "SECRET" not in response.text and "35.83612" not in response.text

    monkeypatch.setattr(ph, "health", broken)
    response = client.get("/health")
    assert response.status_code == 200 and response.json()["status"] == "healthy"
    assert "parking_history" not in response.json()
