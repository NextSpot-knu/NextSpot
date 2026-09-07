# 머천트 콘솔(소상공인 '내 가게 대시보드') 라우터 테스트 — 실제 DB/네트워크 없이
# require_merchant 가드·성적표 집계·타임세일 발행/취소·좌석 상태 방송을 검증한다.
#  · 인증: Supabase JWT + users.role='merchant' + facility_owners 소유권(RBAC).
#         이 파일은 **엔드포인트 로직**을 보므로 프로필 로더만 목으로 대체하고,
#         역할·소유권 자체의 계약은 test_merchant_rbac.py 가 따로 잠근다.
#  · DB: supabase_admin 은 test_routers.py 의 공용 FakeSupabase(canned 데이터)로 대체 — PostgREST 호출 없음.
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import merchant

# test_routers.py 의 공용 Fake(체이닝 흡수 + table별 canned)를 재사용한다.
from tests.routers.test_routers import FakeSupabase, FakeTable, _FakeResult

# settings.MERCHANT_API_TOKEN 의 데모 기본값. tests/conftest.py 가 같은 값으로 env 를 고정해
# 로컬 .env 유무와 무관하게 결정적이다(pydantic-settings 는 env var 를 .env 보다 우선한다).
# 테스트가 다루는 가게. 아래 픽스처가 이 가게의 소유자로 요청을 태운다.
OWNED_FACILITY_ID = "f-1"
# 소유는 하지만 facilities 에 행이 없는 가게 — '없는 시설 → 404' 계약 검증용.
# (소유하지 않은 id 를 쓰면 소유권 검사가 먼저 403 을 내서 404 를 볼 수 없다.)
OWNED_BUT_MISSING_ID = "ghost"


def _merchant_headers(token: str | None = None) -> dict:
    """JWT 경로용 헤더. 값은 아래 프로필 목이 대신하므로 형식만 갖춘다."""
    return {"Authorization": f"Bearer {token or 'test-jwt'}"}


# 이 라우터는 아직 app/main.py 에 등록되지 않았다(통합 단계에서 배선 예정 — docs 참고).
# 등록 여부와 무관하게 라우터 자체를 검증하기 위해, merchant.router 만 얹은 독립 테스트 앱을 쓴다.
@pytest.fixture
def client():
    test_app = FastAPI()
    test_app.include_router(merchant.router)
    with TestClient(test_app) as c:
        yield c


@pytest.fixture(autouse=True)
def _merchant_profile():
    """이 파일의 기본 요청자 — f-1 을 소유한 사업자.

    엔드포인트 로직 검증이 목적이라 인증은 여기서 고정한다. 인증·소유권 자체가 틀렸을 때의
    거동은 test_merchant_rbac.py 가 별도로 검증한다(그쪽이 이 목을 쓰지 않는다).
    콘솔 차단 스위치도 켜진 상태(정상)로 둔다.
    """
    profile = {
        "id": "00000000-0000-0000-0000-0000000000f1",
        "email": "owner@example.com",
        "is_anonymous": False,
        "role": "merchant",
        "facility_ids": frozenset({OWNED_FACILITY_ID, OWNED_BUT_MISSING_ID}),
    }
    with patch.object(
        merchant, "load_profile_from_request", new=AsyncMock(return_value=profile)
    ), patch.object(
        merchant, "require_merchant_console_enabled", new=AsyncMock(return_value=None)
    ):
        yield profile
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


class _CapturingCongestionTable(FakeTable):
    def __init__(self, captured: dict):
        super().__init__([])
        self._captured = captured

    def insert(self, payload):
        self._captured["congestion_log"] = payload
        self._data = [payload]
        return self


class _CapturingFacilitiesSupabase:
    def __init__(self, facility: dict, captured: dict):
        self._facility = facility
        self._captured = captured

    def table(self, name: str):
        if name == "facilities":
            return _CapturingFacilitiesTable([self._facility], self._captured)
        if name == "congestion_logs":
            return _CapturingCongestionTable(self._captured)
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
    assert "updated_at" in body  # 기존 3키는 그대로(응답 봉투 불변)
    # 해제에는 남길 관측 자체가 없다 — '기록 실패(False)' 와 구분해 None 으로 준다.
    assert body["observation_logged"] is None
    assert body["observation_note"] is None
    assert "congestion_log" not in captured

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
    """좌석 방송은 최신 JSON과 출처가 명시된 시계열 관측을 함께 기록한다."""
    facility = {"id": "f-1", "capacity": 40, "features": {"average_processing_time": 10}}
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
    log = captured["congestion_log"]
    assert log["source"] == "merchant_report"
    assert log["evidence_tier"] == "verified"
    assert log["congestion_level"] == pytest.approx(0.5)
    assert log["current_count"] == 20
    # 둘 다 성공했음을 응답이 말해 준다(성공을 침묵으로 표현하지 않는다).
    assert res.json()["observation_logged"] is True
    assert res.json()["observation_note"] is None


# =========================================================================
# 5-2. 부분 커밋(감사 P1) — 좌석 방송은 두 테이블에 나눠 쓰는데 트랜잭션이 없다.
# 예전에는 둘을 한 try 로 묶어, 두 번째(congestion_logs)가 깨지면 500 을 던졌다.
# 그런데 첫 번째(facilities)는 이미 커밋된 뒤였다 — 손님 화면의 좌석 상태는 바뀌었는데
# 사장님 화면만 '실패' 라고 말했고, 다시 눌러도 같은 일이 반복됐다.
# 아래 두 테스트가 '주 효과=방송' 이라는 판단과 그 실패 보고 방식을 잠근다.
# =========================================================================


class _LogFailingSupabase(_CapturingFacilitiesSupabase):
    """facilities 갱신은 성공하고 congestion_logs insert 만 터지는 배포 상황 재현."""

    def table(self, name: str):
        if name == "congestion_logs":
            class _Raising(FakeTable):
                def insert(self, _payload):
                    return self

                def execute(self):
                    raise RuntimeError('relation "congestion_logs" is unavailable')

            return _Raising([])
        return super().table(name)


def test_merchant_seat_status_log_failure_keeps_broadcast_and_reports_it(client):
    """관측 로그가 실패해도 방송은 살아 있고, 응답이 그 사실을 숨기지 않는다.

    되돌리면(두 쓰기를 한 try 로 다시 묶으면) 이 테스트는 500 을 받아 실패한다.
    """
    facility = {"id": "f-1", "capacity": 40, "features": {"average_processing_time": 10}}
    captured: dict = {}
    with patch(
        "app.routers.merchant.supabase_admin",
        new=_LogFailingSupabase(facility, captured),
    ):
        res = client.post(
            "/api/v1/merchant/seat-status",
            headers=_merchant_headers(),
            json={"facility_id": "f-1", "level": "low"},
        )

    # 주 효과(화면에 보이는 좌석 상태)는 실제로 커밋됐다 — 실패라고 말하지 않는다.
    assert res.status_code == 200
    assert captured["payload"]["features"]["seat_status"]["level"] == "low"

    body = res.json()
    assert body["level"] == "low"
    # 그러나 조용히 삼키지도 않는다 — 무엇이 빠졌는지 응답에 실어 보낸다.
    assert body["observation_logged"] is False
    assert body["observation_note"]
    assert "관측" in body["observation_note"]


def test_merchant_seat_status_facilities_failure_is_still_500(client):
    """반대로 '주 효과' 인 facilities 갱신이 깨지면 그건 진짜 실패다 — 200 으로 넘기지 않는다."""

    class _UpdateRaisingTable(FakeTable):
        """update() 를 거친 체인만 터진다 — select(존재 확인)는 정상 통과시킨다."""

        def __init__(self, data):
            super().__init__(data)
            self._is_update = False

        def update(self, _payload):
            self._is_update = True
            return self

        def execute(self):
            if self._is_update:
                raise RuntimeError("update failed")
            return _FakeResult(self._data)

    class _UpdateFailingSupabase(_CapturingFacilitiesSupabase):
        def table(self, name: str):
            if name == "facilities":
                return _UpdateRaisingTable([self._facility])
            return super().table(name)

    captured: dict = {}
    with patch(
        "app.routers.merchant.supabase_admin",
        new=_UpdateFailingSupabase({"id": "f-1", "capacity": 40, "features": {}}, captured),
    ):
        res = client.post(
            "/api/v1/merchant/seat-status",
            headers=_merchant_headers(),
            json={"facility_id": "f-1", "level": "full"},
        )
    assert res.status_code == 500
    # 관측 로그는 시도조차 하지 않는다(방송이 없었으니 남길 관측도 없다).
    assert "congestion_log" not in captured


def test_merchant_seat_status_clear_facility_404(client):
    """해제도 존재하지 않는 시설이면 기존과 동일하게 404."""
    with patch("app.routers.merchant.supabase_admin", new=FakeSupabase({"facilities": []})):
        res = client.post(
            "/api/v1/merchant/seat-status",
            headers=_merchant_headers(),
            json={"facility_id": "ghost", "level": None},
        )
    assert res.status_code == 404


# =========================================================================
# 5-3. 남용 방지(감사 10번) — 같은 버튼을 N번 누르면 verified 학습 정답이 N줄 쌓였다.
# 방송(facilities) 자체는 그대로 두고 **관측 행만** 거른다:
#   · 직전 관측이 10분 이내면 생략(좌석 만료 30분 안에 최대 3번)
#   · 값이 직전과 같으면 간격과 무관하게 생략
# 눌러도 아무 일도 없는 버튼이 되지 않게, 남은 시간은 **서버가 계산해** 응답에 실어 준다.
# =========================================================================


class _SeatLogSupabase(_CapturingFacilitiesSupabase):
    """congestion_logs 의 '직전 관측 조회' 에 canned 행을 물리고 insert 를 붙잡는 Fake."""

    def __init__(self, facility: dict, captured: dict, previous: list[dict] | None = None):
        super().__init__(facility, captured)
        self._previous = previous or []

    def table(self, name: str):
        if name == "congestion_logs":
            return _PreviousLogTable(self._previous, self._captured)
        return super().table(name)


class _PreviousLogTable(FakeTable):
    """select 체인은 직전 관측을 돌려주고, insert 는 payload 를 captured 에 남긴다."""

    def __init__(self, previous: list[dict], captured: dict):
        super().__init__(previous)
        self._captured = captured

    def insert(self, payload):
        self._captured["congestion_log"] = payload
        self._data = [payload]
        return self


def _ago(minutes: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()


def _post_seat(client, level: str, previous: list[dict], captured: dict):
    facility = {"id": "f-1", "capacity": 40, "features": {"average_processing_time": 10}}
    with patch(
        "app.routers.merchant.supabase_admin",
        new=_SeatLogSupabase(facility, captured, previous),
    ):
        return client.post(
            "/api/v1/merchant/seat-status",
            headers=_merchant_headers(),
            json={"facility_id": "f-1", "level": level},
        )


def test_merchant_seat_status_throttles_repeat_log_within_interval(client):
    """직전 관측이 10분 이내면 새 관측을 남기지 않는다 — 방송 자체는 그대로 반영된다.

    빈도 제한을 없애면 이 테스트는 congestion_log 가 남아 실패한다.
    """
    captured: dict = {}
    # 3분 전에 '여유(0.15)' 를 기록해 뒀다. 지금은 '만석(0.9)' 이라 값은 달라졌지만 간격이 짧다.
    res = _post_seat(client, "full", [{"timestamp": _ago(3), "congestion_level": 0.15}], captured)

    assert res.status_code == 200
    body = res.json()
    # ① 방송(주 효과)은 막지 않는다 — 손님 화면과 추천 반영 창은 새로 시작한다.
    assert captured["payload"]["features"]["seat_status"]["level"] == "full"
    assert body["level"] == "full"
    # ② 학습 정답이 되는 관측 행만 생략됐다.
    assert "congestion_log" not in captured
    assert body["observation_status"] == "throttled"
    # '기록 실패'(False)와 구분한다 — 실패가 아니므로 프런트가 장애 문구를 띄우면 안 된다.
    assert body["observation_logged"] is None
    # 남은 시간은 서버가 계산해서 준다(클라이언트 시계를 믿지 않는다). 3분 지났으니 7분쯤 남았다.
    assert 6 * 60 < body["next_observation_in_seconds"] <= 7 * 60
    assert "다시 기록됩니다" in body["observation_note"]


def test_merchant_seat_status_skips_log_when_value_is_unchanged(client):
    """값이 직전과 같으면 간격과 무관하게 생략한다 — 같은 사실을 두 번 적는 것일 뿐이다."""
    captured: dict = {}
    # 두 시간 전 기록이라 간격 제한에는 걸리지 않는다. 그런데 값이 같다.
    res = _post_seat(client, "mid", [{"timestamp": _ago(120), "congestion_level": 0.5}], captured)

    assert res.status_code == 200
    body = res.json()
    assert captured["payload"]["features"]["seat_status"]["level"] == "mid"
    assert "congestion_log" not in captured
    assert body["observation_status"] == "unchanged"
    assert body["observation_logged"] is None
    # 기다린다고 기록되는 게 아니라 값이 바뀌어야 기록된다 — 없는 카운트다운을 만들지 않는다.
    assert body["next_observation_in_seconds"] is None
    assert "같은 상태" in body["observation_note"]


def test_merchant_seat_status_logs_again_after_interval(client):
    """간격이 지났고 값도 달라졌으면 정상적으로 관측을 남기고, 다음 기록까지의 시간을 알려준다."""
    captured: dict = {}
    res = _post_seat(client, "full", [{"timestamp": _ago(11), "congestion_level": 0.15}], captured)

    assert res.status_code == 200
    body = res.json()
    assert captured["congestion_log"]["evidence_tier"] == "verified"
    assert captured["congestion_log"]["congestion_level"] == pytest.approx(0.9)
    assert body["observation_status"] == "logged"
    assert body["observation_logged"] is True
    assert body["next_observation_in_seconds"] == 600


def test_merchant_seat_status_logs_when_no_previous_observation(client):
    """직전 관측이 아예 없으면(첫 방송) 당연히 기록한다 — 제한이 첫 관측을 삼키지 않는다."""
    captured: dict = {}
    res = _post_seat(client, "low", [], captured)

    assert res.status_code == 200
    assert captured["congestion_log"]["source"] == "merchant_report"
    assert res.json()["observation_status"] == "logged"


def test_seat_observation_decision_survives_unreadable_previous_row():
    """직전 행을 못 읽으면 '차단' 이 아니라 '기록' 으로 기운다 — 판정 불가로 관측을 버리지 않는다."""
    now = datetime(2026, 7, 15, 3, 0, tzinfo=timezone.utc)
    # 시각을 못 읽는 행: 값은 달라서 unchanged 도 아니다.
    assert merchant._seat_observation_decision({"timestamp": "not-a-time", "congestion_level": 0.15}, 0.9, now) == ("log", None)
    # 값을 못 읽는 행: '같다' 고 단정하지 않고 간격만 본다.
    assert merchant._seat_observation_decision(
        {"timestamp": (now - timedelta(minutes=30)).isoformat(), "congestion_level": "?"}, 0.9, now
    ) == ("log", None)


def test_seat_observation_decision_clamps_clock_skew():
    """직전 기록 시각이 미래로 어긋나 있어도 남은 시간을 간격 이상으로 부풀리지 않는다."""
    now = datetime(2026, 7, 15, 3, 0, tzinfo=timezone.utc)
    status, remaining = merchant._seat_observation_decision(
        {"timestamp": (now + timedelta(hours=5)).isoformat(), "congestion_level": 0.15}, 0.9, now
    )
    assert status == "throttled"
    assert remaining == merchant._SEAT_OBSERVATION_MIN_INTERVAL_SECONDS


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
