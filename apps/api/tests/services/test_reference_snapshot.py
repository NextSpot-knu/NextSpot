"""참조 스냅샷(app/services/reference_snapshot.py) — 지도 /infrastructures 를 미리 만든 바이트로.

검증하는 약속:
  · 골든: 같은 DB 행이면 스냅샷 바이트 == 실시간 경로 응답(필터 조합별).
  · ETag/304(약한 비교 포함), Cache-Control, X-Snapshot-Age.
  · 유효 구간(B1): is_current(30분)·is_stale(24시간)·영업 근거 만료가 지나면 요청이 재조립한 뒤 낸다.
  · 부팅(B2): 한 번도 못 만들었으면 실시간 경로로 답한다. 준비 전 재시도 간격 15초 상한, 요청의 즉시 깨우기.
  · 실패하면 마지막 정상본 유지, 건전성 관문, mark_dirty 디바운스·쓰기 직후 반영, 단일 비행, 감독 재시작.

페이크는 PostgREST 를 흉내 낸다 — 필터·정렬·range/limit·1000행 상한·열 선택(select)까지. 열 선택을 흉내 내야
스냅샷이 읽는 열 목록(BASE_COLUMNS)이 실시간 경로(select *)가 쓰는 열을 빠뜨렸을 때 골든 비교가 잡는다.
"""
import asyncio
import copy
import json
import math
import time
from collections import Counter
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.config import settings
from app.routers import infrastructures
from app.services import availability_service, reference_snapshot as rs

# =============================================================================
# PostgREST 페이크
# =============================================================================

_TRUSTED_TIERS = ("single_report", "corroborated", "verified")
_EXCLUDED_SOURCES = ("seed", "simulated", "parking_derived")


class _Result:
    def __init__(self, data, count=None):
        self.data = data
        self.count = count


def _cmp_key(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return (0, value)
    return (1, str(value))


class _Query:
    CAP = 1000

    def __init__(self, db: "FakeDB", name: str):
        self.db = db
        self.name = name
        self.columns = "*"
        self.count = None
        self.filters = []
        self.orders = []
        self.offset = 0
        self.lim = None

    def select(self, columns="*", count=None):
        self.columns = columns
        self.count = count
        return self

    def _filter(self, column, predicate):
        def _apply(row):
            value = row.get(column)
            return value is not None and predicate(value)
        self.filters.append(_apply)
        return self

    def eq(self, column, value):
        return self._filter(column, lambda v: v == value)

    def gt(self, column, value):
        return self._filter(column, lambda v: _cmp_key(v) > _cmp_key(value))

    def gte(self, column, value):
        return self._filter(column, lambda v: _cmp_key(v) >= _cmp_key(value))

    def lte(self, column, value):
        return self._filter(column, lambda v: _cmp_key(v) <= _cmp_key(value))

    def in_(self, column, values):
        allowed = set(values)
        return self._filter(column, lambda v: v in allowed)

    def order(self, column, desc=False):
        self.orders.append((column, desc))
        return self

    def range(self, start, end):
        self.offset = start
        self.lim = end - start + 1
        return self

    def limit(self, size):
        self.lim = size
        return self

    def execute(self):
        self.db.calls[self.name] += 1
        if self.name in self.db.fail:
            raise RuntimeError(f"{self.name} unavailable")
        rows = [r for r in self.db.tables.get(self.name, []) if all(f(r) for f in self.filters)]
        for column, desc in reversed(self.orders):
            rows.sort(key=lambda r, c=column: _cmp_key(r.get(c)), reverse=desc)
        total = len(rows)
        rows = rows[self.offset:]
        if self.lim is not None:
            rows = rows[: self.lim]
        rows = rows[: self.CAP]
        if self.columns.strip() != "*":
            cols = [c.strip() for c in self.columns.split(",")]
            rows = [{c: r[c] for c in cols if c in r} for r in rows]
        return _Result(copy.deepcopy(rows), total if self.count else None)


class _Rpc:
    def __init__(self, db, name, params):
        self.db = db
        self.name = name
        self.params = params

    def execute(self):
        self.db.calls["rpc:" + self.name] += 1
        if "rpc" in self.db.fail:
            raise RuntimeError("rpc unavailable")
        assert self.name == "latest_congestion_for_facilities"
        ids = set(self.params["facility_ids"])
        latest: dict[str, dict] = {}
        for log in sorted(self.db.logs, key=lambda r: (r["timestamp"], r["id"]), reverse=True):
            if log["facility_id"] not in ids or log["facility_id"] in latest:
                continue
            if log["evidence_tier"] not in _TRUSTED_TIERS or log["source"] in _EXCLUDED_SOURCES:
                continue
            latest[log["facility_id"]] = {
                k: log[k] for k in
                ("facility_id", "congestion_level", "current_count", "timestamp", "source", "evidence_tier")
            }
        return _Result(copy.deepcopy(list(latest.values())[:1000]))


class FakeDB:
    def __init__(self, facilities, refs=(), logs=(), availability=()):
        self.tables = {
            "facilities": [dict(r) for r in facilities],
            "facility_source_refs": [dict(r) for r in refs],
            "facility_availability_reports": [dict(r) for r in availability],
        }
        self.logs = [dict(r) for r in logs]
        self.calls: Counter = Counter()
        self.fail: set[str] = set()

    def table(self, name):
        return _Query(self, name)

    def rpc(self, name, params):
        return _Rpc(self, name, params)


# =============================================================================
# 픽스처 데이터
# =============================================================================

def _fid(i: int) -> str:
    return f"00000000-0000-4000-8000-{i:012d}"


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _facility(i: int, **overrides) -> dict:
    row = {
        "id": _fid(i), "name": f"시설{i}", "type": "cafe",
        "latitude": 35.83 + i * 0.0001, "longitude": 129.21,
        "capacity": 40, "operating_hours": {"open": "09:00~21:00"},
        "features": {"category": "카페"}, "created_at": "2026-07-01T00:00:00+00:00",
        "updated_at": "2026-09-01T00:00:00+00:00", "is_active": True, "coupon_rate": 0.1,
        "image_url": None, "contentid": None, "contenttypeid": None, "gallery_images": None,
        "address": None, "phone": None, "homepage": None, "overview": None, "barrier_free": None,
    }
    row.update(overrides)
    return row


def _golden_db(now: datetime) -> FakeDB:
    facilities = [
        _facility(1, contentid="1001", contenttypeid=39, image_url="https://img/1.jpg",
                  features={"category": "카페", "seat_status": {"level": "few"},
                            "discovery_source": "x", "tagging_source": "y", "coordinate_source": "z"},
                  gallery_images=[1, "", "https://img/g1.jpg"], address="경주시 포석로",
                  overview="한옥 카페", barrier_free=True, homepage="https://h", phone="054"),
        _facility(2, features={"source": "kakao_discovery", "discovery_updated_at": "2026-09-10T00:00:00+00:00"}),
        _facility(3, type="restaurant", contentid="1003", contenttypeid=39, operating_hours=None),
        _facility(4, latitude=35.90),                        # REGION 밖(북쪽)
        _facility(5, type="restaurant", longitude=129.25),   # REGION 밖(동쪽)
        _facility(6, is_active=False),                       # 비활성 — 어느 경로에도 없다
        _facility(7, type="attraction", features=None, gallery_images="not-a-list"),
        _facility(8, type="culture", latitude=35.85, longitude=129.19),  # 경계값(포함)
    ] + [_facility(i, type="cafe" if i % 2 else "restaurant") for i in range(9, 30)]
    refs = [
        {"id": _fid(900), "facility_id": _fid(3), "source": "localdata", "source_updated_at": "2026-09-20T00:00:00+00:00"},
        {"id": _fid(901), "facility_id": _fid(3), "source": "tourapi", "source_updated_at": "2026-09-19T00:00:00+00:00"},
        {"id": _fid(902), "facility_id": _fid(9), "source": "tourapi", "source_updated_at": "2026-09-18T00:00:00+00:00"},
        {"id": _fid(903), "facility_id": _fid(6), "source": "localdata", "source_updated_at": "2026-09-18T00:00:00+00:00"},
        {"id": _fid(904), "facility_id": _fid(9999), "source": "localdata", "source_updated_at": "2026-09-18T00:00:00+00:00"},
    ]
    logs = [
        # f1: 10분 전 corroborated → is_current True, 그 전 로그는 무시
        {"id": _fid(1001), "facility_id": _fid(1), "congestion_level": 0.7, "current_count": 28,
         "timestamp": _iso(now - timedelta(minutes=10)), "source": "user_report", "evidence_tier": "corroborated"},
        {"id": _fid(1002), "facility_id": _fid(1), "congestion_level": 0.2, "current_count": 8,
         "timestamp": _iso(now - timedelta(hours=3)), "source": "user_report", "evidence_tier": "corroborated"},
        # f2: 2시간 전 단건 → is_current False, is_stale False
        {"id": _fid(1003), "facility_id": _fid(2), "congestion_level": 0.5, "current_count": 20,
         "timestamp": _iso(now - timedelta(hours=2)), "source": "user_report", "evidence_tier": "single_report"},
        # f3: 30시간 전 verified → is_stale True
        {"id": _fid(1004), "facility_id": _fid(3), "congestion_level": 0.9, "current_count": 36,
         "timestamp": _iso(now - timedelta(hours=30)), "source": "merchant_report", "evidence_tier": "verified"},
        # f4: 시뮬 로그는 RPC 가 거른다
        {"id": _fid(1005), "facility_id": _fid(4), "congestion_level": 0.9, "current_count": 1,
         "timestamp": _iso(now - timedelta(minutes=1)), "source": "simulated", "evidence_tier": "single_report"},
        # f5: CCTV — 실제 인원수가 나간다
        {"id": _fid(1006), "facility_id": _fid(5), "congestion_level": 0.4, "current_count": 17,
         "timestamp": _iso(now - timedelta(minutes=5)), "source": "traffic_cctv", "evidence_tier": "verified"},
        # f9: 'Z' 표기 · 5분 전
        {"id": _fid(1007), "facility_id": _fid(9), "congestion_level": 0.1, "current_count": 0,
         "timestamp": (now - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
         "source": "admin_override", "evidence_tier": "single_report"},
    ]
    availability = [
        # f1: 유효(2인 교차확인, 1시간 뒤 만료)
        {"id": _fid(2001), "facility_id": _fid(1), "status": "open", "evidence_tier": "corroborated",
         "corroborating_count": 2, "reported_at": _iso(now - timedelta(minutes=3)), "expires_at": _iso(now + timedelta(hours=1))},
        # f2: 이미 만료 → 없음
        {"id": _fid(2002), "facility_id": _fid(2), "status": "closed", "evidence_tier": "corroborated",
         "corroborating_count": 2, "reported_at": _iso(now - timedelta(hours=2)), "expires_at": _iso(now - timedelta(minutes=1))},
        # f3: 최신 행은 count 1(무효) → 그다음 유효 행이 선택된다
        {"id": _fid(2003), "facility_id": _fid(3), "status": "open", "evidence_tier": "corroborated",
         "corroborating_count": 1, "reported_at": _iso(now - timedelta(minutes=1)), "expires_at": _iso(now + timedelta(hours=2))},
        {"id": _fid(2004), "facility_id": _fid(3), "status": "closed", "evidence_tier": "corroborated",
         "corroborating_count": 3, "reported_at": _iso(now - timedelta(minutes=20)), "expires_at": _iso(now + timedelta(minutes=40))},
        # f5: 단건 tier — 조회 자체에서 빠진다
        {"id": _fid(2005), "facility_id": _fid(5), "status": "open", "evidence_tier": "single_report",
         "corroborating_count": 1, "reported_at": _iso(now - timedelta(minutes=1)), "expires_at": _iso(now + timedelta(hours=1))},
    ]
    return FakeDB(facilities, refs, logs, availability)


@pytest.fixture
def snapshot_mode(monkeypatch):
    monkeypatch.setattr(settings, "REFERENCE_SNAPSHOT_SERVE", "snapshot")
    yield


def _install(monkeypatch, db: FakeDB) -> None:
    """실시간 경로와 스냅샷이 **같은** 페이크를 읽게 한다."""
    monkeypatch.setattr(infrastructures, "supabase_client", db)
    monkeypatch.setattr(availability_service, "supabase_admin", db)
    monkeypatch.setattr(rs, "supabase_client", db)
    monkeypatch.setattr(rs, "supabase_admin", db)


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(infrastructures.router)
    return TestClient(app)


_PARAM_SETS = [
    {},
    {"min_lat": 35.82, "max_lat": 35.85, "min_lng": 129.19, "max_lng": 129.24},  # 웹의 REGION.bounds
    {"type": "cafe"},
    {"type": "restaurant", "min_lat": 35.83, "max_lng": 129.22},
    {"type": ""},
    {"min_lat": 36.5},                                                               # 아무것도 없음
    {"type": "culture", "max_lat": 35.85, "min_lng": 129.19},                         # 경계값 포함
]


# =============================================================================
# 골든 — 스냅샷 바이트 == 실시간 경로
# =============================================================================

@pytest.mark.parametrize("params", _PARAM_SETS)
def test_snapshot_bytes_equal_the_live_path(monkeypatch, snapshot_mode, params):
    now = datetime.now(timezone.utc)
    db = _golden_db(now)
    _install(monkeypatch, db)
    client = _client()

    monkeypatch.setattr(settings, "REFERENCE_SNAPSHOT_SERVE", "legacy")
    live = client.get("/api/v1/infrastructures", params=params)
    assert live.status_code == 200
    assert "etag" not in live.headers

    monkeypatch.setattr(settings, "REFERENCE_SNAPSHOT_SERVE", "snapshot")
    asyncio.run(rs.refresh_once())
    snap = client.get("/api/v1/infrastructures", params=params)
    assert snap.status_code == 200
    assert snap.headers["etag"].startswith('"')
    assert snap.headers["content-type"] == "application/json"

    assert snap.json() == live.json()
    # 바이트까지 같다 — 같은 pydantic 직렬화기, 같은 필드 순서, 같은 행 순서(둘 다 id 로 정렬해 읽는다).
    assert snap.content == live.content


def test_golden_fixture_really_exercises_the_interesting_cases(monkeypatch, snapshot_mode):
    """위 골든 비교가 빈 비교가 되지 않게 — 픽스처가 실제로 각 분기를 태우는지 확인한다."""
    now = datetime.now(timezone.utc)
    _install(monkeypatch, _golden_db(now))
    asyncio.run(rs.refresh_once())
    body = {r["id"]: r for r in _client().get("/api/v1/infrastructures").json()}

    assert _fid(6) not in body                                      # 비활성
    assert body[_fid(1)]["congestion"]["is_current"] is True
    assert body[_fid(1)]["congestion"]["current_count"] is None     # 제보는 인원수를 내지 않는다
    assert body[_fid(1)]["availability_evidence"]["status"] == "open"
    assert body[_fid(1)]["gallery_images"] == ["https://img/g1.jpg"]
    assert "discovery_source" not in body[_fid(1)]["features"]
    assert body[_fid(1)]["place_data_source"] == "tourapi"
    assert body[_fid(2)]["congestion"]["is_current"] is False
    assert body[_fid(2)]["availability_evidence"] is None           # 만료
    assert body[_fid(2)]["place_data_source"] == "kakao"
    assert body[_fid(3)]["congestion"]["is_stale"] is True
    assert body[_fid(3)]["availability_evidence"]["status"] == "closed"
    assert body[_fid(3)]["place_data_source"] == "localdata"
    assert body[_fid(4)]["congestion"] is None                      # 시뮬 로그는 거른다
    assert body[_fid(5)]["congestion"]["current_count"] == 17
    assert body[_fid(7)]["gallery_images"] is None


def test_region_body_is_built_eagerly_and_reused_without_per_request_work(monkeypatch, snapshot_mode):
    _install(monkeypatch, _golden_db(datetime.now(timezone.utc)))
    asyncio.run(rs.refresh_once())
    view = rs._refresher.view
    assert view._region is not None                     # 스왑 직후 미리 조립

    first = asyncio.run(rs.map_payload(rs.REGION_KEY))
    second = asyncio.run(rs.map_payload(rs.REGION_KEY))
    assert first.body is second.body                    # 같은 바이트 객체 — 요청당 조립·할당 없음
    assert first.etag == second.etag


def test_lru_keeps_only_a_few_other_filter_sets(monkeypatch, snapshot_mode):
    _install(monkeypatch, _golden_db(datetime.now(timezone.utc)))
    asyncio.run(rs.refresh_once())
    for i in range(10):
        asyncio.run(rs.map_payload(rs.MapKey.of(min_lat=35.0 + i / 100)))
    assert len(rs._refresher.view._lru) == rs.MAP_LRU_SIZE


# =============================================================================
# ETag / 304 / 헤더
# =============================================================================

def test_etag_revalidation_returns_304_including_weak_tags(monkeypatch, snapshot_mode):
    _install(monkeypatch, _golden_db(datetime.now(timezone.utc)))
    asyncio.run(rs.refresh_once())
    client = _client()
    params = _PARAM_SETS[1]

    first = client.get("/api/v1/infrastructures", params=params)
    etag = first.headers["etag"]
    assert first.headers["cache-control"] == "private, no-cache"
    assert int(first.headers["x-snapshot-age"]) >= 0

    for header in (etag, f"W/{etag}", f'"other", {etag}', "*"):
        res = client.get("/api/v1/infrastructures", params=params, headers={"If-None-Match": header})
        assert res.status_code == 304, header
        assert res.content == b""
        assert res.headers["etag"] == etag

    miss = client.get("/api/v1/infrastructures", params=params, headers={"If-None-Match": '"stale"'})
    assert miss.status_code == 200
    assert miss.content == first.content


def test_etag_is_a_content_hash_stable_across_rebuilds(monkeypatch, snapshot_mode):
    """ETag 는 본문 해시 — 같은 데이터로 다시 만들어도(재시작 포함) 같은 ETag 라 브라우저가 304 를 받는다."""
    db = _golden_db(datetime.now(timezone.utc))
    _install(monkeypatch, db)
    asyncio.run(rs.refresh_once())
    etag1 = asyncio.run(rs.map_payload(rs.NO_FILTER)).etag
    rs.reset_for_tests()
    asyncio.run(rs.refresh_once())
    assert asyncio.run(rs.map_payload(rs.NO_FILTER)).etag == etag1


# =============================================================================
# 유효 구간(B1) — 뒤집힘이 지나면 재조립 후 낸다
# =============================================================================

def _flip_db(t0: datetime) -> FakeDB:
    facilities = [_facility(1), _facility(2), _facility(3)]
    logs = [
        # 29분 전 corroborated → 1분 뒤 is_current False
        {"id": _fid(1001), "facility_id": _fid(1), "congestion_level": 0.6, "current_count": 1,
         "timestamp": _iso(t0 - timedelta(minutes=29)), "source": "user_report", "evidence_tier": "corroborated"},
        # 23시간 58분 전 → 2분 뒤 is_stale True
        {"id": _fid(1002), "facility_id": _fid(2), "congestion_level": 0.3, "current_count": 1,
         "timestamp": _iso(t0 - timedelta(hours=23, minutes=58)), "source": "user_report", "evidence_tier": "single_report"},
    ]
    availability = [
        {"id": _fid(2001), "facility_id": _fid(3), "status": "open", "evidence_tier": "corroborated",
         "corroborating_count": 2, "reported_at": _iso(t0 - timedelta(minutes=5)), "expires_at": _iso(t0 + timedelta(minutes=3))},
    ]
    return FakeDB(facilities, (), logs, availability)


def _body(payload) -> dict:
    return {r["id"]: r for r in json.loads(payload.body)}


def test_validity_flips_rebuild_before_serving(monkeypatch, snapshot_mode):
    t0 = datetime(2026, 9, 27, 3, 0, tzinfo=timezone.utc)
    clock = {"now": t0}
    monkeypatch.setattr(rs, "_utcnow", lambda: clock["now"])
    _install(monkeypatch, _flip_db(t0))
    asyncio.run(rs.refresh_once())

    p0 = asyncio.run(rs.map_payload(rs.NO_FILTER))
    b0 = _body(p0)
    assert b0[_fid(1)]["congestion"]["is_current"] is True
    assert b0[_fid(2)]["congestion"]["is_stale"] is False
    assert b0[_fid(3)]["availability_evidence"]["status"] == "open"
    view = rs._refresher.view
    assert view.valid_until == t0 - timedelta(minutes=29) + timedelta(minutes=30, microseconds=1)

    # 정확히 30분 경계(나이 == 30분)까지는 아직 '지금' 이다 — 1µs 뒤부터 아니다.
    clock["now"] = t0 + timedelta(minutes=1)
    assert _body(asyncio.run(rs.map_payload(rs.NO_FILTER)))[_fid(1)]["congestion"]["is_current"] is True
    clock["now"] = t0 + timedelta(minutes=1, microseconds=1)
    p1 = asyncio.run(rs.map_payload(rs.NO_FILTER))
    b1 = _body(p1)
    assert b1[_fid(1)]["congestion"]["is_current"] is False
    assert b1[_fid(2)]["congestion"]["is_stale"] is False
    assert p1.etag != p0.etag

    clock["now"] = t0 + timedelta(minutes=2, seconds=1)
    b2 = _body(asyncio.run(rs.map_payload(rs.NO_FILTER)))
    assert b2[_fid(2)]["congestion"]["is_stale"] is True
    assert b2[_fid(3)]["availability_evidence"]["status"] == "open"

    clock["now"] = t0 + timedelta(minutes=3)                      # expires_at 도달 — 더는 유효하지 않다
    b3 = _body(asyncio.run(rs.map_payload(rs.NO_FILTER)))
    assert b3[_fid(3)]["availability_evidence"] is None
    assert rs._refresher.view.valid_until is not None             # f2 의 다음 판정은 없지만 f1 의 24h 는 남았다


def test_validity_flip_matches_the_live_path_at_the_same_instant(monkeypatch, snapshot_mode):
    """뒤집힘 뒤 재조립한 바이트가 그 시각의 실시간 판정과 같다(판정 함수 한 벌)."""
    t0 = datetime(2026, 9, 27, 3, 0, tzinfo=timezone.utc)
    clock = {"now": t0}
    monkeypatch.setattr(rs, "_utcnow", lambda: clock["now"])
    _install(monkeypatch, _flip_db(t0))
    asyncio.run(rs.refresh_once())
    clock["now"] = t0 + timedelta(minutes=1, seconds=30)
    snap = _body(asyncio.run(rs.map_payload(rs.NO_FILTER)))

    row = _flip_db(t0).logs[0]
    live = infrastructures._congestion_info(row, now=clock["now"])
    assert snap[_fid(1)]["congestion"]["is_current"] == live["is_current"] is False


def test_flips_are_punctual_even_while_the_loader_thread_is_stalled(monkeypatch, snapshot_mode):
    """레드팀 B1: 적재가 Supabase 에 묶여 있어도(전용 스레드 정지) '지금' 판정은 제시각에 뒤집힌다."""
    import threading

    t0 = datetime(2026, 9, 27, 3, 0, tzinfo=timezone.utc)
    clock = {"now": t0}
    monkeypatch.setattr(rs, "_utcnow", lambda: clock["now"])
    db = _flip_db(t0)
    _install(monkeypatch, db)
    asyncio.run(rs.refresh_once())

    release = threading.Event()
    original_rpc = db.rpc

    def _stalled_rpc(name, params):
        release.wait(5)
        return original_rpc(name, params)

    monkeypatch.setattr(db, "rpc", _stalled_rpc)

    async def _scenario():
        refresh = asyncio.create_task(rs._refresher.refresh_overlay())
        await asyncio.sleep(0.05)                          # 적재 스레드가 RPC 에서 멈춰 있다
        assert not refresh.done()
        clock["now"] = t0 + timedelta(minutes=1, seconds=1)
        started = time.monotonic()
        payload = await rs.map_payload(rs.NO_FILTER)
        assert time.monotonic() - started < 0.5            # 적재를 기다리지 않는다
        assert _body(payload)[_fid(1)]["congestion"]["is_current"] is False
        release.set()
        await refresh

    asyncio.run(_scenario())


def test_concurrent_requests_at_a_flip_recompute_once(monkeypatch, snapshot_mode):
    t0 = datetime(2026, 9, 27, 3, 0, tzinfo=timezone.utc)
    clock = {"now": t0}
    monkeypatch.setattr(rs, "_utcnow", lambda: clock["now"])
    _install(monkeypatch, _flip_db(t0))
    asyncio.run(rs.refresh_once())

    calls = Counter()
    original = rs._facility_fragments

    def _spy(*args, **kwargs):
        calls["n"] += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(rs, "_facility_fragments", _spy)
    clock["now"] = t0 + timedelta(minutes=1, seconds=5)

    async def _burst():
        return await asyncio.gather(*[rs.map_payload(rs.NO_FILTER) for _ in range(25)])

    payloads = asyncio.run(_burst())
    assert calls["n"] == 1                                  # 뒤집힌 시설 하나만, 한 번만
    assert len({p.etag for p in payloads}) == 1
    assert len({id(p.body) for p in payloads}) == 1


# =============================================================================
# 부팅(B2) — 한 번도 못 만들었으면 실시간 경로
# =============================================================================

def test_never_built_serves_the_live_path(monkeypatch, snapshot_mode):
    now = datetime.now(timezone.utc)
    _install(monkeypatch, _golden_db(now))
    res = _client().get("/api/v1/infrastructures")
    assert res.status_code == 200
    assert "etag" not in res.headers                         # 실시간 경로가 답했다
    assert len(res.json()) == 28


def test_snapshot_down_at_boot_then_supabase_recovers(monkeypatch, snapshot_mode):
    """부팅 때 Supabase 가 죽어 있으면 실시간 경로도 실패(도입 전과 같은 500)하고, 살아나면 둘 다 복구된다."""
    db = _golden_db(datetime.now(timezone.utc))
    db.fail = {"facilities"}
    _install(monkeypatch, db)
    client = _client()
    asyncio.run(rs.refresh_once())
    assert rs.health()["ready"] is False
    assert client.get("/api/v1/infrastructures").status_code == 500   # 도입 전과 같다(새 503 없음)

    db.fail = set()
    asyncio.run(rs.refresh_once())
    res = client.get("/api/v1/infrastructures")
    assert res.status_code == 200 and "etag" in res.headers


def test_backoff_is_capped_until_the_first_build(monkeypatch):
    refresher = rs._Refresher()
    for _ in range(10):
        refresher._fail("base", RuntimeError("down"))
    assert refresher.parts["base"].next_due - time.monotonic() <= rs.BACKOFF_MAX_BEFORE_READY_S + 0.5

    refresher.view = object()          # 한 번이라도 만들었으면 긴 백오프를 쓴다
    for _ in range(10):
        refresher._fail("base", RuntimeError("down"))
    assert refresher.parts["base"].next_due - time.monotonic() > rs.BACKOFF_MAX_BEFORE_READY_S


def test_request_kick_is_rate_limited(monkeypatch):
    refresher = rs._Refresher()
    refresher._started = True
    far = time.monotonic() + 1000
    refresher.parts["base"].next_due = far
    refresher.kick()
    assert refresher.parts["base"].next_due <= time.monotonic()

    refresher.parts["base"].next_due = far
    refresher.kick()                    # 5초 안의 두 번째 요청은 적재를 다시 깨우지 않는다
    assert refresher.parts["base"].next_due == far


def test_live_path_is_tried_first_when_snapshot_is_stale_and_last_good_saves_a_failure(monkeypatch, snapshot_mode):
    db = _golden_db(datetime.now(timezone.utc))
    _install(monkeypatch, db)
    asyncio.run(rs.refresh_once())
    client = _client()
    good = client.get("/api/v1/infrastructures")
    assert "etag" in good.headers

    # 오버레이를 11분 동안 확인하지 못했다 → 실시간을 먼저 시도한다.
    rs._refresher.parts["overlay"].ok_at = time.monotonic() - rs.OVERLAY_STALE_AFTER_S - 60
    live = client.get("/api/v1/infrastructures")
    assert live.status_code == 200 and "etag" not in live.headers

    # 실시간마저 실패하면 500 대신 마지막 정상본을 낸다(나이를 헤더로 밝힌다).
    db.fail = {"facilities"}
    saved = client.get("/api/v1/infrastructures")
    assert saved.status_code == 200
    assert saved.content == good.content
    assert int(saved.headers["x-snapshot-age"]) > rs.OVERLAY_STALE_AFTER_S


def test_legacy_switch_disables_the_refresher(monkeypatch):
    monkeypatch.setattr(settings, "REFERENCE_SNAPSHOT_SERVE", "legacy")

    async def _scenario():
        rs.start()
        assert rs._refresher._task is None
        assert await rs.map_payload(rs.NO_FILTER) is None

    asyncio.run(_scenario())
    assert rs.health()["serve"] == "legacy"


# =============================================================================
# 실패 · 마지막 정상본 · 건전성 관문
# =============================================================================

def test_refresh_failures_keep_the_last_good_snapshot(monkeypatch, snapshot_mode):
    db = _golden_db(datetime.now(timezone.utc))
    _install(monkeypatch, db)
    asyncio.run(rs.refresh_once())
    before = asyncio.run(rs.map_payload(rs.NO_FILTER))

    db.fail = {"facilities", "rpc", "facility_availability_reports"}
    db.tables["facilities"] = []                  # 설령 읽혔어도 비어 있을 상황
    asyncio.run(rs.refresh_once())                # 탐침 실패(베이스는 다시 읽지 않는다) + 오버레이 실패
    rs._refresher._last_full_load -= rs.BASE_BACKSTOP_S
    asyncio.run(rs._refresher.refresh_base())     # 30분 전량 재적재도 실패

    after = asyncio.run(rs.map_payload(rs.NO_FILTER))
    assert after.etag == before.etag
    health = rs.health()
    assert health["ready"] is True
    assert health["base"]["failures"] == 1 and health["base"]["last_error"] == "RuntimeError"
    assert health["overlay"]["failures"] == 1


def test_availability_failure_alone_keeps_last_good_availability_and_fresh_congestion(monkeypatch, snapshot_mode):
    now = datetime.now(timezone.utc)
    db = _golden_db(now)
    _install(monkeypatch, db)
    asyncio.run(rs.refresh_once())

    db.fail = {"facility_availability_reports"}
    db.logs.append({"id": _fid(1999), "facility_id": _fid(2), "congestion_level": 0.95, "current_count": 1,
                    "timestamp": _iso(now), "source": "user_report", "evidence_tier": "single_report"})
    asyncio.run(rs._refresher.refresh_overlay())

    body = _body(asyncio.run(rs.map_payload(rs.NO_FILTER)))
    assert body[_fid(2)]["congestion"]["level"] == 0.95                  # 혼잡은 새 값
    assert body[_fid(1)]["availability_evidence"]["status"] == "open"     # 영업 근거는 정상본
    overlay = rs.health()["overlay"]
    # 영업 근거 장애가 혼잡 갱신 주기를 백오프로 끌고 가지 않는다(실패로 세지 않고 오류만 남긴다).
    assert overlay["failures"] == 0
    assert overlay["last_error"] == "availability:RuntimeError"
    assert rs._refresher.parts["overlay"].next_due - time.monotonic() > rs.OVERLAY_INTERVAL_S - 5


def test_first_overlay_without_congestion_is_not_ready(monkeypatch, snapshot_mode):
    db = _golden_db(datetime.now(timezone.utc))
    db.fail = {"rpc"}
    _install(monkeypatch, db)
    asyncio.run(rs.refresh_once())
    assert rs._refresher.base is not None
    assert rs.health()["ready"] is False                     # '혼잡 없음' 으로 준비된 척하지 않는다
    assert asyncio.run(rs.map_payload(rs.NO_FILTER)) is None


def test_sanity_gate_holds_a_sudden_drop_until_two_loads_agree(monkeypatch, snapshot_mode):
    facilities = [_facility(i) for i in range(1, 101)]
    db = FakeDB(facilities)
    _install(monkeypatch, db)
    asyncio.run(rs.refresh_once())
    assert len(rs.current_base().ids) == 100

    db.tables["facilities"] = facilities[:70]               # 30% 감소
    asyncio.run(rs._refresher.refresh_base())
    assert len(rs.current_base().ids) == 100               # 한 번은 믿지 않는다
    assert rs._refresher.parts["base"].hold_until > time.monotonic()

    asyncio.run(rs._refresher.refresh_base())               # 같은 수가 두 번 — 받아들인다
    assert len(rs.current_base().ids) == 70

    db.tables["facilities"] = facilities[:65]               # 20% 안쪽 감소는 바로 받는다
    asyncio.run(rs._refresher.refresh_base())
    assert len(rs.current_base().ids) == 65


def test_sanity_gate_never_accepts_an_empty_base_over_a_good_one(monkeypatch, snapshot_mode):
    db = FakeDB([_facility(i) for i in range(1, 11)])
    _install(monkeypatch, db)
    asyncio.run(rs.refresh_once())
    db.tables["facilities"] = []
    for _ in range(3):
        asyncio.run(rs._refresher.refresh_base())
    assert len(rs.current_base().ids) == 10


def test_probe_skips_the_full_reload_when_nothing_changed(monkeypatch, snapshot_mode):
    db = _golden_db(datetime.now(timezone.utc))
    _install(monkeypatch, db)
    asyncio.run(rs.refresh_once())
    loads = db.calls["facilities"]

    asyncio.run(rs._refresher.refresh_base())
    assert db.calls["facilities"] == loads + 1              # 탐침 1회뿐(전량 재적재 없음)

    db.tables["facilities"][0]["updated_at"] = "2026-09-27T00:00:00+00:00"
    db.tables["facilities"][0]["name"] = "바뀐 이름"
    asyncio.run(rs._refresher.refresh_base())
    assert db.calls["facilities"] > loads + 2               # 탐침이 변화를 보고 전량 재적재
    assert _body(asyncio.run(rs.map_payload(rs.NO_FILTER)))[_fid(1)]["name"] == "바뀐 이름"


def test_a_broken_probe_neither_blocks_the_first_build_nor_forces_minutely_reloads(monkeypatch, snapshot_mode):
    """탐침(count + 최신 updated_at)만 실패하면: 첫 적재는 진행하고, 이후에는 매분 2MB 전량 재적재 대신
    30분 전량 재적재를 기다린다. 확인 못 한 시간은 ok_at 에 쌓여 '오래됨' 판정으로 이어진다."""
    db = _golden_db(datetime.now(timezone.utc))
    _install(monkeypatch, db)

    def _broken_probe():
        raise RuntimeError("permission denied for column updated_at")

    monkeypatch.setattr(rs, "_probe", _broken_probe)
    asyncio.run(rs.refresh_once())
    assert rs.health()["ready"] is True
    ok_at = rs._refresher.parts["base"].ok_at
    loads = db.calls["facilities"]

    asyncio.run(rs._refresher.refresh_base())
    base = rs.health()["base"]
    assert db.calls["facilities"] == loads                  # 다시 읽지 않았다
    assert base["failures"] == 0 and base["last_error"] == "probe:RuntimeError"
    assert rs._refresher.parts["base"].ok_at == ok_at       # 확인하지 못한 시간은 나이로 쌓인다

    rs._refresher._last_full_load -= rs.BASE_BACKSTOP_S     # 30분이 지났다 → 탐침 없이 전량
    asyncio.run(rs._refresher.refresh_base())
    assert db.calls["facilities"] > loads
    assert rs._refresher.parts["base"].ok_at >= ok_at
    assert rs.health()["base"]["failures"] == 0


def test_invalid_rows_are_dropped_and_logged_instead_of_failing_the_map(monkeypatch, snapshot_mode):
    """실시간 경로는 모델 검증에 실패하는 행 하나로 요청 전체가 500 이었다. 스냅샷은 그 행만 뺀다."""
    facilities = [_facility(1), _facility(2, features="not-a-dict"), _facility(3, capacity=None)]
    _install(monkeypatch, FakeDB(facilities))
    client = _client()
    monkeypatch.setattr(settings, "REFERENCE_SNAPSHOT_SERVE", "legacy")
    assert client.get("/api/v1/infrastructures").status_code == 500      # 도입 전 동작

    monkeypatch.setattr(settings, "REFERENCE_SNAPSHOT_SERVE", "snapshot")
    asyncio.run(rs.refresh_once())
    res = client.get("/api/v1/infrastructures")
    assert res.status_code == 200
    assert [r["id"] for r in res.json()] == [_fid(1)]
    assert rs.health()["base"]["dropped"] == 2


def test_keyset_pagination_reads_every_row_past_the_cap(monkeypatch, snapshot_mode):
    facilities = [_facility(i) for i in range(2500)]
    refs = [{"id": _fid(10_000 + i), "facility_id": _fid(i), "source": "localdata", "source_updated_at": "x"}
            for i in range(2500)]
    db = FakeDB(facilities, refs)
    _install(monkeypatch, db)
    asyncio.run(rs.refresh_once())
    base = rs.current_base()
    assert len(base.ids) == 2500
    body = json.loads(asyncio.run(rs.map_payload(rs.NO_FILTER)).body)
    assert len(body) == 2500
    assert all(r["place_data_source"] == "localdata" for r in body)
    # 최신 혼잡 RPC 는 1000개씩 나눠 부른다(RPC 결과도 1000행 상한 — 결과는 시설당 최대 1행).
    assert db.calls["rpc:latest_congestion_for_facilities"] == 3


# =============================================================================
# 갱신 루프 — mark_dirty 디바운스 · 쓰기 직후 반영 · 감독 재시작
# =============================================================================

async def _wait_until(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("timed out")
        await asyncio.sleep(0.01)


def test_mark_dirty_is_debounced_into_one_overlay_refresh(monkeypatch, snapshot_mode):
    monkeypatch.setattr(rs, "DEBOUNCE_S", 0.2)
    db = _golden_db(datetime.now(timezone.utc))
    _install(monkeypatch, db)

    async def _scenario():
        rs.start()
        try:
            await _wait_until(lambda: rs.health()["ready"])
            before = db.calls["rpc:latest_congestion_for_facilities"]
            for _ in range(5):
                rs.mark_dirty("congestion")
                rs.mark_dirty("availability")
            await asyncio.sleep(0.1)
            assert db.calls["rpc:latest_congestion_for_facilities"] == before     # 아직 디바운스 중
            await asyncio.sleep(0.5)
            assert db.calls["rpc:latest_congestion_for_facilities"] == before + 1  # 열 번의 알림 → 한 번
        finally:
            await rs.stop()

    asyncio.run(_scenario())


def test_next_map_request_after_a_write_sees_the_write(monkeypatch, snapshot_mode):
    """도입 전엔 다음 지도 요청이 DB 를 읽어 방금 쓴 제보가 바로 보였다 — 그 체감을 지킨다."""
    now = datetime.now(timezone.utc)
    db = _golden_db(now)
    _install(monkeypatch, db)

    async def _scenario():
        rs.start()
        try:
            await _wait_until(lambda: rs.health()["ready"])
            db.logs.append({"id": _fid(1998), "facility_id": _fid(7), "congestion_level": 0.33, "current_count": 1,
                            "timestamp": _iso(datetime.now(timezone.utc)), "source": "user_report",
                            "evidence_tier": "single_report"})
            rs.mark_dirty("congestion")
            started = time.monotonic()
            payload = await rs.map_payload(rs.NO_FILTER)
            assert time.monotonic() - started < rs.DIRTY_WAIT_S + 0.5
            assert _body(payload)[_fid(7)]["congestion"]["level"] == 0.33
        finally:
            await rs.stop()

    asyncio.run(_scenario())


def test_facility_write_refreshes_the_base(monkeypatch, snapshot_mode):
    db = _golden_db(datetime.now(timezone.utc))
    _install(monkeypatch, db)

    async def _scenario():
        rs.start()
        try:
            await _wait_until(lambda: rs.health()["ready"])
            # 좌석 방송: features 만 바뀐다(탐침이 못 볼 만큼 빠른 쓰기라도 mark_dirty 가 강제 재적재).
            db.tables["facilities"][0]["features"] = {"seat_status": {"level": "full"}}
            rs.mark_dirty("facilities")
            payload = await rs.map_payload(rs.NO_FILTER)
            assert _body(payload)[_fid(1)]["features"] == {"seat_status": {"level": "full"}}
        finally:
            await rs.stop()

    asyncio.run(_scenario())


def test_concurrent_requests_before_ready_trigger_a_single_build(monkeypatch, snapshot_mode):
    db = _golden_db(datetime.now(timezone.utc))
    _install(monkeypatch, db)

    async def _scenario():
        rs.start()
        try:
            results = await asyncio.gather(*[rs.map_payload(rs.NO_FILTER) for _ in range(30)])
            assert all(r is None for r in results)            # 준비 전 → 모두 실시간 경로로
            await _wait_until(lambda: rs.health()["ready"])
            # 첫 적재는 탐침 없이 keyset 1페이지 = 시설 표 1회. 30개의 요청이 적재를 30번 부르지 않았다.
            assert db.calls["facilities"] == 1
            assert db.calls["rpc:latest_congestion_for_facilities"] == 1
        finally:
            await rs.stop()

    asyncio.run(_scenario())


def test_refresher_survives_a_bad_iteration_and_is_restarted_if_it_dies(monkeypatch, snapshot_mode):
    monkeypatch.setattr(rs, "LOOP_ERROR_PAUSE_S", 0.01)
    db = _golden_db(datetime.now(timezone.utc))
    _install(monkeypatch, db)
    original = rs._Refresher._step
    state = {"boom": 1}

    async def _flaky(self):
        if state["boom"]:
            state["boom"] -= 1
            raise RuntimeError("bug in one iteration")
        await original(self)

    monkeypatch.setattr(rs._Refresher, "_step", _flaky)

    async def _scenario():
        rs.start()
        try:
            await _wait_until(lambda: rs.health()["ready"])       # 한 바퀴 실패 뒤에도 계속 돈다
            task = rs._refresher._task
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            assert task.done()
            await rs.map_payload(rs.NO_FILTER)                     # 요청 경로의 감독이 다시 띄운다
            assert rs._refresher._task is not task and not rs._refresher._task.done()
        finally:
            await rs.stop()

    asyncio.run(_scenario())


def test_mark_dirty_never_raises_and_accepts_calls_from_threads(monkeypatch):
    rs.mark_dirty("no-such-kind")                  # 경고만
    rs.mark_dirty("timesales")                     # 아직 스냅샷에 없다 — 아무것도 안 한다
    import threading

    threads = [threading.Thread(target=rs.mark_dirty, args=("congestion",)) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert rs._refresher._dirty_seq["overlay"] == 8
    assert rs._refresher._dirty_seq["base"] == 0


# =============================================================================
# 조각 — 필터 의미 · 헬스
# =============================================================================

def test_filters_follow_postgres_float_semantics():
    row = rs._MapRow(id="x", type="cafe", lat=35.85, lng=129.19, head=b"", mid=b"", tail=b"")
    assert rs._matches(row, rs.REGION_KEY)                               # 경계 포함(gte/lte)
    assert not rs._matches(row, rs.MapKey.of(type="restaurant"))
    assert rs._matches(row, rs.MapKey.of(type=""))                       # 빈 type 은 필터 없음
    nan_row = rs._MapRow(id="y", type="cafe", lat=math.nan, lng=129.2, head=b"", mid=b"", tail=b"")
    assert rs._matches(nan_row, rs.MapKey.of(min_lat=35.0))              # Postgres: NaN 은 모든 수보다 크다
    assert not rs._matches(nan_row, rs.MapKey.of(max_lat=36.0))


def test_health_is_exposed_on_the_health_endpoint(monkeypatch, snapshot_mode):
    from app.main import app

    _install(monkeypatch, _golden_db(datetime.now(timezone.utc)))
    asyncio.run(rs.refresh_once())
    body = TestClient(app).get("/health").json()
    assert body["status"] == "healthy"
    snap = body["reference_snapshot"]
    assert snap["ready"] is True and snap["serve"] == "snapshot"
    assert snap["base"]["active"] == 28 and snap["base"]["age_s"] is not None
    assert snap["overlay"]["congestion"] >= 1
