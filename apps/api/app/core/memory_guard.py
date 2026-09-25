"""무거운 관리자 조회의 동시 실행 상한 + 끝난 뒤 메모리 반환 — 512MB 단일 인스턴스 OOM 방어.

배경(2026-09-25 18:15 KST, Render nextspot-api OOM 재시작 실측):
관제 대시보드는 열릴 때 무거운 관리자 조회 7개(model-trust·metrics·metrics/trend·impact·
dashboard/today·dashboard/briefing·area-demand-reliability)를 **한꺼번에** 쏜다. 각 조회는 수천~
수만 행을 받아 요청이 끝날 때까지 쥐고 있으므로, 순간 메모리는 '가장 큰 하나' 가 아니라 '일곱 개의
합' 이다. 워밍업이 남긴 ~335MB 위에서 이 합이 얹혀 512MB 를 넘었다(09-22 09:40 OOM 도 같은 패턴).
재시작 직후 같은 화면을 다시 열자 RSS 가 95MB → 420MB 로 뛰고 **내려오지 않았다** — glibc 가 해제된
힙을 OS 에 돌려주지 않아서다.

두 가지로 막는다.

  · 동시 실행 상한(HEAVY_ADMIN_CONCURRENCY): 아래 경로의 GET 은 프로세스 전체에서 동시에 N 개만
    처리한다. 나머지는 줄 선다(거절하지 않는다 — 대시보드가 실패로 보고 재시도 폭풍을 만들지 않게).
    순간 피크가 '일곱 개의 합' 에서 'N 개의 합' 으로 고정된다. 관리자 API 제한 시간(25초,
    apps/web/lib/admin-api.ts)을 넘기지 않도록 N=2 로 둔다.
  · 메모리 반환(release_memory): 무거운 요청이 끝날 때마다 gc 후 glibc malloc_trim(0) 으로 빈 힙을
    OS 에 돌려준다 — 한 번 오른 RSS 가 계단식으로 쌓이는(270→335→[OOM]→420→480MB) 현상을 끊는다.
    glibc 가 아닌 환경(Windows 개발기·musl)에서는 gc 만 한다.

인증과의 관계: 이 게이트는 라우터 의존성(require_role) **앞**에서 줄만 세운다. 응답을 캐시하거나
대신 만들지 않으므로 권한 우회 경로가 없다. 인증 실패 요청은 빨리 끝나 슬롯을 곧바로 돌려준다.

CORS 사전 요청(OPTIONS)·쓰기(POST 등)·관광객 경로는 건드리지 않는다.
"""

from __future__ import annotations

import asyncio
import ctypes
import ctypes.util
import gc
import sys
import time
from typing import Any

import structlog

logger = structlog.get_logger(__name__)

# 동시에 처리할 무거운 관리자 조회 수. 1 이면 가장 안전하지만 대시보드 패널 ~9개가 한 줄로 서서
# 느린 패널(여러 날 리포트 10초 타임아웃·LLM 브리핑)이 뒤 패널을 25초 제한 너머로 밀 수 있다.
HEAVY_ADMIN_CONCURRENCY = 2

# 행 수천~수만 개를 끌어와 요청 동안 쥐는 관리자 조회. 정확 일치 경로 + 접두 경로.
_HEAVY_ADMIN_PATHS = frozenset({
    "/api/v1/admin/model-trust",
    "/api/v1/admin/metrics",
    "/api/v1/admin/metrics/trend",
    "/api/v1/admin/impact",
    "/api/v1/admin/reports/estimated",
    "/api/v1/admin/dashboard/today",
    "/api/v1/admin/dashboard/briefing",
    "/api/v1/admin/area-demand-reliability",
    "/api/v1/admin/area-demand-forecast-quality",
    "/api/v1/admin/safety/status",
})
_HEAVY_ADMIN_PREFIXES = ("/api/v1/admin/engine-validation/",)


def is_heavy_admin_request(method: str, path: str) -> bool:
    if method != "GET":
        return False
    path = path.rstrip("/") or path
    return path in _HEAVY_ADMIN_PATHS or path.startswith(_HEAVY_ADMIN_PREFIXES)


# --- 메모리 반환 -----------------------------------------------------------------

_malloc_trim: Any = None
_malloc_trim_resolved = False


def _resolve_malloc_trim() -> Any:
    """glibc 의 malloc_trim 을 한 번만 찾는다. 없으면 None(Windows·macOS·musl)."""
    global _malloc_trim, _malloc_trim_resolved
    if _malloc_trim_resolved:
        return _malloc_trim
    _malloc_trim_resolved = True
    if not sys.platform.startswith("linux"):
        return None
    try:
        libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6")
        trim = libc.malloc_trim
        trim.argtypes = [ctypes.c_size_t]
        trim.restype = ctypes.c_int
        _malloc_trim = trim
    except (OSError, AttributeError):
        _malloc_trim = None
    return _malloc_trim


def release_memory() -> bool:
    """gc 후 glibc 빈 힙을 OS 에 반환한다. malloc_trim 이 실제로 돌았으면 True. 예외는 삼킨다."""
    try:
        gc.collect()
        trim = _resolve_malloc_trim()
        if trim is None:
            return False
        trim(0)
        return True
    except Exception as exc:  # noqa: BLE001 — 메모리 정리 실패가 요청을 깨면 안 된다
        logger.warning("release_memory_failed", error=str(exc))
        return False


# --- 동시 실행 상한 ---------------------------------------------------------------

class _LoopBoundSemaphore:
    """이벤트 루프마다 하나씩 만드는 세마포어 — TestClient 처럼 루프가 바뀌는 환경에서도 안전."""

    def __init__(self, value: int) -> None:
        self._value = value
        self._loop: asyncio.AbstractEventLoop | None = None
        self._sem: asyncio.Semaphore | None = None

    def get(self) -> asyncio.Semaphore:
        loop = asyncio.get_running_loop()
        if self._sem is None or self._loop is not loop:
            self._loop = loop
            self._sem = asyncio.Semaphore(self._value)
        return self._sem


_gate = _LoopBoundSemaphore(HEAVY_ADMIN_CONCURRENCY)


class HeavyAdminGateMiddleware:
    """무거운 관리자 GET 을 동시에 HEAVY_ADMIN_CONCURRENCY 개만 통과시키고, 끝나면 메모리를 반환한다.

    순수 ASGI 미들웨어다(BaseHTTPMiddleware 는 응답 스트리밍·컨텍스트 전파에 부작용이 있다).
    슬롯은 응답 전송이 끝난 **뒤** 메모리 반환까지 마치고 돌려준다 — 다음 무거운 조회가 이전 조회의
    잔여 힙 위에서 시작하지 않게.
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") != "http" or not is_heavy_admin_request(scope.get("method", ""), scope.get("path", "")):
            await self.app(scope, receive, send)
            return
        sem = _gate.get()
        waited_from = time.monotonic()
        async with sem:
            waited_ms = int((time.monotonic() - waited_from) * 1000)
            if waited_ms >= 1000:
                logger.info("heavy_admin_gate_waited", path=scope.get("path"), waited_ms=waited_ms)
            try:
                await self.app(scope, receive, send)
            finally:
                # malloc_trim 은 힙 크기에 비례해 수~수십 ms 걸린다 — 이벤트 루프를 막지 않게 스레드로.
                try:
                    await asyncio.to_thread(release_memory)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("release_memory_offload_failed", error=str(exc))
