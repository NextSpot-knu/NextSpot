# 추정기 × 서울 보정(docs/CONGESTION_ENGINE_PLAN.md §5.3-6, D5) — 켜지기 전/후의 경계.
#
# 오늘(서울 수집 시작 전)의 정답은 "아무것도 달라지지 않는다" 다. 이 파일이 그것을 잠그고,
# 관문을 넘은 뒤에 무엇이 달라지는지(값 · 원값 보존 · 근거 문자열)도 같이 잠근다.

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from app.services import congestion_calibration_service as cal
from app.services import congestion_estimator_service as est
from app.services.parking_derived_congestion_service import ParkingLot

_LAT, _LNG = 35.8325, 129.2125
NOW = datetime(2026, 9, 20, 5, 0, tzinfo=timezone.utc)

# y = x² 를 배운 모양의 곡선. 0.65 → 0.42 근처로 내려간다.
_CURVE = cal.Curve(
    knots=(cal.Knot(0.2, 0.04), cal.Knot(0.5, 0.25), cal.Knot(0.8, 0.64)),
    fitted_at=NOW.isoformat(),
    sample_count=360,
)
_APPLIED = cal.CalibrationState(
    applied=True,
    state=cal.STATE_READY,
    curve=_CURVE,
    days=6,
    paired_buckets=360,
    basis="서울 실측으로 보정(명동·동대문, 6일 · 360표본)",
    reason=None,
)


def _lot(occupancy: float, *, lot_id="L1", total=100) -> ParkingLot:
    return ParkingLot(
        lot_id=lot_id, name=lot_id, latitude=_LAT, longitude=_LNG,
        total_spaces=total, available_spaces=round(total * (1.0 - occupancy)),
    )


def _facility(fid: str, name: str, *, rate: float | None = None) -> dict:
    row = {"id": fid, "name": name, "type": "attraction", "latitude": _LAT, "longitude": _LNG}
    if rate is not None:
        row["tourapi_concentration_rate"] = rate
    return row


# ── 적용 전: 값이 하나도 바뀌지 않는다 ───────────────────────────────────────


@pytest.mark.parametrize(
    "state",
    [
        None,
        cal.IDENTITY,
        cal._identity_state(cal.STATE_INSUFFICIENT, "홀드아웃에서 항등보다 낫지 않다"),
    ],
)
def test_without_an_applied_curve_the_value_is_untouched(state):
    out = est.estimate_facilities([_lot(0.5)], [_facility("f1", "월정교", rate=100)], calibration_state=state)

    estimate = out["f1"]
    assert estimate["level"] == pytest.approx(0.65), "0.7·0.5 + 0.3·1.0 — 보정 전 값 그대로"
    assert estimate["raw_level"] == estimate["level"]
    assert estimate["calibrated"] is False


def test_identity_state_apply_is_the_identity():
    assert cal.IDENTITY.apply(0.77) == pytest.approx(0.77)
    assert cal.IDENTITY.apply(None) is None


# ── 적용 후: 값은 바뀌고 원값은 남는다 ───────────────────────────────────────


def test_applied_curve_changes_the_level_and_keeps_the_raw_one():
    out = est.estimate_facilities([_lot(0.5)], [_facility("f1", "월정교", rate=100)], calibration_state=_APPLIED)

    estimate = out["f1"]
    assert estimate["raw_level"] == pytest.approx(0.65), "원값은 절대 버리지 않는다"
    assert estimate["level"] == pytest.approx(_CURVE.apply(0.65))
    assert estimate["level"] < estimate["raw_level"]
    assert estimate["calibrated"] is True
    # 주차·관광 성분은 **보정 전** 입력 그대로다 — 근거를 되짚을 수 있어야 한다.
    assert estimate["parking_level"] == pytest.approx(0.5)
    assert estimate["tourism_level"] == pytest.approx(1.0)


def test_calibration_never_reverses_the_order_between_facilities():
    facilities = [_facility("busy", "월정교", rate=100), _facility("calm", "교촌마을", rate=0)]
    out = est.estimate_facilities([_lot(0.8)], facilities, calibration_state=_APPLIED)

    assert out["busy"]["raw_level"] > out["calm"]["raw_level"]
    assert out["busy"]["level"] >= out["calm"]["level"], "단조 곡선은 순위를 뒤집지 않는다"


# ── 근거(evidence) ───────────────────────────────────────────────────────────


def _current(state: cal.CalibrationState, lots, facilities) -> dict:
    return {
        "available": True,
        "reason": None,
        "observed_at": NOW.isoformat(),
        "bucket_at": NOW.isoformat(),
        "lot_count": len(lots),
        "estimates": est.estimate_facilities(lots, facilities, calibration_state=state),
        "calibration": state.to_dict(),
    }


def test_evidence_carries_the_provenance_when_calibrated():
    current = _current(_APPLIED, [_lot(0.5)], [_facility("f1", "월정교", rate=100)])
    evidence = est.estimate_evidence(current, "f1")

    assert evidence["source"] == est.ESTIMATE_SOURCE
    assert evidence["calibrated"] is True
    assert evidence["raw_level"] == pytest.approx(0.65)
    assert evidence["level"] < evidence["raw_level"]
    assert evidence["calibration_basis"] == "서울 실측으로 보정(명동·동대문, 6일 · 360표본)"
    # 기존 키는 그대로 — 지도·추천·코스가 이미 읽고 있다(추가만).
    assert {"level", "source", "observed_at", "parking_level", "tourism_level",
            "lot_count", "nearest_lot_m", "radius_m"} <= set(evidence)


def test_evidence_says_so_when_not_calibrated():
    current = _current(cal.IDENTITY, [_lot(0.5)], [_facility("f1", "월정교", rate=100)])
    evidence = est.estimate_evidence(current, "f1")

    assert evidence["calibrated"] is False
    assert evidence["raw_level"] == evidence["level"]
    assert evidence["calibration_basis"] == "보정 전(서울 표본 부족)"


def test_evidence_survives_a_current_without_calibration_key():
    """구 캐시(보정 키가 없던 응답)가 남아 있어도 근거 생성이 깨지지 않는다."""
    current = _current(cal.IDENTITY, [_lot(0.5)], [_facility("f1", "월정교", rate=100)])
    current.pop("calibration")
    for estimate in current["estimates"].values():
        estimate.pop("raw_level")
        estimate.pop("calibrated")
    evidence = est.estimate_evidence(current, "f1")

    assert evidence["calibrated"] is False
    assert evidence["raw_level"] == evidence["level"]
    assert evidence["calibration_basis"] == cal.BASIS_NOT_APPLIED


# ── 하루 집계 ────────────────────────────────────────────────────────────────


def _snapshot(sid: str, bucket: datetime, lots) -> est.Snapshot:
    return est.Snapshot(snapshot_id=sid, bucket_at=bucket, observed_at=bucket, lots=tuple(lots))


def _day_inputs():
    facilities = [_facility("hot", "월정교", rate=100), _facility("calm", "교촌마을", rate=0)]
    forecasts = [
        {"tourist_attraction_name": "월정교", "concentration_rate": 100},
        {"tourist_attraction_name": "교촌마을", "concentration_rate": 0},
    ]
    snapshots = [
        _snapshot(f"s{i}", NOW + timedelta(minutes=10 * i), [_lot(0.8)]) for i in range(3)
    ]
    return snapshots, facilities, forecasts


def test_day_aggregate_applies_the_same_curve_and_records_it():
    snapshots, facilities, forecasts = _day_inputs()
    plain = est.aggregate_estimated_day(snapshots, facilities, forecasts)
    tuned = est.aggregate_estimated_day(snapshots, facilities, forecasts, calibration_state=_APPLIED)

    assert plain["basis"]["calibration"]["applied"] is False
    assert plain["basis"]["calibration"]["basis"] == cal.BASIS_NOT_APPLIED
    assert tuned["basis"]["calibration"]["applied"] is True
    assert tuned["basis"]["calibration"]["places"] == list(cal.CALIBRATION_PLACES)
    assert tuned["avgCongestion"]["value"] < plain["avgCongestion"]["value"]
    assert tuned["sampleCount"] == plain["sampleCount"], "표본 수는 보정과 무관하다"


# ── 공개 경로: 실패는 무해하다 ───────────────────────────────────────────────


def _install_snapshot(monkeypatch, state_or_error):
    snapshot = _snapshot("s1", NOW, [_lot(0.5)])
    monkeypatch.setattr(est, "_load_latest_snapshot", lambda: snapshot)
    monkeypatch.setattr(
        est, "_facilities_for_date", lambda date_iso: ([_facility("f1", "월정교", rate=100)], [])
    )

    def _calibration():
        if isinstance(state_or_error, Exception):
            raise state_or_error
        return state_or_error

    monkeypatch.setattr(cal, "active_calibration", _calibration)


def test_current_estimates_attaches_the_calibration_block(monkeypatch):
    _install_snapshot(monkeypatch, _APPLIED)
    est.reset_caches()
    try:
        current = asyncio.run(est._compute_current(NOW))
    finally:
        est.reset_caches()

    assert current["available"] is True
    assert current["calibration"]["applied"] is True
    assert current["estimates"]["f1"]["calibrated"] is True


def test_a_failing_calibration_falls_back_to_identity_without_raising(monkeypatch):
    _install_snapshot(monkeypatch, RuntimeError("보정 모듈 폭발"))
    est.reset_caches()
    try:
        current = asyncio.run(est._compute_current(NOW))
    finally:
        est.reset_caches()

    assert current["available"] is True, "보정 실패가 추정 전체를 지우면 안 된다"
    assert current["calibration"]["applied"] is False
    assert current["estimates"]["f1"]["level"] == pytest.approx(0.65)
    assert current["estimates"]["f1"]["calibrated"] is False


def test_empty_current_still_reports_the_calibration_state():
    empty = est._empty_current("no_parking_snapshot")
    assert empty["calibration"]["applied"] is False
