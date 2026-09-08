"""공영주차 실측에서 시설별 혼잡 **추정치**를 만든다. 실측 혼잡이 아니다.

## 왜 있는가

`congestion_logs` 에는 두 달 동안 실제 현장 관측이 사실상 한 건뿐이다(실측 2026-09-08:
7/02~7/09 시드 덩어리 + 8/21 낱개 1건). 그래서 관제 대시보드·히트맵·통계가 통째로 비어
있다. 반면 경주 ITS 공영주차 실측은 살아 있다 — `area_demand_snapshots` 에 10분마다
정상 수집된다(같은 날 기준 2,302행, 최신 행이 방금 것).

시연 마감까지 시설 단위 실시간 데이터를 구할 방법이 없으므로, **살아 있는 주차 실측에서
구역 혼잡을 계산해 시설별 추정치를 만든다.** 그리고 그것이 추정임을 숨기지 않는다.

## 이 값이 무엇이고 무엇이 아닌가

이 값은 **시설 주변 공영주차의 가중 점유율**이다. 가게 안이 얼마나 붐비는지가 아니다.
`docs/CONGESTION_DATA.md` §2-3 이 금지하는 것("주변 주차·거리 유동을 매장 내부 혼잡으로
표현하지 않는다")을 피하는 방법은 두 가지뿐이다 — 넣지 않거나, **넣되 파생임을 값과 함께
운반하는 것**이다. 여기는 후자를 택하고 그 표식을 세 겹으로 건다:

  1. `source='parking_derived'` — 기존 값에 섞지 않는다. 나중에 이 행들만 골라낼 수 있다.
  2. `evidence_tier='synthetic'` — 학습 정답에서 빠지고(`scripts/train.py` 는
     {verified, corroborated} 만 쓴다), 추천·지도의 '지금 혼잡' 후보에서도 빠진다
     (`latest_congestion_for_facilities` 와 `_fetch_latest_one` 둘 다 tier 허용목록이
     {single_report, corroborated, verified} 다). 즉 SPOT 점수에 닿지 않는다.
  3. 화면 라벨 — 관리자 대시보드가 이 source 를 '주차 실측 기반 추정' 으로 표시한다.

## 산식

점유율 → 혼잡도 **변환을 하지 않는다.** 격자 혼잡도 = 그 격자 주변 주차 점유율 그대로다.
어떤 단조 변환을 얹어도 그것을 보정할 근거가 지금 하나도 없다(시설 단위 실관측이 1건이다).
근거 없는 곡선을 얹는 순간 '추정' 이 '조작' 이 된다 — 변환하지 않는 것이 유일하게 정직한
선택이고, 그래서 이 값은 "주변 주차가 이만큼 찼다" 이상을 주장하지 않는다.

가중 방식은 **새로 만들지 않고** 저장소에 이미 두 곳(`parking_demand_service._nearby_totals`,
`area_demand_forecast_service.aggregate_nearby_points`)에 있는 것과 같은 식을 쓴다:

    occupancy = 1 - available / total
    weight    = min(total, 500) / (1 + distance_m / 500)
    level     = Σ(occupancy × weight) / Σ(weight)

같은 물리량("이 지점 주변 공영주차가 얼마나 찼는가")을 묻는데 식을 새로 만들면 화면에
`parking_evidence`(실시간 주변 수요)와 이 추정치가 **서로 다른 숫자**로 나란히 뜬다.
"""

from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog

from app.core.supabase import fetch_all_rows, supabase_admin
from app.services.spot.travel import calculate_haversine_distance

logger = structlog.get_logger()

# congestion_logs 에 쓰는 값. 둘 다 바꾸지 말 것 — 위 모듈 독스트링의 3중 표식이다.
SOURCE = "parking_derived"
EVIDENCE_TIER = "synthetic"

# 원본 관측의 source(area_demand_snapshots.source). 전국 API 는 경주 커버리지가 없어
# 실제로 수집되는 것은 경주시 ITS 뿐이다.
SNAPSHOT_SOURCE = "gyeongju_its"

# 주차장 영향 반경. 2km 는 **이 파일이 정한 값이 아니라** 저장소가 이미 '주변' 의 경계로
# 쓰고 있는 값이다(parking_demand_service._RADIUS_M, area_demand_forecast_service._RADIUS_M).
# 여기서 다른 반경을 쓰면 같은 화면에 '주변' 정의가 두 개 생긴다.
#
# ⚠️ 반경 밖 시설에는 **아무 값도 만들지 않는다.** 넓히면 커버리지는 오르지만(실측:
# 2km 806곳 → 5km 1,614곳) 그 늘어난 몫은 "가장 가까운 주차장이 4km 밖" 인 시설들이다.
# 그런 곳의 주차 점유율은 그 시설과 아무 관계가 없다 — 값이 없는 곳에 값을 만드는 순간
# 이 파이프라인이 하려던 것과 정반대가 된다.
RADIUS_M = 2_000.0

# 좌표 격자 한 칸의 크기(도). 0.005° ≈ 위도 555m · 경도 450m(북위 35.8°).
#
# 왜 이 크기인가: 위 가중식의 거리 커널이 `1/(1+d/500)` 이라 **500m 보다 잘게 나눠도
# 값이 의미 있게 갈리지 않는다.** 더 잘게 자르면 화면상 해상도만 올라가고 원 데이터에는
# 없는 정밀도를 주장하게 된다. 지금 실시간 잔여면을 주는 주차장은 4곳뿐이라 더더욱 그렇다.
# 반대로 더 키우면 한 칸 안에서 실제로 다른 구역(황리단길 vs 외곽)이 한 값으로 뭉개진다.
GRID_DEGREES = 0.005

# 원본 관측이 이보다 오래됐으면 추정치를 만들지 않는다.
#
# 수집기는 10분마다 돈다(Supabase Cron 매시 3,13,…,53분). 1시간이 비었다는 것은 수집이
# 여섯 번 연속 실패했다는 뜻이고, 그 상태에서 추정치를 찍으면 **한 시간 전 주차 상황을
# 지금의 구역 혼잡으로 파는** 것이 된다. 그건 이 파이프라인이 피하려는 바로 그 실패다.
MAX_SNAPSHOT_AGE = timedelta(minutes=60)

# congestion_logs INSERT 배치 크기. 근거는 infrastructures._SIMULATE_INSERT_CHUNK 와 동일
# (행 하나가 JSON 약 150B → 500행 ≈ 75KB 로 흔한 본문 상한에 한참 못 미친다).
INSERT_CHUNK = 500


class ParkingDerivedError(RuntimeError):
    """추정치를 만들 수 없다. 코드만 전달하고 원문/키는 노출하지 않는다."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class ParkingLot:
    """실시간 잔여면이 있는 주차장 한 곳(스냅샷 시점 원본)."""

    lot_id: str
    name: str
    latitude: float
    longitude: float
    total_spaces: int
    available_spaces: int

    @property
    def occupancy(self) -> float:
        return 1.0 - self.available_spaces / self.total_spaces


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def grid_cell(latitude: float, longitude: float) -> tuple[int, int]:
    """좌표를 격자 칸 인덱스로 내린다. 같은 칸의 시설은 같은 추정치를 받는다."""
    return (
        math.floor(latitude / GRID_DEGREES),
        math.floor(longitude / GRID_DEGREES),
    )


def grid_center(cell: tuple[int, int]) -> tuple[float, float]:
    """격자 칸의 중심 좌표. **측정 지점은 시설이 아니라 이 중심이다.**

    시설마다 거리를 다시 재지 않는 이유: 그러면 격자가 장식이 되고, 값이 시설 좌표만큼
    잘게 갈려 원 데이터(주차장 4곳)에 없는 해상도를 주장하게 된다. 중심으로 재면 한 칸
    안의 시설은 반드시 같은 값을 받는다 — "이 구역이 이만큼 찼다" 라는 주장 그대로다.
    양자화 오차는 칸 반대각선의 절반(≈360m)이 상한이고, 반경 2km·가중 스케일 500m 에
    비하면 작다.
    """
    return ((cell[0] + 0.5) * GRID_DEGREES, (cell[1] + 0.5) * GRID_DEGREES)


def cell_demand_level(
    lots: list[ParkingLot], latitude: float, longitude: float, *, radius_m: float = RADIUS_M
) -> dict[str, Any] | None:
    """한 지점의 주변 주차 점유율. 반경 안에 주차장이 없으면 ``None``(값을 만들지 않는다).

    식은 모듈 독스트링 참조 — parking_demand_service._nearby_totals 와 같은 식이다.
    """
    weighted = 0.0
    weight_total = 0.0
    count = 0
    nearest_m: float | None = None
    total_spaces = 0
    available_spaces = 0
    for lot in lots:
        distance_m = calculate_haversine_distance(latitude, longitude, lot.latitude, lot.longitude)
        if distance_m > radius_m:
            continue
        weight = min(lot.total_spaces, 500) / (1.0 + distance_m / 500.0)
        weighted += lot.occupancy * weight
        weight_total += weight
        count += 1
        total_spaces += lot.total_spaces
        available_spaces += lot.available_spaces
        if nearest_m is None or distance_m < nearest_m:
            nearest_m = distance_m
    if not count or weight_total <= 0:
        return None
    return {
        "level": round(_clamp(weighted / weight_total), 4),
        "lot_count": count,
        "nearest_lot_m": round(nearest_m) if nearest_m is not None else None,
        "total_spaces": total_spaces,
        "available_spaces": available_spaces,
    }


def build_grid_estimates(
    lots: list[ParkingLot],
    facilities: list[dict[str, Any]],
    *,
    radius_m: float = RADIUS_M,
) -> dict[str, Any]:
    """격자별 혼잡도를 만들고 시설을 격자에 매핑한다. 순수 함수(DB 접근 없음).

    반환의 ``estimates`` 에는 **반경 안에 주차장이 있는 시설만** 들어간다. 나머지는
    ``skipped_no_parking`` 으로 세기만 하고 값을 만들지 않는다.
    """
    cells: dict[tuple[int, int], dict[str, Any] | None] = {}
    estimates: list[dict[str, Any]] = []
    skipped_no_parking = 0
    skipped_no_coordinates = 0

    for facility in facilities:
        facility_id = str(facility.get("id") or "").strip()
        try:
            latitude = float(facility["latitude"])
            longitude = float(facility["longitude"])
        except (KeyError, TypeError, ValueError):
            skipped_no_coordinates += 1
            continue
        if not facility_id:
            skipped_no_coordinates += 1
            continue
        cell = grid_cell(latitude, longitude)
        if cell not in cells:
            center_lat, center_lng = grid_center(cell)
            cells[cell] = cell_demand_level(lots, center_lat, center_lng, radius_m=radius_m)
        demand = cells[cell]
        if demand is None:
            skipped_no_parking += 1
            continue
        estimates.append({
            "facility_id": facility_id,
            "level": demand["level"],
            "grid_cell": f"{cell[0]}:{cell[1]}",
            "lot_count": demand["lot_count"],
            "nearest_lot_m": demand["nearest_lot_m"],
        })

    covered_cells = {cell: demand for cell, demand in cells.items() if demand is not None}
    levels = sorted(demand["level"] for demand in covered_cells.values())
    return {
        "estimates": estimates,
        "grid_degrees": GRID_DEGREES,
        "radius_m": round(radius_m),
        "grid_cells_total": len(cells),
        "grid_cells_covered": len(covered_cells),
        "skipped_no_parking": skipped_no_parking,
        "skipped_no_coordinates": skipped_no_coordinates,
        # 값의 폭을 함께 낸다 — 전부 같은 숫자면 그건 '구역별 혼잡' 이 아니라 상수 하나다.
        "level_min": levels[0] if levels else None,
        "level_max": levels[-1] if levels else None,
    }


def _parse_observed_at(value: Any) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise ParkingDerivedError("snapshot_timestamp_unparsable") from exc
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def _load_latest_snapshot() -> dict[str, Any]:
    """가장 최근 주차 스냅샷 1건과 그 시점 주차장 원본을 읽는다(읽기 전용)."""
    response = (
        supabase_admin.table("area_demand_snapshots")
        .select("id,source,observed_at,bucket_at,live_lot_count")
        .eq("source", SNAPSHOT_SOURCE)
        .order("observed_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = response.data or []
    if not rows:
        raise ParkingDerivedError("no_parking_snapshot")
    snapshot = rows[0]
    # 주차장 수는 4곳 안팎이라 한 페이지로 끝나지만, 행수 가정을 코드에 박지 않는다.
    lot_rows = fetch_all_rows(
        supabase_admin,
        "area_demand_snapshot_lots",
        "source_lot_id,name,latitude,longitude,total_spaces,available_spaces",
        apply_filters=lambda query: query.eq("snapshot_id", snapshot["id"]),
    )
    lots: list[ParkingLot] = []
    for row in lot_rows:
        try:
            total = int(row["total_spaces"])
            available = int(row["available_spaces"])
            lot = ParkingLot(
                lot_id=str(row["source_lot_id"]),
                name=str(row["name"]),
                latitude=float(row["latitude"]),
                longitude=float(row["longitude"]),
                total_spaces=total,
                available_spaces=available,
            )
        except (KeyError, TypeError, ValueError):
            # 원본 한 줄이 깨졌다고 전체를 버리지 않는다. DB CHECK 가 이미 막고 있어
            # 정상 경로에서는 일어나지 않는다.
            logger.warning("parking_derived_lot_row_invalid", snapshot_id=str(snapshot["id"]))
            continue
        if total <= 0 or not 0 <= available <= total:
            continue
        lots.append(lot)
    if not lots:
        raise ParkingDerivedError("no_parking_lots")
    return {"snapshot": snapshot, "lots": lots}


def _load_active_facilities() -> list[dict[str, Any]]:
    """활성 시설 전량.

    **fetch_all_rows 여야 한다.** 단발 select 는 PostgREST 캡(1000)에 걸려 조용히 잘리는데
    오류가 아니라 200 이다 — 실측 1,653곳 중 653곳이 이유 없이 추정에서 빠진다.
    """
    rows = fetch_all_rows(
        supabase_admin,
        "facilities",
        "id,latitude,longitude,is_active",
        apply_filters=lambda query: query.order("id"),
    )
    return [row for row in rows if row.get("is_active", True)]


def _snapshot_age(observed_at: datetime, now: datetime) -> timedelta:
    return now.astimezone(timezone.utc) - observed_at.astimezone(timezone.utc)


def _summarize(
    snapshot: dict[str, Any],
    lots: list[ParkingLot],
    built: dict[str, Any],
    *,
    age: timedelta,
) -> dict[str, Any]:
    return {
        "source": SOURCE,
        "evidence_tier": EVIDENCE_TIER,
        # 이 응답을 읽는 사람이 값의 성격을 오해할 여지를 남기지 않는다.
        "is_estimate": True,
        "derived_from": {
            "table": "area_demand_snapshots",
            "source": SNAPSHOT_SOURCE,
            "snapshot_id": str(snapshot["id"]),
            "observed_at": str(snapshot["observed_at"]),
            "bucket_at": str(snapshot["bucket_at"]),
            "age_seconds": round(age.total_seconds()),
            "lot_count": len(lots),
        },
        "radius_m": built["radius_m"],
        "grid_degrees": built["grid_degrees"],
        "grid_cells_total": built["grid_cells_total"],
        "grid_cells_covered": built["grid_cells_covered"],
        "estimated_facilities": len(built["estimates"]),
        "skipped_no_parking": built["skipped_no_parking"],
        "skipped_no_coordinates": built["skipped_no_coordinates"],
        "level_min": built["level_min"],
        "level_max": built["level_max"],
    }


async def preview_parking_derived_estimates(
    *, now: datetime | None = None
) -> dict[str, Any]:
    """무엇이 적재될지 계산만 한다. **쓰기 없음.**"""
    now = now or datetime.now(timezone.utc)
    loaded = await asyncio.to_thread(_load_latest_snapshot)
    snapshot, lots = loaded["snapshot"], loaded["lots"]
    observed_at = _parse_observed_at(snapshot["observed_at"])
    age = _snapshot_age(observed_at, now)
    facilities = await asyncio.to_thread(_load_active_facilities)
    built = await asyncio.to_thread(build_grid_estimates, lots, facilities)
    summary = _summarize(snapshot, lots, built, age=age)
    # 미리보기는 오래된 스냅샷도 **거절하지 않고 그대로 보여 준다** — 관리자가 지금
    # 수집이 죽어 있다는 사실을 확인하는 것이 이 화면의 용도이기 때문이다. 적재만 막는다.
    summary["stale"] = age > MAX_SNAPSHOT_AGE
    summary["facility_count"] = len(facilities)
    return summary


def _is_missing_source_migration(exc: BaseException) -> bool:
    """`20260908120000_parking_derived_congestion_source.sql` 이 아직 적용되지 않았는가.

    마이그레이션은 사람이 Supabase SQL Editor 에 붙여넣는다 — 백엔드 배포가 먼저 나가는
    순서가 실제로 가능하다(area_demand_forecast_service._is_missing_points_rpc 와 같은
    상황). 그때 이 엔드포인트가 500 을 내면 관리자는 '서버가 고장났다' 로 읽는다.
    실제로는 **할 일이 하나 남아 있다** 는 뜻이라, 그 두 가지를 구분해서 알린다.

    걸리는 오류는 두 가지다:
      · 23514 congestion_logs_source_check — 새 source 값이 아직 허용되지 않음
      · 23502 current_count NOT NULL      — 아직 NULL 을 못 넣음
    """
    code = str(getattr(exc, "code", "") or "")
    message = str(getattr(exc, "message", None) or exc).lower()
    if code == "23514" or "congestion_logs_source_check" in message:
        return True
    return (code == "23502" or "not-null" in message or "not null" in message) and (
        "current_count" in message
    )


def _existing_rows_at(timestamp_iso: str) -> int:
    """같은 시각에 이미 들어간 parking_derived 행 수(중복 적재 방지)."""
    response = (
        supabase_admin.table("congestion_logs")
        .select("id", count="exact")
        .eq("source", SOURCE)
        .eq("timestamp", timestamp_iso)
        .limit(1)
        .execute()
    )
    count = getattr(response, "count", None)
    if count is not None:
        return int(count)
    return len(response.data or [])


def _insert_estimates(rows: list[dict[str, Any]]) -> int:
    inserted = 0
    for offset in range(0, len(rows), INSERT_CHUNK):
        chunk = rows[offset:offset + INSERT_CHUNK]
        response = supabase_admin.table("congestion_logs").insert(chunk).execute()
        inserted += len(response.data or [])
    return inserted


async def record_parking_derived_estimates(
    *, now: datetime | None = None
) -> dict[str, Any]:
    """최신 주차 실측에서 시설별 추정치를 계산해 ``congestion_logs`` 에 적재한다.

    수동 트리거 전용이다. 자동 주기 실행으로 만들지 않은 이유는 docs/CONGESTION_DATA.md §10
    에 적었다 — 요약하면 10분마다 추정치가 쌓이기 시작하면 되돌리기 어렵고, 그 순간
    이 표의 다수가 추정치가 되기 때문이다.
    """
    now = now or datetime.now(timezone.utc)
    loaded = await asyncio.to_thread(_load_latest_snapshot)
    snapshot, lots = loaded["snapshot"], loaded["lots"]
    observed_at = _parse_observed_at(snapshot["observed_at"])
    age = _snapshot_age(observed_at, now)
    if age > MAX_SNAPSHOT_AGE:
        raise ParkingDerivedError("parking_snapshot_stale")
    if age < -timedelta(minutes=5):
        # 스냅샷이 미래다 — 시계가 어긋났거나 원본이 오염됐다. 둘 다 값을 만들 상황이 아니다.
        raise ParkingDerivedError("parking_snapshot_in_future")

    # 로그 timestamp 는 관측 시각이 아니라 **버킷 시각**이다.
    #
    # 왜: (1) 원본이 이미 10분 버킷이라 추정치가 원본보다 정밀한 시각을 주장할 수 없고,
    #     (2) '같은 시각' 이 정확히 정의되어 버튼을 두 번 눌러도 두 배로 쌓이지 않는다.
    # 실제 observed_at 은 사라지지 않는다 — area_demand_snapshots 가 같은 버킷에 그대로
    # 들고 있으므로 bucket_at 으로 되짚을 수 있다.
    timestamp_iso = str(snapshot["bucket_at"])

    facilities = await asyncio.to_thread(_load_active_facilities)
    built = await asyncio.to_thread(build_grid_estimates, lots, facilities)
    summary = _summarize(snapshot, lots, built, age=age)
    summary["timestamp"] = timestamp_iso
    summary["facility_count"] = len(facilities)

    if not built["estimates"]:
        # 반경 안에 시설이 하나도 없다. 실패가 아니라 '만들 값이 없음' 이다.
        return {**summary, "status": "no_estimates", "inserted": 0}

    try:
        existing = await asyncio.to_thread(_existing_rows_at, timestamp_iso)
    except Exception as exc:
        logger.warning("parking_derived_duplicate_check_failed", error=str(exc))
        # 중복 확인에 실패했으면 **적재하지 않는다.** 확인 없이 넣으면 두 배로 쌓인 뒤에야
        # 알게 되고, 그때는 어느 쪽이 두 번째인지 구분할 수 없다.
        raise ParkingDerivedError("duplicate_check_failed") from exc
    if existing:
        return {**summary, "status": "already_recorded", "inserted": 0}

    rows = [
        {
            "facility_id": estimate["facility_id"],
            "congestion_level": estimate["level"],
            # 인원수는 **모른다.** simulate-peak 처럼 capacity×level 로 채우면 관측한 적
            # 없는 인원수를 지어내는 것이다(마이그레이션이 이 컬럼의 NOT NULL 을 푼다).
            "current_count": None,
            "source": SOURCE,
            "evidence_tier": EVIDENCE_TIER,
            "timestamp": timestamp_iso,
        }
        for estimate in built["estimates"]
    ]
    try:
        inserted = await asyncio.to_thread(_insert_estimates, rows)
    except Exception as exc:
        if _is_missing_source_migration(exc):
            raise ParkingDerivedError("migration_not_applied") from exc
        raise
    logger.info(
        "parking_derived_estimates_recorded",
        inserted=inserted,
        snapshot_id=str(snapshot["id"]),
        timestamp=timestamp_iso,
        skipped_no_parking=built["skipped_no_parking"],
    )
    return {**summary, "status": "recorded", "inserted": inserted}
