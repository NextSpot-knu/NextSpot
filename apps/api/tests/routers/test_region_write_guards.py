"""쓰기·콘솔 경로의 지역 가드 — 서울 시설은 관광객·사장님·관리자 경로에서 없는 시설과 같다(S3 isolation_design §6).

각 경로마다:
  · 서울 시설 행은 **region 칸을 고르지 않는 조회**로 읽혀도 걸러진다 — 대역(FakeDB)이 지역 필터를 실제로 적용하고,
    응답 행에서는 region 칸을 뺀다(쿼리 안에서 거르지 않고 dict 로 거르는 코드는 여기서 실패한다).
  · DB 가드(트리거 P0001 · 좌표 CHECK 23514)가 막은 쓰기는 500 이 아니라 404/409/422 다.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.region import PUBLIC_REGION, REGION_HEADER, REGION_SEOUL
from app.main import app
from app.routers import admin as admin_router
from app.routers import lab as lab_router
from app.routers import reports as reports_router
from app.services import coupon_service
from tests.conftest import DEVELOPER_USER_ID, TOURIST_USER_ID, admin_headers, role_headers
from tests.scripts.test_ingest_tourapi_seoul import FakeDB

GJ_ID = "00000000-0000-4000-8000-0000000000a1"
SEOUL_ID = "00000000-0000-4000-8000-0000000000b1"
SEOUL_NAME = "서울 비밀 카페"


def _facility(fid, region, **extra):
    row = {"id": fid, "name": "경주 카페" if region == PUBLIC_REGION else SEOUL_NAME, "type": "cafe",
           "latitude": 35.835 if region == PUBLIC_REGION else 37.574, "longitude": 129.21 if region == PUBLIC_REGION
           else 126.986, "capacity": 40, "coupon_rate": 0.2, "is_active": True, "features": {},
           "contentid": "100" if region == PUBLIC_REGION else "900", "region": region}
    row.update(extra)
    return row


def _db(**tables) -> FakeDB:
    base = {"facilities": [_facility(GJ_ID, PUBLIC_REGION), _facility(SEOUL_ID, REGION_SEOUL)]}
    base.update(tables)
    return FakeDB(base)


class DBError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


REGION_P0001 = DBError("P0001", "facility_region_not_public")
SEOUL_COORDS_23514 = DBError(
    "23514", 'new row for relation "facilities" violates check constraint "facilities_seoul_coords_need_seoul_region"'
)


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _clear_report_slots():
    for store in (reports_router._last_report_at, reports_router._last_availability_report_at,
                  reports_router._last_report_by_ip, reports_router._last_availability_report_by_ip):
        store.clear()
    yield


def _facility_selects(db: FakeDB) -> list[list]:
    return [filters for op, table, filters, _ in db.journal if table == "facilities" and op == "select"]


def _assert_region_pinned(db: FakeDB) -> None:
    """시설 읽기마다 region = gyeongju 가 쿼리에 걸렸다(응답 행에는 region 칸이 없어도)."""
    selects = _facility_selects(db)
    assert selects
    for filters in selects:
        assert ("region", "eq", PUBLIC_REGION, False) in filters, filters


def _never_leaks(response) -> None:
    assert SEOUL_ID not in response.text and SEOUL_NAME not in response.text


# =========================================================================
# reports ×2
# =========================================================================

def test_availability_report_on_a_seoul_facility_is_404(client):
    db = _db()
    with patch.object(reports_router, "supabase_admin", new=db):
        res = client.post("/api/v1/reports/availability", json={"facility_id": SEOUL_ID, "status": "open"},
                          headers=role_headers("tourist"))
    assert res.status_code == 404
    assert not [e for e in db.journal if e[0] != "select"]
    _assert_region_pinned(db)


def test_availability_report_db_trigger_rejection_is_404(client):
    db = _db()

    def rpc(name, params):
        raise REGION_P0001

    db.rpc = rpc
    with patch.object(reports_router, "supabase_admin", new=db):
        res = client.post("/api/v1/reports/availability", json={"facility_id": GJ_ID, "status": "open"},
                          headers=role_headers("tourist"))
    assert res.status_code == 404


def test_congestion_report_on_a_seoul_facility_is_404_and_writes_nothing(client):
    db = _db()
    with patch.object(reports_router, "supabase_admin", new=db):
        res = client.post("/api/v1/reports/congestion", json={"facility_id": SEOUL_ID, "level": 0.6},
                          headers=role_headers("developer"))
    assert res.status_code == 404
    assert db.writes("congestion_logs") == []
    _assert_region_pinned(db)


def test_congestion_report_db_trigger_rejection_is_404(client):
    db = _db()
    db.fail[("congestion_logs", "insert")] = REGION_P0001
    with patch.object(reports_router, "supabase_admin", new=db):
        res = client.post("/api/v1/reports/congestion", json={"facility_id": GJ_ID, "level": 0.6},
                          headers=role_headers("tourist"))
    assert res.status_code == 404


# =========================================================================
# coupons issue / mine · coupon_service
# =========================================================================

def test_coupon_issue_on_a_seoul_facility_is_404(client):
    db = _db(user_coupons=[])
    with patch("app.routers.coupons.supabase_admin", new=db):
        res = client.post("/api/v1/coupons/issue", json={"facility_id": SEOUL_ID}, headers=role_headers("developer"))
    assert res.status_code == 404
    assert db.writes("user_coupons") == []
    _assert_region_pinned(db)


def test_my_coupons_omit_non_public_facilities(client):
    coupons = [
        {"id": "c-g", "user_id": TOURIST_USER_ID, "facility_id": GJ_ID, "coupon_rate": 0.2, "status": "issued",
         "issued_at": "2026-10-30T00:00:00+00:00", "facility": {"name": "경주 카페", "type": "cafe"}},
        {"id": "c-s", "user_id": TOURIST_USER_ID, "facility_id": SEOUL_ID, "coupon_rate": 0.2, "status": "issued",
         "issued_at": "2026-10-31T00:00:00+00:00",
         "facility": {"name": SEOUL_NAME, "type": "cafe", "region": REGION_SEOUL}},
    ]
    db = _db(user_coupons=coupons)
    with patch("app.routers.coupons.supabase_admin", new=db):
        res = client.get("/api/v1/coupons/mine", headers=role_headers("tourist"))
    assert res.status_code == 200
    assert [c["id"] for c in res.json()] == ["c-g"]
    _never_leaks(res)
    filters = next(f for op, t, f, _ in db.journal if t == "user_coupons" and op == "select")
    assert ("facility.region", "eq", PUBLIC_REGION, False) in filters


@pytest.mark.asyncio
async def test_coupon_service_is_a_no_op_for_seoul_facilities():
    db = _db(user_coupons=[], merchant_timesales=[])
    result = await coupon_service.issue_coupon_if_partner(db, DEVELOPER_USER_ID, {"id": SEOUL_ID, "coupon_rate": 0.3})
    assert result == {"coupon_issued": False, "coupon_rate": 0.0, "expires_at": None}
    assert db.writes("user_coupons") == []
    gyeongju = await coupon_service.issue_coupon_if_partner(db, TOURIST_USER_ID, {"id": GJ_ID, "coupon_rate": 0.3})
    assert gyeongju["coupon_issued"] is True


@pytest.mark.asyncio
async def test_coupon_for_a_caller_resolved_gyeongju_facility_needs_no_extra_region_lookup():
    """호출부가 경주로 거른 읽기에서 얻은 시설이면(region=경주) 발급 직전 시설 재조회가 없다(S3 전과 같은 왕복 수)."""
    db = _db(user_coupons=[], merchant_timesales=[])
    result = await coupon_service.issue_coupon_if_partner(
        db, TOURIST_USER_ID, {"id": GJ_ID, "coupon_rate": 0.3}, region=PUBLIC_REGION
    )
    assert result["coupon_issued"] is True
    assert _facility_selects(db) == []


@pytest.mark.asyncio
async def test_coupon_for_an_internal_region_short_circuits_without_any_query():
    db = _db(user_coupons=[], merchant_timesales=[])
    result = await coupon_service.issue_coupon_if_partner(
        db, DEVELOPER_USER_ID, {"id": SEOUL_ID, "coupon_rate": 0.3}, region=REGION_SEOUL
    )
    assert result == {"coupon_issued": False, "coupon_rate": 0.0, "expires_at": None}
    assert db.journal == []


@pytest.mark.asyncio
async def test_coupon_without_a_caller_region_still_checks_the_region_in_the_query():
    """지역을 넘기지 않은 호출(미래의 새 호출부)은 닫힌 쪽 — 지역을 건 단건 조회로 확인한다."""
    db = _db(user_coupons=[], merchant_timesales=[])
    await coupon_service.issue_coupon_if_partner(db, TOURIST_USER_ID, {"id": GJ_ID, "coupon_rate": 0.3})
    assert _facility_selects(db)


def test_every_coupon_caller_passes_the_region_it_resolved():
    """라우터의 발급 호출은 모두 자기가 거른 지역을 넘긴다 — 경주 발급마다 시설 재조회 왕복이 붙지 않게."""
    import ast
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    calls = []
    for rel in ("app/routers/recommendations.py", "app/routers/reports.py"):
        tree = ast.parse((root / rel).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "issue_coupon_if_partner":
                calls.append((rel, node.lineno, {kw.arg for kw in node.keywords}))
    assert len(calls) == 4, calls
    assert all("region" in kws for _rel, _line, kws in calls), calls


# =========================================================================
# account
# =========================================================================

def test_verification_request_for_a_seoul_facility_is_rejected(client):
    db = _db(business_verification_requests=[])
    with patch("app.routers.account.supabase_admin", new=db):
        res = client.post("/api/v1/account/verification-requests", headers=role_headers("tourist"),
                          json={"store_name": "가게", "contact": "010", "facility_id": SEOUL_ID})
    assert res.status_code == 422
    assert db.writes("business_verification_requests") == []
    _assert_region_pinned(db)


def test_verification_request_db_trigger_rejection_is_422(client):
    db = _db(business_verification_requests=[])
    db.fail[("business_verification_requests", "insert")] = REGION_P0001
    with patch("app.routers.account.supabase_admin", new=db):
        res = client.post("/api/v1/account/verification-requests", headers=role_headers("tourist"),
                          json={"store_name": "가게", "contact": "010", "facility_id": GJ_ID})
    assert res.status_code == 422


# =========================================================================
# dev grant / approve
# =========================================================================

def test_dev_owner_grant_on_a_seoul_facility_is_409(client):
    db = _db(users=[{"id": TOURIST_USER_ID, "role": "merchant"}], facility_owners=[])
    with patch("app.routers.dev.supabase_admin", new=db):
        res = client.post("/api/v1/dev/facility-owners", headers=role_headers("developer"),
                          json={"user_id": TOURIST_USER_ID, "facility_id": SEOUL_ID})
    assert res.status_code == 409
    assert "region_not_public" in res.json()["detail"]
    assert db.writes("facility_owners") == []


def test_dev_owner_grant_db_trigger_rejection_is_409(client):
    db = _db(users=[{"id": TOURIST_USER_ID, "role": "merchant"}], facility_owners=[])
    db.fail[("facility_owners", "insert")] = REGION_P0001
    with patch("app.routers.dev.supabase_admin", new=db):
        res = client.post("/api/v1/dev/facility-owners", headers=role_headers("developer"),
                          json={"user_id": TOURIST_USER_ID, "facility_id": GJ_ID})
    assert res.status_code == 409


def _pending_request(**extra):
    row = {"id": "req-1", "user_id": TOURIST_USER_ID, "status": "pending", "requested_role": "merchant",
           "facility_id": None, "document_path": None, "store_name": "가게"}
    row.update(extra)
    return row


def test_dev_approval_creating_a_facility_at_seoul_coordinates_is_422(client):
    db = _db(business_verification_requests=[_pending_request()], users=[{"id": TOURIST_USER_ID, "role": "tourist"}],
             facility_owners=[])
    db.fail[("facilities", "insert")] = SEOUL_COORDS_23514
    body = {"new_facility": {"name": "새 가게", "type": "cafe", "latitude": 37.57, "longitude": 126.98}}
    with patch("app.routers.dev.supabase_admin", new=db):
        res = client.post("/api/v1/dev/verification-requests/req-1/approve", headers=role_headers("developer"),
                          json=body)
    assert res.status_code == 422
    assert db.tables["business_verification_requests"][0]["status"] == "pending"


def test_dev_approval_owner_insert_rejection_is_422(client):
    db = _db(business_verification_requests=[_pending_request(facility_id=GJ_ID)],
             users=[{"id": TOURIST_USER_ID, "role": "tourist"}], facility_owners=[])
    db.fail[("facility_owners", "insert")] = REGION_P0001
    with patch("app.routers.dev.supabase_admin", new=db):
        res = client.post("/api/v1/dev/verification-requests/req-1/approve", headers=role_headers("developer"),
                          json={})
    assert res.status_code == 422
    assert db.tables["business_verification_requests"][0]["status"] == "pending"


def test_dev_approval_picking_a_seoul_facility_is_409(client):
    db = _db(business_verification_requests=[_pending_request()], users=[{"id": TOURIST_USER_ID, "role": "tourist"}],
             facility_owners=[])
    with patch("app.routers.dev.supabase_admin", new=db):
        res = client.post("/api/v1/dev/verification-requests/req-1/approve", headers=role_headers("developer"),
                          json={"facility_id": SEOUL_ID})
    assert res.status_code == 409
    assert db.writes("facility_owners") == [] and db.writes("users") == []


def test_dev_and_lab_embeds_rely_on_child_table_triggers():
    """dev 의 소유권·심사 큐 임베드는 DB 트리거가 경주 시설만 허용하는 표다(구조 검사 허용 목록의 근거)."""
    migration = Path(__file__).resolve().parents[4] / "supabase" / "migrations" / \
        "20261101090000_facility_region_isolation.sql"
    text = migration.read_text(encoding="utf-8")
    for table in ("facility_owners", "business_verification_requests", "congestion_logs"):
        assert f"ON public.{table}" in text or f"ON {table}" in text, table


# =========================================================================
# admin — create / PATCH / DELETE / manual congestion / 지표 읽기
# =========================================================================

def test_admin_create_at_seoul_coordinates_is_422(client):
    db = _db()
    db.fail[("facilities", "insert")] = SEOUL_COORDS_23514
    with patch.object(admin_router, "supabase_admin", new=db):
        res = client.post("/api/v1/admin/facilities", headers=admin_headers(),
                          json={"name": "x", "type": "cafe", "capacity": 10, "latitude": 37.57, "longitude": 126.98})
    assert res.status_code == 422


def test_admin_patch_db_rejection_is_422(client):
    db = _db()
    db.fail[("facilities", "update")] = DBError("P0001", "facility_region_immutable")
    with patch.object(admin_router, "supabase_admin", new=db):
        res = client.patch(f"/api/v1/admin/facilities/{GJ_ID}", headers=admin_headers(), json={"capacity": 5})
    assert res.status_code == 422


def test_admin_patch_on_a_seoul_facility_is_404(client):
    db = _db()
    with patch.object(admin_router, "supabase_admin", new=db):
        res = client.patch(f"/api/v1/admin/facilities/{SEOUL_ID}", headers=admin_headers(), json={"coupon_rate": 0.5})
    assert res.status_code == 404
    assert next(r for r in db.tables["facilities"] if r["id"] == SEOUL_ID)["coupon_rate"] == 0.2


def test_admin_delete_on_a_seoul_facility_is_404(client):
    db = _db()
    with patch.object(admin_router, "supabase_admin", new=db):
        res = client.delete(f"/api/v1/admin/facilities/{SEOUL_ID}", headers=admin_headers())
    assert res.status_code == 404
    assert any(r["id"] == SEOUL_ID for r in db.tables["facilities"])


def test_admin_manual_congestion_on_a_seoul_facility_is_404(client):
    db = _db(congestion_logs=[])
    with patch.object(admin_router, "supabase_admin", new=db):
        res = client.post(f"/api/v1/admin/facilities/{SEOUL_ID}/congestion", headers=admin_headers(),
                          json={"level": 0.5})
    assert res.status_code == 404
    assert db.writes("congestion_logs") == []
    _assert_region_pinned(db)


def test_admin_model_trust_counts_only_gyeongju_facilities(client):
    db = _db(model_registry=[], recommendations=[], recommendation_outcomes=[], congestion_logs=[])
    with patch.object(admin_router, "supabase_admin", new=db), \
         patch("app.services.predict_service.get_model_info", return_value={"trained": False}):
        res = client.get("/api/v1/admin/model-trust", headers=admin_headers())
    assert res.status_code == 200
    assert res.json()["collection"]["active_facilities"] == 1
    _never_leaks(res)
    _assert_region_pinned(db)


@pytest.mark.parametrize("path", [
    "/api/v1/admin/metrics", "/api/v1/admin/impact", "/api/v1/admin/dashboard/today",
    "/api/v1/admin/dashboard/briefing",
])
def test_admin_dashboards_never_read_facilities_without_region(client, path):
    """지표·임팩트·오늘·브리핑은 시설을 직접 읽지 않거나(경주 로그·추천만), 읽으면 지역을 건다."""
    db = _db(recommendations=[], user_feedback=[], recommendation_outcomes=[], congestion_logs=[], users=[])
    with patch.object(admin_router, "supabase_admin", new=db):
        res = client.get(path, headers=admin_headers())
    assert res.status_code in (200, 503), res.text
    _never_leaks(res)
    for filters in _facility_selects(db):
        assert ("region", "eq", PUBLIC_REGION, False) in filters


# =========================================================================
# search approve
# =========================================================================

def _pending_ingest(contentid):
    return [{"id": "req-1", "contentid": contentid, "name": "장소", "content_type_id": 12, "status": "pending"}]


def _approve_held_seoul_contentid(client):
    """서울 행이 이미 가진 contentid(900) 의 승인 — 응답·쓰기 기록·TourAPI 보강 호출."""
    from app.routers import search as search_router

    db = _db(admin_ingest_requests=_pending_ingest("900"))
    row = {"contentid": "900", "name": "서울 장소", "type": "attraction", "latitude": 37.57, "longitude": 126.98,
           "contenttypeid": 12, "capacity": 100, "features": {}}
    enrich = AsyncMock(return_value=row)
    with patch("app.routers.search.supabase_admin", new=db), \
         patch.object(search_router, "_enrich_and_transform", new=enrich):
        res = client.post("/api/v1/search/ingest-requests/approve", headers=admin_headers(), json={"id": "req-1"})
    return res, db, enrich


def _approve_unheld_seoul_place(client):
    """NextSpot 이 갖지 않은 서울 좌표 장소(555)의 승인 — 좌표 CHECK(23514)가 막는다."""
    from app.routers import search as search_router

    db = _db(admin_ingest_requests=_pending_ingest("555"))
    db.fail[("facilities", "upsert")] = SEOUL_COORDS_23514
    db.fail[("facilities", "insert")] = SEOUL_COORDS_23514
    row = {"contentid": "555", "name": "서울 장소", "type": "attraction", "latitude": 37.57, "longitude": 126.98,
           "contenttypeid": 12, "capacity": 100, "features": {}}
    with patch("app.routers.search.supabase_admin", new=db), \
         patch.object(search_router, "_enrich_and_transform", new=AsyncMock(return_value=row)):
        res = client.post("/api/v1/search/ingest-requests/approve", headers=admin_headers(), json={"id": "req-1"})
    return res, db


def test_search_approve_of_a_seoul_contentid_is_rejected_before_any_write(client):
    res, db, enrich = _approve_held_seoul_contentid(client)
    assert res.status_code == 422
    assert "region_not_public" in res.json()["detail"]
    assert db.writes("facilities") == [] and db.writes("admin_ingest_requests") == []
    # 서울 묶음에 든 contentid 도 TourAPI 보강을 똑같이 거친다 — 응답 시간으로 구성원 여부를 떠볼 수 없게.
    enrich.assert_awaited_once_with("900")


def test_search_approve_of_a_seoul_place_is_422(client):
    res, db = _approve_unheld_seoul_place(client)
    assert res.status_code == 422
    assert db.tables["admin_ingest_requests"][0]["status"] == "pending"


def test_search_approve_does_not_reveal_whether_a_seoul_contentid_is_held(client):
    """관리자(심사 계정 포함)가 승인 응답으로 개발자 전용 서울 묶음의 구성을 떠볼 수 없다 — 두 경우의 응답이 같다."""
    held, _, _ = _approve_held_seoul_contentid(client)
    unheld, _ = _approve_unheld_seoul_place(client)
    assert held.status_code == unheld.status_code
    assert held.json() == unheld.json()


# =========================================================================
# merchant ×5 — 소유권을 건너뛰는 developer · 구 공유 토큰 경로
# =========================================================================

MERCHANT_CALLS = [
    ("post", "/api/v1/merchant/timesale", {"json": {"facility_id": SEOUL_ID, "rate": 0.2, "duration_minutes": 60}}),
    ("post", "/api/v1/merchant/timesale/cancel", {"json": {"id": "t-1", "facility_id": SEOUL_ID}}),
    ("post", "/api/v1/merchant/seat-status", {"json": {"facility_id": SEOUL_ID, "level": "low"}}),
    ("get", f"/api/v1/merchant/briefing?facility_id={SEOUL_ID}", {}),
    ("get", f"/api/v1/merchant/stats?facility_id={SEOUL_ID}", {}),
]


def _merchant_db():
    return _db(merchant_timesales=[{"id": "t-1", "facility_id": SEOUL_ID, "rate": 0.2, "canceled_at": None}],
               system_settings=[{"id": 1, "merchant_console_enabled": True}], congestion_logs=[])


@pytest.mark.parametrize("method,path,kwargs", MERCHANT_CALLS)
def test_merchant_endpoints_404_on_seoul_for_developers(client, method, path, kwargs):
    db = _merchant_db()
    with patch("app.routers.merchant.supabase_admin", new=db):
        res = getattr(client, method)(path, headers=role_headers("developer"), **kwargs)
    assert res.status_code == 404, res.text
    assert db.writes("facilities") == [] and db.writes("merchant_timesales") == []
    assert db.writes("congestion_logs") == []
    _assert_region_pinned(db)


@pytest.mark.parametrize("method,path,kwargs", MERCHANT_CALLS)
def test_merchant_endpoints_404_on_seoul_for_the_legacy_token(client, monkeypatch, method, path, kwargs):
    monkeypatch.setattr(settings, "LEGACY_CONSOLE_TOKENS", True)
    monkeypatch.setattr(settings, "MERCHANT_API_TOKEN", "legacy-token")
    db = _merchant_db()
    with patch("app.routers.merchant.supabase_admin", new=db):
        res = getattr(client, method)(path, headers={"x-merchant-token": "legacy-token"}, **kwargs)
    assert res.status_code == 404, res.text
    assert db.writes("facilities") == [] and db.writes("merchant_timesales") == []


def test_merchant_timesale_db_trigger_rejection_is_404(client):
    db = _merchant_db()
    db.fail[("merchant_timesales", "insert")] = REGION_P0001
    with patch("app.routers.merchant.supabase_admin", new=db):
        res = client.post("/api/v1/merchant/timesale", headers=role_headers("developer"),
                          json={"facility_id": GJ_ID, "rate": 0.2, "duration_minutes": 60})
    assert res.status_code == 404


def test_merchant_owner_path_skips_the_extra_lookup(client):
    """소유권이 확인된 사장님은 지역 조회를 하지 않는다 — 소유권 자체가 트리거로 경주 시설에만 붙는다."""
    from app.routers import merchant

    db = _merchant_db()
    db.tables["merchant_timesales"] = []
    with patch("app.routers.merchant.supabase_admin", new=db):
        ctx = {"profile": {"id": "m", "role": "merchant", "facility_ids": frozenset({GJ_ID}), "is_anonymous": False}}
        import asyncio
        asyncio.run(merchant.require_public_facility(ctx, GJ_ID))
    assert _facility_selects(db) == []


# =========================================================================
# lab — 학습 대상 시설은 요청 지역 안에서
# =========================================================================

@pytest.mark.parametrize("role,with_header,expected", [
    ("developer", True, REGION_SEOUL),
    ("developer", False, PUBLIC_REGION),
    ("tourist", True, PUBLIC_REGION),
    ("admin", True, PUBLIC_REGION),
])
def test_lab_learning_resolves_the_target_inside_the_request_region(client, role, with_header, expected):
    headers = role_headers(role)
    if with_header:
        headers[REGION_HEADER] = REGION_SEOUL
    row = {"id": "fb-1", "recommendation_id": "rec-1", "reason_status": "pending",
           "created_at": "2099-01-01T00:00:00+00:00"}
    resolve = AsyncMock(return_value=({"id": "rec-1"}, {"id": SEOUL_ID, "type": "cafe"}))
    applied = {"should_learn_vector": True, "learning_scope": "long_term", "id": "fb-1",
               "reason_status": "answered", "reason_code": "too_far"}
    with patch.object(lab_router, "_fetch_own_feedback", new=AsyncMock(return_value=row)), \
         patch.object(lab_router.fs, "is_expired", return_value=False), \
         patch.object(lab_router.fs, "apply_reason", new=AsyncMock(return_value=applied)), \
         patch.object(lab_router, "resolve_feedback_target", new=resolve), \
         patch.object(lab_router, "apply_feedback_vector_learning", new=AsyncMock(return_value=True)):
        res = client.post("/api/v1/lab/fb-1/reason", headers=headers, json={"reason_code": "too_far"})
    assert res.status_code == 200, res.text
    assert resolve.await_args.kwargs["region"] == expected


# =========================================================================
# warmup — 공개 지역 풀만 데운다
# =========================================================================

@pytest.mark.asyncio
async def test_warmup_loads_the_public_pool_explicitly():
    from app.routers import warmup as warmup_router

    seen = {}

    async def facilities(**kwargs):
        seen.update(kwargs)
        return []

    with patch("app.routers.recommendations.fetch_all_facilities", new=facilities), \
         patch("app.services.congestion_evidence.load_current_estimates", new=AsyncMock(return_value=None)), \
         patch("app.services.area_demand_forecast_service.prefetch_area_demand_points", new=AsyncMock()), \
         patch("app.services.event_boost.get_event_congestion_boost", new=AsyncMock(return_value=None)), \
         patch("app.services.parking_demand_service.get_nearby_parking_lots", new=AsyncMock(return_value=None)), \
         patch("app.services.weather_service.get_gyeongju_weather", new=AsyncMock(return_value=None)), \
         patch("app.services.spot.travel._load_graph", lambda: None):
        await warmup_router._warm_all()
    assert seen["region"] == PUBLIC_REGION
