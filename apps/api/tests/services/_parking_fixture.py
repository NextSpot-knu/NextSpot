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

FakeParkingDB 는 적재 루프(app/services/parking_history.py)가 읽는 area_demand_snapshots 를 흉내 낸 PostgREST 대역이다.
"""

from __future__ import annotations

import copy
import math
import random
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from functools import lru_cache
from types import SimpleNamespace
from typing import Any, Callable

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


def db_row(bucket: datetime, observed: datetime, lots) -> dict[str, Any]:
    """PostgREST 모양 행 하나 — lots 는 [(source_lot_id, 위도, 경도, total, available)]."""
    return {
        "bucket_at": _iso(bucket),
        "observed_at": _iso(observed),
        "area_demand_snapshot_lots": [
            {"source_lot_id": lot_id, "latitude": lat, "longitude": lng,
             "total_spaces": total, "available_spaces": available}
            for lot_id, lat, lng, total, available in lots
        ],
    }


def _ts(value: Any) -> datetime:
    return datetime.fromisoformat(str(value))


@dataclass
class FakeRequest:
    """execute() 한 번의 기록 — 적재 루프가 만든 쿼리 모양을 시험이 대조한다."""

    select: str
    count: Any
    filters: list[tuple[str, str, Any]]
    orders: list[tuple[str, bool]]
    limit: int | None
    thread: str
    rows: int = 0

    def filter(self, op: str, column: str) -> Any:
        for f_op, f_column, value in self.filters:
            if f_op == op and f_column == column:
                return value
        return None


class _FakeQuery:
    def __init__(self, db: "FakeParkingDB") -> None:
        self.db = db
        self.columns = "*"
        self.count = None
        self.filters: list[tuple[str, str, Any]] = []
        self.orders: list[tuple[str, bool]] = []
        self.lim: int | None = None

    def select(self, columns="*", count=None):
        self.columns, self.count = columns, count
        return self

    def eq(self, column, value):
        self.filters.append(("eq", column, value))
        return self

    def gte(self, column, value):
        self.filters.append(("gte", column, value))
        return self

    def gt(self, column, value):
        self.filters.append(("gt", column, value))
        return self

    def order(self, column, desc=False):
        self.orders.append((column, desc))
        return self

    def limit(self, size):
        self.lim = size
        return self

    def _keep(self, row: dict[str, Any]) -> bool:
        for op, column, value in self.filters:
            if op == "eq":
                if row.get(column, "gyeongju_its" if column == "source" else None) != value:
                    return False
            elif op == "gt" and self.db.ignore_keyset:
                continue
            else:
                left, right = _ts(row[column]), _ts(value)
                if (op == "gte" and not left >= right) or (op == "gt" and not left > right):
                    return False
        return True

    def execute(self):
        db = self.db
        request = FakeRequest(self.columns, self.count, list(self.filters), list(self.orders), self.lim,
                              threading.current_thread().name)
        with db.lock:
            db.requests.append(request)
        if db.before is not None:
            db.before(request)
        if db.fail is not None and db.fail(request):
            raise RuntimeError(db.fail_message)
        with db.lock:
            rows = [r for r in db.rows if self._keep(r)]
        for column, desc in reversed(self.orders):
            rows.sort(key=lambda r, c=column: _ts(r[c]), reverse=desc)
        total = len(rows)
        if self.lim is not None:
            rows = rows[: self.lim]
        wanted = [c for c in ("bucket_at", "observed_at", "area_demand_snapshot_lots")
                  if c in self.columns]
        data = [{c: copy.deepcopy(r[c]) for c in wanted if c in r} for r in rows]
        request.rows = len(data)
        if db.after is not None:
            db.after(request)
        return SimpleNamespace(data=data, count=total if self.count is not None else None)


@dataclass
class FakeParkingDB:
    """area_demand_snapshots(+끼워 넣은 주차장 행)만 아는 PostgREST 대역. 스레드 안전(적재 스레드가 읽는다).

    · fail(request) 가 참이면 그 요청은 RuntimeError(fail_message).
    · before / after(request) — 결과를 만들기 전·후에 불린다(지연·막기 주입). after 는 읽은 뒤라, 거기서 막는 동안
      더한 행은 그 요청 결과에 없다.
    · ignore_keyset — bucket_at=gt 조건을 무시한다(keyset 이 전진하지 않는 서버 흉내).
    """

    rows: list[dict[str, Any]] = field(default_factory=list)
    fail: Callable[[FakeRequest], bool] | None = None
    fail_message: str = "area_demand_snapshots unavailable"
    before: Callable[[FakeRequest], None] | None = None
    after: Callable[[FakeRequest], None] | None = None
    ignore_keyset: bool = False

    def __post_init__(self) -> None:
        self.rows = [dict(r) for r in self.rows]
        self.lock = threading.Lock()
        self.requests: list[FakeRequest] = []

    def add(self, *rows: dict[str, Any]) -> None:
        """다른 인스턴스(또는 수집)가 새 행을 쓴다 — 같은 버킷이면 통째로 바꾼다(DB 기록 함수와 같다)."""
        with self.lock:
            for row in rows:
                self.rows = [r for r in self.rows if r["bucket_at"] != row["bucket_at"]] + [dict(row)]

    def remove(self, bucket_at: str) -> None:
        with self.lock:
            self.rows = [r for r in self.rows if r["bucket_at"] != bucket_at]

    def table(self, name: str) -> _FakeQuery:
        assert name == "area_demand_snapshots", name
        return _FakeQuery(self)


# ── Postgres 대조본(RPC area_demand_points_near, 마이그레이션 20260904120000) ─────────────────
# tests/services/test_area_demand_forecast_service.py 의 _sql_payload · _sql_distance_m 은 기존 시험이 잠그고 있어
# 그대로 두고, 여기에 운영 RPC 를 더 가깝게 흉내 낸 판을 따로 둔다: 거리는 Postgres 반올림(_sql_distance_pg),
# 수준은 PostgREST 가 돌려주는 유효숫자 15자리(float('%.15g' % level)), 관측 시각은 to_char(... .US)||'+00:00'.


def _sql_bounding_box_pg(latitude: float, longitude: float, radius_m: float) -> tuple[float, float, float, float]:
    """마이그레이션의 경계 상자 — test_area_demand_forecast_service._sql_bounding_box 와 같은 식(복사본)."""
    sigma = (radius_m + 1.0) / EARTH_M
    lat_delta = math.degrees(sigma)
    lat_min = max(-90.0, latitude - lat_delta)
    lat_max = min(90.0, latitude + lat_delta)
    far_lat = min(90.0, abs(latitude) + lat_delta)
    cos_product = math.cos(math.radians(latitude)) * math.cos(math.radians(far_lat))
    if cos_product <= 0.0:
        lng_delta = 180.0
    else:
        lng_delta = math.degrees(
            2.0 * math.asin(min(1.0, math.sin(sigma / 2.0) / math.sqrt(cos_product)))
        )
    if lng_delta >= 180.0 or longitude - lng_delta < -180.0 or longitude + lng_delta > 180.0:
        return lat_min, lat_max, -180.0, 180.0
    return lat_min, lat_max, longitude - lng_delta, longitude + lng_delta


def _pg_observed(value: Any) -> str:
    """to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' — µs 는 늘 6자리."""
    return _ts(value).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f") + "+00:00"


def _sql_payload_pg(
    parents: Any,
    lots: Any,
    latitude: float,
    longitude: float,
    radius_m: float = 2_000.0,
) -> dict[str, Any]:
    """RPC 가 돌려줄 JSONB 응답의 대조본. 합산 순서는 ``lots`` 의 순서다(열 순서로 넘기면 운영 실측 순서와 같다).

    DB CHECK 가 막아 실제로는 없는 무효 칸(숫자 아님·키 없음)은 SQL 이 볼 수 없으므로 건너뛴다.
    """
    lat_min, lat_max, lng_min, lng_max = _sql_bounding_box_pg(latitude, longitude, radius_m)
    times = {str(parent["id"]): parent["observed_at"] for parent in parents}
    grouped: dict[str, tuple[float, float, int]] = {}
    for lot in lots:
        snapshot_id = str(lot["snapshot_id"])
        if snapshot_id not in times:
            continue
        try:
            lot_lat, lot_lng = float(lot["latitude"]), float(lot["longitude"])
            total, available = int(lot["total_spaces"]), int(lot["available_spaces"])
        except (KeyError, TypeError, ValueError):
            continue
        if not lat_min <= lot_lat <= lat_max:
            continue
        if not lng_min <= lot_lng <= lng_max:
            continue
        if not (total > 0 and 0 <= available <= total):
            continue
        distance_m = _sql_distance_pg(latitude, longitude, lot_lat, lot_lng)
        if distance_m > radius_m:
            continue
        occupancy = 1.0 - available / total
        weight = min(total, 500) / (1.0 + distance_m / 500.0)
        weighted, weight_total, count = grouped.get(snapshot_id, (0.0, 0.0, 0))
        grouped[snapshot_id] = (weighted + occupancy * weight, weight_total + weight, count + 1)
    points = sorted(
        (
            [times[snapshot_id], float("%.15g" % min(1.0, max(0.0, weighted / weight_total))), count]
            for snapshot_id, (weighted, weight_total, count) in grouped.items()
            if weight_total > 0 and count > 0
        ),
        key=lambda row: _ts(row[0]),
    )
    for row in points:
        row[0] = _pg_observed(row[0])
    return {"source": "gyeongju_its", "radius_m": radius_m, "point_count": len(points), "points": points}


def lot_coordinates() -> tuple[tuple[float, float], ...]:
    """고정 자료에 나오는 주차장 좌표 전부(옮긴 :92 포함)."""
    return tuple((lat, lng) for _, lat, lng, _ in LOTS) + (MOVED_LOT_COORDS,)


def _is_tie(latitude: float, longitude: float, tolerance_m: float = 1e-6) -> bool:
    """어느 주차장까지의 반올림 전 거리가 .x5 경계에서 tolerance_m 안인가 — 파이썬·PG 반올림이 갈릴 수 있는 좌표(R11)."""
    for lot_lat, lot_lng in lot_coordinates():
        tenths = haversine_raw_m(latitude, longitude, lot_lat, lot_lng) * 10.0
        if abs((tenths - math.floor(tenths)) - 0.5) < tolerance_m * 10.0:
            return True
    return False


def north_of(lot_lat: float, lot_lng: float, target_m: float) -> tuple[float, float]:
    """주차장에서 정북으로 반올림 전 거리가 target_m 인 좌표(위도 이분 탐색)."""
    low, high = lot_lat, lot_lat + 0.05
    for _ in range(200):
        mid = (low + high) / 2.0
        if haversine_raw_m(mid, lot_lng, lot_lat, lot_lng) < target_m:
            low = mid
        else:
            high = mid
    return high, lot_lng


# ── 요일·시각 모양이 있는 변형(권역 전망이 '쓸 만함' 을 넘도록) ─────────────────────────────────────
# fixture_56d 의 잔여면은 균등 난수라 백테스트가 기준선보다 나을 수 없다(전망이 늘 None — 비교가 공허하다). 같은 행·같은
# 경계 사례(옛 15분 행·누락·무효 칸·옮긴 주차장·경계 행)를 그대로 두고, **유효한 칸의 잔여면만** KST 시각·주말 모양 +
# 작은 잡음으로 바꾼다. 무효 칸은 그대로 무효다.
_KST = timezone(timedelta(hours=9))


def _valid_cell(lot: dict[str, Any]) -> bool:
    total, available = lot.get("total_spaces"), lot.get("available_spaces")
    return (
        type(total) is int and type(available) is int and total > 0 and 0 <= available <= total
    )


@lru_cache(maxsize=1)
def patterned_fixture() -> ParkingFixture:
    base = fixture_56d()
    rng = random.Random(202609281)
    rows: list[dict[str, Any]] = []
    edge_row: dict[str, Any] | None = None
    for row in base.rows:
        local = _ts(row["observed_at"]).astimezone(_KST)
        hour = local.hour + local.minute / 60.0
        occupancy = 0.2 + 0.6 * max(0.0, math.cos((hour - 14.0) / 10.0 * math.pi))
        occupancy += 0.1 if local.weekday() >= 5 else 0.0
        lots = []
        for lot in row["area_demand_snapshot_lots"]:
            lot = dict(lot)
            if _valid_cell(lot):
                share = min(1.0, max(0.0, occupancy + rng.uniform(-0.04, 0.04)))
                lot["available_spaces"] = round(lot["total_spaces"] * (1.0 - share))
            lots.append(lot)
        new_row = {**row, "area_demand_snapshot_lots": lots}
        rows.append(new_row)
        if row is base.edge_row:
            edge_row = new_row
    assert edge_row is not None
    parents: list[dict[str, Any]] = []
    flat_lots: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        snapshot_id = f"s{index}"
        parents.append({"id": snapshot_id, "observed_at": row["observed_at"], "bucket_at": row["bucket_at"]})
        for lot in row["area_demand_snapshot_lots"]:
            flat_lots.append({"snapshot_id": snapshot_id, **lot})
    return ParkingFixture(tuple(rows), tuple(parents), tuple(flat_lots), edge_row)


class _SinceRpcClient:
    """``supabase_admin.rpc('area_demand_points_near', params).execute()`` 대역 — 운영 RPC 를 흉내 낸다(스펙 §8).

    · 부모를 ``observed_at >= p_since`` 로 **먼저** 거른 뒤 ``_sql_payload_pg`` 로 응답을 만든다(RPC 의 창과 같다).
    · 주차장은 열 순서((source_lot_id, 위도, 경도) — 안정 정렬)로 합산한다(운영 실측 순서와 같다).
    · 받은 ``p_since`` 를 전부 적어 둔다 — 시험이 (now − 56일).astimezone(UTC).isoformat() 과 같은지 본다.
    · before_execute(params): 응답 직전에 부른다(막아 두기·실패 주입).
    """

    def __init__(self, parents: Any, lots: Any, *, before_execute: Callable[[dict], None] | None = None) -> None:
        self.parents = tuple(parents)
        self.lots = sorted(
            lots, key=lambda lot: (str(lot["source_lot_id"]), float(lot["latitude"]), float(lot["longitude"]))
        )
        self.before_execute = before_execute
        self.calls: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    @property
    def since_seen(self) -> list[str]:
        return [call["p_since"] for call in self.calls]

    def rpc(self, name: str, params: dict[str, Any]):
        assert name == "area_demand_points_near", name
        with self._lock:
            self.calls.append(dict(params))
        client = self

        class _Query:
            def execute(self):
                if client.before_execute is not None:
                    client.before_execute(params)
                since = _ts(params["p_since"])
                parents = [parent for parent in client.parents if _ts(parent["observed_at"]) >= since]
                return SimpleNamespace(data=_sql_payload_pg(
                    parents, client.lots, params["p_latitude"], params["p_longitude"], params["p_radius_m"],
                ))

        return _Query()
