"""관리자 집계 합류(app/core/admin_coalesce.py) — 저장하지 않고, 동시 중복만 합치고, 쓰기 뒤에는 새로 계산한다."""

import asyncio

from app.core import admin_coalesce


def test_sequential_calls_always_recompute_so_freshness_is_unchanged():
    calls = []

    @admin_coalesce.coalesced_admin_view("t/metrics")
    async def handler(days: int = 28, _user=object()):
        calls.append(days)
        return {"days": days, "n": len(calls)}

    async def run():
        return await handler(days=7), await handler(days=7), await handler(days=30)

    a, b, c = asyncio.run(run())
    assert calls == [7, 7, 30]  # 결과를 저장하지 않는다 — 두 번째 호출도 새로 계산
    assert a == {"days": 7, "n": 1} and b == {"days": 7, "n": 2} and c["days"] == 30
    assert admin_coalesce._inflight == {}  # 흔적이 남지 않는다


def test_concurrent_identical_requests_compute_once_and_get_independent_copies():
    calls = []

    @admin_coalesce.coalesced_admin_view("t/model-trust")
    async def handler(days: int = 30):
        calls.append(days)
        await asyncio.sleep(0.02)
        return {"ok": True, "rows": [1, 2]}

    async def run():
        return await asyncio.gather(*(handler(days=30) for _ in range(5)), handler(days=7))

    results = asyncio.run(run())
    assert calls == [30, 7]  # 같은 파라미터 5개는 한 번, 다른 파라미터는 따로
    first = results[0]
    for other in results[1:5]:
        assert other == first and other is not first  # 합류한 쪽은 복사본


def test_errors_reach_every_joiner_and_are_not_remembered():
    calls = []

    @admin_coalesce.coalesced_admin_view("t/today")
    async def handler():
        calls.append(1)
        await asyncio.sleep(0.01)
        if len(calls) == 1:
            raise RuntimeError("boom")
        return {"ok": True}

    async def run():
        first = await asyncio.gather(handler(), handler(), return_exceptions=True)
        second = await handler()
        return first, second

    first, second = asyncio.run(run())
    assert all(isinstance(r, RuntimeError) for r in first)
    assert second == {"ok": True} and calls == [1, 1]


def test_requests_after_an_admin_write_do_not_join_a_computation_started_before_it():
    calls = []
    release = None

    @admin_coalesce.coalesced_admin_view("t/today")
    async def handler():
        calls.append(1)
        n = len(calls)
        if n == 1:
            await release.wait()
        return {"version": n}

    async def run():
        nonlocal release
        release = asyncio.Event()
        slow = asyncio.create_task(handler())
        await asyncio.sleep(0.01)
        admin_coalesce.invalidate()  # 관리자 쓰기 성공
        fresh = asyncio.create_task(handler())
        await asyncio.sleep(0.01)
        release.set()
        return await slow, await fresh

    old, fresh = asyncio.run(run())
    assert old == {"version": 1}
    assert fresh == {"version": 2}


def test_cancelled_starter_does_not_fail_the_requests_that_joined():
    calls = []

    @admin_coalesce.coalesced_admin_view("t/model-trust")
    async def handler():
        calls.append(1)
        await asyncio.sleep(0.05)
        return {"ok": True}

    async def run():
        starter = asyncio.create_task(handler())
        await asyncio.sleep(0.01)
        joiner = asyncio.create_task(handler())
        await asyncio.sleep(0.01)
        starter.cancel()  # 시작한 요청의 클라이언트가 끊겼다
        joined = await joiner
        cancelled = starter.cancelled() or isinstance(
            (await asyncio.gather(starter, return_exceptions=True))[0], asyncio.CancelledError)
        return joined, cancelled

    joined, cancelled = asyncio.run(run())
    assert cancelled
    assert joined == {"ok": True} and calls == [1]  # 계산은 끝까지 갔고 합류한 요청은 결과를 받았다
