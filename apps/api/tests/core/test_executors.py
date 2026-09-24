"""관리자·집계 전용 풀(app.core.executors) 테스트.

관광객 요청(추천·대기 보드·코스)은 asyncio 기본 executor 를 쓴다. 관리자 대시보드·리포트의
블로킹 조회와 무거운 추정 집계가 그 풀을 차지하면 관광객 요청이 뒤에 줄 서므로(2026-09-24 OOM
대응 리뷰), 둘을 전용 풀로 떼어 냈다. 여기서는 그 분리가 실제로 지켜지는지 본다.
"""

import asyncio
import contextvars
import pathlib
import threading

from app.core import executors

_VAR: contextvars.ContextVar[str] = contextvars.ContextVar("_VAR", default="unset")


def _thread_name() -> str:
    return threading.current_thread().name


def test_run_heavy_and_admin_io_use_their_own_bounded_pools():
    async def run():
        return await executors.run_heavy(_thread_name), await executors.run_admin_io(_thread_name)

    heavy, admin = asyncio.run(run())

    assert heavy.startswith("nextspot-heavy")
    assert admin.startswith("nextspot-admin")
    assert executors.heavy_pool()._max_workers == executors.HEAVY_MAX_WORKERS == 2
    assert executors.admin_io_pool()._max_workers == executors.ADMIN_IO_MAX_WORKERS


def test_contextvars_are_copied_like_to_thread():
    async def run():
        _VAR.set("request-scoped")
        return await executors.run_admin_io(_VAR.get)

    assert asyncio.run(run()) == "request-scoped"


def test_pools_are_recreated_after_shutdown():
    """lifespan 종료 뒤 TestClient 를 다시 열어도(테스트) 풀이 되살아나야 한다."""
    asyncio.run(executors.run_heavy(lambda: None))
    first = executors.heavy_pool()
    executors.shutdown_executors()
    second = executors.heavy_pool()

    assert second is not first
    assert asyncio.run(executors.run_heavy(lambda: 7)) == 7


def test_heavy_pool_caps_concurrency_at_two():
    running = 0
    peak = 0
    lock = threading.Lock()
    gate = threading.Event()

    def work():
        nonlocal running, peak
        with lock:
            running += 1
            peak = max(peak, running)
        gate.wait(0.05)
        with lock:
            running -= 1

    async def run():
        await asyncio.gather(*(executors.run_heavy(work) for _ in range(6)))

    asyncio.run(run())
    assert peak <= executors.HEAVY_MAX_WORKERS


def test_admin_router_never_uses_the_default_executor():
    """admin 라우터의 블로킹 조회가 기본 executor(관광객 요청 풀)로 새지 않게 막는 정적 가드."""
    source = pathlib.Path(__file__).resolve().parents[2].joinpath("app", "routers", "admin.py").read_text(
        encoding="utf-8"
    )
    assert "asyncio.to_thread(" not in source
    assert "run_in_executor(None" not in source
