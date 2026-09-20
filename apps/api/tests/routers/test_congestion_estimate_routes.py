"""추정 모드가 관광객 응답 세 곳(지도 · 추천 두 경로 · 코스)에 **어떻게** 실리는가.

계약(추가만 — 구 번들은 모르는 필드라 지나간다):
  · /congestion/estimates  : 지도가 덧칠할 시설별 추정 묶음(/infrastructures 에는 싣지 않는다)
  · /recommendations(/by-type): '지금' 자격이 있는 실측·예측이 없을 때만 congestion_estimate
                              ('지금' 자격 = verified/corroborated · 30분 이내, 또는 사장님 좌석 방송).
                              congestion_source/level 은 **손대지 않는다** — 낡은 실측도 그대로 실려 나가고
                              congestion_is_current=False 로 '마지막 관측' 임을 알린다
  · /courses/plan           : 예측·실측이 없고 도착이 관측 후 30분 안일 때만 정류지에 congestion_estimate
추정은 점수·scoring_mode·시간비용을 바꾸지 않는다(D2 — area_stats_rules 가 같은 산식을 이미 시간비용에
반영한다). 닿는 곳은 area_stats_rules 후보의 붐빔 판정(ranking_congestion ≥ 0.9 → 강등) 하나뿐이다.
"""

from datetime import timedelta
from unittest.mock import AsyncMock, patch

import pytest

from app.services import congestion_estimator_service
from app.services.preference_vector_service import preference_vector_service

from test_routers import (
    AUTH_USER_ID,
    BASE_LAT,
    BASE_LNG,
    USER_ROW,
    UNIT_VECTOR,
    FakeSupabase,
    _FROZEN_UTC,
    _cong,
    _facility,
    auth_client,  # noqa: F401 — pytest 픽스처 재사용
    client,       # noqa: F401
    _freeze_router_clock,  # noqa: F401 — autouse: 라우터 now() 를 12:00 KST 로 고정
)

OBSERVED_AT = _FROZEN_UTC - timedelta(minutes=5)


def _estimate_row(level: float) -> dict:
    return {
        "level": level, "parking_level": 0.8, "tourism_level": 0.5,
        "zone": "1:1", "lot_count": 3, "nearest_lot_m": 240,
    }


def _REAL_NOW():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc)


@pytest.fixture
def estimates_for(monkeypatch):
    """추정기가 지금 이 시설들에 이 값을 준다고 가정한다(나머지 시설은 반경 밖 = 키 없음).

    추정 근거는 내보낼 때 관측 나이를 **벽시계로** 다시 잰다(congestion_evidence.estimate_for).
    라우터 시계는 _freeze_router_clock 이 12:00 KST 로 고정하므로 근거 모듈의 시계도 같은
    시각으로 맞춘다 — 안 그러면 '5분 전 관측' 이 몇 주 전 관측이 되어 전부 만료된다.
    """
    from test_routers import _frozen_datetime

    monkeypatch.setattr("app.services.congestion_evidence.datetime", _frozen_datetime())
    # 채점의 도착 시각(붐빔 판정이 추정을 쓸지 가르는 기준)도 같은 시계여야 한다.
    monkeypatch.setattr("app.services.spot.score.datetime", _frozen_datetime())

    def _install(levels: dict[str, float]):
        async def _current(*, now=None):
            return {
                "available": True, "reason": None,
                "observed_at": OBSERVED_AT.isoformat(),
                "bucket_at": OBSERVED_AT.replace(minute=0).isoformat(),
                "lot_count": 4,
                "estimates": {fid: _estimate_row(level) for fid, level in levels.items()},
            }

        monkeypatch.setattr(congestion_estimator_service, "current_estimates", _current)

    return _install


# =========================================================================
# 지도
# =========================================================================

def test_map_estimates_come_from_their_own_endpoint(client, estimates_for):  # noqa: F811
    estimates_for({"f-1": 0.7, "f-2": 0.44})
    res = client.get("/api/v1/congestion/estimates")
    assert res.status_code == 200
    body = res.json()
    assert body["available"] is True
    assert body["radius_m"] == 2000
    assert body["lot_count"] == 4
    assert body["observed_at"] == OBSERVED_AT.isoformat()
    assert body["estimates"]["f-2"] == {
        "level": 0.44, "source": "estimated", "observed_at": OBSERVED_AT.isoformat(),
        "parking_level": 0.8, "tourism_level": 0.5, "lot_count": 3,
        "nearest_lot_m": 240.0, "radius_m": 2000,
        # 보정 흔적은 이 응답에서도 살아남아야 한다. 예전에는 pydantic 이 extra='ignore' 라
        # 이 엔드포인트에서만 조용히 사라졌다(추천·코스는 같은 모델을 쓰므로 함께 잃었다).
        "raw_level": 0.44, "calibrated": False, "calibration_basis": "보정 전(서울 표본 부족)",
    }
    # 주차 반경 밖 시설은 키가 없다 — 값을 만들지 않는다.
    assert set(body["estimates"]) == {"f-1", "f-2"}


def test_infrastructures_payload_does_not_grow_with_estimates(client, estimates_for):  # noqa: F811
    """지도 시설 응답에는 추정을 싣지 않는다(느린 응답을 더 늦추고 폴백 경로에서는 사라진다).

    그래서 구 번들이 받는 /infrastructures 는 추정 모드 전과 한 글자도 다르지 않다.
    """
    estimates_for({"f-1": 0.7})
    facilities = [_facility("f-1", "cafe", 0.0002)]
    with patch("app.routers.infrastructures.supabase_client", new=FakeSupabase({"facilities": facilities})),          patch("app.routers.infrastructures.fetch_latest_congestion_for_all", new=AsyncMock(return_value={})):
        res = client.get("/api/v1/infrastructures")
    assert res.status_code == 200
    assert not any("estimate" in key for key in res.json()[0])


def test_map_estimates_expire_at_serve_time(client, monkeypatch):  # noqa: F811
    # 추정기 캐시 끝자락(관측 61분)에도 '지금' 으로 내보내지 않는다.
    old = (_REAL_NOW() - timedelta(minutes=61)).isoformat()

    async def _current(*, now=None):
        return {"available": True, "reason": None, "observed_at": old, "bucket_at": old,
                "lot_count": 4, "estimates": {"f-1": _estimate_row(0.5)}}

    monkeypatch.setattr(congestion_estimator_service, "current_estimates", _current)
    body = client.get("/api/v1/congestion/estimates").json()
    assert body["available"] is False
    assert body["estimates"] == {}


def test_map_estimates_survive_a_broken_estimator(client, monkeypatch):  # noqa: F811
    async def _boom(*, now=None):
        raise RuntimeError("snapshot table missing")

    monkeypatch.setattr(congestion_estimator_service, "current_estimates", _boom)
    res = client.get("/api/v1/congestion/estimates")
    assert res.status_code == 200
    assert res.json() == {
        "available": False, "reason": "estimates_unavailable", "observed_at": None,
        "radius_m": None, "lot_count": 0, "estimates": {},
    }


# =========================================================================
# 추천(by-type) — 표시만 바뀌고 순위는 그대로
# =========================================================================

def _by_type(auth_client, cafes, congestion_map):  # noqa: F811
    with patch("app.routers.recommendations.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.recommendations.fetch_all_facilities", new=AsyncMock(return_value=cafes)), \
         patch("app.routers.recommendations.fetch_congestion_map", new=AsyncMock(return_value=congestion_map)), \
         patch("app.routers.recommendations.get_model_info", return_value={"trained": False}), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)), \
         patch("app.routers.recommendations.generate_reason_with_source", new=AsyncMock(return_value=("사유", "template"))):
        res = auth_client.post("/api/v1/recommendations/by-type", json={
            "user_id": AUTH_USER_ID, "facility_type": "cafe",
            "user_lat": BASE_LAT, "user_lng": BASE_LNG,
        })
    assert res.status_code == 200, res.text
    return res.json()


def _area_cafe(fid: str, lat_offset: float) -> dict:
    # 관광 통계 기준선이 붙은 후보 = area_stats_rules(주변 수요 등급). 실제로는
    # fetch_all_facilities 가 attach_tourism_area_priors 로 붙이는 값이다.
    return {**_facility(fid, "cafe", lat_offset), "tourapi_concentration_rate": 50.0}


def test_by_type_shows_the_estimate_and_uses_it_only_as_the_crowded_gate(auth_client, estimates_for):  # noqa: F811
    cafes = [_area_cafe("c-1", 0.0002), _area_cafe("c-2", 0.0004), _area_cafe("c-3", 0.0006)]
    measured = {"c-3": {**_cong(0.3, source="user_report"), "evidence_tier": "single_report"}}

    baseline = _by_type(auth_client, cafes, measured)
    assert all(i["scoring_mode"] == "area_stats_rules" for i in baseline)
    assert baseline[0]["facility"]["id"] == "c-1"  # 가장 가깝고 나머지는 같다

    # 가장 가까운 c-1 에 '붐빔' 추정(0.95 — CROWDED 컷오프 0.9 위), c-2 는 한산.
    estimates_for({"c-1": 0.95, "c-2": 0.2, "c-3": 0.6})
    estimated = _by_type(auth_client, cafes, measured)
    before = {i["facility"]["id"]: i for i in baseline}
    after = {i["facility"]["id"]: i for i in estimated}

    # 점수·모드·대기는 그대로다 — 같은 산식이 area_stats_rules 시간비용에 이미 있다(이중 계산 금지).
    for fid in before:
        assert after[fid]["spot_score"] == before[fid]["spot_score"]
        assert after[fid]["scoring_mode"] == before[fid]["scoring_mode"]
        assert after[fid]["breakdown"]["wait_time"] is None
        assert after[fid]["breakdown"]["area_demand_penalty_minutes"] ==             before[fid]["breakdown"]["area_demand_penalty_minutes"]
    # 달라지는 것은 붐빔 판정 하나 — '추정 · 매우 혼잡' 인 c-1 은 1위를 잃는다(실측 0.9 이상과 같은 규칙).
    assert after["c-1"]["breakdown"]["ranking_congestion"] == pytest.approx(0.95)
    assert [i["facility"]["id"] for i in estimated][-1] == "c-1"
    # 한산 추정은 올려 주지 않는다 — 같은 등급 안의 점수 순서는 그대로다.
    assert [i for i in [i["facility"]["id"] for i in estimated] if i != "c-1"] ==         [i for i in [i["facility"]["id"] for i in baseline] if i != "c-1"]

    # 근거 없음 → 추정. congestion_source/level 은 'none'/None 그대로다(구 번들 보호).
    assert after["c-1"]["congestion_source"] == "none"
    assert after["c-1"]["congestion_level"] is None
    assert after["c-1"]["congestion_estimate"]["level"] == 0.95
    assert after["c-1"]["congestion_estimate"]["source"] == "estimated"
    # 추정은 인원수를 만들지 않는다.
    assert after["c-1"]["facility"]["current_count"] is None
    assert after["c-1"]["congestion_is_current"] is False  # 근거가 없으면 '지금' 도 없다

    # **단건 제보는 신선한 추정을 덮지 않는다**(2026-09-20 결정). 관측은 응답에서 지워지지 않고
    # (source/level 그대로), is_current=False 로 '마지막 관측' 자리로 내려간다.
    assert after["c-3"]["congestion_source"] == "measured"
    assert after["c-3"]["congestion_level"] == pytest.approx(0.3)
    assert after["c-3"]["congestion_is_current"] is False
    assert after["c-3"]["congestion_estimate"]["level"] == pytest.approx(0.6)
    # 그래도 순위는 예전과 같다: 0.6 은 붐빔 컷오프(0.9) 아래라 아무도 강등되지 않고,
    # 단건 제보는 애초에 measured_rules 가 아니었다(rankable_measured_level 이 막는다).
    assert after["c-3"]["breakdown"]["ranking_congestion"] == pytest.approx(0.6)
    assert after["c-3"]["scoring_mode"] == "area_stats_rules"
    assert after["c-3"]["spot_score"] == before["c-3"]["spot_score"]
    # 대기 분·인원은 추정이 만들지 않는다.
    assert after["c-3"]["breakdown"]["wait_time"] is None
    assert after["c-3"]["facility"]["current_count"] is None


def test_main_recommendations_carry_the_estimate_too(auth_client, estimates_for):  # noqa: F811
    from test_routers import ORIGIN_ROW, _reco_body

    estimates_for({"c-1": 0.4, "orig-1": 0.9})
    cafes = [_facility("c-1", "cafe", 0.0002)]
    with patch("app.routers.recommendations.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.recommendations.fetch_facility", new=AsyncMock(return_value=ORIGIN_ROW)), \
         patch("app.routers.recommendations.fetch_all_facilities", new=AsyncMock(return_value=[ORIGIN_ROW] + cafes)), \
         patch("app.routers.recommendations.fetch_congestion_map", new=AsyncMock(return_value={})), \
         patch("app.routers.recommendations.get_model_info", return_value={"trained": False}), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)), \
         patch("app.routers.recommendations.generate_reason_with_source", new=AsyncMock(return_value=("사유", "template"))), \
         patch("app.routers.recommendations.supabase_client", new=FakeSupabase({"recommendations": [{"id": "rec-1"}]})):
        res = auth_client.post("/api/v1/recommendations", json=_reco_body())

    assert res.status_code == 200, res.text
    item = res.json()[0]
    assert item["congestion_source"] == "none"
    assert item["congestion_is_current"] is False
    assert item["congestion_estimate"]["level"] == 0.4
    # 보정 흔적은 추천 응답에도 실린다(같은 CongestionEstimate 모델).
    assert item["congestion_estimate"]["calibrated"] is False
    assert item["congestion_estimate"]["raw_level"] == 0.4
    assert item["congestion_estimate"]["calibration_basis"]
    # 출발지(orig-1)의 추정 0.9 는 재배치 기여(incentive_relief)의 기준선이 되지 않는다 —
    # 그러면 추정이 인센티브 항으로 순위에 들어간다.
    assert item["breakdown"]["incentive_relief"] is None


def test_stale_measurement_keeps_its_place_but_not_the_now_slot(auth_client, estimates_for):  # noqa: F811
    """프로덕션 상태 재현: 한 달 된 단건 제보 한 건 + 방금 만든 추정.

    기대: 추정이 '지금' 이 되고, 관측은 **응답에서 사라지지 않는다**(level/source/timestamp 그대로 +
    is_current=False). 사유 문장은 한 달 전 값으로 혼잡을 주장하지 않는다.
    """
    from test_routers import ORIGIN_ROW, _reco_body

    estimates_for({"c-1": 0.35})
    cafes = [_facility("c-1", "cafe", 0.0002)]
    month_old_ts = (_FROZEN_UTC - timedelta(days=30)).isoformat()
    congestion = {"c-1": {
        **_cong(0.95, source="user_report", is_stale=True),
        "evidence_tier": "single_report", "timestamp": month_old_ts,
    }}

    with patch("app.routers.recommendations.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.recommendations.fetch_facility", new=AsyncMock(return_value=ORIGIN_ROW)), \
         patch("app.routers.recommendations.fetch_all_facilities", new=AsyncMock(return_value=[ORIGIN_ROW] + cafes)), \
         patch("app.routers.recommendations.fetch_congestion_map", new=AsyncMock(return_value=congestion)), \
         patch("app.routers.recommendations.get_model_info", return_value={"trained": False}), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)), \
         patch("app.routers.recommendations.supabase_client", new=FakeSupabase({"recommendations": [{"id": "rec-1"}]})):
        res = auth_client.post("/api/v1/recommendations", json=_reco_body())

    assert res.status_code == 200, res.text
    item = res.json()[0]
    # 관측은 그대로 실려 나간다 — 화면이 '마지막 관측' 으로 그릴 재료(값·시각·출처)가 전부 있다.
    assert item["congestion_source"] == "measured"
    assert item["congestion_level"] == pytest.approx(0.95)
    assert item["congestion_timestamp"] == month_old_ts
    assert item["congestion_log_source"] == "user_report"
    assert item["congestion_is_stale"] is True
    # 다만 '지금' 은 아니고, 그 자리는 신선한 추정이 가져간다.
    assert item["congestion_is_current"] is False
    assert item["congestion_estimate"]["level"] == pytest.approx(0.35)
    # 한 달 전 값으로 "혼잡도 95%" 를 사실처럼 적지 않는다(배지와 문장이 다른 말을 하지 않게).
    assert "95" not in (item["reason"] or "")
    # 추정은 대기 분·인원을 만들지 않고, 순위 등급도 실측으로 올리지 않는다.
    assert item["breakdown"]["wait_time"] is None
    assert item["scoring_mode"] != "measured_rules"
    assert item["facility"]["current_count"] is None


# =========================================================================
# 코스 — '지금' 관측은 가까운 도착에만
# =========================================================================

def _degraded(monkeypatch):
    from app.services import predict_service

    monkeypatch.setattr(predict_service, "get_snapshot", lambda: None)
    monkeypatch.setattr("app.routers.courses.predict_congestion", predict_service.predict_congestion)


def test_course_puts_the_estimate_on_the_near_stop_only(auth_client, monkeypatch, estimates_for):  # noqa: F811
    _degraded(monkeypatch)
    cafe = _facility("cafe-1", "cafe", 0.0002)
    attraction = _facility("attr-1", "attraction", 0.0010)
    spare_cafe = _facility("cafe-2", "cafe", 0.0003)
    estimates_for({"cafe-1": 0.5, "attr-1": 0.6, "cafe-2": 0.3})

    with patch("app.routers.courses.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.courses.fetch_all_facilities", new=AsyncMock(return_value=[cafe, attraction, spare_cafe])), \
         patch("app.routers.courses.fetch_congestion_map", new=AsyncMock(return_value={})), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)):
        res = auth_client.post("/api/v1/courses/plan", json={
            "user_id": AUTH_USER_ID, "user_lat": BASE_LAT, "user_lng": BASE_LNG,
            "sequence": ["cafe", "attraction"],
        })

    assert res.status_code == 200, res.text
    first, second = res.json()["stops"]
    # 1번: 몇 분 뒤 도착 — 관측 후 30분 안이라 '지금' 추정을 보여 준다.
    assert first["predicted_congestion"] is None
    assert first["congestion_estimate"]["source"] == "estimated"
    # 1번의 '다른 곳' 도 같은 규칙으로 붙는다(갈아끼우면 그 값 그대로 보여야 한다).
    assert all(alt["congestion_estimate"] is not None for alt in first["alternatives"])
    # 2번: 카페 체류(40분) 뒤 도착 — '지금' 주차를 도착 값처럼 보이게 하지 않는다.
    assert second["arrival_offset_min"] > 30
    assert second["congestion_estimate"] is None
    # 사유 문장은 추정 수치를 말하지 않는다(추정은 배지로만 — 문장은 예측·실측의 자리다).
    assert "%" not in first["reason"]
    assert first["facility"]["current_count"] is None


def test_course_stale_measurement_does_not_hide_the_estimate(auth_client, monkeypatch, estimates_for):  # noqa: F811
    """세 번째 경로(코스)도 같은 우선순위를 쓴다 — 판정이 한 곳(attach_estimate)에만 있기 때문이다.

    한 달 된 단건 제보를 들고 있는 시설이어도 코스 정류지는 신선한 추정을 보여 준다. 코스 화면은
    실측 숫자를 그리지 않으므로(정류지 숫자는 '도착 시점' 예측이다) 여기서 가려지는 관측도 없다.
    """
    _degraded(monkeypatch)
    cafe = _facility("cafe-1", "cafe", 0.0002)
    attraction = _facility("attr-1", "attraction", 0.0010)
    spare_cafe = _facility("cafe-2", "cafe", 0.0003)
    estimates_for({"cafe-1": 0.5, "attr-1": 0.6, "cafe-2": 0.3})
    # 2026-08-21 제보 한 건 — 프로덕션에서 실제로 한 시설이 들고 있던 상태.
    month_old = {"cafe-1": {
        **_cong(0.95, source="user_report", is_stale=True),
        "evidence_tier": "single_report",
        "timestamp": (_FROZEN_UTC - timedelta(days=30)).isoformat(),
    }}

    with patch("app.routers.courses.fetch_user", new=AsyncMock(return_value=USER_ROW)), \
         patch("app.routers.courses.fetch_all_facilities", new=AsyncMock(return_value=[cafe, attraction, spare_cafe])), \
         patch("app.routers.courses.fetch_congestion_map", new=AsyncMock(return_value=month_old)), \
         patch.object(preference_vector_service, "get_user_vector", new=AsyncMock(return_value=UNIT_VECTOR)):
        res = auth_client.post("/api/v1/courses/plan", json={
            "user_id": AUTH_USER_ID, "user_lat": BASE_LAT, "user_lng": BASE_LNG,
            "sequence": ["cafe", "attraction"],
        })

    assert res.status_code == 200, res.text
    first = res.json()["stops"][0]
    assert first["facility"]["id"] == "cafe-1"
    assert first["congestion_estimate"]["level"] == pytest.approx(0.5)
    # 한 달 된 0.95 는 순위에도 닿지 않는다(rankable_measured_level 이 같은 30분 선을 쓴다).
    assert first["predicted_congestion"] is None
    assert "%" not in first["reason"]
