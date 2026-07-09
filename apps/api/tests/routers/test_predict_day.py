"""GET /predict/day (하루 24시간 혼잡 예측) 엔드포인트 테스트.

추천 카드의 '최적 방문 시각' 미니 막대용. batch 테스트와 동일하게 predict 라우터만
격리 마운트해(prefix="/predict") 화면용 KST 시(0-23) → 모델용 UTC hour/dow 변환과
최저 혼잡 시각 선택을 검증한다.
"""

from datetime import datetime, timezone
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import predict

# UTC 03:00 = KST 12:00, 2026-07-06 은 월요일 → 기본 dow(KST)=0.
FIXED_NOW = datetime(2026, 7, 6, 3, 0, 0, tzinfo=timezone.utc)


def _make_client() -> TestClient:
    app = FastAPI()
    app.include_router(predict.router, prefix="/predict")
    return TestClient(app)


def _min_at_kst16(facility_type: str, hour: int, dow: int) -> float:
    """KST 16시(=UTC 7시, 요일 유지)에서만 최저(0.05), 나머지는 0.5인 결정적 가짜 모델."""
    if hour == 7 and dow == 0:
        return 0.05
    return 0.5


def test_day_shape_and_best_hour():
    with patch.object(predict, "predict_congestion", side_effect=_min_at_kst16):
        client = _make_client()
        res = client.get("/predict/day", params={"facilityType": "cafe", "dow": 0})

    assert res.status_code == 200
    body = res.json()
    assert body["facility_type"] == "cafe"
    assert body["dow"] == 0
    # 24시간, KST 0..23 순서
    assert [h["hour"] for h in body["hours"]] == list(range(24))
    # KST 16시가 가장 한산
    assert body["best_hour"] == 16
    assert body["best_congestion"] == 0.05
    assert body["hours"][16]["congestion"] == 0.05


def test_day_kst_to_utc_mapping():
    # predict_congestion 에 전달된 (utc_hour, utc_dow) 조합이 KST→UTC 변환과 정확히 일치하는지 검증.
    calls: list[tuple[int, int]] = []

    def _capture(facility_type: str, hour: int, dow: int) -> float:
        calls.append((hour, dow))
        return 0.5

    with patch.object(predict, "predict_congestion", side_effect=_capture):
        client = _make_client()
        res = client.get("/predict/day", params={"facilityType": "restaurant", "dow": 0})

    assert res.status_code == 200
    # KST 9..23 → (0..14, dow 유지=0); KST 0..8 → (15..23, 전날 dow=6)
    expected = {(h - 9, 0) for h in range(9, 24)} | {(h + 15, 6) for h in range(0, 9)}
    assert set(calls) == expected
    assert len(calls) == 24


def test_day_defaults_dow_to_today_kst():
    # dow 생략 시 오늘(KST) 요일 사용 — FIXED_NOW(UTC) → KST 월요일(0).
    with patch.object(predict, "_utcnow", return_value=FIXED_NOW), \
         patch.object(predict, "predict_congestion", side_effect=_min_at_kst16):
        client = _make_client()
        res = client.get("/predict/day", params={"facilityType": "cafe"})

    assert res.status_code == 200
    assert res.json()["dow"] == 0


def test_day_missing_facility_type_422():
    client = _make_client()
    res = client.get("/predict/day")
    assert res.status_code == 422


def test_day_dow_out_of_bounds_422():
    client = _make_client()
    res = client.get("/predict/day", params={"facilityType": "cafe", "dow": 7})
    assert res.status_code == 422
