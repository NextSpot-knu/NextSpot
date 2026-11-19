"""'평소보다' 기준선 캐시(app/services/crowd/zone_evidence.py).

  · 캐시 키에 KST 시(hour)·평일/주말이 들어간다 — 14:40 에 읽은 14시 분포를 15:25 에 다시 쓰지 않는다.
  · 기준선 RPC 는 순위용 구역 관측의 시간 예산 밖에서 돈다 — 캐시가 비면 usual_comparison=None 으로 관측을 먼저
    돌려주고 기준선은 따로(백그라운드) 채운다. 느린 RPC 가 load_zone_readings 를 {} 로 만들 수 없다.
"""

from __future__ import annotations

import asyncio
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

from app.services.crowd import zone_evidence as ze
from tests.services.test_zone_evidence import F1, ZoneDB, _db

BASELINE = [{"zone_id": "seoul:POI078", "samples": 20, "p25": 100.0, "p50": 300.0, "p75": 500.0}]
# 금요일 14:40 KST
FRI_1440 = datetime(2026, 10, 30, 5, 40, tzinfo=timezone.utc)


def _load(db_now: datetime, **kw):
    return asyncio.run(ze.load_zone_readings([F1], region="seoul", wall_now=db_now, **kw))


def _snapshots_at(now: datetime) -> list[dict]:
    from tests.services.test_zone_evidence import _snap

    shift = now - datetime(2026, 10, 31, 3, 0, tzinfo=timezone.utc)
    rows = [_snap("seoul:POI078", minutes_ago=10, level=0.375, label="보통"),
            _snap("seoul:POI012", minutes_ago=5, level=0.625, label="약간 붐빔")]
    for row in rows:
        for col in ("bucket_at", "observed_at", "fetched_at"):
            row[col] = (datetime.fromisoformat(row[col]) + shift).isoformat()
    return rows


def _seoul_db(now: datetime, **kw) -> ZoneDB:
    db = _db(**kw)
    db.tables["zone_crowd_snapshots"] = _snapshots_at(now)
    return db


@pytest.fixture
def sync_refresh(monkeypatch):
    """백그라운드 갱신을 그 자리에서 돌린다(결정적 테스트)."""
    monkeypatch.setattr(ze, "_start_background", lambda fn: fn())


def _baseline_rpcs(db: ZoneDB) -> list[dict]:
    return [params for name, params in db.rpc_calls if name == "zone_population_baseline"]


# ── 항목 2: 캐시 키 = (구역, KST 시, 주말 여부) ─────────────────────────────────────────


def test_baseline_cache_is_not_reused_across_a_kst_hour_boundary(monkeypatch, sync_refresh):
    db = _seoul_db(FRI_1440, baseline=BASELINE)
    monkeypatch.setattr(ze, "supabase_admin", db)
    _load(FRI_1440)
    later = FRI_1440 + timedelta(minutes=45)  # 15:25 KST — 1시간 TTL 안이지만 시가 바뀌었다
    db.tables["zone_crowd_snapshots"] = _snapshots_at(later)
    _load(later)
    calls = _baseline_rpcs(db)
    assert len(calls) == 2
    assert calls[1]["p_at"] == later.isoformat()


def test_baseline_cache_is_reused_within_the_same_kst_hour(monkeypatch, sync_refresh):
    start = FRI_1440 - timedelta(minutes=30)  # 14:10 KST
    db = _seoul_db(start, baseline=BASELINE)
    monkeypatch.setattr(ze, "supabase_admin", db)
    _load(start)
    later = start + timedelta(minutes=45)  # 14:55 KST
    db.tables["zone_crowd_snapshots"] = _snapshots_at(later)
    _load(later)
    assert len(_baseline_rpcs(db)) == 1


def test_baseline_key_separates_weekday_and_weekend_at_the_same_hour():
    zones = ("seoul:POI078", "seoul:POI012")
    friday = ze._baseline_key(zones, FRI_1440)
    saturday = ze._baseline_key(zones, FRI_1440 + timedelta(days=1))
    next_friday = ze._baseline_key(zones, FRI_1440 + timedelta(days=7))
    assert friday != saturday
    assert friday == next_friday
    # KST 기준 — 23:30 UTC 금요일은 KST 토요일 08:30 이다.
    assert ze._baseline_key(zones, datetime(2026, 10, 30, 23, 30, tzinfo=timezone.utc))[1:] == (8, True)
    assert friday[1:] == (14, False)
    assert friday[0] == tuple(sorted(zones))


# ── 항목 3: 기준선은 순위 경로 밖 ───────────────────────────────────────────────────────


class _BlockingDB(ZoneDB):
    """기준선 RPC 가 release 될 때까지 멈춘다."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.release = threading.Event()
        self.entered = threading.Event()

    def rpc(self, name, params):
        handle = super().rpc(name, params)

        def _execute():
            self.entered.set()
            assert self.release.wait(5)
            return handle.execute()

        return type(handle)(execute=_execute)


def _wait_until(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_slow_baseline_rpc_cannot_empty_the_readings(monkeypatch):
    now = FRI_1440
    db = _BlockingDB(_seoul_db(now).tables, baseline=BASELINE)
    monkeypatch.setattr(ze, "supabase_admin", db)
    # 이 테스트만 진짜 스레드로 돈다(conftest 기본은 그 자리 실행).
    monkeypatch.setattr(ze, "_start_background", ze._start_background_thread)
    try:
        readings = _load(now, timeout=1.0)
        # 관측은 그대로 돌아온다 — 기준선이 없을 뿐(순위 근거는 잃지 않는다).
        assert F1 in readings
        assert all(r.usual_comparison is None for r in readings[F1])
        assert db.entered.wait(2)  # 기준선 RPC 는 따로 돌고 있다

        # 갱신이 도는 동안 다시 불러도 RPC 를 겹쳐 띄우지 않는다.
        again = _load(now + timedelta(seconds=5), timeout=1.0)
        assert F1 in again
        assert len(_baseline_rpcs(db)) == 1
    finally:
        db.release.set()

    key = ze._baseline_key(("seoul:POI012", "seoul:POI078", "seoul:POI007"), now)
    assert _wait_until(lambda: ze._baseline_cached(key, now) is not None)
    # 기준선이 채워진 뒤에는(구역 상태 캐시 60초 안이라도) '평소보다' 가 붙는다.
    by_zone = {r.zone_id: r for r in _load(now + timedelta(seconds=10))[F1]}
    assert by_zone["seoul:POI078"].usual_comparison == "busier"
    assert len(_baseline_rpcs(db)) == 1


def test_baseline_refresh_failure_only_drops_the_copy(monkeypatch, sync_refresh):
    db = _seoul_db(FRI_1440, rpc_error=RuntimeError("function does not exist"))
    monkeypatch.setattr(ze, "supabase_admin", db)
    readings = _load(FRI_1440)
    assert F1 in readings and all(r.usual_comparison is None for r in readings[F1])
    # 실패도 TTL 동안 기억한다 — 요청마다 RPC 를 두드리지 않는다.
    _load(FRI_1440 + timedelta(seconds=90))
    assert len(_baseline_rpcs(db)) == 1


def test_refresh_finishing_after_reset_does_not_repopulate_the_cache(monkeypatch):
    pending: list = []
    monkeypatch.setattr(ze, "_start_background", pending.append)
    db = _seoul_db(FRI_1440, baseline=BASELINE)
    monkeypatch.setattr(ze, "supabase_admin", db)
    _load(FRI_1440)
    assert len(pending) == 1
    ze.reset_cache()
    pending[0]()  # 다른 테스트·운영 도구가 캐시를 비운 뒤에 끝난 갱신
    key = ze._baseline_key(("seoul:POI012", "seoul:POI078", "seoul:POI007"), FRI_1440)
    assert ze._baseline_cached(key, FRI_1440) is None


def test_old_refresh_finishing_after_reset_keeps_the_new_generation_inflight_mark(monkeypatch):
    """reset 뒤 새 세대 갱신이 돌고 있는데 옛 세대 스레드가 끝나도, 새 세대의 '진행 중' 표시를 지우지 않는다
    (지우면 같은 키의 RPC 가 겹쳐 뜬다)."""
    pending: list = []
    monkeypatch.setattr(ze, "_start_background", pending.append)
    db = _seoul_db(FRI_1440, baseline=BASELINE)
    monkeypatch.setattr(ze, "supabase_admin", db)
    _load(FRI_1440)
    assert len(pending) == 1
    ze.reset_cache()
    _load(FRI_1440)  # 새 세대 갱신이 뜬다(아직 끝나지 않았다)
    assert len(pending) == 2
    pending[0]()  # 옛 세대 갱신이 이제 끝난다
    _load(FRI_1440 + timedelta(seconds=1))
    assert len(pending) == 2, "새 세대 갱신이 아직 도는데 같은 키의 갱신을 또 띄웠다"


def test_tests_run_baseline_refresh_synchronously_by_default():
    """conftest 기본값 — 기준선 갱신은 테스트에서 그 자리(같은 스레드)에서 돈다. 진짜 스레드가 필요한 테스트만 바꾼다."""
    ran: list = []
    ze._start_background(lambda: ran.append(threading.current_thread()))
    assert ran == [threading.current_thread()]
