"""여러 날의 **추정** 집계를 한 번의 DB 읽기로 만든다 — 리포트 화면의 7/30일 추이용.

## 왜 별도 모듈인가

`congestion_estimator_service.estimated_day_aggregate()` 는 **하루**를 위한 경로다. 콜드 1~3초가
드는데, 30일 추이를 그리려고 30번 부르면 30~90초다 — Render 무료 플랜(0.1 CPU)에서는 그
자체로 장애다. 그래서 `apps/web/app/admin/report` 의 30일 차트는 지금까지 "일별 추정 추이는
서버 쪽 일괄 경로가 생긴 뒤에" 라는 주석과 함께 비어 있었다. 이 모듈이 그 일괄 경로다.

산식·가중치·이상 혼잡 기준은 **새로 정하지 않는다.** 전부 추정기(공통 모듈)의 값을 그대로
import 해서 쓴다 — 같은 숫자가 두 화면에서 다른 이야기를 하지 않게 하려면 정의점이 하나여야 한다.

## 무엇이 다른가(하루 경로와 비교)

1. **DB 왕복 1회.** 기간 전체의 스냅샷을 부모-자식 임베드(`area_demand_snapshot_lots(...)`)로
   한 번에 읽는다. 하루 경로처럼 스냅샷 id 를 200개씩 끊어 `in_()` 를 20번 쏘면 30일에
   20왕복이고, 실측 2026-09-20 기준 그쪽이 훨씬 느렸다(임베드 30일 2.5초).

2. **표본을 '시설 × 버킷' 대신 '(격자·업종·관광기준선) 그룹 × 버킷' 으로 센다.**
   추정치는 `0.7·(격자 주차 점유율) + 0.3·(시설 관광 기준선)` 이라, **같은 격자 · 같은 관광
   기준선** 의 시설들은 언제나 같은 값을 받는다. 시설 1,669곳을 매 버킷마다 한 줄씩 도는 대신
   그 그룹(실측 486개)을 돌고 개수를 곱한다. 집계(합·개수·이상 건수)는 **완전히 같은 값**이고,
   테스트가 `estimate_facilities()` 와의 동치를 잠근다.

3. **격자-주차장 거리를 기간 동안 한 번만 잰다.** 주차장 좌표·총면수는 30일 내내 거의 고정이고
   (실측: 서로 다른 기하 6가지), 버킷마다 바뀌는 것은 잔여면뿐이다. 거리·가중치는 기하가 같으면
   같으므로 기하별로 한 번 계산해 재사용한다. 가중식은 `cell_demand_level` 과 같은 식이고,
   테스트가 그 함수와의 동치를 잠근다(식을 두 벌 두는 값을 그 테스트가 치른다 — 대신 30일
   CPU 가 12.9초에서 1.4초가 됐다).

4. **긴 기간은 표본 간격을 넓힌다.** 원본은 10분 버킷이다. 8일 이상을 그릴 때는 30분마다
   한 버킷만 쓴다(하루 48표본). 일평균을 그리는 데 하루 144표본이 필요하지 않고, 무료 플랜의
   CPU 예산은 유한하다. **얼마 간격으로 쟀는지는 basis 에 실어 화면이 말하게 한다** — 숨기면
   그게 지어낸 정밀도가 된다.

## 무엇을 만들지 않는가

인원 수(`current_count`)를 만들지 않는다. 추정치는 0~1 의 **혼잡도 비율**이고 사람 수가 아니다.
'몇 명' 을 합산하는 화면은 추정 모드에서 그 칸을 0 으로 채우지 말고 "추정에는 인원 수가 없다"
고 말해야 한다(리포트 화면이 그렇게 한다).

`congestion_logs` 에 적재하지 않는다 — 이유는 `congestion_estimator_service` 머리말과 같다.
"""

from __future__ import annotations

import asyncio
import time
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

import structlog

from app.core.supabase import fetch_all_rows, supabase_admin
from app.services import congestion_calibration_service as calibration
from app.services.congestion_estimator_service import (
    ANOMALY_LEVEL,
    ESTIMATE_SOURCE,
    PARKING_WEIGHT,
    TOURISM_WEIGHT,
    blend_level,
    facility_tourism_level,
)
from app.services.parking_derived_congestion_service import (
    RADIUS_M,
    SNAPSHOT_SOURCE,
    ParkingLot,
    grid_cell,
    grid_center,
)
from app.services.spot.travel import calculate_haversine_distance
from app.services.tourism_area_prior_service import attach_tourism_area_priors

logger = structlog.get_logger()

_KST = timezone(timedelta(hours=9))

# 한 번에 그릴 수 있는 최대 일수. 30일은 성과 리포트 차트의 고정 기간이고, 그 위로는 이
# 경로의 CPU 예산(아래 실측)을 넘는다.
MAX_DAYS = 30

# 표본 간격(분). 원본 버킷이 10분이라 10 은 '전부 쓴다' 는 뜻이다.
SAMPLE_MINUTES_SHORT = 10
SAMPLE_MINUTES_LONG = 30
# 이 일수까지는 10분 전부를 쓴다. 넘으면 30분 간격.
SHORT_RANGE_DAYS = 7

# 하루를 '집계 가능' 으로 인정하는 최소 버킷 수. 30분치(3버킷)도 안 되는 날의 평균을 하루
# 평균이라고 부르면, 새벽 한 시간만 수집된 날이 온종일의 대푯값이 된다.
MIN_DAY_SNAPSHOTS = 3

# 관리자 리포트용이라 하루 경로(5분/6시간)보다 길게 잡는다. 지난 날의 원본은 더 바뀌지 않으므로
# 하루 단위 결과를 날짜별로 들고 있다가, 새로고침 때는 **오늘 하루만** 다시 계산한다.
DAY_TTL_TODAY_SECONDS = 300.0
DAY_TTL_PAST_SECONDS = 12 * 3600.0
# 30일 × 표본 간격 2종(10분·30분) = 60 항목이 정상 상태다. 그보다 빠듯하게 잡으면 두 리포트
# 화면이 서로의 캐시를 밀어내며 매번 콜드가 된다.
_DAY_CACHE_MAX = 90


@dataclass(frozen=True)
class RangeSnapshot:
    """10분 버킷 하나. 추정기의 ``Snapshot`` 과 같은 내용이지만 lots 가 **정렬된** 순서다.

    정렬이 계약인 이유: 아래 기하 캐시가 주차장을 위치(index)로 가리킨다. 같은 주차장 묶음이
    버킷마다 다른 순서로 오면 기하 키가 갈려 캐시가 무의미해지고, 더 나쁘게는 index 가
    어긋나 다른 주차장의 잔여면으로 가중을 한다.
    """

    bucket_at: datetime
    observed_at: datetime
    lots: tuple[ParkingLot, ...]


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _aware(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def kst_date_str(moment: datetime) -> str:
    return moment.astimezone(_KST).date().isoformat()


def sample_minutes_for(days: int) -> int:
    """기간 길이 → 표본 간격(분). 화면이 근거 문장에 그대로 싣는 값이다."""
    return SAMPLE_MINUTES_SHORT if days <= SHORT_RANGE_DAYS else SAMPLE_MINUTES_LONG


def date_range(end_date_kst: str, days: int) -> list[str]:
    """과거→오늘 순 KST 날짜 목록. ``/admin/metrics/trend`` 의 daily 와 같은 순서·같은 개수다."""
    end = date.fromisoformat(end_date_kst)
    return [(end - timedelta(days=days - 1 - i)).isoformat() for i in range(days)]


# ── 순수 함수: 집계 ──────────────────────────────────────────────────────────


def keep_snapshot(bucket_at: datetime, sample_minutes: int) -> bool:
    """이 버킷을 표본으로 쓰는가. 원본 버킷이 10분 격자라 '분 % 간격 < 10' 이면 간격당 1개다."""
    if sample_minutes <= SAMPLE_MINUTES_SHORT:
        return True
    return bucket_at.astimezone(timezone.utc).minute % sample_minutes < SAMPLE_MINUTES_SHORT


def _geometry_key(lots: Sequence[ParkingLot]) -> tuple:
    """거리·가중치를 바꾸는 값만 담은 키. 잔여면(available_spaces)은 **일부러 뺀다** — 그게
    버킷마다 바뀌는 유일한 값이고, 빼야 기하 캐시가 재사용된다."""
    return tuple((lot.lot_id, lot.latitude, lot.longitude, lot.total_spaces) for lot in lots)


def cell_weights(
    lots: Sequence[ParkingLot], cell: tuple[int, int], *, radius_m: float = RADIUS_M
) -> tuple[tuple[tuple[int, float], ...], float] | None:
    """격자 중심 기준 (주차장 index, 가중치) 목록과 가중치 합. 반경 안이 비면 ``None``.

    식은 `parking_derived_congestion_service.cell_demand_level` 과 **같은 식**이다
    (weight = min(total,500) / (1 + d/500)). 거기를 부르지 않고 여기서 다시 쓰는 이유는
    거리를 기간 내내 한 번만 재기 위해서다 — 그 대가로 두 식이 갈라질 위험이 생기므로
    `tests/services/test_estimated_report_service.py` 가 두 값의 동치를 잠근다.
    """
    center_lat, center_lng = grid_center(cell)
    weights: list[tuple[int, float]] = []
    total = 0.0
    for index, lot in enumerate(lots):
        distance_m = calculate_haversine_distance(center_lat, center_lng, lot.latitude, lot.longitude)
        if distance_m > radius_m:
            continue
        weight = min(lot.total_spaces, 500) / (1.0 + distance_m / 500.0)
        weights.append((index, weight))
        total += weight
    if not weights or total <= 0:
        return None
    return tuple(weights), total


def cell_parking_level(
    occupancies: Sequence[float], weights: tuple[tuple[int, float], ...], weight_total: float
) -> float:
    """가중 점유율. `cell_demand_level()["level"]` 과 같은 값(같은 식 · 같은 반올림)."""
    weighted = 0.0
    for index, weight in weights:
        weighted += occupancies[index] * weight
    return round(_clamp(weighted / weight_total), 4)


def facility_groups(
    facilities: Sequence[dict[str, Any]],
) -> dict[tuple[int, int], list[tuple[str, float | None, int]]]:
    """시설 목록 → {격자: [(업종, 관광기준선, 시설수)]}.

    같은 격자 · 같은 업종 · 같은 관광기준선이면 추정치가 반드시 같으므로 한 줄로 접는다.
    관광기준선은 **반올림하지 않는다** — 접는 것은 '같은 값' 뿐이고, 비슷한 값을 같다고
    치면 그건 집계가 아니라 근사다.
    """
    buckets: dict[tuple[int, int], Counter] = {}
    for facility in facilities:
        try:
            latitude = float(facility["latitude"])
            longitude = float(facility["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        if not str(facility.get("id") or "").strip():
            continue
        cell = grid_cell(latitude, longitude)
        key = (str(facility.get("type") or "unknown"), facility_tourism_level(facility))
        buckets.setdefault(cell, Counter())[key] += 1
    return {
        cell: [(facility_type, tourism, count) for (facility_type, tourism), count in counter.items()]
        for cell, counter in buckets.items()
    }


def aggregate_estimated_days(
    snapshots: Sequence[RangeSnapshot],
    facilities: Sequence[dict[str, Any]],
    forecasts_by_date: Mapping[str, Sequence[dict[str, Any]]],
    dates: Sequence[str],
    *,
    sample_minutes: int = SAMPLE_MINUTES_SHORT,
    calibration_state: calibration.CalibrationState | None = None,
    radius_m: float = RADIUS_M,
) -> dict[str, Any]:
    """기간 스냅샷 → 날짜별 추정 집계 + 근거. **순수 함수**(DB 접근 없음).

    ``dates`` 에 있는 모든 날짜가 결과에 들어간다 — 원본이 없는 날도 빠지지 않고
    ``avgCongestion=None`` 으로 남는다. 빠뜨리면 화면이 '그 날은 한산했다' 로 읽는다.

    ``facilities`` 의 관광 기준선은 여기서 날짜별로 다시 붙인다(입력 목록은 건드리지 않는다).
    """
    state = calibration_state or calibration.IDENTITY
    applied = bool(state.applied)

    kept: dict[str, list[RangeSnapshot]] = {day: [] for day in dates}
    for snapshot in snapshots:
        if not keep_snapshot(snapshot.bucket_at, sample_minutes):
            continue
        day = kst_date_str(snapshot.bucket_at)
        if day in kept:
            kept[day].append(snapshot)

    # 격자는 시설 좌표만으로 정해진다 — 날짜(관광 기준선)와 무관하다. 그래서 기하별 가중치를
    # 날짜 루프 **밖에서** 한 번만 만든다. 30일 실측 기준 서로 다른 기하가 6가지뿐이라,
    # 이 캐시가 거리 계산을 (버킷 3,972 × 격자 180)회에서 (기하 6 × 격자 180)회로 줄인다.
    all_cells = sorted(facility_groups(facilities))
    geometry_cache: dict[tuple, dict[tuple[int, int], tuple[tuple[tuple[int, float], ...], float]]] = {}
    for snapshot in (snapshot for day_snapshots in kept.values() for snapshot in day_snapshots):
        key = _geometry_key(snapshot.lots)
        if key in geometry_cache:
            continue
        geometry_cache[key] = {
            cell: computed
            for cell in all_cells
            if (computed := cell_weights(snapshot.lots, cell, radius_m=radius_m)) is not None
        }
    # 기간 내 어느 버킷에서든 주차장 반경 안에 든 격자. 나머지 격자의 시설은 값 자체가 없으므로
    # 안쪽 루프에서 매번 걸러 내지 말고 여기서 뺀다(실측: 180칸 중 56칸).
    covered_cells = {cell for per_cell in geometry_cache.values() for cell in per_cell}

    daily: list[dict[str, Any]] = []
    covered_facility_total = 0
    lot_count_max = 0
    observed: list[datetime] = []
    snapshot_total = 0

    for day in dates:
        day_snapshots = kept[day]
        snapshot_total += len(day_snapshots)
        sums: dict[str, float] = {}
        counts: Counter = Counter()
        anomalies: Counter = Counter()
        covered_today = 0
        # 원본이 한 버킷도 없는 날은 관광 기준선을 붙일 이유가 없다(그 자체로 1,669곳 × 앵커 비용).
        groups: dict[tuple[int, int], list[tuple[str, float | None, int]]] = {}
        if day_snapshots:
            # 기준선은 **전체 시설**에 붙인다 — 앵커(관광 통계와 이름이 맞은 관광지)가 반경 밖에
            # 있을 수 있고, 그 앵커가 빠지면 반경 안 시설의 기준선이 달라진다.
            copies = [dict(row) for row in facilities]
            attach_tourism_area_priors(copies, list(forecasts_by_date.get(day) or []))
            groups = {
                cell: cell_groups
                for cell, cell_groups in facility_groups(copies).items()
                if cell in covered_cells
            }

        for snapshot in day_snapshots:
            lots = snapshot.lots
            lot_count_max = max(lot_count_max, len(lots))
            observed.append(snapshot.observed_at)
            per_cell = geometry_cache.get(_geometry_key(lots)) or {}
            if not per_cell:
                continue
            occupancies = [lot.occupancy for lot in lots]
            snapshot_covered = 0
            for cell, cell_groups in groups.items():
                weights = per_cell.get(cell)
                if weights is None:
                    continue
                parking = cell_parking_level(occupancies, weights[0], weights[1])
                for facility_type, tourism, count in cell_groups:
                    raw_level = blend_level(parking, tourism)
                    if raw_level is None:
                        continue
                    # apply() 는 곡선이 없으면 None 을 돌려줄 수 있다 — 그때는 원값이 정답이다.
                    level = (state.apply(raw_level) or raw_level) if applied else raw_level
                    sums[facility_type] = sums.get(facility_type, 0.0) + level * count
                    counts[facility_type] += count
                    snapshot_covered += count
                    if level >= ANOMALY_LEVEL:
                        anomalies[facility_type] += count
            covered_today = max(covered_today, snapshot_covered)

        covered_facility_total = max(covered_facility_total, covered_today)
        sample_count = sum(counts.values())
        enough = len(day_snapshots) >= MIN_DAY_SNAPSHOTS and sample_count > 0
        daily.append({
            "date": day,
            "avgCongestion": round(sum(sums.values()) / sample_count, 3) if enough else None,
            "sampleCount": sample_count,
            "snapshotCount": len(day_snapshots),
            "anomalyCount": sum(anomalies.values()) if enough else None,
            "byType": {
                facility_type: {
                    "avgCongestion": round(sums[facility_type] / counts[facility_type], 3),
                    "sampleCount": counts[facility_type],
                    "anomalyCount": anomalies.get(facility_type, 0),
                }
                for facility_type in sorted(counts)
            } if enough else {},
        })

    basis = {
        "method": "parking_its+tourism_concentration",
        "weights": {"parking": PARKING_WEIGHT, "tourism": TOURISM_WEIGHT},
        "radiusM": round(radius_m),
        "samplingMinutes": sample_minutes,
        # 표본 1개가 무엇인지 화면이 말할 수 있게. 실측의 '로그 1행' 과 단위가 다르다.
        "sampleUnit": "facility_bucket",
        "source": ESTIMATE_SOURCE,
        "snapshotCount": snapshot_total,
        "lotCountMax": lot_count_max,
        "facilityCount": len(facilities),
        "estimatedFacilityCount": covered_facility_total,
        "firstObservedAt": min(observed).isoformat() if observed else None,
        "latestObservedAt": max(observed).isoformat() if observed else None,
        "calibration": state.to_dict(),
    }
    return {"daily": daily, "basis": basis}


# ── DB 읽기(쓰기 없음) ───────────────────────────────────────────────────────

# 부모+자식 임베드. 자식을 따로 `in_(snapshot_ids)` 로 긁으면 30일에 20왕복이고, 실측
# 2026-09-20 기준 임베드가 2.5초 vs 배치가 (타임아웃으로) 측정 불가였다.
_SNAPSHOT_SELECT = (
    "id,observed_at,bucket_at,"
    "area_demand_snapshot_lots(source_lot_id,name,latitude,longitude,total_spaces,available_spaces)"
)

_FACILITY_TTL_SECONDS = 600.0
_facility_cache: tuple[float, list[dict[str, Any]]] | None = None


def _load_facilities() -> list[dict[str, Any]]:
    """활성 시설. fetch_all_rows — 단발 select 는 1000행에서 조용히 잘린다(실측 1,669곳)."""
    global _facility_cache
    now = time.monotonic()
    if _facility_cache and now - _facility_cache[0] < _FACILITY_TTL_SECONDS:
        return _facility_cache[1]
    rows = fetch_all_rows(
        supabase_admin,
        "facilities",
        "id,name,type,latitude,longitude,is_active",
        apply_filters=lambda query: query.order("id"),
    )
    active = [row for row in rows if row.get("is_active", True)]
    _facility_cache = (now, active)
    return active


def _load_forecasts(start_date: str, end_date: str) -> dict[str, list[dict[str, Any]]]:
    """기간 전체의 관광 통계를 한 번에 읽어 날짜별로 나눈다(하루 경로는 날짜마다 한 번 읽는다)."""
    rows = fetch_all_rows(
        supabase_admin,
        "tourism_concentration_forecasts",
        "tourist_attraction_name,concentration_rate,forecast_date",
        apply_filters=lambda query: query.gte("forecast_date", start_date)
        .lte("forecast_date", end_date)
        .order("forecast_date"),
    )
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(str(row.get("forecast_date") or ""), []).append(row)
    return grouped


def snapshots_from_embedded_rows(rows: Sequence[dict[str, Any]]) -> list[RangeSnapshot]:
    """임베드 응답 → 정렬된 ``RangeSnapshot`` 목록. 불량 행은 센다기보다 **버린다**.

    (총면수 0 이하·잔여면이 범위 밖인 행을 살리면 점유율이 1 을 넘거나 음수가 된다 —
     하루 경로 `_snapshots_from_rows` 와 같은 판정이다.)
    """
    snapshots: list[RangeSnapshot] = []
    for row in rows:
        bucket_at = _aware(row.get("bucket_at"))
        observed_at = _aware(row.get("observed_at"))
        if bucket_at is None or observed_at is None:
            continue
        lots: list[ParkingLot] = []
        for lot_row in row.get("area_demand_snapshot_lots") or []:
            try:
                total = int(lot_row["total_spaces"])
                available = int(lot_row["available_spaces"])
                lot = ParkingLot(
                    lot_id=str(lot_row["source_lot_id"]),
                    name=str(lot_row.get("name") or ""),
                    latitude=float(lot_row["latitude"]),
                    longitude=float(lot_row["longitude"]),
                    total_spaces=total,
                    available_spaces=available,
                )
            except (KeyError, TypeError, ValueError):
                continue
            if total <= 0 or not 0 <= available <= total:
                continue
            lots.append(lot)
        if not lots:
            continue
        # 기하 캐시가 주차장을 index 로 가리키므로 순서를 여기서 못 박는다(위 dataclass 주석).
        lots.sort(key=lambda lot: (lot.lot_id, lot.latitude, lot.longitude, lot.total_spaces))
        snapshots.append(RangeSnapshot(bucket_at, observed_at, tuple(lots)))
    snapshots.sort(key=lambda snapshot: snapshot.bucket_at)
    return snapshots


def _load_snapshots(start_iso: str, end_iso: str) -> list[RangeSnapshot]:
    rows = fetch_all_rows(
        supabase_admin,
        "area_demand_snapshots",
        _SNAPSHOT_SELECT,
        apply_filters=lambda query: query.eq("source", SNAPSHOT_SOURCE)
        .gte("bucket_at", start_iso)
        .lte("bucket_at", end_iso)
        .order("bucket_at"),
    )
    return snapshots_from_embedded_rows(rows)


def day_bounds_utc(dates: Sequence[str]) -> tuple[str, str]:
    """KST 날짜 목록 → 조회할 UTC 구간(첫날 00:00 ~ 마지막 날 23:59:59.999)."""
    start = datetime.fromisoformat(dates[0]).replace(tzinfo=_KST).astimezone(timezone.utc)
    end = (
        datetime.fromisoformat(dates[-1]).replace(tzinfo=_KST)
        + timedelta(days=1)
        - timedelta(milliseconds=1)
    ).astimezone(timezone.utc)
    return start.isoformat(), end.isoformat()


# ── 공개 API ─────────────────────────────────────────────────────────────────

# 날짜별 결과 캐시. 지난 날의 원본은 더 바뀌지 않으므로, 새로고침은 **오늘 하루만** 다시 계산한다
# (30일 콜드 ≈ 4초 → 웜 ≈ 0.2초). 키에 표본 간격을 넣는 이유: 7일 창(10분)과 30일 창(30분)은
# 같은 날짜라도 다른 표본으로 잰 값이라 섞으면 안 된다.
_day_cache: dict[tuple[str, int], tuple[float, dict[str, Any]]] = {}
_basis_cache: dict[tuple[str, int], dict[str, Any]] = {}
# 계산을 **한 번에 하나씩**. 이 API 는 0.1 CPU 위에 있어서 30일 계산 두 개가 겹치면 둘 다
# 라우터 상한(10초)을 넘긴다. 기다린 쪽은 대개 헛수고가 아니다 — 앞 계산이 채운 날짜 캐시를
# 그대로 쓰므로(7일 창과 30일 창은 같은 30분 표본을 공유한다) 자기 차례에는 즉시 끝난다.
_lock = asyncio.Lock()


def reset_caches() -> None:
    """테스트용."""
    global _facility_cache
    _facility_cache = None
    _day_cache.clear()
    _basis_cache.clear()


def _cached_day(day: str, sample_minutes: int, today_kst: str) -> dict[str, Any] | None:
    entry = _day_cache.get((day, sample_minutes))
    if entry is None:
        return None
    ttl = DAY_TTL_TODAY_SECONDS if day >= today_kst else DAY_TTL_PAST_SECONDS
    return entry[1] if time.monotonic() - entry[0] < ttl else None


def _store_days(rows: Sequence[dict[str, Any]], sample_minutes: int, basis: dict[str, Any]) -> None:
    now = time.monotonic()
    for row in rows:
        _day_cache[(str(row["date"]), sample_minutes)] = (now, row)
        _basis_cache[(str(row["date"]), sample_minutes)] = basis
    for stale in sorted(_day_cache)[:-_DAY_CACHE_MAX]:
        _day_cache.pop(stale, None)
        _basis_cache.pop(stale, None)


def _forecasts_or_empty(start_date: str, end_date: str) -> dict[str, list[dict[str, Any]]]:
    try:
        return _load_forecasts(start_date, end_date)
    except Exception as exc:  # noqa: BLE001 — 통계가 없으면 주차 성분만으로 간다(하루 경로와 같다)
        logger.warning("estimated_report_forecasts_unavailable", error=str(exc))
        return {}


def _calibration_or_identity() -> calibration.CalibrationState:
    try:
        return calibration.active_calibration()
    except Exception as exc:  # noqa: BLE001 — 보정 실패는 항등이지 추정 전체의 실패가 아니다
        logger.warning("estimated_report_calibration_unavailable", error=str(exc))
        return calibration.IDENTITY


def _context_sync(dates: Sequence[str]) -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]], calibration.CalibrationState]:
    """스냅샷을 제외한 나머지 원본(시설·관광 통계·보정)을 **한 스레드에서 차례로** 읽는다."""
    facilities = _load_facilities()
    forecasts = _forecasts_or_empty(dates[0], dates[-1])
    return facilities, forecasts, _calibration_or_identity()


async def _compute(dates: Sequence[str], sample_minutes: int) -> dict[str, Any]:
    """원본 조회를 두 갈래로 나눠 동시에 하고, 집계는 스레드로 오프로드한다.

    직렬로 두면 30일 기준 조회만 4초가 걸린다(스냅샷 2.5 + 시설 0.9 + 통계 0.7, 실측
    2026-09-20). 둘로 갈라 동시에 하면 느린 쪽(스냅샷)만 남는다.

    **넷으로 더 쪼개지 않는 이유:** 같은 supabase 클라이언트를 스레드 네 개가 동시에 두드리면
    로컬(Windows)에서 소켓 오류가 실제로 났다. 2-way 는 이 저장소가 이미 쓰는 폭이고
    (admin.get_dashboard_today · get_metrics_trend 의 gather), 더 쪼개서 버는 1초보다
    추정이 가끔 통째로 사라지지 않는 쪽이 낫다.

    스냅샷 조회 실패는 올린다 — 주차 원본이 없으면 추정 자체가 없다(라우터가 강등한다).
    """
    start_iso, end_iso = day_bounds_utc(dates)
    snapshots, context = await asyncio.gather(
        asyncio.to_thread(_load_snapshots, start_iso, end_iso),
        asyncio.to_thread(_context_sync, dates),
    )
    facilities, forecasts, state = context
    return await asyncio.to_thread(
        aggregate_estimated_days,
        snapshots, facilities, forecasts, dates,
        sample_minutes=sample_minutes, calibration_state=state,
    )


async def estimated_daily_series(days: int, *, now: datetime | None = None) -> dict[str, Any]:
    """최근 ``days``일(KST, 오늘 포함)의 일별 추정 집계.

    반환: { days, startDateKst, endDateKst, samplingMinutes, daily[], basis, elapsedMs }
    ``daily`` 는 과거→오늘 순이고 요청한 날짜가 전부 들어간다(원본 없는 날은 avgCongestion=None).

    실패는 올린다 — 호출부(라우터)가 시간 초과·예외를 `available=false` 로 강등한다.
    """
    days = max(1, min(int(days), MAX_DAYS))
    moment = now or datetime.now(timezone.utc)
    today_kst = kst_date_str(moment)
    dates = date_range(today_kst, days)
    sample_minutes = sample_minutes_for(days)

    async with _lock:
        started = time.monotonic()
        cached = {day: _cached_day(day, sample_minutes, today_kst) for day in dates}
        missing = [day for day in dates if cached[day] is None]
        basis: dict[str, Any] | None = None
        if missing:
            # 빠진 날만 다시 읽는다. 보통은 '오늘' 하나뿐이라 새로고침이 콜드의 1/30 로 끝난다.
            window = date_range(missing[-1], (date.fromisoformat(missing[-1]) - date.fromisoformat(missing[0])).days + 1)
            computed = await _compute(window, sample_minutes)
            basis = computed["basis"]
            _store_days(computed["daily"], sample_minutes, basis)
            by_date = {str(row["date"]): row for row in computed["daily"]}
            for day in dates:
                if cached[day] is None:
                    cached[day] = by_date.get(day)
        if basis is None:
            # 전부 캐시에서 나왔다 — 그 날들을 계산할 때 쓴 근거를 그대로 쓴다(가장 최근 것).
            basis = _basis_cache.get((dates[-1], sample_minutes)) or _basis_cache.get((dates[0], sample_minutes))
        daily = [
            cached[day] or {
                "date": day, "avgCongestion": None, "sampleCount": 0,
                "snapshotCount": 0, "anomalyCount": None, "byType": {},
            }
            for day in dates
        ]
        return {
            "days": days,
            "startDateKst": dates[0],
            "endDateKst": dates[-1],
            "samplingMinutes": sample_minutes,
            "daily": daily,
            "basis": basis,
            "elapsedMs": round((time.monotonic() - started) * 1000),
        }
