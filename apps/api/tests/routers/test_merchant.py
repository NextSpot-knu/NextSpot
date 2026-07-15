# 머천트 콘솔(소상공인 '내 가게 대시보드') 라우터 테스트 — 실제 DB/네트워크 없이
# require_merchant 가드·성적표 집계·타임세일 발행/취소·좌석 상태 방송을 검증한다.
#  · 인증: require_merchant 는 실제 헤더 경로(X-Merchant-Token)를 그대로 태운다(관리자 가드와 별도 체계).
#  · DB: supabase_admin 은 test_routers.py 의 공용 FakeSupabase(canned 데이터)로 대체 — PostgREST 호출 없음.
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import merchant

# test_routers.py 의 공용 Fake(체이닝 흡수 + table별 canned)를 재사용한다.
from tests.routers.test_routers import FakeSupabase, FakeTable, _FakeResult

# merchant.py 의 기본 토큰(MERCHANT_API_TOKEN 미설정 시 폴백값)과 동일 — .env 는 이 값을 채우지 않는다
# (apps/api 앱 모듈은 dotenv 를 로드하지 않으므로 테스트 환경에서 os.environ 은 비어 있다).
MERCHANT_TOKEN = "nextspot-merchant-local"


def _merchant_headers(token: str | None = None) -> dict:
    return {"X-Merchant-Token": token or MERCHANT_TOKEN}


# 이 라우터는 아직 app/main.py 에 등록되지 않았다(통합 단계에서 배선 예정 — docs 참고).
# 등록 여부와 무관하게 라우터 자체를 검증하기 위해, merchant.router 만 얹은 독립 테스트 앱을 쓴다.
@pytest.fixture
def client():
    test_app = FastAPI()
    test_app.include_router(merchant.router)
    with TestClient(test_app) as c:
        yield c


# =========================================================================
# 1. require_merchant 가드 — 헤더 없음/오답 토큰 → 401
# =========================================================================


def test_merchant_stats_no_header_401(client):
    res = client.get("/api/v1/merchant/stats", params={"facility_id": "f-1"})
    assert res.status_code == 401


def test_merchant_stats_wrong_token_401(client):
    res = client.get(
        "/api/v1/merchant/stats", params={"facility_id": "f-1"}, headers=_merchant_headers("wrong-token")
    )
    assert res.status_code == 401


def test_merchant_seat_status_no_header_401(client):
    res = client.post("/api/v1/merchant/seat-status", json={"facility_id": "f-1", "level": "low"})
    assert res.status_code == 401


def test_merchant_timesale_create_no_header_401(client):
    res = client.post(
        "/api/v1/merchant/timesale", json={"facility_id": "f-1", "rate": 0.15, "duration_minutes": 60}
    )
    assert res.status_code == 401


# =========================================================================
# 2. 성적표(GET /api/v1/merchant/stats) — 집계 산식 + 정직한 미집계 항목
# =========================================================================


def test_merchant_stats_aggregation(client):
    coupons = [
        {"status": "issued", "issued_at": "2026-07-14T01:00:00+00:00"},
        {"status": "used", "issued_at": "2026-07-13T01:00:00+00:00"},
        {"status": "used", "issued_at": "2026-07-12T01:00:00+00:00"},
    ]
    reports = [
        {"id": "log-1", "timestamp": "2026-07-14T02:00:00+00:00"},
    ]
    recs = [
        {"accepted": True, "created_at": "2026-07-14T03:00:00+00:00"},
        {"accepted": False, "created_at": "2026-07-13T03:00:00+00:00"},
        {"accepted": True, "created_at": "2026-07-12T03:00:00+00:00"},
    ]
    with patch(
        "app.routers.merchant.supabase_admin",
        new=FakeSupabase({"user_coupons": coupons, "congestion_logs": reports, "recommendations": recs}),
    ):
        res = client.get(
            "/api/v1/merchant/stats", params={"facility_id": "f-1"}, headers=_merchant_headers()
        )

    assert res.status_code == 200
    body = res.json()
    assert body["facility_id"] == "f-1"
    assert body["coupons_issued"] == 3
    assert body["coupons_used"] == 2
    assert body["congestion_reports"] == 1
    assert body["recommendations_exposed"] == 3
    assert body["recommendations_accepted"] == 2
    # 방문확인은 서버 미집계 — 지어내지 않고 null + 사유 문구
    assert body["visit_confirmations"] is None
    assert "로컬" in body["visit_confirmations_note"]


def test_merchant_stats_empty(client):
    with patch(
        "app.routers.merchant.supabase_admin",
        new=FakeSupabase({"user_coupons": [], "congestion_logs": [], "recommendations": []}),
    ):
        res = client.get(
            "/api/v1/merchant/stats", params={"facility_id": "f-1"}, headers=_merchant_headers()
        )
    assert res.status_code == 200
    body = res.json()
    assert body["coupons_issued"] == 0
    assert body["recommendations_accepted"] == 0


def test_merchant_stats_excludes_browse_rejections(client):
    class SourceFilteringTable(FakeTable):
        def neq(self, column, value):
            self._data = [row for row in self._data if row.get(column, "spot") != value]
            return self

    class SourceFilteringSupabase(FakeSupabase):
        def table(self, name):
            return SourceFilteringTable(self._tables.get(name, []))

    recs = [
        {"source": "spot", "accepted": True, "created_at": "2026-07-14T03:00:00+00:00"},
        {"source": "browse", "accepted": False, "created_at": "2026-07-14T04:00:00+00:00"},
        # 마이그레이션 전 행은 DB 기본/백필 의미상 spot 으로 취급된다.
        {"accepted": False, "created_at": "2026-07-14T05:00:00+00:00"},
    ]
    with patch("app.routers.merchant.supabase_admin", new=SourceFilteringSupabase({"recommendations": recs})):
        res = client.get("/api/v1/merchant/stats", params={"facility_id": "f-1"}, headers=_merchant_headers())
    assert res.status_code == 200
    assert res.json()["recommendations_exposed"] == 2


# =========================================================================
# 3. 셀프 타임세일 — 발행(POST)/목록(GET)/취소(POST)
# =========================================================================


def test_merchant_timesale_create_invalid_rate_422(client):
    # rate 는 Literal[0.15, 0.20, 0.30] — 그리드 밖 값은 라우터 진입 전 422
    res = client.post(
        "/api/v1/merchant/timesale",
        headers=_merchant_headers(),
        json={"facility_id": "f-1", "rate": 0.5, "duration_minutes": 60},
    )
    assert res.status_code == 422


def test_merchant_timesale_create_facility_404(client):
    with patch("app.routers.merchant.supabase_admin", new=FakeSupabase({"facilities": []})):
        res = client.post(
            "/api/v1/merchant/timesale",
            headers=_merchant_headers(),
            json={"facility_id": "ghost", "rate": 0.15, "duration_minutes": 60},
        )
    assert res.status_code == 404


def test_merchant_timesale_create_happy_path(client):
    facility = {"id": "f-1", "name": "시설-f-1"}
    inserted = {
        "id": "ts-1", "facility_id": "f-1", "rate": 0.2,
        "starts_at": "2026-07-15T01:00:00+00:00", "ends_at": "2026-07-15T03:00:00+00:00",
    }
    with patch(
        "app.routers.merchant.supabase_admin",
        new=FakeSupabase({"facilities": [facility], "merchant_timesales": [inserted]}),
    ):
        res = client.post(
            "/api/v1/merchant/timesale",
            headers=_merchant_headers(),
            json={"facility_id": "f-1", "rate": 0.2, "duration_minutes": 120},
        )
    assert res.status_code == 200
    body = res.json()
    assert body["facility_id"] == "f-1"
    assert body["rate"] == 0.2


def test_merchant_timesale_list_active(client):
    active = [
        {"id": "ts-1", "facility_id": "f-1", "rate": 0.15, "ends_at": "2099-01-01T00:00:00+00:00",
         "canceled_at": None, "created_at": "2026-07-15T01:00:00+00:00"},
    ]
    with patch("app.routers.merchant.supabase_admin", new=FakeSupabase({"merchant_timesales": active})):
        res = client.get(
            "/api/v1/merchant/timesale", params={"facility_id": "f-1"}, headers=_merchant_headers()
        )
    assert res.status_code == 200
    assert res.json() == active


def test_merchant_timesale_cancel_happy_path(client):
    canceled = {"id": "ts-1", "facility_id": "f-1", "canceled_at": "2026-07-15T04:00:00+00:00"}
    with patch("app.routers.merchant.supabase_admin", new=FakeSupabase({"merchant_timesales": [canceled]})):
        res = client.post(
            "/api/v1/merchant/timesale/cancel",
            headers=_merchant_headers(),
            json={"id": "ts-1", "facility_id": "f-1"},
        )
    assert res.status_code == 200
    assert res.json()["canceled_at"] == "2026-07-15T04:00:00+00:00"


def test_merchant_timesale_cancel_not_found_404(client):
    with patch("app.routers.merchant.supabase_admin", new=FakeSupabase({"merchant_timesales": []})):
        res = client.post(
            "/api/v1/merchant/timesale/cancel",
            headers=_merchant_headers(),
            json={"id": "ghost", "facility_id": "f-1"},
        )
    assert res.status_code == 404


# =========================================================================
# 4. 좌석 상태 방송(POST /api/v1/merchant/seat-status) — features jsonb 병합
# =========================================================================


def test_merchant_seat_status_facility_404(client):
    with patch("app.routers.merchant.supabase_admin", new=FakeSupabase({"facilities": []})):
        res = client.post(
            "/api/v1/merchant/seat-status",
            headers=_merchant_headers(),
            json={"facility_id": "ghost", "level": "full"},
        )
    assert res.status_code == 404


def test_merchant_seat_status_invalid_level_422(client):
    res = client.post(
        "/api/v1/merchant/seat-status",
        headers=_merchant_headers(),
        json={"facility_id": "f-1", "level": "medium"},
    )
    assert res.status_code == 422


def test_merchant_seat_status_happy_path(client):
    # FakeTable 은 select/update 호출 모두 동일 canned 데이터를 돌려준다(실제 병합은 검증 대상이 아님 —
    # 응답 바디는 라우터가 직접 구성해 반환하므로 canned 데이터는 '존재/비어있지 않음' 신호로만 쓰인다).
    facility = {"id": "f-1", "features": {"average_processing_time": 10}}
    with patch(
        "app.routers.merchant.supabase_admin",
        new=FakeSupabase({"facilities": [facility]}),
    ):
        res = client.post(
            "/api/v1/merchant/seat-status",
            headers=_merchant_headers(),
            json={"facility_id": "f-1", "level": "full"},
        )
    assert res.status_code == 200
    body = res.json()
    assert body["facility_id"] == "f-1"
    assert body["level"] == "full"
    assert "updated_at" in body


# =========================================================================
# 5. 좌석 상태 해제(level=null) — features 에서 seat_status 키 제거
# 공용 FakeTable 은 update() 인자를 흘려버려 '무엇을 썼는지' 를 볼 수 없다 —
# 실제 기록 페이로드가 검증 대상이므로 update payload 를 붙잡는 전용 Fake 를 쓴다.
# =========================================================================


class _CapturingFacilitiesTable(FakeTable):
    """facilities 전용 — update(payload) 의 payload 를 captured 에 남긴다."""

    def __init__(self, data, captured: dict):
        super().__init__(data)
        self._captured = captured

    def update(self, payload):
        self._captured["payload"] = payload
        return self


class _CapturingFacilitiesSupabase:
    def __init__(self, facility: dict, captured: dict):
        self._facility = facility
        self._captured = captured

    def table(self, name: str):
        if name == "facilities":
            return _CapturingFacilitiesTable([self._facility], self._captured)
        return FakeTable([])


def test_merchant_seat_status_clear_removes_key(client):
    facility = {
        "id": "f-1",
        "features": {
            "average_processing_time": 10,
            "seat_status": {"level": "full", "updated_at": "2026-07-15T01:00:00+00:00"},
        },
    }
    captured: dict = {}
    with patch(
        "app.routers.merchant.supabase_admin",
        new=_CapturingFacilitiesSupabase(facility, captured),
    ):
        res = client.post(
            "/api/v1/merchant/seat-status",
            headers=_merchant_headers(),
            json={"facility_id": "f-1", "level": None},
        )

    assert res.status_code == 200
    body = res.json()
    assert body["facility_id"] == "f-1"
    assert body["level"] is None
    assert "updated_at" in body  # 응답 형태는 기존 3키 그대로

    # DB 에 기록된 features 에서 seat_status(중첩 updated_at 포함)가 사라지고 나머지는 보존.
    written = captured["payload"]["features"]
    assert "seat_status" not in written
    assert written["average_processing_time"] == 10


def test_merchant_seat_status_clear_when_absent_is_noop(client):
    """이미 좌석 상태가 없어도 해제는 200 — 프런트가 상태를 모른 채 눌러도 안전해야 한다."""
    facility = {"id": "f-1", "features": {"average_processing_time": 10}}
    captured: dict = {}
    with patch(
        "app.routers.merchant.supabase_admin",
        new=_CapturingFacilitiesSupabase(facility, captured),
    ):
        res = client.post(
            "/api/v1/merchant/seat-status",
            headers=_merchant_headers(),
            json={"facility_id": "f-1", "level": None},
        )
    assert res.status_code == 200
    assert "seat_status" not in captured["payload"]["features"]


def test_merchant_seat_status_save_still_writes_key(client):
    """저장 경로 회귀 가드 — level 지정 시 seat_status 가 기존대로 병합 기록된다."""
    facility = {"id": "f-1", "features": {"average_processing_time": 10}}
    captured: dict = {}
    with patch(
        "app.routers.merchant.supabase_admin",
        new=_CapturingFacilitiesSupabase(facility, captured),
    ):
        res = client.post(
            "/api/v1/merchant/seat-status",
            headers=_merchant_headers(),
            json={"facility_id": "f-1", "level": "mid"},
        )
    assert res.status_code == 200
    written = captured["payload"]["features"]
    assert written["seat_status"]["level"] == "mid"
    assert written["seat_status"]["updated_at"]
    assert written["average_processing_time"] == 10  # 기존 features 보존


def test_merchant_seat_status_clear_facility_404(client):
    """해제도 존재하지 않는 시설이면 기존과 동일하게 404."""
    with patch("app.routers.merchant.supabase_admin", new=FakeSupabase({"facilities": []})):
        res = client.post(
            "/api/v1/merchant/seat-status",
            headers=_merchant_headers(),
            json={"facility_id": "ghost", "level": None},
        )
    assert res.status_code == 404


def test_merchant_seat_status_missing_level_422(client):
    """level 필드 자체가 없으면 422 — 바디 누락으로 실수 해제되지 않는다(해제는 null 명시)."""
    res = client.post(
        "/api/v1/merchant/seat-status",
        headers=_merchant_headers(),
        json={"facility_id": "f-1"},
    )
    assert res.status_code == 422


# =========================================================================
# 6. 활성 타임세일 중복 정책(감사 P1-7) — 발행은 막지 않되 '실제 적용 할인율'을 응답에 싣는다.
# merchant_timesales 는 한 요청에서 select(활성 조회) → insert(발행) 로 두 번 쓰이는데 공용
# FakeSupabase 는 둘을 구분하지 못한다 — 모드를 구분하는 전용 Fake 를 쓴다.
# =========================================================================


class _TimesaleFakeTable(FakeTable):
    """merchant_timesales 전용 — insert() 를 거친 체인만 발행 결과를 돌려준다."""

    def __init__(self, active_rows: list, inserted_row: dict):
        super().__init__(active_rows)
        self._inserted = inserted_row
        self._is_insert = False

    def insert(self, _row):
        self._is_insert = True
        return self

    def execute(self):
        return _FakeResult([self._inserted] if self._is_insert else self._data)


class _TimesaleFakeSupabase:
    def __init__(self, facilities: list, active_rows: list, inserted_row: dict):
        self._facilities = facilities
        self._active_rows = active_rows
        self._inserted_row = inserted_row

    def table(self, name: str):
        if name == "merchant_timesales":
            # 호출마다 새 인스턴스 — select 체인과 insert 체인이 모드를 공유하지 않게 한다.
            return _TimesaleFakeTable(self._active_rows, self._inserted_row)
        if name == "facilities":
            return FakeTable(self._facilities)
        return FakeTable([])


_FACILITY = {"id": "f-1", "name": "시설-f-1"}


def _issue(client, rate: float):
    return client.post(
        "/api/v1/merchant/timesale",
        headers=_merchant_headers(),
        json={"facility_id": "f-1", "rate": rate, "duration_minutes": 60},
    )


def test_merchant_timesale_create_reports_higher_active_sale(client):
    """기존 활성 30% 가 있는데 15% 를 발행하면 — 발행은 성공하되 적용은 30% 임을 알린다."""
    active = [{"rate": 0.3, "starts_at": "2026-07-15T00:00:00+00:00", "ends_at": "2099-01-01T00:00:00+00:00",
               "canceled_at": None}]
    inserted = {"id": "ts-2", "facility_id": "f-1", "rate": 0.15}
    with patch(
        "app.routers.merchant.supabase_admin",
        new=_TimesaleFakeSupabase([_FACILITY], active, inserted),
    ):
        res = _issue(client, 0.15)

    assert res.status_code == 200  # 하드 제약 없음 — 발행 자체는 막지 않는다
    body = res.json()
    assert body["id"] == "ts-2"
    assert body["other_active_timesale_count"] == 1
    assert body["effective_timesale_rate"] == 0.3  # 오버레이는 최댓값만 쓴다
    assert "30%" in body["effective_timesale_note"]


def test_merchant_timesale_create_new_sale_wins(client):
    """기존 15% 위에 30% 를 발행하면 적용 할인율은 방금 발행한 30%."""
    active = [{"rate": 0.15, "starts_at": "2026-07-15T00:00:00+00:00", "ends_at": "2099-01-01T00:00:00+00:00",
               "canceled_at": None}]
    inserted = {"id": "ts-2", "facility_id": "f-1", "rate": 0.3}
    with patch(
        "app.routers.merchant.supabase_admin",
        new=_TimesaleFakeSupabase([_FACILITY], active, inserted),
    ):
        res = _issue(client, 0.3)

    body = res.json()
    assert body["other_active_timesale_count"] == 1
    assert body["effective_timesale_rate"] == 0.3
    assert body["effective_timesale_note"]  # 중복 사실은 여전히 안내한다


def test_merchant_timesale_create_no_active_has_no_note(client):
    """활성 세일이 없으면 안내 문구 없음 — 적용 할인율은 방금 발행한 값."""
    inserted = {"id": "ts-1", "facility_id": "f-1", "rate": 0.2}
    with patch(
        "app.routers.merchant.supabase_admin",
        new=_TimesaleFakeSupabase([_FACILITY], [], inserted),
    ):
        res = _issue(client, 0.2)

    body = res.json()
    assert body["other_active_timesale_count"] == 0
    assert body["effective_timesale_rate"] == 0.2
    assert body["effective_timesale_note"] is None


def test_merchant_timesale_create_lookup_failure_reports_unknown(client):
    """활성 조회가 깨져도 발행은 성공해야 하고, 모르는 값을 지어내지 않는다(None)."""

    class _RaisingSelectTable(_TimesaleFakeTable):
        def execute(self):
            if not self._is_insert:
                raise RuntimeError("relation \"merchant_timesales\" does not exist")
            return _FakeResult([self._inserted])

    class _Supa(_TimesaleFakeSupabase):
        def table(self, name: str):
            if name == "merchant_timesales":
                return _RaisingSelectTable([], {"id": "ts-1", "facility_id": "f-1", "rate": 0.15})
            return FakeTable(self._facilities if name == "facilities" else [])

    with patch("app.routers.merchant.supabase_admin", new=_Supa([_FACILITY], [], {})):
        res = _issue(client, 0.15)

    assert res.status_code == 200  # 안내는 부가 정보 — 발행을 실패시키지 않는다
    body = res.json()
    assert body["id"] == "ts-1"
    assert body["other_active_timesale_count"] is None
    assert body["effective_timesale_rate"] is None
    assert body["effective_timesale_note"] is None
