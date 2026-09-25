"""무거운 관리자 조회 게이트·메모리 반환(app.core.memory_guard) 테스트.

2026-09-25 18:15 KST OOM: 관제 대시보드가 무거운 관리자 조회 7개를 한꺼번에 쏘아 각자 수천~수만 행을
쥔 채 겹쳤다. 게이트는 동시 실행을 HEAVY_ADMIN_CONCURRENCY 개로 묶고, 끝날 때마다 메모리를 반환한다.
"""

import asyncio

from app.core import memory_guard
from app.core.memory_guard import HeavyAdminGateMiddleware, is_heavy_admin_request


def test_heavy_admin_paths_are_gated_and_everything_else_passes():
    assert is_heavy_admin_request("GET", "/api/v1/admin/model-trust")
    assert is_heavy_admin_request("GET", "/api/v1/admin/dashboard/today")
    assert is_heavy_admin_request("GET", "/api/v1/admin/metrics/trend/")
    assert is_heavy_admin_request("GET", "/api/v1/admin/engine-validation/seoul/calibration")
    # CORS 사전 요청·쓰기·가벼운 관리자 조회·관광객 경로는 줄 세우지 않는다.
    assert not is_heavy_admin_request("OPTIONS", "/api/v1/admin/model-trust")
    assert not is_heavy_admin_request("POST", "/api/v1/admin/facilities")
    assert not is_heavy_admin_request("GET", "/api/v1/admin/settings")
    assert not is_heavy_admin_request("GET", "/api/v1/recommendations/by-type")
    assert not is_heavy_admin_request("GET", "/health")


def _run_burst(paths: list[str], monkeypatch, status: int = 200) -> tuple[int, int]:
    """경로마다 요청 하나씩 동시에 흘려 (최대 동시 실행 수, release_memory 호출 수) 를 돌려준다."""
    released = []
    monkeypatch.setattr(memory_guard, "release_memory", lambda: released.append(1) or True)
    state = {"active": 0, "peak": 0}

    async def inner_app(scope, receive, send):
        state["active"] += 1
        state["peak"] = max(state["peak"], state["active"])
        await asyncio.sleep(0.02)
        state["active"] -= 1
        await send({"type": "http.response.start", "status": status, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})

    gate = HeavyAdminGateMiddleware(inner_app)

    async def one(path: str):
        scope = {"type": "http", "method": "GET", "path": path}

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(_message):
            return None

        await gate(scope, receive, send)

    async def run():
        await asyncio.gather(*(one(p) for p in paths))

    asyncio.run(run())
    return state["peak"], len(released)


def test_dashboard_burst_runs_at_most_the_configured_number_at_once(monkeypatch):
    burst = [
        "/api/v1/admin/impact", "/api/v1/admin/metrics", "/api/v1/admin/model-trust",
        "/api/v1/admin/metrics/trend", "/api/v1/admin/dashboard/today",
        "/api/v1/admin/dashboard/briefing", "/api/v1/admin/area-demand-reliability",
    ]
    peak, released = _run_burst(burst, monkeypatch)

    assert peak == memory_guard.HEAVY_ADMIN_CONCURRENCY == 2
    # 반환(전체 gc + malloc_trim)은 GIL 을 쥔다 — 7개가 몰려도 마지막에 한 번만.
    assert released == 1


def test_unauthenticated_heavy_requests_do_not_trigger_memory_release(monkeypatch):
    # 게이트는 인증 앞에 있다. 401 에도 전체 gc 를 돌리면 스캐너가 관광객 요청을 멈출 수 있다.
    peak, released = _run_burst(["/api/v1/admin/model-trust"] * 5, monkeypatch, status=401)
    assert released == 0


def test_cancelled_waiter_leaves_the_queue_count_consistent(monkeypatch):
    released = []
    monkeypatch.setattr(memory_guard, "release_memory", lambda: released.append(1) or True)
    hold = None

    async def slow_app(scope, receive, send):
        await hold.wait()
        await send({"type": "http.response.start", "status": 200, "headers": []})

    gate = HeavyAdminGateMiddleware(slow_app)
    scope = {"type": "http", "method": "GET", "path": "/api/v1/admin/model-trust"}

    async def send(_m):
        return None

    async def run():
        nonlocal hold
        hold = asyncio.Event()
        running = [asyncio.create_task(gate(scope, None, send)) for _ in range(2)]
        waiter = asyncio.create_task(gate(scope, None, send))  # 세 번째는 줄에서 기다린다
        await asyncio.sleep(0.01)
        waiter.cancel()  # 클라이언트가 끊었다
        await asyncio.gather(waiter, return_exceptions=True)
        hold.set()
        await asyncio.gather(*running)
        return gate._pending

    assert asyncio.run(run()) == 0
    assert released == [1]  # 줄이 비었으니 마지막 성공 요청 뒤에 한 번 반환


def test_light_requests_are_not_serialized_or_trimmed(monkeypatch):
    burst = ["/api/v1/recommendations/by-type"] * 6
    peak, released = _run_burst(burst, monkeypatch)

    assert peak == 6
    assert released == 0


def test_slot_is_returned_even_when_the_handler_raises(monkeypatch):
    monkeypatch.setattr(memory_guard, "release_memory", lambda: True)

    async def boom(scope, receive, send):
        raise RuntimeError("handler failed")

    gate = HeavyAdminGateMiddleware(boom)
    scope = {"type": "http", "method": "GET", "path": "/api/v1/admin/model-trust"}

    async def run():
        for _ in range(memory_guard.HEAVY_ADMIN_CONCURRENCY + 1):
            try:
                await asyncio.wait_for(gate(scope, None, None), timeout=1)
            except RuntimeError:
                pass
        return memory_guard._gate.get()._value

    # 슬롯이 새면 세 번째 호출이 영원히 기다려 wait_for 가 TimeoutError 를 낸다.
    assert asyncio.run(run()) == memory_guard.HEAVY_ADMIN_CONCURRENCY


def test_release_memory_never_raises(monkeypatch):
    # glibc 가 없는 환경(Windows 개발기)에서는 gc 만 하고 False, 있으면 True — 어느 쪽이든 예외는 없다.
    assert memory_guard.release_memory() in (True, False)

    def broken_trim(_pad):
        raise OSError("no libc")

    monkeypatch.setattr(memory_guard, "_resolve_malloc_trim", lambda: broken_trim)
    assert memory_guard.release_memory() is False
