"""관리자 보정 조회 API — 상태 판정·권한·계약(admin 페이지가 이 키 이름에 맞춰 만들어진다).

페이크는 PostgREST 의 **1000행 캡을 실제로 강제한다**(test_engine_validation_admin.py 와 같은 이유) —
28일 창은 대상지 2곳 × 144버킷 × 28일 = 8,064행이라 단발 select 로 되돌리면 표본이 조용히 쪼그라든다.
"""

from datetime import datetime, timedelta, timezone

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import engine_validation_calibration as router_module
from app.services import congestion_calibration_service as cal
from tests.conftest import admin_headers

NOW = datetime(2026, 10, 20, 3, 0, tzinfo=timezone.utc)
_ROW_CAP = 1000


class _Response:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, rows, error):
        self._rows = list(rows)
        self._error = error
        self._range = None

    def select(self, columns):
        return self

    def in_(self, column, values):
        self._rows = [row for row in self._rows if row.get(column) in values]
        return self

    def eq(self, column, value):
        self._rows = [row for row in self._rows if row.get(column) == value]
        return self

    def gte(self, column, value):
        self._rows = [row for row in self._rows if str(row.get(column)) >= str(value)]
        return self

    def order(self, column, desc=False):
        self._rows.sort(key=lambda row: str(row.get(column)), reverse=desc)
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def execute(self):
        if self._error is not None:
            raise self._error
        rows = self._rows[: _ROW_CAP]
        if self._range:
            rows = self._rows[self._range[0] : self._range[0] + _ROW_CAP][: self._range[1] - self._range[0] + 1]
        return _Response(rows)


class _Client:
    def __init__(self, tables, error=None):
        self._tables = tables
        self._error = error

    def table(self, name):
        return _Query(self._tables.get(name, []), self._error if name == cal.TABLE else None)


def _seoul_rows(days: int, per_day: int) -> list[dict]:
    """명동·동대문 각각 days 일 × per_day 버킷. 인파 중앙값은 주차의 제곱을 따른다."""
    rows: list[dict] = []
    start = NOW - timedelta(days=days + 1)
    for place in cal.CALIBRATION_PLACES:
        for day in range(days):
            for step in range(per_day):
                x = 0.1 + 0.8 * step / max(1, per_day - 1)
                bucket = start + timedelta(days=day, minutes=4 * step)
                midpoint = round(x * x * 10_000)
                rows.append({
                    "area_nm": place,
                    "bucket_at": bucket.isoformat(),
                    "ppltn_min": midpoint - 100,
                    "ppltn_max": midpoint + 100,
                    "parking_level": round(x, 4),
                })
    return rows


def _gyeongju_tables(count: int) -> dict:
    parents = []
    lots = []
    start = NOW - timedelta(days=2)
    for i in range(count):
        parents.append({
            "id": f"snap-{i:04d}",
            "source": "gyeongju_its",
            "bucket_at": (start + timedelta(minutes=10 * i)).isoformat(),
        })
        occupancy = 0.2 + 0.6 * (i % 10) / 9
        lots.append({
            "snapshot_id": f"snap-{i:04d}",
            "total_spaces": 100,
            "available_spaces": round(100 * (1 - occupancy)),
        })
    return {"area_demand_snapshots": parents, "area_demand_snapshot_lots": lots}


def _install(monkeypatch, *, seoul=(), gyeongju=None, error=None):
    tables = {cal.TABLE: list(seoul), **(gyeongju or {"area_demand_snapshots": [], "area_demand_snapshot_lots": []})}
    monkeypatch.setattr(cal, "supabase_admin", _Client(tables, error))
    cal.reset_caches()


def _client():
    app = FastAPI()
    app.include_router(router_module.router)
    return TestClient(app)


# ── 권한·입력 ────────────────────────────────────────────────────────────────


def test_requires_admin():
    assert _client().get("/api/v1/admin/engine-validation/seoul/calibration").status_code == 401


def test_days_is_bounded():
    response = _client().get(
        "/api/v1/admin/engine-validation/seoul/calibration?days=29", headers=admin_headers()
    )
    assert response.status_code == 422


# ── 상태 ─────────────────────────────────────────────────────────────────────


def test_missing_table_is_not_migrated_not_500(monkeypatch):
    _install(monkeypatch, error=Exception(
        "{'code': 'PGRST205', 'message': \"Could not find the table 'public.seoul_citydata_snapshots' in the schema cache\"}"
    ))
    response = _client().get(
        "/api/v1/admin/engine-validation/seoul/calibration", headers=admin_headers()
    )

    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "not_migrated" and body["applied"] is False
    assert body["curve"] is None and body["quality"] is None
    assert cal.MIGRATION in body["reason"]


def test_missing_column_is_not_mistaken_for_a_missing_table(monkeypatch):
    _install(monkeypatch, error=Exception(
        "{'code': '42703', 'message': 'column seoul_citydata_snapshots.parking_level does not exist'}"
    ))
    response = _client().get(
        "/api/v1/admin/engine-validation/seoul/calibration", headers=admin_headers()
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "calibration_unavailable"}


def test_empty_table_is_the_empty_state(monkeypatch):
    _install(monkeypatch, seoul=[])
    body = cal.build_report(28, now=NOW)

    assert body["state"] == "empty" and body["applied"] is False
    assert body["sample"] == {
        "paired_buckets": 0, "days": 0, "first_bucket_at": None, "last_bucket_at": None
    }
    assert body["gyeongju_effect"] is None
    assert len(body["hour_shape"]["seoul"]) == 24


def test_thin_sample_is_insufficient_and_says_why(monkeypatch):
    _install(monkeypatch, seoul=_seoul_rows(days=2, per_day=20))
    body = cal.build_report(28, now=NOW)

    assert body["state"] == "insufficient" and body["applied"] is False
    assert body["sample"]["days"] == 2 and body["sample"]["paired_buckets"] == 80
    assert "3일" in body["reason"]
    assert body["curve"] is not None, "적용 안 해도 곡선은 보여 준다"


def test_ready_state_applies_the_curve(monkeypatch):
    _install(monkeypatch, seoul=_seoul_rows(days=6, per_day=40), gyeongju=_gyeongju_tables(200))
    body = cal.build_report(28, now=NOW)

    assert body["state"] == "ready" and body["applied"] is True
    assert body["reason"] is None
    assert body["sample"]["paired_buckets"] == 480 and body["sample"]["days"] == 6
    knots = body["curve"]["knots"]
    assert body["curve"]["method"] == cal.METHOD
    assert [knot["y"] for knot in knots] == sorted(knot["y"] for knot in knots)
    assert body["quality"]["improved"] is True
    assert body["quality"]["mae_calibrated"] < body["quality"]["mae_identity"]
    effect = body["gyeongju_effect"]
    assert effect is not None and effect["samples"] and effect["median_shift"] < 0
    assert any(row["n"] for row in body["hour_shape"]["gyeongju_parking"])


def test_window_larger_than_postgrest_cap_is_paged(monkeypatch):
    rows = _seoul_rows(days=6, per_day=100)  # 2곳 × 600 = 1,200행 > 1000
    _install(monkeypatch, seoul=rows)
    body = cal.build_report(28, now=NOW)

    assert body["sample"]["paired_buckets"] == len(rows), "1000행 캡을 넘어 전량을 읽어야 한다"


def test_unexpected_failure_is_503(monkeypatch):
    _install(monkeypatch, error=RuntimeError("connection reset"))
    response = _client().get(
        "/api/v1/admin/engine-validation/seoul/calibration", headers=admin_headers()
    )
    assert response.status_code == 503


# ── 계약 ─────────────────────────────────────────────────────────────────────


def test_endpoint_returns_the_agreed_contract(monkeypatch):
    _install(monkeypatch, seoul=_seoul_rows(days=6, per_day=40), gyeongju=_gyeongju_tables(100))
    response = _client().get(
        "/api/v1/admin/engine-validation/seoul/calibration?days=28", headers=admin_headers()
    )

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "state", "applied", "places", "window_days", "generated_at", "sample", "requirement",
        "curve", "quality", "hour_shape", "gyeongju_effect", "reason",
    }
    assert body["places"] == ["명동 관광특구", "동대문 관광특구"]
    assert body["window_days"] == 28
    assert body["requirement"] == {
        "min_paired_buckets": 300, "min_days": 3, "must_beat_identity": True
    }
    assert set(body["sample"]) == {"paired_buckets", "days", "first_bucket_at", "last_bucket_at"}
    assert set(body["curve"]) == {"method", "knots", "fitted_at"}
    assert set(body["curve"]["knots"][0]) == {"x", "y"}
    assert set(body["quality"]) >= {
        "holdout_days", "mae_identity", "mae_calibrated",
        "spearman_identity", "spearman_calibrated", "improved",
    }
    assert set(body["hour_shape"]) == {"seoul", "gyeongju_parking"}
    assert set(body["hour_shape"]["seoul"][0]) >= {"hour", "weekday_mean", "weekend_mean", "n"}
    assert set(body["gyeongju_effect"]) == {"samples", "median_shift"}
    assert set(body["gyeongju_effect"]["samples"][0]) == {"raw", "calibrated"}
