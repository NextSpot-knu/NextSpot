"""엔진 경로의 지역 격리(서울 S3 — WP3) — 추천·종류별·코스·수락/거절/방문 결과/피드백.

  · 개발자 + 서울 헤더 → 서울 후보만. 관광객·사장님·관리자·게스트 + 서울 헤더 → 경주(헤더는 요청일 뿐이다).
  · 서울 시설 id 를 경주 요청에 넣으면 없는 시설과 같은 404 — 원본 시설·수락·거절·방문 결과·피드백 모두.
  · 같은 계정·같은 본문이라도 판정된 지역이 다르면 캐시 키·후보 풀이 다르다. 경주 키는 지역 도입 전과 같다.
  · 코스의 핀·폴백은 지역을 건너지 않는다.
  · 개발자의 서울 방문 결과(체감 혼잡 포함)는 200 이다(DB 가 공개 혼잡 표로 옮기지 않을 뿐).
  · region 칸 없이 select 된 서울 행도 fetch_facility 가 거른다 — 필터가 쿼리 안에 있다.

이 파일의 대역(RegionDB)과 세계(seoul_world)는 test_region_engine_pipeline · test_gyeongju_zone_invariance 가 함께 쓴다.
"""

from __future__ import annotations

import copy
import uuid
from contextlib import ExitStack, contextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.core import authz
from app.main import app
from app.routers import courses as courses_router
from app.routers import recommendations as reco_router
from app.services.crowd import zone_evidence
from app.services.facility_cache import invalidate_facility_cache
from app.services.preference_vector_service import preference_vector_service
from app.services.spot.travel import estimate_walking_route
from tests import conftest
from tests.conftest import DEVELOPER_USER_ID, TOURIST_USER_ID, role_headers

FROZEN = datetime(2026, 10, 31, 3, 0, tzinfo=timezone.utc)  # 토 12:00 KST
REGION_HEADER = {"X-NextSpot-Region": "seoul"}
OPEN_ALL_DAY = {"open": "00:00~23:59, 23:58~00:01", "closed": "연중무휴"}
UNIT_VECTOR = [1.0 / (8 ** 0.5)] * 8

SEOUL_CENTER = (37.5738, 126.9860)  # 인사동(POI078)
GJ_CENTER = (35.8360, 129.2100)     # 황리단길


def _facility(fid: str, ftype: str, lat: float, lng: float, region: str, **extra) -> dict:
    row = {
        "id": fid, "name": f"시설-{fid}", "type": ftype, "latitude": lat, "longitude": lng,
        "capacity": 40, "features": {"average_processing_time": 10}, "coupon_rate": 0.0,
        "operating_hours": OPEN_ALL_DAY, "is_active": True, "region": region,
        "updated_at": "2026-10-01T00:00:00+00:00",
    }
    row.update(extra)
    return row


SEOUL_FACILITIES = [
    _facility("s-attr", "attraction", 37.5738, 126.9860, "seoul"),
    _facility("s-cafe-1", "cafe", 37.5741, 126.9862, "seoul"),
    _facility("s-cafe-2", "cafe", 37.5745, 126.9857, "seoul"),
    _facility("s-rest-1", "restaurant", 37.5734, 126.9866, "seoul"),
    _facility("s-cult-1", "culture", 37.5748, 126.9871, "seoul"),
]
GYEONGJU_FACILITIES = [
    _facility("g-attr", "attraction", 35.8360, 129.2100, "gyeongju"),
    _facility("g-cafe-1", "cafe", 35.8362, 129.2101, "gyeongju"),
    _facility("g-cafe-2", "cafe", 35.8365, 129.2098, "gyeongju"),
    _facility("g-rest-1", "restaurant", 35.8357, 129.2104, "gyeongju"),
    _facility("g-cult-1", "culture", 35.8368, 129.2106, "gyeongju"),
]
SEOUL_IDS = {f["id"] for f in SEOUL_FACILITIES}
GYEONGJU_IDS = {f["id"] for f in GYEONGJU_FACILITIES}


def _iso(moment: datetime) -> str:
    return moment.isoformat()


def zone_tables(now: datetime = FROZEN) -> dict[str, list[dict]]:
    """서울 구역 2곳 + 매핑 + 최신 관측. 인사동은 지금 '보통', 30·60분 뒤 예보가 붙는다."""
    observed = now - timedelta(minutes=5)
    return {
        "zones": [
            {"zone_id": "seoul:POI078", "region": "seoul", "name": "인사동", "provider": "seoul_citydata",
             "cluster": "jongno", "centroid_lat": 37.5738, "centroid_lng": 126.9860, "radius_m": 450},
            {"zone_id": "seoul:POI012", "region": "seoul", "name": "창덕궁·종묘", "provider": "seoul_citydata",
             "cluster": "jongno", "centroid_lat": 37.5760, "centroid_lng": 126.9920, "radius_m": 600},
        ],
        "facility_zones": [
            {"facility_id": fid, "zone_id": "seoul:POI078", "weight": 1}
            for fid in ("s-attr", "s-cafe-1", "s-cafe-2", "s-rest-1")
        ] + [{"facility_id": "s-cult-1", "zone_id": "seoul:POI012", "weight": 1}],
        "zone_crowd_snapshots": [
            {
                "zone_id": "seoul:POI078", "source": "seoul_citydata", "bucket_at": _iso(observed),
                "observed_at": _iso(observed), "fetched_at": _iso(observed + timedelta(minutes=1)),
                "population_min": 9000, "population_max": 11000, "level": 0.375, "level_label": "보통",
                "level_scale": "seoul_congest_4", "quality": {},
                "forecast": [
                    {"target_at": _iso(observed + timedelta(minutes=30)), "level": 0.625, "level_label": "약간 붐빔"},
                    {"target_at": _iso(observed + timedelta(minutes=60)), "level": 0.875, "level_label": "붐빔"},
                ],
            },
            {
                "zone_id": "seoul:POI012", "source": "seoul_citydata", "bucket_at": _iso(now - timedelta(minutes=3)),
                "observed_at": _iso(now - timedelta(minutes=3)), "fetched_at": _iso(now - timedelta(minutes=2)),
                "population_min": 1000, "population_max": 2000, "level": 0.125, "level_label": "여유",
                "level_scale": "seoul_congest_4", "quality": {}, "forecast": [],
            },
        ],
    }


# ── PostgREST 대역 ────────────────────────────────────────────────────────────


def _cmp(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return (0, value)
    return (1, str(value))


def _cell(row: dict, column: str):
    """칸 값. ``col->>key`` 는 JSON 칸의 키(PostgREST 와 같이 칸이 dict 가 아니면 NULL)."""
    if "->>" not in column:
        return row.get(column)
    base, key = column.split("->>", 1)
    value = row.get(base)
    if not isinstance(value, dict):
        return None
    inner = value.get(key)
    return None if inner is None else str(inner)


class RegionQuery:
    """필터를 기록하고 실제로 적용한다. 임베드(`alias:facilities!fk!inner(*)`)와 그 칸의 필터(`alias.col`)도 흉내 낸다."""

    def __init__(self, db: "RegionDB", table: str) -> None:
        self.db, self.table = db, table
        self.columns = "*"
        self.filters: list[tuple[str, str, object]] = []
        self.orders: list[tuple[str, bool]] = []
        self._limit = None
        self._range = None
        self._op = "select"
        self._payload = None
        self._negate = False

    def select(self, columns="*", **_kw):
        self.columns = columns
        return self

    def insert(self, payload):
        self._op, self._payload = "insert", payload
        return self

    def update(self, payload):
        self._op, self._payload = "update", payload
        return self

    def upsert(self, payload, **_kw):
        self._op, self._payload = "insert", payload
        return self

    @property
    def not_(self):
        self._negate = True
        return self

    def _add(self, column, op, value):
        self.filters.append((column, ("not_" if self._negate else "") + op, value))
        self._negate = False
        return self

    def eq(self, c, v):
        return self._add(c, "eq", v)

    def neq(self, c, v):
        return self._add(c, "neq", v)

    def in_(self, c, v):
        return self._add(c, "in", list(v))

    def gte(self, c, v):
        return self._add(c, "gte", v)

    def lte(self, c, v):
        return self._add(c, "lte", v)

    def gt(self, c, v):
        return self._add(c, "gt", v)

    def lt(self, c, v):
        return self._add(c, "lt", v)

    def is_(self, c, v):
        return self._add(c, "is", v)

    def order(self, column, desc=False, **_kw):
        self.orders.append((column, desc))
        return self

    def limit(self, n):
        self._limit = n
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def __getattr__(self, _name):  # 그 밖의 체이닝은 흡수한다
        return lambda *_a, **_k: self

    @staticmethod
    def _ok(cell, op, value) -> bool:
        negate = op.startswith("not_")
        base = op.removeprefix("not_")
        if base == "eq":
            ok = cell == value
        elif base == "neq":
            ok = cell != value
        elif base == "in":
            ok = cell in value
        elif base in ("gte", "lte", "gt", "lt"):
            if cell is None:
                ok = False
            else:
                a, b = _cmp(cell), _cmp(value)
                ok = {"gte": a >= b, "lte": a <= b, "gt": a > b, "lt": a < b}[base]
        elif base == "is":
            ok = cell is None if value == "null" else cell == value
        else:  # pragma: no cover
            raise AssertionError(op)
        return ok != negate

    def _embed(self) -> tuple[str, bool] | None:
        if self.table != "recommendations" or "recommended_facility:facilities" not in self.columns:
            return None
        return "recommended_facility", "!inner" in self.columns

    def execute(self):
        self.db.queries.append(self)
        if self._op == "insert":
            rows = self._payload if isinstance(self._payload, list) else [self._payload]
            out = []
            for payload in rows:
                row = {"id": self.db.next_id(self.table, payload), **copy.deepcopy(payload)}
                self.db.tables.setdefault(self.table, []).append(row)
                out.append(row)
            return SimpleNamespace(data=copy.deepcopy(out))
        rows = [copy.deepcopy(r) for r in self.db.tables.get(self.table, [])]
        embed = self._embed()
        if embed is not None:
            alias, _inner = embed
            facilities = {f["id"]: f for f in self.db.tables.get("facilities", [])}
            for row in rows:
                row[alias] = copy.deepcopy(facilities.get(row.get("recommended_facility_id")))
        kept = []
        for row in rows:
            ok = True
            for column, op, value in self.filters:
                if "." in column and embed is not None:
                    alias, inner = embed
                    _, sub = column.split(".", 1)
                    child = row.get(alias)
                    if child is None or not self._ok(child.get(sub), op, value):
                        if inner:
                            ok = False
                        else:
                            row[alias] = None
                    continue
                if not self._ok(_cell(row, column), op, value):
                    ok = False
            if ok:
                kept.append(row)
        if self._op == "update":
            for row in self.db.tables.get(self.table, []):
                if any(row.get("id") == k.get("id") for k in kept):
                    row.update(self._payload)
            return SimpleNamespace(data=copy.deepcopy(kept))
        for column, desc in reversed(self.orders):
            kept.sort(key=lambda r, c=column: _cmp(r.get(c)), reverse=desc)
        if self._range is not None:
            kept = kept[self._range[0]: self._range[1] + 1]
        if self._limit is not None:
            kept = kept[: self._limit]
        if self.columns.strip() not in ("*", "") and embed is None and "(" not in self.columns:
            cols = [c.strip() for c in self.columns.split(",")]
            kept = [{c: r[c] for c in cols if c in r} for r in kept]
        return SimpleNamespace(data=kept)


class RegionDB:
    """service_role 클라이언트 대역 — 테이블 dict + 기록된 쿼리 + RPC 처리기."""

    def __init__(self, tables: dict[str, list[dict]], *, rpc_handlers: dict | None = None) -> None:
        self.tables = {name: [copy.deepcopy(r) for r in rows] for name, rows in tables.items()}
        self.queries: list[RegionQuery] = []
        self.rpc_calls: list[tuple[str, dict]] = []
        self.rpc_handlers = rpc_handlers or {}

    def table(self, name: str) -> RegionQuery:
        return RegionQuery(self, name)

    def rpc(self, name: str, params: dict):
        self.rpc_calls.append((name, params))
        handler = self.rpc_handlers.get(name)

        def _execute():
            if handler is None:
                return SimpleNamespace(data=[])
            return SimpleNamespace(data=handler(params))

        return SimpleNamespace(execute=_execute)

    @staticmethod
    def next_id(table: str, payload: dict) -> str:
        # 같은 노출이면 같은 id — 두 요청의 응답을 그대로 비교할 수 있게(결정적).
        key = f"{table}:{payload.get('recommended_facility_id')}:{payload.get('original_facility_id')}"
        return str(uuid.uuid5(uuid.NAMESPACE_URL, key))

    def queries_on(self, table: str) -> list[RegionQuery]:
        return [q for q in self.queries if q.table == table]


def make_db(*, extra: dict[str, list[dict]] | None = None, rpc_handlers: dict | None = None) -> RegionDB:
    tables = {
        "facilities": SEOUL_FACILITIES + GYEONGJU_FACILITIES,
        "facility_source_refs": [],
        "recommendations": [],
        "user_feedback": [],
        "merchant_timesales": [],
        "tourism_concentration_forecasts": [],
        **zone_tables(),
    }
    tables.update(extra or {})
    return RegionDB(tables, rpc_handlers=rpc_handlers)


# ── 세계 ──────────────────────────────────────────────────────────────────────


def _frozen_datetime():
    class _Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return FROZEN.astimezone(tz) if tz else FROZEN.replace(tzinfo=None)

    return _Frozen


async def straight_routes(start_lat, start_lng, destinations):
    return [estimate_walking_route(start_lat, start_lng, lat, lng) for lat, lng in destinations]


@contextmanager
def seoul_world(db: RegionDB, *, user_rows: dict | None = None):
    """엔진 라우터를 대역 DB 위에서 돌린다. 시설 풀은 **실제** fetch_all_facilities → _fetch_all_facilities_uncached 를 탄다."""
    users = user_rows or {}

    async def _fetch_user(user_id):
        return users.get(user_id, {"id": user_id, "preferred_categories": ["cafe", "restaurant"]})

    frozen = _frozen_datetime()
    invalidate_facility_cache()
    with ExitStack() as stack:
        stack.enter_context(patch.object(reco_router, "supabase_client", db))
        stack.enter_context(patch.object(courses_router, "supabase_admin", db))
        stack.enter_context(patch.object(zone_evidence, "supabase_admin", db))
        stack.enter_context(patch.object(reco_router, "fetch_user", new=AsyncMock(side_effect=_fetch_user)))
        stack.enter_context(patch.object(courses_router, "fetch_user", new=AsyncMock(side_effect=_fetch_user)))
        stack.enter_context(patch.object(reco_router, "fetch_congestion_map", new=AsyncMock(return_value={})))
        stack.enter_context(patch.object(courses_router, "fetch_congestion_map", new=AsyncMock(return_value={})))
        stack.enter_context(
            patch.object(reco_router, "fetch_effective_availability_map", new=AsyncMock(return_value={}))
        )
        stack.enter_context(
            patch.object(courses_router, "fetch_effective_availability_map", new=AsyncMock(return_value={}))
        )
        stack.enter_context(patch.object(reco_router, "get_walking_routes", new=straight_routes))
        stack.enter_context(patch.object(courses_router, "get_walking_routes", new=straight_routes))
        stack.enter_context(
            patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR))
        )
        stack.enter_context(patch("app.routers.recommendations.datetime", frozen))
        stack.enter_context(patch("app.routers.courses.datetime", frozen))
        yield db
    invalidate_facility_cache()


def headers(role: str, *, seoul: bool = True, **kw) -> dict:
    return {**role_headers(role, **kw), **(REGION_HEADER if seoul else {})}


def reco_body(user_id: str, origin: str, center: tuple[float, float]) -> dict:
    return {"user_id": user_id, "original_facility_id": origin, "user_lat": center[0], "user_lng": center[1]}


def by_type_body(user_id: str, center: tuple[float, float], facility_type: str = "cafe") -> dict:
    return {"user_id": user_id, "facility_type": facility_type, "user_lat": center[0], "user_lng": center[1]}


def course_body(user_id: str, center: tuple[float, float], **extra) -> dict:
    return {"user_id": user_id, "user_lat": center[0], "user_lng": center[1], **extra}


def has_key_anywhere(value, key: str) -> bool:
    if isinstance(value, dict):
        return key in value or any(has_key_anywhere(v, key) for v in value.values())
    if isinstance(value, list):
        return any(has_key_anywhere(v, key) for v in value)
    return False


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


# ── 추천 ──────────────────────────────────────────────────────────────────────


def test_developer_with_seoul_header_gets_only_seoul_candidates_with_zone_evidence(client):
    db = make_db()
    with seoul_world(db):
        res = client.post(
            "/api/v1/recommendations", json=reco_body(DEVELOPER_USER_ID, "s-attr", SEOUL_CENTER),
            headers=headers("developer"),
        )
    assert res.status_code == 200, res.text
    items = res.json()
    assert items and {item["facility"]["id"] for item in items} <= SEOUL_IDS - {"s-attr"}
    assert not has_key_anywhere(items, "region")
    for item in items:
        assert item["congestion_source"] == "measured"
        assert item["congestion_log_source"] == "seoul_citydata"
        assert item["congestion_is_current"] is True
        assert item["scoring_mode"] == "measured_rules"
        assert item["breakdown"]["zone_name"] in {"인사동", "창덕궁·종묘"}
        assert "권역" in item["reason"] and "%" not in item["reason"]
    # 같은 구역(인사동) 후보의 재배치 기여는 0 — 출발지도 인사동이다.
    insadong = [i for i in items if i["breakdown"]["zone_id"] == "seoul:POI078"]
    assert insadong and all(i["breakdown"]["incentive_relief"] == 0.0 for i in insadong)


@pytest.mark.parametrize("role,kw", [
    ("tourist", {}),
    ("merchant", {}),
    ("admin", {}),
    ("admin", {"email": authz.JUDGE_ADMIN_EMAIL}),  # 심사용 공유 계정
    ("tourist", {"is_anonymous": True}),
])
def test_non_developer_seoul_header_resolves_to_gyeongju(client, role, kw):
    db = make_db()
    user_id = conftest._ROLE_USER_IDS[role]
    with seoul_world(db):
        res = client.post(
            "/api/v1/recommendations", json=reco_body(user_id, "g-attr", GJ_CENTER),
            headers=headers(role, **kw),
        )
        seoul_origin = client.post(
            "/api/v1/recommendations", json=reco_body(user_id, "s-attr", SEOUL_CENTER),
            headers=headers(role, **kw),
        )
    assert res.status_code == 200, res.text
    assert {item["facility"]["id"] for item in res.json()} <= GYEONGJU_IDS
    assert seoul_origin.status_code == 404
    assert not db.queries_on("zones") and not db.queries_on("zone_crowd_snapshots")


def test_tourist_with_a_seoul_original_facility_gets_404(client):
    db = make_db()
    with seoul_world(db):
        res = client.post(
            "/api/v1/recommendations", json=reco_body(TOURIST_USER_ID, "s-attr", SEOUL_CENTER),
            headers=role_headers("tourist"),
        )
    assert res.status_code == 404
    facility_reads = [q for q in db.queries_on("facilities") if ("id", "eq", "s-attr") in q.filters]
    assert facility_reads and all(("region", "eq", "gyeongju") in q.filters for q in facility_reads)


def test_developer_without_the_header_stays_in_gyeongju(client):
    db = make_db()
    with seoul_world(db):
        res = client.post(
            "/api/v1/recommendations", json=reco_body(DEVELOPER_USER_ID, "g-attr", GJ_CENTER),
            headers=role_headers("developer"),
        )
        seoul_origin = client.post(
            "/api/v1/recommendations", json=reco_body(DEVELOPER_USER_ID, "s-attr", SEOUL_CENTER),
            headers=role_headers("developer"),
        )
    assert res.status_code == 200
    assert {item["facility"]["id"] for item in res.json()} <= GYEONGJU_IDS
    assert seoul_origin.status_code == 404


def test_developer_seoul_cannot_use_a_gyeongju_original_facility(client):
    db = make_db()
    with seoul_world(db):
        res = client.post(
            "/api/v1/recommendations", json=reco_body(DEVELOPER_USER_ID, "g-attr", GJ_CENTER),
            headers=headers("developer"),
        )
    assert res.status_code == 404


def test_fetch_facility_filters_in_the_query_even_when_region_is_not_selected():
    """region 칸을 고르지 않은 대역(실제 select 목록이 좁은 경우)에서도 서울 행이 걸러진다 — dict 검사가 아니다."""
    import asyncio

    class NoRegionColumnSelected(RegionDB):
        def table(self, name):
            query = super().table(name)
            original = query.execute

            def _execute():
                result = original()
                for row in result.data:
                    row.pop("region", None)  # 응답에는 region 칸이 없다
                return result

            query.execute = _execute
            return query

    db = NoRegionColumnSelected({"facilities": SEOUL_FACILITIES + GYEONGJU_FACILITIES})
    with patch.object(reco_router, "supabase_client", db):
        with pytest.raises(Exception) as excinfo:
            asyncio.run(reco_router.fetch_facility("s-attr"))
        assert getattr(excinfo.value, "status_code", None) == 404
        row = asyncio.run(reco_router.fetch_facility("s-attr", region="seoul"))
        assert row["id"] == "s-attr" and "region" not in row
        assert asyncio.run(reco_router.fetch_facility("g-attr"))["id"] == "g-attr"


# ── 수락 · 거절 · 방문 결과 · 피드백 ──────────────────────────────────────────

SEOUL_REC_ID = str(uuid.uuid5(uuid.NAMESPACE_URL, "seoul-rec"))
GJ_REC_ID = str(uuid.uuid5(uuid.NAMESPACE_URL, "gj-rec"))


def _rec_rows(owner: str) -> list[dict]:
    return [
        {"id": SEOUL_REC_ID, "user_id": owner, "original_facility_id": "s-attr",
         "recommended_facility_id": "s-cafe-1", "accepted": False, "source": "spot"},
        {"id": GJ_REC_ID, "user_id": owner, "original_facility_id": "g-attr",
         "recommended_facility_id": "g-cafe-1", "accepted": False, "source": "spot"},
    ]


def _outcome_row(params: dict) -> list[dict]:
    return [{
        "recommendation_id": params["p_recommendation_id"], "stage": params["p_stage"],
        "rating": params.get("p_rating"), "observed_congestion": params.get("p_observed_congestion"),
        "observed_answer_mode": "registered" if params.get("p_observed_congestion") else None,
    }]


def test_tourist_cannot_accept_reject_rate_or_give_feedback_on_a_seoul_facility(client):
    db = make_db(extra={"recommendations": _rec_rows(TOURIST_USER_ID)},
                 rpc_handlers={"record_recommendation_outcome": _outcome_row})
    coupon = AsyncMock(return_value={"coupon_issued": False, "coupon_rate": 0.0, "expires_at": None})
    tourist = headers("tourist")  # 서울 헤더를 실어도 경주다
    with seoul_world(db), patch.object(reco_router, "issue_coupon_if_partner", new=coupon):
        accept = client.post("/api/v1/recommendations/accept", json={"facility_id": "s-cafe-1"}, headers=tourist)
        accept_linked = client.post(
            "/api/v1/recommendations/accept",
            json={"facility_id": "g-cafe-1", "recommendation_id": SEOUL_REC_ID}, headers=tourist,
        )
        reject = client.post("/api/v1/recommendations/reject", json={"facility_id": "s-cafe-1"}, headers=tourist)
        outcome = client.patch(
            f"/api/v1/recommendations/{SEOUL_REC_ID}/outcome",
            json={"stage": "arrival_confirmed"}, headers=tourist,
        )
        feedback = client.post(
            "/api/v1/feedback", json={"recommendation_id": SEOUL_REC_ID, "action": "accepted_visit_intent"},
            headers=tourist,
        )
        explain = client.post(
            f"/api/v1/recommendations/{SEOUL_REC_ID}/explain", json={"question": "why_first"}, headers=tourist,
        )
        # 대조: 같은 사용자의 경주 추천은 그대로 된다.
        gj_outcome = client.patch(
            f"/api/v1/recommendations/{GJ_REC_ID}/outcome",
            json={"stage": "arrival_confirmed"}, headers=tourist,
        )
    assert accept.status_code == 404
    assert accept_linked.status_code == 404
    assert reject.status_code == 404
    assert outcome.status_code == 404
    assert feedback.status_code == 404
    assert explain.status_code == 404
    assert gj_outcome.status_code == 200, gj_outcome.text
    coupon.assert_not_called()
    assert not db.rpc_calls or all(
        params["p_recommendation_id"] == GJ_REC_ID for _name, params in db.rpc_calls
    )


def test_developer_seoul_outcome_with_a_crowd_answer_is_200(client):
    db = make_db(extra={"recommendations": _rec_rows(DEVELOPER_USER_ID)},
                 rpc_handlers={"record_recommendation_outcome": _outcome_row})
    dev = headers("developer")
    with seoul_world(db), patch.object(reco_router.reference_snapshot, "mark_dirty") as mark_dirty:
        arrived = client.patch(
            f"/api/v1/recommendations/{SEOUL_REC_ID}/outcome", json={"stage": "arrival_confirmed"}, headers=dev,
        )
        rated = client.patch(
            f"/api/v1/recommendations/{SEOUL_REC_ID}/outcome",
            json={"stage": "rated", "rating": "up", "observed_congestion": "busy"}, headers=dev,
        )
    assert arrived.status_code == 200, arrived.text
    assert rated.status_code == 200, rated.text
    # 서울은 혼잡 제보가 꺼져 있다(사용자 결정 2) — 체감 혼잡은 서버가 버리고 저장하지 않는다(평가만 저장).
    assert rated.json()["crowd_answer"] == "not_recorded_region"
    rated_calls = [params for _name, params in db.rpc_calls if params.get("p_stage") == "rated"]
    assert rated_calls and all(params["p_observed_congestion"] is None for params in rated_calls)
    assert all(params["p_rating"] == "up" for params in rated_calls)
    mark_dirty.assert_not_called()  # 서울 답은 공개 혼잡 표로 옮겨지지 않는다 — 지도 스냅샷을 흔들 이유가 없다


def test_gyeongju_outcome_still_stores_the_crowd_answer(client):
    """대조: 경주 방문 결과의 체감 혼잡은 예전 그대로 RPC 로 간다."""
    db = make_db(extra={"recommendations": _rec_rows(TOURIST_USER_ID)},
                 rpc_handlers={"record_recommendation_outcome": _outcome_row})
    with seoul_world(db), patch.object(reco_router.reference_snapshot, "mark_dirty") as mark_dirty:
        client.patch(f"/api/v1/recommendations/{GJ_REC_ID}/outcome", json={"stage": "arrival_confirmed"},
                     headers=headers("tourist", seoul=False))
        rated = client.patch(
            f"/api/v1/recommendations/{GJ_REC_ID}/outcome",
            json={"stage": "rated", "rating": "up", "observed_congestion": "busy"},
            headers=headers("tourist", seoul=False),
        )
    assert rated.status_code == 200, rated.text
    assert rated.json()["crowd_answer"] == "registered"
    rated_calls = [params for _name, params in db.rpc_calls if params.get("p_stage") == "rated"]
    assert [params["p_observed_congestion"] for params in rated_calls] == ["busy"]
    mark_dirty.assert_called_once_with("congestion")


# ── 설명(explain) ─────────────────────────────────────────────────────────────

DELETED_GJ_REC_ID = str(uuid.uuid5(uuid.NAMESPACE_URL, "gj-rec-deleted-facility"))
DELETED_SEOUL_REC_ID = str(uuid.uuid5(uuid.NAMESPACE_URL, "seoul-rec-deleted-facility"))


def _explain_rows(owner: str) -> list[dict]:
    snapshot = {"facility_id": "g-gone", "facility_name": "지워진 카페", "spot_score": 70, "rank": 1,
                "breakdown": {}, "tourapi_facts": {}}
    return [
        *_rec_rows(owner),
        # 관리자가 시설을 지웠다 — FK ON DELETE SET NULL 로 recommended_facility_id 가 NULL 이다.
        {"id": DELETED_GJ_REC_ID, "user_id": owner, "original_facility_id": "g-attr",
         "recommended_facility_id": None, "accepted": False, "source": "spot", "recommendation_snapshot": snapshot},
        # 서울 추천(지역 표시가 있다)의 시설이 지워졌다.
        {"id": DELETED_SEOUL_REC_ID, "user_id": owner, "original_facility_id": "s-attr",
         "recommended_facility_id": None, "accepted": False, "source": "spot",
         "recommendation_snapshot": {**snapshot, "facility_name": "지워진 서울 카페", "region": "seoul"}},
    ]


def _explain(client, rec_id: str, hdrs: dict):
    with patch.object(reco_router, "explain_snapshot",
                      new=AsyncMock(return_value=("고정 설명", ["SPOT 근거 설명"], "disabled"))):
        return client.post(f"/api/v1/recommendations/{rec_id}/explain", json={"question": "why_first"},
                           headers=hdrs)


def test_gyeongju_explain_still_answers_when_the_facility_was_deleted(client):
    """S3 전과 같다 — 경주 설명은 스냅샷으로 답한다(시설 조인이 행을 빼지 않는다)."""
    db = make_db(extra={"recommendations": _explain_rows(TOURIST_USER_ID)})
    with seoul_world(db):
        res = _explain(client, DELETED_GJ_REC_ID, headers("tourist", seoul=False))
        live = _explain(client, GJ_REC_ID, headers("tourist", seoul=False))
    assert res.status_code == 200, res.text
    assert res.json()["answer"] == "고정 설명"
    assert live.status_code == 200, live.text


@pytest.mark.parametrize("role", ["tourist", "developer"])
def test_gyeongju_explain_never_serves_a_seoul_recommendation(client, role):
    """경주로 판정된 요청 — 서울 시설을 가리키는 추천도, 시설이 지워진 서울 추천(지역 표시)도 없는 추천과 같은 404."""
    owner = TOURIST_USER_ID if role == "tourist" else DEVELOPER_USER_ID
    db = make_db(extra={"recommendations": _explain_rows(owner)})
    with seoul_world(db):
        live = _explain(client, SEOUL_REC_ID, headers(role, seoul=False))
        deleted = _explain(client, DELETED_SEOUL_REC_ID, headers(role, seoul=False))
        tourist_header = _explain(client, DELETED_SEOUL_REC_ID, headers(role)) if role == "tourist" else None
    assert live.status_code == 404
    assert deleted.status_code == 404
    if tourist_header is not None:
        assert tourist_header.status_code == 404  # 서울 헤더를 실어도 관광객은 경주다


def test_developer_seoul_explain_reads_only_seoul_rows(client):
    db = make_db(extra={"recommendations": _explain_rows(DEVELOPER_USER_ID)})
    with seoul_world(db):
        seoul = _explain(client, SEOUL_REC_ID, headers("developer"))
        gyeongju = _explain(client, GJ_REC_ID, headers("developer"))
    assert seoul.status_code == 200, seoul.text
    assert gyeongju.status_code == 404  # 서울로 판정된 요청에서 경주 추천은 없는 추천이다


def test_developer_seoul_outcome_maps_the_region_trigger_error_to_404(client):
    def _trigger(_params):
        raise Exception("P0001: facility_region_not_public")

    db = make_db(extra={"recommendations": _rec_rows(DEVELOPER_USER_ID)},
                 rpc_handlers={"record_recommendation_outcome": _trigger})
    with seoul_world(db):
        res = client.patch(
            f"/api/v1/recommendations/{SEOUL_REC_ID}/outcome",
            json={"stage": "rated", "rating": "up", "observed_congestion": "busy"},
            headers=headers("developer"),
        )
    assert res.status_code == 404


def test_developer_seoul_accept_and_feedback_work_on_seoul_rows(client):
    db = make_db(extra={"recommendations": _rec_rows(DEVELOPER_USER_ID)})
    coupon = AsyncMock(return_value={"coupon_issued": False, "coupon_rate": 0.0, "expires_at": None})
    dev = headers("developer")
    with seoul_world(db), patch.object(reco_router, "issue_coupon_if_partner", new=coupon), \
         patch.object(preference_vector_service, "adjust_user_vector_on_feedback", new=AsyncMock()):
        accept = client.post(
            "/api/v1/recommendations/accept",
            json={"facility_id": "s-cafe-1", "recommendation_id": SEOUL_REC_ID}, headers=dev,
        )
        gj_accept = client.post("/api/v1/recommendations/accept", json={"facility_id": "g-cafe-1"}, headers=dev)
    assert accept.status_code == 200, accept.text
    assert accept.json()["recommendation_id"] == SEOUL_REC_ID
    assert gj_accept.status_code == 404  # 서울로 판정된 요청에서 경주 시설은 없는 시설이다


# ── 캐시 키 · 풀 ──────────────────────────────────────────────────────────────


def test_by_type_cache_key_is_unchanged_for_gyeongju_and_split_for_seoul():
    req = reco_router.RecommendByTypeRequest(**by_type_body("u-1", GJ_CENTER))
    legacy = (
        req.user_id, req.facility_type, *reco_router.round_location(req.user_lat, req.user_lng),
        int(req.limit), None, (), reco_router.model_signature(None),
        reco_router.assumed_time_bucket(None), False,
    )
    assert reco_router._by_type_cache_key(req) == legacy
    assert reco_router._by_type_cache_key(req, "gyeongju") == legacy
    assert reco_router._by_type_cache_key(req, "seoul") != legacy
    course = courses_router.CourseRequest(**course_body("u-1", GJ_CENTER))
    assert courses_router._course_cache_key(course, "gyeongju") == courses_router._course_cache_key(course)
    assert courses_router._course_cache_key(course, "seoul") != courses_router._course_cache_key(course)


def test_same_account_and_body_get_distinct_cache_entries_and_pools_by_resolved_region(client, monkeypatch):
    """같은 user_id·같은 본문 — 관광객일 때(서울 헤더 무시)와 개발자일 때(서울)가 서로의 캐시 답을 받지 않는다."""
    monkeypatch.setattr(reco_router._by_type_cache, "ttl_seconds", 180.0)
    def _role(role: str):
        return AsyncMock(return_value={"role": role, "facility_ids": frozenset()})

    db = make_db()
    body = by_type_body(DEVELOPER_USER_ID, SEOUL_CENTER)
    with seoul_world(db):
        authz.invalidate_profile_cache()
        with patch.object(authz, "_load_profile", new=_role("tourist")):
            as_tourist = client.post("/api/v1/recommendations/by-type", json=body, headers=headers("developer"))
        authz.invalidate_profile_cache()
        with patch.object(authz, "_load_profile", new=_role("developer")):
            as_developer = client.post("/api/v1/recommendations/by-type", json=body, headers=headers("developer"))
        again_tourist_shape = client.post(
            "/api/v1/recommendations/by-type", json=body, headers=role_headers("developer"),
        )
    assert as_tourist.status_code == as_developer.status_code == 200
    tourist_ids = {i["facility"]["id"] for i in as_tourist.json()}
    developer_ids = {i["facility"]["id"] for i in as_developer.json()}
    assert tourist_ids <= GYEONGJU_IDS  # 서울 좌표라 20분 도보 안에 경주 시설은 없다 → 빈 목록
    assert developer_ids and developer_ids <= SEOUL_IDS
    # 헤더 없는 같은 계정 요청은 경주 키 — 앞의 관광객 답(경주)을 그대로 받는다(서울 답이 새지 않는다).
    assert again_tourist_shape.json() == as_tourist.json()
    reco_router._by_type_cache.clear()


# ── 코스 ──────────────────────────────────────────────────────────────────────


def test_course_pins_never_cross_regions(client):
    db = make_db()
    with seoul_world(db):
        dev = client.post(
            "/api/v1/courses/plan",
            json=course_body(DEVELOPER_USER_ID, SEOUL_CENTER, pins=[{"order": 1, "facility_id": "g-cafe-1"}]),
            headers=headers("developer"),
        )
        tourist = client.post(
            "/api/v1/courses/plan",
            json=course_body(TOURIST_USER_ID, GJ_CENTER, pins=[{"order": 1, "facility_id": "s-cafe-1"}]),
            headers=headers("tourist"),
        )
    assert dev.status_code == tourist.status_code == 200
    dev_plan, tourist_plan = dev.json(), tourist.json()
    assert dev_plan["slot_outcomes"][0]["status"] == "pin_unavailable"
    assert {s["facility"]["id"] for s in dev_plan["stops"]} <= SEOUL_IDS
    assert tourist_plan["slot_outcomes"][0]["status"] == "pin_unavailable"
    assert {s["facility"]["id"] for s in tourist_plan["stops"]} <= GYEONGJU_IDS
    for plan in (dev_plan, tourist_plan):
        for stop in plan["stops"]:
            assert {alt["facility"]["id"] for alt in stop["alternatives"]} <= (
                SEOUL_IDS if plan is dev_plan else GYEONGJU_IDS
            )


def test_course_nearest_fallback_never_reaches_into_another_region(client):
    """사용자가 서울 좌표에 있어도 경주로 판정된 요청은 경주 풀의 '가까운 순' 폴백만 쓴다."""
    db = make_db()
    with seoul_world(db):
        res = client.post(
            "/api/v1/courses/recommend", json=course_body(TOURIST_USER_ID, SEOUL_CENTER), headers=headers("tourist"),
        )
    assert res.status_code == 200
    stops = res.json()
    assert stops and {s["facility"]["id"] for s in stops} <= GYEONGJU_IDS


def test_developer_seoul_course_uses_zone_arrival_levels_for_display(client):
    db = make_db()
    with seoul_world(db):
        res = client.post(
            "/api/v1/courses/plan", json=course_body(DEVELOPER_USER_ID, SEOUL_CENTER),
            headers=headers("developer"),
        )
    assert res.status_code == 200, res.text
    stops = res.json()["stops"]
    assert stops and {s["facility"]["id"] for s in stops} <= SEOUL_IDS
    assert not has_key_anywhere(stops, "region")
    first = stops[0]
    zone = first["facility"]["zone_crowd"]
    assert zone["zone_name"] in {"인사동", "창덕궁·종묘"} and zone["basis"] in {"persistence", "provider_forecast"}
    assert first["predicted_congestion"] is not None and first["facility"]["current_count"] is None
    assert "권역" in first["reason"] and "%" not in first["reason"]


# ── 추천 이력의 지역 표시(관제 RLS · model-trust 가 읽는다) ──────────────────────────────────


def _inserted(db: RegionDB) -> list[dict]:
    return [q._payload for q in db.queries_on("recommendations") if q._op == "insert"]


def test_seoul_recommendation_rows_carry_the_region_marker_and_gyeongju_rows_do_not(client):
    db = make_db()
    with seoul_world(db):
        seoul = client.post(
            "/api/v1/recommendations", json=reco_body(DEVELOPER_USER_ID, "s-attr", SEOUL_CENTER),
            headers=headers("developer"),
        )
        seoul_inserts = _inserted(db)
        seoul_by_type = client.post(
            "/api/v1/recommendations/by-type", json=by_type_body(DEVELOPER_USER_ID, SEOUL_CENTER),
            headers=headers("developer"),
        )
        by_type_inserts = _inserted(db)[len(seoul_inserts):]
        gj = client.post(
            "/api/v1/recommendations", json=reco_body(DEVELOPER_USER_ID, "g-attr", GJ_CENTER),
            headers=role_headers("developer"),
        )
        gj_inserts = _inserted(db)[len(seoul_inserts) + len(by_type_inserts):]
    assert seoul.status_code == 200 and seoul_by_type.status_code == 200 and gj.status_code == 200
    assert seoul_inserts and by_type_inserts and gj_inserts
    for payload in seoul_inserts + by_type_inserts:
        assert payload["recommendation_snapshot"]["region"] == "seoul"
    for payload in gj_inserts:
        # 경주 스냅샷에는 표시 칸 자체가 없다(종전 행과 글자 하나 다르지 않다).
        assert "region" not in payload["recommendation_snapshot"]
    # 응답에는 지역 칸이 새지 않는다.
    assert not has_key_anywhere(seoul.json(), "region")


def test_seoul_direct_accept_and_reject_rows_carry_the_marker_gyeongju_rows_unchanged(client):
    db = make_db()
    coupon = AsyncMock(return_value={"coupon_issued": False, "coupon_rate": 0.0, "expires_at": None})
    record = AsyncMock(return_value={"should_learn_vector": False, "row": {"id": "fb-1", "reason_status": "pending"}})
    with seoul_world(db), patch.object(reco_router, "issue_coupon_if_partner", new=coupon), \
         patch.object(reco_router.feedback_service, "record_decision", new=record):
        seoul_accept = client.post(
            "/api/v1/recommendations/accept", json={"facility_id": "s-cafe-1"}, headers=headers("developer"),
        )
        seoul_reject = client.post(
            "/api/v1/recommendations/reject", json={"facility_id": "s-cafe-1"}, headers=headers("developer"),
        )
        seoul_rows = _inserted(db)
        gj_accept = client.post(
            "/api/v1/recommendations/accept", json={"facility_id": "g-cafe-1"}, headers=role_headers("developer"),
        )
        gj_rows = _inserted(db)[len(seoul_rows):]
    assert seoul_accept.status_code == 200, seoul_accept.text
    assert seoul_reject.status_code == 200, seoul_reject.text
    assert gj_accept.status_code == 200, gj_accept.text
    assert len(seoul_rows) == 2
    assert all(row["recommendation_snapshot"] == {"region": "seoul"} for row in seoul_rows)
    assert gj_rows and all("recommendation_snapshot" not in row for row in gj_rows)


# ── 스냅샷 칸이 없는 구 DB 폴백(지역 표시를 잃지 않는다) ───────────────────────────


class _NoSnapshotColumnDB(RegionDB):
    """recommendation_snapshot 칸이 아직 없는 DB — 그 칸을 실은 INSERT 는 거부된다."""

    def table(self, name):
        query = super().table(name)
        original = query.execute

        def _execute():
            payload = query._payload
            rows = payload if isinstance(payload, list) else [payload]
            if name == "recommendations" and query._op == "insert" and any(
                isinstance(r, dict) and "recommendation_snapshot" in r for r in rows
            ):
                raise Exception('column "recommendation_snapshot" of relation "recommendations" does not exist')
            return original()

        query.execute = _execute
        return query


def _no_snapshot_db() -> RegionDB:
    base = make_db()
    return _NoSnapshotColumnDB(base.tables, rpc_handlers=base.rpc_handlers)


def test_seoul_recommendations_are_not_saved_without_the_region_marker(client):
    """스냅샷 칸이 없어 구 payload 로 물러서면 지역 표시가 사라진다 — 서울 추천은 물러서지 않고 저장을 건너뛴다."""
    db = _no_snapshot_db()
    with seoul_world(db):
        res = client.post(
            "/api/v1/recommendations", json=reco_body(DEVELOPER_USER_ID, "s-attr", SEOUL_CENTER),
            headers=headers("developer"),
        )
    assert res.status_code == 200, res.text
    items = res.json()
    assert items
    assert all(item["recommendation_id"] == "mock-rec-id" for item in items)
    assert db.tables.get("recommendations", []) == []  # 표시 없는 서울 행이 남지 않는다


def test_gyeongju_recommendations_still_fall_back_to_the_legacy_payload(client):
    db = _no_snapshot_db()
    with seoul_world(db):
        res = client.post(
            "/api/v1/recommendations", json=reco_body(TOURIST_USER_ID, "g-attr", GJ_CENTER),
            headers=headers("tourist", seoul=False),
        )
    assert res.status_code == 200, res.text
    items = res.json()
    assert items and all(item["recommendation_id"] != "mock-rec-id" for item in items)
    rows = db.tables["recommendations"]
    assert rows and all("recommendation_snapshot" not in row for row in rows)
