"""관리자 집계 응답의 짧은 캐시 — 같은 관제 화면을 다시 열어도 무거운 조회를 다시 돌리지 않는다.

관제 대시보드는 열 때마다 무거운 관리자 GET 7개를 쏘고 클라이언트 캐시가 없다(새로고침·사이드바 이동마다
전부 다시). 2026-09-25 18:15 KST OOM 직후에도 같은 화면을 다시 열어 RSS 가 95→420MB 로 뛰었다.
집계 값은 초 단위로 바뀌지 않으므로 ADMIN_CACHE_TTL_SECONDS 동안은 첫 응답을 그대로 돌려준다.

안전 규칙:
  · 캐시는 **핸들러 안**(FastAPI 의존성 = require_role 이 통과한 뒤)에서만 읽는다 — 권한 없는 요청에
    캐시된 응답이 나갈 경로가 없다. 캐시 값은 관리자 전체 공통 집계뿐이다(사용자별 응답에는 쓰지 않는다).
  · 키 = 엔드포인트 이름 + 쿼리 인자(원시 값만). 의존성 주입 값(사용자 객체 등)은 키에 넣지 않는다.
  · 관리자 쓰기(시설 수정·혼잡 개입·설정·피크 시뮬레이션 등)가 성공하면 통째로 비운다
    (app.core.memory_guard 미들웨어가 호출) — 데모에서 '누르면 바로 반영' 이 깨지지 않게.
  · 같은 키의 동시 요청은 하나만 계산하고 나머지는 합류한다(ResponseCache 의 single-flight).
  · 예외는 캐시하지 않는다. 캐시를 전부 잃어도 시간만 더 든다(정확성 장치가 아니다).
"""

from __future__ import annotations

import functools
from collections.abc import Awaitable, Callable
from datetime import date, datetime
from typing import Any, TypeVar

from app.core.response_cache import ResponseCache

# 60초: 새로고침·패널 재진입은 잡고, 10분 수집·제보가 화면에 늦어도 1분 안에 보인다.
# 신뢰도 패널이 60초마다 폴링하므로 이보다 길게 잡을 이유도 없다.
ADMIN_CACHE_TTL_SECONDS = 60.0

_cache = ResponseCache("admin_analytics", ttl_seconds=ADMIN_CACHE_TTL_SECONDS, max_entries=48)
# 쓰기마다 올라가는 세대 번호. 키에 들어가므로, 쓰기 전에 시작해 쓰기 뒤에 끝난 계산은 옛 세대 키에 저장돼
# 새 요청에 절대 나가지 않는다(clear 만으로는 진행 중이던 계산이 끝나며 옛 값을 다시 넣는다).
_generation = 0

_KEY_TYPES = (str, int, float, bool, type(None), date, datetime)

F = TypeVar("F", bound=Callable[..., Awaitable[Any]])


def cached_admin_view(name: str) -> Callable[[F], F]:
    """async 관리자 GET 핸들러를 짧게 캐시한다. `@router.get(...)` 아래(핸들러 바로 위)에 붙인다.

    functools.wraps 가 __wrapped__ 를 남기므로 FastAPI 는 원래 시그니처(쿼리 인자·Depends)를 그대로 본다.
    """

    def decorate(handler: F) -> F:
        @functools.wraps(handler)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            params = tuple(sorted((k, v) for k, v in kwargs.items() if isinstance(v, _KEY_TYPES)))
            key = (_generation, name, params)
            return await _cache.get_or_compute(key, lambda: handler(*args, **kwargs))

        return wrapper  # type: ignore[return-value]

    return decorate


def invalidate() -> None:
    """관리자 쓰기가 성공했을 때 부른다 — 다음 조회는 새로 계산한다."""
    global _generation
    _generation += 1
    _cache.clear()
