"""실시간 키워드 게이트웨이(search 라우터) 테스트 — 실제 DB/TourAPI 호출 없이
레이트리밋·무해 폴백·관리자 가드·승인(단건 인제스트) 흐름을 검증한다.

이 라우터는 아직 app/main.py 에 등록되지 않았다(통합 단계에서 배선 예정 —
test_merchant.py 와 동일 관례로 search.router 만 얹은 독립 테스트 앱을 쓴다).
"""
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.config import settings
from app.routers import search
from app.routers.search import transform_keyword_item

# test_routers.py 의 공용 Fake(체이닝 흡수 + table별 canned)를 재사용한다.
from tests.routers.test_routers import FakeSupabase


def _admin_headers(token: str | None = None) -> dict:
    return {"X-Admin-Authorization": f"Bearer {token or settings.ADMIN_API_TOKEN}"}


@pytest.fixture
def client():
    test_app = FastAPI()
    test_app.include_router(search.router)
    with TestClient(test_app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_rate_limit_state():
    """전역 인메모리 레이트리밋 상태를 테스트마다 격리(reports.py _last_report_at.clear() 관례 미러)."""
    search._search_hits.clear()
    search._ingest_hits.clear()
    yield
    search._search_hits.clear()
    search._ingest_hits.clear()


def _payload(items: list[dict]) -> dict:
    return {
        "response": {
            "header": {"resultCode": "0000", "resultMsg": "OK"},
            "body": {"items": {"item": items}, "totalCount": len(items)},
        }
    }


# =========================================================================
# 스파이 Fake — insert/update/upsert 호출과 인자를 기록(승인 흐름 회귀 검증용)
# =========================================================================

class _FakeResult:
    def __init__(self, data):
        self.data = data


class SpyTable:
    def __init__(self, data, calls: list, table_name: str):
        self._data = data
        self._calls = calls
        self._table = table_name

    def insert(self, payload):
        self._calls.append((self._table, "insert", payload))
        return self

    def update(self, payload):
        self._calls.append((self._table, "update", payload))
        return self

    def upsert(self, payload, **kwargs):
        self._calls.append((self._table, "upsert", payload, kwargs))
        return self

    def eq(self, column, value):
        self._calls.append((self._table, "eq", column, value))
        return self

    def __getattr__(self, _name):
        def _chain(*_a, **_k):
            return self
        return _chain

    def execute(self):
        return _FakeResult(self._data)


class SpySupabase:
    def __init__(self, tables: dict):
        self._tables = tables
        self.calls: list = []

    def table(self, name: str) -> SpyTable:
        return SpyTable(self._tables.get(name, []), self.calls, name)


class RaisingFakeTable:
    def __init__(self, error: Exception):
        self._error = error

    def __getattr__(self, _name):
        def _chain(*_a, **_k):
            return self
        return _chain

    def execute(self):
        raise self._error


class RaisingFakeSupabase:
    """모든 테이블 접근이 지정된 예외를 던진다 — 마이그레이션 미적용(테이블 부재) 시뮬레이션."""

    def __init__(self, error: Exception):
        self._error = error

    def table(self, _name: str) -> RaisingFakeTable:
        return RaisingFakeTable(self._error)


_MISSING_TABLE_ERROR = Exception('relation "public.admin_ingest_requests" does not exist')


# =========================================================================
# 1. transform_keyword_item — 순수 함수
# =========================================================================

def test_transform_keyword_item_happy_path():
    item = {
        "contentid": "500001", "title": "불국사", "addr1": "경상북도 경주시 불국로 385",
        "mapx": "129.3320", "mapy": "35.7898", "contenttypeid": "12",
        "firstimage": "http://tong.visitkorea.or.kr/f.jpg",
    }
    parsed = transform_keyword_item(item)
    assert parsed is not None
    assert parsed.contentid == "500001"
    assert parsed.title == "불국사"
    assert parsed.contenttypeid == 12
    assert parsed.mapx == 129.332 and parsed.mapy == 35.7898
    assert parsed.firstimage == "https://tong.visitkorea.or.kr/f.jpg"  # http → https 승격


def test_transform_keyword_item_missing_required_fields():
    assert transform_keyword_item({"contentid": "1", "title": "  "}) is None
    assert transform_keyword_item({"contentid": "", "title": "이름만"}) is None
    assert transform_keyword_item("not-a-dict") is None


def test_transform_keyword_item_zero_coords_and_bad_ctid():
    parsed = transform_keyword_item({
        "contentid": "1", "title": "좌표미상", "mapx": "0", "mapy": "0", "contenttypeid": "abc",
    })
    assert parsed is not None
    assert parsed.mapx is None and parsed.mapy is None
    assert parsed.contenttypeid is None


# =========================================================================
# 2. GET /api/v1/search/keyword — 레이트리밋 + 무해 폴백 + 행복 경로
# =========================================================================

def test_search_keyword_unavailable_fallback(client):
    with patch.object(search.tourapi, "search_keyword", AsyncMock(side_effect=RuntimeError("TOURAPI_KEY 없음"))):
        res = client.get("/api/v1/search/keyword", params={"q": "불국사"})
    assert res.status_code == 200
    assert res.json() == {"items": [], "source": "unavailable"}


def test_search_keyword_happy_path_caps_at_five():
    items = [
        {"contentid": str(i), "title": f"장소{i}", "addr1": "경주", "mapx": "129.2", "mapy": "35.8",
         "contenttypeid": "12"}
        for i in range(8)
    ]
    with patch.object(search.tourapi, "search_keyword", AsyncMock(return_value=_payload(items))) as mock:
        test_app = FastAPI()
        test_app.include_router(search.router)
        with TestClient(test_app) as c:
            res = c.get("/api/v1/search/keyword", params={"q": "황리단길"})
    assert res.status_code == 200
    body = res.json()
    assert body["source"] == "tourapi"
    assert len(body["items"]) == 5  # 상위 5개 캡
    # 경주 지역 필터(legacy areaCode=35/sigunguCode=2) + rows=5 가 실제로 전달되는지 회귀 방지
    kwargs = mock.await_args.kwargs
    assert kwargs["area_code"] == 35 and kwargs["sigungu_code"] == 2 and kwargs["rows"] == 5


def test_search_keyword_rate_limited_after_five_calls(client):
    with patch.object(search.tourapi, "search_keyword", AsyncMock(side_effect=RuntimeError("no key"))):
        for _ in range(5):
            ok = client.get("/api/v1/search/keyword", params={"q": "황리단길"})
            assert ok.status_code == 200
        limited = client.get("/api/v1/search/keyword", params={"q": "황리단길"})
    assert limited.status_code == 429
    assert "Retry-After" in limited.headers


def test_search_keyword_missing_query_422(client):
    res = client.get("/api/v1/search/keyword")
    assert res.status_code == 422


# =========================================================================
# 3. POST /api/v1/search/ingest-request — 큐잉 + 레이트리밋 + 테이블 부재 폴백
# =========================================================================

def test_ingest_request_happy_path_upserts_pending(client):
    spy = SpySupabase({"admin_ingest_requests": [{"id": "req-1"}]})
    with patch("app.routers.search.supabase_admin", new=spy):
        res = client.post(
            "/api/v1/search/ingest-request",
            json={"contentid": "500001", "name": "불국사", "content_type_id": 12},
        )
    assert res.status_code == 200
    assert res.json() == {"success": True}
    upsert_calls = [c for c in spy.calls if c[0] == "admin_ingest_requests" and c[1] == "upsert"]
    assert len(upsert_calls) == 1
    _, _, payload, kwargs = upsert_calls[0]
    assert payload["contentid"] == "500001" and payload["status"] == "pending"
    assert kwargs.get("on_conflict") == "contentid" and kwargs.get("ignore_duplicates") is True


def test_ingest_request_rate_limited_after_three_calls(client):
    spy = FakeSupabase({"admin_ingest_requests": [{"id": "req-1"}]})
    with patch("app.routers.search.supabase_admin", new=spy):
        for _ in range(3):
            ok = client.post("/api/v1/search/ingest-request", json={"contentid": "c1", "name": "x"})
            assert ok.status_code == 200
        limited = client.post("/api/v1/search/ingest-request", json={"contentid": "c1", "name": "x"})
    assert limited.status_code == 429
    assert "Retry-After" in limited.headers


def test_ingest_request_table_missing_returns_503_not_500(client):
    with patch("app.routers.search.supabase_admin", new=RaisingFakeSupabase(_MISSING_TABLE_ERROR)):
        res = client.post("/api/v1/search/ingest-request", json={"contentid": "c1", "name": "x"})
    assert res.status_code == 503
    assert "마이그레이션" in res.json()["detail"]


def test_ingest_request_invalid_body_422(client):
    res = client.post("/api/v1/search/ingest-request", json={"name": "이름만"})
    assert res.status_code == 422


# =========================================================================
# 4. GET /api/v1/search/ingest-requests — 관리자 가드 + 목록
# =========================================================================

def test_ingest_requests_list_no_header_401(client):
    res = client.get("/api/v1/search/ingest-requests")
    assert res.status_code == 401


def test_ingest_requests_list_ok(client):
    pending = [
        {"id": "req-1", "contentid": "500001", "name": "불국사", "status": "pending",
         "created_at": "2026-07-15T01:00:00+00:00"},
    ]
    with patch("app.routers.search.supabase_admin", new=FakeSupabase({"admin_ingest_requests": pending})):
        res = client.get("/api/v1/search/ingest-requests", headers=_admin_headers())
    assert res.status_code == 200
    assert res.json() == pending


def test_ingest_requests_list_invalid_status_422(client):
    res = client.get(
        "/api/v1/search/ingest-requests", params={"status": "archived"}, headers=_admin_headers()
    )
    assert res.status_code == 422


def test_ingest_requests_list_table_missing_returns_503_not_500(client):
    with patch("app.routers.search.supabase_admin", new=RaisingFakeSupabase(_MISSING_TABLE_ERROR)):
        res = client.get("/api/v1/search/ingest-requests", headers=_admin_headers())
    assert res.status_code == 503


# =========================================================================
# 5. POST /api/v1/search/ingest-requests/approve — 단건 인제스트 승인
# =========================================================================

def _common_item(**over) -> dict:
    base = {
        "contentid": "500001",
        "contenttypeid": "12",
        "title": "테스트 관광지",
        "addr1": "경상북도 경주시 어딘가",
        "mapx": "129.2105",
        "mapy": "35.8361",
        "cat1": "A01", "cat2": "A0101", "cat3": "A01010100",
        "firstimage": "http://tong.visitkorea.or.kr/f.jpg",
        "tel": "054-000-0000",
        "overview": "테스트 개요입니다.",
        "homepage": '<a href="http://example.com" target="_blank">예시</a>',
    }
    base.update(over)
    return base


def _intro_item(**over) -> dict:
    base = {
        "usetime": "09:00-18:00", "restdate": "연중무휴",
        "parking": "가능", "chkbabycarriage": "가능", "chkpet": "불가", "chkcreditcard": "가능",
        "accomcount": "1,000",
    }
    base.update(over)
    return base


def test_approve_requires_admin_401(client):
    res = client.post("/api/v1/search/ingest-requests/approve", json={"id": "req-1"})
    assert res.status_code == 401


def test_approve_request_not_found_404(client):
    with patch("app.routers.search.supabase_admin", new=FakeSupabase({"admin_ingest_requests": []})):
        res = client.post(
            "/api/v1/search/ingest-requests/approve", headers=_admin_headers(), json={"id": "ghost"}
        )
    assert res.status_code == 404


def test_approve_happy_path_ingests_and_marks_approved(client):
    pending_row = {
        "id": "req-1", "contentid": "500001", "name": "테스트 관광지",
        "content_type_id": 12, "status": "pending",
    }
    spy = SpySupabase({
        "admin_ingest_requests": [pending_row],
        "facilities": [{"id": "f-new", "contentid": "500001"}],
    })
    with patch("app.routers.search.supabase_admin", new=spy), \
         patch.object(search.tourapi, "detail_common", AsyncMock(return_value=_payload([_common_item()]))), \
         patch.object(search.tourapi, "detail_intro", AsyncMock(return_value=_payload([_intro_item()]))):
        res = client.post(
            "/api/v1/search/ingest-requests/approve", headers=_admin_headers(), json={"id": "req-1"}
        )

    assert res.status_code == 200
    body = res.json()
    assert body["success"] is True
    assert body["contentid"] == "500001"
    assert body["name"] == "테스트 관광지"

    # facilities upsert 가 실제로 호출됐는지(contentid 기준)
    fac_upserts = [c for c in spy.calls if c[0] == "facilities" and c[1] == "upsert"]
    assert len(fac_upserts) == 1
    assert fac_upserts[0][2]["contentid"] == "500001"
    assert fac_upserts[0][2]["type"] == "attraction"  # contenttypeid=12

    # admin_ingest_requests 상태가 approved 로 갱신됐는지
    status_updates = [
        c for c in spy.calls if c[0] == "admin_ingest_requests" and c[1] == "update"
    ]
    assert len(status_updates) == 1
    assert status_updates[0][2]["status"] == "approved"
    assert status_updates[0][2]["approved_at"] is not None


def test_approve_already_approved_is_idempotent_no_tourapi_call(client):
    approved_row = {"id": "req-1", "contentid": "500001", "name": "이미승인", "status": "approved"}
    with patch("app.routers.search.supabase_admin", new=FakeSupabase({"admin_ingest_requests": [approved_row]})), \
         patch.object(search.tourapi, "detail_common", AsyncMock(side_effect=AssertionError("호출되면 안 됨"))):
        res = client.post(
            "/api/v1/search/ingest-requests/approve", headers=_admin_headers(), json={"id": "req-1"}
        )
    assert res.status_code == 200
    assert res.json()["already_approved"] is True


def test_approve_detail_common_failure_keeps_pending(client):
    pending_row = {"id": "req-1", "contentid": "500001", "name": "테스트", "status": "pending"}
    spy = SpySupabase({"admin_ingest_requests": [pending_row]})
    with patch("app.routers.search.supabase_admin", new=spy), \
         patch.object(search.tourapi, "detail_common", AsyncMock(side_effect=search.tourapi.TourAPIError("실패"))):
        res = client.post(
            "/api/v1/search/ingest-requests/approve", headers=_admin_headers(), json={"id": "req-1"}
        )
    assert res.status_code == 502
    # 실패했으므로 admin_ingest_requests 상태 갱신이 절대 호출되지 않아야 한다(pending 유지).
    assert not [c for c in spy.calls if c[0] == "admin_ingest_requests" and c[1] == "update"]


def test_approve_table_missing_returns_503_not_500(client):
    with patch("app.routers.search.supabase_admin", new=RaisingFakeSupabase(_MISSING_TABLE_ERROR)):
        res = client.post(
            "/api/v1/search/ingest-requests/approve", headers=_admin_headers(), json={"id": "req-1"}
        )
    assert res.status_code == 503
