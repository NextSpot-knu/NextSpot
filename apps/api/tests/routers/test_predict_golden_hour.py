"""GET /predict/golden-hour (골든타임 알리미) 엔드포인트 테스트.

다른 predict 테스트(test_predict_day.py, test_predict_batch.py)와 동일하게 predict 라우터만
격리 마운트해(prefix="/predict") 검증한다. 이 엔드포인트는 세 갈래로 갈린다:
  1) 시설 없음 → 404
  2) 모델 미학습 → 200 + available:false (정직한 폴백 — 평탄한 0.5 곡선을 그럴듯하게 보여주지 않음)
  3) 정상 → 오늘 남은 시간대(현재시각~22시) 앵커링 곡선에서 최저 혼잡 60분 창 반환
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import predict

FACILITY_ID = "fac-golden-1"

# UTC 03:00 = KST 12:00, 2026-07-06 은 월요일(dow=0) → 남은 그리드는 KST 12..22시(11개).
FIXED_NOW_NOON_KST = datetime(2026, 7, 6, 3, 0, 0, tzinfo=timezone.utc)

# UTC 15:00 = KST 23:00(다음날 넘어가기 전, 같은 날짜) → 남은 그리드가 비어 available:false 케이스.
FIXED_NOW_23_KST = datetime(2026, 7, 6, 14, 30, 0, tzinfo=timezone.utc)


class _FakeResult:
    def __init__(self, data):
        self.data = data


class FakeTable:
    """어떤 체이닝 메서드 호출이든 self 를 반환하고 execute() 에서 canned 데이터를 준다."""

    def __init__(self, data):
        self._data = data

    def __getattr__(self, _name):
        def _chain(*_args, **_kwargs):
            return self

        return _chain

    def execute(self):
        return _FakeResult(self._data)


class FakeSupabase:
    def __init__(self, tables: dict):
        self._tables = tables

    def table(self, name: str) -> FakeTable:
        return FakeTable(self._tables.get(name, []))


def _make_client() -> TestClient:
    app = FastAPI()
    app.include_router(predict.router, prefix="/predict")
    return TestClient(app)


def _min_at_utc7_dow0(facility_type: str, hour: int, dow: int) -> float:
    """KST 16시(=UTC 7시, 월요일)에서만 최저(0.05), 나머지는 0.5인 결정적 가짜 타입 수준 모델."""
    if hour == 7 and dow == 0:
        return 0.05
    return 0.5


def test_golden_hour_facility_not_found_404():
    with patch.object(predict, "supabase_client", new=FakeSupabase({"facilities": []})):
        client = _make_client()
        res = client.get("/predict/golden-hour", params={"facilityId": FACILITY_ID})
    assert res.status_code == 404


def test_golden_hour_model_untrained_returns_available_false():
    facilities = [{"id": FACILITY_ID, "type": "cafe"}]
    with patch.object(predict, "supabase_client", new=FakeSupabase({"facilities": facilities})), \
         patch.object(predict, "get_model_info", return_value={"trained": False, "metrics": None}):
        client = _make_client()
        res = client.get("/predict/golden-hour", params={"facilityId": FACILITY_ID})

    assert res.status_code == 200
    body = res.json()
    assert body["available"] is False
    assert body["facility_id"] == FACILITY_ID
    assert body["curve"] == []
    assert body["start"] is None


def test_golden_hour_happy_path_anchored_curve_and_best_window():
    facilities = [{"id": FACILITY_ID, "type": "cafe"}]
    # 실측 혼잡 0.9 → offset = 0.9 - base_now(0.5) = 0.4
    congestion_map = {FACILITY_ID: {"level": 0.9, "current_count": 90, "timestamp": "2026-07-06T03:00:00+00:00"}}

    with patch.object(predict, "supabase_client", new=FakeSupabase({"facilities": facilities})), \
         patch.object(predict, "get_model_info", return_value={"trained": True, "metrics": {"mae": 0.1}}), \
         patch.object(predict, "_utcnow", return_value=FIXED_NOW_NOON_KST), \
         patch.object(predict, "fetch_latest_congestion_for_all", new=AsyncMock(return_value=congestion_map)), \
         patch.object(predict, "predict_congestion", side_effect=_min_at_utc7_dow0):
        client = _make_client()
        res = client.get("/predict/golden-hour", params={"facilityId": FACILITY_ID})

    assert res.status_code == 200
    body = res.json()
    assert body["available"] is True
    assert body["facility_id"] == FACILITY_ID

    # KST 12..22시(11개), 오름차순
    assert [p["hour"] for p in body["curve"]] == list(range(12, 23))

    # KST 16시(=UTC 7,dow0)만 base=0.05 → +offset(0.4) = 0.45. 나머지는 0.5+0.4=0.9.
    by_hour = {p["hour"]: p["congestion"] for p in body["curve"]}
    assert by_hour[16] == 0.45
    assert by_hour[12] == 0.9

    # 최저 혼잡 60분 창은 16~17시.
    assert body["start"] == 16
    assert body["end"] == 17
    assert body["congestion"] == 0.45


def test_golden_hour_no_hours_left_returns_available_false():
    # KST 23시 이후 진입 — 오늘 남은 시간대(현재~22시) 그리드가 비어 정직한 폴백.
    facilities = [{"id": FACILITY_ID, "type": "cafe"}]
    with patch.object(predict, "supabase_client", new=FakeSupabase({"facilities": facilities})), \
         patch.object(predict, "get_model_info", return_value={"trained": True, "metrics": None}), \
         patch.object(predict, "_utcnow", return_value=FIXED_NOW_23_KST):
        client = _make_client()
        res = client.get("/predict/golden-hour", params={"facilityId": FACILITY_ID})

    assert res.status_code == 200
    body = res.json()
    assert body["available"] is False
    assert body["curve"] == []


def test_golden_hour_missing_facility_id_422():
    client = _make_client()
    res = client.get("/predict/golden-hour")
    assert res.status_code == 422
