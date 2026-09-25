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


async def _receive_ok():
    return {"type": "http.request", "body": b"", "more_body": False}


def _run_burst(paths: list[str], monkeypatch, status: int = 200) -> tuple[int, int]:
    """경로마다 요청 하나씩 동시에 흘려 (최대 동시 실행 수, release_memory 호출 수) 를 돌려준다."""
    released = []
    monkeypatch.setattr(memory_guard, "release_memory", lambda *_a, **_k: released.append(1) or True)
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
    monkeypatch.setattr(memory_guard, "release_memory", lambda *_a, **_k: released.append(1) or True)
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
        running = [asyncio.create_task(gate(scope, _receive_ok, send)) for _ in range(2)]
        waiter = asyncio.create_task(gate(scope, _receive_ok, send))  # 세 번째는 줄에서 기다린다
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
    monkeypatch.setattr(memory_guard, "release_memory", lambda *_a, **_k: True)

    async def boom(scope, receive, send):
        raise RuntimeError("handler failed")

    gate = HeavyAdminGateMiddleware(boom)
    scope = {"type": "http", "method": "GET", "path": "/api/v1/admin/model-trust"}

    async def run():
        for _ in range(memory_guard.HEAVY_ADMIN_CONCURRENCY + 1):
            try:
                await asyncio.wait_for(gate(scope, _receive_ok, None), timeout=1)
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


def test_request_whose_client_left_while_queued_is_skipped(monkeypatch):
    """줄 서는 동안 연결이 끊긴 요청은 슬롯을 얻어도 핸들러를 돌리지 않는다(uvicorn 은 끊김에 태스크를 취소하지 않는다)."""
    released = []
    monkeypatch.setattr(memory_guard, "release_memory", lambda *_a, **_k: released.append(1) or True)
    ran = []

    async def inner_app(scope, receive, send):
        msg = await receive()  # 핸들러는 게이트가 먼저 꺼낸 첫 메시지를 그대로 받는다
        ran.append(msg["type"])
        await asyncio.sleep(0.02)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})

    gate = HeavyAdminGateMiddleware(inner_app)
    scope = {"type": "http", "method": "GET", "path": "/api/v1/admin/model-trust"}

    async def gone():
        return {"type": "http.disconnect"}

    async def sink(_message):
        return None

    async def run():
        await asyncio.gather(gate(scope, _receive_ok, sink), gate(scope, _receive_ok, sink), gate(scope, gone, sink))
        return memory_guard._gate.get()._value, gate._pending

    assert asyncio.run(run()) == (memory_guard.HEAVY_ADMIN_CONCURRENCY, 0)
    assert ran == ["http.request", "http.request"]
    assert len(released) == 1


def _call_gate(gate, method, path):
    sent = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    asyncio.run(gate({"type": "http", "method": method, "path": path}, receive, send))
    return sent


def test_heavy_admin_request_is_shed_with_503_when_memory_stays_high(monkeypatch):
    ran = []

    async def inner_app(scope, receive, send):
        ran.append(scope["path"])
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})

    monkeypatch.setattr(memory_guard, "release_memory", lambda *_a, **_k: True)
    monkeypatch.setattr(memory_guard, "current_rss_mb", lambda: memory_guard.HEAVY_ADMIN_SHED_RSS_MB + 20)
    sent = _call_gate(HeavyAdminGateMiddleware(inner_app), "GET", "/api/v1/admin/model-trust")

    assert ran == []  # 무거운 조회를 시작하지 않았다
    assert sent[0]["status"] == 503
    assert (b"retry-after", b"5") in sent[0]["headers"]

    # 관광객 경로는 메모리가 높아도 절대 거절하지 않는다.
    sent = _call_gate(HeavyAdminGateMiddleware(inner_app), "GET", "/api/v1/recommendations/by-type")
    assert sent[0]["status"] == 200 and ran == ["/api/v1/recommendations/by-type"]


def test_trim_before_start_can_bring_memory_back_under_the_limit(monkeypatch):
    readings = iter([memory_guard.HEAVY_ADMIN_TRIM_RSS_MB + 50, memory_guard.HEAVY_ADMIN_TRIM_RSS_MB - 10])
    released = []
    monkeypatch.setattr(memory_guard, "current_rss_mb", lambda: next(readings, 100.0))
    monkeypatch.setattr(memory_guard, "release_memory", lambda *a, **_k: released.append(a) or True)

    async def inner_app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})

    sent = _call_gate(HeavyAdminGateMiddleware(inner_app), "GET", "/api/v1/admin/dashboard/today")
    assert sent[0]["status"] == 200
    assert released[0] == ("admin_preflight",)


def test_successful_admin_write_advances_the_admin_coalesce_generation(monkeypatch):
    from app.core import admin_coalesce

    cleared = []
    monkeypatch.setattr(admin_coalesce, "invalidate", lambda: cleared.append(1))

    def app_with(status):
        async def inner_app(scope, receive, send):
            await send({"type": "http.response.start", "status": status, "headers": []})
        return inner_app

    _call_gate(HeavyAdminGateMiddleware(app_with(200)), "POST", "/api/v1/admin/simulate-peak")
    _call_gate(HeavyAdminGateMiddleware(app_with(403)), "POST", "/api/v1/admin/simulate-peak")
    _call_gate(HeavyAdminGateMiddleware(app_with(200)), "POST", "/api/v1/reports")
    assert cleared == [1]  # 성공한 관리자 쓰기만


def test_preflight_trim_is_rate_limited_so_unauthenticated_floods_cannot_force_repeated_gc(monkeypatch):
    """게이트는 인증 앞에서 돈다 — 메모리가 높은 동안 무인증 요청이 몰려도 전체 gc+trim 은 5초에 한 번뿐."""
    released = []
    monkeypatch.setattr(memory_guard, "release_memory", lambda *a, **_k: released.append(a) or True)
    monkeypatch.setattr(memory_guard, "current_rss_mb", lambda: memory_guard.HEAVY_ADMIN_TRIM_RSS_MB + 10)

    async def unauthorized(scope, receive, send):
        await send({"type": "http.response.start", "status": 401, "headers": []})

    gate = HeavyAdminGateMiddleware(unauthorized)
    for _ in range(20):
        sent = _call_gate(gate, "GET", "/api/v1/admin/model-trust")
        assert sent[0]["status"] == 401  # 차단 문턱(SHED) 아래라 그대로 통과
    assert released == [("admin_preflight",)]  # 20번 중 사전 반환은 한 번
