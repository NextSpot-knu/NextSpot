"""적재 전용 **데몬** 스레드 1개짜리 실행기(app/services/reference_snapshot.py 에서 옮김 — 동작 불변).

참조 스냅샷(nextspot-ref)과 주차 이력(nextspot-parking)이 각자 한 개씩 만들어 쓴다. 같은 스레드를 나누지
않으므로 한쪽의 느린 Supabase 읽기가 다른 쪽 적재를 줄 세우지 않는다.
"""

from __future__ import annotations

import queue
import threading
from concurrent.futures import Executor, Future


class DaemonExecutor(Executor):
    """적재 전용 **데몬** 스레드 1개짜리 실행기.

    concurrent.futures.ThreadPoolExecutor 의 워커는 비데몬이고 인터프리터가 끝날 때 join 된다 — Supabase 호출
    하나가 매달려 있으면(httpx 타임아웃 단계당 120초) lifespan 이 끝나도 프로세스가 그만큼 남는다(배포가 겹칠 때
    옛 인스턴스가 늦게 빠진다 — 리뷰 재현: stop() 0초, 프로세스 종료 8초). 적재는 읽기 전용이라 종료 때
    버려도 잃는 것이 없다. 작업은 넣은 순서대로 하나씩 돈다(단일 비행).
    """

    def __init__(self, name: str) -> None:
        self._queue: queue.SimpleQueue = queue.SimpleQueue()
        self._lock = threading.Lock()
        self._closed = False
        self._thread = threading.Thread(target=self._work, name=name, daemon=True)
        self._thread.start()

    def submit(self, fn, /, *args, **kwargs) -> Future:
        with self._lock:
            if self._closed:
                raise RuntimeError("cannot schedule new futures after shutdown")
            future: Future = Future()
            self._queue.put((future, fn, args, kwargs))
            return future

    def _work(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                return
            future, fn, args, kwargs = item
            if not future.set_running_or_notify_cancel():
                continue
            try:
                result = fn(*args, **kwargs)
            except BaseException as exc:  # noqa: BLE001 — 호출한 쪽(await)이 받는다
                future.set_exception(exc)
            else:
                future.set_result(result)

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        with self._lock:
            if not self._closed:
                self._closed = True
                if cancel_futures:
                    while True:
                        try:
                            item = self._queue.get_nowait()
                        except queue.Empty:
                            break
                        if item is not None:
                            item[0].cancel()
                self._queue.put(None)
        if wait and self._thread is not threading.current_thread():
            self._thread.join()
