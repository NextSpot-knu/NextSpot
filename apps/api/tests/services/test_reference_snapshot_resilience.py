"""참조 스냅샷 — 리뷰가 재현한 장애 모양들의 회귀 테스트.

  · 베이스가 없을 때 혼잡 쓰기 한 번이 이벤트 루프를 헛돌게 하던 것(_due 와 _sleep 의 판정 불일치).
  · 출처 표만 못 읽어도 베이스 전체가 멈춰 좌석 방송·시설 수정이 최대 3시간 안 보이던 것.
  · 베이스 재적재가 실패 중인데 방금 쓴 시설 쓰기가 있으면 실시간 경로를 먼저 시도하는지.
  · 오리건→서울 왕복이 느려도 '다음 지도 요청에 방금 쓴 값' 약속을 지키는지(탐침 생략·RPC 1000개 조각).
  · 연속 쓰기가 연속 전량 재적재가 되지 않는지(묶음별 디바운스·최소 간격·오버레이는 활성 집합이 바뀔 때만).
  · 되돌림 스위치는 정확히 'snapshot' 일 때만 켜지는지, 적재 스레드가 프로세스 종료를 붙잡지 않는지.
"""
import asyncio
import dataclasses
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.core.config import settings
from app.services import reference_snapshot as rs
from tests.services.test_reference_snapshot import (
    FakeDB,
    _client,
    _facility,
    _fid,
    _golden_db,
    _install,
    _iso,
    _wait_until,
)


@pytest.fixture
def snapshot_mode(monkeypatch):
    monkeypatch.setattr(settings, "REFERENCE_SNAPSHOT_SERVE", "snapshot")


def _body(payload) -> dict:
    return {r["id"]: r for r in json.loads(payload.body)}


class _SlowDB(FakeDB):
    """PostgREST 호출마다 latency 초 — 오리건(Render) → 서울(Supabase) 왕복을 흉내 낸다."""

    def __init__(self, *args, latency: float = 0.0, **kwargs):
        super().__init__(*args, **kwargs)
        self.latency = latency

    def table(self, name):
        query = super().table(name)
        execute = query.execute

        def _slow_execute():
            time.sleep(self.latency)
            return execute()

        query.execute = _slow_execute
        return query

    def rpc(self, name, params):
        call = super().rpc(name, params)
        execute = call.execute

        def _slow_execute():
            time.sleep(self.latency)
            return execute()

        call.execute = _slow_execute
        return call


# =============================================================================
# 갱신 루프가 헛돌지 않는다
# =============================================================================

@pytest.mark.parametrize("why_base_is_missing", ["supabase_down_at_boot", "empty_first_base"])
def test_an_overlay_write_while_the_base_is_missing_does_not_spin_the_event_loop(
    monkeypatch, snapshot_mode, why_base_is_missing
):
    """베이스가 없으면 오버레이는 읽지 않는데(_step), 잠들 시각(_sleep)은 그 쓰기 알림을 기다려 sleep(0) 으로
    헛돌았다 — 리뷰 재현: 쓰기 한 번에 2초 동안 35만 바퀴, CPU 2.0초(0.5 CPU 인스턴스면 할당량 전부)."""
    monkeypatch.setattr(rs, "DEBOUNCE_S", 0.05)
    db = _golden_db(datetime.now(timezone.utc))
    facilities = db.tables["facilities"]
    if why_base_is_missing == "supabase_down_at_boot":
        db.fail = {"facilities", "facility_source_refs"}
    else:
        db.tables["facilities"] = []                        # 건전성 관문이 0곳짜리 첫 베이스를 붙잡는다
    _install(monkeypatch, db)

    steps = {"n": 0}
    original = rs._Refresher._step

    async def _counting_step(self):
        steps["n"] += 1
        await original(self)

    monkeypatch.setattr(rs._Refresher, "_step", _counting_step)

    async def _scenario():
        rs.start()
        try:
            base_part = rs._refresher.parts["base"]
            await _wait_until(lambda: base_part.failures >= 1 or base_part.hold_until > 0)
            assert rs._refresher.base is None
            rs.mark_dirty("congestion")                    # 예: POST /reports/congestion 성공
            await asyncio.sleep(0.2)                        # 디바운스가 지났다
            before, cpu_before = steps["n"], time.process_time()
            await asyncio.sleep(0.5)
            assert steps["n"] - before <= 2, f"refresher spun {steps['n'] - before} times in 0.5s"
            assert time.process_time() - cpu_before < 0.3

            # 베이스가 돌아오면 기다리던 쓰기가 반영된다(알림을 잃지 않는다).
            db.fail = set()
            db.tables["facilities"] = facilities
            base_part.next_due = time.monotonic()
            base_part.hold_until = 0.0
            rs._refresher._wake_up()
            await _wait_until(lambda: rs.health()["ready"] and not rs._refresher._pending("overlay")[0])
        finally:
            await rs.stop()

    asyncio.run(_scenario())


def test_the_loop_never_sleeps_zero_even_if_a_deadline_is_already_past():
    """판정이 또 어긋나는 날이 와도 헛돌기가 되지 않게 잠드는 시간에 바닥을 둔다."""
    refresher = rs._Refresher()
    refresher.parts["base"].next_due = time.monotonic() - 10

    started = time.monotonic()
    asyncio.run(refresher._sleep())
    assert time.monotonic() - started >= rs.MIN_LOOP_SLEEP_S * 0.8


# =============================================================================
# 출처 표만 실패 — 시설 쓰기는 계속 반영된다
# =============================================================================

def test_a_source_refs_failure_does_not_freeze_facility_writes(monkeypatch, snapshot_mode):
    """출처 표 읽기만 실패하면 베이스 전체를 실패로 올려, 좌석 방송이 최대 3시간(오래됨 판정까지) 안 보였다
    — 실시간 경로는 같은 오류를 삼키고 새 좌석 상태를 냈다(리뷰 재현). 출처 표기는 정상본으로 채운다."""
    db = _golden_db(datetime.now(timezone.utc))
    _install(monkeypatch, db)
    asyncio.run(rs.refresh_once())
    assert _body(asyncio.run(rs.map_payload(rs.NO_FILTER)))[_fid(3)]["place_data_source"] == "localdata"

    db.fail = {"facility_source_refs"}
    db.tables["facilities"][0]["features"] = {"seat_status": {"level": "full"}}
    rs.mark_dirty("facilities")
    asyncio.run(rs._refresher.refresh_base())

    payload = asyncio.run(rs.map_payload(rs.NO_FILTER))
    body = _body(payload)
    assert body[_fid(1)]["features"] == {"seat_status": {"level": "full"}}   # 시설 쓰기는 반영
    assert body[_fid(3)]["place_data_source"] == "localdata"                 # 출처 표기는 정상본
    assert body[_fid(3)]["data_updated_at"] == "2026-09-20T00:00:00+00:00"
    assert payload.stale is False
    base = rs.health()["base"]
    assert base["failures"] == 0 and base["refs_failures"] == 1
    assert base["last_error"] == "refs:RuntimeError"
    assert not rs._refresher._pending("base")[0]

    # 출처 표가 돌아오면 다음 탐침이 전량 다시 읽어 정상 상태로 돌아간다.
    db.fail = set()
    asyncio.run(rs._refresher.refresh_base())
    assert rs.health()["base"]["refs_failures"] == 0
    assert _body(asyncio.run(rs.map_payload(rs.NO_FILTER)))[_fid(3)]["place_data_source"] == "localdata"


def test_a_first_build_without_source_refs_matches_the_live_path(monkeypatch, snapshot_mode):
    """출처 표를 한 번도 못 읽었으면 실시간 경로와 똑같이(출처 표기 없이) 만든다 — 지어내지 않는다."""
    db = _golden_db(datetime.now(timezone.utc))
    db.fail = {"facility_source_refs"}
    _install(monkeypatch, db)
    client = _client()

    monkeypatch.setattr(settings, "REFERENCE_SNAPSHOT_SERVE", "legacy")
    live = client.get("/api/v1/infrastructures")
    assert live.status_code == 200 and "etag" not in live.headers

    monkeypatch.setattr(settings, "REFERENCE_SNAPSHOT_SERVE", "snapshot")
    asyncio.run(rs.refresh_once())
    assert rs.health()["ready"] is True
    snap = client.get("/api/v1/infrastructures")
    assert "etag" in snap.headers
    assert snap.content == live.content


# =============================================================================
# 베이스 재적재가 실패 중이면 실시간을 먼저
# =============================================================================

def _break_snapshot_facility_reads(monkeypatch):
    """스냅샷만의 적재 실패(열 목록·페이지네이션) — 실시간 경로(select *)는 그대로 읽힌다."""
    original = rs._keyset_rows

    def _broken(client, table, select, *, filters=None):
        if table == "facilities":
            raise RuntimeError("column facilities.overview does not exist")
        return original(client, table, select, filters=filters)

    monkeypatch.setattr(rs, "_keyset_rows", _broken)


def test_a_failing_base_with_an_unapplied_facility_write_prefers_the_live_path(monkeypatch, snapshot_mode):
    db = _golden_db(datetime.now(timezone.utc))
    _install(monkeypatch, db)
    asyncio.run(rs.refresh_once())
    client = _client()
    good = client.get("/api/v1/infrastructures")
    assert "etag" in good.headers

    _break_snapshot_facility_reads(monkeypatch)
    db.tables["facilities"][0]["features"] = {"seat_status": {"level": "full"}}
    rs.mark_dirty("facilities")
    asyncio.run(rs._refresher.refresh_base())
    assert rs.health()["base"]["failures"] == 1

    res = client.get("/api/v1/infrastructures")                   # 실시간이 방금 쓴 값을 보여 준다
    assert res.status_code == 200 and "etag" not in res.headers
    assert {r["id"]: r for r in res.json()}[_fid(1)]["features"] == {"seat_status": {"level": "full"}}

    db.fail = {"facilities"}                                      # 실시간마저 실패 — 마지막 정상본
    saved = client.get("/api/v1/infrastructures")
    assert saved.status_code == 200 and saved.content == good.content


def test_a_long_failing_base_prefers_the_live_path_but_a_brief_one_does_not(monkeypatch, snapshot_mode):
    db = _golden_db(datetime.now(timezone.utc))
    _install(monkeypatch, db)
    asyncio.run(rs.refresh_once())
    _break_snapshot_facility_reads(monkeypatch)
    rs._refresher._last_full_load -= rs.BASE_BACKSTOP_S          # 30분 전량 재적재가 실패한다(쓰기 없음)
    asyncio.run(rs._refresher.refresh_base())
    assert rs.health()["base"]["failures"] == 1
    assert asyncio.run(rs.map_payload(rs.NO_FILTER)).stale is False

    rs._refresher.parts["base"].ok_at = time.monotonic() - rs.BASE_FAILING_STALE_AFTER_S - 1
    assert asyncio.run(rs.map_payload(rs.NO_FILTER)).stale is True


# =============================================================================
# 오버레이가 오래됐는데 혼잡 RPC 가 죽어 있으면 — 혼잡 없는 지도가 아니라 마지막 정상본
# =============================================================================

def test_a_stale_overlay_with_a_dead_congestion_rpc_serves_last_good_not_a_congestionless_map(
    monkeypatch, snapshot_mode
):
    """리뷰 재현: 실시간 경로가 RPC 실패를 {} 로 삼켜 '혼잡 0곳' 지도를 200 으로 냈고(ETag 없음), 웹은 그걸
    24시간 캐시에 저장했다. 이제 실시간이 500 으로 올리고 라우터가 마지막 정상본을 낸다."""
    db = _golden_db(datetime.now(timezone.utc))
    _install(monkeypatch, db)
    asyncio.run(rs.refresh_once())
    client = _client()
    good = client.get("/api/v1/infrastructures")
    assert sum(1 for r in good.json() if r["congestion"]) >= 3

    db.fail = {"rpc"}
    asyncio.run(rs._refresher.refresh_overlay())
    rs._refresher.parts["overlay"].ok_at = time.monotonic() - rs.OVERLAY_STALE_AFTER_S - 60

    res = client.get("/api/v1/infrastructures")
    assert res.status_code == 200
    assert res.content == good.content
    assert int(res.headers["x-snapshot-age"]) > rs.OVERLAY_STALE_AFTER_S


def test_without_a_snapshot_a_dead_congestion_rpc_is_a_500_so_the_web_falls_back(monkeypatch):
    """정상본이 없으면(부팅 직후·legacy) 500 — 웹은 곧바로 Supabase 직접 읽기(혼잡 포함)로 돈다. 도입 전에는
    시설별 폴백이 ~14초 걸려 웹이 4초에 포기하고 같은 폴백으로 돌았다. 혼잡 없는 200 은 그 폴백을 막는다."""
    monkeypatch.setattr(settings, "REFERENCE_SNAPSHOT_SERVE", "legacy")
    db = _golden_db(datetime.now(timezone.utc))
    db.fail = {"rpc"}
    _install(monkeypatch, db)
    res = _client().get("/api/v1/infrastructures")
    assert res.status_code == 500
    assert db.calls["rpc:latest_congestion_for_facilities"] == 2   # 한 번 + 차례 재시도 한 번(증폭 없음)


# =============================================================================
# 느린 왕복에서도 '방금 쓴 값' 이 다음 지도 요청에 보인다
# =============================================================================

def test_writes_show_on_the_next_map_load_with_slow_oregon_to_seoul_round_trips(monkeypatch, snapshot_mode):
    """호출당 0.45초면 예전 재적재(탐침 2 + 시설 2페이지 + 출처 1 = 5회, 혼잡 500개 조각 4회 + 영업 1회)는 2초
    대기를 넘겨 이전 바이트를 냈다(리뷰 재현). 탐침 생략·1000개 조각이면 둘 다 3회다."""
    now = datetime.now(timezone.utc)
    facilities = [_facility(i) for i in range(1, 1683)]            # 운영 규모(1,682곳 — keyset 2페이지)
    logs = [
        {"id": _fid(100_000 + i), "facility_id": _fid(i), "congestion_level": 0.2, "current_count": 1,
         "timestamp": _iso(now), "source": "user_report", "evidence_tier": "single_report"}
        for i in range(1, 60)
    ]
    db = _SlowDB(facilities, (), logs, ())
    _install(monkeypatch, db)

    async def _scenario():
        rs.start()
        try:
            await _wait_until(lambda: rs.health()["ready"], timeout=30)
            db.latency = 0.45
            before = db.calls["facilities"]

            # 사장님 좌석 방송(베이스)
            db.tables["facilities"][0]["features"] = {"seat_status": {"level": "full"}}
            rs.mark_dirty("facilities")
            started = time.monotonic()
            payload = await rs.map_payload(rs.NO_FILTER)
            assert time.monotonic() - started < rs.DIRTY_WAIT_S + 0.3
            assert _body(payload)[_fid(1)]["features"] == {"seat_status": {"level": "full"}}
            assert db.calls["facilities"] - before == 2                 # 탐침 없이 keyset 2페이지뿐

            # 관리자 혼잡 설정(오버레이)
            db.logs.append({"id": _fid(999_999), "facility_id": _fid(7), "congestion_level": 0.95,
                            "current_count": 1, "timestamp": _iso(datetime.now(timezone.utc)),
                            "source": "admin_override", "evidence_tier": "single_report"})
            rs.mark_dirty("congestion")
            started = time.monotonic()
            payload = await rs.map_payload(rs.NO_FILTER)
            assert time.monotonic() - started < rs.DIRTY_WAIT_S + 0.3
            assert _body(payload)[_fid(7)]["congestion"]["level"] == 0.95
        finally:
            await rs.stop()

    asyncio.run(_scenario())


def test_a_write_triggered_reload_skips_the_probe_and_the_next_probe_does_not_reload_again(
    monkeypatch, snapshot_mode
):
    db = _golden_db(datetime.now(timezone.utc))
    _install(monkeypatch, db)
    asyncio.run(rs.refresh_once())

    db.tables["facilities"][0]["features"] = {"seat_status": {"level": "full"}}
    db.tables["facilities"][0]["updated_at"] = "2026-09-27T09:00:00.123456+00:00"
    rs.mark_dirty("facilities")
    before = db.calls["facilities"]
    asyncio.run(rs._refresher.refresh_base())
    assert db.calls["facilities"] == before + 1                     # keyset 1페이지 — 탐침 없음

    asyncio.run(rs._refresher.refresh_base())                      # 60초 탐침: 방금 읽은 그대로다
    assert db.calls["facilities"] == before + 2                     # 탐침 1회뿐, 전량 재적재 없음


# =============================================================================
# 연속 쓰기 — 연속 전량 재적재가 되지 않는다
# =============================================================================

def test_a_write_storm_does_not_become_back_to_back_full_reloads(monkeypatch, snapshot_mode):
    """리뷰 재현: 0.25초마다 좌석 방송 6초 → 전량 재적재 26회가 0.1초 간격으로. 재적재마다 오버레이까지."""
    monkeypatch.setattr(rs, "BASE_WRITE_RELOAD_MIN_GAP_S", 0.5)
    db = _SlowDB(_golden_db(datetime.now(timezone.utc)).tables["facilities"], latency=0.0)
    _install(monkeypatch, db)

    async def _scenario():
        rs.start()
        try:
            await _wait_until(lambda: rs.health()["ready"])
            db.latency = 0.01
            reloads_before = db.calls["facility_source_refs"]
            rpc_before = db.calls["rpc:latest_congestion_for_facilities"]
            waiters = []
            stop = time.monotonic() + 2.0
            level = 0
            while time.monotonic() < stop:
                level += 1
                db.tables["facilities"][0]["features"] = {"seat_status": {"level": f"n{level}"}}
                rs.mark_dirty("facilities")
                waiters.append(asyncio.create_task(rs.map_payload(rs.REGION_KEY)))  # 기다리는 지도 요청
                await asyncio.sleep(0.05)
            await asyncio.gather(*waiters)
            await _wait_until(lambda: not rs._refresher._pending("base")[0], timeout=5)

            reloads = db.calls["facility_source_refs"] - reloads_before
            assert reloads <= 6, f"{reloads} full reloads in 2s"
            # 행 내용만 바뀐 재적재는 오버레이를 다시 읽게 하지 않는다.
            assert db.calls["rpc:latest_congestion_for_facilities"] == rpc_before
            payload = await rs.map_payload(rs.NO_FILTER)
            assert _body(payload)[_fid(1)]["features"] == {"seat_status": {"level": f"n{level}"}}

            # 활성 시설이 바뀌면(새 시설) 오버레이를 곧바로 읽는다.
            await asyncio.sleep(rs.BASE_WRITE_RELOAD_MIN_GAP_S)
            db.tables["facilities"].append(_facility(500))
            rs.mark_dirty("facilities")
            await _wait_until(lambda: db.calls["rpc:latest_congestion_for_facilities"] > rpc_before)
        finally:
            await rs.stop()

    asyncio.run(_scenario())


def test_marks_that_arrive_during_a_reload_start_a_new_debounce_window():
    refresher = rs._Refresher()
    refresher.mark_dirty("facilities")
    seq, pending = refresher._capture("base")
    assert pending
    time.sleep(0.02)
    refresher.mark_dirty("facilities")                             # 적재 중에 들어온 알림
    marked_during = refresher._marked_since_capture["base"]
    refresher._ok("base", seq, 60.0)
    still_pending, at = refresher._pending("base")
    assert still_pending
    assert at == marked_during                                      # 가장 오래된 알림이 아니라 새 묶음의 첫 알림


# =============================================================================
# 되돌림 스위치 · 종료 · 메모리
# =============================================================================

@pytest.mark.parametrize("value, serving", [
    ("snapshot", True), (" Snapshot ", True),
    ("legacy", False), ("LEGACY ", False), ("off", False), ("false", False), ("0", False),
    ("disabled", False), ("", False), ("snapshots", False),
])
def test_only_the_exact_word_snapshot_turns_the_snapshot_on(monkeypatch, value, serving):
    """장애 중에 손으로 치는 스위치다 — 'off'·'0'·오타가 스냅샷을 켠 채로 두면 재시작을 한 번 더 치른다."""
    monkeypatch.setattr(settings, "REFERENCE_SNAPSHOT_SERVE", value)
    assert rs._serving() is serving
    assert rs.health()["serve"] == ("snapshot" if serving else "legacy")


def test_the_loader_thread_is_a_daemon():
    refresher = rs._Refresher()
    executor = refresher._executor_or_new()
    try:
        assert executor._thread.daemon is True
        future = executor.submit(lambda: 41 + 1)
        assert future.result(timeout=5) == 42
    finally:
        executor.shutdown(wait=True)
    with pytest.raises(RuntimeError):
        executor.submit(lambda: None)


def test_shutdown_cancels_queued_loads():
    import threading

    executor = rs._DaemonExecutor("test-ref")
    release = threading.Event()
    running = executor.submit(release.wait, 5)
    deadline = time.monotonic() + 5
    while not running.running():
        assert time.monotonic() < deadline
        time.sleep(0.005)
    queued = executor.submit(lambda: "never")
    executor.shutdown(wait=False, cancel_futures=True)
    assert queued.cancelled()
    release.set()
    assert running.result(timeout=5) is True


def test_a_hung_supabase_read_does_not_hold_process_exit():
    """리뷰 재현: 적재 스레드가 Supabase 호출에 매달려 있으면 lifespan 이 끝나도 프로세스가 그 호출이 끝날
    때까지 남았다(ThreadPoolExecutor 워커는 종료 때 join 된다)."""
    code = (
        "import time\n"
        "from app.services.reference_snapshot import _DaemonExecutor\n"
        "executor = _DaemonExecutor('nextspot-ref')\n"
        "executor.submit(time.sleep, 60)\n"
        "time.sleep(0.2)\n"
        "executor.shutdown(wait=False, cancel_futures=True)\n"
    )
    api_root = Path(__file__).resolve().parents[2]
    env = {**os.environ, "PYTHONUTF8": "1"}
    started = time.monotonic()
    subprocess.run([sys.executable, "-c", code], cwd=api_root, env=env, check=True, timeout=45)
    assert time.monotonic() - started < 30


def test_the_base_does_not_retain_raw_rows_and_the_lru_is_small():
    """원본 행(1,682곳 약 4MB)은 소비자가 없다 — 512MB 인스턴스에서 들고 있지 않는다."""
    assert "rows" not in {f.name for f in dataclasses.fields(rs.FacilityBase)}
    assert rs.MAP_LRU_SIZE <= 2
