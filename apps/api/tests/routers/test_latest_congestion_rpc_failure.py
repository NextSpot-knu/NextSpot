"""최신 혼잡 RPC 가 실패했을 때 시설별 조회를 흩뿌리지 않는다(P0a — 장애 증폭 차단).

예전 fetch_latest_congestion_for_all 은 RPC 가 한 번 흔들리면 **넘겨받은 시설 수만큼**
to_thread 조회를 gather 했다. 지도·예측 배치·안전 관제는 전 시설(1,682곳)을 넘기므로 일시 오류 한 번이
1,682개의 스레드 호출이 되어 기본 executor(16)를 가득 채웠다(감사 시뮬레이션 ~14초 정지).
"""
import asyncio
import threading
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from tests.conftest import admin_headers

from app.routers import infrastructures, safety


class _CountingClient:
    """rpc 는 항상 실패하고, rpc·table() 호출 수를 센다(table = 시설별 폴백 조회 수)."""

    def __init__(self):
        self.table_calls = 0
        self.rpc_calls = 0
        self._lock = threading.Lock()

    def rpc(self, *_a, **_k):
        with self._lock:
            self.rpc_calls += 1
        raise RuntimeError("ConnectionTerminated error_code:1")

    def table(self, _name):
        self.table_calls += 1

        class _Q:
            def __getattr__(self, _n):
                return lambda *a, **k: self

            def execute(self):
                class _R:
                    data = [{
                        "congestion_level": 0.4, "current_count": None,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "source": "user_report", "evidence_tier": "single_report",
                    }]
                return _R()

        return _Q()


def _ids(n: int) -> list[str]:
    return [f"00000000-0000-4000-8000-{i:012d}" for i in range(n)]


def test_rpc_failure_with_many_ids_returns_empty_without_fanout(monkeypatch):
    fake = _CountingClient()
    monkeypatch.setattr(infrastructures, "supabase_client", fake)

    result = asyncio.run(infrastructures.fetch_latest_congestion_for_all(_ids(1682)))

    assert result == {}
    assert fake.table_calls == 0, "RPC 실패가 시설별 조회로 흩뿌려졌다"
    # 1000개씩 두 조각(동시) + 차례 재시도 한 번(첫 조각에서 멈춤) — 1,682배가 아니라 3회.
    assert fake.rpc_calls == 3


def test_rpc_failure_can_raise_for_callers_that_must_not_read_empty_as_quiet(monkeypatch):
    fake = _CountingClient()
    monkeypatch.setattr(infrastructures, "supabase_client", fake)

    with pytest.raises(RuntimeError):
        asyncio.run(infrastructures.fetch_latest_congestion_for_all(_ids(50), raise_on_error=True))
    assert fake.table_calls == 0


def test_rpc_failure_with_a_single_id_still_asks_once(monkeypatch):
    """단건 호출부(골든아워·사장님 브리핑)는 종전처럼 limit(1) 한 번으로 대신한다 — 증폭이 없다."""
    fake = _CountingClient()
    monkeypatch.setattr(infrastructures, "supabase_client", fake)

    result = asyncio.run(infrastructures.fetch_latest_congestion_for_all(["f-1"]))

    assert fake.table_calls == 1
    assert result["f-1"]["level"] == 0.4


def test_fallback_bound_is_small():
    # 이 상한이 커지면 다시 증폭이 된다 — 단건·소수 호출부만 덮을 크기로 묶어 둔다.
    assert infrastructures._PER_FACILITY_FALLBACK_MAX_IDS <= 5


def test_safety_status_reports_error_instead_of_false_all_clear():
    """RPC 가 실패했는데 빈 맵으로 '실측 표본 없음'(sampleEmpty) 을 돌려주면 관제 화면에는 '경보 없음'
    으로 읽힌다. 모르면 모른다고(500) 알려야 한다."""
    app = FastAPI()
    app.include_router(safety.router)
    client = TestClient(app)
    facilities = [
        {"id": fid, "name": "n", "type": "cafe", "latitude": 35.83, "longitude": 129.21}
        for fid in _ids(20)
    ]
    fake = _CountingClient()
    with patch.object(safety, "_fetch_facilities", new=AsyncMock(return_value=facilities)), \
         patch.object(infrastructures, "supabase_client", fake):
        res = client.get("/api/v1/admin/safety/status", headers=admin_headers())

    assert res.status_code == 500
    assert fake.table_calls == 0


class _FlakyRpcClient:
    """최신 혼잡 RPC — 앞의 ``fail_first`` 번은 실패하고 그 뒤로는 답한다. PostgREST 처럼 결과를 1000행에서 자른다."""

    def __init__(self, logged_ids, fail_first=0):
        self.logged_ids = list(logged_ids)
        self.fail_first = fail_first
        self.rpc_calls = 0
        self.table_calls = 0
        self._lock = threading.Lock()

    def rpc(self, name, params):
        assert name == "latest_congestion_for_facilities"
        client = self

        class _Call:
            def execute(self):
                with client._lock:
                    client.rpc_calls += 1
                    failing = client.rpc_calls <= client.fail_first
                if failing:
                    raise RuntimeError("ConnectionTerminated error_code:1")
                wanted = set(params["facility_ids"])
                rows = [{
                    "facility_id": fid, "congestion_level": 0.5, "current_count": None,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "source": "user_report", "evidence_tier": "single_report",
                } for fid in client.logged_ids if fid in wanted]

                class _R:
                    data = rows[:1000]
                return _R()

        return _Call()

    def table(self, _name):
        self.table_calls += 1
        raise AssertionError("per-facility fallback must not run for many ids")


def test_a_transient_rpc_failure_is_retried_once_and_keeps_the_data(monkeypatch):
    """09-26 ConnectionTerminated 같은 일시 오류 — 도입 전엔 시설별 폴백이 데이터를 살렸다(1,682배 증폭으로).
    같은 RPC 를 조각별로 차례로 한 번 더 부르면 증폭 없이 데이터를 지킨다(안전 관제·추천·예측 배치)."""
    ids = _ids(1682)
    fake = _FlakyRpcClient(ids[:40], fail_first=1)
    monkeypatch.setattr(infrastructures, "supabase_client", fake)

    result = asyncio.run(infrastructures.fetch_latest_congestion_for_all(ids))

    assert len(result) == 40
    assert fake.table_calls == 0
    assert fake.rpc_calls <= 4                     # 첫 시도 2조각 + 재시도 2조각


def test_results_past_the_1000_row_rpc_cap_are_not_dropped(monkeypatch):
    """한 번에 1,682개를 넘기면 PostgREST 가 RPC 결과를 1000행에서 잘라 나머지 시설의 혼잡이 조용히 null 이었다.
    참조 스냅샷과 같은 1000개 조각이면 두 경로가 어느 규모에서나 같은 값을 낸다."""
    ids = _ids(1682)
    fake = _FlakyRpcClient(ids[:1500])
    monkeypatch.setattr(infrastructures, "supabase_client", fake)

    result = asyncio.run(infrastructures.fetch_latest_congestion_for_all(ids))

    assert len(result) == 1500
    assert fake.rpc_calls == 2


def test_safety_status_survives_a_transient_rpc_failure():
    app = FastAPI()
    app.include_router(safety.router)
    client = TestClient(app)
    facilities = [
        {"id": fid, "name": "n", "type": "cafe", "latitude": 35.83, "longitude": 129.21}
        for fid in _ids(20)
    ]
    fake = _FlakyRpcClient([f["id"] for f in facilities], fail_first=1)
    with patch.object(safety, "_fetch_facilities", new=AsyncMock(return_value=facilities)),          patch.object(infrastructures, "supabase_client", fake):
        res = client.get("/api/v1/admin/safety/status", headers=admin_headers())

    assert res.status_code == 200
    assert res.json()["sampleEmpty"] is False
    assert fake.table_calls == 0
