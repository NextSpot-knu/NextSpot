"""GET /api/v1/admin/safety/status (인파 밀집 안전 경보) 테스트.

predict_batch 테스트(test_predict_batch.py)와 동일하게, app.main 전체를 띄우지 않고
safety 라우터만 FastAPI() 에 마운트해 격리 테스트한다(라우터 자체가 prefix 를 갖고 있어
main.py 와 동일하게 그대로 include_router 하면 된다).

P0-4(2026-10-31): 판정은 **최근 30분 안의 관측**으로만 한다. 그래서 이 파일의 시각은 전부 고정 시각
(FIXED_NOW) 기준이다 — 실행 시각을 따르면 고정된 로그 시각이 언젠가 30분을 넘어 테스트가 저절로 바뀐다.
"""
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from tests.conftest import (
    ADMIN_USER_ID,  # noqa: F401 — 하위 테스트에서 참조
    admin_headers as conftest_admin_headers,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import safety
from app.services.congestion_estimator_service import ANOMALY_LEVEL
from app.services.congestion_evidence import RANKING_FRESHNESS

# 2026-07-14 는 화요일(dow=1). 03시 UTC 고정 — +1h 목표 시각은 04시(같은 요일).
FIXED_NOW = datetime(2026, 7, 14, 3, 0, 0, tzinfo=timezone.utc)


def _ago(minutes: float) -> str:
    """FIXED_NOW 기준 minutes 분 전의 관측 시각(UTC ISO)."""
    return (FIXED_NOW - timedelta(minutes=minutes)).isoformat()


FRESH = _ago(5)  # 판정에 쓰이는 관측(30분 안)


@pytest.fixture(autouse=True)
def _frozen_clock():
    with patch.object(safety, "_utcnow", return_value=FIXED_NOW):
        yield


def _make_client() -> TestClient:
    app = FastAPI()
    app.include_router(safety.router)
    return TestClient(app)


def _admin_headers(sub: str | None = None) -> dict:
    # 관리자 판정은 JWT + users.role 이다(공유 토큰 가드는 폐지).
    # sub 를 넘기면 그 사용자의 역할로 평가된다 — 권한 없는 계정 테스트에 쓴다.
    return conftest_admin_headers(sub)


def _log(level: float, timestamp: str = FRESH, *, source: str = "user_report", tier: str = "single_report") -> dict:
    """fetch_latest_congestion_for_all 의 시설별 info 모양(infrastructures._congestion_info)."""
    return {
        "level": level,
        "current_count": None,
        "timestamp": timestamp,
        "source": source,
        "evidence_tier": tier,
        "is_stale": False,
        "is_current": False,
    }


def _patched(facilities, congestion_map, predict_side_effect=None):
    """facilities/congestion 조회 + predict_congestion 을 패치하는 3개 patch 컨텍스트를 반환."""
    return (
        patch.object(safety, "_fetch_facilities", new=AsyncMock(return_value=facilities)),
        patch.object(safety, "fetch_latest_congestion_for_all", new=AsyncMock(return_value=congestion_map)),
        patch.object(safety, "predict_congestion", side_effect=predict_side_effect or (lambda t, h, d: 0.5)),
    )


def _get(facilities, congestion_map, **params):
    p1, p2, p3 = _patched(facilities, congestion_map)
    with p1, p2, p3:
        return _make_client().get("/api/v1/admin/safety/status", params=params, headers=_admin_headers())


# ============================================================================
# 1. 인증 가드(401)
# ============================================================================

def test_status_requires_admin_401():
    client = _make_client()
    res = client.get("/api/v1/admin/safety/status")
    assert res.status_code == 401


def test_status_rejects_non_admin_account_403():
    """유효한 로그인이어도 role 이 admin 이 아니면 막힌다.

    구 가드는 공유 토큰 하나만 봐서 '토큰이 틀리면 401' 이었다. 이제는 **누구인지**를 먼저
    확인하므로, 로그인은 됐지만 권한이 없는 계정은 401(인증 실패)이 아니라 403(권한 없음)이다.
    """
    client = _make_client()
    res = client.get(
        "/api/v1/admin/safety/status",
        headers=_admin_headers("00000000-0000-4000-8000-000000000000"),  # tourist
    )
    assert res.status_code == 403


# ============================================================================
# 2. 관측 없음 → 판정 불가(정상이 아니다)
# ============================================================================

def test_status_no_logs_is_unavailable_not_normal():
    facilities = [{"id": "f1", "name": "동궁원", "type": "attraction", "latitude": 35.8, "longitude": 129.2}]
    res = _get(facilities, {})

    assert res.status_code == 200
    body = res.json()
    assert body["judgement"] == "unavailable"
    assert body["sampleEmpty"] is True
    assert body["facilityAlerts"] == []
    assert body["facilityWarnings"] == []
    assert body["zones"] == []
    # 관측이 없으면 '정상' 존도 0 — 관측 없는 구역은 어느 칸에도 세지 않는다.
    assert body["summary"]["normalZones"] == 0
    assert body["summary"]["observedZones"] == 0
    assert body["observedFacilities"] == 0
    assert body["latestObservedAt"] is None
    assert body["meta"]["zoneMethod"] == "grid150m"
    assert body["meta"]["maxObservationAgeMinutes"] == 30


def test_status_stale_report_never_raises_an_alert():
    """2주 전 제보 한 건이 오늘의 '경보' 가 되던 결함(P0-4) — 30분이 지난 관측은 판정에 쓰지 않는다."""
    facilities = [{"id": "f1", "name": "황리단길", "type": "attraction", "latitude": 35.80, "longitude": 129.20}]
    two_weeks_ago = (FIXED_NOW - timedelta(days=14)).isoformat()
    res = _get(facilities, {"f1": _log(0.99, two_weeks_ago)})

    body = res.json()
    assert body["judgement"] == "unavailable"
    assert body["sampleEmpty"] is True
    assert body["facilityAlerts"] == [] and body["zones"] == []
    assert body["summary"]["alertZones"] == 0
    assert body["staleFacilities"] == 1
    # '마지막 관측 14일 전' 을 화면이 말할 수 있게 오래된 관측 시각은 따로 싣는다.
    assert body["latestObservedAt"] == two_weeks_ago


def test_status_freshness_window_is_the_ranking_window():
    """판정 창은 추천 순위의 '지금' 판정과 같은 30분이다(같은 상수를 쓴다)."""
    assert safety.OBSERVATION_MAX_AGE == RANKING_FRESHNESS == timedelta(minutes=30)
    facilities = [
        {"id": "edge", "name": "경계", "type": "cafe", "latitude": 35.80, "longitude": 129.20},
        {"id": "over", "name": "넘김", "type": "cafe", "latitude": 35.90, "longitude": 129.30},
        {"id": "future", "name": "미래", "type": "cafe", "latitude": 36.00, "longitude": 129.40},
        {"id": "bad", "name": "시각 없음", "type": "cafe", "latitude": 36.10, "longitude": 129.50},
    ]
    congestion_map = {
        "edge": _log(0.95, _ago(30)),                      # 정확히 30분 — 포함
        "over": _log(0.95, _ago(30.5)),                    # 30분 초과 — 제외
        "future": _log(0.95, (FIXED_NOW + timedelta(minutes=2)).isoformat()),  # 미래 — 제외
        "bad": _log(0.95, "t"),                            # 읽을 수 없는 시각 — 제외
    }
    body = _get(facilities, congestion_map).json()
    assert [a["facilityId"] for a in body["facilityAlerts"]] == ["edge"]
    assert body["observedFacilities"] == 1
    assert body["staleFacilities"] == 3
    assert body["judgement"] == "available"


def test_status_mixed_fresh_and_stale_only_judges_fresh():
    facilities = [
        {"id": "fresh", "name": "첨성대", "type": "attraction", "latitude": 35.80, "longitude": 129.20},
        {"id": "stale", "name": "황리단길", "type": "attraction", "latitude": 35.90, "longitude": 129.30},
    ]
    congestion_map = {"fresh": _log(0.2), "stale": _log(0.97, _ago(90))}
    body = _get(facilities, congestion_map).json()

    assert body["judgement"] == "available"
    assert body["sampleEmpty"] is False
    assert body["facilityAlerts"] == []
    assert [z["zoneLabel"] for z in body["zones"]] == ["첨성대 일대"]
    assert body["summary"] == {
        "alertZones": 0, "warnZones": 0, "normalZones": 1,
        "alertFacilities": 0, "warnFacilities": 0, "observedZones": 1,
    }
    assert body["staleFacilities"] == 1


# ============================================================================
# 3. 임계값 분류 (facility 단위)
# ============================================================================

def test_default_alert_threshold_is_the_dashboard_anomaly_level():
    """경보 기준은 대시보드 '이상 혼잡'·추정 집계와 같은 상수 하나다(예전 안전 화면만 85%)."""
    assert safety.DEFAULT_ALERT_THRESHOLD == ANOMALY_LEVEL == 0.9
    facilities = [
        {"id": "f-88", "name": "대릉원", "type": "attraction", "latitude": 35.80, "longitude": 129.20},
        {"id": "f-90", "name": "황리단길", "type": "attraction", "latitude": 35.81, "longitude": 129.21},
    ]
    body = _get(facilities, {"f-88": _log(0.88), "f-90": _log(0.9)}).json()
    assert body["thresholds"] == {"alert": 0.9, "warn": 0.7}
    assert {a["facilityId"] for a in body["facilityAlerts"]} == {"f-90"}
    assert {a["facilityId"] for a in body["facilityWarnings"]} == {"f-88"}


def test_status_classifies_facility_alert_warn_normal_with_default_thresholds():
    facilities = [
        {"id": "f-alert", "name": "황리단길", "type": "attraction", "latitude": 35.80, "longitude": 129.20},
        {"id": "f-warn", "name": "동궁원", "type": "cafe", "latitude": 35.81, "longitude": 129.21},
        {"id": "f-normal", "name": "첨성대", "type": "attraction", "latitude": 35.82, "longitude": 129.22},
    ]
    congestion_map = {
        "f-alert": _log(0.9, source="merchant_report", tier="corroborated"),
        "f-warn": _log(0.75),
        "f-normal": _log(0.2),
    }
    res = _get(facilities, congestion_map)

    assert res.status_code == 200
    body = res.json()
    assert body["sampleEmpty"] is False
    assert {a["facilityId"] for a in body["facilityAlerts"]} == {"f-alert"}
    assert {a["facilityId"] for a in body["facilityWarnings"]} == {"f-warn"}
    assert body["summary"]["alertFacilities"] == 1
    assert body["summary"]["warnFacilities"] == 1
    # 판정 근거(출처·등급·시각)가 항목에 실린다.
    alert = body["facilityAlerts"][0]
    assert alert["source"] == "merchant_report"
    assert alert["evidenceTier"] == "corroborated"
    assert alert["timestamp"] == FRESH


def test_status_custom_thresholds_via_query_params():
    # 기본 임계값(0.9/0.7)이면 0.5는 normal 이지만, threshold=0.4/warn=0.3 을 주면 alert 이 된다.
    facilities = [{"id": "f1", "name": "황리단길", "type": "attraction", "latitude": 35.80, "longitude": 129.20}]
    res = _get(facilities, {"f1": _log(0.5)}, threshold=0.4, warn=0.3)

    assert res.status_code == 200
    body = res.json()
    assert body["thresholds"] == {"alert": 0.4, "warn": 0.3}
    assert body["facilityAlerts"][0]["facilityId"] == "f1"


def test_status_swaps_inverted_thresholds_defensively():
    # 프런트 슬라이더 오조작으로 warn > threshold 가 들어와도 분류가 뒤집히지 않도록 스왑한다.
    facilities = [{"id": "f1", "name": "황리단길", "type": "attraction", "latitude": 35.80, "longitude": 129.20}]
    body = _get(facilities, {"f1": _log(0.8)}, threshold=0.3, warn=0.9).json()

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
        "f1": _log(0.95, _ago(12)),
        "f2": _log(0.55, _ago(3), source="merchant_report"),
        "f3": _log(0.10, _ago(20)),
    }
    res = _get(facilities, congestion_map)

    assert res.status_code == 200
    body = res.json()
    assert body["meta"]["zoneMethod"] == "grid150m"

    zones_by_count = sorted(body["zones"], key=lambda z: z["facilityCount"], reverse=True)
    merged_zone = zones_by_count[0]
    assert merged_zone["facilityCount"] == 2
    assert merged_zone["maxCongestion"] == pytest.approx(0.95)
    assert merged_zone["avgCongestion"] == pytest.approx((0.95 + 0.55) / 2)
    assert merged_zone["level"] == "alert"  # max 기준(0.95 >= 기본 threshold 0.9)
    assert merged_zone["zoneLabel"] == "황남빵 본점 일대"  # 존 내 최고 혼잡 시설이 대표
    # 존 카드의 근거 — 존 안에서 가장 최근 관측 시각과 출처별 시설 수.
    assert merged_zone["observedAt"] == _ago(3)
    assert merged_zone["sourceCounts"] == {"user_report": 1, "merchant_report": 1}

    solo_zone = zones_by_count[1]
    assert solo_zone["facilityCount"] == 1
    assert solo_zone["level"] == "normal"
    assert solo_zone["observedAt"] == _ago(20)

    assert body["summary"]["alertZones"] == 1
    assert body["summary"]["normalZones"] == 1
    assert body["summary"]["observedZones"] == 2
    assert body["latestObservedAt"] == _ago(3)


# ============================================================================
# 5. 다음 1시간 예측(있으면 포함, 실패 시 null)
# ============================================================================

def test_status_next_hour_prediction_uses_anchoring_formula():
    facilities = [{"id": "f1", "name": "황리단길", "type": "cafe", "latitude": 35.80, "longitude": 129.20}]
    congestion_map = {"f1": _log(0.9)}

    def fake_predict(ftype, hour, dow):
        # now(3시)=0.4, +1h(4시)=0.6 — 서로 다른 기저값으로 오프셋 반영을 검증.
        return {3: 0.4, 4: 0.6}[hour]

    p1, p2, _ = _patched(facilities, congestion_map)
    with p1, p2, patch.object(safety, "predict_congestion", side_effect=fake_predict):
        client = _make_client()
        res = client.get("/api/v1/admin/safety/status", headers=_admin_headers())

    body = res.json()
    # offset = 0.9 - 0.4 = 0.5 → next = clamp01(0.6 + 0.5) = 1.0
    assert body["facilityAlerts"][0]["nextHourCongestion"] == pytest.approx(1.0)
    zone = body["zones"][0]
    assert zone["nextHourCongestion"] == pytest.approx(1.0)


def test_status_next_hour_prediction_null_on_predict_failure():
    facilities = [{"id": "f1", "name": "황리단길", "type": "cafe", "latitude": 35.80, "longitude": 129.20}]
    congestion_map = {"f1": _log(0.9)}
    p1, p2, _ = _patched(facilities, congestion_map)
    with p1, p2, patch.object(safety, "predict_congestion", side_effect=RuntimeError("model boom")):
        client = _make_client()
        res = client.get("/api/v1/admin/safety/status", headers=_admin_headers())

    assert res.status_code == 200  # 예측 실패는 무해 폴백 — 전체 요청은 계속 성공한다
    body = res.json()
    assert body["facilityAlerts"][0]["nextHourCongestion"] is None
    assert body["zones"][0]["nextHourCongestion"] is None


# ============================================================================
# 6. 조회 실패는 '판정 불가' 로도 꾸미지 않는다 — 500
# ============================================================================

def test_status_rpc_failure_is_an_error_not_unavailable():
    facilities = [{"id": "f1", "name": "황리단길", "type": "cafe", "latitude": 35.80, "longitude": 129.20}]
    with patch.object(safety, "_fetch_facilities", new=AsyncMock(return_value=facilities)), \
            patch.object(safety, "fetch_latest_congestion_for_all", new=AsyncMock(side_effect=RuntimeError("rpc down"))):
        res = _make_client().get("/api/v1/admin/safety/status", headers=_admin_headers())
    assert res.status_code == 500
