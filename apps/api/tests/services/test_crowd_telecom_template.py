"""통신사 격자 어댑터 템플릿(S5) — 전달물 읽기 · 격자 → 구역 · 인원 → 단계 · 표본/마스킹 플래그.

픽스처 `tests/fixtures/crowd/gyeongju_grid_synthetic.json` 은 **합성**이다(같은 폴더의 생성기가 만든다).
공급원 공통 계약은 `test_crowd_provider_contract.py` 가 따로 본다 — 여기는 이 템플릿만의 규칙이다.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.services.crowd import telecom_template as tt
from app.services.crowd.observation import CrowdProvider

FIXTURE_DIR = Path(__file__).resolve().parents[1] / "fixtures" / "crowd"
FIXTURE = FIXTURE_DIR / "gyeongju_grid_synthetic.json"
KST = timezone(timedelta(hours=9))
SUN_1505 = datetime(2026, 10, 25, 15, 5, tzinfo=KST)
MAIN, SIDE, BACK, LOW = "G100-0-0", "G100-0-1", "G100-1-0", "G100-1-1"
# 마이그레이션 20261031120000 의 zones.zone_id CHECK 와 같은 식.
ZONE_ID_RE = re.compile(r"^[a-z][a-z0-9_]*:\S+$")


def _generator():
    spec = importlib.util.spec_from_file_location("make_gyeongju_grid", FIXTURE_DIR / "make_gyeongju_grid.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _payload() -> tt.GridPayload:
    return tt.load_grid_file(FIXTURE)


CONFIG = tt.TelecomGridConfig(source="synthetic_gyeongju_grid", cell_size_m=100)


def _provider(payload=None, *, baseline=None, now=SUN_1505, config=CONFIG):
    return tt.TelecomGridProvider(
        tt.static_feed(payload or _payload()), config, baseline=baseline, clock=lambda: now
    )


def _by_zone(observations):
    return {item.quality["provider_zone_code"]: item for item in observations}


def _current(provider, payload=None):
    zones = tt.zones_from_payload(payload or _payload(), provider.config)
    return _by_zone(asyncio.run(provider.fetch_current(zones)))


# ── 픽스처 ────────────────────────────────────────────────────────────────────


def test_committed_fixture_matches_the_generator():
    generator = _generator()
    assert FIXTURE.read_text(encoding="utf-8") == generator.render(generator.build_payload())


def test_fixture_shape_has_gaps_and_a_low_sample_cell():
    payload = _payload()
    assert sorted(payload.cells) == [MAIN, SIDE, BACK, LOW]
    assert payload.cell_size_m == 100 and payload.period_seconds == 600 and payload.min_count == 5
    assert payload.rejected_rows == 0
    full = 3 * 144 * 4
    assert full * 0.95 < len(payload.rows) < full, "결측 행이 있어야 한다"
    outage = [row for row in payload.rows if datetime(2026, 10, 24, 12, 0, tzinfo=KST) <= row.observed_at
              < datetime(2026, 10, 24, 12, 30, tzinfo=KST)]
    assert outage == [], "토요일 12:00~12:20 은 전 칸이 끊겼다"
    low_rows = [row for row in payload.rows if row.cell_id == LOW]
    assert {row.sample_flag for row in low_rows} == {"low", "masked"}
    assert all(row.population is None for row in low_rows if row.sample_flag == "masked")
    # 하루 모양: 정점(14~15시)이 새벽보다 크다.
    def hour_mean(hour: int) -> float:
        values = [row.population for row in payload.rows if row.cell_id == MAIN and row.observed_at.day == 24
                  and row.observed_at.hour == hour]
        return sum(values) / len(values)

    assert hour_mean(14) > 10 * hour_mean(4)


# ── 격자 → 구역 ───────────────────────────────────────────────────────────────


def test_cells_become_grid_cell_zones_with_equal_area_radius():
    zones = tt.zones_from_payload(_payload(), CONFIG)
    assert [zone.provider_zone_code for zone in zones] == [MAIN, SIDE, BACK, LOW]
    for zone in zones:
        assert zone.kind == "grid_cell"
        assert zone.region == "gyeongju" and zone.cluster == "hwangnidan"
        assert zone.provider == "synthetic_gyeongju_grid"
        assert ZONE_ID_RE.match(zone.zone_id) and zone.zone_id == f"gyeongju:{zone.provider_zone_code}"
        assert zone.radius_m == round(100 / math.sqrt(math.pi))
        assert 35.8 < zone.centroid_lat < 35.9 and 129.1 < zone.centroid_lng < 129.3


def test_zone_table_rows_carry_a_closed_polygon():
    rows = tt.zone_table_rows(_payload(), CONFIG)
    assert len({row["zone_id"] for row in rows}) == 4
    ring = rows[0]["geometry"]["coordinates"][0]
    assert rows[0]["geometry"]["type"] == "Polygon" and ring[0] == ring[-1] and len(ring) == 5
    assert set(rows[0]) >= {"zone_id", "region", "kind", "provider", "provider_zone_code", "centroid_lat", "radius_m"}


def test_radius_falls_back_to_bbox_area_without_cell_size():
    payload = _payload()
    bare = tt.GridPayload(cells=payload.cells, rows=payload.rows)
    zone = tt.zones_from_payload(bare, tt.TelecomGridConfig())[0]
    assert zone.radius_m == pytest.approx(56, abs=1)


# ── 단계: 기준선 전의 보수적 대체 ──────────────────────────────────────────────


def test_provider_satisfies_the_protocol():
    assert isinstance(_provider(), CrowdProvider)


def test_without_baseline_uses_provisional_density_bands_and_says_so():
    current = _current(_provider())
    main, back = current[MAIN], current[BACK]
    assert main.observed_at == datetime(2026, 10, 25, 15, 0, tzinfo=KST), "미래 행(15:10 이후)은 보지 않는다"
    assert main.population_point == pytest.approx(615.9)
    # 615.9명 / 10,000m² = 0.0616 ≥ 0.06 → 붐빔(구간 중앙값 0.875).
    assert (main.level, main.level_label) == (0.875, "붐빔")
    assert back.level_label == "보통" and back.level == 0.375  # 230.4명 → 0.023
    for observation in (main, back):
        assert observation.level_scale == tt.LEVEL_SCALE_FALLBACK
        assert observation.quality["level_method"] == "density_fallback"
        assert observation.quality["level_provisional"] is True
        assert observation.quality["baseline_samples"] == 0
        assert observation.quality["baseline_required"] == 12
        assert observation.population_min is None and observation.population_max is None
        assert observation.quality["lag_seconds"] == 300
        assert "stale" not in observation.quality


def test_without_cell_area_level_is_unknown_not_guessed():
    payload = _payload()
    bare = tt.GridPayload(cells={}, rows=payload.rows)
    zones = tt.zones_from_payload(payload, CONFIG)
    provider = _provider(bare, config=tt.TelecomGridConfig(source="synthetic_gyeongju_grid"))
    main = _by_zone(asyncio.run(provider.fetch_current(zones)))[MAIN]
    assert main.level is None and main.level_label is None
    assert main.population_point == pytest.approx(615.9)
    assert main.quality["level_method"] == "none" and main.quality["level_unavailable"] is True


# ── 단계: 기준선 분위수 ────────────────────────────────────────────────────────


def test_quantile_rank_is_mid_rank_within_zero_and_one():
    baseline = tt.GridBaseline()
    at = SUN_1505
    for value in range(1, 11):
        baseline.add("gyeongju:x", at, float(value))
    baseline.add("gyeongju:x", at, None)  # 가려진 값은 분포에 넣지 않는다
    assert baseline.samples("gyeongju:x", at) == 10
    assert baseline.quantile_rank("gyeongju:x", at, 0.0) == (0.0, 10)
    assert baseline.quantile_rank("gyeongju:x", at, 99.0) == (1.0, 10)
    assert baseline.quantile_rank("gyeongju:x", at, 5.0) == (pytest.approx(0.45), 10)
    assert baseline.quantile_rank("gyeongju:x", at + timedelta(days=1), 5.0) == (None, 0), "다른 요일은 다른 분포"
    assert baseline.slot_label(at) == "sun-1500"


def test_baseline_slots_by_weekday_and_hour_in_kst():
    baseline = tt.GridBaseline(slot_minutes=60, by_weekday=True)
    utc_moment = datetime(2026, 10, 25, 6, 5, tzinfo=timezone.utc)  # = 일요일 15:05 KST
    assert baseline.slot(utc_moment) == (6, 15)
    assert tt.GridBaseline(by_weekday=False).slot(utc_moment) == (-1, 15)


def test_three_weeks_of_history_switch_to_baseline_quantiles():
    generator = _generator()
    start = datetime(2026, 10, 2, tzinfo=KST)  # 금요일부터 24일
    raw = generator.build_payload(start=start, days=24)
    payload = tt.parse_grid_json(raw)
    now = datetime(2026, 10, 24, 15, 5, tzinfo=KST)  # 넷째 토요일
    baseline = tt.GridBaseline.for_config(CONFIG)
    baseline.add_payload(payload, CONFIG.region, before=datetime(2026, 10, 24, tzinfo=KST))
    current = _current(_provider(payload, baseline=baseline, now=now), payload)

    main = current[MAIN]
    assert main.quality["level_method"] == "baseline_quantile"
    assert main.level_scale == tt.LEVEL_SCALE_BASELINE
    assert main.quality["baseline_samples"] >= 12  # 토 15시대 3주 × 6행(결측 제외)
    assert main.quality["baseline_slot"] == "sat-1500"
    assert "level_provisional" not in main.quality
    assert 0.0 <= main.level <= 1.0
    expected_label = tt.LEVEL_LABELS[sum(main.level >= edge for edge in CONFIG.level_bands)]
    assert main.level_label == expected_label


def test_thin_baseline_still_falls_back_and_reports_the_count():
    payload = _payload()
    baseline = tt.GridBaseline.for_config(CONFIG)
    baseline.add_payload(payload, CONFIG.region, before=SUN_1505 - timedelta(minutes=5))
    main = _current(_provider(payload, baseline=baseline))[MAIN]
    # 같은 요일(일) 15시대 이력은 이 3일 안에 없다 → 표본 0, 대체 단계.
    assert main.quality["level_method"] == "density_fallback"
    assert main.quality["baseline_samples"] == 0


def test_day_agnostic_baseline_can_be_configured():
    payload = _payload()
    config = tt.TelecomGridConfig(
        source="synthetic_gyeongju_grid", cell_size_m=100, baseline_by_weekday=False, min_baseline_samples=6
    )
    baseline = tt.GridBaseline.for_config(config)
    baseline.add_payload(payload, config.region, before=datetime(2026, 10, 25, tzinfo=KST))
    main = _current(_provider(payload, baseline=baseline, config=config))[MAIN]
    assert main.quality["level_method"] == "baseline_quantile"
    assert main.quality["baseline_slot"] == "all-1500"


# ── 표본 · 마스킹 · 결측 · 지연 ────────────────────────────────────────────────


def test_low_sample_cell_is_flagged_and_keeps_its_interval():
    low = _current(_provider())[LOW]
    assert low.quality["low_sample"] is True
    assert low.quality["sample_flag"] == "low"
    assert low.population_point == pytest.approx(9.6)
    assert (low.population_min, low.population_max) == (4, 16)  # 4.8 내림 · 15.4 올림
    assert low.level is not None, "표본이 적어도 값은 그대로 — 깎는 것은 엔진 몫"


def test_masked_cell_reports_only_the_contract_bound():
    payload = _payload()
    masked = max(row.observed_at for row in payload.rows if row.cell_id == LOW and row.sample_flag == "masked")
    low = _current(_provider(now=masked + timedelta(minutes=2)))[LOW]
    assert low.observed_at == masked
    assert low.population_point is None and low.level is None and low.level_label is None
    assert (low.population_min, low.population_max) == (0, 4)
    assert low.quality["masked"] is True and low.quality["population_bound"] == "below_min_count"
    assert low.quality["level_method"] == "none"


def test_masked_without_declared_min_count_has_no_population_at_all():
    payload = _payload()
    bare = tt.GridPayload(cells=payload.cells, rows=payload.rows, cell_size_m=100)
    masked = max(row.observed_at for row in payload.rows if row.cell_id == LOW and row.sample_flag == "masked")
    low = _current(_provider(bare, now=masked + timedelta(minutes=2)), bare)[LOW]
    assert (low.population_min, low.population_max, low.population_point) == (None, None, None)
    assert low.quality["masked"] is True and "population_bound" not in low.quality


def test_outage_serves_the_last_real_row_and_marks_it_stale():
    # 끊김 12:00~12:20. 12:20 에는 11:50 행이 지연 30분 — stale(> 10+15분) 이지만 버릴 나이(> 35분)는 아니다.
    current = _current(_provider(now=datetime(2026, 10, 24, 12, 20, tzinfo=KST)))
    assert current, "11:50 행이 있는 칸은 돌아와야 한다"
    for observation in current.values():
        assert observation.observed_at < datetime(2026, 10, 24, 12, 0, tzinfo=KST)
        assert 25 * 60 < observation.quality["lag_seconds"] <= 35 * 60
        assert observation.quality["stale"] is True


def test_rows_older_than_the_max_age_are_not_presented_as_current():
    # 픽스처 마지막 행은 10-25 23:50. 몇 시간 뒤에는 어떤 칸도 '지금' 관측이 아니다.
    assert _current(_provider(now=datetime(2026, 10, 26, 3, 0, tzinfo=KST))) == {}
    # 기본 한계 = 10분 + 15분 + 10분 = 35분: 23:50 행은 00:25 까지만 나온다.
    assert CONFIG.max_age_seconds(600) == 35 * 60
    assert _current(_provider(now=datetime(2026, 10, 26, 0, 25, tzinfo=KST)))
    assert _current(_provider(now=datetime(2026, 10, 26, 0, 26, tzinfo=KST))) == {}


def test_unknown_latency_still_flags_stale_and_drops_old_rows():
    config = tt.TelecomGridConfig(source="synthetic_gyeongju_grid", cell_size_m=100, expected_latency_seconds=None)
    assert (config.stale_after_seconds(600), config.max_age_seconds(600)) == (20 * 60, 30 * 60)
    fresh = _current(_provider(config=config, now=datetime(2026, 10, 25, 15, 5, tzinfo=KST)))
    assert fresh and all("stale" not in item.quality for item in fresh.values())
    late = _current(_provider(config=config, now=datetime(2026, 10, 26, 0, 15, tzinfo=KST)))  # 23:50 + 25분
    assert late and all(item.quality["stale"] is True for item in late.values())
    assert _current(_provider(config=config, now=datetime(2026, 10, 26, 0, 21, tzinfo=KST))) == {}
    explicit = tt.TelecomGridConfig(source="synthetic_gyeongju_grid", max_row_age_seconds=6 * 3600)
    assert explicit.max_age_seconds(600) == 6 * 3600


# ── 기준선: 가려진 행도 표본이다 ───────────────────────────────────────────────

_SAT_15 = datetime(2026, 10, 24, 15, 0, tzinfo=KST)


def _masked_slot_payload(min_count):
    """같은 칸 · 토요일 15시대 24행: 가린 12행 + 5~16명 12행(리뷰 재현)."""
    rows = []
    for week in range(1, 13):
        at = _SAT_15 - timedelta(weeks=week)
        rows.append({"cell_id": "A1", "observed_at": at.isoformat(), "sample_flag": "masked"})
        rows.append({"cell_id": "A1", "observed_at": (at + timedelta(minutes=10)).isoformat(),
                     "population": 4 + week, "sample_flag": "low"})
    meta = {"min_count": min_count} if min_count is not None else {}
    return tt.parse_grid_json(_json(rows, **meta))


@pytest.mark.parametrize("min_count", [5, None])
def test_masked_rows_count_as_low_samples_in_the_baseline(min_count):
    payload = _masked_slot_payload(min_count)
    baseline = tt.GridBaseline()
    baseline.add_payload(payload, "gyeongju")
    # 6명: 가린 12행 + 5명 1행이 아래, 6명 1행이 같다 → (13 + 0.5) / 24.
    assert baseline.quantile_rank("gyeongju:A1", _SAT_15, 6.0) == (pytest.approx(13.5 / 24), 24)
    # 가린 행을 빼던 예전 계산이면 (0.125, 12) = '여유' — 덜 붐빈다고 잘못 말한다.
    now = _SAT_15 + timedelta(minutes=5)
    live = tt.parse_grid_json(_json([{"cell_id": "A1", "observed_at": _SAT_15.isoformat(), "population": 6}]))
    config = tt.TelecomGridConfig()
    observation = asyncio.run(
        tt.TelecomGridProvider(tt.static_feed(live), config, baseline=baseline, clock=lambda: now)
        .fetch_current(tt.zones_from_payload(live, config))
    )[0]
    assert observation.quality["level_method"] == "baseline_quantile"
    assert observation.level_label == "보통"


def test_masked_baseline_value_is_the_contract_bound_or_below_everything():
    assert tt.masked_baseline_value(5) == 4.0
    assert tt.masked_baseline_value(None) == tt.MASKED_SENTINEL < 0
    baseline = tt.GridBaseline()
    baseline.add("gyeongju:x", _SAT_15, None)  # 결측(가림 표시 없음)은 여전히 빠진다
    assert baseline.samples("gyeongju:x", _SAT_15) == 0
    baseline.add("gyeongju:x", _SAT_15, None, masked=True)
    assert baseline.quantile_rank("gyeongju:x", _SAT_15, 0.0) == (1.0, 1), "가린 값은 실제 0명보다도 아래"


def test_baseline_from_stored_observations_keeps_masked_rows():
    payload = _masked_slot_payload(5)
    config = tt.TelecomGridConfig()
    zones = tt.zones_from_payload(payload, config)
    stored = []
    for row in payload.rows:  # 저장된 관측을 흉내: 행마다 그 시각에 받은 관측
        at = row.observed_at + timedelta(minutes=5)
        single = tt.GridPayload(cells=payload.cells, rows=(row,), cell_size_m=50, min_count=5)
        stored += asyncio.run(
            tt.TelecomGridProvider(tt.static_feed(single), config, clock=lambda at=at: at).fetch_current(zones)
        )
    assert sum(bool(item.quality.get("masked")) for item in stored) == 12
    baseline = tt.GridBaseline()
    baseline.add_observations(stored)
    assert baseline.quantile_rank("gyeongju:A1", _SAT_15, 6.0) == (pytest.approx(13.5 / 24), 24)


def test_unknown_cells_and_foreign_provider_zones_are_dropped():
    payload = _payload()
    zones = list(tt.zones_from_payload(payload, CONFIG))
    ghost = tt.Zone(**{**zones[0].__dict__, "zone_id": "gyeongju:G100-9-9", "provider_zone_code": "G100-9-9"})
    other = tt.Zone(**{**zones[0].__dict__, "zone_id": "gyeongju:other", "provider": "someone_else"})
    observations = asyncio.run(_provider().fetch_current([ghost, other, *zones, zones[0]]))
    assert [item.zone_id for item in observations] == [zone.zone_id for zone in zones], "중복 구역도 한 번만"


def test_feed_failure_is_no_observation_not_an_exception():
    async def broken():
        raise TimeoutError("vendor down")

    async def wrong_type():
        return {"rows": []}

    zones = tt.zones_from_payload(_payload(), CONFIG)
    for feed in (broken, wrong_type):
        provider = tt.TelecomGridProvider(feed, CONFIG, clock=lambda: SUN_1505)
        assert asyncio.run(provider.fetch_current(zones)) == []
        assert asyncio.run(provider.fetch_forecast(zones, timedelta(hours=1))) == []
    assert asyncio.run(_provider().fetch_current([])) == []


# ── 전달물 읽기 ───────────────────────────────────────────────────────────────


def _json(rows, **meta):
    return {"format": tt.PAYLOAD_FORMAT, "cell_size_m": 50, "period_seconds": 600, "cells": [
        {"cell_id": "A1", "centroid_lat": 35.8361, "centroid_lng": 129.2105}], "rows": rows, **meta}


def test_bad_rows_are_rejected_one_by_one():
    payload = tt.parse_grid_json(_json([
        {"cell_id": "A1", "observed_at": "2026-10-25T15:00+09:00", "population": 10},
        {"cell_id": "A1", "observed_at": "2026-10-25T15:10+09:00", "population": -1},
        {"cell_id": "A1", "observed_at": "2026-10-25T15:10+09:00", "population": "NaN"},
        {"cell_id": "A1", "observed_at": "2026-10-25T15:10+09:00"},  # 인원도 마스킹 표시도 없다 = 결측
        {"cell_id": "A 1", "observed_at": "2026-10-25T15:10+09:00", "population": 3},
        {"cell_id": "A1", "observed_at": "어제", "population": 3},
        "not a row",
    ]))
    assert len(payload.rows) == 1 and payload.rejected_rows == 6


@pytest.mark.parametrize("data", [[], {"rows": "x"}, {"format": "vendor.v9", "rows": []}])
def test_unreadable_payload_raises_a_payload_error(data):
    with pytest.raises(tt.GridPayloadError):
        tt.parse_grid_json(data)


def test_invalid_interval_is_dropped_and_flagged_and_foreign_kept():
    payload = tt.parse_grid_json(_json([
        {"cell_id": "A1", "observed_at": "2026-10-25T15:00+09:00", "population": 40,
         "population_low": 50, "population_high": 60, "foreign_population": 7, "sample_flag": "weird"},
    ]))
    config = tt.TelecomGridConfig(source="telecom_grid")
    zones = tt.zones_from_payload(payload, config)
    observation = asyncio.run(
        tt.TelecomGridProvider(tt.static_feed(payload), config, clock=lambda: SUN_1505).fetch_current(zones)
    )[0]
    assert observation.population_min is None and observation.quality["ci_dropped"] is True
    assert observation.quality["foreign_population"] == 7
    assert observation.quality["sample_flag"] == "unknown" and observation.quality["low_sample"] is True
    # 50m 칸 = 2,500m² → 40명 = 0.016 → 보통.
    assert observation.level_label == "보통"


def test_csv_with_inline_centroids_and_naive_compact_timestamps():
    text = (
        "﻿cell_id,observed_at,population,sample_flag,centroid_lat,centroid_lng\n"
        "B7,202610251450,120,ok,35.8361,129.2105\n"
        "B7,202610251500,130.5,ok,35.8361,129.2105\n"
        "B8,202610251500,,masked,35.8370,129.2105\n"
    )
    payload = tt.parse_grid_csv(text, cell_size_m=50, period_seconds=600, min_count=3)
    assert sorted(payload.cells) == ["B7", "B8"] and payload.rejected_rows == 0
    config = tt.TelecomGridConfig()
    zones = tt.zones_from_payload(payload, config)
    provider = tt.TelecomGridProvider(tt.static_feed(payload), config, clock=lambda: SUN_1505)
    current = _by_zone(asyncio.run(provider.fetch_current(zones)))
    assert current["B7"].observed_at == datetime(2026, 10, 25, 15, 0, tzinfo=KST)
    assert current["B7"].quality["timestamp_assumed_kst"] is True
    assert current["B8"].quality["masked"] is True and current["B8"].population_max == 2


def test_csv_without_required_columns_is_rejected():
    with pytest.raises(tt.GridPayloadError):
        tt.parse_grid_csv("cell,time\nA,1\n")


def test_file_feed_reads_the_fixture(tmp_path):
    zones = tt.zones_from_payload(_payload(), CONFIG)
    provider = tt.TelecomGridProvider(tt.file_feed(FIXTURE), CONFIG, clock=lambda: SUN_1505)
    assert len(asyncio.run(provider.fetch_current(zones))) == 4
    csv_path = tmp_path / "grid.csv"
    csv_path.write_text("cell_id,observed_at,population,centroid_lat,centroid_lng\nC1,2026-10-25T15:00+09:00,5,35.8,129.2\n",
                        encoding="utf-8")
    assert len(tt.load_grid_file(csv_path, cell_size_m=50).rows) == 1


# ── 예측(선택) ────────────────────────────────────────────────────────────────


def test_forecast_rows_become_forecasts_with_level_only_when_baseline_exists():
    payload = tt.parse_grid_json(_json([
        {"cell_id": "A1", "observed_at": "2026-10-25T15:00+09:00", "population": 100, "forecast": [
            {"target_at": "2026-10-25T16:00+09:00", "population": 150, "population_low": 120, "population_high": 180},
            {"target_at": "2026-10-25T18:00+09:00", "population": 90},
            {"target_at": "2026-10-25T14:00+09:00", "population": 80},  # 관측보다 앞선 예측은 버린다
            {"target_at": "모름", "population": 80},
        ]},
    ]))
    config = tt.TelecomGridConfig(provides_forecast=True)
    zones = tt.zones_from_payload(payload, config)
    provider = tt.TelecomGridProvider(tt.static_feed(payload), config, clock=lambda: SUN_1505)

    forecasts = asyncio.run(provider.fetch_forecast(zones, timedelta(hours=3)))
    assert [(item.population_min, item.population_max) for item in forecasts] == [(120, 180), (90, 90)]
    assert all(item.level is None for item in forecasts), "기준선 없이는 예측 단계를 매기지 않는다"
    assert [item.target_at.hour for item in asyncio.run(provider.fetch_forecast(zones, timedelta(hours=1)))] == [16]

    baseline = tt.GridBaseline(slot_minutes=60, by_weekday=True)
    for week in range(1, 13):
        baseline.add("gyeongju:A1", datetime(2026, 10, 25, 16, 0, tzinfo=KST) - timedelta(weeks=week), 100.0 + week)
    with_baseline = tt.TelecomGridProvider(tt.static_feed(payload), config, baseline=baseline, clock=lambda: SUN_1505)
    first = asyncio.run(with_baseline.fetch_forecast(zones, timedelta(hours=1)))[0]
    assert first.level == 1.0 and first.level_label == "붐빔"


# ── 설정 ─────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "overrides",
    [
        {"region": "Gyeongju"},
        {"level_bands": (0.75, 0.5, 0.9)},
        {"level_bands": (0.5, 0.75, 1.0)},
        {"fallback_density_per_m2": (0.0, 0.03, 0.06)},
        {"baseline_slot_minutes": 7},
        {"min_baseline_samples": 0},
        {"max_row_age_seconds": 0},
    ],
)
def test_config_rejects_nonsense(overrides):
    with pytest.raises(ValueError):
        tt.TelecomGridConfig(**overrides)


def test_describe_states_unknowns_honestly():
    description = tt.TelecomGridProvider(tt.static_feed(_payload())).describe()
    assert description.region == "gyeongju"
    assert description.spatial_resolution == "격자(칸 크기는 계약에서 확인)"
    assert "견적에서 확인" in description.license
    assert _provider().describe().spatial_resolution == "100m 격자"


def test_fixture_is_valid_json_for_humans_too():
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert data["format"] == tt.PAYLOAD_FORMAT and "합성" in data["note"]
