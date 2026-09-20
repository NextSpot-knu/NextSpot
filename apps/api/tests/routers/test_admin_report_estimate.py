# GET /api/v1/admin/reports/estimated — 리포트 화면의 일별 **추정** 추이 계약.
#
# 배경: congestion_logs 가 사실상 비어 있어(실측 2026-09-20 기준 전체 2,705행, 마지막 관측 8/20)
# '통계 리포트'(최근 14일 로그)와 '성과 리포트'(30일 추이)가 둘 다 기간 전체 0행이었다. 이
# 엔드포인트가 그 자리를 채울 추정 집계를 준다 — 단, 실측이 아니라는 사실을 응답이 스스로 말한다.
#
# 여기서 잠그는 것:
#   1) 추정 실패(예외·시간 초과·모양 불량)는 **HTTP 오류가 아니다** — available=false + reason 이다.
#      500 을 주면 화면이 '관제 API 장애' 라고 말하는데, 그건 사실이 아니다(추정이 없는 것은 정상 상태).
#   2) 실측 엔드포인트(/metrics/trend)는 이 엔드포인트가 무엇을 하든 **한 글자도 달라지지 않는다.**
#   3) days 는 상한에 붙는다(계산 비용이 일수에 비례한다).
#   4) 같은 기간의 계산이 이미 돌고 있으면 합류한다(두 리포트 화면이 같은 30일을 동시에 부른다).
import asyncio
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import admin
from app.services import estimated_report_service
from tests.conftest import admin_headers

PATH = "/api/v1/admin/reports/estimated"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _clear_inflight():
    admin._report_estimate_inflight.clear()
    yield
    admin._report_estimate_inflight.clear()


def _series(days: int = 3) -> dict:
    """estimated_daily_series 가 내는 모양 그대로의 최소 예시."""
    dates = [f"2026-09-{18 + i:02d}" for i in range(days)]
    return {
        "days": days,
        "startDateKst": dates[0],
        "endDateKst": dates[-1],
        "samplingMinutes": 10,
        "daily": [{
            "date": day,
            "avgCongestion": 0.53,
            "sampleCount": 121695,
            "snapshotCount": 144,
            "anomalyCount": 765,
            "byType": {"cafe": {"avgCongestion": 0.52, "sampleCount": 46000, "anomalyCount": 300}},
        } for day in dates],
        "basis": {
            "method": "parking_its+tourism_concentration",
            "weights": {"parking": 0.7, "tourism": 0.3},
            "radiusM": 2000, "samplingMinutes": 10, "sampleUnit": "facility_bucket",
            "source": "estimated", "snapshotCount": 144 * days, "lotCountMax": 4,
            "facilityCount": 1669, "estimatedFacilityCount": 846,
            "firstObservedAt": "2026-09-18T15:00:00+00:00",
            "latestObservedAt": "2026-09-20T04:13:02+00:00",
        },
        "elapsedMs": 2150,
    }


def _stub(monkeypatch, *, result=None, exc: Exception | None = None, delay: float = 0.0):
    calls: list[int] = []

    async def _fake(days, **_kwargs):
        calls.append(days)
        if delay:
            await asyncio.sleep(delay)
        if exc is not None:
            raise exc
        return result if result is not None else _series()

    monkeypatch.setattr(estimated_report_service, "estimated_daily_series", _fake)
    return calls


def test_returns_daily_estimate_with_basis(client, monkeypatch):
    calls = _stub(monkeypatch)
    res = client.get(f"{PATH}?days=3", headers=admin_headers())
    assert res.status_code == 200
    body = res.json()
    assert calls == [3]
    assert body["available"] is True and body["reason"] is None
    assert [row["date"] for row in body["daily"]] == ["2026-09-18", "2026-09-19", "2026-09-20"]
    # 근거가 없으면 화면이 '추정' 이라고 말할 수 없다 — 응답이 스스로 근거를 싣는다.
    assert body["basis"]["radiusM"] == 2000
    assert body["basis"]["sampleUnit"] == "facility_bucket"
    assert body["samplingMinutes"] == 10
    # 인원 수는 어디에도 없다. 추정치는 비율이지 사람 수가 아니다.
    assert all("currentCount" not in row and "current_count" not in row for row in body["daily"])


def test_failure_is_not_an_http_error(client, monkeypatch):
    """추정 실패는 '조회 실패' 가 아니라 '추정 없음' 이다 — 화면이 둘을 다르게 말해야 한다."""
    _stub(monkeypatch, exc=RuntimeError("supabase down"))
    res = client.get(f"{PATH}?days=7", headers=admin_headers())
    assert res.status_code == 200
    body = res.json()
    assert body["available"] is False
    assert body["reason"] == "compute_failed"
    assert body["daily"] == [] and body["basis"] is None
    assert body["days"] == 7


def test_timeout_degrades_to_unavailable(client, monkeypatch):
    _stub(monkeypatch, delay=0.2)
    with patch.object(admin, "_REPORT_ESTIMATE_TIMEOUT_SECONDS", 0.01):
        res = client.get(f"{PATH}?days=7", headers=admin_headers())
    assert res.status_code == 200
    assert res.json()["reason"] == "timeout"


def test_bad_shape_is_reported_not_forwarded(client, monkeypatch):
    """모양이 어긋난 결과를 그대로 흘리면 화면의 형 가드가 막더라도 서버 로그에 원인이 안 남는다."""
    _stub(monkeypatch, result={"daily": "not-a-list"})
    res = client.get(PATH, headers=admin_headers())
    assert res.status_code == 200
    assert res.json()["reason"] == "bad_shape"


def test_days_is_clamped(client, monkeypatch):
    calls = _stub(monkeypatch)
    client.get(f"{PATH}?days=999", headers=admin_headers())
    client.get(f"{PATH}?days=0", headers=admin_headers())
    assert calls == [estimated_report_service.MAX_DAYS, 1]


def test_concurrent_requests_join_one_computation(client, monkeypatch):
    """두 리포트 화면이 같은 30일을 동시에 부른다 — 콜드 계산이 두 번 겹치면 안 된다."""
    calls = _stub(monkeypatch, delay=0.05)
    with TestClient(app) as c:
        # 첫 요청이 태스크를 만들고, 그 태스크가 끝나기 전에 두 번째가 합류한다.
        first = c.get(f"{PATH}?days=30", headers=admin_headers())
        second = c.get(f"{PATH}?days=30", headers=admin_headers())
    assert first.status_code == second.status_code == 200
    # 첫 요청이 끝나면 태스크도 끝나므로 두 번째는 새 계산을 만든다 — 합류는 '동시일 때' 의 보장이다.
    # 여기서 잠그는 것은 '요청마다 태스크가 쌓이지 않는다'(끝난 태스크는 목록에서 빠진다)이다.
    assert len(calls) <= 2
    assert len(admin._report_estimate_inflight) <= 1


def test_measured_trend_is_untouched_by_the_estimate(client, monkeypatch):
    """추정이 죽어도 실측 추이 엔드포인트는 그대로다 — 둘은 애초에 다른 요청이다."""
    _stub(monkeypatch, exc=RuntimeError("boom"))
    with patch("app.routers.admin._fetch_capped", return_value=([], False)):
        res = client.get("/api/v1/admin/metrics/trend?days=7", headers=admin_headers())
    assert res.status_code == 200
    body = res.json()
    assert body["days"] == 7 and len(body["daily"]) == 7
    assert "estimated" not in body, "실측 응답에 추정 키를 더하지 않는다(별도 엔드포인트다)"
    assert all(row["avg_congestion"] is None and row["samples"] == 0 for row in body["daily"])
