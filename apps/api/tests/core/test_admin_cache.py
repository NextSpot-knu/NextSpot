"""관리자 집계 캐시(app/core/admin_cache.py) — 재사용·키 분리·쓰기 무효화·쓰기 중 계산의 옛 값 차단."""

import asyncio

import pytest

from app.core import admin_cache


@pytest.fixture
def live_cache(monkeypatch):
    admin_cache.invalidate()
    monkeypatch.setattr(admin_cache._cache, "ttl_seconds", 60.0)  # conftest 가 0 으로 끈 것을 되살린다
    yield
    admin_cache.invalidate()


def test_repeat_calls_reuse_the_first_answer_and_params_split_keys(live_cache):
    calls = []

    @admin_cache.cached_admin_view("t/metrics")
    async def handler(days: int = 28, _user=object()):
        calls.append(days)
        return {"days": days, "n": len(calls)}

    async def run():
        a = await handler(days=7)
        b = await handler(days=7)
        c = await handler(days=30)
        return a, b, c

    a, b, c = asyncio.run(run())
    assert a == b and calls == [7, 30]
    assert c["days"] == 30


def test_concurrent_identical_requests_compute_once(live_cache):
    calls = []

    @admin_cache.cached_admin_view("t/model-trust")
    async def handler(days: int = 30):
        calls.append(days)
        await asyncio.sleep(0.02)
        return {"ok": True}

    async def run():
        return await asyncio.gather(*(handler(days=30) for _ in range(5)))

    results = asyncio.run(run())
    assert calls == [30] and all(r == {"ok": True} for r in results)


def test_admin_write_invalidates_and_in_flight_result_is_not_served_after_it(live_cache):
    calls = []
    release = None

    @admin_cache.cached_admin_view("t/today")
    async def handler():
        calls.append(1)
        n = len(calls)
        if n == 1:
            await release.wait()  # 쓰기가 끝날 때까지 계산이 걸려 있다
        return {"version": n}

    async def run():
        nonlocal release
        release = asyncio.Event()
        slow = asyncio.create_task(handler())
        await asyncio.sleep(0.01)
        admin_cache.invalidate()  # 관리자 쓰기 성공
        release.set()
        old = await slow
        fresh = await handler()
        return old, fresh

    old, fresh = asyncio.run(run())
    assert old == {"version": 1}
    assert fresh == {"version": 2}  # 쓰기 전에 시작한 계산의 값이 쓰기 뒤 요청에 나가지 않는다
