import math
import random
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from types import SimpleNamespace

import pytest

from app.services import area_demand_forecast_service as forecast_svc
from app.services.area_demand_forecast_service import (
    AreaDemandPoint,
    aggregate_nearby_points,
    backtest_forecast_points,
    forecast_from_points,
)


def test_snapshot_lots_are_reaggregated_for_each_candidate_radius():
    parents = [{"id": "s1", "observed_at": "2026-08-01T01:00:00+00:00"}]
    lots = [
        {
            "snapshot_id": "s1", "latitude": 35.8361, "longitude": 129.2105,
            "total_spaces": 100, "available_spaces": 20,
        },
        {
            "snapshot_id": "s1", "latitude": 36.0, "longitude": 129.4,
            "total_spaces": 500, "available_spaces": 500,
        },
    ]
    points = aggregate_nearby_points(parents, lots, 35.8361, 129.2105)
    assert len(points) == 1
    assert points[0].level == pytest.approx(0.8)
    assert points[0].lot_count == 1


def _weekly_points(count: int = 10) -> list[AreaDemandPoint]:
    start = datetime(2026, 5, 4, 1, tzinfo=timezone.utc)  # 월요일 10:00 KST
    return [
        AreaDemandPoint(start + timedelta(days=7 * index), 0.35 + (index % 3) * 0.02, 2)
        for index in range(count)
    ]


def test_forecast_requires_enough_dates_and_never_reads_future_points():
    points = _weekly_points(7)
    now = datetime(2026, 6, 20, tzinfo=timezone.utc)
    future_outlier = AreaDemandPoint(datetime(2026, 6, 29, 1, tzinfo=timezone.utc), 1.0, 2)
    arrival = datetime(2026, 6, 22, 1, tzinfo=timezone.utc)
    forecast = forecast_from_points([*points, future_outlier], arrival, now=now)
    assert forecast is not None
    assert forecast["sample_count"] == 7
    assert forecast["bucket_minutes"] == 10
    assert forecast["level"] < 0.5
    assert forecast["mode"] == "forecast"


def test_forecast_fails_closed_when_history_is_too_short():
    points = _weekly_points(2)
    arrival = datetime(2026, 6, 22, 1, tzinfo=timezone.utc)
    assert forecast_from_points(points, arrival, now=arrival - timedelta(days=1)) is None


def test_backtest_is_time_ordered_and_reports_real_mae_only_when_available():
    quality = backtest_forecast_points(_weekly_points(16))
    assert quality["sample_count"] > 0
    assert quality["mae"] is not None
    assert quality["baseline_mae"] is not None


# ── 백테스트 캐시 — 후보마다 빗나가면 캐시가 아니다 ────────────────────────
# 예전에는 삽입 직전에 _quality_cache.clear() 를 해서 항목이 항상 하나뿐이었다.
# 키에 좌표가 들어가므로 한 번의 추천 안에서도 후보마다 키가 달라, TTL 30분짜리 캐시가
# 사실상 없는 것과 같았고 비싼 백테스트가 후보 수만큼 돌았다.


def _points(n: int = 8) -> list:
    base = datetime(2026, 8, 1, tzinfo=timezone.utc)
    return [
        AreaDemandPoint(observed_at=base + timedelta(hours=i), level=0.4 + 0.01 * i, lot_count=3)
        for i in range(n)
    ]


def test_the_backtest_cache_keeps_more_than_one_candidate():
    forecast_svc._quality_cache.clear()
    pts = _points()
    # 한 번의 추천이 훑는 서로 다른 후보 좌표들.
    for lat, lng in [(35.836, 129.210), (35.840, 129.215), (35.845, 129.220)]:
        forecast_svc._cached_backtest(pts, lat, lng)
    assert len(forecast_svc._quality_cache) == 3, (
        f"후보마다 캐시가 비워진다 — 항목 {len(forecast_svc._quality_cache)}개"
    )


def test_the_same_candidate_hits_the_cache():
    forecast_svc._quality_cache.clear()
    pts = _points()
    first = forecast_svc._cached_backtest(pts, 35.836, 129.210)
    second = forecast_svc._cached_backtest(pts, 35.836, 129.210)
    assert first is second, "같은 후보를 두 번 물었는데 백테스트가 다시 돌았다"


def test_the_cache_stays_bounded():
    """상한이 없으면 좌표마다 항목이 쌓여 무한히 자란다(Render 무료 인스턴스)."""
    forecast_svc._quality_cache.clear()
    pts = _points()
    cap = forecast_svc._QUALITY_CACHE_MAX_ENTRIES
    for i in range(cap + 20):
        forecast_svc._cached_backtest(pts, 35.0 + i * 0.01, 129.0 + i * 0.01)
    assert len(forecast_svc._quality_cache) <= cap


# ── RPC 집계(마이그레이션 20260904120000) ─────────────────────────────────
# 집계는 이제 Postgres 가 한다. 여기서 SQL 을 실행할 수는 없으므로, 마이그레이션의
# 수식을 **연산 순서까지 그대로** 파이썬으로 옮긴 대조본을 두고 aggregate_nearby_points
# 와 같은 값이 나오는지 잠근다. SQL 을 고치면 아래 옮긴 식도 같이 고쳐야 한다.
#
# 이 테스트가 잠그는 것: 두 **수식**이 같다(필터·가중·클램프·경계·정렬). 잠그지 못하는 것:
# 실제 Postgres 실행 결과의 비트 단위 일치. 합산 순서가 SQL 에서 지정되지 않고 float8→jsonb
# 변환도 유효숫자를 15자리로 줄일 수 있어, 실 DB 값은 마지막 1e-15 자리에서 흔들릴 수 있다.
# 하류가 전부 4자리 반올림·중앙값이라 판정에는 영향이 없지만, "완전히 같은 비트"로 읽지 말 것.

_QUERY_LAT = 35.8361
_QUERY_LNG = 129.2105
_EARTH_M = 6371000.0


def _sql_distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """마이그레이션의 거리식.

    파이썬 calculate_haversine_distance 는 round(x, 1)(짝수 반올림)을, Postgres 는
    round(x::numeric, 1)(사사오입)을 쓴다. float 의 최단 표현을 Decimal 로 받아
    ROUND_HALF_UP 하는 것이 Postgres 쪽 동작이다 — 정확히 .05 로 떨어지는 값에서만 두
    방식이 갈리는데, 아래 대조 테스트가 그 차이까지 함께 잠근다.
    """
    a = (
        math.sin((math.radians(lat2) - math.radians(lat1)) / 2.0) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin((math.radians(lng2) - math.radians(lng1)) / 2.0) ** 2
    )
    meters = _EARTH_M * (2.0 * math.asin(min(1.0, math.sqrt(a))))
    return float(Decimal(repr(meters)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))


def _sql_bounding_box(
    latitude: float, longitude: float, radius_m: float
) -> tuple[float, float, float, float]:
    """마이그레이션의 경계 상자."""
    sigma = (radius_m + 1.0) / _EARTH_M
    lat_delta = math.degrees(sigma)
    lat_min = max(-90.0, latitude - lat_delta)
    lat_max = min(90.0, latitude + lat_delta)
    far_lat = min(90.0, abs(latitude) + lat_delta)
    cos_product = math.cos(math.radians(latitude)) * math.cos(math.radians(far_lat))
    if cos_product <= 0.0:
        lng_delta = 180.0
    else:
        lng_delta = math.degrees(
            2.0 * math.asin(min(1.0, math.sin(sigma / 2.0) / math.sqrt(cos_product)))
        )
    if lng_delta >= 180.0 or longitude - lng_delta < -180.0 or longitude + lng_delta > 180.0:
        return lat_min, lat_max, -180.0, 180.0
    return lat_min, lat_max, longitude - lng_delta, longitude + lng_delta


def _sql_payload(
    parents: list[dict],
    lots: list[dict],
    latitude: float,
    longitude: float,
    radius_m: float = 2_000.0,
) -> dict:
    """마이그레이션 SQL 이 돌려줄 JSONB 응답을 그대로 만든다."""
    lat_min, lat_max, lng_min, lng_max = _sql_bounding_box(latitude, longitude, radius_m)
    times = {str(parent["id"]): parent["observed_at"] for parent in parents}
    grouped: dict[str, tuple[float, float, int]] = {}
    for lot in lots:
        snapshot_id = str(lot["snapshot_id"])
        if snapshot_id not in times:
            continue
        if not lat_min <= lot["latitude"] <= lat_max:
            continue
        if not lng_min <= lot["longitude"] <= lng_max:
            continue
        total, available = lot["total_spaces"], lot["available_spaces"]
        if not (total > 0 and 0 <= available <= total):
            continue
        distance_m = _sql_distance_m(latitude, longitude, lot["latitude"], lot["longitude"])
        if distance_m > radius_m:
            continue
        occupancy = 1.0 - available / total
        weight = min(total, 500) / (1.0 + distance_m / 500.0)
        weighted, weight_total, count = grouped.get(snapshot_id, (0.0, 0.0, 0))
        grouped[snapshot_id] = (
            weighted + occupancy * weight,
            weight_total + weight,
            count + 1,
        )
    points = sorted(
        (
            [times[snapshot_id], min(1.0, max(0.0, weighted / weight_total)), count]
            for snapshot_id, (weighted, weight_total, count) in grouped.items()
            if weight_total > 0 and count > 0
        ),
        key=lambda row: row[0],
    )
    return {
        "source": "gyeongju_its",
        "radius_m": radius_m,
        "point_count": len(points),
        "points": points,
    }


def _lot_grid() -> list[tuple[float, float, int]]:
    """경주 시내 주변에 결정적으로 흩뿌린 주차장(반경 안팎이 섞이도록)."""
    rng = random.Random(20260904)
    return [
        (
            _QUERY_LAT + rng.uniform(-0.03, 0.03),
            _QUERY_LNG + rng.uniform(-0.03, 0.03),
            rng.choice([30, 80, 120, 400, 900]),
        )
        for _ in range(40)
    ]


def _snapshot_fixture(snapshot_count: int = 5) -> tuple[list[dict], list[dict]]:
    grid = _lot_grid()
    rng = random.Random(11)
    base = datetime(2026, 8, 1, tzinfo=timezone.utc)
    parents: list[dict] = []
    lots: list[dict] = []
    for index in range(snapshot_count):
        snapshot_id = f"s{index}"
        observed_at = base + timedelta(minutes=10 * index)
        parents.append({
            "id": snapshot_id,
            "source": "gyeongju_its",
            # 마이그레이션의 to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' 형식.
            "observed_at": observed_at.strftime("%Y-%m-%dT%H:%M:%S.%f") + "+00:00",
        })
        for latitude, longitude, total in grid:
            lots.append({
                "snapshot_id": snapshot_id,
                "latitude": latitude,
                "longitude": longitude,
                "total_spaces": total,
                "available_spaces": rng.randint(0, total),
            })
    return parents, lots


@pytest.fixture
def _clean_module_state():
    forecast_svc._quality_cache.clear()
    forecast_svc._raw_cache = None
    forecast_svc._rpc_missing_until = 0.0
    yield
    forecast_svc._quality_cache.clear()
    forecast_svc._raw_cache = None
    forecast_svc._rpc_missing_until = 0.0


def test_the_rpc_bounding_box_never_drops_a_lot_inside_the_radius():
    """상자가 반경 원의 상위집합이 아니면 주차장이 조용히 빠지고 수요가 낮게 나온다."""
    lat_min, lat_max, lng_min, lng_max = _sql_bounding_box(_QUERY_LAT, _QUERY_LNG, 2_000.0)
    rng = random.Random(7)
    checked = 0
    for _ in range(20_000):
        latitude = _QUERY_LAT + rng.uniform(-0.05, 0.05)
        longitude = _QUERY_LNG + rng.uniform(-0.05, 0.05)
        if _sql_distance_m(_QUERY_LAT, _QUERY_LNG, latitude, longitude) > 2_000.0:
            continue
        checked += 1
        assert lat_min <= latitude <= lat_max, (latitude, lat_min, lat_max)
        assert lng_min <= longitude <= lng_max, (longitude, lng_min, lng_max)
    assert checked > 1_000, "반경 안 표본이 너무 적어 상자를 검증하지 못했다"


def test_the_bounding_box_gives_up_instead_of_splitting_at_the_antimeridian():
    """BETWEEN 한 구간으로 표현 못 하는 자리에서는 필터를 포기해야 한다(누락 금지)."""
    assert _sql_bounding_box(35.8361, 179.9999, 2_000.0)[2:] == (-180.0, 180.0)
    assert _sql_bounding_box(89.9999, 129.2105, 2_000.0)[2:] == (-180.0, 180.0)


def test_the_rpc_aggregation_matches_the_python_aggregation():
    """RPC 결과와 기존 파이썬 집계가 **같은 값**이어야 한다 — 구조 변경의 핵심 계약."""
    parents, lots = _snapshot_fixture()
    expected = aggregate_nearby_points(parents, lots, _QUERY_LAT, _QUERY_LNG)
    assert expected, "표본이 비어 대조가 무의미하다"
    assert expected[0].lot_count > 1, "반경 안 주차장이 여럿이어야 가중 합을 검증한다"
    assert expected[0].lot_count < len(_lot_grid()), "반경 밖 주차장이 섞여야 필터도 검증된다"

    from_rpc = forecast_svc._points_from_payload(
        _sql_payload(parents, lots, _QUERY_LAT, _QUERY_LNG)
    )
    assert [(p.observed_at, p.level, p.lot_count) for p in from_rpc] == [
        (p.observed_at, p.level, p.lot_count) for p in expected
    ]


def test_the_rpc_aggregation_matches_at_the_radius_boundary():
    """경계에서 갈리면 후보마다 주차장 하나가 들락날락하며 수요가 흔들린다."""
    parents = [{"id": "s1", "observed_at": "2026-08-01T01:00:00.000000+00:00"}]
    lots = []
    # 2km 경계를 0.5m 간격으로 훑는다(안/밖/딱 걸치는 지점).
    for step in range(-40, 41):
        offset_deg = (2_000.0 + step * 0.5) / (_EARTH_M * math.pi / 180.0)
        lots.append({
            "snapshot_id": "s1",
            "latitude": _QUERY_LAT + offset_deg,
            "longitude": _QUERY_LNG,
            "total_spaces": 100 + step,
            "available_spaces": (step + 40) % 50,
        })
    expected = aggregate_nearby_points(parents, lots, _QUERY_LAT, _QUERY_LNG)
    from_rpc = forecast_svc._points_from_payload(
        _sql_payload(parents, lots, _QUERY_LAT, _QUERY_LNG)
    )
    assert [(p.observed_at, p.level, p.lot_count) for p in from_rpc] == [
        (p.observed_at, p.level, p.lot_count) for p in expected
    ]
    assert 0 < expected[0].lot_count < len(lots), "경계 필터가 아무것도 자르지 않았다"


def test_rpc_points_are_ordered_and_clamped():
    payload = {"points": [
        ["2026-08-01T01:10:00.000000+00:00", 0.5, 3],
        ["2026-08-01T01:00:00.000000+00:00", 1.4, 2],
        ["2026-08-01T01:20:00.000000+00:00", -0.2, 1],
    ]}
    points = forecast_svc._points_from_payload(payload)
    assert [point.level for point in points] == [1.0, 0.5, 0.0]
    assert [point.lot_count for point in points] == [2, 3, 1]
    assert points[0].observed_at == datetime(2026, 8, 1, 1, tzinfo=timezone.utc)
    # PostgREST 가 한 행짜리 리스트로 감싸 주는 형태도 같은 결과여야 한다.
    assert forecast_svc._points_from_payload([payload]) == points


@pytest.mark.parametrize("payload", [
    None,
    {},
    {"points": "nope"},
    {"points": [[1, 2]]},
    {"points": [["not-a-time", 0.5, 1]]},
])
def test_a_broken_rpc_payload_is_never_read_as_an_empty_history(payload):
    """빈 시계열은 '표본 부족'으로 조용히 닫힌다. 깨진 응답이 그걸로 위장되면 안 된다."""
    with pytest.raises(ValueError):
        forecast_svc._points_from_payload(payload)


class _FakeRpcClient:
    """supabase_admin.rpc(name, params).execute() 만 흉내 낸다."""

    def __init__(self, result=None, error: Exception | None = None):
        self.result = result
        self.error = error
        self.calls: list[tuple[str, dict]] = []

    def rpc(self, name, params):
        self.calls.append((name, params))
        client = self

        class _Query:
            def execute(self):
                if client.error is not None:
                    raise client.error
                return SimpleNamespace(data=client.result)

        return _Query()


@pytest.mark.asyncio
async def test_the_rpc_path_never_loads_the_raw_lot_table(monkeypatch, _clean_module_state):
    """52MB 상주 캐시를 없애는 것이 이 변경의 목적이다 — 원본 적재가 남으면 실패."""
    parents, lots = _snapshot_fixture()
    fake = _FakeRpcClient(result=_sql_payload(parents, lots, _QUERY_LAT, _QUERY_LNG))
    monkeypatch.setattr(forecast_svc, "supabase_admin", fake)

    def _forbidden(*_args, **_kwargs):
        raise AssertionError("RPC 경로가 원본 lot 테이블을 다시 읽었다")

    monkeypatch.setattr(forecast_svc, "fetch_all_rows", _forbidden)
    now = datetime(2026, 8, 2, tzinfo=timezone.utc)
    points = await forecast_svc._load_points(_QUERY_LAT, _QUERY_LNG, now)

    assert points == aggregate_nearby_points(parents, lots, _QUERY_LAT, _QUERY_LNG)
    assert forecast_svc._raw_cache is None
    assert len(fake.calls) == 1
    name, params = fake.calls[0]
    assert name == "area_demand_points_near"
    assert params["p_latitude"] == _QUERY_LAT
    assert params["p_longitude"] == _QUERY_LNG
    assert params["p_radius_m"] == forecast_svc._RADIUS_M
    assert params["p_source"] == "gyeongju_its"
    assert params["p_since"] == (now - timedelta(days=56)).isoformat()


@pytest.mark.asyncio
async def test_a_successful_rpc_releases_the_fallback_raw_cache(monkeypatch, _clean_module_state):
    parents, lots = _snapshot_fixture(2)
    forecast_svc._raw_cache = (0.0, parents, lots)
    monkeypatch.setattr(
        forecast_svc,
        "supabase_admin",
        _FakeRpcClient(result=_sql_payload(parents, lots, _QUERY_LAT, _QUERY_LNG)),
    )
    await forecast_svc._load_points(
        _QUERY_LAT, _QUERY_LNG, datetime(2026, 8, 2, tzinfo=timezone.utc)
    )
    assert forecast_svc._raw_cache is None, "RPC 가 살아 있는데 원본 캐시를 붙들고 있다"


@pytest.mark.asyncio
async def test_a_missing_rpc_falls_back_to_the_python_aggregation(monkeypatch, _clean_module_state):
    """마이그레이션보다 백엔드가 먼저 배포돼도 권역 수요 신호가 사라지면 안 된다."""
    parents, lots = _snapshot_fixture()
    missing = RuntimeError(
        "{'code': 'PGRST202', 'message': 'Could not find the function "
        "public.area_demand_points_near(p_latitude, p_longitude, p_radius_m, "
        "p_since, p_source) in the schema cache'}"
    )
    monkeypatch.setattr(forecast_svc, "supabase_admin", _FakeRpcClient(error=missing))

    async def _raw(_now):
        return parents, lots

    monkeypatch.setattr(forecast_svc, "_load_raw_history", _raw)
    now = datetime(2026, 8, 2, tzinfo=timezone.utc)
    points = await forecast_svc._load_points(_QUERY_LAT, _QUERY_LNG, now)
    assert points == aggregate_nearby_points(parents, lots, _QUERY_LAT, _QUERY_LNG)

    # 후보마다 실패하는 왕복을 한 번 더 하지 않는다(배포 창 동안 지연이 두 배가 된다).
    assert forecast_svc._rpc_missing_until > 0.0
    quiet = _FakeRpcClient(error=missing)
    monkeypatch.setattr(forecast_svc, "supabase_admin", quiet)
    await forecast_svc._load_points(_QUERY_LAT, _QUERY_LNG, now)
    assert quiet.calls == []


@pytest.mark.asyncio
async def test_a_real_rpc_failure_is_not_disguised_as_a_missing_migration(
    monkeypatch, _clean_module_state
):
    """DB 장애까지 폴백으로 덮으면 없앤 52MB 경로가 조용히 되살아난다."""
    monkeypatch.setattr(
        forecast_svc, "supabase_admin", _FakeRpcClient(error=RuntimeError("connection reset"))
    )

    async def _forbidden(_now):
        raise AssertionError("진짜 오류에서 폴백을 탔다")

    monkeypatch.setattr(forecast_svc, "_load_raw_history", _forbidden)
    with pytest.raises(RuntimeError, match="connection reset"):
        await forecast_svc._load_points(
            _QUERY_LAT, _QUERY_LNG, datetime(2026, 8, 2, tzinfo=timezone.utc)
        )
    assert forecast_svc._rpc_missing_until == 0.0
