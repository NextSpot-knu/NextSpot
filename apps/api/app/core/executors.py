"""관리자·리포트용 **전용** 스레드풀 — 관광객 요청이 쓰는 기본 executor 를 굶기지 않게.

배경(2026-09-24, Render nextspot-api 512MB OOM 재시작): asyncio 기본 executor
(app.main._IO_EXECUTOR_MAX_WORKERS=16)는 관광객 요청의 Supabase 동기 호출(asyncio.to_thread)과
모든 httpx.AsyncClient 의 DNS 조회(loop.getaddrinfo)가 함께 쓰는 **공용 풀**이다. 관리자 탭 하나가
여기에 블로킹 조회 5~8개를 한꺼번에 올리고(/admin/model-trust 5개), 여러 날 추정 리포트가 수 초짜리
CPU 집계를 같은 풀에 올리면, 그동안 추천·대기 보드·코스 요청이 그 뒤에 줄을 선다. 동시에 뜬
무거운 작업 수만큼 메모리 피크도 겹친다.

그래서 성격별로 풀을 나눈다.

  · HEAVY(2)    — 하루/여러 날 추정 집계처럼 수 초 CPU + 수십 MB 를 쓰는 작업. 동시 실행이 2개로
                  고정되므로 순간 메모리 피크도 2개분으로 고정된다.
  · ADMIN_IO(4) — 관리자 대시보드·리포트의 Supabase 블로킹 조회. 관리자 탭이 몇 개가 겹치든 이
                  4개 안에서 줄 서고, 관광객 요청이 쓰는 기본 풀은 건드리지 않는다.

**재진입 금지:** 이 풀에서 도는 함수(동기)는 같은 풀에 작업을 넣고 기다리면 안 된다 — 워커가 전부
자기 자신을 기다리는 교착이 된다. 지금 올리는 함수들은 모두 순수 동기 함수라 풀에 다시 제출할 수단이
없다(`run_heavy`/`run_admin_io` 는 이벤트 루프에서만 부를 수 있는 코루틴이다). 새 호출부도 이 규칙을
지킨다: 풀 안에서는 동기 코드만, 풀 제출은 이벤트 루프에서만.

풀은 **게으르게** 만든다 — import 만으로 스레드를 띄우면 이 경로를 쓰지 않는 배치 스크립트·테스트까지
워커 스레드를 물고 시작한다. 앱 종료(lifespan) 때 `shutdown_executors()` 로 닫고, 닫힌 뒤 다시
필요해지면(테스트가 TestClient 를 여러 번 여는 경우) 새로 만든다.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextvars
import functools
import threading
from collections.abc import Callable
from typing import Any, TypeVar

T = TypeVar("T")

HEAVY_MAX_WORKERS = 2
ADMIN_IO_MAX_WORKERS = 4


class _LazyPool:
    """최초 사용 때 만들고, 종료 후 다시 쓰이면 새로 만드는 ThreadPoolExecutor 홀더."""

    def __init__(self, name: str, max_workers: int) -> None:
        self.name = name
        self.max_workers = max_workers
        self._pool: concurrent.futures.ThreadPoolExecutor | None = None
        self._lock = threading.Lock()

    def get(self) -> concurrent.futures.ThreadPoolExecutor:
        with self._lock:
            if self._pool is None:
                self._pool = concurrent.futures.ThreadPoolExecutor(
                    max_workers=self.max_workers, thread_name_prefix=self.name
                )
            return self._pool

    def shutdown(self) -> None:
        with self._lock:
            pool, self._pool = self._pool, None
        if pool is not None:
            # 종료 중에는 아직 시작하지 않은 무거운 작업을 새로 띄울 이유가 없다.
            pool.shutdown(wait=False, cancel_futures=True)


_HEAVY = _LazyPool("nextspot-heavy", HEAVY_MAX_WORKERS)
_ADMIN_IO = _LazyPool("nextspot-admin", ADMIN_IO_MAX_WORKERS)


def heavy_pool() -> concurrent.futures.ThreadPoolExecutor:
    return _HEAVY.get()


def admin_io_pool() -> concurrent.futures.ThreadPoolExecutor:
    return _ADMIN_IO.get()


async def _run_in(pool: concurrent.futures.ThreadPoolExecutor, func: Callable[..., T], /, *args: Any, **kwargs: Any) -> T:
    """`asyncio.to_thread` 와 같은 의미(contextvars 복사 포함)로 지정한 풀에서 실행한다."""
    loop = asyncio.get_running_loop()
    ctx = contextvars.copy_context()
    return await loop.run_in_executor(pool, functools.partial(ctx.run, func, *args, **kwargs))


async def run_heavy(func: Callable[..., T], /, *args: Any, **kwargs: Any) -> T:
    """무거운 CPU·메모리 집계 전용(동시 2개)."""
    return await _run_in(heavy_pool(), func, *args, **kwargs)


async def run_admin_io(func: Callable[..., T], /, *args: Any, **kwargs: Any) -> T:
    """관리자·리포트의 블로킹 조회 전용(동시 4개) — 기본 executor(관광객 요청) 와 분리."""
    return await _run_in(admin_io_pool(), func, *args, **kwargs)


def shutdown_executors() -> None:
    """lifespan 종료 때 호출. 실패해도 다른 풀 종료는 계속한다."""
    for holder in (_HEAVY, _ADMIN_IO):
        try:
            holder.shutdown()
        except Exception:  # noqa: BLE001 — 종료 경로에서 예외로 나머지 정리를 막지 않는다
            pass
