"""주차 실측 파생 혼잡 추정의 계약.

잠그는 사실은 두 종류다.

  (A) 산식 — 격자·반경·점유율 변환. 특히 **반경 밖 시설에는 값을 만들지 않는다**.
  (B) 이 값이 실측으로 팔리지 않는다 — tier/source 가 추천 순위와 학습에서 빠진다.

(B) 가 이 파이프라인의 존재 조건이다. 산식이 틀리면 숫자가 나빠지지만, (B) 가 뚫리면
추정치가 사용자 순위와 모델 정답이 된다.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.services.congestion_evidence import (
    TRUSTED_EVIDENCE_TIERS,
    rankable_measured_level,
)
from app.services.parking_derived_congestion_service import (
    EVIDENCE_TIER,
    GRID_DEGREES,
    MAX_SNAPSHOT_AGE,
    RADIUS_M,
    SOURCE,
    ParkingDerivedError,
    ParkingLot,
    build_grid_estimates,
    cell_demand_level,
    grid_cell,
    grid_center,
    record_parking_derived_estimates,
)

# 황리단길 인근(실측 주차장이 실제로 몰려 있는 좌표대).
HWANGNAM_LAT, HWANGNAM_LNG = 35.8403, 129.2124


def _lot(lat: float, lng: float, *, total: int = 100, available: int = 20, lot_id: str = "l1") -> ParkingLot:
    return ParkingLot(
        lot_id=lot_id, name=lot_id, latitude=lat, longitude=lng,
        total_spaces=total, available_spaces=available,
    )


def _facility(fid: str, lat: float, lng: float) -> dict:
    return {"id": fid, "latitude": lat, "longitude": lng, "is_active": True}


# =========================================================================
# (A) 산식
# =========================================================================

def test_single_lot_level_is_its_occupancy_unchanged():
    """점유율 → 혼잡도 **변환을 하지 않는다.**

    보정할 근거가 하나도 없는 상태에서 단조 변환을 얹으면 그 순간 추정이 조작이 된다.
    주차장이 하나뿐이면 가중평균은 그 주차장의 점유율 그대로여야 한다.
    """
    lots = [_lot(HWANGNAM_LAT, HWANGNAM_LNG, total=200, available=50)]
    demand = cell_demand_level(lots, HWANGNAM_LAT, HWANGNAM_LNG)
    assert demand is not None
    assert demand["level"] == pytest.approx(0.75)
    assert demand["lot_count"] == 1


def test_no_lot_within_radius_yields_no_value():
    """반경 밖이면 ``None``. 값이 없는 곳에 값을 만들지 않는다 — 이 파이프라인의 핵심 제약."""
    # 위도 1도 ≈ 111km. 0.1도면 약 11km 로 반경 2km 밖이다.
    lots = [_lot(HWANGNAM_LAT + 0.1, HWANGNAM_LNG)]
    assert cell_demand_level(lots, HWANGNAM_LAT, HWANGNAM_LNG) is None


def test_closer_lot_dominates_the_weighted_average():
    """거리 가중이 실제로 작동한다 — 가까운 주차장 쪽으로 값이 끌린다."""
    near = _lot(HWANGNAM_LAT, HWANGNAM_LNG, total=100, available=0, lot_id="near")      # 점유율 1.0
    far = _lot(HWANGNAM_LAT + 0.015, HWANGNAM_LNG, total=100, available=100, lot_id="far")  # 점유율 0.0
    demand = cell_demand_level([near, far], HWANGNAM_LAT, HWANGNAM_LNG)
    assert demand is not None
    assert demand["lot_count"] == 2
    assert demand["level"] > 0.5, "가까운 주차장이 더 무겁게 반영되지 않는다"


def test_facilities_in_the_same_cell_share_one_value():
    """같은 격자 = 같은 값. 시설 좌표마다 다시 재면 원 데이터에 없는 해상도를 주장하게 된다."""
    lots = [_lot(HWANGNAM_LAT, HWANGNAM_LNG, total=100, available=30)]
    # 격자 한 칸(0.005°) 안에서 서로 다른 두 좌표.
    a = _facility("a", HWANGNAM_LAT, HWANGNAM_LNG)
    b = _facility("b", HWANGNAM_LAT + GRID_DEGREES / 4, HWANGNAM_LNG + GRID_DEGREES / 4)
    assert grid_cell(a["latitude"], a["longitude"]) == grid_cell(b["latitude"], b["longitude"])
    built = build_grid_estimates(lots, [a, b])
    levels = {row["facility_id"]: row["level"] for row in built["estimates"]}
    assert levels["a"] == levels["b"]
    assert built["grid_cells_covered"] == 1


def test_the_measurement_point_is_the_cell_center_not_the_first_facility():
    """거리를 **격자 중심**에서 잰다.

    '같은 칸이면 같은 값' 만으로는 부족하다 — 칸별로 메모하기만 하면 그 값이 **그 칸에서
    처음 만난 시설의 좌표**로 계산된다. 그러면 같은 데이터에서도 시설 조회 순서가 바뀌는
    것만으로 값이 달라진다(재현 불가). 중심으로 재는지 값으로 직접 확인한다.
    """
    # 주차장을 칸 중심에서 뚜렷하게 떨어뜨려, 중심 기준과 시설 기준 값이 실제로 갈리게 한다.
    lot_lat, lot_lng = HWANGNAM_LAT + 0.008, HWANGNAM_LNG
    lots = [_lot(lot_lat, lot_lng, total=100, available=30)]
    cell = grid_cell(HWANGNAM_LAT, HWANGNAM_LNG)
    center_lat, center_lng = grid_center(cell)
    expected = cell_demand_level(lots, center_lat, center_lng)
    assert expected is not None

    # 같은 칸 안의 서로 다른 두 시설을 **순서를 바꿔** 넣어도 값이 같아야 한다.
    a = _facility("a", HWANGNAM_LAT, HWANGNAM_LNG)
    b = _facility("b", HWANGNAM_LAT + GRID_DEGREES / 3, HWANGNAM_LNG)
    assert grid_cell(b["latitude"], b["longitude"]) == cell
    for order in ([a, b], [b, a]):
        built = build_grid_estimates(lots, order)
        for row in built["estimates"]:
            assert row["level"] == expected["level"], (
                "격자 중심이 아니라 시설 좌표로 재고 있다 — 조회 순서가 값을 바꾼다"
            )
            assert row["nearest_lot_m"] == expected["nearest_lot_m"]


def test_grid_center_stays_inside_its_own_cell():
    cell = grid_cell(HWANGNAM_LAT, HWANGNAM_LNG)
    center_lat, center_lng = grid_center(cell)
    assert grid_cell(center_lat, center_lng) == cell


def test_far_facilities_are_skipped_not_defaulted():
    """반경 밖 시설은 estimates 에 들어가지 않고 **세어지기만** 한다."""
    lots = [_lot(HWANGNAM_LAT, HWANGNAM_LNG)]
    near = _facility("near", HWANGNAM_LAT, HWANGNAM_LNG)
    far = _facility("far", HWANGNAM_LAT + 0.3, HWANGNAM_LNG)  # 약 33km
    built = build_grid_estimates(lots, [near, far])
    assert [row["facility_id"] for row in built["estimates"]] == ["near"]
    assert built["skipped_no_parking"] == 1
    assert built["skipped_no_coordinates"] == 0


def test_facilities_without_coordinates_are_skipped():
    lots = [_lot(HWANGNAM_LAT, HWANGNAM_LNG)]
    built = build_grid_estimates(lots, [
        {"id": "no-coords", "latitude": None, "longitude": None},
        {"id": "", "latitude": HWANGNAM_LAT, "longitude": HWANGNAM_LNG},
    ])
    assert built["estimates"] == []
    assert built["skipped_no_coordinates"] == 2


def test_level_stays_inside_the_column_check_range():
    """congestion_level 은 DB CHECK 로 0..1 이다. 여기서 벗어나면 INSERT 가 통째로 죽는다."""
    lots = [
        _lot(HWANGNAM_LAT, HWANGNAM_LNG, total=17, available=0, lot_id="full"),
        _lot(HWANGNAM_LAT + 0.001, HWANGNAM_LNG, total=564, available=564, lot_id="empty"),
    ]
    built = build_grid_estimates(lots, [_facility("f", HWANGNAM_LAT, HWANGNAM_LNG)])
    for row in built["estimates"]:
        assert 0.0 <= row["level"] <= 1.0


def test_facility_load_pages_past_the_postgrest_row_cap():
    """단발 select 는 1,000행에서 **조용히** 잘린다(오류가 아니라 200).

    프로덕션 활성 시설은 1,653곳이다. 잘리면 653곳이 이유 없이 추정에서 빠지는데 화면에는
    아무 표시도 없다 — simulate-peak 이 똑같은 방식으로 664곳을 놓쳤던 결함이다.
    """
    from tests.routers.test_routers import FakeSupabase  # 1000행 캡을 실제로 흉내 내는 Fake
    from app.services import parking_derived_congestion_service as svc

    rows = [
        {"id": f"f-{i}", "latitude": HWANGNAM_LAT, "longitude": HWANGNAM_LNG, "is_active": True}
        for i in range(1200)
    ]
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(svc, "supabase_admin", FakeSupabase({"facilities": rows}))
        loaded = svc._load_active_facilities()
    assert len(loaded) == 1200, f"PostgREST 캡에 잘렸다({len(loaded)}곳) — fetch_all_rows 가 아니다"


def test_inactive_facilities_are_not_estimated():
    """비활성(미검증·데모 정리) 시설에 추정치를 붙이면 지도에 없는 곳의 값이 쌓인다."""
    from tests.routers.test_routers import FakeSupabase
    from app.services import parking_derived_congestion_service as svc

    rows = [
        {"id": "on", "latitude": HWANGNAM_LAT, "longitude": HWANGNAM_LNG, "is_active": True},
        {"id": "off", "latitude": HWANGNAM_LAT, "longitude": HWANGNAM_LNG, "is_active": False},
    ]
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(svc, "supabase_admin", FakeSupabase({"facilities": rows}))
        loaded = svc._load_active_facilities()
    assert [row["id"] for row in loaded] == ["on"]


def test_radius_matches_the_repository_definition_of_nearby():
    """반경을 이 파일이 새로 정하지 않는다 — 저장소가 이미 쓰는 '주변' 과 같아야 한다."""
    from app.services.area_demand_forecast_service import _RADIUS_M as forecast_radius
    from app.services.parking_demand_service import _RADIUS_M as live_radius

    assert RADIUS_M == forecast_radius == live_radius


# =========================================================================
# (B) 추정치가 실측·학습·순위로 새지 않는다
# =========================================================================

def test_evidence_tier_is_synthetic():
    """verified/corroborated 로 넣으면 scripts/train.py 가 이것을 학습 정답으로 먹는다."""
    assert EVIDENCE_TIER == "synthetic"
    assert EVIDENCE_TIER not in TRUSTED_EVIDENCE_TIERS


def test_source_is_a_new_value_not_mixed_into_existing_ones():
    assert SOURCE == "parking_derived"
    assert SOURCE not in {"traffic_cctv", "tour_api", "event", "user_report",
                          "merchant_report", "admin_override", "seed", "simulated"}


def test_synthetic_evidence_is_never_rankable():
    """추천 순위 진입로(congestion_evidence.rankable_measured_level)에서 막힌다."""
    now = datetime(2026, 9, 8, 7, 0, tzinfo=timezone.utc)
    evidence = {
        "source": "measured",
        "evidence_tier": EVIDENCE_TIER,
        "level": 0.9,
        "timestamp": now.isoformat(),
    }
    assert rankable_measured_level(evidence, now=now) is None
    # 대조군 — 같은 값이 corroborated 였다면 순위에 들어간다(테스트가 항상 None 을 보는
    # 무의미한 통과가 되지 않게 확인한다).
    assert rankable_measured_level({**evidence, "evidence_tier": "corroborated"}, now=now) == 0.9


def test_source_is_listed_as_never_trainable():
    """tier 로 이미 막히지만 두 겹으로 막는 것이 이 저장소의 관례다."""
    from pathlib import Path

    train_py = (Path(__file__).resolve().parents[2] / "scripts" / "train.py").read_text(encoding="utf-8")
    marker = "NEVER_TRAINABLE_SOURCES = {"
    line = train_py[train_py.index(marker):]
    line = line[: line.index("}")]
    assert f'"{SOURCE}"' in line, "새 source 가 학습 금지 목록에 없다"


def test_latest_congestion_fallback_query_excludes_synthetic_tier():
    """RPC 가 없는 환경에서 도는 폴백 경로도 tier 허용목록으로 막는지 실제로 확인한다.

    (여기가 뚫리면 RPC 미배포 구간에서만 추정치가 추천에 흘러든다 — 가장 발견하기 어려운
     종류의 누출이라 문서가 아니라 코드로 잠근다.)
    """
    from app.routers import infrastructures

    captured: dict = {}

    class _Result:
        data: list = []

    class _Query:
        def select(self, *_a, **_k):
            return self

        def eq(self, *_a, **_k):
            return self

        def in_(self, column, values):
            captured[column] = list(values)
            return self

        def order(self, *_a, **_k):
            return self

        def limit(self, *_a, **_k):
            return self

        def execute(self):
            return _Result()

    class _Client:
        def table(self, _name):
            return _Query()

        # 폴백 경로로 강제하기 위해 RPC 는 실패시킨다.
        def rpc(self, *_a, **_k):
            raise RuntimeError("rpc unavailable")

    import asyncio

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(infrastructures, "supabase_client", _Client())
        asyncio.run(infrastructures.fetch_latest_congestion_for_all(["f-1"]))

    assert "evidence_tier" in captured, "폴백 쿼리가 tier 허용목록을 걸지 않는다"
    assert EVIDENCE_TIER not in captured["evidence_tier"]
    assert set(captured["evidence_tier"]) == {"single_report", "corroborated", "verified"}


# =========================================================================
# 적재 가드 — 낡은 원본으로 추정치를 찍지 않는다 / 두 번 눌러도 두 배가 되지 않는다
# =========================================================================

_SNAPSHOT = {
    "id": "snap-1",
    "source": "gyeongju_its",
    "observed_at": "2026-09-08T07:03:01.924168+00:00",
    "bucket_at": "2026-09-08T07:00:00+00:00",
    "live_lot_count": 1,
}


def _patch_loaders(monkeypatch, *, lots=None, facilities=None):
    from app.services import parking_derived_congestion_service as svc

    monkeypatch.setattr(svc, "_load_latest_snapshot", lambda: {
        "snapshot": dict(_SNAPSHOT),
        "lots": lots if lots is not None else [_lot(HWANGNAM_LAT, HWANGNAM_LNG)],
    })
    monkeypatch.setattr(svc, "_load_active_facilities", lambda: (
        facilities if facilities is not None else [_facility("f-1", HWANGNAM_LAT, HWANGNAM_LNG)]
    ))


@pytest.mark.asyncio
async def test_stale_snapshot_is_refused(monkeypatch):
    """수집이 죽어 있을 때 한 시간 전 주차 상황을 '지금' 으로 파는 것이 이 가드가 막는 것이다."""
    _patch_loaders(monkeypatch)
    observed = datetime.fromisoformat(_SNAPSHOT["observed_at"])
    with pytest.raises(ParkingDerivedError) as exc:
        await record_parking_derived_estimates(now=observed + MAX_SNAPSHOT_AGE + timedelta(minutes=1))
    assert exc.value.code == "parking_snapshot_stale"


@pytest.mark.asyncio
async def test_second_press_at_the_same_bucket_inserts_nothing(monkeypatch):
    from app.services import parking_derived_congestion_service as svc

    _patch_loaders(monkeypatch)
    monkeypatch.setattr(svc, "_existing_rows_at", lambda _timestamp: 1)

    def _must_not_insert(_rows):
        raise AssertionError("같은 버킷에 두 번 적재했다")

    monkeypatch.setattr(svc, "_insert_estimates", _must_not_insert)
    observed = datetime.fromisoformat(_SNAPSHOT["observed_at"])
    result = await record_parking_derived_estimates(now=observed + timedelta(minutes=1))
    assert result["status"] == "already_recorded"
    assert result["inserted"] == 0


@pytest.mark.asyncio
async def test_recorded_rows_carry_the_three_markers(monkeypatch):
    """실제로 쓰는 행에 source/tier 가 붙고, 인원수는 지어내지 않는다."""
    from app.services import parking_derived_congestion_service as svc

    _patch_loaders(monkeypatch)
    monkeypatch.setattr(svc, "_existing_rows_at", lambda _timestamp: 0)
    written: list[dict] = []

    def _capture(rows):
        written.extend(rows)
        return len(rows)

    monkeypatch.setattr(svc, "_insert_estimates", _capture)
    observed = datetime.fromisoformat(_SNAPSHOT["observed_at"])
    result = await record_parking_derived_estimates(now=observed + timedelta(minutes=1))

    assert result["status"] == "recorded"
    assert result["is_estimate"] is True
    assert written and all(row["source"] == SOURCE for row in written)
    assert all(row["evidence_tier"] == EVIDENCE_TIER for row in written)
    # 인원수는 관측한 적이 없다 — capacity × level 로 채우면 그게 곧 지어낸 숫자다.
    fabricated = [row["current_count"] for row in written if row["current_count"] is not None]
    assert not fabricated, f"관측한 적 없는 인원수를 적었다: {fabricated[:5]}"
    # 시각은 원본의 10분 버킷을 그대로 쓴다(원본보다 정밀한 시각을 주장하지 않는다).
    assert all(row["timestamp"] == _SNAPSHOT["bucket_at"] for row in written)


@pytest.mark.asyncio
async def test_no_facility_in_radius_is_not_a_failure(monkeypatch):
    """만들 값이 없는 것과 실패는 다른 사실이다."""
    from app.services import parking_derived_congestion_service as svc

    _patch_loaders(monkeypatch, facilities=[_facility("far", HWANGNAM_LAT + 0.5, HWANGNAM_LNG)])
    monkeypatch.setattr(svc, "_existing_rows_at", lambda _timestamp: 0)
    observed = datetime.fromisoformat(_SNAPSHOT["observed_at"])
    result = await record_parking_derived_estimates(now=observed + timedelta(minutes=1))
    assert result["status"] == "no_estimates"
    assert result["inserted"] == 0
    assert result["skipped_no_parking"] == 1


@pytest.mark.asyncio
async def test_duplicate_check_failure_blocks_the_insert(monkeypatch):
    """중복 확인이 실패하면 적재하지 않는다 — 확인 없이 넣으면 두 배로 쌓인 뒤에야 안다."""
    from app.services import parking_derived_congestion_service as svc

    _patch_loaders(monkeypatch)

    def _boom(_timestamp):
        raise RuntimeError("postgrest down")

    monkeypatch.setattr(svc, "_existing_rows_at", _boom)
    monkeypatch.setattr(svc, "_insert_estimates", lambda _rows: (_ for _ in ()).throw(
        AssertionError("중복 확인 실패인데 적재했다")
    ))
    observed = datetime.fromisoformat(_SNAPSHOT["observed_at"])
    with pytest.raises(ParkingDerivedError) as exc:
        await record_parking_derived_estimates(now=observed + timedelta(minutes=1))
    assert exc.value.code == "duplicate_check_failed"


@pytest.mark.asyncio
async def test_missing_migration_is_reported_as_such(monkeypatch):
    """마이그레이션 미적용은 '서버 고장' 이 아니라 '할 일이 남았다' 다."""
    from app.services import parking_derived_congestion_service as svc

    class _CheckViolation(Exception):
        code = "23514"
        message = 'new row violates check constraint "congestion_logs_source_check"'

    _patch_loaders(monkeypatch)
    monkeypatch.setattr(svc, "_existing_rows_at", lambda _timestamp: 0)
    monkeypatch.setattr(svc, "_insert_estimates", lambda _rows: (_ for _ in ()).throw(_CheckViolation()))
    observed = datetime.fromisoformat(_SNAPSHOT["observed_at"])
    with pytest.raises(ParkingDerivedError) as exc:
        await record_parking_derived_estimates(now=observed + timedelta(minutes=1))
    assert exc.value.code == "migration_not_applied"
