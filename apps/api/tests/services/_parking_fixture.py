"""주차 이력 행렬(P2a) 시험의 공용 합성 자료 — 56일 × 144버킷 × 경주 ITS 실 주차장 4곳.

결정적이다(고정 시드). 운영에서 실제로 본 모양과 경계 사례를 일부러 넣었다(스펙 §8):
  · observed_at = bucket_at + U(7초, 898초), µs 까지 무작위 — 관측 시각 순서가 버킷 순서와 어긋나는 행이 생긴다.
  · 처음 4일은 15분 단위 옛 행(관측 오프셋 최대 14분 — 예: 버킷 12:45, 관측 12:58:41).
  · 버킷 2% 누락, 주차장 칸 15% 누락. KST 자정 경계(UTC 14:50·15:00·15:10) 버킷은 빠뜨리지 않는다.
  · 무효 칸: available > total, total = 0, available 음수, 키 없음, 숫자 아님.
  · 30일째부터 주차장 하나(:92)의 좌표가 바뀐다(새 열).
  · ``bucket_at < since ≤ observed_at`` 인 행 하나 — NOW_EDGE 의 56일 경계가 그 행을 가른다. RPC(observed_at 기준)는
    넣고, bucket_at 기준으로 자르는 구현은 빠뜨린다.

행은 PostgREST 가 부모 스냅샷에 주차장 행을 끼워 돌려주는 모양(``area_demand_snapshot_lots``)이고, 같은 자료를
aggregate_nearby_points 가 받는 (parents, lots) 모양으로도 준다. 돌려받은 자료를 고치지 말 것(lru_cache 로 공유한다).
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from functools import lru_cache
from typing import Any

UTC = timezone.utc

# (source_lot_id, 위도, 경도, 총면수) — 운영 area_demand_snapshot_lots 의 실제 값(읽기 전용 조회로 확인, 좌표·면수 불변).
LOTS: tuple[tuple[str, float, float, int], ...] = (
    ("gyeongju-its:87", 35.84031213, 129.21243696, 95),
    ("gyeongju-its:89", 35.8454256, 129.2156901, 221),
    ("gyeongju-its:92", 35.8372886, 129.2100733, 17),
    ("gyeongju-its:93", 35.798201, 129.140779, 564),
)
MOVED_LOT_ID = "gyeongju-its:92"
MOVED_LOT_COORDS = (35.8376886, 129.2104733)  # 30일째부터
START = datetime(2026, 8, 3, 0, 0, tzinfo=UTC)
DAYS = 56
LEGACY_DAYS = 4
MOVE_DAY = 30
EARTH_M = 6371000.0

# 경계 행: 옛 15분 행(06:00 버킷). since = 버킷 + 5분, 관측 = 버킷 + 12분 → bucket_at < since ≤ observed_at.
EDGE_BUCKET = START + timedelta(hours=6)
EDGE_OBSERVED = EDGE_BUCKET + timedelta(minutes=12, seconds=3, microseconds=417_211)
EDGE_SINCE = EDGE_BUCKET + timedelta(minutes=5)
NOW_EDGE = EDGE_SINCE + timedelta(days=DAYS)


@dataclass(frozen=True)
class ParkingFixture:
    rows: tuple[dict[str, Any], ...]  # PostgREST 모양, bucket_at 오름차순(적재 쿼리의 order=bucket_at.asc)
    parents: tuple[dict[str, Any], ...]  # aggregate_nearby_points 모양
    lots: tuple[dict[str, Any], ...]
    edge_row: dict[str, Any]  # bucket_at < EDGE_SINCE ≤ observed_at 인 행


def _iso(value: datetime) -> str:
    # PostgREST 의 timestamptz 표기와 같다: µs 가 0 이면 소수부 없이, 아니면 6자리, 끝은 '+00:00'.
    return value.isoformat()


def _invalid_lot(rng: random.Random, lot_id: str, lat: float, lng: float, total: int) -> dict[str, Any]:
    kind = rng.randrange(5)
    lot: dict[str, Any] = {"source_lot_id": lot_id, "latitude": lat, "longitude": lng}
    if kind == 0:
        lot.update(total_spaces=total, available_spaces=total + 1)  # available > total
    elif kind == 1:
        lot.update(total_spaces=0, available_spaces=0)  # total = 0
    elif kind == 2:
        lot.update(total_spaces=total, available_spaces=-1)  # 음수
    elif kind == 3:
        lot.update(total_spaces=total)  # available_spaces 키 없음
    else:
        lot.update(total_spaces="n/a", available_spaces=3)  # 숫자 아님
    return lot


@lru_cache(maxsize=1)
def fixture_56d() -> ParkingFixture:
    rng = random.Random(20260928)
    rows: list[dict[str, Any]] = []
    used_observed: set[datetime] = set()
    legacy_end = START + timedelta(days=LEGACY_DAYS)
    end = START + timedelta(days=DAYS)
    move_at = START + timedelta(days=MOVE_DAY)
    bucket = START
    edge_row: dict[str, Any] | None = None
    while bucket < end:
        legacy = bucket < legacy_end
        step = timedelta(minutes=15 if legacy else 10)
        kst_midnight_edge = (bucket.hour, bucket.minute) in {(14, 50), (15, 0), (15, 10)}
        if bucket == EDGE_BUCKET:
            observed = EDGE_OBSERVED
        elif not kst_midnight_edge and rng.random() < 0.02:
            bucket += step
            continue
        else:
            max_offset_s = 14 * 60 if legacy else 898
            observed = bucket + timedelta(
                seconds=rng.randint(7, max_offset_s - 1), microseconds=rng.randrange(1_000_000)
            )
        while observed in used_observed:  # µs 까지 같은 두 관측은 만들지 않는다(스펙 R8)
            observed += timedelta(microseconds=1)
        used_observed.add(observed)
        lots: list[dict[str, Any]] = []
        for lot_id, lat, lng, total in LOTS:
            if lot_id == MOVED_LOT_ID and bucket >= move_at:
                lat, lng = MOVED_LOT_COORDS
            if bucket != EDGE_BUCKET and rng.random() < 0.15:
                continue
            if bucket != EDGE_BUCKET and rng.random() < 0.01:
                lots.append(_invalid_lot(rng, lot_id, lat, lng, total))
                continue
            lots.append({
                "source_lot_id": lot_id,
                "latitude": lat,
                "longitude": lng,
                "total_spaces": total,
                "available_spaces": rng.randint(0, total),
            })
        row = {"bucket_at": _iso(bucket), "observed_at": _iso(observed), "area_demand_snapshot_lots": lots}
        rows.append(row)
        if bucket == EDGE_BUCKET:
            edge_row = row
        bucket += step
    assert edge_row is not None

    parents: list[dict[str, Any]] = []
    flat_lots: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        snapshot_id = f"s{index}"
        parents.append({"id": snapshot_id, "observed_at": row["observed_at"], "bucket_at": row["bucket_at"]})
        for lot in row["area_demand_snapshot_lots"]:
            flat_lots.append({"snapshot_id": snapshot_id, **lot})
    return ParkingFixture(tuple(rows), tuple(parents), tuple(flat_lots), edge_row)


def haversine_raw_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """반올림 전 거리 — calculate_haversine_distance · 마이그레이션 20260904120000 과 같은 식·같은 순서."""
    r_lat1, r_lng1, r_lat2, r_lng2 = map(math.radians, [lat1, lng1, lat2, lng2])
    a = (
        math.sin((r_lat2 - r_lat1) / 2) ** 2
        + math.cos(r_lat1) * math.cos(r_lat2) * math.sin((r_lng2 - r_lng1) / 2) ** 2
    )
    return EARTH_M * (2 * math.asin(min(1.0, math.sqrt(a))))


def pg_round_distance(meters: float) -> float:
    """Postgres 의 ``round(x::NUMERIC, 1)`` — float8→numeric 은 유효숫자 15자리(DBL_DIG)로 바꾼 뒤 사사오입."""
    return float(Decimal("%.15g" % meters).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))


def _sql_distance_pg(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """마이그레이션의 거리식을 Postgres 의 반올림까지 흉내 낸 대조본(기존 _sql_distance_m 은 최단 repr 기준)."""
    return pg_round_distance(haversine_raw_m(lat1, lng1, lat2, lng2))
