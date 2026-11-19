"""``zone_evidence.select_latest_reading`` — 운영 구역 상태 읽기(_load_region_state_sync)와 같은 선택(S4 재생이 쓴다).

대역 DB 로 운영 경로를 돌린 결과와, 같은 행을 같은 순서(bucket desc, observed desc · 2시간 창)로 순수 함수에 넣은 결과가
구역마다 같아야 한다 — 대체값 · 상대 눈금 · 2시간보다 오래된 행 건너뛰기 포함.
"""

from __future__ import annotations

from datetime import timedelta

from app.services.crowd import zone_evidence as ze
from tests.services.test_zone_evidence import NOW, _db, _Explode, _load, _snap, use_db  # noqa: F401 — 픽스처 재사용


def _definitions(db) -> dict[str, ze.ZoneDefinition]:
    return {
        row["zone_id"]: ze._zone_definition(row) for row in db.tables["zones"] if row["region"] == "seoul"
    }


def _rows_newest_first(db, zone_id: str) -> list[dict]:
    since = NOW - ze._SNAPSHOT_LOOKBACK
    rows = [
        r for r in db.tables["zone_crowd_snapshots"]
        if r["zone_id"] == zone_id and ze.parse_ts(r["bucket_at"]) >= since
    ]
    return sorted(rows, key=lambda r: (r["bucket_at"], r["observed_at"]), reverse=True)


def test_select_latest_reading_matches_the_region_state_loader(use_db):  # noqa: F811
    db = use_db(_db())
    db.tables["zone_crowd_snapshots"].append(  # 2시간 창 밖의 행은 최신 후보가 아니다
        _snap("seoul:POI012", minutes_ago=130, level=0.875, label="붐빔")
    )
    state = ze._load_region_state_sync("seoul", NOW)
    zones = _definitions(db)
    for zone_id, zone in zones.items():
        chosen = ze.select_latest_reading(_rows_newest_first(db, zone_id), zone)
        assert chosen == state.readings.get(zone_id), zone_id
    # 홍대: 최신(대체값) · 둘째(상대 눈금)를 건너뛰고 셋째(여유)
    assert state.readings["seoul:POI007"].level_band == "relaxed"


def test_select_latest_reading_skips_replaced_and_returns_none_when_nothing_passes():
    zone = ze.ZoneDefinition("seoul:POI007", "seoul", "홍대 관광특구", "seoul_citydata", "hongdae", 37.55, 126.92, 600)
    rows = [
        _snap("seoul:POI007", minutes_ago=2, level=0.875, label="붐빔", quality={"replaced": True}),
        _snap("seoul:POI007", minutes_ago=4, level=None, label=None),
    ]
    assert ze.select_latest_reading(rows, zone) is None
    rows.append(_snap("seoul:POI007", minutes_ago=6, level=0.375, label="보통"))
    reading = ze.select_latest_reading(rows, zone)
    assert reading is not None and reading.level_band == "normal"
    assert reading.observed_at == NOW - timedelta(minutes=6)


def test_gyeongju_still_makes_zero_client_calls(monkeypatch):
    monkeypatch.setattr(ze, "supabase_admin", _Explode())
    assert _load(["x"], region="gyeongju") == {}
