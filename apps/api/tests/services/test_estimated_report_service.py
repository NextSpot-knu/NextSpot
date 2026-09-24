# 여러 날 **추정** 집계(리포트 화면의 7/30일 추이) — estimated_report_service 계약.
#
# 여기서 잠그는 것:
#   1) **하루 경로와 같은 숫자.** 이 모듈은 속도를 위해 (격자·업종·관광기준선) 그룹으로 접고
#      격자-주차장 거리를 기간 동안 한 번만 잰다. 그 두 지름길이 `congestion_estimator_service`
#      의 `estimate_facilities` / `parking_derived_congestion_service.cell_demand_level` 과
#      **같은 값**을 내는지가 이 파일의 첫 번째 일이다 — 갈라지면 같은 데이터가 대시보드와
#      리포트에서 다른 이야기를 한다.
#   2) KST 날짜 버킷팅. UTC 15:00 은 이미 다음 날이다.
#   3) 요청한 날짜가 **전부** 결과에 들어간다(원본 없는 날은 avgCongestion=None — 0 이 아니다).
#   4) 표본 간격(30분)이 실제로 버킷을 솎는다.
#   5) 날짜별 캐시: 지난 날은 다시 계산하지 않고, 오늘만 다시 읽는다.
import random
from datetime import datetime, timedelta, timezone

import pytest

from app.services import congestion_estimator_service as estimator
from app.services import estimated_report_service as svc
from app.services.parking_derived_congestion_service import ParkingLot, cell_demand_level, grid_cell
from app.services.tourism_area_prior_service import attach_tourism_area_priors

KST = timezone(timedelta(hours=9))

# 경주 시내 근처. 실제 좌표대가 아니면 격자 인덱스가 음수/거대값이 되어 테스트가 현실과 멀어진다.
_BASE_LAT, _BASE_LNG = 35.8350, 129.2100


def _lot(lot_id: str, lat: float, lng: float, total: int, available: int) -> ParkingLot:
    return ParkingLot(lot_id=lot_id, name=lot_id, latitude=lat, longitude=lng,
                      total_spaces=total, available_spaces=available)


def _lots(available: int = 40) -> tuple[ParkingLot, ...]:
    return (
        _lot("a", _BASE_LAT, _BASE_LNG, 100, available),
        _lot("b", _BASE_LAT + 0.004, _BASE_LNG + 0.004, 200, available * 2),
    )


def _facility(fid: str, lat: float, lng: float, ftype: str, rate: float | None) -> dict:
    row = {"id": fid, "name": fid, "type": ftype, "latitude": lat, "longitude": lng}
    if rate is not None:
        row["tourapi_concentration_rate"] = rate
    return row


def _snapshot(bucket: datetime, lots: tuple[ParkingLot, ...] | None = None) -> svc.RangeSnapshot:
    return svc.RangeSnapshot(bucket, bucket, lots or _lots())


# ── 1. 하루 경로와 동치 ───────────────────────────────────────────────────────


def test_cell_weights_match_cell_demand_level():
    """빠른 경로의 주차 점유율이 `cell_demand_level` 과 **같은 값**이어야 한다.

    이 모듈은 거리를 기간 동안 한 번만 재려고 가중식을 한 벌 더 들고 있다. 그 대가가 이
    테스트다 — 어느 한쪽 식이 바뀌면 여기서 먼저 깨진다.
    """
    rng = random.Random(20260920)
    for _ in range(50):
        lots = tuple(
            _lot(f"l{i}", _BASE_LAT + rng.uniform(-0.02, 0.02), _BASE_LNG + rng.uniform(-0.02, 0.02),
                 rng.randint(20, 900), 0)
            for i in range(rng.randint(1, 5))
        )
        lots = tuple(
            _lot(lot.lot_id, lot.latitude, lot.longitude, lot.total_spaces,
                 rng.randint(0, lot.total_spaces))
            for lot in lots
        )
        cell = grid_cell(_BASE_LAT + rng.uniform(-0.03, 0.03), _BASE_LNG + rng.uniform(-0.03, 0.03))
        reference = cell_demand_level(list(lots), *svc.grid_center(cell))
        weights = svc.cell_weights(lots, cell)
        if reference is None:
            assert weights is None, "반경 안에 주차장이 없으면 빠른 경로도 값을 만들면 안 된다"
            continue
        assert weights is not None
        fast = svc.cell_parking_level([lot.occupancy for lot in lots], weights[0], weights[1])
        assert abs(fast - reference["level"]) <= 1e-4, "가중식이 갈라졌다"


def _reference(snapshots, facilities, forecasts):
    """하루 경로가 내는 (합, 개수, 이상 건수) — 시설을 **하나씩** 돈 결과.

    관광 기준선을 붙이는 방법까지 서비스와 똑같이 맞춘다(`attach_tourism_area_priors` 는
    입력의 기존 prior 키를 먼저 지운다 — 그 사실을 흉내 내지 않으면 애초에 다른 것을 비교하게 된다).
    """
    copies = [dict(row) for row in facilities]
    attach_tourism_area_priors(copies, list(forecasts))
    total = 0.0
    count = 0
    anomalies = 0
    for snapshot in snapshots:
        for value in estimator.estimate_facilities(snapshot.lots, copies).values():
            total += value["level"]
            count += 1
            if value["level"] >= estimator.ANOMALY_LEVEL:
                anomalies += 1
    return total, count, anomalies


def test_day_aggregate_matches_estimate_facilities():
    """그룹으로 접은 합·개수가 시설을 하나씩 돈 결과와 같아야 한다."""
    rng = random.Random(4242)
    facilities = [
        _facility(f"f{i}", _BASE_LAT + rng.uniform(-0.01, 0.01), _BASE_LNG + rng.uniform(-0.01, 0.01),
                  rng.choice(["restaurant", "cafe"]), None)
        for i in range(120)
    ]
    # 관광 앵커 두 곳 — 기준선이 거리 감쇠로 시설마다 **다른 값**이 되어야 그룹 접기가 의미 있다.
    facilities += [
        _facility("첨성대", _BASE_LAT + 0.002, _BASE_LNG + 0.002, "attraction", None),
        _facility("월정교", _BASE_LAT - 0.006, _BASE_LNG - 0.004, "attraction", None),
    ]
    forecasts = [
        {"tourist_attraction_name": "첨성대", "concentration_rate": 88.0, "forecast_date": "2026-09-18"},
        {"tourist_attraction_name": "월정교", "concentration_rate": 12.0, "forecast_date": "2026-09-18"},
    ]
    day = datetime(2026, 9, 18, tzinfo=KST)
    snapshots = [_snapshot(day + timedelta(minutes=10 * i), _lots(20 + i)) for i in range(6)]

    row = svc.aggregate_estimated_days(
        snapshots, facilities, {"2026-09-18": forecasts}, ["2026-09-18"],
    )["daily"][0]
    total, count, _ = _reference(snapshots, facilities, forecasts)

    assert count > 0
    assert row["sampleCount"] == count
    assert row["avgCongestion"] == pytest.approx(round(total / count, 3), abs=1e-3)
    assert sum(t["sampleCount"] for t in row["byType"].values()) == count
    # 유형별 평균의 표본 가중 합도 전체 평균과 같아야 한다(어느 유형도 새지 않았다).
    weighted = sum(t["avgCongestion"] * t["sampleCount"] for t in row["byType"].values())
    assert weighted / count == pytest.approx(total / count, abs=1e-3)


def test_anomaly_count_matches_per_facility_threshold():
    """이상 혼잡 건수도 시설 단위로 센 것과 같아야 한다(그룹 개수를 곱해 세는 지름길)."""
    facilities = [
        _facility("첨성대", _BASE_LAT, _BASE_LNG, "attraction", None),
        _facility("hot", _BASE_LAT + 0.0001, _BASE_LNG, "cafe", None),
        # 앵커에서 약 1.4km — 감쇠된 기준선이 낮아 이상 혼잡 선을 넘지 못한다.
        _facility("cool", _BASE_LAT + 0.0125, _BASE_LNG, "restaurant", None),
    ]
    forecasts = [{"tourist_attraction_name": "첨성대", "concentration_rate": 100.0,
                  "forecast_date": "2026-09-18"}]
    # 주차가 꽉 차면(available=0) 점유율 1.0 — 이상 혼잡 여부는 관광 성분이 가른다.
    full = (_lot("a", _BASE_LAT, _BASE_LNG, 100, 0),)
    snapshots = [_snapshot(datetime(2026, 9, 18, 10, 10 * i, tzinfo=KST), full) for i in range(3)]

    row = svc.aggregate_estimated_days(
        snapshots, facilities, {"2026-09-18": forecasts}, ["2026-09-18"],
    )["daily"][0]
    _, _, expected = _reference(snapshots, facilities, forecasts)
    assert row["anomalyCount"] == expected
    assert 0 < expected < row["sampleCount"], "전부/전무가 아니어야 경계를 실제로 검사한다"


# ── 2. KST 버킷팅 ────────────────────────────────────────────────────────────


def test_buckets_are_split_by_kst_day_not_utc():
    """UTC 15:00 은 이미 다음 KST 날이다. UTC 로 자르면 하루가 통째로 옆 날로 샌다."""
    facilities = [_facility("f", _BASE_LAT, _BASE_LNG, "cafe", 50.0)]
    utc = timezone.utc
    snapshots = [
        # 2026-09-17 23:50 KST = 14:50 UTC
        _snapshot(datetime(2026, 9, 17, 14, 50, tzinfo=utc)),
        _snapshot(datetime(2026, 9, 17, 14, 40, tzinfo=utc)),
        _snapshot(datetime(2026, 9, 17, 14, 30, tzinfo=utc)),
        # 2026-09-18 00:00 KST = 15:00 UTC (전날이 아니다)
        _snapshot(datetime(2026, 9, 17, 15, 0, tzinfo=utc)),
        _snapshot(datetime(2026, 9, 17, 15, 10, tzinfo=utc)),
        _snapshot(datetime(2026, 9, 17, 15, 20, tzinfo=utc)),
    ]
    daily = svc.aggregate_estimated_days(snapshots, facilities, {}, ["2026-09-17", "2026-09-18"])["daily"]
    assert [row["date"] for row in daily] == ["2026-09-17", "2026-09-18"]
    assert daily[0]["snapshotCount"] == 3
    assert daily[1]["snapshotCount"] == 3


# ── 3. 빈 구간·부분 수집 ─────────────────────────────────────────────────────


def test_every_requested_date_is_present_even_with_no_source():
    """원본이 없는 날도 빠지지 않는다 — 빠뜨리면 화면이 '그 날은 한산했다' 로 읽는다."""
    facilities = [_facility("f", _BASE_LAT, _BASE_LNG, "cafe", 50.0)]
    dates = ["2026-09-16", "2026-09-17", "2026-09-18"]
    snapshots = [_snapshot(datetime(2026, 9, 17, 10, 10 * i, tzinfo=KST)) for i in range(4)]

    daily = svc.aggregate_estimated_days(snapshots, facilities, {}, dates)["daily"]
    assert [row["date"] for row in daily] == dates
    assert daily[0]["avgCongestion"] is None and daily[0]["sampleCount"] == 0
    assert daily[0]["anomalyCount"] is None, "0 이 아니라 None 이어야 '기록 없음' 과 '0건' 이 갈린다"
    assert daily[1]["avgCongestion"] is not None
    assert daily[2]["avgCongestion"] is None


def test_empty_range_is_not_a_crash():
    result = svc.aggregate_estimated_days([], [], {}, ["2026-09-18"])
    assert result["daily"] == [{
        "date": "2026-09-18", "avgCongestion": None, "sampleCount": 0,
        "snapshotCount": 0, "anomalyCount": None, "byType": {},
    }]
    assert result["basis"]["snapshotCount"] == 0
    assert result["basis"]["latestObservedAt"] is None


def test_partial_day_below_minimum_snapshots_has_no_average():
    """버킷 2개(20분)뿐인 날의 평균을 '하루 평균' 이라고 부르지 않는다."""
    facilities = [_facility("f", _BASE_LAT, _BASE_LNG, "cafe", 50.0)]
    snapshots = [_snapshot(datetime(2026, 9, 18, 3, 10 * i, tzinfo=KST)) for i in range(2)]
    row = svc.aggregate_estimated_days(snapshots, facilities, {}, ["2026-09-18"])["daily"][0]
    assert row["snapshotCount"] == 2, "버킷 수 자체는 사실대로 싣는다"
    assert row["avgCongestion"] is None
    assert row["byType"] == {}


def test_facilities_outside_parking_radius_get_no_value():
    """반경 밖 시설은 표본이 되지 않는다 — 값이 없는 곳에 값을 만들지 않는다."""
    facilities = [
        _facility("near", _BASE_LAT, _BASE_LNG, "cafe", 50.0),
        _facility("far", _BASE_LAT + 1.0, _BASE_LNG + 1.0, "restaurant", 50.0),
    ]
    snapshots = [_snapshot(datetime(2026, 9, 18, 10, 10 * i, tzinfo=KST)) for i in range(3)]
    row = svc.aggregate_estimated_days(snapshots, facilities, {}, ["2026-09-18"])["daily"][0]
    assert set(row["byType"]) == {"cafe"}
    assert row["sampleCount"] == 3


# ── 4. 표본 간격 ─────────────────────────────────────────────────────────────


def test_sampling_interval_thins_buckets():
    assert svc.sample_minutes_for(7) == svc.SAMPLE_MINUTES_SHORT
    assert svc.sample_minutes_for(8) == svc.SAMPLE_MINUTES_LONG
    assert svc.sample_minutes_for(30) == svc.SAMPLE_MINUTES_LONG

    facilities = [_facility("f", _BASE_LAT, _BASE_LNG, "cafe", 50.0)]
    snapshots = [_snapshot(datetime(2026, 9, 18, tzinfo=KST) + timedelta(minutes=10 * i)) for i in range(18)]
    full = svc.aggregate_estimated_days(snapshots, facilities, {}, ["2026-09-18"])["daily"][0]
    thin = svc.aggregate_estimated_days(
        snapshots, facilities, {}, ["2026-09-18"], sample_minutes=svc.SAMPLE_MINUTES_LONG,
    )["daily"][0]
    assert full["snapshotCount"] == 18
    assert thin["snapshotCount"] == 6, "30분 간격이면 10분 버킷 3개 중 1개만 남는다"


def test_basis_declares_how_it_was_measured():
    """근거가 없으면 화면이 '추정' 이라고 말할 수 없다 — 산식·반경·간격·표본 단위를 모두 싣는다."""
    facilities = [_facility("f", _BASE_LAT, _BASE_LNG, "cafe", 50.0)]
    snapshots = [_snapshot(datetime(2026, 9, 18, 10, 10 * i, tzinfo=KST)) for i in range(4)]
    basis = svc.aggregate_estimated_days(
        snapshots, facilities, {}, ["2026-09-18"], sample_minutes=30,
    )["basis"]
    assert basis["weights"] == {"parking": estimator.PARKING_WEIGHT, "tourism": estimator.TOURISM_WEIGHT}
    assert basis["radiusM"] == 2000
    assert basis["samplingMinutes"] == 30
    assert basis["sampleUnit"] == "facility_bucket"
    assert basis["source"] == estimator.ESTIMATE_SOURCE
    assert basis["lotCountMax"] == 2
    assert basis["facilityCount"] == 1
    assert basis["latestObservedAt"] is not None
    assert "calibration" in basis


# ── 5. 캐시 ──────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clean_caches():
    svc.reset_caches()
    yield
    svc.reset_caches()


@pytest.mark.asyncio
async def test_cache_recomputes_only_today(monkeypatch):
    """지난 날은 원본이 더 바뀌지 않는다 — 새로고침은 **오늘 하루만** 다시 읽어야 한다."""
    now = datetime(2026, 9, 20, 6, 0, tzinfo=timezone.utc)  # KST 2026-09-20 15:00
    windows: list[list[str]] = []

    async def _fake_compute(dates, sample_minutes):
        windows.append(list(dates))
        return {
            "daily": [{
                "date": day, "avgCongestion": 0.5, "sampleCount": 10,
                "snapshotCount": 5, "anomalyCount": 0, "byType": {},
            } for day in dates],
            "basis": {"snapshotCount": len(dates)},
        }

    monkeypatch.setattr(svc, "_compute", _fake_compute)

    first = await svc.estimated_daily_series(3, now=now)
    assert [row["date"] for row in first["daily"]] == ["2026-09-18", "2026-09-19", "2026-09-20"]
    assert windows == [["2026-09-18", "2026-09-19", "2026-09-20"]]

    # 전부 캐시 — 계산이 다시 돌지 않는다.
    await svc.estimated_daily_series(3, now=now)
    assert len(windows) == 1

    # 오늘 항목만 만료시킨다(TTL 300초).
    key = ("2026-09-20", svc.sample_minutes_for(3))
    stored = svc._day_cache[key]
    svc._day_cache[key] = (stored[0] - svc.DAY_TTL_TODAY_SECONDS - 1, stored[1])

    third = await svc.estimated_daily_series(3, now=now)
    assert windows[-1] == ["2026-09-20"], "지난 날까지 다시 읽으면 캐시가 하는 일이 없다"
    assert [row["date"] for row in third["daily"]] == ["2026-09-18", "2026-09-19", "2026-09-20"]
    assert third["basis"] is not None


@pytest.mark.asyncio
async def test_series_is_clamped_to_max_days(monkeypatch):
    async def _fake_compute(dates, sample_minutes):
        return {"daily": [{"date": d, "avgCongestion": None, "sampleCount": 0,
                           "snapshotCount": 0, "anomalyCount": None, "byType": {}} for d in dates],
                "basis": {}}

    monkeypatch.setattr(svc, "_compute", _fake_compute)
    result = await svc.estimated_daily_series(999, now=datetime(2026, 9, 20, tzinfo=timezone.utc))
    assert result["days"] == svc.MAX_DAYS
    assert len(result["daily"]) == svc.MAX_DAYS


@pytest.mark.asyncio
async def test_compute_runs_loads_on_admin_pool_and_aggregation_on_heavy_pool(monkeypatch):
    """여러 날 집계가 기본 executor(관광객 요청 풀)를 쓰지 않는다 — 조회는 관리자 풀, 집계는 HEAVY 풀."""
    import threading

    seen: dict[str, str] = {}

    def _loads(start_iso, end_iso):
        seen["snapshots"] = threading.current_thread().name
        return []

    def _context(dates):
        seen["context"] = threading.current_thread().name
        return [], {}, None

    def _aggregate(snapshots, facilities, forecasts, dates, *, sample_minutes, calibration_state):
        seen["aggregate"] = threading.current_thread().name
        return {"daily": [], "basis": {}}

    monkeypatch.setattr(svc, "_load_snapshots", _loads)
    monkeypatch.setattr(svc, "_context_sync", _context)
    monkeypatch.setattr(svc, "aggregate_estimated_days", _aggregate)

    assert await svc._compute(["2026-09-20"], 10) == {"daily": [], "basis": {}}
    assert seen["snapshots"].startswith("nextspot-admin")
    assert seen["context"].startswith("nextspot-admin")
    assert seen["aggregate"].startswith("nextspot-heavy")


def test_embedded_rows_drop_impossible_lots():
    """총면수 0·잔여면 범위 밖 행을 살리면 점유율이 1 을 넘거나 음수가 된다."""
    rows = [
        {
            "id": "s1", "bucket_at": "2026-09-18T01:00:00+00:00", "observed_at": "2026-09-18T01:00:05+00:00",
            "area_demand_snapshot_lots": [
                {"source_lot_id": "ok", "name": "ok", "latitude": _BASE_LAT, "longitude": _BASE_LNG,
                 "total_spaces": 100, "available_spaces": 40},
                {"source_lot_id": "zero", "name": "zero", "latitude": _BASE_LAT, "longitude": _BASE_LNG,
                 "total_spaces": 0, "available_spaces": 0},
                {"source_lot_id": "over", "name": "over", "latitude": _BASE_LAT, "longitude": _BASE_LNG,
                 "total_spaces": 10, "available_spaces": 99},
            ],
        },
        # 주차장이 하나도 안 남는 스냅샷은 스냅샷 자체를 버린다.
        {"id": "s2", "bucket_at": "2026-09-18T01:10:00+00:00", "observed_at": "2026-09-18T01:10:05+00:00",
         "area_demand_snapshot_lots": [
             {"source_lot_id": "zero", "name": "zero", "latitude": _BASE_LAT, "longitude": _BASE_LNG,
              "total_spaces": 0, "available_spaces": 0},
         ]},
        # 시각이 깨진 행도 버린다.
        {"id": "s3", "bucket_at": "nonsense", "observed_at": "2026-09-18T01:20:00+00:00",
         "area_demand_snapshot_lots": []},
    ]
    snapshots = svc.snapshots_from_embedded_rows(rows)
    assert len(snapshots) == 1
    assert [lot.lot_id for lot in snapshots[0].lots] == ["ok"]
