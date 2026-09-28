"""권역 수요 전망의 행렬 경로(app/services/area_demand_forecast_service.py 의 _aggregate_matrix · _PointsView · 메모).

스펙 §8 의 T19, T21-T24, T26 — 행렬 커널이 RPC 가 돌려줄 값(유효숫자 15자리)과 비트 단위로 같은지, 정확한 좌표마다
결정적인지, 메모가 상한·락·세대를 지키는지 잠근다. 아직 요청 경로에 연결하지 않은 순수 CPU 함수들이다.
"""

from __future__ import annotations

import random
import sys
import threading
import time
from array import array
from datetime import datetime, timedelta, timezone
from functools import lru_cache

import pytest

from app.services import area_demand_forecast_service as forecast_svc
from app.services import parking_history as ph
from app.services.area_demand_forecast_service import (
    _backtest_forecast_points_reference,
    aggregate_nearby_points,
    backtest_forecast_points,
)
from app.services.spot.travel import calculate_haversine_distance
from tests.services._parking_fixture import (
    LOTS,
    NOW_EDGE,
    _is_tie,
    _sql_payload_pg,
    db_row,
    fixture_56d,
    north_of,
)

UTC = timezone.utc
_CENTER = (35.8361, 129.2105)
_LOT_89 = LOTS[1]
# 스펙 §8 T19 의 좌표: 가운데, 두 번째 지점, 주차장 하나만 닿는 곳, 반경 경계(주차장 :89 까지 반올림 전 1999.93 m ·
# 2000.02 m · 2000.08 m — 반올림하면 1999.9 · 2000.0(안) · 2000.1(밖)), 먼 곳(반경 안 주차장 없음).
_COORDS = {
    "center": _CENTER,
    "second": (35.84317, 129.21871),
    "one_lot": (35.79, 129.13),
    "edge_1999_93": north_of(_LOT_89[1], _LOT_89[2], 1999.93),
    "edge_2000_02": north_of(_LOT_89[1], _LOT_89[2], 2000.02),
    "edge_2000_08": north_of(_LOT_89[1], _LOT_89[2], 2000.08),
    "far": (35.70, 129.0),
}
# 56일 경계가 고정 자료를 가르는 시각들(NOW_EDGE 는 bucket_at < since ≤ observed_at 인 행을 가른다).
_NOWS = (NOW_EDGE, NOW_EDGE + timedelta(days=2, hours=5, minutes=7, microseconds=3))


@pytest.fixture(autouse=True)
def _clean_memos():
    forecast_svc.reset_matrix_memos()
    forecast_svc.reset_points_cache()
    yield
    forecast_svc.reset_matrix_memos()
    forecast_svc.reset_points_cache()


@lru_cache(maxsize=8)
def _snapshot(now: datetime = NOW_EDGE) -> ph.HistorySnapshot:
    """적재 루프의 전량 적재와 같은 병합(merge(None, 전 행, now))으로 만든 행렬 — 고치지 말 것(공유)."""
    return ph.merge(None, ph.parse_page(fixture_56d().rows, aware=forecast_svc._aware), now=now)


def _since(now: datetime) -> datetime:
    return now - timedelta(days=forecast_svc._LOOKBACK_DAYS)


def _column_key(lot: dict) -> tuple[str, float, float]:
    return (str(lot["source_lot_id"]), float(lot["latitude"]), float(lot["longitude"]))


@lru_cache(maxsize=4)
def _reference_input(now: datetime) -> tuple[list[dict], list[dict]]:
    """RPC 와 같은 창(observed_at >= now − 56일)의 부모와, 열 순서로 늘어놓은 주차장 행."""
    since = _since(now)
    fixture = fixture_56d()
    parents = [p for p in fixture.parents if forecast_svc._aware(p["observed_at"]) >= since]
    return parents, sorted(fixture.lots, key=_column_key)  # 안정 정렬: 스냅샷 안에서는 열 순서


def _view(snapshot, latitude, longitude, now):
    start = ph.window_start(snapshot, _since(now))
    return forecast_svc._matrix_series(snapshot, latitude, longitude, start)


def _triples(points) -> list[tuple]:
    return [(p.observed_at, p.level, p.lot_count) for p in points]


def _assert_same_repr(got, expected, context=None, *, raw: bool = False) -> None:
    """repr 로 비교하되, 틀리면 첫 차이만 보여 준다(수천 점짜리 repr 을 pytest 가 통째로 diff 하면 몇 분이 걸린다)."""
    if raw:
        same = repr(got) == expected
        assert same, f"repr differs {context}"
        return
    same = len(got) == len(expected) and repr(got) == repr(expected)
    if same:
        return
    first = next((k for k, (a, b) in enumerate(zip(got, expected)) if repr(a) != repr(b)), min(len(got), len(expected)))
    detail = (f"len {len(got)} vs {len(expected)}; first difference at {first}: "
              f"{got[first] if first < len(got) else None!r} vs {expected[first] if first < len(expected) else None!r}")
    assert same, f"{context} {detail}"


def test_radius_edge_coordinates_are_what_the_test_claims():
    lat, lng = _LOT_89[1], _LOT_89[2]
    got = {name: calculate_haversine_distance(*_COORDS[name], lat, lng)
           for name in ("edge_1999_93", "edge_2000_02", "edge_2000_08")}
    assert got == {"edge_1999_93": 1999.9, "edge_2000_02": 2000.0, "edge_2000_08": 2000.1}
    for name, (a, b) in _COORDS.items():
        assert not _is_tie(a, b), name


# ── T19 ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("now", _NOWS)
@pytest.mark.parametrize("name", list(_COORDS))
def test_matrix_series_equals_quantized_python_reference(name, now):
    latitude, longitude = _COORDS[name]
    snapshot = _snapshot()
    parents, lots = _reference_input(now)
    view, _ = _view(snapshot, latitude, longitude, now)
    reference = aggregate_nearby_points(parents, lots, latitude, longitude)
    expected = [(p.observed_at, float("%.15g" % p.level), p.lot_count) for p in reference]
    _assert_same_repr(_triples(view), expected)
    if name in ("far", "edge_2000_08"):  # 반경 안 주차장 없음(2000.1 m 는 밖)
        assert len(view) == 0
    else:
        assert len(view) > 6_000
    if name == "center" and now == NOW_EDGE:
        # bucket_at < since ≤ observed_at 인 행은 들어간다(RPC 는 observed_at 으로 자른다).
        edge = forecast_svc._aware(fixture_56d().edge_row["observed_at"])
        assert view[0].observed_at == edge


def test_radius_edge_membership_follows_the_rounded_distance():
    snapshot = _snapshot()
    column_89 = [j for j, c in enumerate(snapshot.columns) if c.lot_id == _LOT_89[0]]
    start = ph.window_start(snapshot, _since(NOW_EDGE))
    near = {name: forecast_svc._aggregate_matrix(snapshot, *_COORDS[name], start)[0]
            for name in ("edge_1999_93", "edge_2000_02", "edge_2000_08")}
    assert near["edge_1999_93"] == near["edge_2000_02"] == tuple(column_89)
    assert near["edge_2000_08"] == ()


def test_levels_are_rendered_like_the_rpc_and_never_negative_zero():
    snapshot = _snapshot()
    for latitude, longitude in _COORDS.values():
        view, _ = _view(snapshot, latitude, longitude, NOW_EDGE)
        for point in view:
            assert 0.0 <= point.level <= 1.0
            assert float("%.15g" % point.level) == point.level
            assert str(point.level) != "-0.0"


# ── T21 ──────────────────────────────────────────────────────────────────────


def _random_coordinates(count: int, seed: int) -> list[tuple[float, float]]:
    rng = random.Random(seed)
    coordinates = []
    while len(coordinates) < count:
        candidate = (round(_CENTER[0] + rng.uniform(-0.02, 0.02), 6),
                     round(_CENTER[1] + rng.uniform(-0.025, 0.025), 6))
        if not _is_tie(*candidate):
            coordinates.append(candidate)
    return coordinates


@pytest.mark.parametrize("now", _NOWS)
def test_matrix_series_matches_pg_mirror(now):
    snapshot = _snapshot()
    parents, lots = _reference_input(now)
    coordinates = list(_COORDS.values()) + _random_coordinates(6, seed=21 + _NOWS.index(now))
    for latitude, longitude in coordinates:
        assert not _is_tie(latitude, longitude)
        view, _ = _view(snapshot, latitude, longitude, now)
        rpc_points = forecast_svc._points_from_payload(_sql_payload_pg(parents, lots, latitude, longitude))
        _assert_same_repr(_triples(view), _triples(rpc_points), (latitude, longitude))
        # isoformat 도 같다(응답 문자열이 된다).
        assert [p.observed_at.isoformat() for p in view] == [p.observed_at.isoformat() for p in rpc_points]


# ── T22 ──────────────────────────────────────────────────────────────────────


def test_isoformat_round_trip():
    """PostgREST 의 timestamptz 표기(µs 가 0 이면 소수부 없음)와 RPC 의 to_char(.US) 표기가 같은 isoformat 이 된다."""
    lot_id, lat, lng, total = LOTS[0]
    base = datetime(2026, 9, 20, 3, 0, tzinfo=UTC)
    observed = [
        base + timedelta(seconds=1),  # '…:01+00:00'
        base + timedelta(minutes=10, seconds=1),  # '…:01.000000+00:00' 로 보낸다
        base + timedelta(minutes=20, seconds=1, microseconds=120_000),
        base + timedelta(minutes=30, seconds=59, microseconds=999_999),
    ]
    rows = [db_row(base + timedelta(minutes=10 * k), at, [(lot_id, lat, lng, total, 10 + k)])
            for k, at in enumerate(observed)]
    rows[1]["observed_at"] = observed[1].strftime("%Y-%m-%dT%H:%M:%S.%f") + "+00:00"
    assert rows[0]["observed_at"].endswith(":01+00:00")
    assert rows[1]["observed_at"].endswith(":01.000000+00:00")
    now = base + timedelta(hours=1)
    snapshot = ph.merge(None, ph.parse_page(rows, aware=forecast_svc._aware), now=now)
    view, _ = _view(snapshot, lat, lng, now)

    for form in ("pg", "postgrest"):
        strings = [at.strftime("%Y-%m-%dT%H:%M:%S.%f") + "+00:00" if form == "pg" else at.isoformat()
                   for at in observed]
        rpc_points = forecast_svc._points_from_payload({"points": [[s, 0.5, 1] for s in strings]})
        assert [p.observed_at.isoformat() for p in view] == [p.observed_at.isoformat() for p in rpc_points]
    assert view[0].observed_at.isoformat() == "2026-09-20T03:00:01+00:00"
    assert view[0].observed_at.tzinfo is timezone.utc


# ── T23 ──────────────────────────────────────────────────────────────────────

_A = (35.8361, 129.2105)
_B = (35.83649, 129.21049)
_T23_NOW = datetime(2026, 9, 28, 0, 20, 11, 5, tzinfo=UTC)  # 마지막 버킷 직후 — 최근 추세 보정도 돈다
_T23_ARRIVAL = _T23_NOW + timedelta(minutes=90)


def _results(snapshot, coordinate):
    latitude, longitude = coordinate
    view, entry = _view(snapshot, latitude, longitude, _T23_NOW)
    raw = forecast_svc._forecast_from_points(view, _T23_ARRIVAL, _T23_NOW, entry.index)
    return (
        repr(_triples(view)),
        repr(raw),
        repr(forecast_svc._matrix_forecast(snapshot, latitude, longitude, _T23_ARRIVAL, _T23_NOW)),
        repr(forecast_svc._matrix_quality(snapshot, latitude, longitude, _T23_NOW)),
    )


def test_matrix_is_deterministic_per_exact_coordinate():
    assert forecast_svc._grid_key(*_A) == forecast_svc._grid_key(*_B)  # 오늘의 경로는 둘을 한 격자로 묶는다
    snapshot = _snapshot(_T23_NOW)

    a_then_b = (_results(snapshot, _A), _results(snapshot, _B))
    forecast_svc.reset_matrix_memos()
    b_then_a = (_results(snapshot, _B), _results(snapshot, _A))
    forecast_svc.reset_matrix_memos()
    fresh_b = _results(snapshot, _B)

    assert a_then_b[0] == b_then_a[1]
    assert a_then_b[1] == b_then_a[0] == fresh_b
    assert a_then_b[0][0] != a_then_b[1][0], "B 의 시계열이 A 의 것과 같다 — 격자 공유가 남아 있다"
    assert a_then_b[1][1] != "None", "전망이 없으면 비교가 무의미하다"
    # 같은 반경 안 열 조합이면 시각 쪽 몫(남는 행·색인)은 한 벌을 나눠 쓴다.
    start = ph.window_start(snapshot, _since(_T23_NOW))
    view_a, entry_a = forecast_svc._matrix_series(snapshot, *_A, start)
    view_b, entry_b = forecast_svc._matrix_series(snapshot, *_B, start)
    assert entry_a is entry_b
    # 메모에서 다시 받아도 값은 같다.
    _assert_same_repr(_triples(forecast_svc._matrix_series(snapshot, *_B, start)[0]), fresh_b[0], raw=True)


def test_matrix_forecast_mirrors_the_rpc_path_on_the_same_points():
    """_matrix_forecast · _matrix_quality 는 RPC 경로 본체와 같은 계산이다 — 같은 점을 RPC 경로의 함수에 넣어 대조."""
    snapshot = _snapshot(_T23_NOW)
    parents, lots = _reference_input(_T23_NOW)
    for latitude, longitude in (_A, _B, _COORDS["one_lot"], _COORDS["far"]):
        reference = [
            forecast_svc.AreaDemandPoint(p.observed_at, float("%.15g" % p.level), p.lot_count)
            for p in aggregate_nearby_points(parents, lots, latitude, longitude)
        ]
        forecast = forecast_svc.forecast_from_points(reference, _T23_ARRIVAL, now=_T23_NOW)
        quality = backtest_forecast_points(reference)
        expected = None
        if forecast is not None and (
            quality["sample_count"] >= 30 and quality["mae"] is not None and quality["mae"] <= 0.15
            and quality["improvement_rate"] is not None and quality["improvement_rate"] >= 0.20
        ):
            expected = {**forecast, "validation": quality}
        got = forecast_svc._matrix_forecast(snapshot, latitude, longitude, _T23_ARRIVAL, _T23_NOW)
        assert repr(got) == repr(expected)
        got_quality = forecast_svc._matrix_quality(snapshot, latitude, longitude, _T23_NOW)
        assert {k: got_quality[k] for k in quality} == quality
        assert got_quality["point_count"] == len(reference)
        if reference:
            assert got_quality["data_from"] == reference[0].observed_at.isoformat()
            assert got_quality["data_to"] == reference[-1].observed_at.isoformat()
        else:
            assert got_quality["data_from"] is None and got_quality["usable"] is False


def test_points_view_behaves_like_the_list():
    snapshot = _snapshot()
    view, _ = _view(snapshot, *_CENTER, NOW_EDGE)
    as_list = list(view)
    assert len(view) == len(as_list)
    assert view[-1] == as_list[-1] and view[0] == as_list[0]
    assert view[10:20] == as_list[10:20] and view[-9:] == as_list[-9:]
    assert view[::500] == as_list[::500]
    with pytest.raises(IndexError):
        view[len(view)]
    assert not hasattr(view, "__dict__")


# ── T24 ──────────────────────────────────────────────────────────────────────


def _line_snapshot(now: datetime) -> ph.HistorySnapshot:
    """주차장 12곳을 동서로 1km 간격으로 늘어놓은 작은 행렬(30행) — 반경 안 열 조합이 여러 가지 나온다."""
    lots = [(f"line:{k}", 35.8, 129.0 + 0.011 * k, 100 + k) for k in range(12)]
    rows = []
    for i in range(30):
        bucket = now - timedelta(hours=5) + timedelta(minutes=10 * i)
        rows.append(db_row(bucket, bucket + timedelta(seconds=30 + i),
                           [(lot_id, lat, lng, total, (i * 7 + k) % total)
                            for k, (lot_id, lat, lng, total) in enumerate(lots)]))
    return ph.merge(None, ph.parse_page(rows, aware=forecast_svc._aware), now=now)


def test_memos_bounded_locked_and_generation_scoped():
    now = datetime(2026, 9, 20, 12, 0, tzinfo=UTC)
    snapshot = _line_snapshot(now)
    rng = random.Random(24)
    near_sets = set()
    for _ in range(600):
        latitude = 35.8 + rng.uniform(-0.01, 0.01)
        longitude = 129.0 + rng.uniform(-0.01, 0.13)
        start = rng.randrange(3)
        view, entry = forecast_svc._matrix_series(snapshot, latitude, longitude, start)
        near_sets.add((forecast_svc._aggregate_matrix(snapshot, latitude, longitude, start)[0], start))
        forecast_svc._matrix_quality_for(snapshot, latitude, longitude, start, view, entry)
    assert len(near_sets) > forecast_svc._NEAR_MEMO_MAX
    assert len(forecast_svc._NEAR_MEMO.entries) == forecast_svc._NEAR_MEMO_MAX == 8
    assert len(forecast_svc._SERIES_MEMO.entries) == forecast_svc._SERIES_MEMO_MAX == 128
    assert len(forecast_svc._MQUALITY.entries) == forecast_svc._MQUALITY_MAX == 512
    assert not any(memo.inflight for memo in forecast_svc._MEMOS)

    # 8 스레드가 읽기·넣기·single-flight·세대 올리기를 한꺼번에 — 예외 없이, 상한을 지키고, 진행 중 표가 남지 않는다.
    errors: list[str] = []
    base = forecast_svc._memo_generation

    def _worker(tid: int) -> None:
        local = random.Random(tid)
        for i in range(400):
            generation = base + i // 40 + local.randrange(2)
            key = (local.randrange(40), generation)
            memo = local.choice(forecast_svc._MEMOS)
            try:
                op = local.randrange(3)
                if op == 0:
                    forecast_svc._memo_get(memo, key, generation)
                elif op == 1:
                    forecast_svc._memo_put(memo, key, generation, ("v", key))
                else:
                    assert forecast_svc._mflight(memo, key, generation, lambda k=key: ("v", k)) == ("v", key)
            except Exception as exc:  # noqa: BLE001 — 예외 자체가 검사 대상이다
                errors.append(repr(exc))

    previous = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        threads = [threading.Thread(target=_worker, args=(tid,)) for tid in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    finally:
        sys.setswitchinterval(previous)
    assert not errors, errors[:3]
    for memo in forecast_svc._MEMOS:
        assert len(memo.entries) <= memo.cap
        assert not memo.inflight

    # 옛 세대의 넣기는 버린다. 더 새 세대를 보면 셋 다 비운다.
    forecast_svc.reset_matrix_memos()
    forecast_svc._memo_put(forecast_svc._SERIES_MEMO, "k5", 5, "five")
    assert forecast_svc._memo_get(forecast_svc._SERIES_MEMO, "k5", 5) == "five"
    forecast_svc._memo_put(forecast_svc._SERIES_MEMO, "k4", 4, "four")
    forecast_svc._memo_put(forecast_svc._MQUALITY, "q4", 4, "four")
    assert "k4" not in forecast_svc._SERIES_MEMO.entries and not forecast_svc._MQUALITY.entries
    assert forecast_svc._memo_get(forecast_svc._SERIES_MEMO, "k4", 4) is None
    computed: list[int] = []
    assert forecast_svc._mflight(forecast_svc._MQUALITY, "q4", 4, lambda: computed.append(1) or "q") == "q"
    assert computed == [1] and not forecast_svc._MQUALITY.entries  # 옛 세대: 계산만 하고 나눠 갖지 않는다
    assert forecast_svc._memo_get(forecast_svc._NEAR_MEMO, "n6", 6) is None
    assert forecast_svc._memo_generation == 6 and not forecast_svc._SERIES_MEMO.entries


def test_new_generation_snapshot_never_serves_older_memo_content():
    now = datetime(2026, 9, 20, 12, 0, tzinfo=UTC)
    old = _line_snapshot(now)
    new = _line_snapshot(now)  # 같은 내용이어도 세대가 다르다
    assert new.generation > old.generation
    view_old, entry_old = forecast_svc._matrix_series(old, 35.8, 129.05, 0)
    view_new, entry_new = forecast_svc._matrix_series(new, 35.8, 129.05, 0)
    assert entry_new is not entry_old
    assert forecast_svc._memo_generation == new.generation
    # 옛 세대로 다시 읽으면 계산은 하되(같은 값) 메모에는 넣지 않는다.
    again_old, entry_again = forecast_svc._matrix_series(old, 35.8, 129.05, 0)
    assert entry_again is not entry_old and list(again_old) == list(view_old)
    assert all(key[1] == new.generation for key in forecast_svc._NEAR_MEMO.entries)


def test_non_finite_coordinates_bypass_the_memos():
    snapshot = _snapshot()
    start = ph.window_start(snapshot, _since(NOW_EDGE))
    view, entry = forecast_svc._matrix_series(snapshot, float("nan"), 129.2105, start)
    assert len(view) == 0
    assert not forecast_svc._SERIES_MEMO.entries and not forecast_svc._NEAR_MEMO.entries


# ── T26 ──────────────────────────────────────────────────────────────────────


def test_matrix_view_backtest_matches_reference():
    """행렬 뷰로 돈 백테스트 == RPC 가 돌려줄 점(유효숫자 15자리)으로 돈 백테스트. 가운데는 예전 구현(정의)으로도."""
    snapshot = _snapshot()
    parents, lots = _reference_input(NOW_EDGE)
    for name in ("center", "second", "one_lot"):
        latitude, longitude = _COORDS[name]
        view, entry = _view(snapshot, latitude, longitude, NOW_EDGE)
        reference = [
            forecast_svc.AreaDemandPoint(p.observed_at, float("%.15g" % p.level), p.lot_count)
            for p in aggregate_nearby_points(parents, lots, latitude, longitude)
        ]
        got = forecast_svc._matrix_quality_compute(view, entry)
        assert repr(got) == repr(backtest_forecast_points(reference))
        if name == "center":
            assert got["sample_count"] > 300
            # 예전 구현은 O(평가점 × 시계열)이라 한 좌표(~5초)만 돈다 — 빠른 경로와 같다는 것은 기존 시험이 잠근다.
            assert repr(got) == repr(_backtest_forecast_points_reference(reference))


def test_kernel_output_arrays_are_compact():
    snapshot = _snapshot()
    start = ph.window_start(snapshot, _since(NOW_EDGE))
    near, keep, levels, counts = forecast_svc._aggregate_matrix(snapshot, *_CENTER, start)
    assert isinstance(keep, array) and keep.typecode == "I"
    assert levels.typecode == "d" and counts.typecode == "H"
    assert len(keep) == len(levels) == len(counts)
    assert list(keep) == sorted(keep) and keep[0] >= start


# ── T20 · T25 — 반경 안 열 조합마다 한 벌인 백테스트 계획 ────────────────────────────────


def _plan_backtest(points) -> dict:
    """점 리스트에 대해 계획을 새로 짓고 그 위에서 백테스트 — 운영 경로와 같은 두 함수."""
    plan = forecast_svc._build_backtest_plan([p.observed_at for p in points])
    assert plan is not None
    return forecast_svc._backtest_with_plan(plan, array("d", (p.level for p in points)))


def _freshness_series(gap: timedelta, seed: int) -> tuple[list, int]:
    """10분 간격 20일 시계열에서, 한 평가점 바로 앞의 관측이 정확히 ``gap`` 전이 되게 고친 것과 그 평가점 번호."""
    rng = random.Random(seed)
    base = datetime(2026, 8, 1, 0, 3, 17, 250_000, tzinfo=UTC)
    times = [base + timedelta(minutes=10 * k) for k in range(20 * 144)]
    # 평가점은 '마지막 − 28일' 이후 첫 점부터 2시간 간격 — 그 가운데 하나를 고른다.
    eval_cutoff = times[-1] - timedelta(days=28)
    first = next(k for k, t in enumerate(times) if t >= eval_cutoff)
    target = times[first] + timedelta(hours=2 * 120)
    kept = [t for t in times if not (target - gap <= t < target)]
    kept.append(target - gap)
    kept.sort()
    levels = [float("%.15g" % rng.choice([rng.random(), round(rng.random(), 2)])) for _ in kept]
    points = [forecast_svc.AreaDemandPoint(t, v, 2) for t, v in zip(kept, levels)]
    return points, kept.index(target)


def test_plan_backtest_bit_exact():
    snapshot = _snapshot(_T23_NOW)
    # (1) 다섯 좌표의 전체 시계열: 계획 == backtest_forecast_points. 예전 구현(정의)은 비용(좌표당 ~5초) 때문에 끝 1,500점
    #     창에서 대조한다(전체 길이의 가운데 좌표는 T26 이 예전 구현과 대조한다).
    for name in ("center", "second", "one_lot", "edge_1999_93"):
        view, entry = _view(snapshot, *_COORDS[name], _T23_NOW)
        points = list(view)
        fast = backtest_forecast_points(points)
        assert fast["sample_count"] > 0
        assert repr(forecast_svc._backtest_with_plan(entry.plan, view._levels)) == repr(fast), name
        assert repr(forecast_svc._matrix_quality_compute(view, entry)) == repr(fast), name
        tail = points[-1_500:]
        assert repr(_plan_backtest(tail)) == repr(backtest_forecast_points(tail)) == repr(
            _backtest_forecast_points_reference(tail)), name
    view_b, entry_b = _view(snapshot, *_B, _T23_NOW)
    assert repr(forecast_svc._matrix_quality_compute(view_b, entry_b)) == repr(backtest_forecast_points(list(view_b)))

    # (2) 무작위로 자른 30개 — 앞부분·가운데 창·성긴 표본. 표본 0개(sample_count == 0)인 경우도 나온다.
    center_points = list(_view(snapshot, *_CENTER, _T23_NOW)[0])
    rng = random.Random(20)
    saw_empty = saw_nonempty = False
    for k in range(30):
        kind = k % 3
        if kind == 0:
            chosen = center_points[: rng.randrange(0, 1_500)]
        elif kind == 1:
            begin = rng.randrange(0, len(center_points) - 1_200)
            chosen = center_points[begin: begin + rng.randrange(1, 1_200)]
        else:
            chosen = center_points[rng.randrange(0, 40)::rng.randrange(8, 60)]
        expected = backtest_forecast_points(chosen)
        assert repr(_plan_backtest(chosen)) == repr(expected) == repr(_backtest_forecast_points_reference(chosen)), k
        saw_empty |= expected["sample_count"] == 0
        saw_nonempty |= expected["sample_count"] > 0
    assert saw_empty and saw_nonempty

    # (3) 평가점의 최근 추세 신선도가 정확히 45분(포함)과 45분 + 1µs(제외)인 경계.
    for gap in (timedelta(minutes=45), timedelta(minutes=45, microseconds=1)):
        points, target = _freshness_series(gap, seed=gap.microseconds)
        plan = forecast_svc._build_backtest_plan([p.observed_at for p in points])
        evaluated = {index: trend_end for index, _, trend_end, _ in plan.evals}
        assert target in evaluated
        assert (evaluated[target] >= 0) is (gap == timedelta(minutes=45))
        assert repr(_plan_backtest(points)) == repr(backtest_forecast_points(points)) == repr(
            _backtest_forecast_points_reference(points))


def test_plan_refuses_non_fixed_offset_timestamps_and_quality_falls_back():
    from datetime import tzinfo

    class _Seoul(tzinfo):  # timezone 이 아닌 tzinfo(zoneinfo 처럼) — 계획은 전제를 세울 수 없다
        def utcoffset(self, dt):
            return timedelta(hours=9)

        def dst(self, dt):
            return timedelta(0)

    seoul = _Seoul()
    points = [forecast_svc.AreaDemandPoint(datetime(2026, 8, 1, tzinfo=seoul) + timedelta(minutes=10 * k), 0.5, 1)
              for k in range(20)]
    assert forecast_svc._build_backtest_plan([p.observed_at for p in points]) is None

    snapshot = _snapshot()
    view, entry = _view(snapshot, *_CENTER, NOW_EDGE)
    no_plan = forecast_svc._NearEntry(entry.keep, entry.counts, entry.index, None)
    assert repr(forecast_svc._matrix_quality_compute(view, no_plan)) == repr(
        forecast_svc._matrix_quality_compute(view, entry))


def test_matrix_quality_single_flight(monkeypatch):
    """같은 좌표의 품질을 8 스레드가 동시에 빗나가도 계획은 한 번 짓고, 계획 백테스트도 한 번만 돈다(:185-224 와 같은 모양)."""
    snapshot = _snapshot(_T23_NOW)
    real_build = forecast_svc._build_backtest_plan
    real_backtest = forecast_svc._backtest_with_plan
    builds: list[int] = []
    backtests: list[int] = []
    started = threading.Event()
    release = threading.Event()

    def _counting_build(observed):
        builds.append(1)
        return real_build(observed)

    def _slow_backtest(plan, levels):
        backtests.append(1)
        started.set()
        assert release.wait(10)
        return real_backtest(plan, levels)

    monkeypatch.setattr(forecast_svc, "_build_backtest_plan", _counting_build)
    monkeypatch.setattr(forecast_svc, "_backtest_with_plan", _slow_backtest)
    results: list = [None] * 8

    def _run(slot: int) -> None:
        results[slot] = forecast_svc._matrix_quality(snapshot, *_CENTER, _T23_NOW)

    first = threading.Thread(target=_run, args=(0,))
    first.start()
    assert started.wait(30)
    others = [threading.Thread(target=_run, args=(i,)) for i in range(1, 8)]
    for thread in others:
        thread.start()
    time.sleep(0.3)
    release.set()
    for thread in [first, *others]:
        thread.join(30)

    assert len(builds) == 1, f"계획을 {len(builds)}번 지었다"
    assert len(backtests) == 1, f"계획 백테스트가 {len(backtests)}번 돌았다"
    assert all(result == results[0] for result in results)
    assert not any(memo.inflight for memo in forecast_svc._MEMOS)
    view, _ = _view(snapshot, *_CENTER, _T23_NOW)
    expected = backtest_forecast_points(list(view))
    assert {k: results[0][k] for k in expected} == expected


def test_failed_plan_backtest_is_not_shared_and_the_next_caller_recomputes(monkeypatch):
    snapshot = _snapshot(_T23_NOW)
    real = forecast_svc._backtest_with_plan

    def _boom(plan, levels):
        raise RuntimeError("boom")

    monkeypatch.setattr(forecast_svc, "_backtest_with_plan", _boom)
    with pytest.raises(RuntimeError):
        forecast_svc._matrix_quality(snapshot, *_CENTER, _T23_NOW)
    assert not forecast_svc._MQUALITY.entries and not forecast_svc._MQUALITY.inflight

    monkeypatch.setattr(forecast_svc, "_backtest_with_plan", real)
    quality = forecast_svc._matrix_quality(snapshot, *_CENTER, _T23_NOW)
    view, _ = _view(snapshot, *_CENTER, _T23_NOW)
    assert {k: quality[k] for k in ("sample_count", "mae", "baseline_mae", "improvement_rate")} == \
        backtest_forecast_points(list(view))


# ── 수리: 계획의 '서로 다른 날짜 수' 는 KST 로 센다 — 날짜 경계(09:00 KST = UTC 자정, 00:00 KST)를 건너는 성긴 시계열 ──────


def _date_boundary_series(first_minute: int) -> list:
    """같은 시각대 표본이 한 KST 날짜 경계를 걸치게 day 0 · day 7 에만 4개씩(first_minute 부터 10분 간격, KST 기준),
    다른 시각대(20:00 KST) 채움 15일, day 14 의 평가 대상 한 점."""
    kst = timedelta(hours=9)
    base = datetime(2026, 8, 3, tzinfo=UTC) - kst  # 2026-08-03 00:00 KST(월)
    times = []
    for day in (0, 7):
        for step in range(4):
            times.append(base + timedelta(days=day, minutes=first_minute + 10 * step))
    for day in range(15):
        times.append(base + timedelta(days=day, hours=20))
    times.append(base + timedelta(days=14, minutes=first_minute + 20))
    times = sorted(set(times))
    levels = [0.3 + 0.01 * (k % 7) for k in range(len(times))]
    return [forecast_svc.AreaDemandPoint(t, v, 1) for t, v in zip(times, levels)]


@pytest.mark.parametrize("first_minute", [8 * 60 + 40, 23 * 60 + 40])  # 08:40~09:10 KST(UTC 자정) · 23:40~00:10 KST
def test_plan_counts_distinct_dates_in_kst_across_date_boundaries(first_minute):
    import inspect

    points = _date_boundary_series(first_minute)
    expected = backtest_forecast_points(points)
    assert repr(_plan_backtest(points)) == repr(expected) == repr(_backtest_forecast_points_reference(points))
    assert expected["sample_count"] > 0

    if first_minute == 8 * 60 + 40:
        # 이 시계열은 날짜를 UTC 로 세는 계획(변이 M05)을 가른다 — 표본 2개 KST 날짜가 UTC 로는 4개라 문턱(3)을 넘는다.
        source = inspect.getsource(forecast_svc._build_backtest_plan)
        mutated = source.replace("value.astimezone(KST).date()", "value.date()")
        assert mutated != source, "계획의 KST 날짜 계산 줄이 바뀌었다 — 이 변이 대조를 새 코드에 맞출 것"
        namespace = dict(vars(forecast_svc))
        exec(mutated, namespace)  # noqa: S102 — 시험 안에서 변이 하나를 만들어 이 시계열이 가르는지 본다
        utc_plan = namespace["_build_backtest_plan"]([p.observed_at for p in points])
        utc_result = forecast_svc._backtest_with_plan(utc_plan, array("d", (p.level for p in points)))
        assert repr(utc_result) != repr(expected)
