"""AREA_DEMAND_SOURCE=shadow — 답은 RPC 경로 그대로, 행렬과의 차이만 센다(스펙 §3.4(f) · §5.3 · §7.2 · §7.3).

스펙 §8 의 T34-T40 과 T33 의 shadow 칸. 대역 RPC(_SinceRpcClient)는 운영 RPC 처럼 p_since 로 거른 뒤 PG 대조본으로 답하고,
저장소는 적재 루프와 같은 병합으로 만든 스냅샷이다(_serve_from — 루프 없이 '준비됨').
"""

from __future__ import annotations

import asyncio
import json
import math
import random
import threading
import time
from datetime import timedelta

import pytest

from app.services import area_demand_forecast_service as forecast_svc
from app.services import parking_history as ph
from app.services.spot.travel import calculate_haversine_distance
from tests.services._parking_fixture import LOTS, _is_tie, _SinceRpcClient, patterned_fixture
from tests.services.test_area_demand_forecast_service import (
    _P2_CENTER,
    _P2_FAR,
    _P2_NOW,
    _P2_SECOND,
    _expected_since,
    _patterned_snapshot,
    _RecordingLogger,
    _serve_from,
    _since_rpc_client,
    _use_source,
)
from tests.services.test_parking_history import _HEALTH_KEYS, _assert_health_values

# 스펙 §7.3 의 shadow 칸 — 이 이름들만, 정수만.
_SPEC_SHADOW_KEYS = {
    "compared", "equal", "ulp", "edge", "rows", "value", "forecast_compared", "forecast_mismatch", "repr_only",
    "served_grid_quality_differs", "probes", "probe_failed", "distinct_facility_coords",
}
_ARRIVAL = _P2_NOW + timedelta(minutes=90)
_B_SAME_GRID = (35.83649, 129.21049)  # _P2_CENTER 와 같은 격자(round 3자리), 품질은 4째 자리에서 다르다


def _reset_all() -> None:
    forecast_svc.reset_points_cache()
    forecast_svc._quality_cache.clear()
    forecast_svc._rpc_missing_until = 0.0
    forecast_svc._raw_cache = None
    forecast_svc.reset_matrix_memos()
    forecast_svc.reset_source_dispatch()
    ph.reset_for_tests()


@pytest.fixture
def shadow_env(monkeypatch):
    """shadow 모드 + 기록 로거. 격자·품질 캐시, 행렬 메모, 분기·shadow 상태, 적재 상태를 앞뒤로 비운다."""
    logs = _RecordingLogger()
    monkeypatch.setattr(forecast_svc, "logger", logs)
    _use_source(monkeypatch, "shadow")
    _reset_all()
    yield logs
    _reset_all()


async def _drain() -> None:
    """띄운 요청 비교 태스크가 모두 끝날 때까지."""
    while forecast_svc._shadow_tasks:
        await asyncio.gather(*list(forecast_svc._shadow_tasks), return_exceptions=True)


def _total() -> dict:
    return forecast_svc._shadow_total.as_log()


def _assert_consistent(counts: dict) -> None:
    assert counts["compared"] == sum(counts[k] for k in ("equal", "ulp", "edge", "rows", "value"))
    assert counts["forecast_mismatch"] + counts["repr_only"] <= counts["forecast_compared"]


def _grid_forget(*coordinates) -> None:
    """이 좌표들의 격자 캐시 항목을 지운다 — 다음 호출이 직접 RPC 로 받게(fetched_here)."""
    for latitude, longitude in coordinates:
        key = forecast_svc._grid_key(latitude, longitude)
        forecast_svc._points_cache.pop(key, None)
        forecast_svc._series_indexes.pop(key, None)


def _center_view(snapshot):
    start = forecast_svc._matrix_window_start(snapshot, _P2_NOW)
    view, _ = forecast_svc._matrix_series(snapshot, *_P2_CENTER, start)
    return view


def _parent_at(parents, observed_at):
    return next(p for p in parents if forecast_svc._aware(p["observed_at"]) == observed_at)


async def _rpc_mode_value(monkeypatch, client, latitude, longitude, arrival=_ARRIVAL, now=_P2_NOW):
    """같은 대역 RPC 로 rpc 모드가 돌려주는 값(그 뒤 캐시를 비우고 shadow 로 되돌린다)."""
    _use_source(monkeypatch, "rpc")
    value = await forecast_svc.get_historical_area_demand_forecast(latitude, longitude, arrival, now=now)
    forecast_svc.reset_points_cache()
    forecast_svc._quality_cache.clear()
    _use_source(monkeypatch, "shadow")
    return value


# ── T34 ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_shadow_serves_rpc_and_logs_bounded_diffs(monkeypatch, shadow_env):
    logs = shadow_env
    fixture = patterned_fixture()
    snapshot = _patterned_snapshot()
    view = _center_view(snapshot)
    dropped = _parent_at(fixture.parents, view[len(view) // 2].observed_at)  # 안쪽 행 — 중심 반경 안에 점이 있다
    client = _SinceRpcClient([p for p in fixture.parents if p is not dropped], fixture.lots)
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    expected = await _rpc_mode_value(monkeypatch, client, *_P2_CENTER)
    assert expected is not None

    _serve_from(snapshot)
    served = await forecast_svc.get_historical_area_demand_forecast(*_P2_CENTER, _ARRIVAL, now=_P2_NOW)
    await _drain()
    assert repr(served) == repr(expected)  # 손님 값은 rpc 모드와 같다
    assert client.calls[-1]["p_since"] == _expected_since(_P2_NOW)
    first = _total()
    assert first["compared"] == 1 and first["rows"] == 1 and first["forecast_compared"] == 0
    [diff] = logs.named("area_demand_shadow_diff")
    assert diff["kind"] == "rows" and diff["origin"] == "request" and diff["gen_changed"] is False
    assert diff["rpc_rows"] == len(view) - 1 and diff["matrix_rows"] == len(view) and diff["trailing"] == 0
    assert diff["lat3"] == round(_P2_CENTER[0], 3) and diff["generation"] == snapshot.generation
    assert diff["first_diff_at"] is not None

    for _ in range(20):
        _grid_forget(_P2_CENTER)
        again = await forecast_svc.get_historical_area_demand_forecast(*_P2_CENTER, _ARRIVAL, now=_P2_NOW)
        await _drain()
        assert repr(again) == repr(expected)
    counts = _total()
    assert len(logs.named("area_demand_shadow_diff")) == forecast_svc._SHADOW_DIFF_BUDGET == 5
    assert counts["compared"] == counts["rows"] == forecast_svc._SHADOW_REQUEST_BUDGET == 10
    assert counts["skipped_budget"] == 21 - 10 and counts["skipped_busy"] == 0
    assert counts["equal"] == counts["value"] == counts["edge"] == 0 and counts["failed"] == 0
    _assert_consistent(counts)
    assert len(client.calls) == 1 + 21  # rpc 모드 1 + shadow 21(비교 여부와 무관하게 RPC 경로 그대로)


# ── T35 ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_shadow_reference_ignores_grid_quality_cache(monkeypatch, shadow_env):
    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    snapshot = _patterned_snapshot()
    _serve_from(snapshot)
    assert forecast_svc._grid_key(*_P2_CENTER) == forecast_svc._grid_key(*_B_SAME_GRID)

    served_a = await forecast_svc.get_historical_area_demand_forecast(*_P2_CENTER, _ARRIVAL, now=_P2_NOW)
    await _drain()
    # A 의 시계열 TTL(5분)만 지났다 — B 는 새로 받지만, 품질은 아직 유효한(30분) A 의 격자 품질 캐시가 준다.
    key = forecast_svc._grid_key(*_P2_CENTER)
    at, points = forecast_svc._points_cache[key]
    forecast_svc._points_cache[key] = (at - forecast_svc._POINTS_CACHE_TTL_SECONDS - 1, points)
    served_b = await forecast_svc.get_historical_area_demand_forecast(*_B_SAME_GRID, _ARRIVAL, now=_P2_NOW)
    await _drain()

    assert served_a is not None and served_b is not None
    assert len(client.calls) == 2 and (client.calls[-1]["p_latitude"], client.calls[-1]["p_longitude"]) == _B_SAME_GRID
    assert served_b["validation"] is served_a["validation"]  # 오늘의 경로: B 가 A 의 품질을 받았다(crit7)
    true_b = forecast_svc._matrix_quality(snapshot, *_B_SAME_GRID, _P2_NOW)
    assert true_b["improvement_rate"] != served_a["validation"]["improvement_rate"]
    counts = _total()
    assert counts["compared"] == counts["equal"] == 2 and counts["forecast_compared"] == 2
    assert counts["forecast_mismatch"] == 0  # 행렬은 B 자신의 기준과 같다 — 결함이 아니다
    assert counts["served_grid_quality_differs"] == 1  # A 는 자기 품질을 받았고, B 만 다르다
    assert not shadow_env.named("area_demand_shadow_diff")


# ── T36 ──────────────────────────────────────────────────────────────────────


def _add_parent(client: _SinceRpcClient, parent: dict, lots: list[dict]) -> None:
    client.parents = client.parents + (parent,)
    client.lots = sorted(
        list(client.lots) + lots,
        key=lambda lot: (str(lot["source_lot_id"]), float(lot["latitude"]), float(lot["longitude"])),
    )


def _center_lots(snapshot_id: str) -> list[dict]:
    return [
        {"snapshot_id": snapshot_id, "source_lot_id": lot_id, "latitude": lat, "longitude": lng,
         "total_spaces": total, "available_spaces": total // 3}
        for lot_id, lat, lng, total in LOTS[:2]
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["late_bucket", "retry", "merge_during_fetch"])
async def test_shadow_trailing_edge_race_is_edge_not_rows(monkeypatch, shadow_env, case):
    fixture = patterned_fixture()
    full = _patterned_snapshot()
    view = _center_view(full)
    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    store = full
    expected_changed = False

    if case == "late_bucket":
        # (a) g0 를 잡은 뒤, RPC 가 답하기 전에 새 버킷이 DB 에 들어온다(저장소는 아직 모른다).
        late = view[-1].observed_at + timedelta(minutes=4, seconds=7, microseconds=123_456)
        assert late < _P2_NOW
        new_parent = {"id": "late", "observed_at": late.isoformat(), "bucket_at": "2026-09-28T00:00:00+00:00"}
        client.before_execute = lambda _params: _add_parent(client, new_parent, _center_lots("late"))
    elif case == "retry":
        # (b) 최신 버킷을 :06 재시도가 더 늦은 관측·다른 값으로 통째로 바꿨다(저장소는 옛 판).
        newest = _parent_at(fixture.parents, view[-1].observed_at)
        retried = {**newest, "observed_at": (view[-1].observed_at + timedelta(seconds=63)).isoformat()}
        client.parents = tuple(retried if p is newest else p for p in client.parents)
        client.lots = [
            {**lot, "available_spaces": 0} if lot["snapshot_id"] == newest["id"] and "total_spaces" in lot else lot
            for lot in client.lots
        ]
    else:
        # (c) 저장소에 안쪽 버킷 하나가 비어 있었고(배포 겹침), RPC 가 읽는 동안 꼬리 병합이 그 구멍을 채웠다(세대 바뀜).
        hole = view[len(view) // 3].observed_at
        rows = [row for row in fixture.rows if forecast_svc._aware(row["observed_at"]) != hole]
        store = ph.merge(None, ph.parse_page(rows, aware=forecast_svc._aware), now=_P2_NOW)

        def _merge_lands(_params):
            ph._loader.snapshot = ph.merge(
                None, ph.parse_page(fixture.rows, aware=forecast_svc._aware), now=_P2_NOW,
            )

        client.before_execute = _merge_lands
        expected_changed = True

    _serve_from(store)
    served = await forecast_svc.get_historical_area_demand_forecast(*_P2_CENTER, _ARRIVAL, now=_P2_NOW)
    await _drain()
    assert served is not None
    counts = _total()
    assert counts["compared"] == counts["edge"] == 1
    assert counts["rows"] == counts["value"] == 0
    [diff] = shadow_env.named("area_demand_shadow_diff")
    assert diff["kind"] == "edge" and diff["gen_changed"] is expected_changed
    if case != "merge_during_fetch":
        assert diff["trailing"] == 1
    else:
        # 같은 입력이라도 세대가 그대로였다면 안쪽 구멍 — rows(진짜 결함)로 센다.
        [rpc_points] = [forecast_svc._points_cache[forecast_svc._grid_key(*_P2_CENTER)][1]]
        kind = forecast_svc._shadow_compare(
            "request", *_P2_CENTER, _ARRIVAL, _P2_NOW, rpc_points, store, False, None,
        )
        assert kind == "rows"


# ── T37 ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_shadow_fetched_here_probe(monkeypatch, shadow_env):
    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    _serve_from(_patterned_snapshot())
    other = (35.83612, 129.21041)  # 같은 격자, 다른 좌표
    assert forecast_svc._grid_key(*other) == forecast_svc._grid_key(*_P2_CENTER)

    # 1) 직접 받은 호출만 비교한다 — 같은 격자의 캐시 적중은 비교하지 않는다.
    await forecast_svc.get_historical_area_demand_forecast(*_P2_CENTER, _ARRIVAL, now=_P2_NOW)
    await _drain()
    assert _total()["compared"] == 1
    await forecast_svc.get_historical_area_demand_forecast(*other, _ARRIVAL, now=_P2_NOW)
    await _drain()
    assert _total()["compared"] == 1 and len(client.calls) == 1

    # 2) 다른 코루틴이 락을 쥐고 받는 중이면, 기다렸다 그 결과를 받는 쪽은 비교하지 않는다.
    _grid_forget(_P2_CENTER)
    release, entered = threading.Event(), threading.Event()

    def _hold(_params):
        entered.set()
        assert release.wait(10)

    client.before_execute = _hold
    holder = asyncio.create_task(forecast_svc.get_historical_area_demand_forecast(*_P2_CENTER, _ARRIVAL, now=_P2_NOW))
    assert await asyncio.to_thread(entered.wait, 10)
    waiter = asyncio.create_task(forecast_svc.get_historical_area_demand_forecast(*other, _ARRIVAL, now=_P2_NOW))
    await asyncio.sleep(0.05)
    release.set()
    held, waited = await asyncio.gather(holder, waiter)
    await _drain()
    assert repr(held) == repr(waited)
    assert len(client.calls) == 2 and _total()["compared"] == 2

    # 3) 보유자가 실패하고 락을 푼 순간 기다리는 쪽이 남아 있으면 — 그쪽이 먼저 받는다, 이 호출은 비교하지 않는다.
    _grid_forget(_P2_CENTER)
    release.clear()
    entered.clear()
    attempts: list[int] = []

    def _fail_first(_params):
        attempts.append(1)
        if len(attempts) == 1:
            entered.set()
            assert release.wait(10)
            raise RuntimeError("holder failed")

    client.before_execute = _fail_first
    holder = asyncio.create_task(forecast_svc.get_historical_area_demand_forecast(*_P2_CENTER, _ARRIVAL, now=_P2_NOW))
    assert await asyncio.to_thread(entered.wait, 10)
    waiter = asyncio.create_task(forecast_svc.get_historical_area_demand_forecast(*other, _ARRIVAL, now=_P2_NOW))
    await asyncio.sleep(0.05)
    release.set()
    failed, waited = await asyncio.gather(holder, waiter)
    await _drain()
    assert failed is None and waited is not None and len(attempts) == 2
    assert _total()["compared"] == 2  # 받은 쪽(waiter)은 판정 당시 락이 잡혀 있었다 — 추측하지 않고 건너뛴다

    # 판정 함수 자체: 기다리는 쪽이 있는 풀린 락 · 대기열을 볼 수 없는 락 · 만료된 캐시. 아무것도 바꾸지 않는다.
    key = (1.234, 5.678)
    lock = asyncio.Lock()
    forecast_svc._points_locks[key] = lock
    await lock.acquire()
    pending = asyncio.create_task(lock.acquire())
    await asyncio.sleep(0)
    cache_before, locks_before = dict(forecast_svc._points_cache), dict(forecast_svc._points_locks)
    assert forecast_svc._will_fetch_here(key) is False  # 잡혀 있다
    lock.release()  # 보유자가 (실패하고) 풀었다 — 기다리던 쪽은 아직 깨어나지 않았다
    assert not lock.locked() and lock._waiters
    assert forecast_svc._will_fetch_here(key) is False
    assert forecast_svc._will_fetch_here((9.0, 9.0)) is True  # 캐시도 락도 없다
    assert dict(forecast_svc._points_cache) == cache_before and dict(forecast_svc._points_locks) == locks_before
    assert (9.0, 9.0) not in forecast_svc._points_locks
    await pending
    lock.release()
    assert forecast_svc._will_fetch_here(key) is True  # 비었고 기다리는 쪽도 없다

    class _OpaqueLock:
        def locked(self):
            return False

    forecast_svc._points_locks[key] = _OpaqueLock()
    assert forecast_svc._will_fetch_here(key) is False  # 대기열을 볼 수 없다 — 건너뛴다(R10)
    forecast_svc._points_locks.pop(key)
    forecast_svc._points_cache[key] = (time.monotonic() - forecast_svc._POINTS_CACHE_TTL_SECONDS - 1, [])
    assert forecast_svc._will_fetch_here(key) is True  # 만료된 항목은 곧 다시 받는다
    forecast_svc._points_cache[key] = (time.monotonic(), [])
    assert forecast_svc._will_fetch_here(key) is False


# ── T38 ──────────────────────────────────────────────────────────────────────


def _recent_coordinates(count: int) -> list[tuple[float, float]]:
    rng = random.Random(38)
    coordinates: list[tuple[float, float]] = []
    while len(coordinates) < count:
        latitude = _P2_CENTER[0] + rng.uniform(-0.012, 0.012)
        longitude = _P2_CENTER[1] + rng.uniform(-0.015, 0.015)
        if not _is_tie(latitude, longitude):
            coordinates.append((latitude, longitude))
    return coordinates


def test_shadow_self_probe_rotation_and_classes(monkeypatch, shadow_env):
    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    monkeypatch.setattr(forecast_svc, "_shadow_utcnow", lambda: _P2_NOW)
    snapshot = _patterned_snapshot()
    assert ph._shadow_probe is forecast_svc._shadow_self_probe  # import 때 등록된다

    fixed = forecast_svc._probe_fixed_targets(tuple(snapshot.columns))
    assert [name for name, _ in fixed] == ["center", "edge_in", "edge_out", "one_lot", "far"]
    targets = dict(fixed)
    assert targets["center"] == _P2_CENTER and targets["far"] == _P2_FAR
    nearest = min(snapshot.columns, key=lambda c: calculate_haversine_distance(*_P2_CENTER, c.latitude, c.longitude))
    assert calculate_haversine_distance(*targets["edge_in"], nearest.latitude, nearest.longitude) == 2000.0
    assert calculate_haversine_distance(*targets["edge_out"], nearest.latitude, nearest.longitude) == 2000.1
    lonely = next(c for c in snapshot.columns if c.lot_id == "gyeongju-its:93")  # 다른 열에서 ~7km
    assert calculate_haversine_distance(*targets["one_lot"], lonely.latitude, lonely.longitude) == 300.0
    for point in targets.values():
        assert not _is_tie(*point)
        for column in snapshot.columns:  # 반올림 전 값이 반올림 값과 같은 식(스펙 §1.2)
            raw = forecast_svc._raw_distance_m(*point, column.latitude, column.longitude)
            assert round(raw, 1) == calculate_haversine_distance(*point, column.latitude, column.longitude)

    recent = _recent_coordinates(24)
    for coordinate in recent:
        forecast_svc._remember_coordinate(*coordinate)
    results = [forecast_svc._shadow_self_probe(snapshot) for _ in range(29)]

    expected_order = [point for _, point in fixed] + list(reversed(recent))
    assert [(call["p_latitude"], call["p_longitude"]) for call in client.calls] == expected_order
    assert client.since_seen == [_expected_since(_P2_NOW)] * 29
    assert results == ["equal"] * 29  # far 도: 두 시계열 모두 비어 있다 → equal
    counts = _total()
    assert counts["probes"] == counts["compared"] == counts["equal"] == 29 and counts["probe_failed"] == 0
    assert counts["probes_by_class"] == {"center": 1, "edge_in": 1, "edge_out": 1, "one_lot": 1, "far": 1,
                                         "facility": 24}
    assert counts["distinct_facility_coords"] == 24
    assert counts["forecast_compared"] == forecast_svc._SHADOW_FORECAST_BUDGET == 12
    assert counts["forecast_skipped"] == 29 - 12 and counts["forecast_mismatch"] == 0
    assert counts["rows"] == counts["value"] == 0 and counts["failed"] == 0
    _assert_consistent(counts)

    # 한 바퀴를 넘으면 처음부터(돌림). 적재 스레드의 호출 모양(_call_probe — 그때의 저장소)으로도 같은 함수가 돈다.
    ph._loader.snapshot = snapshot
    ph._loader._call_probe(forecast_svc._shadow_self_probe)
    assert (client.calls[-1]["p_latitude"], client.calls[-1]["p_longitude"]) == _P2_CENTER


def test_shadow_probe_failure_is_counted_and_only_in_shadow(monkeypatch, shadow_env):
    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    monkeypatch.setattr(forecast_svc, "_shadow_utcnow", lambda: _P2_NOW)
    snapshot = _patterned_snapshot()

    def _down(_params):
        raise RuntimeError("SECRET-xyz at 35.83612")

    client.before_execute = _down
    assert forecast_svc._shadow_self_probe(snapshot) is None
    counts = _total()
    assert counts["probes"] == 1 and counts["probe_failed"] == 1 and counts["compared"] == 0
    assert counts["probes_by_class"]["center"] == 0
    [failed] = shadow_env.named("area_demand_shadow_probe_failed")
    assert failed["probe_class"] == "center" and failed["error_type"] == "RuntimeError"

    client.before_execute = None
    for source in ("rpc", "matrix"):
        _use_source(monkeypatch, source)
        assert forecast_svc._shadow_self_probe(snapshot) is None
    assert len(client.calls) == 1 and _total()["probes"] == 1


def test_shadow_summary_is_one_line_per_window(monkeypatch, shadow_env):
    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    monkeypatch.setattr(forecast_svc, "_shadow_utcnow", lambda: _P2_NOW)
    clock = {"t": 1_000.0}
    monkeypatch.setattr(forecast_svc, "_shadow_mono", lambda: clock["t"])
    snapshot = _patterned_snapshot()
    forecast_svc._shadow_self_probe(snapshot)  # 창을 연다
    forecast_svc._shadow_self_probe(snapshot)
    assert not shadow_env.named("area_demand_shadow_summary")
    clock["t"] += forecast_svc._SHADOW_WINDOW_S
    forecast_svc._shadow_tick()  # 적재 꼬리 단계(탐침) 또는 다음 비교가 낸다
    forecast_svc._shadow_tick()
    [summary] = shadow_env.named("area_demand_shadow_summary")
    assert summary["window_s"] == 600
    for part in ("window", "total"):
        assert summary[part]["compared"] == 2 and summary[part]["probes"] == 2
        assert set(summary[part]) >= _SPEC_SHADOW_KEYS | {
            "probes_by_class", "skipped_budget", "skipped_busy", "skipped_not_servable",
        }
    # 새 창: 예산이 다시 찬다, 누적은 이어진다.
    assert forecast_svc._shadow_budget == {"request": 0, "forecast": 0, "diff": 0}
    forecast_svc._shadow_self_probe(snapshot)
    assert forecast_svc._shadow_window.counts["compared"] == 1 and _total()["compared"] == 3


# ── T39 ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_shadow_never_delays_or_fails_the_response(monkeypatch, shadow_env):
    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    expected = await _rpc_mode_value(monkeypatch, client, *_P2_CENTER)
    _serve_from(_patterned_snapshot())

    # 1) 비교가 던진다 → 답은 그대로, 세고 내부 로그에만.
    def _boom(*_args, **_kwargs):
        raise RuntimeError("SECRET-xyz at 35.83612")

    monkeypatch.setattr(forecast_svc, "_shadow_compare", _boom)
    got = await forecast_svc.get_historical_area_demand_forecast(*_P2_CENTER, _ARRIVAL, now=_P2_NOW)
    await _drain()
    assert repr(got) == repr(expected)
    assert _total()["failed"] == 1 and forecast_svc._shadow_request_inflight == 0
    assert shadow_env.named("area_demand_shadow_failed")[0]["error_type"] == "RuntimeError"

    # 2) 비교가 느리다 → 답은 비교를 기다리지 않는다. 그동안 받은 다른 호출은 동시 1 을 넘지 않게 건너뛴다(skipped_busy).
    gate = threading.Event()

    def _slow(*_args, **_kwargs):
        assert gate.wait(10)
        return "equal"

    monkeypatch.setattr(forecast_svc, "_shadow_compare", _slow)
    _grid_forget(_P2_CENTER)
    started = time.perf_counter()
    got = await forecast_svc.get_historical_area_demand_forecast(*_P2_CENTER, _ARRIVAL, now=_P2_NOW)
    # 비교를 기다리지 않았다는 증거는 다음 줄(게이트가 닫힌 채 진행 중 1 · 태스크 1)이다. 시간 상한은 비교를 기다린 경우
    # (gate.wait 10초)만 가르도록 넉넉히 — 바쁜 CI 에서 요청 계산(대역 RPC + 순수 파이썬 전망, 한가할 때 ~0.5초)이 흔들리지 않게.
    assert time.perf_counter() - started < 8.0 and repr(got) == repr(expected)
    assert forecast_svc._shadow_request_inflight == 1 and len(forecast_svc._shadow_tasks) == 1
    await forecast_svc.get_historical_area_demand_forecast(*_P2_SECOND, _ARRIVAL, now=_P2_NOW)
    assert _total()["skipped_busy"] == 1
    gate.set()
    await _drain()
    assert forecast_svc._shadow_request_inflight == 0

    # 3) 판정 쪽이 던져도(요청 경로의 앞단) 답은 그대로다.
    def _probe_boom(_key):
        raise RuntimeError("probe bug")

    monkeypatch.setattr(forecast_svc, "_will_fetch_here", _probe_boom)
    _grid_forget(_P2_CENTER)
    got = await forecast_svc.get_historical_area_demand_forecast(*_P2_CENTER, _ARRIVAL, now=_P2_NOW)
    assert repr(got) == repr(expected) and _total()["failed"] == 2

    # 품질·예열은 shadow 에서도 RPC 경로 그대로다(비교 없음).
    monkeypatch.setattr(forecast_svc, "_shadow_compare", _boom)
    quality = await forecast_svc.get_area_demand_forecast_quality(*_P2_CENTER, now=_P2_NOW)
    assert quality["usable"] is True and _total()["failed"] == 2


# ── T40 ──────────────────────────────────────────────────────────────────────


def test_shadow_forecast_compare_normalizes_negative_zero(monkeypatch, shadow_env):
    client = _since_rpc_client()
    snapshot = _patterned_snapshot()
    rpc_points = forecast_svc._points_from_payload(
        client.rpc("area_demand_points_near", {
            "p_latitude": _P2_CENTER[0], "p_longitude": _P2_CENTER[1], "p_since": _expected_since(_P2_NOW),
            "p_radius_m": 2000.0, "p_source": "gyeongju_its",
        }).execute().data
    )
    arrival = _P2_NOW + timedelta(hours=4)  # 지평 ≥180분 → decay 0 → recent_adjustment 는 ±0.0
    real = forecast_svc._matrix_forecast
    baseline = real(snapshot, *_P2_CENTER, arrival, _P2_NOW)
    assert baseline is not None and baseline["recent_adjustment"] == 0

    def _flipped(*args):
        forecast = real(*args)
        sign = math.copysign(1.0, forecast["recent_adjustment"])
        return {**forecast, "recent_adjustment": -0.0 if sign > 0 else 0.0}

    monkeypatch.setattr(forecast_svc, "_matrix_forecast", _flipped)
    kind = forecast_svc._shadow_compare("probe:center", *_P2_CENTER, arrival, _P2_NOW, rpc_points, snapshot, False, None)
    counts = _total()
    assert kind == "equal"
    assert counts["forecast_compared"] == 1 and counts["forecast_mismatch"] == 0 and counts["repr_only"] == 1
    assert not shadow_env.named("area_demand_shadow_diff")

    # 대조: 값이 정말 다르면 forecast_mismatch 이고 차이 한 줄(kind=forecast).
    monkeypatch.setattr(forecast_svc, "_matrix_forecast", lambda *args: {**real(*args), "level": 0.1234})
    forecast_svc._shadow_compare("probe:center", *_P2_CENTER, arrival, _P2_NOW, rpc_points, snapshot, False, None)
    counts = _total()
    assert counts["forecast_compared"] == 2 and counts["forecast_mismatch"] == 1 and counts["repr_only"] == 1
    [diff] = shadow_env.named("area_demand_shadow_diff")
    assert diff["kind"] == "forecast" and diff["matrix_level"] == 0.1234 and diff["ref_usable"] is True
    assert forecast_svc._norm({"a": [-0.0, (1.5, -0.0)], "b": None}) == {"a": [0.0, [1.5, 0.0]], "b": None}
    assert repr(forecast_svc._norm(-0.0)) == "0.0"


# ── T33(shadow 칸) ───────────────────────────────────────────────────────────


def test_health_shadow_block_is_integers_only(monkeypatch, shadow_env):
    from fastapi.testclient import TestClient

    from app.main import app

    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    monkeypatch.setattr(forecast_svc, "_shadow_utcnow", lambda: _P2_NOW)
    snapshot = _patterned_snapshot()
    _serve_from(snapshot)
    secret = "SECRET-xyz at 35.83612"

    forecast_svc._shadow_self_probe(snapshot)  # 정상 탐침 하나

    def _down(_params):
        raise RuntimeError(secret)

    client.before_execute = _down
    forecast_svc._shadow_self_probe(snapshot)  # RPC 실패
    client.before_execute = None

    def _broken(*_args, **_kwargs):
        raise RuntimeError(secret)

    monkeypatch.setattr(forecast_svc, "_matrix_series", _broken)
    forecast_svc._shadow_self_probe(snapshot)  # 비교 실패

    body = ph.health()
    assert set(body) == _HEALTH_KEYS | {"memo", "fallback_served", "shadow"}
    assert set(body["shadow"]) == _SPEC_SHADOW_KEYS
    assert all(type(value) is int for value in body["shadow"].values())
    assert body["shadow"]["probes"] == 3 and body["shadow"]["probe_failed"] == 1 and body["shadow"]["compared"] == 1
    _assert_health_values(body)
    assert "SECRET" not in json.dumps(body) and "35.83612" not in json.dumps(body)
    assert any(secret in f["error"] for f in shadow_env.named("area_demand_shadow_failed"))

    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert set(response.json()["parking_history"]["shadow"]) == _SPEC_SHADOW_KEYS
    assert "SECRET" not in response.text

    _use_source(monkeypatch, "matrix")  # shadow 칸은 shadow 모드에서만
    assert "shadow" not in ph.health()
    _use_source(monkeypatch, "rpc")
    assert ph.health() == {"mode": "rpc"}


# ── rpc(기본)는 shadow 를 건드리지 않는다 ──────────────────────────────────────


@pytest.mark.asyncio
async def test_rpc_mode_never_touches_shadow(monkeypatch, shadow_env):
    def _forbidden(*_args, **_kwargs):
        raise AssertionError("rpc 모드가 shadow 쪽을 건드렸다")

    for name in ("_serve_shadow_forecast", "_remember_coordinate", "_will_fetch_here", "_shadow_compare",
                 "_shadow_take", "_shadow_count"):
        monkeypatch.setattr(forecast_svc, name, _forbidden)
    monkeypatch.setattr(ph, "current", _forbidden)
    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    _use_source(monkeypatch, "rpc")
    forecast = await forecast_svc.get_historical_area_demand_forecast(*_P2_CENTER, _ARRIVAL, now=_P2_NOW)
    assert forecast is not None and len(client.calls) == 1
    assert not forecast_svc._shadow_tasks and not forecast_svc._recent_coords
    assert forecast_svc._shadow_window_started is None
    assert shadow_env.events == []


# ── 수리: 게이트의 종류별 표본은 비교를 끝낸 탐침만 센다 ──────────────────────────────────────────


def test_probe_class_coverage_counts_only_finished_compares(monkeypatch, shadow_env):
    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    monkeypatch.setattr(forecast_svc, "_shadow_utcnow", lambda: _P2_NOW)
    snapshot = _patterned_snapshot()
    recent = _recent_coordinates(1)
    forecast_svc._remember_coordinate(*recent[0])
    real = forecast_svc._shadow_compare

    # 행렬 쪽이 edge_out·facility 에서만 던지고, one_lot 은 비교를 건너뛴다('skipped').
    def _partly_broken(origin, *args):
        if origin in ("probe:edge_out", "probe:facility"):
            raise RuntimeError("matrix bug")
        if origin == "probe:one_lot":
            return "skipped"
        return real(origin, *args)

    monkeypatch.setattr(forecast_svc, "_shadow_compare", _partly_broken)
    results = [forecast_svc._shadow_self_probe(snapshot) for _ in range(6 * 3)]
    assert results.count(None) == 6 and results.count("skipped") == 3
    counts = _total()
    assert counts["probes"] == 18 and counts["probe_failed"] == 0 and counts["failed"] == 6
    assert counts["probes_by_class"] == {"center": 3, "edge_in": 3, "edge_out": 0, "one_lot": 0, "far": 3,
                                         "facility": 0}
    assert counts["distinct_facility_coords"] == 0 and forecast_svc._shadow_health()["distinct_facility_coords"] == 0
    window = forecast_svc._shadow_window.as_log()
    assert window["probes_by_class"] == counts["probes_by_class"]

    # 고쳐지면 같은 좌표가 곧바로 표본이 된다.
    monkeypatch.setattr(forecast_svc, "_shadow_compare", real)
    for _ in range(6):
        forecast_svc._shadow_self_probe(snapshot)
    counts = _total()
    assert counts["probes_by_class"]["edge_out"] == 1 and counts["probes_by_class"]["facility"] == 1
    assert counts["distinct_facility_coords"] == 1


# ── 수리: 수준만 다른 시계열의 ulp / value 경계(스펙 §5 — 0 < d ≤ 1e-12 → ulp, d > 1e-12 → value) ──────


@pytest.mark.parametrize(
    ("delta", "expected_kind"),
    [(5e-13, "ulp"), (-5e-13, "ulp"), (2e-12, "value"), (-2e-12, "value"), (1e-6, "value")],
)
def test_level_only_difference_is_ulp_up_to_1e12_and_value_beyond(monkeypatch, shadow_env, delta, expected_kind):
    snapshot = _patterned_snapshot()
    view = _center_view(snapshot)
    matrix_points = list(view)
    position = len(matrix_points) // 2
    assert 0 < position < len(matrix_points) - 1  # 안쪽 한 점 — 끝자락(edge)이 아니다
    original = matrix_points[position]
    shifted = original.level + delta
    rpc_points = list(matrix_points)
    rpc_points[position] = forecast_svc.AreaDemandPoint(original.observed_at, shifted, original.lot_count)
    actual_diff = abs(shifted - original.level)
    assert actual_diff != 0.0 and (actual_diff <= forecast_svc._SHADOW_ULP) == (expected_kind == "ulp")

    arrival = _P2_NOW + timedelta(minutes=90)
    kind = forecast_svc._shadow_compare(
        "probe:center", *_P2_CENTER, arrival, _P2_NOW, rpc_points, snapshot, False, None,
    )
    assert kind == expected_kind
    counts = _total()
    assert counts["compared"] == 1 and counts[expected_kind] == 1
    assert counts["equal"] == counts["edge"] == counts["rows"] == 0
    _assert_consistent(counts)
    [diff] = shadow_env.named("area_demand_shadow_diff")
    assert diff["kind"] == expected_kind and diff["max_abs_level_diff"] == actual_diff
    assert diff["first_diff_at"] is None and diff["trailing"] == 0 and diff["rpc_rows"] == diff["matrix_rows"]
    if expected_kind == "value":
        # value 는 게이트를 막는 결함이다: 전망 비교로 넘어가지 않고 경고 한 줄.
        assert counts["forecast_compared"] == 0 and counts["forecast_skipped"] == 0
        assert ("warning", "area_demand_shadow_diff") in [(lvl, name) for lvl, name, _ in shadow_env.events]
    else:
        assert counts["forecast_compared"] == 1


# ── 수리: 종료 때 shadow 누적을 마지막 요약 한 줄로 남긴다(재시작을 넘는 게이트 합산) ────────────────────────


def test_stop_emits_a_final_shadow_summary_with_the_boot_totals(monkeypatch, shadow_env):
    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    monkeypatch.setattr(forecast_svc, "_shadow_utcnow", lambda: _P2_NOW)
    clock = {"t": 5_000.0}
    monkeypatch.setattr(forecast_svc, "_shadow_mono", lambda: clock["t"])
    assert ph._shadow_flush is forecast_svc._shadow_flush  # import 때 등록된다
    snapshot = _patterned_snapshot()

    asyncio.run(ph.stop())  # 창을 연 적이 없으면 아무것도 남기지 않는다
    assert not shadow_env.named("area_demand_shadow_summary")

    forecast_svc._shadow_self_probe(snapshot)  # 창을 연다(비교 1)
    clock["t"] += 300.0
    forecast_svc._shadow_count("compared", "rows")  # 창이 닫히기 전의 결함 — 10분 요약으로는 나오지 않는다
    for _ in range(forecast_svc._SHADOW_DIFF_BUDGET):
        forecast_svc._shadow_take("diff", forecast_svc._SHADOW_DIFF_BUDGET)  # 차이 줄 예산도 다 썼다
    assert not shadow_env.named("area_demand_shadow_summary")

    asyncio.run(ph.stop())  # 재시작(배포·env 변경)
    [final] = shadow_env.named("area_demand_shadow_summary")
    assert final["final"] is True and final["window_s"] == 300
    assert final["total"]["rows"] == 1 and final["total"]["compared"] == 2 and final["total"]["probes"] == 1
    assert final["total"] == forecast_svc._shadow_total.as_log() and final["window"]["rows"] == 1
    assert set(final["total"]) >= _SPEC_SHADOW_KEYS | {"probes_by_class", "failed"}

    # shadow 가 아닌 모드에서는 아무것도 남기지 않고, 기록이 실패해도 종료는 막히지 않는다.
    for source in ("rpc", "matrix"):
        _use_source(monkeypatch, source)
        asyncio.run(ph.stop())
    assert len(shadow_env.named("area_demand_shadow_summary")) == 1
    _use_source(monkeypatch, "shadow")

    def _broken():
        raise RuntimeError("flush bug")

    monkeypatch.setattr(ph, "_shadow_flush", _broken)
    asyncio.run(ph.stop())


# ── 수리: shadow 요청이 최근 좌표 고리를 채운다('facility' 탐침 · distinct_facility_coords ≥ 20 게이트의 원천) ──────────


@pytest.mark.asyncio
async def test_shadow_requests_feed_the_recent_coordinate_ring_used_by_facility_probes(monkeypatch, shadow_env):
    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    monkeypatch.setattr(forecast_svc, "_shadow_utcnow", lambda: _P2_NOW)
    snapshot = _patterned_snapshot()
    _serve_from(snapshot)
    # 한 격자(round 3자리) 안의 서로 다른 정확한 좌표 34개 — 첫 호출만 RPC, 나머지는 격자 캐시 적중이어도 고리에 든다.
    coordinates = [(_P2_CENTER[0] + k * 1e-5, _P2_CENTER[1] - k * 1e-5) for k in range(34)]
    assert len({forecast_svc._grid_key(*c) for c in coordinates}) == 1
    for coordinate in coordinates:
        await forecast_svc.get_historical_area_demand_forecast(*coordinate, _ARRIVAL, now=_P2_NOW)
    await forecast_svc.get_historical_area_demand_forecast(*coordinates[5], _ARRIVAL, now=_P2_NOW)  # 다시 물으면 맨 앞으로
    await _drain()
    assert len(client.calls) == 1

    ring = list(reversed(forecast_svc._recent_coords))  # 가장 최근 먼저
    assert len(ring) == forecast_svc._RECENT_COORDS_MAX == 32
    assert ring[0] == coordinates[5]
    assert ring[1:] == [c for c in reversed(coordinates) if c != coordinates[5]][:31]  # 가장 오래된 2개는 밀려났다

    # 자기 탐침: 고정 5종 다음은 이 요청 좌표들(가장 최근 먼저)이 'facility' 로.
    calls_before = len(client.calls)
    for _ in range(5 + 3):
        forecast_svc._shadow_self_probe(snapshot)
    probed = [(call["p_latitude"], call["p_longitude"]) for call in client.calls[calls_before:]]
    assert probed[5:] == ring[:3]
    counts = _total()
    assert counts["probes_by_class"]["facility"] == 3 and counts["distinct_facility_coords"] == 3
