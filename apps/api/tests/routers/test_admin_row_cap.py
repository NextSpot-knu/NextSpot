# 관리자 집계의 PostgREST 행수 캡 회귀 방지 — apps/api/app/routers/admin.py
#
# 이 파일의 페이크는 **1000행 캡을 실제로 강제한다**. 요청한 만큼 다 돌려주는 관대한 페이크
# (tests/routers/test_routers.py 의 FakeSupabase)로는 이 결함을 절대 잡을 수 없다 —
# `.limit(20000)` 로 되돌려도 그대로 통과하기 때문이다. 선례:
# tests/services/test_area_demand_reliability_service.py 의
# test_query_window_pages_past_the_postgrest_row_cap.
#
# 잡으려는 결함(감사 확정):
#   · /metrics/trend 30일 추이가 최신 1000행으로 쪼그라들고, truncated 는 구조상 절대 안 켜짐
#   · /model-trust 의 활성 시설 수·커버리지·'수집 공백' 목록이 시설 1000곳만 보고 계산됨
#     (= 멀쩡히 관측되는 시설을 '데이터 없음' 으로 지목)
#   · /metrics·/impact·/dashboard/today 의 같은 유형 절단
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import admin
from tests.conftest import admin_headers

# PostgREST 가 단일 응답에서 자르는 행수(기본값). 페이크는 무엇을 요청했든 여기서 자른다.
_POSTGREST_ROW_CAP = 1000


class _FakeResponse:
    def __init__(self, data: list[dict]) -> None:
        self.data = data


class _FakeQuery:
    """PostgREST 쿼리 빌더의 최소 흉내 — 필터/정렬/범위/캡을 실제로 적용한다."""

    def __init__(self, table: str, rows: list[dict], calls: list) -> None:
        self._table = table
        self._rows = rows
        self._calls = calls
        self._filters: list[tuple[str, str, object]] = []
        self._orders: list[tuple[str, bool]] = []
        self._limit: int | None = None
        self._range: tuple[int, int] | None = None

    def select(self, _columns: str) -> "_FakeQuery":
        return self

    def eq(self, column: str, value) -> "_FakeQuery":
        self._filters.append(("eq", column, value))
        return self

    def neq(self, column: str, value) -> "_FakeQuery":
        self._filters.append(("neq", column, value))
        return self

    def gte(self, column: str, value) -> "_FakeQuery":
        self._filters.append(("gte", column, value))
        return self

    def lte(self, column: str, value) -> "_FakeQuery":
        self._filters.append(("lte", column, value))
        return self

    def order(self, column: str, desc: bool = False) -> "_FakeQuery":
        self._orders.append((column, desc))
        return self

    def limit(self, count: int) -> "_FakeQuery":
        self._limit = count
        return self

    def range(self, start: int, end: int) -> "_FakeQuery":
        self._range = (start, end)
        return self

    def _matches(self, row: dict) -> bool:
        for op, column, value in self._filters:
            cell = row.get(column)
            if op == "eq" and cell != value:
                return False
            if op == "neq" and cell == value:
                return False
            if op == "gte" and not (cell is not None and cell >= value):
                return False
            if op == "lte" and not (cell is not None and cell <= value):
                return False
        return True

    def execute(self) -> _FakeResponse:
        rows = [row for row in self._rows if self._matches(row)]
        # 마지막 order 가 1차 정렬 키가 되도록 역순으로 안정 정렬한다(PostgREST 와 동일 의미).
        for column, desc in reversed(self._orders):
            rows.sort(key=lambda row: row.get(column), reverse=desc)
        call = {"table": self._table, "orders": list(self._orders)}
        if self._range is not None:
            start, end = self._range
            call.update(op="range", start=start, end=end)
            rows = rows[start:end + 1]
        else:
            call.update(op="limit", limit=self._limit)
            if self._limit is not None:
                rows = rows[:self._limit]
        self._calls.append(call)
        # ⚠️ 이 페이크의 핵심: 무엇을 요청했든 단일 응답은 캡에서 잘린다.
        return _FakeResponse(rows[:_POSTGREST_ROW_CAP])


class _CappedFakeSupabase:
    def __init__(self, tables: dict[str, list[dict]], calls: list) -> None:
        self._tables = tables
        self._calls = calls

    def table(self, name: str) -> _FakeQuery:
        return _FakeQuery(name, self._tables.get(name, []), self._calls)


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _ranges(calls: list, table: str) -> list[tuple[int, int]]:
    return [(c["start"], c["end"]) for c in calls if c["table"] == table and c["op"] == "range"]


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


# =========================================================================
# 1. /metrics/trend — 30일 추이가 최신 1000행으로 쪼그라들지 않는다
# =========================================================================

def test_metrics_trend_pages_past_the_postgrest_row_cap(client):
    """30일 × 50건 = 1,500행. 단발 조회면 캡에서 잘리고, 정렬이 최신순이라
    **잘린 쪽이 과거 열흘**이다 — 실제로는 매일 50건씩 쌓였는데 화면은 그 열흘을
    '관측 0건'(회색 구간)으로 그린다. 30일 추이의 존재 이유가 바로 그 판정이다.
    """
    now = datetime.now(timezone.utc)
    logs = [
        {
            "id": f"log-{day:02d}-{i:03d}",
            "congestion_level": 0.5,
            "timestamp": _iso(now - timedelta(days=day, seconds=i)),
        }
        for day in range(30)
        for i in range(50)
    ]
    recs = [
        {
            "id": f"rec-{day:02d}",
            "source": "spot",
            "accepted": True,
            "created_at": _iso(now - timedelta(days=day)),
        }
        for day in range(30)
    ]
    calls: list = []
    with patch(
        "app.routers.admin.supabase_admin",
        new=_CappedFakeSupabase({"congestion_logs": logs, "recommendations": recs}, calls),
    ):
        res = client.get("/api/v1/admin/metrics/trend?days=30", headers=admin_headers())

    assert res.status_code == 200
    body = res.json()
    assert len(body["daily"]) == 30
    # 1,500행 전부를 봤는가. 캡에서 잘렸다면 과거 열흘이 samples=0 으로 비어 있다.
    assert [day["samples"] for day in body["daily"]] == [50] * 30, "캡에서 잘렸다 — 두 번째 페이지를 받지 않았다"
    assert all(day["avg_congestion"] == 0.5 for day in body["daily"])
    assert all(day["rec_total"] == 1 for day in body["daily"])
    # 상한(20,000)에 닿지 않았으므로 truncated 는 거짓이어야 한다.
    assert body["truncated"] is False
    # 두 번째 페이지가 **실제로** 요청됐는가. 단발 .limit() 이면 여기서 갈린다.
    assert _ranges(calls, "congestion_logs") == [(0, 999), (1000, 1999)]
    # 최신순 보존 + 결정적 페이지 경계(동일 timestamp 대량 삽입은 simulate-peak 이 실제로 만든다).
    log_call = next(c for c in calls if c["table"] == "congestion_logs")
    assert log_call["orders"] == [("timestamp", True), ("id", True)]


def test_metrics_trend_truncated_is_true_only_when_the_cap_is_really_hit(client, monkeypatch):
    """상한에 실제로 닿았을 때만 truncated 가 켜지고, 상한을 넘겨 받지도 않는다.

    예전 구현은 `.limit(_TREND_LOG_CAP)` 한 번을 쏘고 `len(logs) >= _TREND_LOG_CAP` 로
    판정했다 — 서버가 1000행에서 자르므로 **절단이 일어난 모든 경우에 False** 였다.
    """
    monkeypatch.setattr(admin, "_TREND_LOG_CAP", 2000)
    now = datetime.now(timezone.utc)
    logs = [
        {
            "id": f"log-{i:05d}",
            "congestion_level": 0.4,
            "timestamp": _iso(now - timedelta(minutes=i)),
        }
        for i in range(2500)
    ]
    calls: list = []
    with patch(
        "app.routers.admin.supabase_admin",
        new=_CappedFakeSupabase({"congestion_logs": logs, "recommendations": []}, calls),
    ):
        res = client.get("/api/v1/admin/metrics/trend?days=30", headers=admin_headers())

    assert res.status_code == 200
    assert res.json()["truncated"] is True, "상한을 넘겼는데도 절단을 알리지 않았다"
    # 상한에서 멈춘다 — 세 번째 페이지를 요청하면 상한이 상한이 아니다.
    assert _ranges(calls, "congestion_logs") == [(0, 999), (1000, 1999)]


# =========================================================================
# 2. /model-trust — 존재하는 시설·관측을 '수집 공백' 으로 지목하지 않는다
# =========================================================================

_MODEL_INFO = {
    "trained": True, "version": "v-test", "real_data_count": 500,
    "mae": 0.05, "refresh_error": None,
}


def _trust_fixture(*, facility_count: int, covered: int, log_days: int = 3):
    """facility_count 곳 중 앞 covered 곳만 검증 관측이 있는 상태를 만든다."""
    now = datetime.now(timezone.utc)
    facilities = [
        {"id": f"fac-{i:04d}", "name": f"시설-{i:04d}", "type": "cafe", "is_active": True}
        for i in range(facility_count)
    ]
    logs = [
        {
            "id": f"log-{i:05d}",
            "facility_id": f"fac-{i:04d}",
            "source": "traffic_cctv",
            "evidence_tier": "verified",
            "timestamp": _iso(now - timedelta(days=i % log_days, seconds=i)),
        }
        for i in range(covered)
    ]
    return facilities, logs


def test_model_trust_counts_every_facility_and_observation_past_the_row_cap(client):
    """시설 1,600곳 · 검증 관측 1,200건. 캡에서 잘리면 활성 시설이 1,000곳으로 줄고
    커버리지가 100% 로 부풀며, **관측이 있는 시설이 '수집 공백' 후보 밖으로 사라진다.**
    관리자가 '데이터가 없다' 고 판단하는 근거 화면이라 이 절단이 특히 나쁘다.
    """
    facilities, logs = _trust_fixture(facility_count=1600, covered=1200)
    calls: list = []
    tables = {
        "facilities": facilities,
        "congestion_logs": logs,
        "recommendations": [],
        "recommendation_outcomes": [],
        "model_registry": [],
    }
    with patch("app.routers.admin.supabase_admin", new=_CappedFakeSupabase(tables, calls)), \
            patch("app.services.predict_service.get_model_info", return_value=dict(_MODEL_INFO)):
        res = client.get("/api/v1/admin/model-trust?days=30", headers=admin_headers())

    assert res.status_code == 200
    collection = res.json()["collection"]
    assert collection["active_facilities"] == 1600, "시설 목록이 캡에서 잘렸다"
    assert collection["observations"] == 1200, "관측 로그가 캡에서 잘렸다"
    assert collection["trusted_observations"] == 1200
    assert collection["trusted_facility_coverage_rate"] == 0.75  # 1200/1600
    # 공백은 관측이 없는 fac-1200 이후여야 한다. 잘린 목록으로 계산하면 여기서 어긋난다.
    gap_ids = [row["id"] for row in collection["facility_gaps"]]
    assert gap_ids == [f"fac-{i:04d}" for i in range(1200, 1220)]
    assert res.json()["truncated"] is False
    assert "metrics_truncated" not in res.json()["guardrails"]["warnings"]
    # 시설은 전량 조회(fetch_all_rows) — 두 페이지가 실제로 요청됐다.
    assert _ranges(calls, "facilities") == [(0, 999), (1000, 1999)]


def test_model_trust_warns_when_the_observation_window_is_truncated(client, monkeypatch):
    """로그 상한에 닿으면 수치가 창 전체의 값이 아니므로 그 사실을 화면에 알린다."""
    monkeypatch.setattr(admin, "_TRUST_LOG_CAP", 2000)
    facilities, logs = _trust_fixture(facility_count=2500, covered=2500)
    calls: list = []
    tables = {
        "facilities": facilities,
        "congestion_logs": logs,
        "recommendations": [],
        "recommendation_outcomes": [],
        "model_registry": [],
    }
    with patch("app.routers.admin.supabase_admin", new=_CappedFakeSupabase(tables, calls)), \
            patch("app.services.predict_service.get_model_info", return_value=dict(_MODEL_INFO)):
        res = client.get("/api/v1/admin/model-trust?days=30", headers=admin_headers())

    assert res.status_code == 200
    body = res.json()
    assert body["truncated"] is True
    assert "metrics_truncated" in body["guardrails"]["warnings"]
    assert body["collection"]["observations"] == 2000  # 상한에서 멈춘다
    assert _ranges(calls, "congestion_logs") == [(0, 999), (1000, 1999)]


# =========================================================================
# 3. /metrics — 대시보드가 계산하는 수락률·DAU 의 표본
# =========================================================================

def test_metrics_returns_the_whole_window_past_the_row_cap(client):
    now = datetime.now(timezone.utc)
    recs = [
        {"id": f"rec-{i:05d}", "source": "spot", "accepted": i % 2 == 0,
         "created_at": _iso(now - timedelta(minutes=i))}
        for i in range(1200)
    ]
    feedback = [
        {"id": f"fb-{i:03d}", "user_id": f"u-{i}", "timestamp": _iso(now - timedelta(minutes=i))}
        for i in range(10)
    ]
    calls: list = []
    with patch(
        "app.routers.admin.supabase_admin",
        new=_CappedFakeSupabase({"recommendations": recs, "user_feedback": feedback}, calls),
    ):
        res = client.get("/api/v1/admin/metrics?days=28", headers=admin_headers())

    assert res.status_code == 200
    body = res.json()
    assert len(body["recommendations"]) == 1200, "수락률 분모가 캡에서 잘렸다"
    assert len(body["feedback"]) == 10
    assert body["truncated"] is False
    assert _ranges(calls, "recommendations") == [(0, 999), (1000, 1999)]


# =========================================================================
# 4. /impact — 절감 대기시간은 합계라 잘린 만큼 그대로 과소 보고된다
# =========================================================================

def test_impact_sums_every_accepted_recommendation_past_the_row_cap(client):
    now = datetime.now(timezone.utc)
    recs = [
        {
            "id": f"rec-{i:05d}",
            "accepted": True,
            "created_at": _iso(now - timedelta(minutes=i)),
            "score_breakdown": {"original_wait_time": 20.0, "wait_time": 19.0},  # 1분 절감
        }
        for i in range(1200)
    ]
    # 잘못 포함되면 즉시 드러나도록 미수락 행을 섞어 둔다(필터가 살아 있는지 함께 잠근다).
    recs.append({
        "id": "rec-rejected", "accepted": False, "created_at": _iso(now),
        "score_breakdown": {"original_wait_time": 999.0, "wait_time": 0.0},
    })
    calls: list = []
    with patch(
        "app.routers.admin.supabase_admin",
        new=_CappedFakeSupabase({"recommendations": recs}, calls),
    ):
        # 쿼리스트링의 '+' 는 공백으로 디코딩되므로 UTC 오프셋은 'Z' 표기로 넘긴다.
        since = _iso(now - timedelta(days=2)).replace("+00:00", "Z")
        res = client.get(f"/api/v1/admin/impact?since={since}", headers=admin_headers())

    assert res.status_code == 200
    body = res.json()
    assert body["relocations"] == 1200, "수락 추천이 캡에서 잘렸다"
    assert body["measured"] == 1200
    assert body["saved_wait_minutes"] == 1200.0
    assert body["truncated"] is False


# =========================================================================
# 5. /dashboard/today — 평균·이상 건수·히트맵이 하루의 앞 1000행만 보지 않는다
# =========================================================================

def test_dashboard_today_aggregates_every_log_past_the_row_cap(client):
    """오늘 로그 1,100건 중 **뒤쪽 100건**이 이상(>=0.9)이다.

    오름차순 단발 조회면 앞 1,000건만 남아 이상 건수가 0 으로 보고된다 — 이상 알림 위젯이
    통째로 침묵한다. (12,000 상한은 클라이언트가 1000행×12페이지로 돌던 것을 옮긴 값인데,
    이관하면서 왕복 12번이 `.limit(12000)` 한 번이 되어 1/12 만 보고 있었다.)
    """
    start, _end = admin._kst_today_range_utc()
    start_dt = datetime.fromisoformat(start)
    logs = [
        {
            "id": f"log-{i:05d}",
            "congestion_level": 0.2 if i < 1000 else 0.9,
            "current_count": 10,
            "timestamp": _iso(start_dt + timedelta(seconds=i)),
            "facility": {"name": "황리단길", "type": "attraction"},
        }
        for i in range(1100)
    ]
    calls: list = []
    with patch(
        "app.routers.admin.supabase_admin",
        new=_CappedFakeSupabase({"congestion_logs": logs}, calls),
    ):
        res = client.get("/api/v1/admin/dashboard/today", headers=admin_headers())

    assert res.status_code == 200
    body = res.json()
    assert body["hasLogs"] is True
    assert body["anomalyCount"] == 100, "이상 건수가 캡에 잘려 침묵했다"
    # (1000×0.2 + 100×0.9)/1100 = 0.2636… → 0.26 (잘리면 0.2)
    assert body["avgCongestion"]["value"] == 0.26
    # 오늘/어제 두 조회가 같은 테이블을 동시에 친다(gather+to_thread) — 기록 순서는 뒤섞일 수
    # 있으므로 '두 번째 페이지를 요청했는가' 만 본다. 단발 .limit() 이면 range 자체가 없다.
    assert (1000, 1999) in _ranges(calls, "congestion_logs")
    # 응답 shape 은 클라이언트 폴백 계약과 1:1 — 절단 사실은 구조화 로그로만 남긴다.
    # (sampleCount/latestObservedAt/fallback 은 뒤에 **추가만** 된 키다 — test_dashboard_fallback.py 참조.)
    assert set(body) == {
        "hasLogs", "avgCongestion", "anomalyCount", "heatmap", "anomalies",
        "sampleCount", "latestObservedAt", "fallback",
    }
