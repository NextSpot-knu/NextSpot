"""공급원 계약 테스트 — **모든 `CrowdProvider` 가 통과해야 하는 한 벌**(경주 전환 키트, S5).

`docs/SEOUL_TESTBED_PLAN.md` §3.1 · `docs/CROWD_DATA_CONTRACT.md` §11. 새 공급원(경주 통신사 어댑터)을 붙이면
아래 `_CASES` 에 한 줄을 더한다. 엔진(S3 이후)은 이 계약만 믿고 공급원을 바꿔 끼운다(G3).

계약:
  · `describe()` 의 칸이 다 차 있고 `source`·눈금이 공급원과 맞다.
  · `fetch_current` 는 **예외를 내지 않는다** — 실패한 구역은 빠지고, 공급원 전체가 죽으면 빈 목록이다.
  · 돌려준 관측의 구역은 요청한 구역 안에 있고 중복이 없다.
  · 시각은 시간대가 있고, 관측 시각이 받은 시각보다 (허용 오차 넘게) 늦지 않다.
  · 단계는 0~1, 인원은 음수가 아니고 범위는 min ≤ point ≤ max 순서다.
  · 품질에 `lag_seconds` 가 늘 있고, 값이 빠졌거나(단계·인원 없음) 성능이 떨어진 관측은 이유 플래그가 있다.
  · `store.snapshot_row` 로 저장 행이 되고 JSON 으로 직렬화된다(`zone_crowd_snapshots` 에 그대로 들어간다).
  · `fetch_forecast` 도 예외 없이 요청 구역의 예측만, 시간대 있는 시각으로 돌려준다.

네트워크·DB 없음: 서울은 httpx MockTransport(실제 `fetch_citydata` 경로), 통신사 템플릿은 합성 격자 픽스처.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Sequence
from urllib.parse import unquote

import httpx
import pytest

from app.core.config import settings
from app.services.crowd import seoul_provider, store
from app.services.crowd import telecom_template as tt
from app.services.crowd.observation import (
    CrowdForecast,
    CrowdObservation,
    CrowdProvider,
    ProviderDescription,
    Zone,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
KST = timezone(timedelta(hours=9))
# 공급원 시계가 우리보다 조금 앞서는 것은 허용한다(telecom_template.future_tolerance_seconds 와 같은 값).
CLOCK_SKEW = timedelta(seconds=60)
# '값이 빠졌거나 떨어졌다'를 설명하는 품질 키. 공급원마다 다른 키를 쓰되, 이 가운데 하나는 있어야 한다.
DEGRADATION_KEYS = {
    "population_range_missing", "replaced", "provider_zone_code_mismatch",  # 서울
    "masked", "low_sample", "stale", "level_provisional", "level_unavailable", "ci_dropped",  # 통신사 격자
    "timestamp_assumed_kst",
}


@dataclass
class ProviderCase:
    """계약 한 벌을 돌릴 공급원 한 개와 그 상황."""

    provider: CrowdProvider
    zones: tuple[Zone, ...]
    current: Callable[[Sequence[Zone]], Awaitable[list[CrowdObservation]]]
    forecast: Callable[[Sequence[Zone], timedelta], Awaitable[list[CrowdForecast]]]
    # 실패하도록 꾸민 구역(빠져야 한다)과 반드시 돌아와야 하는 구역.
    failing_zone_ids: frozenset[str]
    expected_zone_ids: frozenset[str]
    # 성능이 떨어지도록 꾸민 구역 → 있어야 하는 품질 키(가운데 하나 이상).
    degraded: dict[str, set[str]]
    # 공급원 전체가 죽은 상황.
    broken_current: Callable[[Sequence[Zone]], Awaitable[list[CrowdObservation]]]


# ── 서울: 실제 fetch_citydata 경로 + MockTransport ─────────────────────────────


def _seoul_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _seoul_case(monkeypatch) -> ProviderCase:
    monkeypatch.setattr(settings, "SEOUL_OPENDATA_KEY", "SEOULKEY0123456789abcdef")
    by_name = {zone.provider_zone_name: zone for zone in seoul_provider.SEOUL_ZONES}
    hongdae, yeonnam, hapjeong = by_name["홍대 관광특구"], by_name["연남동"], by_name["합정역"]

    def handler(request: httpx.Request) -> httpx.Response:
        name = unquote(request.url.path.rsplit("/", 1)[-1])
        if name == hongdae.provider_zone_name:
            # 합성 응답 — AREA_CD 가 일부러 다르다(품질 플래그가 붙어야 한다).
            return httpx.Response(200, json=_seoul_fixture("seoul_citydata_hongdae_synthetic.json"))
        if name == hapjeong.provider_zone_name:
            # 샘플키는 무엇을 물어도 광화문을 준다 — 다른 곳의 답이 이 구역 관측이 되면 안 된다.
            return httpx.Response(200, json=_seoul_fixture("seoul_citydata_gwanghwamun_sample.json"))
        return httpx.Response(500, text="upstream down")

    def broken(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route")

    provider = seoul_provider.SeoulCitydataProvider()

    async def current(zones):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await provider.fetch_current(zones, client=client)

    async def forecast(zones, horizon):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await provider.fetch_forecast(zones, horizon, client=client)

    async def broken_current(zones):
        async with httpx.AsyncClient(transport=httpx.MockTransport(broken)) as client:
            return await provider.fetch_current(zones, client=client)

    return ProviderCase(
        provider=provider,
        zones=(hongdae, yeonnam, hapjeong),
        current=current,
        forecast=forecast,
        failing_zone_ids=frozenset({yeonnam.zone_id, hapjeong.zone_id}),
        expected_zone_ids=frozenset({hongdae.zone_id}),
        degraded={hongdae.zone_id: {"provider_zone_code_mismatch"}},
        broken_current=broken_current,
    )


# ── 통신사 격자 템플릿: 합성 경주 격자 ─────────────────────────────────────────

_GRID_CONFIG = tt.TelecomGridConfig(source="synthetic_gyeongju_grid", cell_size_m=100, provides_forecast=False)
_SUN_1505 = datetime(2026, 10, 25, 15, 5, tzinfo=KST)


def _telecom_case(*, with_baseline: bool) -> ProviderCase:
    payload = tt.load_grid_file(FIXTURES / "crowd" / "gyeongju_grid_synthetic.json")
    config = _GRID_CONFIG
    baseline = None
    if with_baseline:
        # 3일치뿐이라 요일 무시 · 시간대 기준선(표본 6 이상)으로 연다. 판정 시각 이전 이력만 넣는다.
        config = tt.TelecomGridConfig(
            source=_GRID_CONFIG.source, cell_size_m=100, baseline_by_weekday=False, min_baseline_samples=6
        )
        baseline = tt.GridBaseline.for_config(config)
        baseline.add_payload(payload, config.region, before=datetime(2026, 10, 25, tzinfo=KST))
    zones = tt.zones_from_payload(payload, config)
    ghost = Zone(**{**zones[0].__dict__, "zone_id": "gyeongju:G100-9-9", "provider_zone_code": "G100-9-9"})
    provider = tt.TelecomGridProvider(tt.static_feed(payload), config, baseline=baseline, clock=lambda: _SUN_1505)

    async def broken_feed():
        raise ConnectionError("vendor down")

    broken = tt.TelecomGridProvider(broken_feed, config, clock=lambda: _SUN_1505)
    low = tt.zone_id_for_cell(config.region, "G100-1-1")
    degraded = {low: {"low_sample"}}
    if not with_baseline:
        degraded.update({zone.zone_id: {"level_provisional"} for zone in zones})
    return ProviderCase(
        provider=provider,
        zones=(*zones, ghost),
        current=provider.fetch_current,
        forecast=provider.fetch_forecast,
        failing_zone_ids=frozenset({ghost.zone_id}),
        expected_zone_ids=frozenset(zone.zone_id for zone in zones),
        degraded=degraded,
        broken_current=broken.fetch_current,
    )


_CASES = {
    "seoul_citydata": lambda monkeypatch: _seoul_case(monkeypatch),
    "telecom_grid_fallback": lambda _monkeypatch: _telecom_case(with_baseline=False),
    "telecom_grid_baseline": lambda _monkeypatch: _telecom_case(with_baseline=True),
}


@pytest.fixture(params=sorted(_CASES))
def case(request, monkeypatch) -> ProviderCase:
    monkeypatch.setattr(settings, "SEOUL_OPENDATA_KEY", "")
    return _CASES[request.param](monkeypatch)


def _aware(moment: datetime) -> bool:
    return moment.tzinfo is not None and moment.utcoffset() is not None


# ── 계약 ─────────────────────────────────────────────────────────────────────


def test_is_a_crowd_provider(case: ProviderCase):
    assert isinstance(case.provider, CrowdProvider)


def test_describe_is_complete_and_consistent(case: ProviderCase):
    description = case.provider.describe()
    assert isinstance(description, ProviderDescription)
    assert description.source == case.provider.source
    assert description.region and description.region == description.region.lower()
    assert all(zone.region == description.region for zone in case.zones)
    assert description.cadence_seconds > 0
    assert description.expected_latency_seconds is None or description.expected_latency_seconds > 0
    assert description.spatial_resolution.strip()
    assert description.level_scale.strip()
    assert isinstance(description.provides_forecast, bool) and isinstance(description.provides_history, bool)
    assert description.license.strip()


def test_empty_zone_list_returns_nothing(case: ProviderCase):
    assert asyncio.run(case.current([])) == []


def test_failures_are_dropped_silently(case: ProviderCase):
    observations = asyncio.run(case.current(case.zones))
    returned = {item.zone_id for item in observations}
    assert case.expected_zone_ids <= returned
    assert not (case.failing_zone_ids & returned)


def test_total_outage_is_an_empty_list(case: ProviderCase):
    assert asyncio.run(case.broken_current(case.zones)) == []


def test_observations_obey_the_shape_rules(case: ProviderCase):
    observations = asyncio.run(case.current(case.zones))
    assert observations, "계약 상황에서 관측이 하나는 있어야 한다"
    requested = {zone.zone_id for zone in case.zones}
    ids = [item.zone_id for item in observations]
    assert len(ids) == len(set(ids)), "같은 구역은 한 번만"
    for item in observations:
        assert isinstance(item, CrowdObservation)
        assert item.zone_id in requested
        assert item.source == case.provider.source
        assert item.level_scale.strip()
        assert _aware(item.observed_at) and _aware(item.fetched_at)
        assert item.observed_at <= item.fetched_at + CLOCK_SKEW
        assert item.period_seconds is None or item.period_seconds > 0
        if item.level is not None:
            assert 0.0 <= item.level <= 1.0
        for value in (item.population_min, item.population_max, item.population_point):
            assert value is None or value >= 0
        if item.population_min is not None and item.population_max is not None:
            assert item.population_min <= item.population_max
            if item.population_point is not None:
                assert item.population_min <= item.population_point <= item.population_max
        for forecast in item.forecast:
            assert forecast.zone_id == item.zone_id
            assert _aware(forecast.target_at) and _aware(forecast.issued_at)


def test_quality_explains_latency_and_degradation(case: ProviderCase):
    observations = {item.zone_id: item for item in asyncio.run(case.current(case.zones))}
    for item in observations.values():
        lag = item.quality.get("lag_seconds")
        assert isinstance(lag, int) and lag >= 0, "지연은 늘 남긴다(V1 지연 지표의 원천)"
        missing_value = item.level is None or (
            item.population_point is None and item.population_min is None and item.population_max is None
        )
        if missing_value:
            assert DEGRADATION_KEYS & {key for key, value in item.quality.items() if value}, item.quality
    for zone_id, keys in case.degraded.items():
        assert zone_id in observations, f"{zone_id} 는 떨어진 값이라도 돌아와야 한다"
        flags = {key for key, value in observations[zone_id].quality.items() if value}
        assert flags & keys, f"{zone_id}: {keys} 가운데 하나가 있어야 한다 — {observations[zone_id].quality}"


def test_observations_are_storable(case: ProviderCase):
    for item in asyncio.run(case.current(case.zones)):
        row = store.snapshot_row(item)
        json.dumps(row, ensure_ascii=False, allow_nan=False)
        assert row["zone_id"] == item.zone_id and row["level_scale"] == item.level_scale


def test_forecast_stays_within_requested_zones(case: ProviderCase):
    requested = {zone.zone_id for zone in case.zones}
    forecasts = asyncio.run(case.forecast(case.zones, timedelta(hours=3)))
    if not case.provider.describe().provides_forecast:
        assert forecasts == []
    for item in forecasts:
        assert isinstance(item, CrowdForecast)
        assert item.zone_id in requested and item.source == case.provider.source
        assert _aware(item.target_at) and _aware(item.issued_at)
        assert item.level is None or 0.0 <= item.level <= 1.0
        if item.population_min is not None and item.population_max is not None:
            assert item.population_min <= item.population_max
