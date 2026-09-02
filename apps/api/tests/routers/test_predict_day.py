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
    with patch.object(predict, "predict_congestion", side_effect=_min_at_kst16), \
         patch.object(predict, "get_model_info", return_value={"trained": True}):
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

    with patch.object(predict, "predict_congestion", side_effect=_capture), \
         patch.object(predict, "get_model_info", return_value={"trained": True}):
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
         patch.object(predict, "predict_congestion", side_effect=_min_at_kst16), \
         patch.object(predict, "get_model_info", return_value={"trained": True}):
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


# ── 학습에 없던 조합 — predict_congestion 이 None 을 준다 ───────────────────
# 이 계약이 테스트에 없어서 500 이 오래 살아 있었다. 위 테스트들이 전부 float 를 돌려주는
# 가짜를 끼우기 때문에 None 경로를 한 번도 타지 않았다.


def test_an_unseen_hour_is_reported_honestly_not_as_a_500():
    """round(None) 은 TypeError → 500 이었다. 지어내지도, 터지지도 않아야 한다."""
    def _one_hour_missing(_type: str, hour: int, dow: int):
        return None if hour == 7 else 0.5

    with patch.object(predict, "predict_congestion", side_effect=_one_hour_missing), \
         patch.object(predict, "get_model_info", return_value={"trained": True}):
        res = _make_client().get("/predict/day", params={"facilityType": "cafe", "dow": 0})

    assert res.status_code == 503, f"학습에 없던 시각에 {res.status_code} 가 났다"
    assert "예측" in res.json()["detail"]


def test_an_unknown_facility_type_is_a_422_not_a_500():
    """facilityType 은 자유 문자열이라 아무 값이나 들어온다. 알 수 없는 값은 사용자 입력
    문제이지 서버 장애가 아니다 — 503(모델 없음)으로 뭉뚱그리면 원인을 못 찾는다."""
    with patch.object(predict, "get_model_info", return_value={"trained": True}):
        res = _make_client().get("/predict/day", params={"facilityType": "bogus", "dow": 0})
    assert res.status_code == 422


def test_the_24_hour_contract_survives():
    """프런트 미니 막대가 24칸을 전제한다 — 빈 시각을 빼는 방식으로는 고칠 수 없었다."""
    with patch.object(predict, "predict_congestion", side_effect=_min_at_kst16), \
         patch.object(predict, "get_model_info", return_value={"trained": True}):
        res = _make_client().get("/predict/day", params={"facilityType": "cafe", "dow": 0})
    assert [h["hour"] for h in res.json()["hours"]] == list(range(24))
