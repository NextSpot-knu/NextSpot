# 경주 추정 모드(congestion_estimator_service)의 순수 함수 — 산식·표본 단위·KST 시간축을 잠근다.
#
# 이 값은 관리자 대시보드에 '추정' 라벨과 함께 그대로 그려진다. 여기서 잠그는 것:
#   · 주차 성분이 없으면 값을 **만들지 않는다**(관광 통계만으로 '지금' 을 지어내지 않는다).
#   · 주차 반경 밖 시설은 결과에 키 자체가 없다(0 으로 채우지 않는다).
#   · 하루 집계가 실측 집계(admin._aggregate_congestion_day)와 같은 모양·같은 기준(표본 5, 이상 0.9)이다.
#   · 히트맵의 시(hour)는 UTC 가 아니라 KST 다 — 한 칸 어긋나면 오후 피크가 새벽에 그려진다.
import asyncio
from datetime import datetime, timezone

import pytest

from app.services import congestion_estimator_service as est
from app.services.parking_derived_congestion_service import RADIUS_M, ParkingLot

# conftest 의 autouse 픽스처가 모듈 속성을 '추정 없음' 스텁으로 바꾼다. 캐시 자체를 시험하는
# 테스트는 실물이 필요하므로 **수집 시점(픽스처 이전)** 에 원본을 잡아 둔다.
_REAL_ESTIMATED_DAY_AGGREGATE = est.estimated_day_aggregate

# 황리단길 부근. 주차장과 시설을 같은 점 근처에 두어 반경(2km) 안에 확실히 들어오게 한다.
_LAT, _LNG = 35.8325, 129.2125  # 격자(0.005°) 칸의 한가운데 — ±0.0002 이동이 칸을 넘지 않는다
# 약 70km 북쪽 — 반경 밖.
_FAR_LAT = 36.5


def _lot(occupancy: float, *, lot_id: str = "L1", total: int = 100, lat: float = _LAT, lng: float = _LNG) -> ParkingLot:
    available = round(total * (1.0 - occupancy))
    return ParkingLot(lot_id=lot_id, name=lot_id, latitude=lat, longitude=lng, total_spaces=total, available_spaces=available)


def _facility(fid: str, name: str, *, rate: float | None, ftype: str = "attraction", lat: float = _LAT, lng: float = _LNG) -> dict:
    row = {"id": fid, "name": name, "type": ftype, "latitude": lat, "longitude": lng}
    if rate is not None:
        row["tourapi_concentration_rate"] = rate
    return row


def _snapshot(sid: str, bucket_iso: str, lots: list[ParkingLot]) -> est.Snapshot:
    at = datetime.fromisoformat(bucket_iso)
    return est.Snapshot(snapshot_id=sid, bucket_at=at, observed_at=at, lots=tuple(lots))


# ── blend_level ──────────────────────────────────────────────────────────────


def test_blend_level_without_parking_makes_no_value():
    """관광 통계만으로는 하루 한 숫자라 '지금' 을 말할 수 없다 — None."""
    assert est.blend_level(None, 0.9) is None
    assert est.blend_level(None, None) is None


def test_blend_level_weights_and_clamp():
    assert est.PARKING_WEIGHT == pytest.approx(0.7)
    assert est.TOURISM_WEIGHT == pytest.approx(0.3)
    assert est.blend_level(0.5, 1.0) == pytest.approx(0.65)
    assert est.blend_level(1.0, 0.0) == pytest.approx(0.7)
    # 관광 성분이 없으면 주차 성분 그대로(가중치를 0 으로 끌어내리지 않는다).
    assert est.blend_level(0.42, None) == pytest.approx(0.42)
    # 범위 밖 입력은 0~1 로 자른다.
    assert est.blend_level(1.5, 1.0) == 1.0
    assert est.blend_level(-0.2, None) == 0.0
    # 소수 4자리.
    assert est.blend_level(0.123456, None) == 0.1235


def test_facility_tourism_level_reads_the_attached_prior():
    assert est.facility_tourism_level({"tourapi_concentration_rate": 80}) == pytest.approx(0.8)
    assert est.facility_tourism_level({"tourapi_concentration_rate": 150}) == 1.0
    assert est.facility_tourism_level({"tourapi_concentration_rate": None}) is None
    assert est.facility_tourism_level({}) is None


# ── estimate_facilities ──────────────────────────────────────────────────────


def test_estimate_facilities_skips_everything_outside_the_parking_radius():
    facilities = [
        _facility("near", "월정교", rate=100),
        _facility("far", "먼 관광지", rate=100, lat=_FAR_LAT),
        _facility("nocoord", "좌표 없음", rate=100, lat=None),  # type: ignore[arg-type]
        {"id": "", "name": "id 없음", "type": "attraction", "latitude": _LAT, "longitude": _LNG},
    ]
    out = est.estimate_facilities([_lot(0.5)], facilities)

    assert set(out) == {"near"}, "반경 밖·좌표 없음·id 없음은 키 자체가 없어야 한다(0 으로 채우지 않는다)"
    near = out["near"]
    assert near["parking_level"] == pytest.approx(0.5)
    assert near["tourism_level"] == pytest.approx(1.0)
    assert near["level"] == pytest.approx(0.65)
    assert near["lot_count"] == 1
    assert near["nearest_lot_m"] is not None and near["nearest_lot_m"] < RADIUS_M


def test_estimate_facilities_shares_parking_per_grid_cell_but_not_tourism():
    """같은 격자 칸의 시설은 주차 성분이 같다(원본 4곳에 없는 해상도를 주장하지 않는다)."""
    facilities = [
        _facility("a", "A", rate=100),
        _facility("b", "B", rate=0, lng=_LNG + 0.0001),
        _facility("c", "C", rate=None, lng=_LNG + 0.0002),
    ]
    out = est.estimate_facilities([_lot(1.0)], facilities)

    assert out["a"]["zone"] == out["b"]["zone"] == out["c"]["zone"]
    assert out["a"]["parking_level"] == out["b"]["parking_level"] == out["c"]["parking_level"] == pytest.approx(1.0)
    assert out["a"]["level"] == pytest.approx(1.0)
    assert out["b"]["level"] == pytest.approx(0.7)
    assert out["c"]["tourism_level"] is None
    assert out["c"]["level"] == pytest.approx(1.0)


def test_estimate_facilities_without_lots_is_empty():
    assert est.estimate_facilities([], [_facility("a", "A", rate=50)]) == {}


# ── representative_places ────────────────────────────────────────────────────


def test_representative_places_are_one_to_one_tourism_matches_sorted_by_rate():
    facilities = [
        _facility("f1", "교촌마을", rate=None),
        _facility("f2", "월정교", rate=None),
        _facility("f3", "황남빵", rate=None, ftype="restaurant"),  # 관광 앵커 유형이 아니다
        _facility("f4", "첨성대", rate=None),
        _facility("f5", "첨성대", rate=None),  # 이름 충돌 — 1:1 이 아니면 버린다
    ]
    forecasts = [
        {"tourist_attraction_name": "교촌마을", "concentration_rate": 40},
        {"tourist_attraction_name": "월정교", "concentration_rate": 90},
        {"tourist_attraction_name": "황남빵", "concentration_rate": 99},
        {"tourist_attraction_name": "첨성대", "concentration_rate": 95},
    ]
    places = est.representative_places(facilities, forecasts)

    assert [p["id"] for p in places] == ["f2", "f1"]
    assert places[0]["_rate"] == 90
    # 원본 시설 행을 바꾸지 않는다(사본에 _rate 를 붙인다).
    assert "_rate" not in facilities[1]


# ── aggregate_estimated_day ──────────────────────────────────────────────────

# KST 시간축 — 버킷 시각(UTC) → KST 시.
_S1 = "2026-09-19T23:00:00+00:00"  # KST 09-20 08:00
_S2 = "2026-09-20T05:00:00+00:00"  # KST 09-20 14:00
_S3 = "2026-09-20T14:50:00+00:00"  # KST 09-20 23:50


def _day_inputs():
    facilities = [
        _facility("hot", "월정교", rate=100),
        _facility("calm", "교촌마을", rate=0),
        _facility("cafe", "근처 카페", rate=None, ftype="cafe"),  # 추정은 되지만 대표 장소는 아니다
        _facility("far", "먼 관광지", rate=100, lat=_FAR_LAT),  # 대표 후보지만 반경 밖
    ]
    forecasts = [
        {"tourist_attraction_name": "월정교", "concentration_rate": 100},
        {"tourist_attraction_name": "교촌마을", "concentration_rate": 0},
        {"tourist_attraction_name": "먼 관광지", "concentration_rate": 100},
    ]
    snapshots = [
        _snapshot("s1", _S1, [_lot(1.0)]),
        _snapshot("s2", _S2, [_lot(0.5), _lot(0.5, lot_id="L2", lng=_LNG + 0.001)]),
        _snapshot("s3", _S3, [_lot(1.0)]),
    ]
    return snapshots, facilities, forecasts


def test_aggregate_day_counts_anomalies_per_place_and_bucket():
    snapshots, facilities, forecasts = _day_inputs()
    day = est.aggregate_estimated_day(snapshots, facilities, forecasts)

    assert day["hasLogs"] is True
    # 표본 = (대표 장소 2곳 × 버킷 3개). 카페는 추정 대상이지만 대표 장소가 아니고, 먼 관광지는 반경 밖.
    assert day["sampleCount"] == 6
    assert day["sourceComposition"] == {"estimated": 6}
    # 월정교: 1.0, 0.65, 1.0 / 교촌마을: 0.7, 0.35, 0.7 → 평균 4.4/6
    assert day["avgCongestion"]["value"] == pytest.approx(0.73)
    # 이상(>= 0.9)은 월정교의 두 버킷뿐.
    assert day["anomalyCount"] == 2
    assert len(day["anomalies"]) == 1, "이상 알림은 장소별 최고 1건"
    alert = day["anomalies"][0]
    assert alert["facilityName"] == "월정교"
    assert alert["congestionLevel"] == pytest.approx(1.0)
    assert alert["durationMinutes"] == 10
    assert alert["timestamp"] == datetime.fromisoformat(_S1).isoformat(), "같은 최고값이면 먼저 온 버킷"


def test_aggregate_day_heatmap_hours_are_kst():
    snapshots, facilities, forecasts = _day_inputs()
    heatmap = est.aggregate_estimated_day(snapshots, facilities, forecasts)["heatmap"]

    assert len(heatmap) == 2 * 24
    assert [c["facility"] for c in heatmap[:24]] == ["월정교"] * 24, "관광 집중률 높은 장소가 먼저"
    hot = {c["hour"]: c["value"] for c in heatmap if c["facility"] == "월정교"}
    calm = {c["hour"]: c["value"] for c in heatmap if c["facility"] == "교촌마을"}
    assert hot[8] == pytest.approx(1.0)   # 23:00Z → KST 08시
    assert hot[14] == pytest.approx(0.65)  # 05:00Z → KST 14시
    assert hot[23] == pytest.approx(1.0)  # 14:50Z → KST 23시
    assert calm[14] == pytest.approx(0.35)
    # 관측 없는 시간은 null 센티넬(실측 0 과 구분) — 화면이 '아직 오지 않은 시간' 을 그릴 근거.
    assert hot[23 - 1] is None and hot[0] is None
    assert sum(1 for v in hot.values() if v is not None) == 3
    assert {c["facilityType"] for c in heatmap} == {"attraction"}


def test_aggregate_day_basis_describes_the_inputs():
    snapshots, facilities, forecasts = _day_inputs()
    basis = est.aggregate_estimated_day(snapshots, facilities, forecasts)["basis"]

    assert basis["method"] == "parking_its+tourism_concentration"
    assert basis["weights"] == {"parking": pytest.approx(0.7), "tourism": pytest.approx(0.3)}
    assert basis["radiusM"] == 2000
    assert basis["snapshotCount"] == 3
    assert basis["lotCountMax"] == 2
    assert basis["placeCount"] == 2
    assert basis["estimatedFacilityCount"] == 3, "반경 안 시설 전부(카페 포함) — 먼 관광지는 빠진다"
    assert basis["facilityCount"] == 4
    assert basis["latestObservedAt"] == datetime.fromisoformat(_S3).isoformat()


def test_aggregate_day_change_against_previous_day():
    snapshots, facilities, forecasts = _day_inputs()

    compared = est.aggregate_estimated_day(snapshots, facilities, forecasts, prev_avg=0.5, prev_samples=1440)
    assert compared["avgCongestion"]["changePercentOrNull"] == pytest.approx(46.0)
    assert compared["avgCongestion"]["changePercent"] == pytest.approx(46.0)
    assert compared["avgCongestion"]["prevSampleCount"] == 1440

    # 전일이 없으면 '변화 없음(0)' 이 아니라 '비교 불가(null)' — 구 키만 0.0 을 유지한다.
    for prev in (None, 0.0):
        alone = est.aggregate_estimated_day(snapshots, facilities, forecasts, prev_avg=prev)
        assert alone["avgCongestion"]["changePercentOrNull"] is None
        assert alone["avgCongestion"]["changePercent"] == 0.0


def test_aggregate_day_below_five_samples_is_not_a_day():
    """실측 집계와 같은 최소 표본(5). 모자라면 hasLogs=false 와 null — 0 으로 채우지 않는다."""
    _snapshots, facilities, forecasts = _day_inputs()
    thin = [_snapshot("s1", _S1, [_lot(1.0)]), _snapshot("s2", _S2, [_lot(0.5)])]  # 2곳 × 2버킷 = 4
    day = est.aggregate_estimated_day(thin, facilities, forecasts)

    assert day["hasLogs"] is False
    assert day["sampleCount"] == 4
    assert day["avgCongestion"] is None
    assert day["anomalyCount"] is None
    assert day["heatmap"] is None
    assert day["anomalies"] is None
    assert day["sourceComposition"] == {"estimated": 4}
    assert day["basis"]["snapshotCount"] == 2


def test_aggregate_day_without_snapshots_says_so():
    _snapshots, facilities, forecasts = _day_inputs()
    day = est.aggregate_estimated_day([], facilities, forecasts)

    assert day["hasLogs"] is False
    assert day["sampleCount"] == 0
    assert day["sourceComposition"] == {}
    assert day["basis"]["latestObservedAt"] is None
    assert day["basis"]["lotCountMax"] == 0
    assert day["basis"]["placeCount"] == 0


def test_aggregate_day_caps_heatmap_places():
    places = [_facility(f"p{i:02d}", f"관광지{i:02d}", rate=i) for i in range(est.HEATMAP_PLACE_CAP + 3)]
    forecasts = [{"tourist_attraction_name": p["name"], "concentration_rate": p["tourapi_concentration_rate"]} for p in places]
    day = est.aggregate_estimated_day([_snapshot("s1", _S1, [_lot(0.4)])], places, forecasts)

    assert day["basis"]["placeCount"] == est.HEATMAP_PLACE_CAP
    assert len(day["heatmap"]) == est.HEATMAP_PLACE_CAP * 24
    # 집중률 높은 순으로 자른다 — 가장 낮은 세 곳이 빠진다.
    assert "관광지00" not in {c["facility"] for c in day["heatmap"]}


# ── DB 행 → 스냅샷(순수 변환) ────────────────────────────────────────────────


def test_snapshots_from_rows_drops_invalid_lots_and_sorts():
    parents = [
        {"id": "b", "bucket_at": "2026-09-20T01:10:00Z", "observed_at": "2026-09-20T01:12:00Z"},
        {"id": "a", "bucket_at": "2026-09-20T01:00:00", "observed_at": "2026-09-20T01:02:00+00:00"},
        {"id": "empty", "bucket_at": "2026-09-20T01:20:00Z", "observed_at": "2026-09-20T01:22:00Z"},
        {"id": "bad", "bucket_at": "not-a-date", "observed_at": "2026-09-20T01:22:00Z"},
    ]

    def lot_row(sid, total, available, lot="L1"):
        return {
            "snapshot_id": sid, "source_lot_id": lot, "name": lot, "latitude": _LAT, "longitude": _LNG,
            "total_spaces": total, "available_spaces": available,
        }

    rows = [
        lot_row("a", 100, 20),
        lot_row("b", 100, 50),
        lot_row("b", 0, 0, lot="zero"),        # 정원 0 — 점유율을 낼 수 없다
        lot_row("b", 100, 120, lot="over"),    # 잔여 > 정원 — 원본 오류
        lot_row("bad", 100, 10),
        {"snapshot_id": "a", "source_lot_id": "x"},  # 필수 칼럼 누락
    ]
    snapshots = est._snapshots_from_rows(parents, rows)

    assert [s.snapshot_id for s in snapshots] == ["a", "b"], "lot 없는 스냅샷·날짜 불량은 버리고 시간순"
    assert snapshots[0].bucket_at.tzinfo is not None, "나이브 시각은 UTC 로 간주한다"
    assert [lot.lot_id for lot in snapshots[1].lots] == ["L1"]


def test_day_bounds_are_the_kst_day_in_utc():
    start, end = est._day_bounds_kst("2026-09-20")
    assert datetime.fromisoformat(start) == datetime(2026, 9, 19, 15, 0, tzinfo=timezone.utc)
    assert datetime.fromisoformat(end) == datetime(2026, 9, 20, 14, 59, 59, 999000, tzinfo=timezone.utc)


# ── 공개 API: 날짜 캐시 ──────────────────────────────────────────────────────


def test_estimated_day_aggregate_caches_per_date(monkeypatch):
    est.reset_caches()
    calls: list[str] = []

    def _fake_sync(date_kst, *, with_prev):
        calls.append(date_kst)
        assert with_prev is True
        return {"dateKst": date_kst, "hasLogs": False}

    monkeypatch.setattr(est, "_estimated_day_sync", _fake_sync)
    monkeypatch.setattr(est, "estimated_day_aggregate", _REAL_ESTIMATED_DAY_AGGREGATE)
    now = datetime(2026, 9, 20, 3, 0, tzinfo=timezone.utc)
    try:
        first = asyncio.run(est.estimated_day_aggregate("2026-09-20", now=now))
        second = asyncio.run(est.estimated_day_aggregate("2026-09-20", now=now))
        asyncio.run(est.estimated_day_aggregate("2026-09-19", now=now))
    finally:
        est.reset_caches()

    assert first == second == {"dateKst": "2026-09-20", "hasLogs": False}
    assert calls == ["2026-09-20", "2026-09-19"], "같은 날짜는 TTL 동안 다시 계산하지 않는다"
