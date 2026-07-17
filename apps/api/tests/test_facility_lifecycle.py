# 폐업·표출중단 자동 감지(2차 기획 1위) — 신규 기능 테스트.
#
#   A. app.routers.infrastructures.fetch_active_facilities
#      추천/코스/예측/시설목록이 공용으로 쓰는 is_active 필터 래퍼. is_active 컬럼이 아직 배포되지
#      않은 상태(마이그레이션 미적용, PostgREST 42703)에서도 500 대신 필터 없이 폴백해야 한다.
#   B. scripts/ingest_tourapi.py 의 --sync 스텝(showflag 동기화)
#      area_based_sync_list() 결과(showflag)를 facilities.is_active 에 반영 + app_events 기록.
#
#   실측(2026-07-15, 실 TOURAPI_KEY·실 Supabase 로 직접 확인 — client.py 는 수정하지 않음):
#     · areaCode=35+sigunguCode=2 가 경주(587건, 기존 적재 69건 중 67건 매칭). showflag 는
#       문자열 '1'(표출)/'0'(비표출) 두 값만 관측(정식 감지 모드로 구현, 저하 모드 아님).
#     · is_active 컬럼 미배포 상태에서 `.select("...is_active")` 는 실제로
#       postgrest.exceptions.APIError(code='42703', message='column facilities.is_active does not exist')
#       를 던진다 — 아래 _missing_column_error() 가 그 형태를 그대로 재현한다.
import argparse
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import infrastructures
import scripts.ingest_tourapi as ingest_tourapi


# ---------------------------------------------------------------------------
# 공용 fake — postgrest APIError(undefined_column) 재현 + Supabase 체이닝 흡수
# ---------------------------------------------------------------------------
class _FakeAPIError(Exception):
    """실측(위 헤더 주석)과 동일한 속성(.code/.message)을 갖는 postgrest.exceptions.APIError 재현."""

    def __init__(self, code, message):
        self.code = code
        self.message = message
        super().__init__(message)


def _missing_column_error() -> _FakeAPIError:
    return _FakeAPIError("42703", "column facilities.is_active does not exist")


class _FakeResult:
    def __init__(self, data):
        self.data = data


class _StatefulFacilitiesTable:
    """.execute() 호출 횟수를 세고, raise_once 가 있으면 1회차만 그 예외를 던진다(폴백 재시도 검증용).
    그 외 체이닝 메서드(select/eq/gte/...)는 전부 self 를 반환해 흡수한다."""

    def __init__(self, rows, raise_once: Exception | None = None):
        self.rows = rows
        self._raise_once = raise_once
        self.call_count = 0

    def __getattr__(self, _name):
        def _chain(*_a, **_kw):
            return self
        return _chain

    def execute(self):
        self.call_count += 1
        if self._raise_once is not None and self.call_count == 1:
            raise self._raise_once
        return _FakeResult(self.rows)


class _StatefulSupabase:
    def __init__(self, table_map: dict):
        self._table_map = table_map

    def table(self, name: str):
        return self._table_map[name]


def _sync_payload(items: list[dict], total: int | None = None) -> dict:
    """areaBasedSyncList2 응답 골격(test_tourapi.py 의 _payload 헬퍼와 동일 관례)."""
    body = {"items": {"item": items} if items else "", "numOfRows": 100, "pageNo": 1}
    if total is not None:
        body["totalCount"] = total
    return {"response": {"header": {"resultCode": "0000", "resultMsg": "OK"}, "body": body}}


# =========================================================================
# A. fetch_active_facilities — is_active 필터 적용 + 컬럼 부재 폴백
# =========================================================================

def test_fetch_active_facilities_applies_is_active_filter():
    """정상 경로: fetch_all_rows 에 넘겨지는 apply_filters 가 is_active=true 를 건다."""
    recorded: list[tuple] = []

    class _Spy:
        def eq(self, field, value):
            recorded.append((field, value))
            return self

    def fake_fetch_all_rows(client, table, select, apply_filters=None):
        assert table == "facilities"
        if apply_filters is not None:
            apply_filters(_Spy())
        return [{"id": "f1", "is_active": True}]

    with patch.object(infrastructures, "fetch_all_rows", side_effect=fake_fetch_all_rows):
        import asyncio
        result = asyncio.run(infrastructures.fetch_active_facilities(object(), "*"))

    assert result == [{"id": "f1", "is_active": True}]
    assert ("is_active", True) in recorded


def test_fetch_active_facilities_falls_back_when_column_missing():
    """is_active 컬럼 미배포(42703) → 필터 없이 재조회해 500 대신 전체 목록 반환(무중단 저하)."""
    calls: list = []

    def fake_fetch_all_rows(client, table, select, apply_filters=None):
        calls.append(apply_filters)
        if len(calls) == 1:
            raise _missing_column_error()
        return [{"id": "f1"}, {"id": "f2"}]

    with patch.object(infrastructures, "fetch_all_rows", side_effect=fake_fetch_all_rows):
        import asyncio
        result = asyncio.run(infrastructures.fetch_active_facilities(object(), "*"))

    assert result == [{"id": "f1"}, {"id": "f2"}]
    assert len(calls) == 2  # 1차(필터 시도, 42703) → 2차(무필터 재조회)


def test_fetch_active_facilities_reraises_unrelated_errors():
    """is_active 무관 오류는 폴백하지 않고 그대로 전파(500 처리는 라우터의 기존 예외 핸들러 몫)."""
    def fake_fetch_all_rows(client, table, select, apply_filters=None):
        raise RuntimeError("network down")

    with patch.object(infrastructures, "fetch_all_rows", side_effect=fake_fetch_all_rows):
        import asyncio
        with pytest.raises(RuntimeError, match="network down"):
            asyncio.run(infrastructures.fetch_active_facilities(object(), "*"))


def test_infrastructures_endpoint_falls_back_when_column_missing_end_to_end():
    """GET /api/v1/infrastructures 전체 경로: 컬럼 부재에도 500 이 아니라 200 + is_active=None."""
    row = {
        "id": "f1", "name": "시설", "type": "restaurant", "latitude": 35.8, "longitude": 129.2,
        "capacity": 10, "operating_hours": None, "features": None,
    }
    fac_table = _StatefulFacilitiesTable([row], raise_once=_missing_column_error())
    fake_client = _StatefulSupabase({"facilities": fac_table})

    with patch.object(infrastructures, "supabase_client", fake_client), \
         patch.object(infrastructures, "fetch_latest_congestion_for_all", new=AsyncMock(return_value={})):
        app = FastAPI()
        app.include_router(infrastructures.router)
        client = TestClient(app)
        res = client.get("/api/v1/infrastructures")

    assert res.status_code == 200
    body = res.json()
    assert len(body) == 1
    assert body[0]["is_active"] is None  # 값 조회 불가 — 지어내지 않고 정직하게 None
    assert fac_table.call_count == 2


def test_infrastructures_endpoint_passes_through_is_active_values():
    """is_active 컬럼이 있으면 True/False 값이 응답에 그대로 실린다(saved 페이지 배지 판단 근거)."""
    rows = [
        {"id": "f1", "name": "정상영업", "type": "cafe", "latitude": 1.0, "longitude": 1.0,
         "capacity": 5, "operating_hours": None, "features": None, "is_active": True},
        {"id": "f2", "name": "비표출감지", "type": "cafe", "latitude": 1.0, "longitude": 1.0,
         "capacity": 5, "operating_hours": None, "features": None, "is_active": False},
    ]
    fac_table = _StatefulFacilitiesTable(rows)
    fake_client = _StatefulSupabase({"facilities": fac_table})

    with patch.object(infrastructures, "supabase_client", fake_client), \
         patch.object(infrastructures, "fetch_latest_congestion_for_all", new=AsyncMock(return_value={})):
        app = FastAPI()
        app.include_router(infrastructures.router)
        client = TestClient(app)
        res = client.get("/api/v1/infrastructures")

    assert res.status_code == 200
    by_id = {item["id"]: item for item in res.json()}
    assert by_id["f1"]["is_active"] is True
    assert by_id["f2"]["is_active"] is False
    assert fac_table.call_count == 1


# =========================================================================
# B. scripts/ingest_tourapi.py — showflag 동기화(폐업/표출중단 감지)
# =========================================================================

def test_fetch_showflag_map_paginates_and_builds_map():
    page1 = [{"contentid": "1", "showflag": "1"}, {"contentid": "2", "showflag": "0"}]
    page2 = [{"contentid": "3", "showflag": "1"}]
    mock_call = AsyncMock(side_effect=[_sync_payload(page1, total=3), _sync_payload(page2, total=3)])

    with patch.object(ingest_tourapi, "area_based_sync_list", mock_call), \
         patch.object(ingest_tourapi, "SYNC_PAGE_ROWS", 2):
        import asyncio
        result = asyncio.run(ingest_tourapi.fetch_showflag_map(area_code=35, sigungu_code=2))

    assert result == {"1": "1", "2": "0", "3": "1"}
    assert mock_call.await_count == 2
    # 실측 코드(areaCode=35, sigunguCode=2=경주)가 그대로 전달됐는지 확인
    _, kwargs = mock_call.await_args_list[0]
    assert kwargs["area_code"] == 35 and kwargs["sigungu_code"] == 2


def test_fetch_showflag_map_empty_response_returns_empty_map():
    mock_call = AsyncMock(return_value=_sync_payload([]))
    with patch.object(ingest_tourapi, "area_based_sync_list", mock_call):
        import asyncio
        result = asyncio.run(ingest_tourapi.fetch_showflag_map())

    assert result == {}
    assert mock_call.await_count == 1


def test_sync_showflags_empty_map_is_noop_without_db_call():
    # showflag_by_id 가 비면 DB 조회조차 하지 않는다(app.core.supabase.supabase_admin 패치 불필요).
    summary = ingest_tourapi.sync_showflags({})
    assert summary == {"checked": 0, "deactivated": [], "reactivated": 0, "degraded": False, "reason": None}


def test_sync_showflags_deactivates_reactivates_and_skips_noop_and_unknown():
    rows = [
        {"id": "id-a", "contentid": "1", "is_active": True},   # showflag=0 → 신규 비표출 감지
        {"id": "id-b", "contentid": "2", "is_active": False},  # showflag=1 → 재표출(복구)
        {"id": "id-c", "contentid": "3", "is_active": True},   # showflag=1 → 변화 없음(no-op)
        {"id": "id-d", "contentid": "4", "is_active": False},  # showflag=0 → 이미 비활성(재기록 안 함)
        {"id": "id-e", "contentid": "5", "is_active": True},   # 이번 동기화 목록에 없음 → checked 제외
        {"id": "id-f", "contentid": "6", "is_active": True},   # showflag='2'(실측 미관측 미상값) → 스킵
    ]
    facilities = _RecordingFacilitiesTable(rows)
    admin = _FakeAdmin(facilities)
    showflag_map = {"1": "0", "2": "1", "3": "1", "4": "0", "6": "2"}

    with patch("app.core.supabase.supabase_admin", admin):
        summary = ingest_tourapi.sync_showflags(showflag_map)

    assert summary["checked"] == 5  # contentid 1,2,3,4,6 매칭 (5 는 목록에 없어 제외)
    assert summary["deactivated"] == ["1"]
    assert summary["reactivated"] == 1
    assert summary["degraded"] is False
    assert facilities.update_calls == [("id-a", {"is_active": False}), ("id-b", {"is_active": True})]


def test_sync_showflags_degrades_gracefully_when_column_missing():
    facilities = _RecordingFacilitiesTable(rows=[], select_error=_missing_column_error())
    admin = _FakeAdmin(facilities)

    with patch("app.core.supabase.supabase_admin", admin):
        summary = ingest_tourapi.sync_showflags({"1": "0"})

    assert summary["degraded"] is True
    assert "is_active" in summary["reason"]
    assert summary["deactivated"] == [] and summary["reactivated"] == 0
    assert facilities.update_calls == []  # 갱신을 시도조차 하지 않음(오탐 방지)


def test_run_showflag_sync_records_single_app_event_with_written_passthrough():
    rows = [{"id": "id-a", "contentid": "1", "is_active": True}]
    facilities = _RecordingFacilitiesTable(rows)
    app_events = _RecordingAppEventsTable()
    admin = _FakeAdmin(facilities, app_events)
    mock_call = AsyncMock(return_value=_sync_payload([{"contentid": "1", "showflag": "0"}], total=1))

    with patch.object(ingest_tourapi, "area_based_sync_list", mock_call), \
         patch("app.core.supabase.supabase_admin", admin):
        import asyncio
        summary = asyncio.run(ingest_tourapi.run_showflag_sync(written=42))

    assert summary["deactivated"] == ["1"]
    assert len(app_events.insert_calls) == 1
    event = app_events.insert_calls[0]
    assert event["event"] == "tourapi_sync"
    assert event["props"]["deactivated"] == ["1"]
    assert event["props"]["reactivated"] == 0
    assert event["props"]["checked"] == 1
    # written 을 함께 남겨 GET /api/v1/freshness(최신 tourapi_sync 1행)의 기존 '적재 행수' 표기가
    # 이 신규 스텝 때문에 조용히 null 로 퇴화하지 않게 한다(회귀 방지).
    assert event["props"]["written"] == 42


def _run_args(*, sync: bool) -> argparse.Namespace:
    return argparse.Namespace(
        lat=ingest_tourapi.DEFAULT_LAT, lng=ingest_tourapi.DEFAULT_LNG,
        radius=ingest_tourapi.DEFAULT_RADIUS_M, limit=1,
        dry_run=False, details=False, sync=sync,
    )


def test_run_skips_sync_step_when_no_sync_flag_set():
    """--no-sync(args.sync=False) 면 run_showflag_sync 자체가 호출되지 않는다."""
    fake_row = {
        "name": "t", "type": "attraction", "latitude": 1.0, "longitude": 1.0, "address": None,
        "contentid": "1", "contenttypeid": 12, "image_url": None, "capacity": 300,
        "features": {"source": "tourapi"},
    }
    admin = _FakeAdmin(_RecordingFacilitiesTable([]), _RecordingAppEventsTable())

    with patch.object(ingest_tourapi, "fetch_pois", new=AsyncMock(return_value={12: [{"x": 1}]})), \
         patch.object(ingest_tourapi, "transform_poi", return_value=fake_row), \
         patch.object(ingest_tourapi, "upsert_facilities", return_value=1), \
         patch.object(ingest_tourapi, "run_showflag_sync", new=AsyncMock()) as sync_mock, \
         patch("app.core.supabase.supabase_admin", admin):
        import asyncio
        exit_code = asyncio.run(ingest_tourapi.run(_run_args(sync=False)))

    assert exit_code == 0
    sync_mock.assert_not_called()


def test_run_calls_sync_step_by_default():
    """기본(args.sync=True) 이면 적재 완료 후 run_showflag_sync 가 written 값과 함께 호출된다."""
    fake_row = {
        "name": "t", "type": "attraction", "latitude": 1.0, "longitude": 1.0, "address": None,
        "contentid": "1", "contenttypeid": 12, "image_url": None, "capacity": 300,
        "features": {"source": "tourapi"},
    }
    admin = _FakeAdmin(_RecordingFacilitiesTable([]), _RecordingAppEventsTable())

    with patch.object(ingest_tourapi, "fetch_pois", new=AsyncMock(return_value={12: [{"x": 1}]})), \
         patch.object(ingest_tourapi, "transform_poi", return_value=fake_row), \
         patch.object(ingest_tourapi, "upsert_facilities", return_value=1), \
         patch.object(
             ingest_tourapi, "run_showflag_sync",
             new=AsyncMock(return_value={"checked": 0, "deactivated": [], "reactivated": 0, "degraded": False, "reason": None}),
         ) as sync_mock, \
         patch("app.core.supabase.supabase_admin", admin):
        import asyncio
        exit_code = asyncio.run(ingest_tourapi.run(_run_args(sync=True)))

    assert exit_code == 0
    sync_mock.assert_awaited_once_with(1)  # written=1(위 upsert_facilities 목값)과 함께 호출


# ---------------------------------------------------------------------------
# B 전용 fake — facilities(select/update)·app_events(insert) 체이닝 흡수 + 호출 기록
# ---------------------------------------------------------------------------
class _RecordingFacilitiesTable:
    def __init__(self, rows, select_error: Exception | None = None):
        self.rows = rows
        self.select_error = select_error
        self.update_calls: list[tuple] = []  # [(id, payload)]
        self._mode: str | None = None
        self._pending_payload: dict | None = None

    def select(self, *_a, **_kw):
        self._mode = "select"
        return self

    @property
    def not_(self):
        return self

    def is_(self, *_a, **_kw):
        return self

    def update(self, payload):
        self._mode = "update"
        self._pending_payload = payload
        return self

    def eq(self, field, value):
        if self._mode == "update" and field == "id":
            self.update_calls.append((value, dict(self._pending_payload)))
        return self

    def execute(self):
        if self._mode == "select":
            if self.select_error is not None:
                raise self.select_error
            return _FakeResult(self.rows)
        return _FakeResult(None)


class _RecordingAppEventsTable:
    def __init__(self):
        self.insert_calls: list[dict] = []

    def insert(self, payload):
        self.insert_calls.append(payload)
        return self

    def execute(self):
        return _FakeResult([{"id": "evt-1"}])


class _FakeAdmin:
    def __init__(self, facilities: _RecordingFacilitiesTable, app_events: "_RecordingAppEventsTable | None" = None):
        self._tables = {"facilities": facilities, "app_events": app_events or _RecordingAppEventsTable()}

    def table(self, name: str):
        return self._tables[name]


# ---------------------------------------------------------------------------
# C. upsert_facilities features 병합 (P0, 2026-07-17)
#    통째 교체하면 배치 밖에서 축적된 키(overview_i18n 번역·image_source 라이선스)가
#    일배치 cron 마다 소실된다 — {**기존, **신규} 병합과 fail-closed 를 검증한다.
# ---------------------------------------------------------------------------
class _MergeCaptureTable:
    """SELECT 는 기존 행을 돌려주고 upsert 페이로드를 캡처한다(체이닝은 자신 반환으로 흡수)."""

    def __init__(self, existing_rows, select_error: Exception | None = None):
        self.existing_rows = existing_rows
        self.select_error = select_error
        self.upserted: list[dict] = []
        self._mode = None

    def select(self, *_a, **_k):
        self._mode = "select"
        return self

    @property
    def not_(self):
        return self

    def is_(self, *_a, **_k):
        return self

    def upsert(self, chunk, **_k):
        self._mode = "upsert"
        self.upserted.extend(chunk)
        return self

    def execute(self):
        if self._mode == "select":
            if self.select_error is not None:
                raise self.select_error
            return _FakeResult(self.existing_rows)
        return _FakeResult([])


def test_upsert_facilities_merges_features_preserving_external_keys():
    table = _MergeCaptureTable([
        {"contentid": "100",
         "features": {"overview_i18n": {"en": "kept-en"}, "cat1": "OLD", "source": "tourapi"}},
    ])
    with patch("app.core.supabase.supabase_admin", _FakeAdmin(table)):
        written = ingest_tourapi.upsert_facilities([
            {"contentid": "100", "name": "기존시설", "features": {"cat1": "NEW", "source": "tourapi"}},
            {"contentid": "200", "name": "신규시설", "features": {"cat1": "X"}},
        ])

    assert written == 2
    merged = next(r for r in table.upserted if r["contentid"] == "100")
    # 배치 밖 축적 키(overview_i18n)는 보존, transform 키(cat1)는 신규 값이 이긴다.
    assert merged["features"] == {"overview_i18n": {"en": "kept-en"}, "cat1": "NEW", "source": "tourapi"}
    fresh = next(r for r in table.upserted if r["contentid"] == "200")
    assert fresh["features"] == {"cat1": "X"}  # 기존 없음 — 그대로


def test_upsert_facilities_fail_closed_when_existing_features_unreadable():
    # 기존 features 를 못 읽으면 병합 불가 — 진행 시 번역이 소실되므로 0건 기록으로 중단해야 한다.
    table = _MergeCaptureTable([], select_error=RuntimeError("network down"))
    with patch("app.core.supabase.supabase_admin", _FakeAdmin(table)):
        written = ingest_tourapi.upsert_facilities([
            {"contentid": "100", "name": "A", "features": {"cat1": "NEW"}},
        ])
    assert written == 0
    assert table.upserted == []  # 어떤 쓰기도 발생하지 않는다
