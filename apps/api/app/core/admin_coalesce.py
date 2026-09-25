"""관리자 집계 GET 의 동시 중복 합류(single-flight) — 같은 조회가 겹칠 때만 한 번 계산해 나눠 준다.

관제 대시보드는 열 때마다 무거운 관리자 GET 7개를 쏘고, 새로고침·패널 재마운트·재시도가 겹치면 **같은**
조회가 동시에 여러 번 돈다. 각자 수천 행을 받아 쥐므로 메모리가 겹친 수만큼 늘었다(2026-09-25 OOM).

이 모듈은 결과를 **저장하지 않는다**(TTL 캐시가 아니다). 계산이 진행 중인 동안 도착한 같은 요청만 그 계산에
합류하고, 끝나면 흔적이 남지 않는다 — 다음 요청은 언제나 새로 계산하므로 응답의 신선도는 캐시가 없던
때와 같다(겹친 요청이 몇 초 먼저 시작된 계산의 값을 받는 것은 동시 요청 사이의 평범한 경합과 같다).

안전 규칙:
  · 합류는 **핸들러 안**(FastAPI 의존성 = require_role 통과 뒤)에서만 — 권한 없는 요청이 합류할 수 없다.
    관리자 전체 공통 집계에만 쓴다(사용자별 응답에는 쓰지 않는다).
  · 키 = 세대 번호 + 엔드포인트 이름 + 쿼리 인자(원시 값만). 의존성 주입 값은 키에 넣지 않는다.
  · 관리자 쓰기가 성공하면 세대를 올린다(app.core.memory_guard) — 쓰기 전에 시작한 계산에 쓰기 뒤의
    요청이 합류하지 않는다.
  · 합류한 쪽은 결과의 깊은 복사본을 받는다(한 객체를 두 응답이 공유하지 않는다). 예외는 합류한 쪽에도
    그대로 올라간다. 합류한 요청이 끊겨도(취소) 진행 중인 계산은 취소되지 않는다.
  · 모든 상태는 이벤트 루프 스레드에서만 바뀐다(잠금 불필요).
"""

from __future__ import annotations

import asyncio
import copy
import functools
from collections.abc import Awaitable, Callable, Hashable
from datetime import date, datetime
from typing import Any, TypeVar

_KEY_TYPES = (str, int, float, bool, type(None), date, datetime)

# 쓰기마다 올라가는 세대 번호 — 키에 들어간다.
_generation = 0
_inflight: dict[Hashable, asyncio.Future] = {}

F = TypeVar("F", bound=Callable[..., Awaitable[Any]])


def _consume_exception(future: asyncio.Future) -> None:
    # 합류자가 없는 실패가 "exception was never retrieved" 경고를 남기지 않게.
    if not future.cancelled():
        future.exception()


def coalesced_admin_view(name: str) -> Callable[[F], F]:
    """async 관리자 GET 핸들러의 동시 중복을 합친다. `@router.get(...)` 아래(핸들러 바로 위)에 붙인다.

    functools.wraps 가 __wrapped__ 를 남기므로 FastAPI 는 원래 시그니처(쿼리 인자·Depends)를 그대로 본다.
    """

    def decorate(handler: F) -> F:
        @functools.wraps(handler)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            params = tuple(sorted((k, v) for k, v in kwargs.items() if isinstance(v, _KEY_TYPES)))
            key = (_generation, name, params)
            running = _inflight.get(key)
            if running is not None:
                return copy.deepcopy(await asyncio.shield(running))

            future = asyncio.get_running_loop().create_future()
            future.add_done_callback(_consume_exception)
            _inflight[key] = future
            try:
                value = await handler(*args, **kwargs)
            except BaseException as exc:
                if not future.done():
                    future.set_exception(exc)
                raise
            else:
                if not future.done():
                    future.set_result(value)
                return value
            finally:
                if _inflight.get(key) is future:
                    _inflight.pop(key, None)

        return wrapper  # type: ignore[return-value]

    return decorate


def invalidate() -> None:
    """관리자 쓰기가 성공했을 때 부른다 — 이후 요청은 쓰기 전에 시작한 계산에 합류하지 않는다."""
    global _generation
    _generation += 1


def reset_for_tests() -> None:
    global _generation
    _generation = 0
    _inflight.clear()
