"""GET /api/v1/admin/safety/status (인파 밀집 안전 경보) 테스트.

predict_batch 테스트(test_predict_batch.py)와 동일하게, app.main 전체를 띄우지 않고
safety 라우터만 FastAPI() 에 마운트해 격리 테스트한다(라우터 자체가 prefix 를 갖고 있어
main.py 와 동일하게 그대로 include_router 하면 된다).
"""
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.config import settings
from app.routers import safety

# 2026-07-14 는 화요일(dow=1). 03시 UTC 고정 — +1h 목표 시각은 04시(같은 요일).
FIXED_NOW = datetime(2026, 7, 14, 3, 0, 0, tzinfo=timezone.utc)


def _make_client() -> TestClient:
    app = FastAPI()
    app.include_router(safety.router)
    return TestClient(app)


def _admin_headers(token: str | None = None) -> dict:
    # require_admin 은 X-Admin-Authorization 헤더만 읽는다(admin.py 테스트 관례와 동일).
    return {"X-Admin-Authorization": f"Bearer {token or settings.ADMIN_API_TOKEN}"}


def _patched(facilities, congestion_map, predict_side_effect=None):
    """facilities/congestion 조회 + predict_congestion 을 패치하는 3개 patch 컨텍스트를 반환."""
    return (
        patch.object(safety, "_fetch_facilities", new=AsyncMock(return_value=facilities)),
        patch.object(safety, "fetch_latest_congestion_for_all", new=AsyncMock(return_value=congestion_map)),
        patch.object(safety, "predict_congestion", side_effect=predict_side_effect or (lambda t, h, d: 0.5)),
    )


# ============================================================================
# 1. 인증 가드(401)
# ============================================================================

def test_status_requires_admin_401():
    client = _make_client()
    res = client.get("/api/v1/admin/safety/status")
    assert res.status_code == 401


def test_status_rejects_invalid_admin_token_401():
    client = _make_client()
    res = client.get("/api/v1/admin/safety/status", headers=_admin_headers("wrong-token"))
    assert res.status_code == 401


# ============================================================================
# 2. 실측 로그 없음 → sampleEmpty
# ============================================================================

def test_status_sample_empty_when_no_congestion_logs():
    facilities = [{"id": "f1", "name": "동궁원", "type": "attraction", "latitude": 35.8, "longitude": 129.2}]
    p1, p2, p3 = _patched(facilities, {})
    with p1, p2, p3:
        client = _make_client()
        res = client.get("/api/v1/admin/safety/status", headers=_admin_headers())

    assert res.status_code == 200
    body = res.json()
    assert body["sampleEmpty"] is True
    assert body["facilityAlerts"] == []
    assert body["facilityWarnings"] == []
    assert body["zones"] == []
    assert body["meta"]["zoneMethod"] == "grid150m"


# ============================================================================
# 3. 임계값 분류 (facility 단위)
# ============================================================================

def test_status_classifies_facility_alert_warn_normal_with_default_thresholds():
    facilities = [
        {"id": "f-alert", "name": "황리단길", "type": "attraction", "latitude": 35.80, "longitude": 129.20},
        {"id": "f-warn", "name": "동궁원", "type": "cafe", "latitude": 35.81, "longitude": 129.21},
        {"id": "f-normal", "name": "첨성대", "type": "attraction", "latitude": 35.82, "longitude": 129.22},
    ]
    congestion_map = {
        "f-alert": {"level": 0.9, "current_count": 90, "timestamp": "2026-07-14T02:00:00+00:00"},
        "f-warn": {"level": 0.75, "current_count": 75, "timestamp": "2026-07-14T02:00:00+00:00"},
        "f-normal": {"level": 0.2, "current_count": 20, "timestamp": "2026-07-14T02:00:00+00:00"},
    }
    p1, p2, p3 = _patched(facilities, congestion_map)
    with p1, p2, p3:
        client = _make_client()
        res = client.get("/api/v1/admin/safety/status", headers=_admin_headers())

    assert res.status_code == 200
    body = res.json()
    assert body["sampleEmpty"] is False
    assert {a["facilityId"] for a in body["facilityAlerts"]} == {"f-alert"}
    assert {a["facilityId"] for a in body["facilityWarnings"]} == {"f-warn"}
    assert body["summary"]["alertFacilities"] == 1
    assert body["summary"]["warnFacilities"] == 1


def test_status_custom_thresholds_via_query_params():
    # 기본 임계값(0.85/0.7)이면 0.5는 normal 이지만, threshold=0.4/warn=0.3 을 주면 alert 이 된다.
    facilities = [{"id": "f1", "name": "황리단길", "type": "attraction", "latitude": 35.80, "longitude": 129.20}]
    congestion_map = {"f1": {"level": 0.5, "current_count": 50, "timestamp": "2026-07-14T02:00:00+00:00"}}
    p1, p2, p3 = _patched(facilities, congestion_map)
    with p1, p2, p3:
        client = _make_client()
        res = client.get(
            "/api/v1/admin/safety/status", params={"threshold": 0.4, "warn": 0.3}, headers=_admin_headers()
        )

    assert res.status_code == 200
    body = res.json()
    assert body["thresholds"] == {"alert": 0.4, "warn": 0.3}
    assert body["facilityAlerts"][0]["facilityId"] == "f1"


def test_status_swaps_inverted_thresholds_defensively():
    # 프런트 슬라이더 오조작으로 warn > threshold 가 들어와도 분류가 뒤집히지 않도록 스왑한다.
    facilities = [{"id": "f1", "name": "황리단길", "type": "attraction", "latitude": 35.80, "longitude": 129.20}]
    congestion_map = {"f1": {"level": 0.8, "current_count": 80, "timestamp": "t"}}
    p1, p2, p3 = _patched(facilities, congestion_map)
    with p1, p2, p3:
        client = _make_client()
        res = client.get(
            "/api/v1/admin/safety/status", params={"threshold": 0.3, "warn": 0.9}, headers=_admin_headers()
        )

    body = res.json()
    # 스왑 후 실제로는 threshold=0.9, warn=0.3 이 되어 0.8은 warn 목록에 들어간다.
    assert body["thresholds"] == {"alert": 0.9, "warn": 0.3}
    assert {a["facilityId"] for a in body["facilityWarnings"]} == {"f1"}
    assert body["facilityAlerts"] == []


@pytest.mark.parametrize("bad_value", [-0.1, 1.5])
def test_status_threshold_out_of_range_422(bad_value):
    client = _make_client()
    res = client.get("/api/v1/admin/safety/status", params={"threshold": bad_value}, headers=_admin_headers())
    assert res.status_code == 422


# ============================================================================
# 4. 존 롤업(150m 격자, 목킹)
# ============================================================================

def test_status_zone_rollup_groups_nearby_facilities_by_grid():
    # f1/f2 는 소수 3자리 반올림 시 같은 격자(35.840, 129.210)에 속하고 f3 은 멀리 떨어져 별도 격자.
    facilities = [
        {"id": "f1", "name": "황남빵 본점", "type": "restaurant", "latitude": 35.83969, "longitude": 129.21015},
        {"id": "f2", "name": "동리단길카페", "type": "cafe", "latitude": 35.83971, "longitude": 129.21018},
        {"id": "f3", "name": "첨성대", "type": "attraction", "latitude": 35.90000, "longitude": 129.30000},
    ]
    congestion_map = {
        "f1": {"level": 0.95, "current_count": 95, "timestamp": "t"},
        "f2": {"level": 0.55, "current_count": 55, "timestamp": "t"},
        "f3": {"level": 0.10, "current_count": 10, "timestamp": "t"},
    }
    p1, p2, p3 = _patched(facilities, congestion_map)
    with p1, p2, p3:
        client = _make_client()
        res = client.get("/api/v1/admin/safety/status", headers=_admin_headers())

    assert res.status_code == 200
    body = res.json()
    assert body["meta"]["zoneMethod"] == "grid150m"

    zones_by_count = sorted(body["zones"], key=lambda z: z["facilityCount"], reverse=True)
    merged_zone = zones_by_count[0]
    assert merged_zone["facilityCount"] == 2
    assert merged_zone["maxCongestion"] == pytest.approx(0.95)
    assert merged_zone["avgCongestion"] == pytest.approx((0.95 + 0.55) / 2)
    assert merged_zone["level"] == "alert"  # max 기준(0.95 >= 기본 threshold 0.85)
    assert merged_zone["zoneLabel"] == "황남빵 본점 일대"  # 존 내 최고 혼잡 시설이 대표

    solo_zone = zones_by_count[1]
    assert solo_zone["facilityCount"] == 1
    assert solo_zone["level"] == "normal"

    assert body["summary"]["alertZones"] == 1
    assert body["summary"]["normalZones"] == 1


# ============================================================================
# 5. 다음 1시간 예측(있으면 포함, 실패 시 null)
# ============================================================================

def test_status_next_hour_prediction_uses_anchoring_formula():
    facilities = [{"id": "f1", "name": "황리단길", "type": "cafe", "latitude": 35.80, "longitude": 129.20}]
    congestion_map = {"f1": {"level": 0.9, "current_count": 90, "timestamp": "t"}}

    def fake_predict(ftype, hour, dow):
        # now(3시)=0.4, +1h(4시)=0.6 — 서로 다른 기저값으로 오프셋 반영을 검증.
        return {3: 0.4, 4: 0.6}[hour]

    p1, p2, _ = _patched(facilities, congestion_map)
    with p1, p2, \
         patch.object(safety, "predict_congestion", side_effect=fake_predict), \
         patch.object(safety, "_utcnow", return_value=FIXED_NOW):
        client = _make_client()
        res = client.get("/api/v1/admin/safety/status", headers=_admin_headers())

    body = res.json()
    # offset = 0.9 - 0.4 = 0.5 → next = clamp01(0.6 + 0.5) = 1.0
    assert body["facilityAlerts"][0]["nextHourCongestion"] == pytest.approx(1.0)
    zone = body["zones"][0]
    assert zone["nextHourCongestion"] == pytest.approx(1.0)


def test_status_next_hour_prediction_null_on_predict_failure():
    facilities = [{"id": "f1", "name": "황리단길", "type": "cafe", "latitude": 35.80, "longitude": 129.20}]
    congestion_map = {"f1": {"level": 0.9, "current_count": 90, "timestamp": "t"}}
    p1, p2, _ = _patched(facilities, congestion_map)
    with p1, p2, patch.object(safety, "predict_congestion", side_effect=RuntimeError("model boom")):
        client = _make_client()
        res = client.get("/api/v1/admin/safety/status", headers=_admin_headers())

    assert res.status_code == 200  # 예측 실패는 무해 폴백 — 전체 요청은 계속 성공한다
    body = res.json()
    assert body["facilityAlerts"][0]["nextHourCongestion"] is None
    assert body["zones"][0]["nextHourCongestion"] is None
