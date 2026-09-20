# /admin/dashboard/today 의 `estimated` 키 — 경주 **추정 모드** 계약.
#
# 배경: congestion_logs 가 사실상 비어 있어(7월 시드 한 덩어리) '실시간 관제' 가 매일 빈 카드이거나
# 두 달 전 시드를 그렸다. 서버는 주차 실측 + 관광 통계로 읽을 때 계산한 오늘의 추정 집계를
# 별도 키(estimated)로 함께 싣는다.
#
# 여기서 잠그는 것:
#   1) 추정은 **추가 키**다 — 최상위(오늘 실측) 키의 값·뜻은 추정이 있든 없든 그대로다.
#      (옛 번들은 최상위만 읽는다. 거기에 추정이 섞이면 라벨 없는 추정치가 실측처럼 그려진다.)
#   2) 추정의 어떤 실패도(예외·시간 초과·모양 불량) 응답을 죽이지 않는다 → estimated=null.
#   3) 실측 조회가 실패하면 여전히 500 이다 — 추정이 실패를 가리지 않는다.
import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import admin
from app.services import congestion_estimator_service
from tests.conftest import admin_headers
from tests.routers.test_dashboard_fallback import _DayFilteredSupabase, _fallback_day_logs, _log

TODAY_PATH = "/api/v1/admin/dashboard/today"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _clear_inflight():
    admin._estimate_inflight.clear()
    yield
    admin._estimate_inflight.clear()


def _kst_today() -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=9)).date().isoformat()


def _estimate(date_kst: str) -> dict:
    """추정기(aggregate_estimated_day)가 내는 모양 그대로의 최소 예시."""
    return {
        "dateKst": date_kst,
        "hasLogs": True,
        "avgCongestion": {"value": 0.66, "changePercent": 3.1, "changePercentOrNull": 3.1, "prevSampleCount": 1440},
        "anomalyCount": 151,
        "heatmap": [{"facility": "월정교", "facilityType": "attraction", "hour": 14, "value": 0.93}],
        "anomalies": [{
            "id": "월정교-x", "facilityName": "월정교", "timestamp": "2026-09-19T05:00:00+00:00",
            "congestionLevel": 0.95, "durationMinutes": 10,
        }],
        "sampleCount": 1440,
        "sourceComposition": {"estimated": 1440},
        "basis": {
            "method": "parking_its+tourism_concentration",
            "weights": {"parking": 0.7, "tourism": 0.3},
            "radiusM": 2000,
            "snapshotCount": 144,
            "lotCountMax": 4,
            "placeCount": 10,
            "estimatedFacilityCount": 846,
            "facilityCount": 1669,
            "latestObservedAt": "2026-09-19T14:50:00+00:00",
        },
    }


def _stub_estimator(monkeypatch, *, result=None, exc: Exception | None = None, delay: float = 0.0):
    calls: list[str] = []

    async def _fake(date_kst, **_kwargs):
        calls.append(date_kst)
        if delay:
            await asyncio.sleep(delay)
        if exc is not None:
            raise exc
        return result if result is not None else _estimate(date_kst)

    monkeypatch.setattr(congestion_estimator_service, "estimated_day_aggregate", _fake)
    return calls


def test_empty_today_carries_todays_estimate_beside_the_fallback(client, monkeypatch):
    """오늘 실측이 비면 추정과 폴백(과거 실측)이 **둘 다** 실린다 — 무엇을 먼저 그릴지는 화면이 정한다."""
    calls = _stub_estimator(monkeypatch)
    with patch.object(admin, "supabase_admin", _DayFilteredSupabase(_fallback_day_logs())):
        res = client.get(TODAY_PATH, headers=admin_headers())

    assert res.status_code == 200, res.text
    body = res.json()
    assert calls == [_kst_today()], "오늘(KST) 날짜로 추정을 요청해야 한다"
    assert body["estimated"] == _estimate(_kst_today())
    assert body["estimated"]["basis"]["radiusM"] == 2000
    # 최상위는 끝까지 '오늘 실측' 이다 — 추정 값이 새어 들어가면 옛 번들이 라벨 없이 그린다.
    assert body["hasLogs"] is False
    assert body["avgCongestion"] is None
    assert body["anomalyCount"] is None
    assert body["heatmap"] is None
    assert body["sampleCount"] == 0
    # 폴백은 그대로 계산된다(옛 번들 · 추정 실패 시 화면의 세 번째 선택지).
    assert body["fallback"]["hasLogs"] is True
    assert body["fallback"]["dateKst"] == "2026-08-21"


def test_estimator_failure_degrades_to_null_without_breaking_the_response(client, monkeypatch):
    _stub_estimator(monkeypatch, exc=RuntimeError("snapshot table unavailable"))
    with patch.object(admin, "supabase_admin", _DayFilteredSupabase(_fallback_day_logs())):
        res = client.get(TODAY_PATH, headers=admin_headers())

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["estimated"] is None
    assert body["fallback"]["hasLogs"] is True, "추정 실패가 폴백까지 끌고 가면 안 된다"
    assert body["latestObservedAt"] is not None


def test_estimator_timeout_degrades_to_null(client, monkeypatch):
    """추정이 상한을 넘으면 기다리지 않는다 — 화면 타임아웃에 실측 KPI 까지 끌려가지 않게."""
    monkeypatch.setattr(admin, "_ESTIMATE_TIMEOUT_SECONDS", 0.05)
    _stub_estimator(monkeypatch, delay=1.0)
    with patch.object(admin, "supabase_admin", _DayFilteredSupabase([])):
        res = client.get(TODAY_PATH, headers=admin_headers())

    assert res.status_code == 200, res.text
    assert res.json()["estimated"] is None


def test_estimator_bad_shape_degrades_to_null(client, monkeypatch):
    async def _weird(_date_kst, **_kwargs):
        return ["not", "a", "dict"]

    monkeypatch.setattr(congestion_estimator_service, "estimated_day_aggregate", _weird)
    with patch.object(admin, "supabase_admin", _DayFilteredSupabase([])):
        res = client.get(TODAY_PATH, headers=admin_headers())

    assert res.status_code == 200
    assert res.json()["estimated"] is None


def _measured_today_rows() -> list[dict]:
    now = datetime.now(timezone.utc)
    rows = [_log(0.5, (now - timedelta(hours=1)).isoformat()) for _ in range(5)]
    rows.append(_log(1.0, (now - timedelta(minutes=1)).isoformat()))
    return rows


def test_measured_today_is_unaffected_by_the_estimate(client, monkeypatch):
    """오늘 실측이 있으면 최상위 값은 추정 유무와 **바이트 단위로 같다**."""
    rows = _measured_today_rows()

    _stub_estimator(monkeypatch, exc=RuntimeError("off"))
    with patch.object(admin, "supabase_admin", _DayFilteredSupabase(rows)):
        without = client.get(TODAY_PATH, headers=admin_headers()).json()

    admin._estimate_inflight.clear()
    _stub_estimator(monkeypatch)
    with patch.object(admin, "supabase_admin", _DayFilteredSupabase(rows)):
        with_estimate = client.get(TODAY_PATH, headers=admin_headers()).json()

    assert without["estimated"] is None
    assert with_estimate["estimated"]["hasLogs"] is True
    strip = lambda body: {k: v for k, v in body.items() if k != "estimated"}  # noqa: E731
    assert strip(with_estimate) == strip(without)
    assert with_estimate["hasLogs"] is True
    assert with_estimate["fallback"] is None
    # 실측 평균 (0.5×5 + 1.0)/6 = 0.58 — 추정(0.66)이 섞이지 않았다.
    assert with_estimate["avgCongestion"]["value"] == 0.58
    assert with_estimate["anomalyCount"] == 1
    assert with_estimate["sourceComposition"] == {"unknown": 6}


def test_measured_query_failure_is_still_a_500(client, monkeypatch):
    """추정이 살아 있어도 실측 조회 실패는 실패다 — 추정으로 가리면 '조회 실패' 가 사라진다."""
    _stub_estimator(monkeypatch)

    class _Broken:
        def table(self, _name):
            raise RuntimeError("db down")

    with patch.object(admin, "supabase_admin", _Broken()):
        res = client.get(TODAY_PATH, headers=admin_headers())

    assert res.status_code == 500


def test_concurrent_callers_share_one_estimate_computation():
    """dashboard/today 와 briefing 이 동시에 불러도 콜드 계산은 한 번이다."""
    calls: list[str] = []

    async def _slow(date_kst, **_kwargs):
        calls.append(date_kst)
        await asyncio.sleep(0.05)
        return _estimate(date_kst)

    async def _run():
        with patch.object(congestion_estimator_service, "estimated_day_aggregate", _slow):
            return await asyncio.gather(
                admin._estimated_day_or_none("2026-09-20"),
                admin._estimated_day_or_none("2026-09-20"),
            )

    first, second = asyncio.run(_run())
    assert calls == ["2026-09-20"]
    assert first == second == _estimate("2026-09-20")
    assert admin._estimate_inflight == {}, "끝난 계산은 합류 목록에서 빠져야 한다"
