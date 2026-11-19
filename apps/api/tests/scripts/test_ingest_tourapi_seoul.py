"""서울 TourAPI 적재(scripts/ingest_tourapi_seoul.py) — 격리 확인 뒤에만 쓰고, 새면 되돌린다(S3 §1).

실DB·실네트워크 없음: Supabase 는 인메모리 `FakeDB`(쓰기 순서를 기록), HTTP(PostgREST·Auth·API·/health)는
httpx.MockTransport, TourAPI 목록·상세·showflag 는 모듈 이름을 바꿔 끼운다.
"""

from __future__ import annotations

import copy
import json
import re
import uuid
from types import SimpleNamespace

import httpx
import pytest

import scripts.ingest_tourapi_seoul as seoul
from app.core import supabase as supabase_core
from app.services.crowd.seoul_provider import SEOUL_ZONES
from app.services.tourapi.client import TourAPITransientError

SUPABASE = "https://probe.supabase.test"
HEALTH = "https://api.test/health"
API = "https://api.test"
TOURIST_ID = "tttttttt-0000-4000-8000-00000000tou1"
INSADONG = next(z for z in SEOUL_ZONES if z.provider_zone_code == "POI078")


# ── 인메모리 Supabase ──────────────────────────────────────────────────────────

class MissingColumn(Exception):
    def __init__(self, column: str = "region") -> None:
        self.code = "42703"
        self.message = f"column facilities.{column} does not exist"
        super().__init__(self.message)


def _cell(row: dict, column: str):
    value = row
    for part in column.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


class FakeQuery:
    def __init__(self, db: "FakeDB", table: str) -> None:
        self.db, self.table = db, table
        self.op, self.payload, self.columns = "select", None, "*"
        self.filters: list[tuple[str, str, object, bool]] = []
        self.on_conflict = None
        self._negate = False
        self._range = None
        self._limit = None
        self._orders: list[tuple[str, bool]] = []

    # 모양
    def select(self, columns="*", **_kw):
        self.columns = columns
        return self

    def insert(self, payload):
        self.op, self.payload = "insert", payload
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def upsert(self, payload, on_conflict=None, **_kw):
        self.op, self.payload, self.on_conflict = "upsert", payload, on_conflict
        return self

    def delete(self):
        self.op = "delete"
        return self

    @property
    def not_(self):
        self._negate = True
        return self

    def _f(self, op, column, value):
        if self.table == "facilities" and column == "region" and self.db.region_missing:
            raise MissingColumn()
        self.filters.append((column, op, value, self._negate))
        self._negate = False
        return self

    def eq(self, c, v):
        return self._f("eq", c, v)

    def neq(self, c, v):
        return self._f("neq", c, v)

    def in_(self, c, v):
        return self._f("in", c, list(v))

    def is_(self, c, v):
        return self._f("is", c, v)

    def gt(self, c, v):
        return self._f("gt", c, v)

    def gte(self, c, v):
        return self._f("gte", c, v)

    def lt(self, c, v):
        return self._f("lt", c, v)

    def lte(self, c, v):
        return self._f("lte", c, v)

    def order(self, column, desc=False, **_kw):
        self._orders.append((column, desc))
        return self

    def limit(self, n):
        self._limit = n
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def _match(self, row: dict) -> bool:
        for column, op, value, negate in self.filters:
            cell = _cell(row, column)
            if column.rsplit(".", 1)[-1] == "region" and cell is None:
                cell = "gyeongju"  # 컬럼 기본값(임베드 칸 포함) — 픽스처 행에 region 이 없으면 경주
            ok = {
                "eq": lambda: cell == value,
                "neq": lambda: cell is not None and cell != value,
                "in": lambda: cell in value,
                "is": lambda: (cell is None) if value == "null" else cell == value,
                "gt": lambda: cell is not None and str(cell) > str(value),
                "gte": lambda: cell is not None and str(cell) >= str(value),
                "lt": lambda: cell is not None and str(cell) < str(value),
                "lte": lambda: cell is not None and str(cell) <= str(value),
            }[op]()
            if ok == negate:
                return False
        return True

    def _project(self, row: dict) -> dict:
        if self.columns.strip() == "*" or "(" in self.columns:
            return copy.deepcopy(row)
        return {c.strip(): copy.deepcopy(row.get(c.strip())) for c in self.columns.split(",") if c.strip() in row}

    def execute(self):
        db = self.db
        key = (self.table, self.op)
        if key in db.fail:
            raise db.fail[key]
        rows = db.tables.setdefault(self.table, [])
        db.journal.append((self.op, self.table, list(self.filters), copy.deepcopy(self.payload)))
        if self.op == "insert":
            items = self.payload if isinstance(self.payload, list) else [self.payload]
            out = []
            for item in items:
                row = {"id": str(uuid.uuid4()), **copy.deepcopy(item)}
                rows.append(row)
                out.append(copy.deepcopy(row))
            return SimpleNamespace(data=out)
        if self.op == "upsert":
            items = self.payload if isinstance(self.payload, list) else [self.payload]
            keys = [k.strip() for k in (self.on_conflict or "id").split(",")]
            out = []
            for item in items:
                hit = next((r for r in rows if all(r.get(k) == item.get(k) for k in keys)), None)
                if hit is None:
                    hit = {"id": str(uuid.uuid4())}
                    rows.append(hit)
                hit.update(copy.deepcopy(item))
                out.append(copy.deepcopy(hit))
            return SimpleNamespace(data=out)
        hits = [r for r in rows if self._match(r)]
        if self.op == "update":
            for row in hits:
                row.update(copy.deepcopy(self.payload))
            return SimpleNamespace(data=[copy.deepcopy(r) for r in hits])
        if self.op == "delete":
            db.tables[self.table] = [r for r in rows if r not in hits]
            return SimpleNamespace(data=[copy.deepcopy(r) for r in hits])
        for column, desc in reversed(self._orders):
            hits.sort(key=lambda r, c=column: str(_cell(r, c) or ""), reverse=desc)
        if self._range is not None:
            hits = hits[self._range[0]: self._range[1] + 1]
        if self._limit is not None:
            hits = hits[: self._limit]
        return SimpleNamespace(data=[self._project(r) for r in hits])


class FakeDB:
    def __init__(self, tables: dict | None = None, *, isolation: object = 1, region_missing: bool = False):
        self.tables = {k: [dict(r) for r in v] for k, v in (tables or {}).items()}
        self.journal: list[tuple] = []
        self.fail: dict[tuple[str, str], Exception] = {}
        self.isolation = isolation
        self.region_missing = region_missing

    def table(self, name: str) -> FakeQuery:
        return FakeQuery(self, name)

    def rpc(self, name, _params=None):
        if name != "region_isolation_status" or isinstance(self.isolation, Exception):
            exc = self.isolation if isinstance(self.isolation, Exception) else RuntimeError(name)
            return SimpleNamespace(execute=lambda: (_ for _ in ()).throw(exc))
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=self.isolation))

    def writes(self, table: str = "facilities") -> list[tuple]:
        return [entry for entry in self.journal if entry[1] == table and entry[0] != "select"]


# ── HTTP(PostgREST · Auth · /health · 공개 API) ────────────────────────────────

class Web:
    """시나리오별 응답. 기본은 모두 정상(격리됨)."""

    def __init__(self, **overrides):
        self.health = {"status": "ok", "capabilities": {"region_isolation": 1}}
        self.health_status = 200
        self.anon_rows: list = []
        self.tourist_rows: list = []
        self.anon_rows_after_write: list | None = None
        self.api_payload = None  # callable(path, headers, db) → JSON
        self.login_ok = True
        self.requests: list[httpx.Request] = []
        self.wrote = False
        self.__dict__.update(overrides)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        if url.startswith(HEALTH):
            return httpx.Response(self.health_status, json=self.health)
        if url.startswith(f"{SUPABASE}/auth/v1/token"):
            if not self.login_ok:
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(200, json={"access_token": "tourist-jwt", "user": {"id": TOURIST_ID}})
        if url.startswith(f"{SUPABASE}/rest/v1/facilities"):
            tourist = request.headers.get("authorization") == "Bearer tourist-jwt"
            rows = self.tourist_rows if tourist else self.anon_rows
            if not tourist and self.wrote and self.anon_rows_after_write is not None:
                rows = self.anon_rows_after_write
            return httpx.Response(200, json=rows)
        if url.startswith(API):
            path = request.url.path
            body = self.api_payload(path, request.headers) if self.api_payload else []
            return httpx.Response(200, json=body)
        return httpx.Response(404, json={})


def _cfg(**overrides) -> seoul.Config:
    values = dict(supabase_url=SUPABASE, anon_key="anon-key", health_url=HEALTH,
                  probe_email="probe@example.com", probe_password="pw")
    values.update(overrides)
    return seoul.Config(**values)


def _args(**overrides):
    values = dict(apply=True, details_budget=400, max_per_zone_type=0, clusters="all", reactivate=False, sync=True)
    values.update(overrides)
    return SimpleNamespace(**values)


# ── TourAPI 대역 ──────────────────────────────────────────────────────────────

def _payload(items: list[dict]) -> dict:
    return {"response": {"header": {"resultCode": "0000"},
                         "body": {"items": {"item": items} if items else "", "totalCount": len(items)}}}


def _item(cid: str, lat: float, lng: float, ctid: int = 39, *, image: str = "https://img/x.jpg") -> dict:
    return {"contentid": cid, "contenttypeid": str(ctid), "title": f"장소{cid}", "mapy": str(lat), "mapx": str(lng),
            "addr1": "서울 종로구", "firstimage": image, "cat3": "A05020100"}


class TourAPI:
    def __init__(self, location: list[dict] | None = None, ldong: dict | None = None, *, transient: bool = False):
        self.location = location or []
        self.ldong = ldong or {}
        self.transient = transient
        self.location_calls: list[dict] = []
        self.area_calls: list[dict] = []
        self.details: list[str] = []
        self.showflag_calls: list[dict] = []

    async def location_based_list(self, **kw):
        self.location_calls.append(kw)
        if self.transient:
            raise TourAPITransientError("timeout")
        ctid = kw["content_type_id"]
        return _payload([i for i in self.location if int(i["contenttypeid"]) == ctid] if kw["page"] == 1 else [])

    async def area_based_list(self, **kw):
        self.area_calls.append(kw)
        items = self.ldong.get((kw["content_type_id"], kw["ldong_signgu_cd"]), [])
        return _payload(items if kw["page"] == 1 else [])

    async def enrich_row(self, row):
        self.details.append(row["contentid"])
        print(f"[details] detailCommon2 실패 (contentid={row['contentid']}): boom")  # 재사용 함수의 행 단위 출력
        row["overview"] = "개요"

    async def fetch_showflag_map(self, **kw):
        self.showflag_calls.append(kw)
        return {}


@pytest.fixture
def world(monkeypatch):
    """적재 한 번을 돌릴 판 — db·web·tourapi 를 바꿔 끼우고 run() 을 부르는 함수를 돌려준다."""
    state = SimpleNamespace(db=FakeDB(), web=Web(), tourapi=TourAPI(), sleeps=[])

    async def _run(args=None, cfg=None):
        db, web, api = state.db, state.web, state.tourapi
        monkeypatch.setattr(supabase_core, "supabase_admin", db)
        monkeypatch.setattr(seoul, "location_based_list", api.location_based_list)
        monkeypatch.setattr(seoul, "area_based_list", api.area_based_list)
        monkeypatch.setattr(seoul, "enrich_row", api.enrich_row)
        monkeypatch.setattr(seoul, "fetch_showflag_map", api.fetch_showflag_map)
        monkeypatch.setattr(seoul, "load_polygon_file", lambda: {})

        original_activate = seoul._set_active

        def _set_active(ctx, ids, active):
            original_activate(ctx, ids, active)
            web.wrote = True

        monkeypatch.setattr(seoul, "_set_active", _set_active)

        async def _sleep(seconds):
            state.sleeps.append(seconds)

        async with httpx.AsyncClient(transport=httpx.MockTransport(web.handler)) as http:
            ctx = seoul.Context(admin=db, http=http, cfg=cfg or _cfg(), sleep=_sleep)
            return await seoul.run(args or _args(), ctx)

    state.run = _run
    return state


def _near(zone, d_lat=0.0005, d_lng=0.0):
    return zone.centroid_lat + d_lat, zone.centroid_lng + d_lng


# =========================================================================
# 사전 점검 — 하나라도 실패하면 exit 3, 쓰기 0
# =========================================================================

def _two_items():
    lat, lng = _near(INSADONG)
    return [_item("900001", lat, lng), _item("900002", lat + 0.0003, lng, ctid=12)]


@pytest.mark.parametrize("breaker", [
    "region_column", "status_zero", "status_missing", "capability_missing", "capability_bool",
    "health_down", "anon_rows", "tourist_rows", "probe_secrets", "tourist_login", "service_role_key",
])
@pytest.mark.asyncio
async def test_each_precheck_failure_exits_3_with_zero_writes(world, breaker):
    world.tourapi = TourAPI(_two_items())
    cfg = _cfg()
    if breaker == "region_column":
        world.db = FakeDB(region_missing=True)
    elif breaker == "status_zero":
        world.db = FakeDB(isolation=0)
    elif breaker == "status_missing":
        world.db = FakeDB(isolation=RuntimeError("PGRST202"))
    elif breaker == "capability_missing":
        world.web.health = {"status": "ok"}
    elif breaker == "capability_bool":
        world.web.health = {"status": "ok", "capabilities": {"region_isolation": True}}
    elif breaker == "health_down":
        world.web.health_status = 503
    elif breaker == "anon_rows":
        world.web.anon_rows = [{"id": "x"}]
    elif breaker == "tourist_rows":
        world.web.tourist_rows = [{"id": "x"}]
    elif breaker == "probe_secrets":
        cfg = _cfg(probe_email="", probe_password="")
    elif breaker == "tourist_login":
        world.web.login_ok = False
    elif breaker == "service_role_key":
        cfg = _cfg(service_role_configured=False)

    code = await world.run(cfg=cfg)

    assert code == seoul.EXIT_PRECHECK
    assert world.db.writes() == [] and world.db.writes("app_events") == []
    assert world.tourapi.location_calls == []  # 점검 전에는 TourAPI 쿼터도 쓰지 않는다


@pytest.mark.asyncio
async def test_dry_run_without_probe_secrets_is_allowed_and_writes_nothing(world):
    world.tourapi = TourAPI(_two_items())
    code = await world.run(args=_args(apply=False), cfg=_cfg(probe_email="", probe_password=""))
    assert code == seoul.EXIT_OK
    assert world.db.writes() == [] and world.db.writes("app_events") == []
    assert world.tourapi.details == []  # 미리보기는 상세 쿼터를 쓰지 않는다


# =========================================================================
# 적재 — 대기(비활성)로 넣고, 점검을 통과하면 켠다
# =========================================================================

@pytest.mark.asyncio
async def test_new_rows_are_staged_inactive_then_activated(world):
    world.tourapi = TourAPI(_two_items())
    code = await world.run()
    assert code == seoul.EXIT_OK

    rows = [r for r in world.db.tables["facilities"] if r.get("contentid") in {"900001", "900002"}]
    assert len(rows) == 2 and all(r["region"] == "seoul" for r in rows)
    assert all(r["is_active"] is True for r in rows)
    first_write = next(entry for entry in world.db.journal if entry[1] == "facilities" and entry[0] in ("upsert", "insert"))
    assert all(item["is_active"] is False for item in first_write[3])  # 처음 쓸 때는 대기
    assert world.sleeps == [seoul.POST_WRITE_WAIT_SECONDS]
    events = [e[3]["event"] for e in world.db.writes("app_events")]
    assert seoul.EVENT in events and seoul.EVENT_DETAIL in events


@pytest.mark.asyncio
async def test_existing_gyeongju_contentid_is_skipped(world):
    gyeongju = {"id": "g-1", "contentid": "900001", "region": "gyeongju", "name": "경주 가게",
                "latitude": 35.83, "longitude": 129.21, "is_active": True, "features": {}}
    world.db = FakeDB({"facilities": [gyeongju]})
    world.tourapi = TourAPI(_two_items())
    assert await world.run() == seoul.EXIT_OK
    g_row = next(r for r in world.db.tables["facilities"] if r["id"] == "g-1")
    assert g_row == gyeongju  # 경주 행은 손대지 않았다
    assert sum(1 for r in world.db.tables["facilities"] if r.get("contentid") == "900001") == 1


@pytest.mark.asyncio
async def test_rows_outside_the_footprint_are_skipped(world):
    inside = _item("900001", *_near(INSADONG))
    far = _item("900009", INSADONG.centroid_lat + 0.05, INSADONG.centroid_lng)  # 약 5.5 km 북쪽
    world.tourapi = TourAPI([inside, far])
    assert await world.run() == seoul.EXIT_OK
    cids = {r.get("contentid") for r in world.db.tables["facilities"]}
    assert "900001" in cids and "900009" not in cids


@pytest.mark.asyncio
async def test_details_budget_counts_calls_and_prefers_new_rows(world):
    lat, lng = _near(INSADONG)
    old = {"id": "s-old", "contentid": "800001", "region": "seoul", "name": "기존", "type": "restaurant",
           "latitude": lat, "longitude": lng, "is_active": True, "features": {"tourapi_details_at": "2026-01-01"}}
    world.db = FakeDB({"facilities": [old]})
    items = [_item(f"90000{i}", lat + i * 0.0001, lng) for i in range(3)] + [_item("800001", lat, lng)]
    world.tourapi = TourAPI(items)
    assert await world.run(args=_args(details_budget=8)) == seoul.EXIT_OK  # 8콜 = 2곳
    assert len(world.tourapi.details) == 2
    assert "800001" not in world.tourapi.details  # 새 행 먼저


@pytest.mark.asyncio
async def test_legal_dong_lists_are_seoul_codes_only(world):
    world.tourapi = TourAPI(_two_items())
    assert await world.run() == seoul.EXIT_OK
    pairs = {(c["ldong_regn_cd"], c["ldong_signgu_cd"]) for c in world.tourapi.area_calls}
    assert pairs == {(11, 110), (11, 140), (11, 440)}
    assert (47, 130) not in pairs


@pytest.mark.asyncio
async def test_legal_dong_only_row_without_photo_is_skipped(world):
    lat, lng = _near(INSADONG)
    ldong = {(39, 110): [_item("910001", lat, lng, image=""), _item("910002", lat, lng + 0.0002)]}
    world.tourapi = TourAPI([], ldong)
    assert await world.run() == seoul.EXIT_OK
    cids = {r.get("contentid") for r in world.db.tables["facilities"]}
    assert "910002" in cids and "910001" not in cids


@pytest.mark.asyncio
async def test_showflag_sync_only_touches_seoul_rows(world):
    lat, lng = _near(INSADONG)
    rows = [
        {"id": "g-1", "contentid": "700001", "region": "gyeongju", "latitude": 35.8, "longitude": 129.2,
         "is_active": True, "features": {}},
        {"id": "s-1", "contentid": "700002", "region": "seoul", "name": "서울1", "type": "restaurant",
         "latitude": lat, "longitude": lng, "is_active": True, "features": {}},
    ]
    world.db = FakeDB({"facilities": rows})
    world.tourapi = TourAPI(_two_items())

    async def showflags(**kw):
        world.tourapi.showflag_calls.append(kw)
        return {"700001": "0", "700002": "0"}

    world.tourapi.fetch_showflag_map = showflags
    assert await world.run() == seoul.EXIT_OK
    by_id = {r["id"]: r for r in world.db.tables["facilities"]}
    assert by_id["g-1"]["is_active"] is True  # 경주 행은 서울 동기화가 끄지 않는다
    assert by_id["s-1"]["is_active"] is False
    legacy = {(c.get("area_code"), c.get("sigungu_code")) for c in world.tourapi.showflag_calls if c.get("area_code")}
    assert legacy == {(1, 23), (1, 24), (1, 13)}
    for _op, table, filters, _payload in world.db.writes():
        if table == "facilities" and _op == "update":
            assert ("region", "eq", "seoul", False) in filters


@pytest.mark.asyncio
async def test_reactivate_turns_on_non_hidden_seoul_rows_only(world):
    lat, lng = _near(INSADONG)
    rows = [
        {"id": "s-1", "contentid": "700002", "region": "seoul", "name": "a", "type": "cafe",
         "latitude": lat, "longitude": lng, "is_active": False, "features": {}},
        {"id": "s-2", "contentid": "700003", "region": "seoul", "name": "b", "type": "cafe",
         "latitude": lat, "longitude": lng, "is_active": False, "features": {"manual_hidden": {"by": "pm"}}},
        {"id": "g-1", "contentid": "700004", "region": "gyeongju", "latitude": 35.8, "longitude": 129.2,
         "is_active": False, "features": {}},
    ]
    world.db = FakeDB({"facilities": rows})
    world.tourapi = TourAPI([])
    assert await world.run(args=_args(reactivate=True)) == seoul.EXIT_OK
    by_id = {r["id"]: r for r in world.db.tables["facilities"]}
    assert by_id["s-1"]["is_active"] is True
    assert by_id["s-2"]["is_active"] is False
    assert by_id["g-1"]["is_active"] is False


@pytest.mark.asyncio
async def test_no_kakao_calls(world, monkeypatch):
    called = []

    async def kakao(*_a, **_k):
        called.append(1)
        return False

    monkeypatch.setattr("scripts.ingest_tourapi.reconcile_row_coordinate", kakao)
    monkeypatch.setenv("KAKAO_REST_API_KEY", "set")
    world.tourapi = TourAPI(_two_items())
    assert await world.run() == seoul.EXIT_OK
    assert called == []
    assert not any("kakao" in str(r.url) for r in world.web.requests)


@pytest.mark.asyncio
async def test_persistent_list_failure_exits_75_before_any_write(world):
    world.tourapi = TourAPI(_two_items(), transient=True)
    original = seoul.list_call_with_retry

    async def no_wait(label, call):
        return await call()

    seoul.list_call_with_retry = no_wait
    try:
        assert await world.run() == seoul.EXIT_TEMPFAIL
    finally:
        seoul.list_call_with_retry = original
    assert world.db.writes() == []


# =========================================================================
# 쓴 뒤 누수 — 끄기가 먼저, 지우기가 다음, exit 4
# =========================================================================

def _leaky(kind: str):
    def payload(path, headers):
        if kind == path:
            return [{"id": "leaked", "latitude": 37.57, "longitude": 126.98}]
        return []
    return payload


@pytest.mark.parametrize("leak", [
    "anon_postgrest", "tourist_postgrest", "/api/v1/infrastructures", "/api/v1/recommendations/by-type",
    "/api/v1/courses/plan", "/api/v1/congestion/estimates",
])
@pytest.mark.asyncio
async def test_post_write_leak_deactivates_before_delete_then_exits_4(world, leak):
    world.tourapi = TourAPI(_two_items())
    if leak == "anon_postgrest":
        world.web.anon_rows_after_write = [{"id": "x"}]
    elif leak == "tourist_postgrest":
        original_handler = world.web.handler

        def handler(request):
            if str(request.url).startswith(f"{SUPABASE}/rest/v1/facilities") and world.web.wrote \
                    and request.headers.get("authorization") == "Bearer tourist-jwt":
                return httpx.Response(200, json=[{"id": "x"}])
            return original_handler(request)

        world.web.handler = handler
    else:
        world.web.api_payload = _leaky(leak)

    code = await world.run()

    assert code == seoul.EXIT_LEAK
    writes = world.db.writes()
    ops = [op for op, *_ in writes]
    last_delete = max(i for i, op in enumerate(ops) if op == "delete")
    deactivations = [i for i, (op, _t, _f, payload) in enumerate(writes)
                     if op == "update" and payload == {"is_active": False}]
    assert deactivations and min(deactivations) < last_delete
    assert not [r for r in world.db.tables.get("facilities", []) if r.get("contentid") in {"900001", "900002"}]
    leak_events = [e[3] for e in world.db.writes("app_events") if e[3]["event"] == seoul.EVENT_LEAK]
    assert len(leak_events) == 1
    assert seoul.EVENT not in [e[3]["event"] for e in world.db.writes("app_events")]


@pytest.mark.asyncio
async def test_api_leak_by_seoul_id_in_estimates_keys(world):
    world.tourapi = TourAPI(_two_items())

    def payload(path, headers):
        if path == "/api/v1/congestion/estimates" and headers.get("x-nextspot-region") == "seoul":
            ids = [r["id"] for r in world.db.tables["facilities"] if r.get("region") == "seoul"]
            return {"available": True, "estimates": {ids[0]: {"level": 0.4}}}
        return {"available": False, "estimates": {}}

    world.web.api_payload = payload
    assert await world.run() == seoul.EXIT_LEAK


@pytest.mark.asyncio
async def test_policy_leak_deactivates_every_seoul_row(world):
    lat, lng = _near(INSADONG)
    older = {"id": "s-old", "contentid": "800001", "region": "seoul", "name": "기존", "type": "cafe",
             "latitude": lat + 0.001, "longitude": lng, "is_active": True, "features": {}}
    world.db = FakeDB({"facilities": [older]})
    world.tourapi = TourAPI(_two_items())
    world.web.anon_rows_after_write = [{"id": "x"}]
    assert await world.run() == seoul.EXIT_LEAK
    assert next(r for r in world.db.tables["facilities"] if r["id"] == "s-old")["is_active"] is False


@pytest.mark.asyncio
async def test_api_probes_send_both_header_variants_as_the_tourist(world):
    world.tourapi = TourAPI(_two_items())
    assert await world.run() == seoul.EXIT_OK
    api_calls = [r for r in world.web.requests if str(r.url).startswith(API) and r.url.path.startswith("/api/")]
    assert len(api_calls) == 8
    assert {r.headers.get("x-nextspot-region") for r in api_calls} == {None, "seoul"}
    assert all(r.headers["authorization"] == "Bearer tourist-jwt" for r in api_calls)
    by_type = next(r for r in api_calls if r.url.path.endswith("/by-type"))
    assert json.loads(by_type.content)["user_id"] == TOURIST_ID


# =========================================================================
# 로그 — 집계만(공개 CI)
# =========================================================================

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
_CONTENTID = re.compile(r"\b9\d{5}\b|\b8\d{5}\b")
_COORD = re.compile(r"\b(?:3[5-8]|12[6-9])\.\d{3,}")


@pytest.mark.parametrize("scenario", ["ok", "dry", "leak"])
@pytest.mark.asyncio
async def test_stdout_and_step_summary_have_no_ids_or_coordinates(world, capsys, tmp_path, monkeypatch, scenario):
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    world.tourapi = TourAPI(_two_items())
    if scenario == "leak":
        world.web.api_payload = _leaky("/api/v1/infrastructures")
    code = await world.run(args=_args(apply=scenario != "dry"))
    assert code == {"ok": 0, "dry": 0, "leak": 4}[scenario]
    text = capsys.readouterr().out + summary.read_text(encoding="utf-8")
    assert text.strip()
    for pattern in (_UUID, _CONTENTID, _COORD):
        assert not pattern.search(text), pattern.pattern
    assert "장소9" not in text


def test_count_leaks_rules():
    ids = {"s-1"}
    assert seoul.count_leaks([{"id": "g", "latitude": 35.8}], ids) == 0
    assert seoul.count_leaks([{"id": "x", "latitude": 37.5}], ids) == 1
    assert seoul.count_leaks({"estimates": {"s-1": {}}}, ids) == 1
    assert seoul.count_leaks({"items": [{"facility": {"id": "s-1"}}]}, ids) == 1
    assert seoul.count_leaks({"user_lat": 37.57}, ids) == 0  # 요청 원점 되풀이는 시설이 아니다


def test_config_reads_env_names_and_derives_api_base():
    cfg = seoul.Config.from_env({
        "SUPABASE_URL": "https://a.supabase.co/", "SUPABASE_ANON_KEY": "k", "BACKEND_HEALTH_URL": "https://api/health",
        "REGION_PROBE_TOURIST_EMAIL": "e", "REGION_PROBE_TOURIST_PASSWORD": "p",
    })
    assert cfg.supabase_url == "https://a.supabase.co"
    assert cfg.api_base == "https://api"
    assert (cfg.probe_email, cfg.probe_password) == ("e", "p")
    assert cfg.service_role_configured is False


def test_parser_defaults_to_dry_run():
    args = seoul.build_parser().parse_args([])
    assert args.apply is False and args.details_budget == 400 and args.sync is True and args.reactivate is False
    assert seoul.build_parser().parse_args(["--apply", "--reactivate"]).reactivate is True
