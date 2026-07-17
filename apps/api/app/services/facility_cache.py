"""Short-lived process cache for semi-static recommendation facility rows."""

import asyncio
import copy
from collections.abc import Awaitable, Callable
from concurrent.futures import Future
import logging
import threading
import time
from typing import Any

FACILITY_CACHE_SOFT_TTL_SECONDS = 180.0
# Keep the original public name as the absolute lifetime for compatibility.
FACILITY_CACHE_TTL_SECONDS = 900.0

logger = logging.getLogger(__name__)

_lock = threading.RLock()
_entries: dict[tuple[Any, ...], tuple[float, float, list[dict]]] = {}
_flights: dict[tuple[Any, ...], Future] = {}
_background_tasks: set[asyncio.Task] = set()
_generation = 0


async def _reload(
    key: tuple[Any, ...],
    loader: Callable[[], Awaitable[list[dict]]],
    flight: Future,
    load_generation: int,
) -> list[dict]:
    try:
        rows = await loader()
        stored = copy.deepcopy(rows)
        loaded_at = time.monotonic()
        with _lock:
            if load_generation == _generation:
                _entries[key] = (
                    loaded_at + FACILITY_CACHE_SOFT_TTL_SECONDS,
                    loaded_at + FACILITY_CACHE_TTL_SECONDS,
                    stored,
                )
            if _flights.get(key) is flight:
                _flights.pop(key, None)
            flight.set_result(stored)
        return stored
    except BaseException as exc:
        with _lock:
            if _flights.get(key) is flight:
                _flights.pop(key, None)
            flight.set_exception(exc)
            # The loader caller observes the original exception; consume the
            # Future copy when there are no waiters.
            flight.exception()
        raise


async def _reload_in_background(
    key: tuple[Any, ...],
    loader: Callable[[], Awaitable[list[dict]]],
    flight: Future,
    load_generation: int,
) -> None:
    try:
        await _reload(key, loader, flight, load_generation)
    except asyncio.CancelledError:
        # Process shutdown cancellation is expected and must not escape.
        pass
    except BaseException:
        logger.warning("Facility cache background reload failed for key %r", key, exc_info=True)


def _start_background_reload(
    key: tuple[Any, ...],
    loader: Callable[[], Awaitable[list[dict]]],
    flight: Future,
    load_generation: int,
) -> None:
    task = asyncio.create_task(_reload_in_background(key, loader, flight, load_generation))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def get_facilities_cached(
    key: tuple[Any, ...],
    loader: Callable[[], Awaitable[list[dict]]],
) -> list[dict]:
    """Return an isolated copy, serving soft-expired rows while refreshing."""
    now = time.monotonic()
    with _lock:
        cached = _entries.get(key)
        if cached is not None and cached[0] > now:
            return copy.deepcopy(cached[2])

        if cached is not None and cached[1] > now:
            flight = _flights.get(key)
            if flight is None:
                flight = Future()
                _flights[key] = flight
                _start_background_reload(key, loader, flight, _generation)
            return copy.deepcopy(cached[2])

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

    rows = await _reload(key, loader, flight, load_generation)
    return copy.deepcopy(rows)


def invalidate_facility_cache() -> None:
    """Invalidate all entries; an already-running load cannot repopulate them."""
    global _generation
    with _lock:
        _generation += 1
        _entries.clear()
        _flights.clear()
