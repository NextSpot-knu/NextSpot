"""배치 스크립트는 기본으로 경주 시설만 읽고 쓴다(SEOUL_TESTBED_PLAN S3 · ingest_mapping_design §5).

서울 시설은 개발자 전용이다. 번역·음식 태깅·좌표 교정은 ``--region`` 으로 서울을 **명시**할 때만 서울을 보고,
학습·품질·관광 수요 평가·심사 계정 시드·Kakao/LOCALDATA/경주 음식점 보강은 경주로 고정이다.
각 테스트는 시설 읽기(·쓰기) 쿼리에 ``region = gyeongju`` 가 걸렸는지, 그리고 서울 행이 결과에 없는지 본다.
"""

from __future__ import annotations

import asyncio
import sys
from types import SimpleNamespace

import pytest

from app.core import supabase as supabase_core
from app.core.region import PUBLIC_REGION, REGION_HEADER

GJ = {"id": "g-1", "name": "경주 가게", "type": "restaurant", "region": "gyeongju", "is_active": True,
      "latitude": 35.83, "longitude": 129.21, "features": {}, "overview": "소개", "contentid": "1",
      "address": "경주", "capacity": 30}
SEOUL = {**GJ, "id": "s-1", "name": "서울 가게", "region": "seoul", "latitude": 37.57, "longitude": 126.98,
         "contentid": "2", "address": "서울"}


class RecQuery:
    def __init__(self, db, table):
        self.db, self.table, self.filters, self.op, self.payload = db, table, [], "select", None
        self._negate, self._range = False, None

    def select(self, *_a, **_k):
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    @property
    def not_(self):
        self._negate = True
        return self

    def _f(self, op, column, value):
        self.filters.append((("not_" if self._negate else "") + op, column, value))
        self._negate = False
        return self

    def eq(self, c, v):
        return self._f("eq", c, v)

    def in_(self, c, v):
        return self._f("in", c, list(v))

    def is_(self, c, v):
        return self._f("is", c, v)

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a):
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def execute(self):
        self.db.queries.append(self)
        rows = []
        for row in self.db.tables.get(self.table, []):
            ok = True
            for op, column, value in self.filters:
                cell = row.get(column)
                hit = {"eq": cell == value, "in": cell in (value if isinstance(value, list) else []),
                       "is": (cell is None) if value == "null" else cell == value}[op.removeprefix("not_")]
                ok &= hit != op.startswith("not_")
            if ok:
                rows.append(dict(row))
        if self.op == "update":
            return SimpleNamespace(data=rows)
        if self._range is not None:
            rows = rows[self._range[0]: self._range[1] + 1]
        return SimpleNamespace(data=rows)


class RecDB:
    def __init__(self, tables=None):
        self.tables = tables if tables is not None else {"facilities": [GJ, SEOUL]}
        self.queries: list[RecQuery] = []

    def table(self, name):
        return RecQuery(self, name)

    def facility_queries(self, op=None):
        return [q for q in self.queries if q.table == "facilities" and (op is None or q.op == op)]


def _region_filters(query) -> list:
    return [value for op, column, value in query.filters if op == "eq" and column == "region"]


def _assert_gyeongju(db: RecDB, op: str | None = None) -> None:
    queries = db.facility_queries(op)
    assert queries, "시설 쿼리가 없다"
    for query in queries:
        assert _region_filters(query) == [PUBLIC_REGION], query.filters


@pytest.fixture
def db(monkeypatch):
    rec = RecDB()
    monkeypatch.setattr(supabase_core, "supabase_admin", rec)
    return rec


# ── --region 이 있는 스크립트(기본 경주) ──────────────────────────────────────

def test_translate_overviews_defaults_to_gyeongju(db):
    import scripts.translate_overviews as mod

    rows = mod.fetch_candidate_rows()
    assert [r["id"] for r in rows] == ["g-1"]
    _assert_gyeongju(db)
    assert [r["id"] for r in mod.fetch_candidate_rows(region="seoul")] == ["s-1"]


def test_translate_overviews_cli_region_default(monkeypatch):
    import scripts.translate_overviews as mod

    captured = {}

    async def fake_run(args):
        captured["region"] = args.region
        return 0

    monkeypatch.setattr(mod, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["translate_overviews.py", "--dry-run"])
    with pytest.raises(SystemExit):
        mod.main()
    assert captured["region"] == PUBLIC_REGION


def test_tag_cuisines_defaults_to_gyeongju(db):
    import scripts.tag_cuisines as mod

    assert [r["id"] for r in mod.fetch_candidate_rows()] == ["g-1"]
    _assert_gyeongju(db)
    mod.apply_update("g-1", {"x": 1})
    _assert_gyeongju(db, "update")


def test_tag_cuisines_run_passes_region_to_reads_and_writes(monkeypatch):
    import scripts.tag_cuisines as mod

    seen = {}
    monkeypatch.setattr(mod, "fetch_candidate_rows", lambda **kw: seen.setdefault("read", kw) and [])
    args = SimpleNamespace(apply=False, limit=0, report="unused.json")
    monkeypatch.setattr(mod, "write_report", lambda *_a, **_k: None)
    asyncio.run(mod.run(args))
    assert seen["read"] == {"region": PUBLIC_REGION}


def test_reconcile_kakao_coordinates_defaults_to_gyeongju(monkeypatch):
    import scripts.reconcile_kakao_coordinates as mod

    rec = RecDB()
    monkeypatch.setattr(mod, "supabase_admin", rec)
    assert [r["id"] for r in mod.load_rows()] == ["g-1"]
    mod.update_coordinates("g-1", {"latitude": 35.8})
    _assert_gyeongju(rec)
    monkeypatch.setattr(sys, "argv", ["reconcile_kakao_coordinates.py"])
    assert mod.parse_args().region == PUBLIC_REGION


# ── 경주 고정 스크립트 ───────────────────────────────────────────────────────

def test_train_reads_only_gyeongju_facilities():
    import scripts.train as mod

    rec = RecDB()
    rows = mod._load_facilities(rec)
    assert [r["id"] for r in rows] == ["g-1"]
    _assert_gyeongju(rec)


def test_train_falls_back_when_region_column_is_missing():
    import scripts.train as mod

    class Missing(Exception):
        code = "42703"
        message = "column facilities.region does not exist"

    class NoRegion(RecDB):
        def table(self, name):
            query = super().table(name)
            original = query.eq

            def eq(column, value):
                if column == "region":
                    raise Missing(Missing.message)
                return original(column, value)

            query.eq = eq
            return query

    rec = NoRegion({"facilities": [GJ]})
    assert [r["id"] for r in mod._load_facilities(rec)] == ["g-1"]


def test_recommendation_quality_never_sends_a_region_header():
    import scripts.recommendation_quality as mod

    assert mod.QUALITY_REGION == PUBLIC_REGION
    headers = mod.live_headers("token")
    assert REGION_HEADER not in headers and "x-nextspot-region" not in {k.lower() for k in headers}


def test_evaluate_tourism_demand_pins_region(monkeypatch):
    import scripts.evaluate_tourism_demand as mod

    seen = {}

    async def fake_fetch(_client, _select, **kwargs):
        seen.update(kwargs)
        return []

    monkeypatch.setattr(mod, "fetch_active_facilities", fake_fetch)
    monkeypatch.setattr(mod, "supabase_admin", RecDB({"tourism_concentration_forecasts": []}))
    monkeypatch.setattr(mod, "attach_and_measure_tourism_coverage", lambda *_a: {})
    monkeypatch.setattr(mod, "evaluate_tourism_demand_impact", lambda *_a: {})
    asyncio.run(mod.build_report("2026-10-31"))
    assert seen["region"] == PUBLIC_REGION


def test_seed_judge_accounts_only_grants_gyeongju_facilities(monkeypatch, capsys):
    import scripts.seed_judge_accounts as mod

    rec = RecDB({"facility_owners": [], "facilities": [GJ, SEOUL], "role_audit_log": []})
    inserted = []
    original_table = rec.table

    def table(name):
        query = original_table(name)
        query.insert = lambda payload: inserted.append((name, payload)) or query
        return query

    rec.table = table
    monkeypatch.setattr(mod, "supabase_admin", rec)
    mod._ensure_ownership("u-1", ["s-1", "g-1"])
    granted = [p["facility_id"] for name, p in inserted if name == "facility_owners"]
    assert granted == ["g-1"]
    _assert_gyeongju(rec, "select")


def test_ingest_kakao_places_matches_only_gyeongju_rows(monkeypatch):
    import scripts.ingest_kakao_places as mod

    rec = RecDB()
    monkeypatch.setattr(mod, "supabase_admin", rec)
    rows, supports = mod.load_existing_facilities("id,name")
    assert [r["id"] for r in rows] == ["g-1"] and supports is True
    _assert_gyeongju(rec)


def test_ingest_localdata_matches_only_gyeongju_rows(db):
    import scripts.ingest_localdata as mod

    facilities, _refs = mod.load_db_context()
    assert [r["id"] for r in facilities] == ["g-1"]
    _assert_gyeongju(db)


def test_ingest_gyeongju_restaurants_reads_and_updates_only_gyeongju(monkeypatch):
    import scripts.ingest_gyeongju_restaurants as mod

    rec = RecDB()
    monkeypatch.setattr(supabase_core, "supabase_admin", rec)
    monkeypatch.setattr(mod.settings, "GYEONGJU_FOOD_API_BASE_URL", "https://example.com")
    monkeypatch.setattr(mod.settings, "GYEONGJU_FOOD_API_KEY", "k")

    async def fake_restaurants(**_kwargs):
        return [{"name": "경주 가게"}]

    monkeypatch.setattr(mod, "get_gyeongju_restaurants", fake_restaurants)
    monkeypatch.setattr(mod, "build_actions", lambda _r, facilities, *_a, **_k: (
        [{"id": f["id"], "features": {}} for f in facilities], [{"status": "matched"} for _ in facilities]))
    asyncio.run(mod.run(apply=True))
    _assert_gyeongju(rec, "select")
    _assert_gyeongju(rec, "update")
    assert [q for q in rec.facility_queries("update")]
