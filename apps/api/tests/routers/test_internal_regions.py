"""내부 지역 API(app/routers/internal_regions.py) — developer 전용 서울 시설·구역·지역 요약."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.core import authz
from app.main import app
from app.routers import internal_regions
from app.services.crowd import zone_evidence
from tests.conftest import role_headers
from tests.routers.test_region_isolation_public_reads import GJ_ID, facility_row
from tests.services.test_zone_evidence import ZoneDB

S1 = "00000000-0000-4000-8000-0000000000d1"
S2 = "00000000-0000-4000-8000-0000000000d2"
S_INACTIVE = "00000000-0000-4000-8000-0000000000d3"

PATHS = (
    "/api/v1/internal/regions",
    "/api/v1/internal/regions/seoul/infrastructures",
    "/api/v1/internal/regions/seoul/zones",
)


def _seoul_db() -> ZoneDB:
    now = datetime.now(timezone.utc)
    observed = now - timedelta(minutes=5)
    return ZoneDB(
        {
            "facilities": [
                facility_row(GJ_ID, region="gyeongju"),
                facility_row(S1, region="seoul", lat=37.5739, lng=126.9861, name="인사동 찻집"),
                facility_row(S2, region="seoul", lat=37.5540, lng=126.9213, type="restaurant"),
                facility_row(S_INACTIVE, region="seoul", lat=37.5741, lng=126.9862, is_active=False),
            ],
            "facility_source_refs": [],
            "zones": [
                {"zone_id": "seoul:POI078", "region": "seoul", "name": "인사동", "provider": "seoul_citydata",
                 "cluster": "jongno", "centroid_lat": 37.573863, "centroid_lng": 126.986063, "radius_m": 328},
                {"zone_id": "seoul:POI007", "region": "seoul", "name": "홍대 관광특구", "provider": "seoul_citydata",
                 "cluster": "hongdae", "centroid_lat": 37.553919, "centroid_lng": 126.921276, "radius_m": 634},
            ],
            "facility_zones": [
                {"facility_id": S1, "zone_id": "seoul:POI078", "weight": 1},
                {"facility_id": S_INACTIVE, "zone_id": "seoul:POI078", "weight": 1},
            ],
            "zone_crowd_snapshots": [
                {"zone_id": "seoul:POI078", "source": "seoul_citydata", "bucket_at": observed.isoformat(),
                 "observed_at": observed.isoformat(), "fetched_at": now.isoformat(),
                 "population_min": 100, "population_max": 200, "level": 0.625, "level_label": "약간 붐빔",
                 "level_scale": "seoul_congest_4",
                 "forecast": [{"target_at": (observed + timedelta(hours=1)).isoformat(), "level": 0.875,
                               "level_label": "붐빔"}],
                 "quality": {}},
            ],
            "congestion_logs": [{"facility_id": S1, "congestion_level": 0.1}],
        }
    )


@pytest.fixture
def seoul_db(monkeypatch):
    db = _seoul_db()
    monkeypatch.setattr(internal_regions, "supabase_admin", db)
    monkeypatch.setattr(zone_evidence, "supabase_admin", db)
    return db


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


# ── 접근 ───────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("path", PATHS)
def test_requires_a_session(client, seoul_db, path):
    assert client.get(path).status_code == 401


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize(
    "headers",
    [
        role_headers("tourist"),
        role_headers("merchant"),
        role_headers("admin"),
        role_headers("admin", email=authz.JUDGE_ADMIN_EMAIL),
        role_headers("tourist", is_anonymous=True),
        role_headers("developer", is_anonymous=True),
    ],
    ids=["tourist", "merchant", "admin", "judge_admin", "guest", "anonymous_developer"],
)
def test_non_developers_are_forbidden(client, seoul_db, path, headers):
    res = client.get(path, headers=headers)
    assert res.status_code == 403
    assert not seoul_db.queries  # 거부 전에 아무것도 읽지 않는다


@pytest.mark.parametrize("path", PATHS)
def test_developer_is_allowed_with_private_no_store(client, seoul_db, path):
    res = client.get(path, headers=role_headers("developer"))
    assert res.status_code == 200
    assert res.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize("region", ["gyeongju", "busan"])
@pytest.mark.parametrize("suffix", ["infrastructures", "zones"])
def test_non_internal_region_is_404(client, seoul_db, region, suffix):
    res = client.get(f"/api/v1/internal/regions/{region}/{suffix}", headers=role_headers("developer"))
    assert res.status_code == 404


# ── 지역 요약 ──────────────────────────────────────────────────────────────────


def test_regions_pack_is_built_server_side(client, seoul_db):
    body = client.get("/api/v1/internal/regions", headers=role_headers("developer")).json()
    (seoul,) = body["regions"]
    assert seoul["id"] == "seoul"
    assert seoul["names"] == {"ko": "서울", "en": "Seoul", "ja": "ソウル", "zh": "首尔"}
    assert seoul["center"] == {"lat": 37.573863, "lng": 126.986063}  # 인사동 POI078
    assert seoul["address_token"] == "서울"
    assert len(seoul["presets"]) == 9
    bounds = seoul["bounds"]
    for preset in seoul["presets"]:
        assert bounds["min_lat"] < preset["lat"] < bounds["max_lat"]
        assert bounds["min_lng"] < preset["lng"] < bounds["max_lng"]
    assert seoul["facility_count"] == 2           # 활성 서울만
    assert seoul["mapped_facility_count"] == 1
    assert seoul["zone_count"] == 2
    assert seoul["latest_observed_at"] is not None


# ── 시설 ───────────────────────────────────────────────────────────────────────


def test_infrastructures_are_active_seoul_rows_with_zone_congestion(client, seoul_db):
    res = client.get("/api/v1/internal/regions/seoul/infrastructures", headers=role_headers("developer"))
    body = res.json()
    assert body["region"] == "seoul"
    items = {item["id"]: item for item in body["items"]}
    assert set(items) == {S1, S2}  # 비활성·경주 행은 없다
    s1 = items[S1]
    assert s1["congestion"]["source"] == "seoul_citydata"
    assert s1["congestion"]["evidence_tier"] == "zone_measured"
    assert s1["congestion"]["is_current"] is True
    assert s1["congestion"]["current_count"] is None
    assert s1["zone"]["zone_id"] == "seoul:POI078"
    assert s1["zone"]["level_band"] == "slightly_busy"
    assert s1["zone"]["forecast"][0]["level_band"] == "busy"
    assert items[S2]["congestion"] is None and items[S2]["zone"] is None
    assert all("region" not in item for item in body["items"])
    # 서울 혼잡은 공개 혼잡 로그를 읽지 않는다
    assert not [q for q in seoul_db.queries if q.table == "congestion_logs"]
    assert not [name for name, _ in seoul_db.rpc_calls if name == "latest_congestion_for_facilities"]
    # 시설 읽기는 쿼리 안에서 서울로 걸렸다
    facility_reads = seoul_db.facility_queries()
    assert facility_reads and all(q.region_filters() == ["seoul"] for q in facility_reads)


def test_infrastructures_filters_by_type_and_box(client, seoul_db):
    res = client.get(
        "/api/v1/internal/regions/seoul/infrastructures",
        params={"type": "restaurant", "min_lat": 37.5, "max_lat": 37.56},
        headers=role_headers("developer"),
    )
    assert [item["id"] for item in res.json()["items"]] == [S2]


def test_facility_list_is_cached_per_region(client, seoul_db):
    headers = role_headers("developer")
    client.get("/api/v1/internal/regions/seoul/infrastructures", headers=headers)
    first = len(seoul_db.facility_queries())
    client.get("/api/v1/internal/regions/seoul/infrastructures", headers=headers)
    assert len(seoul_db.facility_queries()) == first


# ── 구역 ───────────────────────────────────────────────────────────────────────


def test_zones_list_every_zone_with_latest_reading(client, seoul_db):
    body = client.get("/api/v1/internal/regions/seoul/zones", headers=role_headers("developer")).json()
    zones = {zone["zone_id"]: zone for zone in body["zones"]}
    assert set(zones) == {"seoul:POI078", "seoul:POI007"}
    assert zones["seoul:POI078"]["level"] == 0.625
    assert zones["seoul:POI078"]["centroid"] == {"lat": 37.573863, "lng": 126.986063}
    assert zones["seoul:POI078"]["radius_m"] == 328.0
    assert zones["seoul:POI007"]["level"] is None
    assert zones["seoul:POI007"]["is_current"] is False
    assert zones["seoul:POI007"]["cluster"] == "hongdae"


def test_zone_tables_missing_degrade_to_empty(client, monkeypatch):
    class _Missing(Exception):
        code = "PGRST205"
        message = "Could not find the table 'public.zones'"

    class _DB(ZoneDB):
        def table(self, name):
            if name.startswith("zone"):
                raise _Missing()
            return super().table(name)

    db = _DB(_seoul_db().tables)
    monkeypatch.setattr(internal_regions, "supabase_admin", db)
    monkeypatch.setattr(zone_evidence, "supabase_admin", db)
    headers = role_headers("developer")
    assert client.get("/api/v1/internal/regions/seoul/zones", headers=headers).json()["zones"] == []
    items = client.get("/api/v1/internal/regions/seoul/infrastructures", headers=headers).json()["items"]
    assert {item["id"] for item in items} == {S1, S2}
    assert all(item["congestion"] is None for item in items)


def test_infrastructure_is_not_current_when_another_mapped_zone_is_older_than_now(client, seoul_db):
    """S1 이 인사동(5분 전 '약간 붐빔')과 홍대(50분 전 '붐빔')에 걸친다 — 시설의 '지금' 을 말하지 않는다(엔진과 같은 규칙)."""
    stale = datetime.now(timezone.utc) - timedelta(minutes=50)
    seoul_db.tables["facility_zones"].append({"facility_id": S1, "zone_id": "seoul:POI007", "weight": 1})
    seoul_db.tables["zone_crowd_snapshots"].append(
        {"zone_id": "seoul:POI007", "source": "seoul_citydata", "bucket_at": stale.isoformat(),
         "observed_at": stale.isoformat(), "fetched_at": stale.isoformat(),
         "population_min": 100, "population_max": 200, "level": 0.875, "level_label": "붐빔",
         "level_scale": "seoul_congest_4", "forecast": [], "quality": {}}
    )
    zone_evidence.reset_cache()
    res = client.get("/api/v1/internal/regions/seoul/infrastructures", headers=role_headers("developer"))
    s1 = {item["id"]: item for item in res.json()["items"]}[S1]
    # 관측된 구역 전부의 최댓값(보수적) — 5분 전 '약간 붐빔' 이 아니라 50분 전 '붐빔' 구역을 근거로 든다.
    assert s1["zone"]["zone_id"] == "seoul:POI007"
    assert s1["congestion"]["level"] == 0.875
    assert s1["congestion"]["is_current"] is False
    assert s1["zone"]["is_current"] is False


def test_partial_multi_zone_facility_claims_no_grade(client, seoul_db):
    """S1 이 인사동(5분 전 '여유')과 홍대(관측 없음)에 걸친다 — 조용한 구역 하나로 시설 단계를 말하지 않는다(엔진과 같은 규칙).

    단계(level·level_band·평소 대비·예보)는 비우고 관측 시각만 남긴다 — 카드는 '마지막 관측' 만 그린다.
    """
    seoul_db.tables["facility_zones"].append({"facility_id": S1, "zone_id": "seoul:POI007", "weight": 1})
    snapshot = seoul_db.tables["zone_crowd_snapshots"][0]
    snapshot.update({"level": 0.125, "level_label": "여유"})
    zone_evidence.reset_cache()
    res = client.get("/api/v1/internal/regions/seoul/infrastructures", headers=role_headers("developer"))
    s1 = {item["id"]: item for item in res.json()["items"]}[S1]
    assert s1["congestion"]["level"] is None
    assert s1["congestion"]["is_current"] is False
    assert s1["congestion"]["timestamp"] is not None  # '마지막 관측' 시각은 남긴다
    assert s1["zone"]["zone_id"] == "seoul:POI078"
    assert s1["zone"]["level"] is None
    assert s1["zone"]["level_band"] is None
    assert s1["zone"]["usual_comparison"] is None
    assert s1["zone"]["forecast"] == []
    assert s1["zone"]["observed_at"] is not None
    assert s1["zone"]["is_current"] is False
