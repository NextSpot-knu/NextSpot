"""통신사 격자 유동인구 → `CrowdObservation` 어댑터 **템플릿**(경주 전환 키트, S5).

`docs/SEOUL_TESTBED_PLAN.md` §3.5 · §5 · §6 S5, 요구 명세는 `docs/CROWD_DATA_CONTRACT.md`.
경주 통신사 데이터를 사면 이 파일을 복사해 공급원 전용 부분(받아 오기 `GridFeed` · 필드 이름)만 바꾸고,
나머지(격자 → 구역, 인원 → 0~1 단계, 표본·마스킹 플래그)는 그대로 쓴다. 추천 엔진·화면은 바꾸지 않는다(G3).

**아직 어디에도 연결하지 않는다** — 수집 경로·엔드포인트·설정이 이 모듈을 부르지 않는다. 테스트
(`tests/services/test_crowd_telecom_template.py` · `test_crowd_provider_contract.py`)만 부른다.

## 기준 전달 형식 `nextspot.crowd_grid.v1`(JSON) — CSV 는 같은 열 이름
    {
      "format": "nextspot.crowd_grid.v1",
      "cell_size_m": 50, "period_seconds": 600, "min_count": 5,       # 공급원 메타(선택)
      "cells": [{"cell_id": "…", "centroid_lat": 35.8, "centroid_lng": 129.2,
                 "bbox": [min_lng, min_lat, max_lng, max_lat]}],       # 중심 또는 bbox 하나는 필수
      "rows":  [{"cell_id": "…", "observed_at": "2026-10-25T15:00+09:00",   # 집계 구간 **시작** 시각
                 "population": 615.9,                                  # 체류 인구 추정(가려졌으면 생략)
                 "population_low": …, "population_high": …,           # 신뢰구간(선택)
                 "sample_flag": "ok" | "low" | "masked",              # 표본 플래그(선택)
                 "foreign_population": …,                              # 외국인 추정(선택)
                 "forecast": [{"target_at": "…", "population": …}]}]  # 예측(선택)
    }
  · 행에 `centroid_lat/lng`(또는 `min_lng,min_lat,max_lng,max_lat`)를 직접 실어도 된다(CSV 는 이 방식).
  · 시각에 시간대가 없으면 KST 로 읽고 `quality.timestamp_assumed_kst` 를 남긴다. `YYYYMMDDHHMM` 도 읽는다.
  · 행 단위 오류(칸 ID 없음 · 시각 못 읽음 · 음수/NaN 인원)는 그 행만 버린다 — 지어내지 않는다.

## 인원 → 0~1 단계(§3.5)
  1. **기준선 분위수**(`level_method=baseline_quantile`): 같은 구역 · 같은 요일 · 같은 시간대(기본 1시간)의
     과거 인원 분포에서 지금 값의 순위(중간 순위, 0~1). 표본이 `min_baseline_samples`(기본 12 = 2주 × 6행)
     이상일 때만 쓴다. 단계 이름은 `level_bands` 경계로 나눈다(임계값은 전환 체크리스트 6단계에서 확정).
  2. **보수적 대체**(`level_method=density_fallback`, `level_provisional=True`): 기준선이 모자라면 칸 넓이당
     인원(명/m²)을 `fallback_density_per_m2` 경계로 4단계에 넣고 구간 중앙값(0.125·0.375·0.625·0.875)을 쓴다.
     경계는 일부러 낮게 잡았다 — 덜 붐빈다고 잘못 말해 사람을 붐비는 곳으로 보내는 쪽이 더 나쁜 오류다.
  3. 둘 다 안 되면(칸 넓이도 모름) 단계는 None, `level_method=none`.
  · 가려진 칸(`masked`)은 단계·인원 점 추정을 만들지 않는다. 공급원이 `min_count` 를 밝혔으면 인원 범위
    0 ~ min_count-1 만 남긴다(계약이 보장하는 사실이라 지어낸 값이 아니다).
  · 표본 적은 칸(`low` · 알 수 없는 플래그 · 신뢰구간 폭이 추정치보다 큼)은 값은 그대로 두고
    `quality.low_sample=True` 로 표시한다. 순위에서 얼마나 깎을지는 엔진(S3)이 정한다.
  · 기준선에는 가려진 행도 **표본으로 넣는다**(`GridBaseline.add(masked=True)`). 빼면 한산한 시간이 분포에서
    사라져 지금 값의 순위가 낮게 나온다 — 덜 붐빈다고 잘못 말하는 쪽으로 기운다. 넣는 값은 `min_count` 를
    알면 `min_count - 1`(가린 값의 상한), 모르면 `MASKED_SENTINEL`(-1, 모든 실제 값보다 아래)이다. 실제 값
    (≥ min_count)의 순위는 둘 중 어느 쪽이든 정확하다.

## 오래된 행
  · 지연 `lag = 받은 시각 − 집계 시작`. `lag > period + expected_latency`(지연 목표를 모르면 `period × 2`)면
    `quality.stale`. 그보다 한 집계 주기(`period`) 더 늦으면(기본 10+15+10 = 35분) **현재값으로 내지 않고
    그 구역을 뺀다** — 몇 시간 전 행을 '지금'으로 보여 주지 않는다. `max_row_age_seconds` 로 바꿀 수 있다.
"""

from __future__ import annotations

import asyncio
import bisect
import csv
import io
import json
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable, Mapping, Sequence

import structlog

from app.services.crowd.observation import (
    CrowdForecast,
    CrowdObservation,
    ProviderDescription,
    Zone,
    forecasts_within,
)

logger = structlog.get_logger()

PAYLOAD_FORMAT = "nextspot.crowd_grid.v1"
LEVEL_SCALE_BASELINE = "telecom_baseline_quantile"
LEVEL_SCALE_FALLBACK = "telecom_density_fallback_4"
LEVEL_LABELS = ("여유", "보통", "약간 붐빔", "붐빔")
# 대체 단계의 구간 중앙값 — 서울 4등급 환산(seoul_provider.level_for_label)과 같은 눈금.
BAND_MIDPOINTS = (0.125, 0.375, 0.625, 0.875)
SAMPLE_FLAGS = ("ok", "low", "masked")

KST = timezone(timedelta(hours=9))
_CELL_ID = re.compile(r"^[^\s:]{1,64}$")
_DIGITS_TIME = re.compile(r"^\d{12}(\d{2})?$")


class GridPayloadError(ValueError):
    """전달물 전체를 읽을 수 없다(형식이 아니다). 행 하나의 오류는 이 예외가 아니라 그 행을 버린다."""


# ── 설정 ─────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class TelecomGridConfig:
    """공급원 하나의 설정. 계약이 정해지면 값만 바꾼다(코드 변경 없이)."""

    source: str = "telecom_grid"
    region: str = "gyeongju"
    cluster: str | None = "hwangnidan"
    # 전달물에 cell_size_m 이 있으면 그 값이 이긴다.
    cell_size_m: float | None = None
    period_seconds: int = 600
    # 관측(집계 끝) → 수신 목표. 계약 명세 §4 '≤ 15분'. None = 모름.
    expected_latency_seconds: int | None = 15 * 60
    provides_forecast: bool = False
    provides_history: bool = True
    license: str = "계약 전 — 견적에서 확인(docs/CROWD_DATA_CONTRACT.md §9)"
    baseline_slot_minutes: int = 60
    baseline_by_weekday: bool = True
    min_baseline_samples: int = 12
    # 기준선 분위수 → 단계 이름 경계(여유|보통|약간 붐빔|붐빔). 잠정값 — 체크리스트 6단계에서 확정.
    level_bands: tuple[float, float, float] = (0.5, 0.75, 0.9)
    # 대체 단계 경계(명/m²). 100m 칸이면 100 · 300 · 600명. 잠정값 — 일부러 낮다.
    fallback_density_per_m2: tuple[float, float, float] = (0.01, 0.03, 0.06)
    # 신뢰구간 폭 / 추정치 가 이 값을 넘으면 표본 부족으로 본다.
    low_sample_ci_ratio: float = 1.0
    # 공급원 시계가 조금 앞서도 받는 허용치. 이보다 미래 시각의 행은 버린다.
    future_tolerance_seconds: int = 60
    # 이보다 오래된 행은 현재값으로 내지 않는다(구역을 뺀다). None = stale 기준 + 집계 주기 1번.
    max_row_age_seconds: int | None = None

    def stale_after_seconds(self, period: int | None = None) -> int:
        """이 지연을 넘으면 `quality.stale`. period = 전달물의 집계 주기(없으면 설정값).
        지연 목표를 모르면 집계 주기 한 번을 목표로 본다."""
        period = period or self.period_seconds
        latency = self.expected_latency_seconds if self.expected_latency_seconds is not None else period
        return period + latency

    def max_age_seconds(self, period: int | None = None) -> int:
        """이보다 오래된 행은 현재값으로 내지 않는다(기본 stale 기준 + 집계 주기 1번)."""
        if self.max_row_age_seconds is not None:
            return self.max_row_age_seconds
        return self.stale_after_seconds(period) + (period or self.period_seconds)

    def __post_init__(self) -> None:
        if not re.match(r"^[a-z][a-z0-9_]*$", self.region):
            raise ValueError("region must match zones.region (^[a-z][a-z0-9_]*$)")
        for bands in (self.level_bands, self.fallback_density_per_m2):
            if len(bands) != 3 or list(bands) != sorted(bands) or bands[0] <= 0:
                raise ValueError("bands must be three increasing positive thresholds")
        if self.level_bands[-1] >= 1:
            raise ValueError("level_bands must stay below 1")
        if self.baseline_slot_minutes <= 0 or 1440 % self.baseline_slot_minutes:
            raise ValueError("baseline_slot_minutes must divide a day")
        if self.min_baseline_samples < 1 or self.period_seconds <= 0:
            raise ValueError("min_baseline_samples and period_seconds must be positive")
        if self.max_row_age_seconds is not None and self.max_row_age_seconds <= 0:
            raise ValueError("max_row_age_seconds must be positive")


# ── 전달물 ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class GridCell:
    cell_id: str
    centroid_lat: float
    centroid_lng: float
    # (min_lng, min_lat, max_lng, max_lat) — GeoJSON bbox 순서.
    bbox: tuple[float, float, float, float] | None = None


@dataclass(frozen=True)
class GridForecastPoint:
    target_at: datetime
    population: float | None
    population_low: float | None = None
    population_high: float | None = None


@dataclass(frozen=True)
class GridRow:
    cell_id: str
    observed_at: datetime
    population: float | None
    population_low: float | None = None
    population_high: float | None = None
    sample_flag: str | None = None
    foreign_population: float | None = None
    timestamp_assumed_kst: bool = False
    ci_dropped: bool = False
    forecast: tuple[GridForecastPoint, ...] = ()


@dataclass(frozen=True)
class GridPayload:
    cells: dict[str, GridCell]
    rows: tuple[GridRow, ...]
    cell_size_m: float | None = None
    period_seconds: int | None = None
    min_count: int | None = None
    rejected_rows: int = 0


GridFeed = Callable[[], Awaitable[GridPayload]]
"""공급원에서 최신 전달물을 받아 오는 함수. **공급원마다 바꾸는 유일한 부분**(API pull · 파일 수신)."""


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str):
        value = value.replace(",", "").strip()
        if not value:
            return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def parse_timestamp(value: Any) -> tuple[datetime, bool] | None:
    """ISO 8601 또는 `YYYYMMDDHHMM[SS]`. (시각, KST 로 가정했는가). 못 읽으면 None."""
    text = str(value or "").strip()
    if not text:
        return None
    moment: datetime | None = None
    if _DIGITS_TIME.match(text):
        fmt = "%Y%m%d%H%M%S" if len(text) == 14 else "%Y%m%d%H%M"
        try:
            moment = datetime.strptime(text, fmt)
        except ValueError:
            return None
    else:
        try:
            moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if moment.tzinfo is None:
        return moment.replace(tzinfo=KST), True
    return moment, False


def _cell_id(value: Any) -> str | None:
    text = str(value or "").strip()
    return text if _CELL_ID.match(text) else None


def _bbox(raw: Mapping[str, Any]) -> tuple[float, float, float, float] | None:
    values = raw.get("bbox")
    if isinstance(values, (list, tuple)) and len(values) == 4:
        box = [_number(item) for item in values]
    else:
        box = [_number(raw.get(key)) for key in ("min_lng", "min_lat", "max_lng", "max_lat")]
    if any(item is None for item in box):
        return None
    min_lng, min_lat, max_lng, max_lat = box  # type: ignore[misc]
    if not (min_lng < max_lng and min_lat < max_lat and -90 <= min_lat and max_lat <= 90):
        return None
    return (min_lng, min_lat, max_lng, max_lat)


def _cell(raw: Mapping[str, Any]) -> GridCell | None:
    cell_id = _cell_id(raw.get("cell_id"))
    if cell_id is None:
        return None
    box = _bbox(raw)
    lat, lng = _number(raw.get("centroid_lat")), _number(raw.get("centroid_lng"))
    if (lat is None or lng is None) and box is not None:
        lat, lng = (box[1] + box[3]) / 2, (box[0] + box[2]) / 2
    if lat is None or lng is None or not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None
    return GridCell(cell_id=cell_id, centroid_lat=lat, centroid_lng=lng, bbox=box)


def _sample_flag(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    if not text:
        return None
    return text if text in SAMPLE_FLAGS else "unknown"


def _forecast_points(raw: Any) -> tuple[GridForecastPoint, ...]:
    points: list[GridForecastPoint] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, Mapping):
            continue
        parsed = parse_timestamp(item.get("target_at"))
        population = _number(item.get("population"))
        if parsed is None or (population is not None and population < 0):
            continue
        low, high = _number(item.get("population_low")), _number(item.get("population_high"))
        if population is None or low is None or high is None or not 0 <= low <= population <= high:
            low = high = None
        points.append(GridForecastPoint(parsed[0], population, low, high))
    points.sort(key=lambda point: point.target_at)
    return tuple(points)


def _row(raw: Mapping[str, Any]) -> GridRow | None:
    cell_id = _cell_id(raw.get("cell_id"))
    parsed = parse_timestamp(raw.get("observed_at"))
    if cell_id is None or parsed is None:
        return None
    flag = _sample_flag(raw.get("sample_flag"))
    population = _number(raw.get("population"))
    if population is not None and population < 0:
        return None
    if population is None and flag != "masked":
        # 인원이 없는데 가렸다는 표시도 없다 — 결측 행이다. 0 으로 채우지 않는다.
        return None
    if flag == "masked":
        population = None
    low, high = _number(raw.get("population_low")), _number(raw.get("population_high"))
    ci_dropped = False
    if low is not None or high is not None:
        if population is None or low is None or high is None or not 0 <= low <= population <= high:
            low = high = None
            ci_dropped = population is not None
    foreign = _number(raw.get("foreign_population"))
    if foreign is not None and (foreign < 0 or (population is not None and foreign > population)):
        foreign = None
    return GridRow(
        cell_id=cell_id,
        observed_at=parsed[0],
        population=population,
        population_low=low,
        population_high=high,
        sample_flag=flag,
        foreign_population=foreign,
        timestamp_assumed_kst=parsed[1],
        ci_dropped=ci_dropped,
        forecast=_forecast_points(raw.get("forecast")),
    )


def _optional_positive(value: Any) -> float | None:
    number = _number(value)
    return number if number is not None and number > 0 else None


def _build_payload(
    raw_cells: Iterable[Mapping[str, Any]],
    raw_rows: Iterable[Any],
    *,
    cell_size_m: Any,
    period_seconds: Any,
    min_count: Any,
) -> GridPayload:
    cells: dict[str, GridCell] = {}
    for raw in raw_cells:
        cell = _cell(raw) if isinstance(raw, Mapping) else None
        if cell is not None:
            cells[cell.cell_id] = cell
    rows: list[GridRow] = []
    rejected = 0
    for raw in raw_rows:
        row = _row(raw) if isinstance(raw, Mapping) else None
        if row is None:
            rejected += 1
            continue
        if row.cell_id not in cells and isinstance(raw, Mapping):
            # 행에 칸 좌표를 직접 실은 형식(CSV).
            cell = _cell(raw)
            if cell is not None:
                cells[cell.cell_id] = cell
        rows.append(row)
    period = _optional_positive(period_seconds)
    count = _optional_positive(min_count)
    return GridPayload(
        cells=cells,
        rows=tuple(rows),
        cell_size_m=_optional_positive(cell_size_m),
        period_seconds=int(period) if period is not None else None,
        min_count=int(count) if count is not None else None,
        rejected_rows=rejected,
    )


def parse_grid_json(data: Any) -> GridPayload:
    if not isinstance(data, Mapping) or not isinstance(data.get("rows"), list):
        raise GridPayloadError("grid payload must be an object with a 'rows' list")
    declared = data.get("format")
    if declared is not None and declared != PAYLOAD_FORMAT:
        raise GridPayloadError(f"unsupported grid payload format: {declared!r}")
    cells = data.get("cells")
    return _build_payload(
        cells if isinstance(cells, list) else [],
        data["rows"],
        cell_size_m=data.get("cell_size_m"),
        period_seconds=data.get("period_seconds"),
        min_count=data.get("min_count"),
    )


def parse_grid_csv(
    text: str,
    *,
    cell_size_m: float | None = None,
    period_seconds: int | None = None,
    min_count: int | None = None,
) -> GridPayload:
    """CSV(머리줄 = JSON 행의 키 이름). 메타(칸 크기·주기·최소 인원)는 계약값을 인자로 준다."""
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    if not reader.fieldnames or "cell_id" not in reader.fieldnames or "observed_at" not in reader.fieldnames:
        raise GridPayloadError("grid CSV needs cell_id and observed_at columns")
    return _build_payload(
        [], list(reader), cell_size_m=cell_size_m, period_seconds=period_seconds, min_count=min_count
    )


def load_grid_file(path: str | Path, **csv_meta: Any) -> GridPayload:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    if target.suffix.lower() == ".csv":
        return parse_grid_csv(text, **csv_meta)
    return parse_grid_json(json.loads(text))


def static_feed(payload: GridPayload) -> GridFeed:
    """고정 전달물(테스트 · 받은 샘플 파일 검증용)."""

    async def feed() -> GridPayload:
        return payload

    return feed


def file_feed(path: str | Path, **csv_meta: Any) -> GridFeed:
    """주기 파일 전달 방식의 최소 구현 — 매번 파일을 다시 읽는다."""

    async def feed() -> GridPayload:
        return await asyncio.to_thread(load_grid_file, path, **csv_meta)

    return feed


# ── 격자 → 구역 ───────────────────────────────────────────────────────────────


def zone_id_for_cell(region: str, cell_id: str) -> str:
    return f"{region}:{cell_id}"


def _cell_area_m2(cell: GridCell | None, cell_size_m: float | None) -> float | None:
    if cell_size_m:
        return cell_size_m * cell_size_m
    if cell is None or cell.bbox is None:
        return None
    min_lng, min_lat, max_lng, max_lat = cell.bbox
    mid = math.radians((min_lat + max_lat) / 2)
    return (max_lat - min_lat) * 111_320.0 * (max_lng - min_lng) * 111_320.0 * math.cos(mid)


def zones_from_payload(payload: GridPayload, config: TelecomGridConfig) -> tuple[Zone, ...]:
    """전달물의 칸 → `grid_cell` 구역. 반지름은 칸과 같은 넓이 원의 반지름(서울 구역과 같은 정의)."""
    size = payload.cell_size_m or config.cell_size_m
    zones: list[Zone] = []
    for cell in sorted(payload.cells.values(), key=lambda item: item.cell_id):
        area = _cell_area_m2(cell, size)
        zones.append(
            Zone(
                zone_id=zone_id_for_cell(config.region, cell.cell_id),
                region=config.region,
                kind="grid_cell",
                name=f"격자 {cell.cell_id}",
                provider=config.source,
                provider_zone_code=cell.cell_id,
                provider_zone_name=None,
                cluster=config.cluster,
                centroid_lat=cell.centroid_lat,
                centroid_lng=cell.centroid_lng,
                radius_m=max(1, round(math.sqrt(area / math.pi))) if area else None,
            )
        )
    return tuple(zones)


def zone_table_rows(payload: GridPayload, config: TelecomGridConfig) -> list[dict[str, Any]]:
    """`zones` 표 upsert 행(전환 체크리스트 1단계). bbox 가 있으면 GeoJSON Polygon 을 싣는다. DB 접근 없음."""
    rows: list[dict[str, Any]] = []
    for zone in zones_from_payload(payload, config):
        cell = payload.cells[zone.provider_zone_code or ""]
        geometry = None
        if cell.bbox is not None:
            min_lng, min_lat, max_lng, max_lat = cell.bbox
            ring = [[min_lng, min_lat], [max_lng, min_lat], [max_lng, max_lat], [min_lng, max_lat], [min_lng, min_lat]]
            geometry = {"type": "Polygon", "coordinates": [ring]}
        rows.append(
            {
                "zone_id": zone.zone_id,
                "region": zone.region,
                "kind": zone.kind,
                "name": zone.name,
                "provider": zone.provider,
                "provider_zone_code": zone.provider_zone_code,
                "provider_zone_name": zone.provider_zone_name,
                "cluster": zone.cluster,
                "centroid_lat": zone.centroid_lat,
                "centroid_lng": zone.centroid_lng,
                "radius_m": zone.radius_m,
                "geometry": geometry,
            }
        )
    return rows


# ── 기준선 ────────────────────────────────────────────────────────────────────


# 최소 인원(min_count)을 모를 때 가려진 행이 기준선에 들어가는 값 — 모든 실제 인원(≥ 0)보다 아래.
MASKED_SENTINEL = -1.0


def masked_baseline_value(min_count: int | None) -> float:
    """가려진 행의 기준선 값. min_count 를 알면 가린 값의 상한(min_count-1), 모르면 MASKED_SENTINEL."""
    return float(min_count - 1) if min_count and min_count >= 1 else MASKED_SENTINEL


class GridBaseline:
    """구역 × (요일, 시간대) 인원 분포.

    가려진 행(masked)은 **표본으로 넣는다** — 결측(인원 없음 · 표시 없음)만 뺀다. 가려진 행을 빼면 한산한
    시간이 분포에서 사라져 지금 값의 순위가 낮게(덜 붐빈다고) 나온다. 값은 `masked_baseline_value` 를 쓴다.

    채우는 곳: 계약의 8주 백필(`add_payload`) 또는 우리가 쌓은 `zone_crowd_snapshots`(`add_observations`).
    지금 판정할 관측 자체를 넣은 뒤 순위를 매기면 자기 자신이 섞인다 — 기준선은 판정 시각 **이전** 이력으로 만든다.
    """

    def __init__(self, *, slot_minutes: int = 60, by_weekday: bool = True) -> None:
        if slot_minutes <= 0 or 1440 % slot_minutes:
            raise ValueError("slot_minutes must divide a day")
        self.slot_minutes = slot_minutes
        self.by_weekday = by_weekday
        self._values: dict[tuple[str, int, int], list[float]] = {}

    @classmethod
    def for_config(cls, config: TelecomGridConfig) -> "GridBaseline":
        return cls(slot_minutes=config.baseline_slot_minutes, by_weekday=config.baseline_by_weekday)

    def slot(self, moment: datetime) -> tuple[int, int]:
        local = moment.astimezone(KST)
        weekday = local.weekday() if self.by_weekday else -1
        return weekday, (local.hour * 60 + local.minute) // self.slot_minutes

    def add(
        self,
        zone_id: str,
        observed_at: datetime,
        population: float | None,
        *,
        masked: bool = False,
        min_count: int | None = None,
    ) -> None:
        if masked:
            value = masked_baseline_value(min_count)
        elif population is None or not math.isfinite(population) or population < 0:
            return  # 결측 — 지어내지 않는다
        else:
            value = float(population)
        bisect.insort(self._values.setdefault((zone_id, *self.slot(observed_at)), []), value)

    def add_payload(self, payload: GridPayload, region: str, *, before: datetime | None = None) -> None:
        for row in payload.rows:
            if before is None or row.observed_at < before:
                self.add(
                    zone_id_for_cell(region, row.cell_id),
                    row.observed_at,
                    row.population,
                    masked=row.sample_flag == "masked",
                    min_count=payload.min_count,
                )

    def add_observations(self, observations: Iterable[CrowdObservation]) -> None:
        """저장된 관측(`zone_crowd_snapshots`)에서. 가려진 관측은 `quality.masked` 로 알아보고, 상한
        (`population_max` = min_count-1)이 있으면 그 값을 쓴다."""
        for observation in observations:
            masked = bool(observation.quality.get("masked"))
            bound = observation.population_max if masked else None
            self.add(
                observation.zone_id,
                observation.observed_at,
                observation.population_point,
                masked=masked,
                min_count=bound + 1 if bound is not None else None,
            )

    def samples(self, zone_id: str, at: datetime) -> int:
        return len(self._values.get((zone_id, *self.slot(at)), ()))

    def quantile_rank(self, zone_id: str, at: datetime, value: float) -> tuple[float | None, int]:
        """(중간 순위 0~1, 표본 수). 표본이 없으면 (None, 0)."""
        values = self._values.get((zone_id, *self.slot(at)))
        if not values:
            return None, 0
        below = bisect.bisect_left(values, value)
        equal = bisect.bisect_right(values, value) - below
        rank = (below + 0.5 * equal) / len(values)
        return min(1.0, max(0.0, rank)), len(values)

    def slot_label(self, at: datetime) -> str:
        weekday, index = self.slot(at)
        start = index * self.slot_minutes
        day = "all" if weekday < 0 else ("mon", "tue", "wed", "thu", "fri", "sat", "sun")[weekday]
        return f"{day}-{start // 60:02d}{start % 60:02d}"


# ── 단계 ─────────────────────────────────────────────────────────────────────


def _band(value: float, bands: Sequence[float]) -> int:
    return bisect.bisect_right(list(bands), value)


@dataclass(frozen=True)
class _Level:
    level: float | None
    label: str | None
    scale: str
    quality: dict[str, Any] = field(default_factory=dict)


def _level_for(
    zone_id: str,
    at: datetime,
    population: float | None,
    *,
    area_m2: float | None,
    baseline: GridBaseline | None,
    config: TelecomGridConfig,
) -> _Level:
    if population is None:
        return _Level(None, None, LEVEL_SCALE_BASELINE, {"level_method": "none"})
    if baseline is not None:
        rank, samples = baseline.quantile_rank(zone_id, at, population)
        if rank is not None and samples >= config.min_baseline_samples:
            return _Level(
                rank,
                LEVEL_LABELS[_band(rank, config.level_bands)],
                LEVEL_SCALE_BASELINE,
                {"level_method": "baseline_quantile", "baseline_samples": samples, "baseline_slot": baseline.slot_label(at)},
            )
        base_quality: dict[str, Any] = {"baseline_samples": samples, "baseline_required": config.min_baseline_samples}
    else:
        base_quality = {"baseline_samples": 0, "baseline_required": config.min_baseline_samples}
    if area_m2:
        index = _band(population / area_m2, config.fallback_density_per_m2)
        return _Level(
            BAND_MIDPOINTS[index],
            LEVEL_LABELS[index],
            LEVEL_SCALE_FALLBACK,
            {"level_method": "density_fallback", "level_provisional": True, **base_quality},
        )
    return _Level(None, None, LEVEL_SCALE_BASELINE, {"level_method": "none", "level_unavailable": True, **base_quality})


# ── 공급원 ────────────────────────────────────────────────────────────────────


class TelecomGridProvider:
    """`CrowdProvider` 의 통신사 격자 구현(템플릿). 호출 1번 = 전달물 1건(구역 수와 무관)."""

    def __init__(
        self,
        feed: GridFeed,
        config: TelecomGridConfig | None = None,
        *,
        baseline: GridBaseline | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.config = config or TelecomGridConfig()
        self.source = self.config.source
        self._feed = feed
        self._baseline = baseline
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def describe(self) -> ProviderDescription:
        size = self.config.cell_size_m
        return ProviderDescription(
            source=self.config.source,
            region=self.config.region,
            cadence_seconds=self.config.period_seconds,
            expected_latency_seconds=self.config.expected_latency_seconds,
            spatial_resolution=f"{size:g}m 격자" if size else "격자(칸 크기는 계약에서 확인)",
            level_scale=LEVEL_SCALE_BASELINE,
            provides_forecast=self.config.provides_forecast,
            provides_history=self.config.provides_history,
            license=self.config.license,
        )

    async def _payload(self) -> GridPayload | None:
        try:
            payload = await self._feed()
        except Exception as exc:  # noqa: BLE001 — 실패는 '관측 없음'(observation.py 규칙)
            logger.warning("crowd_telecom_feed_failed", source=self.source, error_type=type(exc).__name__)
            return None
        if not isinstance(payload, GridPayload):
            logger.warning("crowd_telecom_feed_invalid", source=self.source)
            return None
        if payload.rejected_rows:
            logger.warning("crowd_telecom_rows_rejected", source=self.source, count=payload.rejected_rows)
        return payload

    def _latest_rows(self, payload: GridPayload, now: datetime) -> dict[str, GridRow]:
        horizon = now + timedelta(seconds=self.config.future_tolerance_seconds)
        oldest = now - timedelta(seconds=self.config.max_age_seconds(payload.period_seconds))
        latest: dict[str, GridRow] = {}
        for row in payload.rows:
            if row.observed_at > horizon or row.observed_at < oldest:
                # 미래 행(시계 어긋남)과 너무 오래된 행은 '현재값'이 아니다 — 그 구역은 관측 없음.
                continue
            current = latest.get(row.cell_id)
            if current is None or row.observed_at >= current.observed_at:
                latest[row.cell_id] = row
        return latest

    def _observation(
        self, zone: Zone, row: GridRow, payload: GridPayload, fetched_at: datetime
    ) -> CrowdObservation:
        config = self.config
        period = payload.period_seconds or config.period_seconds
        area = _cell_area_m2(payload.cells.get(row.cell_id), payload.cell_size_m or config.cell_size_m)
        level = _level_for(
            zone.zone_id, row.observed_at, row.population, area_m2=area, baseline=self._baseline, config=config
        )
        lag = max(0, int((fetched_at - row.observed_at).total_seconds()))
        quality: dict[str, Any] = {
            "provider_zone_code": row.cell_id,
            "lag_seconds": lag,
            "sample_flag": row.sample_flag,
            **level.quality,
        }
        if lag > config.stale_after_seconds(period):
            quality["stale"] = True
        if row.timestamp_assumed_kst:
            quality["timestamp_assumed_kst"] = True
        if row.ci_dropped:
            quality["ci_dropped"] = True
        if row.foreign_population is not None:
            quality["foreign_population"] = row.foreign_population

        pop_min = pop_max = None
        if row.sample_flag == "masked":
            quality["masked"] = True
            if payload.min_count:
                # 공급원이 'min_count 미만은 가린다'고 밝혔다 — 이 범위만은 사실이다.
                pop_min, pop_max = 0, payload.min_count - 1
                quality["population_bound"] = "below_min_count"
        elif row.population_low is not None and row.population_high is not None:
            pop_min, pop_max = math.floor(row.population_low), math.ceil(row.population_high)
            width = row.population_high - row.population_low
            if row.population and width / row.population > config.low_sample_ci_ratio:
                quality["low_sample"] = True
        if row.sample_flag in ("low", "unknown"):
            quality["low_sample"] = True

        forecasts = tuple(
            self._forecast(zone, row, point, area) for point in row.forecast if point.target_at > row.observed_at
        )
        return CrowdObservation(
            zone_id=zone.zone_id,
            source=self.source,
            observed_at=row.observed_at,
            fetched_at=fetched_at,
            level_scale=level.scale,
            period_seconds=period,
            population_min=pop_min,
            population_max=pop_max,
            population_point=row.population,
            level=level.level,
            level_label=level.label,
            forecast=forecasts,
            quality=quality,
        )

    def _forecast(self, zone: Zone, row: GridRow, point: GridForecastPoint, area: float | None) -> CrowdForecast:
        # 예측의 단계는 **기준선이 있을 때만** 매긴다. CrowdForecast 에는 품질 칸이 없어 '잠정 대체'를
        # 표시할 수 없기 때문이다. 인원은 신뢰구간이 있으면 그 범위, 없으면 점 추정을 폭 0 범위로 싣는다.
        level: float | None = None
        label: str | None = None
        if point.population is not None and self._baseline is not None:
            rank, samples = self._baseline.quantile_rank(zone.zone_id, point.target_at, point.population)
            if rank is not None and samples >= self.config.min_baseline_samples:
                level, label = rank, LEVEL_LABELS[_band(rank, self.config.level_bands)]
        if point.population_low is not None and point.population_high is not None:
            low, high = math.floor(point.population_low), math.ceil(point.population_high)
        elif point.population is not None:
            low = high = round(point.population)
        else:
            low = high = None
        return CrowdForecast(
            zone_id=zone.zone_id,
            source=self.source,
            issued_at=row.observed_at,
            target_at=point.target_at,
            population_min=low,
            population_max=high,
            level=level,
            level_label=label,
        )

    async def fetch_current(self, zones: Sequence[Zone]) -> list[CrowdObservation]:
        """구역별 가장 최근 행. 전달물에 없는 구역·다른 공급원 구역은 빠진다(예외 없음)."""
        if not zones:
            return []
        payload = await self._payload()
        if payload is None:
            return []
        now = self._clock()
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        fetched_at = now.astimezone(timezone.utc)
        latest = self._latest_rows(payload, now)
        observations: list[CrowdObservation] = []
        seen: set[str] = set()
        for zone in zones:
            if zone.provider != self.source or zone.zone_id in seen or zone.provider_zone_code is None:
                continue
            row = latest.get(zone.provider_zone_code)
            if row is None:
                continue
            try:
                observations.append(self._observation(zone, row, payload, fetched_at))
            except (ValueError, TypeError) as exc:
                logger.warning("crowd_telecom_row_invalid", zone_id=zone.zone_id, error_type=type(exc).__name__)
                continue
            seen.add(zone.zone_id)
        return observations

    async def fetch_forecast(self, zones: Sequence[Zone], horizon: timedelta) -> list[CrowdForecast]:
        """예측은 현재값과 같은 전달물에 실려 온다고 가정한다(따로 오면 이 함수만 바꾼다)."""
        return forecasts_within(await self.fetch_current(zones), horizon)
