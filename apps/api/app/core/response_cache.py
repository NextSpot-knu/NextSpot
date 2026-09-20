"""Short-TTL in-process cache for whole endpoint responses.

Why this exists: the demo instance is a single 0.5 CPU / 512MB Render worker, and
the two hot endpoints (``POST /recommendations/by-type``, ``POST /courses/plan``)
rebuild everything per request — facility rows, availability chunks, merchant
timesales, the latest-congestion RPC, ~20 area-demand RPCs, the festival feed,
ITS parking. A judge click-through replays the *same* request (same facility
types, same assumed-time preset, same location, same account) within seconds, so
the replays can be answered from the first one's result instead of paying the
whole pipeline again. When they are not, the health check starves and Render
restarts the service — a total outage in front of the judges.

This cache is deliberately dumb:
  · The key is built by the caller and must contain **every** request field that
    can change the answer. Anything left out silently serves one request's answer
    to a different question, so the routers list the fields explicitly rather
    than hashing the whole request body (a body field that does *not* change the
    answer would otherwise cost a miss).
  · TTL is short (180s default). Nothing outlives a demo click-through.
  · Values are stored and handed back as deep copies. The cached object is never
    handed to two callers, so no downstream mutation (FastAPI serialization,
    response-model revalidation) can leak into the next caller's payload.
  · Concurrent misses on the same key wait for the first one instead of each
    running the pipeline. The herd is what actually kills this instance.

Process-local by design — there is one uvicorn worker. Nothing here is a
correctness mechanism: dropping every entry only costs time.
"""

from __future__ import annotations

import asyncio
import copy
import threading
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any, Hashable

import structlog
from pydantic import BaseModel

logger = structlog.get_logger()

# 180s: long enough that a judge re-opening the same tab hits it, short enough
# that a merchant seat broadcast or a fresh congestion report shows up inside the
# same demo. Do not raise this without re-reading what the pipeline folds in.
DEFAULT_TTL_SECONDS = 180.0
# The demo only ever has a handful of live keys (4 facility types x a couple of
# presets x one account). 64 is headroom, not a target.
DEFAULT_MAX_ENTRIES = 64


def round_location(latitude: float, longitude: float, *, digits: int = 3) -> tuple[float, float]:
    """Fold a coordinate onto a ~110m grid so a drifting GPS fix still hits.

    3 decimal places is ~110m in latitude and ~90m at Gyeongju's longitude. That
    is well inside the walking bands the ranking uses (the shortest is 5 minutes
    ≈ 330m) and inside the 100m grid the area-demand prefetch already folds
    coordinates onto, so two requests that share a bucket were already going to
    read the same area signals.
    """
    return (round(float(latitude), digits), round(float(longitude), digits))


def assumed_time_bucket(assumed_at: datetime | None, *, now: datetime | None = None) -> str:
    """Bucket the request's reference time to the hour.

    Two requests in the same hour bucket ask the pipeline the same question: the
    arrival-eligibility tier, ``open_status_at_arrival``, the industry baseline
    and the model prediction all read hour/weekday, not minutes.

    ``assumed_at=None`` (live "now") buckets on the real clock hour and is kept
    **distinct** from an assumed time that happens to land in the same hour —
    they are not the same request. With an assumed time the routers pass
    ``depart_time`` into scoring; without one they pass ``None`` and scoring uses
    its own clock, which is a different code path and may score differently.
    """
    if assumed_at is not None:
        moment = assumed_at.astimezone(timezone.utc)
        return f"assumed:{moment:%Y-%m-%dT%H}"
    moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return f"live:{moment:%Y-%m-%dT%H}"


def model_signature(model: BaseModel | None) -> str | None:
    """Stable signature for an optional pydantic sub-model (e.g. TravelContext).

    Field order in ``model_dump_json`` is declaration order, so the string is
    deterministic for a given model class. List fields keep their request order:
    two requests that differ only in list order miss the cache and recompute,
    which is the safe direction to be wrong in.
    """
    if model is None:
        return None
    return model.model_dump_json()


class ResponseCache:
    """TTL + LRU response cache with single-flight on concurrent misses."""

    def __init__(
        self,
        name: str,
        *,
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
        max_entries: int = DEFAULT_MAX_ENTRIES,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.name = name
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self._clock = clock
        # value = (expires_at, deep-copied payload). Ordered newest-used last.
        self._entries: OrderedDict[Hashable, tuple[float, Any]] = OrderedDict()
        self._inflight: dict[Hashable, asyncio.Future] = {}
        # A plain lock is enough: every critical section below is pure dict work
        # with no await inside, so it can never block the event loop or deadlock.
        self._lock = threading.Lock()

    # --- internals (call under self._lock) ---

    def _peek_locked(self, key: Hashable) -> Any | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if expires_at <= self._clock():
            self._entries.pop(key, None)
            return None
        self._entries.move_to_end(key)
        return value

    def _store_locked(self, key: Hashable, value: Any) -> None:
        now = self._clock()
        self._entries[key] = (now + self.ttl_seconds, copy.deepcopy(value))
        self._entries.move_to_end(key)
        # Drop anything already dead before evicting a live entry.
        for dead in [k for k, (expires_at, _) in self._entries.items() if expires_at <= now]:
            self._entries.pop(dead, None)
        while len(self._entries) > self.max_entries:
            self._entries.popitem(last=False)

    # --- public ---

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._inflight.clear()

    async def get_or_compute(
        self, key: Hashable, factory: Callable[[], Awaitable[Any]]
    ) -> Any:
        """Return the cached payload for ``key``, or run ``factory`` and cache it.

        The caller always receives an object nobody else holds a reference to.
        Exceptions are never cached: a failed pipeline leaves the key empty so
        the next request tries again.
        """
        with self._lock:
            cached = self._peek_locked(key)
            if cached is not None:
                owner = False
                future = None
            else:
                future = self._inflight.get(key)
                owner = future is None
                if owner:
                    future = asyncio.get_running_loop().create_future()
                    # Retrieve any exception as soon as it is set so a failure
                    # with no waiters does not log "exception was never
                    # retrieved". Waiters still see it raised from their await.
                    future.add_done_callback(_consume_exception)
                    self._inflight[key] = future

        if cached is not None:
            logger.debug("response_cache_hit", cache=self.name)
            return copy.deepcopy(cached)

        if not owner:
            # shield: this request being cancelled (client hung up) must not
            # cancel the in-flight computation the other waiters are waiting on.
            logger.debug("response_cache_join", cache=self.name)
            return copy.deepcopy(await asyncio.shield(future))

        try:
            value = await factory()
        except BaseException as exc:
            with self._lock:
                if self._inflight.get(key) is future:
                    self._inflight.pop(key, None)
            if not future.done():
                future.set_exception(exc)
            raise

        with self._lock:
            self._store_locked(key, value)
            if self._inflight.get(key) is future:
                self._inflight.pop(key, None)
        if not future.done():
            # Waiters deep-copy what they get; the owner keeps the original and
            # the stored entry is a third, independent copy.
            future.set_result(value)
        return value


def _consume_exception(future: asyncio.Future) -> None:
    if not future.cancelled():
        future.exception()
