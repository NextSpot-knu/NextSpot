"""Short-lived process cache for semi-static recommendation facility rows."""

import asyncio
import copy
from collections.abc import Awaitable, Callable
from concurrent.futures import Future
import threading
import time
from typing import Any

FACILITY_CACHE_TTL_SECONDS = 180.0

_lock = threading.RLock()
_entries: dict[tuple[Any, ...], tuple[float, list[dict]]] = {}
_flights: dict[tuple[Any, ...], Future] = {}
_generation = 0


async def get_facilities_cached(
    key: tuple[Any, ...],
    loader: Callable[[], Awaitable[list[dict]]],
) -> list[dict]:
    """Return an isolated copy and collapse concurrent misses for the same key."""
    global _generation
    now = time.monotonic()
    with _lock:
        cached = _entries.get(key)
        if cached is not None and cached[0] > now:
            return copy.deepcopy(cached[1])
        if cached is not None:
            _entries.pop(key, None)

        flight = _flights.get(key)
        owner = flight is None
        if owner:
            flight = Future()
            _flights[key] = flight
            load_generation = _generation

    if not owner:
        rows = await asyncio.wrap_future(flight)
        return copy.deepcopy(rows)

    try:
        rows = await loader()
        stored = copy.deepcopy(rows)
        with _lock:
            if load_generation == _generation:
                _entries[key] = (time.monotonic() + FACILITY_CACHE_TTL_SECONDS, stored)
            _flights.pop(key, None)
            flight.set_result(stored)
        return copy.deepcopy(stored)
    except BaseException as exc:
        with _lock:
            _flights.pop(key, None)
            flight.set_exception(exc)
            # The owner observes the original exception; consume the Future copy
            # when there are no waiters to avoid an unhandled-future warning.
            flight.exception()
        raise


def invalidate_facility_cache() -> None:
    """Invalidate all entries; an already-running load cannot repopulate them."""
    global _generation
    with _lock:
        _generation += 1
        _entries.clear()
