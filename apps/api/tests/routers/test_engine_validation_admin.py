"""관리자 엔진 검증 조회 API — 상태 판정·권한·PostgREST 1000행 캡을 잠근다.

페이크는 **1000행 캡을 실제로 강제한다**(test_admin_row_cap.py 와 같은 이유) — 14일 창은 2,016행이라
`fetch_all_rows` 대신 단일 select 로 되돌리면 지표가 앞쪽 1000행으로 쪼그라드는데, 관대한 페이크로는
그 회귀를 잡을 수 없다.
"""

from datetime import datetime, timedelta, timezone

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import engine_validation_admin as router_module
from tests.conftest import admin_headers

NOW = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)
_ROW_CAP = 1000


class _Response:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, table: "_Table"):
        self._table = table
        self._gte: tuple[str, str] | None = None
        self._orders: list[tuple[str, bool]] = []
        self._range: tuple[int, int] | None = None
        self._limit: int | None = None

    def select(self, columns: str):
        self._table.selects.append(columns)
        return self

    def gte(self, column, value):
        self._gte = (column, value)
        return self

    def order(self, column, desc=False):
        self._orders.append((column, desc))
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def limit(self, size):
        self._limit = size
        return self

    def execute(self):
        if self._table.error is not None:
            raise self._table.error
        rows = list(self._table.rows)
        if self._gte:
            column, value = self._gte
            rows = [row for row in rows if row[column] >= value]
        for column, desc in reversed(self._orders):
            rows.sort(key=lambda row: row[column], reverse=desc)
        if self._range:
            rows = rows[self._range[0] : self._range[1] + 1]
        if self._limit is not None:
            rows = rows[: self._limit]
        return _Response(rows[:_ROW_CAP])


class _Table:
    def __init__(self, rows=None, error: Exception | None = None):
        self.rows = rows or []
        self.error = error
        self.selects: list[str] = []


class _Client:
    def __init__(self, table: _Table):
        self._table = table

    def table(self, name):
        assert name == "seoul_citydata_snapshots"
        return _Query(self._table)


def _row(i: int, *, start: datetime, lvl="보통", est=0.4) -> dict:
    bucket = start + timedelta(minutes=10 * i)
    return {
        "id": f"id-{i:05d}",
        "area_cd": "POI014",
        "area_nm": "홍대 관광특구",
        # PostgREST 가 돌려주는 형태(ISO 문자열) — gte 비교도 문자열로 한다.
        "bucket_at": bucket.isoformat(),
        "observed_at": (bucket - timedelta(minutes=4)).isoformat(),
        "fetched_at": bucket.isoformat(),
        "congest_lvl": lvl,
        "ppltn_min": 20000 + (i % 30) * 500,
        "ppltn_max": 22000 + (i % 30) * 500,
        "fcst": [],
        "live_lot_count": 2,
        "parking_level": est,
        "tourism_level": None,
        "level_est": est,
        "estimator_version": "v1",
    }


def _install(monkeypatch, table: _Table):
    monkeypatch.setattr(router_module, "supabase_admin", _Client(table))


def _client():
    app = FastAPI()
    app.include_router(router_module.router)
    return TestClient(app)


def test_requires_admin():
    assert _client().get("/api/v1/admin/engine-validation/seoul/summary").status_code == 401


def test_days_is_bounded():
    response = _client().get("/api/v1/admin/engine-validation/seoul/summary?days=29", headers=admin_headers())
    assert response.status_code == 422


def test_missing_table_is_not_migrated_state_not_500(monkeypatch):
    _install(monkeypatch, _Table(error=Exception("{'code': 'PGRST205', 'message': \"Could not find the table 'public.seoul_citydata_snapshots' in the schema cache\"}")))
    response = _client().get("/api/v1/admin/engine-validation/seoul/summary", headers=admin_headers())
    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "not_migrated"
    assert body["migration"] == "20260920120000_seoul_citydata_snapshots.sql"
    assert body["places"] == [] and body["collection"] is None


def test_missing_column_is_not_mistaken_for_missing_table(monkeypatch):
    _install(monkeypatch, _Table(error=Exception("{'code': '42703', 'message': 'column seoul_citydata_snapshots.level_est does not exist'}")))
    response = _client().get("/api/v1/admin/engine-validation/seoul/summary", headers=admin_headers())
    assert response.status_code == 503
    assert response.json() == {"detail": "engine_validation_unavailable"}


def test_empty_state(monkeypatch):
    _install(monkeypatch, _Table(rows=[]))
    body = router_module.build_summary(14, now=NOW)
    assert body["state"] == "empty"
    assert body["collection"]["row_count"] == 0 and body["collection"]["latest_bucket_at"] is None


def test_rows_only_outside_window_is_stalled(monkeypatch):
    old = [_row(i, start=NOW - timedelta(days=20)) for i in range(5)]
    _install(monkeypatch, _Table(rows=old))
    body = router_module.build_summary(14, now=NOW)
    assert body["state"] == "stalled"
    assert body["collection"]["stale"] is True
    assert body["collection"]["latest_bucket_at"].startswith("2026-09-15")


def test_few_rows_is_collecting_with_insufficient_metrics(monkeypatch):
    rows = [_row(i, start=NOW - timedelta(hours=2)) for i in range(12)]
    _install(monkeypatch, _Table(rows=rows))
    body = router_module.build_summary(14, now=NOW)
    assert body["state"] == "collecting"
    place = body["places"][0]
    assert place["area_nm"] == "홍대 관광특구" and place["sufficient"] is False
    exact = next(metric for metric in place["metrics"] if metric["key"] == "grade_exact")
    assert exact["status"] == "insufficient" and exact["n"] == 12
    assert body["collection"]["stale"] is False


def test_full_window_pages_past_postgrest_cap(monkeypatch):
    # 14일 × 144 = 2,016행. 한 번의 select 로는 1000행만 온다.
    start = NOW - timedelta(days=14) + timedelta(minutes=10)
    rows = [_row(i, start=start) for i in range(14 * 144 - 1)]
    table = _Table(rows=rows)
    _install(monkeypatch, table)
    body = router_module.build_summary(14, now=NOW)
    assert body["state"] == "ready"
    assert body["collection"]["row_count"] == len(rows)
    place = body["places"][0]
    assert place["bucket_count"] == len(rows)
    assert len(place["series"]) == len(rows)
    assert place["days_covered"] >= 14
    # 주차장 원문(prk)은 조회하지 않는다 — 행마다 커서 응답을 부풀린다.
    assert all("prk" not in columns.split(",") for columns in table.selects)


def test_endpoint_returns_contract(monkeypatch):
    rows = [_row(i, start=datetime.now(timezone.utc) - timedelta(hours=10)) for i in range(50)]
    _install(monkeypatch, _Table(rows=rows))
    response = _client().get("/api/v1/admin/engine-validation/seoul/summary?days=7", headers=admin_headers())
    assert response.status_code == 200
    body = response.json()
    assert set(body) >= {
        "state", "window_days", "window_start", "generated_at", "grade_labels", "estimate_grade_edges",
        "min_samples", "min_danger_samples", "omitted_metrics", "collection", "places",
    }
    assert body["window_days"] == 7
    assert body["state"] == "ready"
    place = body["places"][0]
    assert {metric["key"] for metric in place["metrics"]} == {
        "grade_exact", "grade_within_one", "spearman", "danger_misclassification",
        "forecast_mae_30m", "seoul_forecast_mae_30m", "coverage",
    }
    assert body["omitted_metrics"][0]["key"] == "distinguishability"


def test_unexpected_failure_is_503(monkeypatch):
    _install(monkeypatch, _Table(error=RuntimeError("connection reset")))
    response = _client().get("/api/v1/admin/engine-validation/seoul/summary", headers=admin_headers())
    assert response.status_code == 503
    assert response.json() == {"detail": "engine_validation_unavailable"}
