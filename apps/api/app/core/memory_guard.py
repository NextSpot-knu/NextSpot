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
import json
import os
import sys
import time
from typing import Any

import structlog

from app.core import admin_cache

logger = structlog.get_logger(__name__)

# 동시에 처리할 무거운 관리자 조회 수. 1 이면 가장 안전하지만 대시보드 패널 ~9개가 한 줄로 서서
# 느린 패널(여러 날 리포트 10초 타임아웃·LLM 브리핑)이 뒤 패널을 25초 제한 너머로 밀 수 있다.
HEAVY_ADMIN_CONCURRENCY = 2

# 동시 개수 상한만으로는 '메모리 상한' 이 아니다 — 관광객 요청·예열이 겹친 상태에서 무거운 조회가 하나만
# 더 얹혀도 512MB 를 넘을 수 있다. 그래서 무거운 조회를 **시작하기 전에** 실제 RSS 를 본다:
#   · TRIM 이상이면 먼저 빈 힙을 반환하고 다시 잰다.
#   · 그래도 SHED 이상이면 그 관리자 조회만 503(잠시 후 재시도)으로 돌려보낸다. 관광객 경로는 절대 거절하지 않는다.
# 512MB 인스턴스 기준값이다. 인스턴스를 키우면 env 로 올린다(Render Environment).
HEAVY_ADMIN_TRIM_RSS_MB = float(os.environ.get("HEAVY_ADMIN_TRIM_RSS_MB", "320"))
HEAVY_ADMIN_SHED_RSS_MB = float(os.environ.get("HEAVY_ADMIN_SHED_RSS_MB", "400"))
_SHED_RETRY_AFTER_SECONDS = 5

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


_ADMIN_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def is_admin_write(method: str, path: str) -> bool:
    """관리자 집계를 바꿀 수 있는 쓰기(시설·혼잡 개입·설정·피크 시뮬레이션·문의 처리 등)."""
    return method in _ADMIN_WRITE_METHODS and path.startswith("/api/v1/admin/")


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


def current_rss_mb() -> float | None:
    """이 프로세스의 상주 메모리(MB). /proc 가 없는 환경(Windows·macOS)에서는 None."""
    try:
        with open("/proc/self/statm", "rb") as fh:
            resident_pages = int(fh.read().split()[1])
        return resident_pages * os.sysconf("SC_PAGE_SIZE") / (1024 * 1024)
    except (OSError, ValueError, IndexError, AttributeError):
        return None


def release_memory(trigger: str = "unspecified") -> bool:
    """gc 후 glibc 빈 힙을 OS 에 반환한다. malloc_trim 이 실제로 돌았으면 True. 예외는 삼킨다.

    전후 RSS 를 `memory_released` 로 남긴다 — 운영 로그에서 반환량·기저선을 바로 확인하려고.
    """
    try:
        before = current_rss_mb()
        gc.collect()
        trim = _resolve_malloc_trim()
        if trim is not None:
            trim(0)
        after = current_rss_mb()
        if before is not None and after is not None:
            logger.info(
                "memory_released", trigger=trigger, rss_before_mb=round(before, 1), rss_after_mb=round(after, 1)
            )
        return trim is not None
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


def _replay_first(first: dict, receive: Any) -> Any:
    """이미 꺼낸 첫 메시지를 한 번 돌려준 뒤 원래 receive 로 넘긴다."""
    pending = [first]

    async def replay() -> dict:
        if pending:
            return pending.pop()
        return await receive()

    return replay


class HeavyAdminGateMiddleware:
    """무거운 관리자 GET 을 동시에 HEAVY_ADMIN_CONCURRENCY 개만 통과시키고, 몰림이 끝나면 메모리를 반환한다.

    순수 ASGI 미들웨어다(BaseHTTPMiddleware 는 응답 스트리밍·컨텍스트 전파에 부작용이 있다).

    메모리 반환(gc 전체 수집 + malloc_trim)은 GIL 을 쥐고 수십~수백 ms 걸리므로 **몰림의 끝에 한 번만** 한다:
      · 성공 응답(<400)일 때만 — 인증 실패(401/403)는 행을 들고 있지 않다. 게이트가 인증 앞에 있으므로
        이 조건이 없으면 무인증 스캐너가 요청마다 전체 gc 를 일으켜 관광객 요청을 멈출 수 있다.
      · 줄 선 무거운 요청이 하나도 남지 않았을 때만 — 대시보드 한 번에 7개가 몰려도 반환은 마지막에 한 번.
        그 사이의 요청들은 앞 요청이 비운 힙을 glibc 가 재사용하므로 계단이 쌓이지 않는다.
    반환은 슬롯을 쥔 채 한다 — 다음 무거운 조회가 이전 조회의 잔여 힙 위에서 시작하지 않게.
    """

    def __init__(self, app: Any) -> None:
        self.app = app
        self._pending = 0  # 대기 + 실행 중인 무거운 요청 수(이벤트 루프 스레드에서만 바뀐다)
        # 이번 몰림에서 성공 응답(행을 들었던 요청)이 하나라도 있었나 — 마지막으로 끝난 요청이 실패·끊김이어도
        # 앞 요청들이 남긴 빈 힙은 반환해야 한다.
        self._burst_had_success = False

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        method, path = scope.get("method", ""), scope.get("path", "")
        if is_admin_write(method, path):
            await self._admin_write(scope, receive, send)
            return
        if not is_heavy_admin_request(method, path):
            await self.app(scope, receive, send)
            return
        sem = _gate.get()
        status = {"code": 0}

        async def send_with_status(message: dict) -> None:
            if message.get("type") == "http.response.start":
                status["code"] = int(message.get("status") or 0)
            await send(message)

        self._pending += 1
        counted = True  # 줄에서 빠질 때 정확히 한 번 _pending 을 줄이기 위한 표시
        try:
            waited_from = time.monotonic()
            async with sem:
                waited_ms = int((time.monotonic() - waited_from) * 1000)
                if waited_ms >= 1000:
                    logger.info("heavy_admin_gate_waited", path=path, waited_ms=waited_ms)
                # uvicorn 은 연결이 끊겨도 요청 태스크를 취소하지 않는다 — 줄 서는 동안 브라우저가 떠난 요청
                # (25초 타임아웃·새로고침)을 그대로 돌리면 아무도 받지 않을 무거운 조회가 슬롯을 차지하고,
                # 재시도분이 그 뒤에 또 선다. GET 은 본문이 없어 첫 receive 가 즉시 돌아온다(끊겼으면 disconnect).
                try:
                    first = await receive()
                    if first.get("type") == "http.disconnect":
                        # 응답 없이 끝낸다 — uvicorn 은 끊긴 연결에 아무것도 쓰지 않고 오류도 남기지 않는다.
                        logger.info("heavy_admin_gate_client_gone", path=path, waited_ms=waited_ms)
                        return
                    if await self._over_memory_budget(path):
                        await _send_busy(send_with_status)
                        return
                    await self.app(scope, _replay_first(first, receive), send_with_status)
                finally:
                    self._pending -= 1
                    counted = False
                    if 0 < status["code"] < 400:
                        self._burst_had_success = True
                    if self._pending == 0 and self._burst_had_success:
                        self._burst_had_success = False
                        # malloc_trim 은 힙 크기에 비례해 수~수십 ms — 이벤트 루프를 막지 않게 스레드로.
                        try:
                            await asyncio.to_thread(release_memory, "admin_burst")
                        except Exception as exc:  # noqa: BLE001
                            logger.warning("release_memory_offload_failed", error=str(exc))
        finally:
            if counted:  # 슬롯을 얻기 전에 취소됐다(클라이언트 끊김) — 줄에서 뺀다.
                self._pending -= 1

    async def _over_memory_budget(self, path: str) -> bool:
        """무거운 조회를 시작해도 되는지 실제 RSS 로 판단한다. 넘치면 True(이 요청은 503)."""
        rss = current_rss_mb()
        if rss is None or rss < HEAVY_ADMIN_TRIM_RSS_MB:
            return False
        await asyncio.to_thread(release_memory, "admin_preflight")
        rss_after = current_rss_mb()
        if rss_after is None or rss_after < HEAVY_ADMIN_SHED_RSS_MB:
            return False
        logger.warning("heavy_admin_shed", path=path, rss_mb=round(rss_after, 1), limit_mb=HEAVY_ADMIN_SHED_RSS_MB)
        return True

    async def _admin_write(self, scope: dict, receive: Any, send: Any) -> None:
        """관리자 쓰기는 그대로 통과시키고, 성공하면 관리자 집계 캐시를 비운다(데모의 '누르면 바로 반영')."""
        status = {"code": 0}

        async def send_with_status(message: dict) -> None:
            if message.get("type") == "http.response.start":
                status["code"] = int(message.get("status") or 0)
            await send(message)

        try:
            await self.app(scope, receive, send_with_status)
        finally:
            if 0 < status["code"] < 400:
                admin_cache.invalidate()


async def _send_busy(send: Any) -> None:
    body = json.dumps({"detail": "요청이 몰려 있어요. 잠시 후 다시 시도해 주세요."}, ensure_ascii=False).encode()
    await send({
        "type": "http.response.start",
        "status": 503,
        "headers": [
            (b"content-type", b"application/json; charset=utf-8"),
            (b"retry-after", str(_SHED_RETRY_AFTER_SECONDS).encode()),
            (b"content-length", str(len(body)).encode()),
        ],
    })
    await send({"type": "http.response.body", "body": body})
