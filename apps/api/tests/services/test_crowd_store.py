"""정규화 관측 저장(`zone_crowd_snapshots`) — 행 모양 · 멱등 키 · 표 미적용 · 예외 없음."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.services import seoul_citydata_service as seoul
from app.services.crowd import seoul_provider as provider
from app.services.crowd import store

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
KST = timezone(timedelta(hours=9))
FETCHED_AT = datetime(2026, 9, 20, 14, 41, 30, tzinfo=KST).astimezone(timezone.utc)
BUCKET_AT = seoul.bucket_start(FETCHED_AT)


def _observation(name: str = "홍대 관광특구"):
    payload = json.loads((FIXTURES / "seoul_citydata_hongdae_synthetic.json").read_text(encoding="utf-8"))
    payload["CITYDATA"]["AREA_NM"] = name
    payload["CITYDATA"]["LIVE_PPLTN_STTS"][0]["AREA_NM"] = name
    observation = provider.observation_from_parsed(seoul.parse_citydata(payload, name), fetched_at=FETCHED_AT)
    assert observation is not None
    return observation


class _PostgrestLikeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def test_row_has_the_columns_and_unique_key_of_the_migration():
    row = store.snapshot_row(_observation(), bucket_at=BUCKET_AT)
    assert row["zone_id"] == "seoul:POI007"
    assert row["source"] == "seoul_citydata"
    assert row["bucket_at"] == "2026-09-20T05:40:00+00:00"
    assert row["observed_at"] == "2026-09-20T14:30:00+09:00"
    assert row["level"] == pytest.approx(0.625)
    assert row["level_scale"] == "seoul_congest_4"
    assert row["forecast"][0] == {
        "target_at": "2026-09-20T15:00:00+09:00",
        "population_min": 46000, "population_max": 48000,
        "level": pytest.approx(0.875), "level_label": "붐빔",
    }
    json.dumps(row, ensure_ascii=False)  # JSON 으로 그대로 보낼 수 있어야 한다

    sql = (Path(__file__).resolve().parents[4] / "supabase/migrations" / store.MIGRATION).read_text(encoding="utf-8")
    table_sql = sql[sql.index("CREATE TABLE IF NOT EXISTS public.zone_crowd_snapshots"):]
    table_sql = table_sql[: table_sql.index(");")]
    for column in row:
        assert f"\n    {column} " in table_sql, f"마이그레이션에 {column} 컬럼이 없다"
    assert "UNIQUE (zone_id, source, bucket_at)" in table_sql


def test_default_bucket_follows_fetched_at_like_the_legacy_table():
    observation = _observation()
    assert store.snapshot_row(observation)["bucket_at"] == seoul.build_snapshot_row(
        seoul.parse_citydata(
            json.loads((FIXTURES / "seoul_citydata_hongdae_synthetic.json").read_text(encoding="utf-8")),
            "홍대 관광특구",
        ),
        fetched_at=FETCHED_AT,
        tourism_level=None,
    )[0]["bucket_at"]
    assert store.bucket_floor(FETCHED_AT) == BUCKET_AT


def test_persist_stores_each_observation(monkeypatch):
    written: list[dict] = []
    monkeypatch.setattr(store, "_upsert_row", written.append)
    result = asyncio.run(store.persist_observations([_observation(), _observation("연남동")], bucket_at=BUCKET_AT))
    assert result == {"state": "stored", "stored_count": 2, "errors": {}}
    assert [row["zone_id"] for row in written] == ["seoul:POI007", "seoul:POI073"]


def test_nothing_to_store_is_skipped(monkeypatch):
    def must_not_call(_row):
        raise AssertionError

    monkeypatch.setattr(store, "_upsert_row", must_not_call)
    assert asyncio.run(store.persist_observations([], bucket_at=BUCKET_AT))["state"] == "skipped"


def test_missing_table_stops_at_the_first_row_without_raising(monkeypatch):
    calls: list[str] = []

    def missing(row):
        calls.append(row["zone_id"])
        raise _PostgrestLikeError(
            "PGRST205", "Could not find the table 'public.zone_crowd_snapshots' in the schema cache"
        )

    monkeypatch.setattr(store, "_upsert_row", missing)
    result = asyncio.run(store.persist_observations([_observation(), _observation("연남동")], bucket_at=BUCKET_AT))
    assert result["state"] == "migration_not_applied"
    assert result["stored_count"] == 0
    assert calls == ["seoul:POI007"]


def test_undefined_zone_fails_only_that_row(monkeypatch):
    def upsert(row):
        if row["zone_id"] == "seoul:POI073":
            raise _PostgrestLikeError(
                "23503",
                'insert or update on table "zone_crowd_snapshots" violates foreign key constraint',
            )

    monkeypatch.setattr(store, "_upsert_row", upsert)
    result = asyncio.run(store.persist_observations([_observation("연남동"), _observation()], bucket_at=BUCKET_AT))
    assert result == {"state": "partial", "stored_count": 1, "errors": {"seoul:POI073": "zone_not_defined"}}


def test_other_failures_are_reported_not_raised(monkeypatch):
    def broken(_row):
        raise RuntimeError("connection reset")

    monkeypatch.setattr(store, "_upsert_row", broken)
    result = asyncio.run(store.persist_observations([_observation()], bucket_at=BUCKET_AT))
    assert result == {"state": "failed", "stored_count": 0, "errors": {"seoul:POI007": "zone_snapshot_failed"}}


@pytest.mark.parametrize(
    ("exc", "expected"),
    [
        (Exception("Could not find the table 'public.zone_crowd_snapshots' in the schema cache"), True),
        (Exception('relation "public.zone_crowd_snapshots" does not exist'), True),
        (_PostgrestLikeError("42P01", "undefined table"), True),
        (Exception("column zone_crowd_snapshots.quality does not exist"), False),
        (Exception('relation "public.other_table" does not exist'), False),
        (Exception("connection reset"), False),
    ],
)
def test_missing_table_detection_is_per_table(exc, expected):
    assert store.is_missing_table(exc, store.TABLE) is expected


def test_row_building_failure_is_contained_per_observation(monkeypatch):
    """행 만들기(snapshot_row)도 try 안이다 — 깨진 관측 하나가 이중 저장 전체를 터뜨리지 않는다."""
    written: list[dict] = []
    monkeypatch.setattr(store, "_upsert_row", written.append)
    real = store.snapshot_row

    def picky(observation, *, bucket_at=None):
        if observation.zone_id == "seoul:POI073":
            raise ValueError("bad observation")
        return real(observation, bucket_at=bucket_at)

    monkeypatch.setattr(store, "snapshot_row", picky)
    result = asyncio.run(store.persist_observations([_observation("연남동"), _observation()], bucket_at=BUCKET_AT))
    assert result == {"state": "partial", "stored_count": 1, "errors": {"seoul:POI073": "zone_snapshot_failed"}}
    assert [row["zone_id"] for row in written] == ["seoul:POI007"]


def test_non_observation_input_never_raises(monkeypatch):
    monkeypatch.setattr(store, "_upsert_row", lambda _row: None)
    result = asyncio.run(store.persist_observations([object()], bucket_at=BUCKET_AT))  # type: ignore[list-item]
    assert result == {"state": "failed", "stored_count": 0, "errors": {"?": "zone_snapshot_failed"}}
