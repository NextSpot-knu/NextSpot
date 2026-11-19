"""region 컬럼이 아직 없을 때(API 가 마이그레이션보다 먼저 배포) 경주 출력은 그대로다.

고정한 읽기마다 같은 경주 행을 두 번 돌린다:
  · 마이그레이션 후 — 행에 region='gyeongju', 필터가 그대로 통과.
  · 마이그레이션 전 — region 필터를 건 읽기가 42703 'column facilities.region does not exist' 로 실패.
두 결과가 같아야 한다(경고를 남기고 필터 없이 다시 읽는다). 서울 경로는 같은 상황에서 빈 결과다.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.core import region as region_core
from app.main import app
from app.routers import freshness, infrastructures, predict, safety
from app.services import (
    congestion_estimator_service,
    estimated_report_service,
    parking_derived_congestion_service,
    reference_snapshot,
)
from tests.conftest import role_headers
from tests.routers.test_region_isolation_public_reads import (
    GJ2_ID,
    GJ_ID,
    MissingRegionColumn,
    RecordingDB,
    facility_row,
)


def _db(*, migrated: bool) -> RecordingDB:
    region = "gyeongju" if migrated else None
    return RecordingDB(
        {
            "facilities": [
                facility_row(GJ_ID, region=region, contentid="100", updated_at="2026-10-01T00:00:00+00:00"),
                facility_row(GJ2_ID, region=region, type="restaurant", updated_at="2026-09-01T00:00:00+00:00"),
            ],
            "facility_source_refs": [],
            "app_events": [],
        },
        region_missing=set() if migrated else {"facilities"},
    )


def _strip_region(rows):
    return [{k: v for k, v in row.items() if k != "region"} for row in rows]


def _both(run):
    after, before = _db(migrated=True), _db(migrated=False)
    out_after, out_before = run(after), run(before)
    # 마이그레이션 전 db 는 region 필터를 한 번 거부당하고 필터 없이 다시 읽었다.
    assert any(q.region_filters() for q in before.facility_queries())
    assert any(not q.region_filters() for q in before.facility_queries())
    return out_after, out_before


def test_region_column_error_is_recognized_and_other_42703_is_not():
    assert region_core.is_missing_region_column(MissingRegionColumn())

    class _IsActiveMissing(Exception):
        code = "42703"
        message = "column facilities.is_active does not exist"

    assert not region_core.is_missing_region_column(_IsActiveMissing())


def test_fetch_active_facilities():
    after, before = _both(lambda db: asyncio.run(infrastructures.fetch_active_facilities(db, "*")))
    assert _strip_region(after) == _strip_region(before)
    assert {row["id"] for row in before} == {GJ_ID, GJ2_ID}


def test_fetch_active_facilities_internal_region_is_empty_before_migration():
    db = _db(migrated=False)
    assert asyncio.run(infrastructures.fetch_active_facilities(db, "*", region="seoul")) == []


def test_reference_snapshot_base_and_probe():
    def run(db):
        with patch.object(reference_snapshot, "supabase_client", db):
            _sig, base, probe_error, refs_error = reference_snapshot._load_base(None, True)
            probe = reference_snapshot._probe()
        assert probe_error is None and refs_error is None
        return base.version, base.ids, probe

    after, before = _both(run)
    assert after == before


def test_live_infrastructures_endpoint():
    def run(db):
        with patch.object(infrastructures, "supabase_client", db), \
             patch.object(infrastructures, "fetch_latest_congestion_for_all", new=AsyncMock(return_value={})), \
             patch.object(infrastructures, "fetch_effective_availability_map", new=AsyncMock(return_value={})):
            with TestClient(app) as client:
                res = client.get("/api/v1/infrastructures")
        assert res.status_code == 200
        return res.json()

    after, before = _both(run)
    assert after == before


def test_simulate_peak():
    def run(db):
        admin_db = RecordingDB({})
        with patch.object(infrastructures, "supabase_client", db), \
             patch.object(infrastructures, "supabase_admin", admin_db):
            with TestClient(app) as client:
                res = client.post("/api/v1/admin/simulate-peak", headers=role_headers("admin"))
        assert res.status_code == 200
        return sorted(row["facility_id"] for row in admin_db.inserted["congestion_logs"])

    after, before = _both(run)
    assert after == before == sorted([GJ_ID, GJ2_ID])


def test_predict_batch_and_golden_hour():
    def run(db):
        with patch.object(predict, "supabase_client", db):
            rows = asyncio.run(predict._fetch_facilities_id_type())
            with TestClient(app) as client:
                golden = client.get("/predict/golden-hour", params={"facilityId": GJ_ID})
        return _strip_region(rows), golden.status_code, golden.json()

    after, before = _both(run)
    assert after == before
    assert before[1] == 200


def test_freshness_estimate():
    def run(db):
        with patch.object(freshness, "supabase_admin", db):
            with TestClient(app) as client:
                return client.get("/api/v1/freshness").json()

    after, before = _both(run)
    assert after == before
    assert before["last_tourapi_sync"] == "2026-10-01T00:00:00+00:00"


def test_safety_facilities():
    def run(db):
        with patch.object(safety, "supabase_client", db):
            return _strip_region(asyncio.run(safety._fetch_facilities()))

    after, before = _both(run)
    assert after == before


@pytest.mark.parametrize(
    "module, loader",
    [
        (congestion_estimator_service, "_load_base_facilities"),
        (estimated_report_service, "_load_facilities"),
    ],
)
def test_estimator_facility_loaders(monkeypatch, module, loader):
    def run(db):
        monkeypatch.setattr(module, "_facility_cache", None)
        monkeypatch.setattr(module, "supabase_admin", db)
        return _strip_region(getattr(module, loader)())

    after, before = _both(run)
    assert after == before


def test_parking_derived_facilities(monkeypatch):
    def run(db):
        monkeypatch.setattr(parking_derived_congestion_service, "supabase_admin", db)
        return _strip_region(parking_derived_congestion_service._load_active_facilities())

    after, before = _both(run)
    assert after == before
