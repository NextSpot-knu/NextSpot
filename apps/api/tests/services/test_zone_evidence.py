"""구역 혼잡 근거(app/services/crowd/zone_evidence.py)."""

from __future__ import annotations

import asyncio
import time
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.services.crowd import zone_evidence as ze
from tests.routers.test_region_isolation_public_reads import RecordingDB

NOW = datetime(2026, 10, 31, 3, 0, tzinfo=timezone.utc)  # 12:00 KST
F1 = "00000000-0000-4000-8000-0000000000c1"
F2 = "00000000-0000-4000-8000-0000000000c2"
F3 = "00000000-0000-4000-8000-0000000000c3"


def _iso(moment: datetime) -> str:
    return moment.isoformat()


def _zone(zone_id: str, name: str, *, region: str = "seoul", cluster: str = "jongno") -> dict:
    return {
        "zone_id": zone_id, "region": region, "name": name, "provider": "seoul_citydata",
        "cluster": cluster, "centroid_lat": 37.57, "centroid_lng": 126.98, "radius_m": 400,
    }


def _snap(zone_id: str, *, minutes_ago: int, level: float | None, label: str | None, **extra) -> dict:
    observed = NOW - timedelta(minutes=minutes_ago)
    row = {
        "zone_id": zone_id, "source": "seoul_citydata", "bucket_at": _iso(observed),
        "observed_at": _iso(observed), "fetched_at": _iso(observed + timedelta(minutes=2)),
        "population_min": 1000, "population_max": 2000, "level": level, "level_label": label,
        "level_scale": "seoul_congest_4",
        "forecast": [
            {"target_at": _iso(observed + timedelta(minutes=60)), "level": 0.875, "level_label": "붐빔"},
            {"target_at": _iso(observed + timedelta(minutes=30)), "level": 0.625, "level_label": "약간 붐빔"},
        ],
        "quality": {},
    }
    row.update(extra)
    return row


class ZoneDB(RecordingDB):
    def __init__(self, tables, *, baseline=None, rpc_error: Exception | None = None, **kw):
        super().__init__(tables, **kw)
        self.baseline = baseline or []
        self.rpc_error = rpc_error
        self.rpc_calls: list[tuple[str, dict]] = []

    def rpc(self, name, params):
        self.rpc_calls.append((name, params))

        def _execute():
            if self.rpc_error is not None:
                raise self.rpc_error
            return SimpleNamespace(data=list(self.baseline))

        return SimpleNamespace(execute=_execute)


def _db(**kw) -> ZoneDB:
    return ZoneDB(
        {
            "zones": [
                _zone("seoul:POI078", "인사동"),
                _zone("seoul:POI012", "창덕궁·종묘"),
                _zone("seoul:POI007", "홍대 관광특구", cluster="hongdae"),
                _zone("gyeongju:G1", "황리단길", region="gyeongju"),
            ],
            "facility_zones": [
                {"facility_id": F1, "zone_id": "seoul:POI078", "weight": 0.5},
                {"facility_id": F1, "zone_id": "seoul:POI012", "weight": 0.5},
                {"facility_id": F2, "zone_id": "seoul:POI007", "weight": 1},
                {"facility_id": F3, "zone_id": "gyeongju:G1", "weight": 1},
            ],
            "zone_crowd_snapshots": [
                _snap("seoul:POI078", minutes_ago=10, level=0.375, label="보통"),
                _snap("seoul:POI078", minutes_ago=40, level=0.875, label="붐빔"),
                _snap("seoul:POI012", minutes_ago=5, level=0.625, label="약간 붐빔"),
                # 홍대: 최신은 대체값, 그다음은 상대 눈금, 그다음이 유효
                _snap("seoul:POI007", minutes_ago=2, level=0.875, label="붐빔", quality={"replaced": True}),
                _snap("seoul:POI007", minutes_ago=4, level=0.9, label=None, level_scale="telecom_relative"),
                _snap("seoul:POI007", minutes_ago=6, level=0.125, label="여유"),
                _snap("gyeongju:G1", minutes_ago=1, level=0.875, label="붐빔"),
            ],
        },
        **kw,
    )


@pytest.fixture
def use_db(monkeypatch):
    # '평소' 기준선 갱신(원래 백그라운드 스레드)을 그 자리에서 돌린다 — 첫 호출에 usual_comparison 이 결정적으로 붙는다.
    # 백그라운드 동작 자체는 test_zone_baseline_cache.py 가 본다.
    monkeypatch.setattr(ze, "_start_background", lambda fn: fn())

    def _use(db):
        monkeypatch.setattr(ze, "supabase_admin", db)
        ze.reset_cache()
        return db

    return _use


def _load(ids, region="seoul", **kw):
    return asyncio.run(ze.load_zone_readings(ids, region=region, wall_now=NOW, **kw))


# ── 경주 불변 ──────────────────────────────────────────────────────────────────


class _Explode:
    def table(self, *_a, **_k):
        raise AssertionError("gyeongju must not touch zone tables")

    def rpc(self, *_a, **_k):
        raise AssertionError("gyeongju must not call rpc")


def test_gyeongju_returns_empty_with_zero_client_calls(monkeypatch):
    monkeypatch.setattr(ze, "supabase_admin", _Explode())
    assert _load([F1, F3], region="gyeongju") == {}
    assert asyncio.run(ze.load_zone_states("gyeongju")) == []
    assert asyncio.run(ze.load_facility_zone_ids([F1], region="gyeongju")) == {}


# ── 읽기·필터 ──────────────────────────────────────────────────────────────────


def test_readings_keep_every_mapped_zone_and_filter_to_the_region(use_db):
    db = use_db(_db())
    readings = _load([F1, F2, F3])
    assert set(readings) == {F1, F2}  # F3 은 경주 구역에만 매핑 — 서울 요청에서 빠진다
    assert sorted(r.zone_id for r in readings[F1]) == ["seoul:POI012", "seoul:POI078"]
    by_zone = {r.zone_id: r for r in readings[F1]}
    # 인사동의 최신 유효 관측(10분 전 '보통'), 40분 전 '붐빔' 이 아니다
    assert by_zone["seoul:POI078"].level == 0.375
    assert by_zone["seoul:POI078"].level_band == "normal"
    assert by_zone["seoul:POI078"].weight == 0.5
    # 홍대: 대체값·상대 눈금은 버리고 6분 전 '여유'
    (hongdae,) = readings[F2]
    assert hongdae.level == 0.125 and hongdae.level_band == "relaxed"
    # 구역 표는 지역으로, 매핑은 그 지역 구역으로 걸러 읽었다
    zone_reads = [q for q in db.queries if q.table == "zones"]
    assert zone_reads and all(("region", "eq", "seoul") in q.filters for q in zone_reads)
    mapping_reads = [q for q in db.queries if q.table == "facility_zones"]
    assert mapping_reads
    for query in mapping_reads:
        zone_filter = [v for c, op, v in query.filters if c == "zone_id" and op == "in"]
        assert zone_filter and "gyeongju:G1" not in zone_filter[0]


def test_forecast_points_are_sorted_with_bands(use_db):
    use_db(_db())
    reading = next(r for r in _load([F1])[F1] if r.zone_id == "seoul:POI078")
    targets = [point[0] for point in reading.forecast]
    assert targets == sorted(targets)
    assert [point[2] for point in reading.forecast] == ["slightly_busy", "busy"]


def test_snapshots_older_than_two_hours_are_not_read(use_db):
    db = _db()
    db.tables["zone_crowd_snapshots"] = [_snap("seoul:POI078", minutes_ago=180, level=0.875, label="붐빔")]
    use_db(db)
    assert _load([F1]) == {}


def test_missing_table_returns_empty(use_db):
    class _Missing(Exception):
        code = "PGRST205"
        message = "Could not find the table 'public.facility_zones'"

    class _DB(ZoneDB):
        def table(self, name):
            if name == "facility_zones":
                raise _Missing()
            return super().table(name)

    use_db(_DB(_db().tables))
    assert _load([F1]) == {}


def test_timeout_returns_empty(use_db, monkeypatch):
    def _slow(*_args, **_kwargs):
        time.sleep(0.3)
        return {}

    use_db(_db())
    monkeypatch.setattr(ze, "_readings_sync", _slow)
    assert _load([F1], timeout=0.05) == {}


def test_usual_comparison_from_baseline_and_missing_rpc_is_none(use_db):
    baseline = [{"zone_id": "seoul:POI078", "samples": 20, "p25": 100.0, "p50": 300.0, "p75": 500.0}]
    use_db(_db(baseline=baseline))
    by_zone = {r.zone_id: r for r in _load([F1])[F1]}
    assert by_zone["seoul:POI078"].usual_comparison == "busier"  # 중앙값 1500 > p75
    assert by_zone["seoul:POI012"].usual_comparison is None      # 기준선 없음

    use_db(_db(rpc_error=RuntimeError("function does not exist")))
    assert all(r.usual_comparison is None for r in _load([F1])[F1])


def test_results_are_cached_for_sixty_seconds(use_db):
    db = use_db(_db())
    _load([F1])
    first = len(db.queries)
    asyncio.run(ze.load_zone_readings([F1], region="seoul", wall_now=NOW + timedelta(seconds=30)))
    assert len(db.queries) == first
    asyncio.run(ze.load_zone_readings([F1], region="seoul", wall_now=NOW + timedelta(seconds=90)))
    assert len(db.queries) > first


# ── 순수 함수 ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "label, band",
    [("여유", "relaxed"), ("보통", "normal"), ("약간 붐빔", "slightly_busy"), ("약간  붐빔", "slightly_busy"),
     ("붐빔", "busy"), ("모름", None), (None, None)],
)
def test_band_mapping(label, band):
    assert ze.band_for_label(label) == band


@pytest.mark.parametrize(
    "level, band", [(0.125, "relaxed"), (0.375, "normal"), (0.625, "slightly_busy"), (0.875, "busy"), (None, None)]
)
def test_band_from_level_when_label_missing(level, band):
    assert ze.level_band(None, level, "seoul_congest_4") == band
    assert ze.level_band(None, level, "telecom_relative") is None


def test_zone_reading_is_current_window():
    assert ze.zone_reading_is_current(NOW - timedelta(minutes=30), wall_now=NOW)
    assert not ze.zone_reading_is_current(NOW - timedelta(minutes=31), wall_now=NOW)
    assert not ze.zone_reading_is_current(NOW + timedelta(minutes=1), wall_now=NOW)
    assert not ze.zone_reading_is_current(None, wall_now=NOW)


def _reading(zone_id, level, minutes_ago, band="normal"):
    return ze.ZoneReading(
        zone_id=zone_id, zone_name=zone_id, cluster="jongno", provider="seoul_citydata", level=level,
        level_band=band, level_scale="seoul_congest_4", observed_at=NOW - timedelta(minutes=minutes_ago),
        fetched_at=None, population_min=None, population_max=None, forecast=(), usual_comparison=None,
    )


def test_evidence_dict_uses_the_max_observed_zone():
    readings = (_reading("a", 0.375, 10), _reading("b", 0.625, 5, "slightly_busy"), _reading("c", 0.875, 50, "busy"))
    evidence = ze.zone_evidence_dict(readings, wall_now=NOW)
    assert evidence["source"] == "measured"
    assert evidence["evidence_tier"] == ze.ZONE_EVIDENCE_TIER
    # 'c' 는 지금이 아니지만, 관측된 구역 전부의 최댓값을 쓴다(지금 구역만 고르면 '덜 붐빔' 쪽으로 말하게 된다).
    assert evidence["level"] == 0.875
    assert evidence["zone_id"] == "c"
    # 'c'(50분 전 '붐빔')가 30분을 넘겼으므로 시설의 '지금' 은 아니다.
    assert evidence["is_current"] is False and evidence["is_stale"] is False
    assert evidence["current_count"] is None and evidence["estimate"] is None
    assert evidence["log_source"] == "seoul_citydata"
    assert [z["id"] for z in evidence["zones"]] == ["a", "b", "c"]


def test_evidence_dict_falls_back_to_latest_when_nothing_is_current():
    readings = (_reading("a", 0.375, 40), _reading("b", 0.125, 45))
    evidence = ze.zone_evidence_dict(readings, wall_now=NOW)
    assert evidence["level"] == 0.375
    assert evidence["is_current"] is False


def test_constants_contract():
    assert ze.ZONE_NOW_WINDOW == timedelta(minutes=30)
    assert ze.ZONE_FORECAST_MAX_ISSUE_AGE == timedelta(minutes=90)
    assert ze.ZONE_FORECAST_MATCH_WINDOW == timedelta(minutes=30)
    assert ze.ABSOLUTE_LEVEL_SCALES == frozenset({"seoul_congest_4"})
    assert ze.TOP_BAND == {"seoul_congest_4": "busy"}


# ── 매핑된 구역 일부에 관측이 없을 때 — 관측된 조용한 구역 하나로 순위를 매기지 않는다 ───────────────────


def test_a_mapped_zone_without_a_reading_blocks_the_arrival_claim(use_db):
    from app.services.congestion_evidence import evidence_is_current, zone_arrival_level
    from app.services.spot.score import _zone_breakdown

    db = _db()
    # 인사동(POI078) 공급이 끊겼다 — 창덕궁·종묘(POI012)만 '지금' 관측이 있다.
    db.tables["zone_crowd_snapshots"] = [
        row for row in db.tables["zone_crowd_snapshots"] if row["zone_id"] != "seoul:POI078"
    ]
    db.tables["zone_crowd_snapshots"].append(_snap("seoul:POI012", minutes_ago=1, level=0.125, label="여유"))
    use_db(db)
    (only,) = _load([F1])[F1]
    assert only.zone_id == "seoul:POI012" and only.mapped_zone_count == 2

    evidence = ze.zone_evidence_dict((only,), wall_now=NOW)
    assert evidence["mapped_zone_count"] == 2 and len(evidence["zones"]) == 1
    # 예전: 관측된 한 구역의 최댓값(0.125 '여유')으로 순위를 매겼다. 이제는 말하지 않는다.
    assert zone_arrival_level(evidence, NOW + timedelta(minutes=5), wall_now=NOW) is None
    assert evidence_is_current(evidence, now=NOW) is False
    breakdown = _zone_breakdown(evidence, None)
    assert breakdown["zone_partial"] is True and breakdown["zone_is_current"] is False


def test_fully_observed_multi_zone_facility_still_ranks(use_db):
    from app.services.congestion_evidence import zone_arrival_level

    use_db(_db())
    readings = _load([F1])[F1]
    assert {r.mapped_zone_count for r in readings} == {2}
    evidence = ze.zone_evidence_dict(readings, wall_now=NOW)
    assert evidence["mapped_zone_count"] == 2
    arrival = zone_arrival_level(evidence, NOW + timedelta(minutes=5), wall_now=NOW)
    assert arrival is not None and arrival.zone_id == "seoul:POI012"  # 0.625 > 0.375 — 최댓값


# ── 매핑된 구역 하나가 2시간 안이지만 '지금'(30분)이 아닐 때 — 시설의 '지금' 을 말하지 않는다 ───────────


def test_a_mapped_zone_older_than_now_window_blocks_the_now_claim():
    """A 는 5분 전 '여유', B 는 50분 전 '붐빔'(2시간 조회 범위 안). 조용한 A 하나로 시설을 '지금 여유' 라 하지 않는다.

    B 에 행이 아예 없으면(부분 매핑) 이미 '지금' 이 아니다 — 50분 전 행이 있다고 더 강하게 말하면 규칙이 어긋난다.
    """
    from app.services.congestion_evidence import evidence_is_current, zone_arrival_level
    from app.services.spot.score import _zone_breakdown

    readings = tuple(
        replace(r, mapped_zone_count=2)
        for r in (_reading("a", 0.125, 5, band="relaxed"), _reading("b", 0.875, 50, band="busy"))
    )
    evidence = ze.zone_evidence_dict(readings, wall_now=NOW)
    assert evidence["is_current"] is False
    assert evidence_is_current(evidence, now=NOW) is False
    arrival = zone_arrival_level(evidence, NOW + timedelta(minutes=8), wall_now=NOW)
    assert arrival is None  # 순위는 이미 안전했다(B 가 도착 시각을 말하지 못한다)
    breakdown = _zone_breakdown({**evidence, "is_current": False}, arrival)
    assert breakdown["zone_is_current"] is False
    assert ze.facility_zones_current(readings, wall_now=NOW) is False


def test_every_mapped_zone_current_still_says_now():
    from app.services.congestion_evidence import evidence_is_current
    from app.services.spot.score import _zone_breakdown

    readings = tuple(
        replace(r, mapped_zone_count=2)
        for r in (_reading("a", 0.125, 5, band="relaxed"), _reading("b", 0.875, 20, band="busy"))
    )
    evidence = ze.zone_evidence_dict(readings, wall_now=NOW)
    assert evidence["is_current"] is True
    assert evidence_is_current(evidence, now=NOW) is True
    assert _zone_breakdown(evidence, None)["zone_is_current"] is True
    assert ze.facility_zones_current(readings, wall_now=NOW) is True


# ── 시설이 '지금' 이 아닐 때 근거의 단계 — 조용한 '지금' 구역 하나로 시설 단계를 말하지 않는다(카드 칩) ──────────


def test_stale_busy_zone_is_not_hidden_behind_a_fresh_quiet_zone():
    """A 5분 전 '여유', B 50분 전 '붐빔'. 시설은 '지금' 이 아니고, 근거 단계는 A 의 0.125 가 아니라 B 의 0.875 다.

    예전에는 '지금' 구역(A)만 골라 level=0.125 · timestamp=A 를 보냈고, 카드가 그대로 실선 칩 '혼잡도: 한산' 을 그렸다.
    """
    readings = tuple(
        replace(r, mapped_zone_count=2)
        for r in (_reading("a", 0.125, 5, band="relaxed"), _reading("b", 0.875, 50, band="busy"))
    )
    evidence = ze.zone_evidence_dict(readings, wall_now=NOW)
    assert evidence["is_current"] is False
    assert evidence["level"] == 0.875
    assert evidence["zone_id"] == "b"
    assert evidence["timestamp"] == (NOW - timedelta(minutes=50)).isoformat()
    # 내부 지도 핀도 같은 구역을 고른다.
    assert ze.choose_zone_reading(readings, wall_now=NOW).zone_id == "b"


def test_partial_facility_reports_no_level():
    """B 에 쓸 행이 없다(공급 끊김·대체값·2시간 초과). 관측된 A('여유') 하나로 시설 단계를 말하지 않는다 — level None."""
    readings = (replace(_reading("a", 0.125, 5, band="relaxed"), mapped_zone_count=2),)
    evidence = ze.zone_evidence_dict(readings, wall_now=NOW)
    assert evidence["is_current"] is False
    assert evidence["level"] is None
    # 관측 시각은 남는다 — 화면은 단계 없이 '마지막 관측 HH:MM' 만 그린다.
    assert evidence["timestamp"] == (NOW - timedelta(minutes=5)).isoformat()
    assert evidence["source"] == "measured" and evidence["evidence_tier"] == ze.ZONE_EVIDENCE_TIER
    assert evidence["mapped_zone_count"] == 2 and len(evidence["zones"]) == 1


def test_fully_current_facility_keeps_the_max_level():
    readings = tuple(
        replace(r, mapped_zone_count=2)
        for r in (_reading("a", 0.125, 5, band="relaxed"), _reading("b", 0.625, 20, band="slightly_busy"))
    )
    evidence = ze.zone_evidence_dict(readings, wall_now=NOW)
    assert evidence["is_current"] is True
    assert evidence["level"] == 0.625 and evidence["zone_id"] == "b"
