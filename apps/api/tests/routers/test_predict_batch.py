"""POST /predict/batch (배치 혼잡 예측) 엔드포인트 테스트.

이 파일은 배치 예측 전용이다 — 다른 라우터의 테스트는 test_routers.py(별도 파일)에 둔다.
app.main 전체(모든 라우터)를 띄우지 않고 predict 라우터만 마운트해 격리 테스트한다
(main.py 와 동일하게 prefix="/predict").
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import predict

# 2026-07-06 은 월요일(dow=0). 03시 UTC 고정 — +2h 목표 시각은 05시(같은 요일).
FIXED_NOW = datetime(2026, 7, 6, 3, 0, 0, tzinfo=timezone.utc)

FACILITIES = [
    {"id": "fac-anchored-high", "type": "cafe"},
    {"id": "fac-no-log", "type": "cafe"},
    {"id": "fac-anchored-low", "type": "restaurant"},
]

# 실측 로그: cafe 1곳(0.9), restaurant 1곳(0.1). fac-no-log 는 로그 없음 → anchored=False.
CONGESTION_MAP = {
    "fac-anchored-high": {"level": 0.9, "current_count": 90, "timestamp": "2026-07-06T03:00:00+00:00"},
    "fac-anchored-low": {"level": 0.1, "current_count": 5, "timestamp": "2026-07-06T03:00:00+00:00"},
}


def _fake_predict(facility_type: str, hour: int, dow: int) -> float:
    """시각에 따라 값이 갈리는 결정적 가짜 타입 수준 모델."""
    table = {
        ("cafe", 3, 0): 0.4,        # 지금
        ("cafe", 5, 0): 0.7,        # +2h
        ("restaurant", 3, 0): 0.2,  # 지금
        ("restaurant", 5, 0): 0.6,  # +2h
    }
    return table[(facility_type, hour, dow)]


def _make_client() -> TestClient:
    app = FastAPI()
    app.include_router(predict.router, prefix="/predict")
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clear_batch_cache():
    # 테스트 간 60초 캐시 오염 방지
    predict._batch_cache.clear()
    yield
    predict._batch_cache.clear()


def _patched(facilities=None, congestion_map=None):
    return (
        patch.object(
            predict, "_fetch_facilities_id_type",
            new=AsyncMock(return_value=FACILITIES if facilities is None else facilities),
        ),
        patch.object(
            predict, "fetch_latest_congestion_for_all",
            new=AsyncMock(return_value=CONGESTION_MAP if congestion_map is None else congestion_map),
        ),
        patch.object(predict, "predict_congestion", side_effect=_fake_predict),
        patch.object(predict, "_utcnow", return_value=FIXED_NOW),
    )


def test_batch_happy_path_anchoring_math():
    # 앵커링 공식 검증: offset_f = 현재실측 − predict(타입, 지금) / pred_f = clamp01(predict(타입, 목표) + offset_f)
    p1, p2, p3, p4 = _patched()
    with p1, p2, p3, p4:
        client = _make_client()
        res = client.post("/predict/batch", json={"hours_ahead": 2})

    assert res.status_code == 200
    body = res.json()
    assert body["hours_ahead"] == 2
    assert body["generated_at"] == FIXED_NOW.isoformat()

    by_id = {p["facility_id"]: p for p in body["predictions"]}
    assert set(by_id) == {"fac-anchored-high", "fac-no-log", "fac-anchored-low"}

    # cafe 실측 0.9: offset = 0.9 − 0.4 = 0.5 → 0.7 + 0.5 = 1.2 → clamp 1.0
    assert by_id["fac-anchored-high"]["predicted_congestion"] == pytest.approx(1.0)
    assert by_id["fac-anchored-high"]["anchored"] is True

    # restaurant 실측 0.1: offset = 0.1 − 0.2 = −0.1 → 0.6 − 0.1 = 0.5
    assert by_id["fac-anchored-low"]["predicted_congestion"] == pytest.approx(0.5)
    assert by_id["fac-anchored-low"]["anchored"] is True

    # 로그 없는 시설: 타입 수준 예측 원값(0.7) + anchored=False
    assert by_id["fac-no-log"]["predicted_congestion"] == pytest.approx(0.7)
    assert by_id["fac-no-log"]["anchored"] is False


def test_batch_hours_ahead_zero_returns_current_level_for_anchored():
    # hours_ahead=0 이면 앵커링 항등식: pred = base_now + (현재실측 − base_now) = 현재실측
    p1, p2, p3, p4 = _patched()
    with p1, p2, p3, p4:
        client = _make_client()
        res = client.post("/predict/batch", json={"hours_ahead": 0})

    assert res.status_code == 200
    by_id = {p["facility_id"]: p for p in res.json()["predictions"]}
    assert by_id["fac-anchored-high"]["predicted_congestion"] == pytest.approx(0.9)
    assert by_id["fac-anchored-low"]["predicted_congestion"] == pytest.approx(0.1)
    # 로그 없는 시설은 지금 시점도 타입 수준 예측값
    assert by_id["fac-no-log"]["predicted_congestion"] == pytest.approx(0.4)
    assert by_id["fac-no-log"]["anchored"] is False


@pytest.mark.parametrize("hours_ahead", [-1, 13])
def test_batch_hours_ahead_out_of_bounds_422(hours_ahead):
    client = _make_client()
    res = client.post("/predict/batch", json={"hours_ahead": hours_ahead})
    assert res.status_code == 422


def test_batch_hours_ahead_missing_422():
    client = _make_client()
    res = client.post("/predict/batch", json={})
    assert res.status_code == 422


def test_batch_response_cached_60s_per_hours_ahead():
    # 같은 hours_ahead 재호출은 60초 캐시로 응답 — DB/모델 재조회 없음(버스트 보호)
    p1, p2, p3, p4 = _patched()
    with p1 as fetch_fac_mock, p2, p3, p4:
        client = _make_client()
        first = client.post("/predict/batch", json={"hours_ahead": 2})
        second = client.post("/predict/batch", json={"hours_ahead": 2})

        assert first.status_code == 200 and second.status_code == 200
        assert first.json() == second.json()
        assert fetch_fac_mock.await_count == 1

        # 다른 hours_ahead 는 별도 캐시 키 → 새로 계산
        third = client.post("/predict/batch", json={"hours_ahead": 0})
        assert third.status_code == 200
        assert fetch_fac_mock.await_count == 2
