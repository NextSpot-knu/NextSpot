"""asyncio 기본 executor 상한(app.main._install_bounded_executor) 테스트.

배경(2026-09-21 실측 인시던트): Render nextspot-api(0.5 CPU / 512MB, 단일 uvicorn
워커)가 15~60분마다 "Ran out of memory" 로 재시작됐다. asyncio.to_thread 의 기본
executor 는 스레드를 최대 32개까지 늘리는데, 관리자 대시보드 하루 집계
(aggregate_estimated_day, 호출당 +96MB transient)와 백테스트가 동시에 여러 개
asyncio.to_thread 로 뜨면 그 스레드들이 겹쳐 순간 메모리가 512MB 를 넘는다.
_install_bounded_executor 가 스레드 수를 8개로 묶어 그 폭을 줄인다.
"""

import asyncio
import concurrent.futures

from app.main import _IO_EXECUTOR_MAX_WORKERS, _install_bounded_executor


def test_install_bounded_executor_sets_max_workers_and_default_executor():
    loop = asyncio.new_event_loop()
    try:
        executor = _install_bounded_executor(loop)

        assert isinstance(executor, concurrent.futures.ThreadPoolExecutor)
        assert executor._max_workers == _IO_EXECUTOR_MAX_WORKERS
        assert loop._default_executor is executor
    finally:
        executor.shutdown(wait=False, cancel_futures=False)
        loop.close()


def test_asyncio_to_thread_still_works_after_install():
    loop = asyncio.new_event_loop()
    try:
        executor = _install_bounded_executor(loop)
        result = loop.run_until_complete(asyncio.to_thread(lambda: 42))

        assert result == 42
    finally:
        executor.shutdown(wait=False, cancel_futures=False)
        loop.close()
