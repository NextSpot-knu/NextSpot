"""공개 읽기 경로는 경주 시설만 읽는다 — 서울 행은 **쿼리 안에서** 걸러진다(S3 isolation_design §3).

각 경로마다:
  · 기록하는 대역이 facilities 읽기에 ``region = gyeongju`` 필터가 걸렸는지 본다.
  · 대역은 그 필터를 실제로 적용한다 — 결과에 서울 행이 없다(선택 칸에 region 이 없어도).

`parking_demand_service` 는 facilities 를 읽지 않는다(주차장 목록만 다룬다) — 고정할 읽기가 없다.
"""

from __future__ import annotations

import asyncio
import copy
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.main import app
from app.routers import freshness, infrastructures, predict, safety
from app.services import (
    congestion_estimator_service,
    estimated_report_service,
    parking_derived_congestion_service,
    reference_snapshot,
)
from tests.conftest import role_headers

GJ_ID = "00000000-0000-4000-8000-0000000000a1"
GJ2_ID = "00000000-0000-4000-8000-0000000000a2"
SEOUL_ID = "00000000-0000-4000-8000-0000000000b1"


class MissingRegionColumn(Exception):
    """PostgREST 42703 — region 컬럼이 아직 없다(마이그레이션 전)."""

    def __init__(self, table: str = "facilities") -> None:
        self.code = "42703"
        self.message = f"column {table}.region does not exist"
        super().__init__(self.message)


def _cmp(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return (0, value)
    return (1, str(value))


class RecordingQuery:
    """PostgREST 체이닝 대역 — 필터를 기록하고 execute() 에서 실제로 적용한다."""

    CAP = 1000

    def __init__(self, db: "RecordingDB", table: str) -> None:
        self.db = db
        self.table = table
        self.columns = "*"
        self.count = None
        self.filters: list[tuple[str, str, object]] = []
        self.orders: list[tuple[str, bool]] = []
        self._negate = False
        self._range: tuple[int, int] | None = None
        self._limit: int | None = None
        self._insert = None

    # 체이닝
    def select(self, columns="*", count=None):
        self.columns, self.count = columns, count
        return self

    @property
    def not_(self):
        self._negate = True
        return self

    def _add(self, column, op, value):
        self.filters.append((column, ("not_" if self._negate else "") + op, value))
        self._negate = False
        return self

    def eq(self, column, value):
        return self._add(column, "eq", value)

    def neq(self, column, value):
        return self._add(column, "neq", value)

    def gt(self, column, value):
        return self._add(column, "gt", value)

    def gte(self, column, value):
        return self._add(column, "gte", value)

    def lte(self, column, value):
        return self._add(column, "lte", value)

    def in_(self, column, values):
        return self._add(column, "in", list(values))

    def is_(self, column, value):
        return self._add(column, "is", value)

    def order(self, column, desc=False, **_kw):
        self.orders.append((column, desc))
        return self

    def limit(self, size):
        self._limit = size
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def insert(self, payload):
        self._insert = payload
        return self

    # 실행
    def _match(self, row) -> bool:
        for column, op, value in self.filters:
            cell = row.get(column)
            negate = op.startswith("not_")
            base = op.removeprefix("not_")
            if base == "eq":
                ok = cell == value
            elif base == "neq":
                ok = cell != value
            elif base == "gt":
                ok = cell is not None and _cmp(cell) > _cmp(value)
            elif base == "gte":
                ok = cell is not None and _cmp(cell) >= _cmp(value)
            elif base == "lte":
                ok = cell is not None and _cmp(cell) <= _cmp(value)
            elif base == "in":
                ok = cell in value
            elif base == "is":
                ok = cell is None if value == "null" else cell == value
            else:  # pragma: no cover
                raise AssertionError(op)
            if ok == negate:
                return False
        return True

    def region_filters(self) -> list[object]:
        return [value for column, op, value in self.filters if column == "region" and op == "eq"]

    def execute(self):
        self.db.queries.append(self)
        if self._insert is not None:
            rows = self._insert if isinstance(self._insert, list) else [self._insert]
            self.db.inserted.setdefault(self.table, []).extend(copy.deepcopy(rows))
            return SimpleNamespace(data=copy.deepcopy(rows), count=None)
        if self.table in self.db.region_missing and any(c == "region" for c, _, _ in self.filters):
            raise MissingRegionColumn(self.table)
        rows = [r for r in self.db.tables.get(self.table, []) if self._match(r)]
        for column, desc in reversed(self.orders):
            rows.sort(key=lambda r, c=column: _cmp(r.get(c)), reverse=desc)
        total = len(rows)
        if self._range is not None:
            start, end = self._range
            rows = rows[start:end + 1]
        if self._limit is not None:
            rows = rows[: self._limit]
        rows = rows[: self.CAP]
        if self.columns.strip() != "*":
            cols = [c.strip() for c in self.columns.split(",")]
            rows = [{c: r[c] for c in cols if c in r} for r in rows]
        return SimpleNamespace(data=copy.deepcopy(rows), count=total if self.count else None)


class RecordingDB:
    def __init__(self, tables: dict[str, list[dict]], *, region_missing: set[str] | None = None) -> None:
        self.tables = {name: [dict(r) for r in rows] for name, rows in tables.items()}
        self.region_missing = set(region_missing or ())
        self.queries: list[RecordingQuery] = []
        self.inserted: dict[str, list[dict]] = {}

    def table(self, name: str) -> RecordingQuery:
        return RecordingQuery(self, name)

    def rpc(self, _name, _params):
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=[]))

    def facility_queries(self) -> list[RecordingQuery]:
        return [q for q in self.queries if q.table == "facilities" and q._insert is None]


def facility_row(fid: str, *, region: str | None, lat: float = 35.835, lng: float = 129.21, **extra) -> dict:
    row = {
        "id": fid, "name": f"시설-{fid[-2:]}", "type": "cafe", "latitude": lat, "longitude": lng,
        "capacity": 30, "operating_hours": None, "features": {"category": "카페"}, "is_active": True,
        "updated_at": "2026-10-01T00:00:00+00:00", "contentid": None, "contenttypeid": None,
        "image_url": None, "gallery_images": None, "address": None, "phone": None, "homepage": None,
        "overview": None, "barrier_free": None,
    }
    if region is not None:
        row["region"] = region
    row.update(extra)
    return row


def mixed_db(**kwargs) -> RecordingDB:
    """경주 2곳 + 서울 1곳(서울 쪽이 가장 최근에 갱신됐다 — '최신 1건' 류 읽기가 서울을 집으면 드러난다)."""
    return RecordingDB(
        {
            "facilities": [
                facility_row(GJ_ID, region="gyeongju", contentid="100", updated_at="2026-10-01T00:00:00+00:00"),
                facility_row(GJ2_ID, region="gyeongju", type="restaurant"),
                facility_row(
                    SEOUL_ID, region="seoul", lat=37.5738, lng=126.986, contentid="900",
                    updated_at="2026-10-30T00:00:00+00:00",
                ),
            ],
            "facility_source_refs": [],
            "app_events": [],
        },
        **kwargs,
    )


def assert_all_facility_reads_pinned(db: RecordingDB) -> None:
    reads = db.facility_queries()
    assert reads, "facilities 읽기가 없었다"
    for query in reads:
        assert query.region_filters() == ["gyeongju"], query.filters


def _ids(rows) -> set[str]:
    return {str(r["id"]) for r in rows}


# ── 참조 스냅샷(지도 기본 경로) ────────────────────────────────────────────────


def test_reference_snapshot_base_and_probe_read_only_gyeongju():
    db = mixed_db()
    with patch.object(reference_snapshot, "supabase_client", db):
        _signature, base, probe_error, refs_error = reference_snapshot._load_base(None, True)
        assert probe_error is None and refs_error is None
        assert base is not None
        assert set(base.ids) == {GJ_ID, GJ2_ID}
        signature = reference_snapshot._probe()
    assert signature[0] == 2  # 활성 경주 시설 수(서울 제외)
    assert signature[1] == "2026-10-01T00:00:00+00:00"  # 서울 행의 더 늦은 updated_at 이 끼지 않는다
    assert_all_facility_reads_pinned(db)


# ── 지도 실시간 경로 ───────────────────────────────────────────────────────────


def test_live_infrastructures_never_returns_seoul():
    db = mixed_db()
    with patch.object(infrastructures, "supabase_client", db), \
         patch.object(infrastructures, "fetch_latest_congestion_for_all", new=AsyncMock(return_value={})), \
         patch.object(infrastructures, "fetch_effective_availability_map", new=AsyncMock(return_value={})):
        with TestClient(app) as client:
            res = client.get("/api/v1/infrastructures")
            res_header = client.get(
                "/api/v1/infrastructures",
                headers={**role_headers("developer"), "X-NextSpot-Region": "seoul"},
            )
    assert res.status_code == 200
    assert {item["id"] for item in res.json()} == {GJ_ID, GJ2_ID}
    # 공개 지도는 헤더·역할과 무관하게 경주다(서울은 내부 경로로만).
    assert {item["id"] for item in res_header.json()} == {GJ_ID, GJ2_ID}
    assert all("region" not in item for item in res.json())
    assert_all_facility_reads_pinned(db)


def test_fetch_active_facilities_default_is_the_public_region():
    db = mixed_db()
    rows = asyncio.run(infrastructures.fetch_active_facilities(db, "id"))
    assert _ids(rows) == {GJ_ID, GJ2_ID}
    assert_all_facility_reads_pinned(db)


def test_fetch_active_facilities_internal_region_reads_only_that_region():
    db = mixed_db()
    rows = asyncio.run(infrastructures.fetch_active_facilities(db, "id", region="seoul"))
    assert _ids(rows) == {SEOUL_ID}
    assert [q.region_filters() for q in db.facility_queries()] == [["seoul"]]


# ── 관리자 피크 모의 ───────────────────────────────────────────────────────────


def test_simulate_peak_writes_logs_only_for_gyeongju():
    db = mixed_db()
    admin_db = RecordingDB({})
    with patch.object(infrastructures, "supabase_client", db), \
         patch.object(infrastructures, "supabase_admin", admin_db):
        with TestClient(app) as client:
            res = client.post("/api/v1/admin/simulate-peak", headers=role_headers("admin"))
    assert res.status_code == 200
    logged = {row["facility_id"] for row in admin_db.inserted["congestion_logs"]}
    assert logged == {GJ_ID, GJ2_ID}
    assert_all_facility_reads_pinned(db)


# ── 예측 ───────────────────────────────────────────────────────────────────────


def test_predict_batch_facilities_are_gyeongju_only():
    db = mixed_db()
    with patch.object(predict, "supabase_client", db):
        rows = asyncio.run(predict._fetch_facilities_id_type())
    assert _ids(rows) == {GJ_ID, GJ2_ID}
    assert_all_facility_reads_pinned(db)


def test_golden_hour_treats_a_seoul_facility_as_not_found():
    db = mixed_db()
    with patch.object(predict, "supabase_client", db):
        with TestClient(app) as client:
            res = client.get("/predict/golden-hour", params={"facilityId": SEOUL_ID})
    assert res.status_code == 404
    assert_all_facility_reads_pinned(db)


# ── 신선도 ─────────────────────────────────────────────────────────────────────


def test_freshness_estimate_ignores_seoul_updates():
    db = mixed_db()
    with patch.object(freshness, "supabase_admin", db):
        with TestClient(app) as client:
            res = client.get("/api/v1/freshness")
    assert res.status_code == 200
    body = res.json()
    assert body["source"] == "estimate"
    assert body["last_tourapi_sync"] == "2026-10-01T00:00:00+00:00"
    assert_all_facility_reads_pinned(db)


# ── 안전 관제 ──────────────────────────────────────────────────────────────────


def test_safety_facilities_are_gyeongju_only():
    db = mixed_db()
    with patch.object(safety, "supabase_client", db):
        rows = asyncio.run(safety._fetch_facilities())
    assert _ids(rows) == {GJ_ID, GJ2_ID}
    assert_all_facility_reads_pinned(db)


# ── 주차 기반 추정 ─────────────────────────────────────────────────────────────


def test_estimator_base_facilities_are_gyeongju_only(monkeypatch):
    db = mixed_db()
    monkeypatch.setattr(congestion_estimator_service, "_facility_cache", None)
    monkeypatch.setattr(congestion_estimator_service, "supabase_admin", db)
    rows = congestion_estimator_service._load_base_facilities()
    assert _ids(rows) == {GJ_ID, GJ2_ID}
    assert_all_facility_reads_pinned(db)


def test_estimated_report_facilities_are_gyeongju_only(monkeypatch):
    db = mixed_db()
    monkeypatch.setattr(estimated_report_service, "_facility_cache", None)
    monkeypatch.setattr(estimated_report_service, "supabase_admin", db)
    rows = estimated_report_service._load_facilities()
    assert _ids(rows) == {GJ_ID, GJ2_ID}
    assert_all_facility_reads_pinned(db)


def test_parking_derived_facilities_are_gyeongju_only(monkeypatch):
    db = mixed_db()
    monkeypatch.setattr(parking_derived_congestion_service, "supabase_admin", db)
    rows = parking_derived_congestion_service._load_active_facilities()
    assert _ids(rows) == {GJ_ID, GJ2_ID}
    assert_all_facility_reads_pinned(db)


def test_seoul_row_never_leaks_even_when_selected_without_the_region_column():
    db = mixed_db()
    rows = asyncio.run(infrastructures.fetch_active_facilities(db, "id, name"))
    assert all("region" not in row for row in rows)
    assert SEOUL_ID not in _ids(rows)

