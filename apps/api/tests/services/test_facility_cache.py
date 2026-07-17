import asyncio

import pytest

from app.services import facility_cache


@pytest.fixture(autouse=True)
def _clear_cache():
    facility_cache.invalidate_facility_cache()
    yield
    facility_cache.invalidate_facility_cache()


@pytest.mark.asyncio
async def test_cache_hit_returns_isolated_copy(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(facility_cache.time, "monotonic", lambda: now[0])
    calls = 0

    async def loader():
        nonlocal calls
        calls += 1
        return [{"id": "f-1", "features": {"source": "tourapi"}}]

    first = await facility_cache.get_facilities_cached(("all",), loader)
    first[0]["features"]["source"] = "mutated"
    second = await facility_cache.get_facilities_cached(("all",), loader)

    assert calls == 1
    assert second[0]["features"]["source"] == "tourapi"


@pytest.mark.asyncio
async def test_ttl_expiry_reloads(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(facility_cache.time, "monotonic", lambda: now[0])
    calls = 0

    async def loader():
        nonlocal calls
        calls += 1
        return [{"version": calls}]

    assert (await facility_cache.get_facilities_cached(("all",), loader))[0]["version"] == 1
    now[0] += facility_cache.FACILITY_CACHE_TTL_SECONDS + 0.01
    assert (await facility_cache.get_facilities_cached(("all",), loader))[0]["version"] == 2


@pytest.mark.asyncio
async def test_concurrent_miss_is_single_flight():
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def loader():
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return [{"id": "f-1"}]

    tasks = [asyncio.create_task(facility_cache.get_facilities_cached(("same",), loader)) for _ in range(4)]
    await started.wait()
    release.set()
    assert await asyncio.gather(*tasks) == [[{"id": "f-1"}]] * 4
    assert calls == 1


@pytest.mark.asyncio
async def test_invalidation_forces_reload():
    calls = 0

    async def loader():
        nonlocal calls
        calls += 1
        return [{"version": calls}]

    await facility_cache.get_facilities_cached(("all",), loader)
    facility_cache.invalidate_facility_cache()
    assert (await facility_cache.get_facilities_cached(("all",), loader))[0]["version"] == 2


@pytest.mark.asyncio
async def test_invalidation_during_load_prevents_stale_repopulation():
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def loader():
        nonlocal calls
        calls += 1
        if calls == 1:
            started.set()
            await release.wait()
        return [{"version": calls}]

    first = asyncio.create_task(facility_cache.get_facilities_cached(("all",), loader))
    await started.wait()
    facility_cache.invalidate_facility_cache()
    release.set()
    assert (await first)[0]["version"] == 1
    assert (await facility_cache.get_facilities_cached(("all",), loader))[0]["version"] == 2


@pytest.mark.asyncio
async def test_soft_expiry_serves_stale_then_background_reload(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(facility_cache.time, "monotonic", lambda: now[0])
    reloaded = asyncio.Event()
    calls = 0

    async def loader():
        nonlocal calls
        calls += 1
        if calls == 2:
            reloaded.set()
        return [{"version": calls}]

    assert (await facility_cache.get_facilities_cached(("all",), loader))[0]["version"] == 1
    now[0] += facility_cache.FACILITY_CACHE_SOFT_TTL_SECONDS + 0.01
    assert (await facility_cache.get_facilities_cached(("all",), loader))[0]["version"] == 1
    await reloaded.wait()
    await asyncio.sleep(0)
    assert (await facility_cache.get_facilities_cached(("all",), loader))[0]["version"] == 2


@pytest.mark.asyncio
async def test_failed_background_reload_keeps_stale_and_retries(monkeypatch, caplog):
    now = [100.0]
    monkeypatch.setattr(facility_cache.time, "monotonic", lambda: now[0])
    attempts = 0

    async def loader():
        nonlocal attempts
        attempts += 1
        if attempts == 2:
            raise RuntimeError("reload failed")
        return [{"version": attempts}]

    await facility_cache.get_facilities_cached(("all",), loader)
    now[0] += facility_cache.FACILITY_CACHE_SOFT_TTL_SECONDS + 0.01
    assert (await facility_cache.get_facilities_cached(("all",), loader))[0]["version"] == 1
    await asyncio.sleep(0)
    assert "background reload failed" in caplog.text
    assert (await facility_cache.get_facilities_cached(("all",), loader))[0]["version"] == 1
    await asyncio.sleep(0)
    assert attempts == 3


@pytest.mark.asyncio
async def test_concurrent_soft_expiry_starts_one_background_reload(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(facility_cache.time, "monotonic", lambda: now[0])
    release = asyncio.Event()
    calls = 0

    async def loader():
        nonlocal calls
        calls += 1
        if calls == 2:
            await release.wait()
        return [{"version": calls}]

    await facility_cache.get_facilities_cached(("all",), loader)
    now[0] += facility_cache.FACILITY_CACHE_SOFT_TTL_SECONDS + 0.01
    results = await asyncio.gather(
        *(facility_cache.get_facilities_cached(("all",), loader) for _ in range(6))
    )
    assert results == [[{"version": 1}]] * 6
    assert calls == 2
    release.set()
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_invalidate_discards_stale_entry(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(facility_cache.time, "monotonic", lambda: now[0])
    calls = 0

    async def loader():
        nonlocal calls
        calls += 1
        return [{"version": calls}]

    await facility_cache.get_facilities_cached(("all",), loader)
    now[0] += facility_cache.FACILITY_CACHE_SOFT_TTL_SECONDS + 0.01
    facility_cache.invalidate_facility_cache()
    assert (await facility_cache.get_facilities_cached(("all",), loader))[0]["version"] == 2


@pytest.mark.asyncio
async def test_invalidate_does_not_join_stale_background_reload(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(facility_cache.time, "monotonic", lambda: now[0])
    stale_reload_started = asyncio.Event()
    release_stale_reload = asyncio.Event()
    calls = 0

    async def loader():
        nonlocal calls
        calls += 1
        version = calls
        if version == 2:
            stale_reload_started.set()
            await release_stale_reload.wait()
        return [{"version": version}]

    await facility_cache.get_facilities_cached(("all",), loader)
    now[0] += facility_cache.FACILITY_CACHE_SOFT_TTL_SECONDS + 0.01
    assert (await facility_cache.get_facilities_cached(("all",), loader))[0]["version"] == 1
    await stale_reload_started.wait()
    facility_cache.invalidate_facility_cache()
    assert (await facility_cache.get_facilities_cached(("all",), loader))[0]["version"] == 3
    release_stale_reload.set()
    await asyncio.sleep(0)
    assert (await facility_cache.get_facilities_cached(("all",), loader))[0]["version"] == 3
