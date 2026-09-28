import ast
import asyncio
import hashlib
import inspect
import math
import random
import threading
import time
from dataclasses import FrozenInstanceError
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from functools import lru_cache
from types import SimpleNamespace

import pytest

from app.core.config import settings
from app.services import area_demand_forecast_service as forecast_svc
from app.services import parking_history as ph
from app.services.area_demand_forecast_service import (
    AreaDemandPoint,
    aggregate_nearby_points,
    backtest_forecast_points,
    forecast_from_points,
)
from tests.services._parking_fixture import (
    DAYS,
    LOTS,
    NOW_EDGE,
    START,
    _is_tie,
    _SinceRpcClient,
    north_of,
    patterned_fixture,
)


@pytest.fixture(autouse=True)
def _clear_module_caches():
    """모듈 전역 캐시를 테스트마다 비운다.

    `_load_points` 는 좌표 격자별 TTL 캐시를 탄다(코스 한 요청의 RPC 왕복 수십 회를 격자
    수로 줄이려고 넣었다). 이 캐시는 프로세스 수명 동안 살아 있으므로, 비우지 않으면
    **앞 테스트가 채운 값 때문에 뒤 테스트가 RPC 를 아예 부르지 않는다** — 폴백·실패 전파
    같은 경로가 조용히 검증되지 않은 채 초록이 된다(실제로 3건이 그렇게 깨졌다).
    """
    forecast_svc.reset_points_cache()
    forecast_svc._rpc_missing_until = 0.0
    forecast_svc._raw_cache = None
    yield
    forecast_svc.reset_points_cache()


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


def _backtest_series(seed: int, *, mixed_offsets: bool, ties: bool) -> list[AreaDemandPoint]:
    rng = random.Random(seed)
    kst = timezone(timedelta(hours=9))
    at = datetime(2026, 8, 1, tzinfo=timezone.utc) + timedelta(minutes=rng.randint(0, 1439))
    points = []
    for _ in range(36 * 96):  # 15분 간격 36일 — 28일 평가 창 전체가 비자명한 예측을 낸다
        at += timedelta(minutes=rng.choice((10, 15, 20)), seconds=rng.randint(0, 120))
        observed = at.astimezone(kst) if mixed_offsets and rng.random() < 0.5 else at
        level = rng.choice((0.0, 0.5, 1.0)) if ties and rng.random() < 0.3 else round(rng.random(), 6)
        points.append(AreaDemandPoint(observed, level, 3))
        if ties and rng.random() < 0.05:  # 같은 순간, 다른 오프셋 표기
            points.append(AreaDemandPoint(observed.astimezone(timezone.utc), round(rng.random(), 3), 2))
    rng.shuffle(points)
    return points


@pytest.mark.parametrize(
    ("seed", "mixed_offsets", "ties"),
    [(1, False, False), (2, True, False), (3, True, True)],
)
def test_backtest_fast_path_equals_reference_bit_for_bit(seed, mixed_offsets, ties):
    """빠른 백테스트는 예전 구현(정의)과 **repr 까지** 같아야 한다 — 근사 금지."""
    points = _backtest_series(seed, mixed_offsets=mixed_offsets, ties=ties)
    expected = forecast_svc._backtest_forecast_points_reference(points)
    actual = backtest_forecast_points(points)
    assert expected["sample_count"] > 30
    assert repr(actual) == repr(expected)


def test_backtest_falls_back_to_reference_for_naive_timestamps(monkeypatch):
    points = [
        AreaDemandPoint(datetime(2026, 8, 1) + timedelta(minutes=15 * i), (i % 7) / 7, 3)
        for i in range(10)
    ]
    calls = []
    real = forecast_svc._backtest_forecast_points_reference
    monkeypatch.setattr(
        forecast_svc, "_backtest_forecast_points_reference",
        lambda pts: calls.append(len(pts)) or real(pts),
    )
    assert backtest_forecast_points(points) == real(points)
    assert calls == [10]


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


def test_the_cache_holds_more_than_one_course_request():
    """코스 한 번이 24개 안팎의 새 키를 밀어 넣는다 — 상한이 그보다 빠듯하면 캐시가 아니다.

    2·3번 자리는 누적 도착(도착 + 체류 40~60분)이 항상 live 지평 30분 밖이라 반드시 이
    이력 경로로 오고, 자리당 MAX_COURSE_CANDIDATES(12)씩 서로 다른 좌표를 훑는다.
    상한이 그 한두 배면 다음 요청이 직전 요청의 항목을 밀어내 TTL 30분이 무의미해진다.
    """
    assert forecast_svc._QUALITY_CACHE_MAX_ENTRIES >= 24 * 4


def test_concurrent_misses_on_the_same_key_run_the_backtest_once(monkeypatch):
    """코스 한 자리의 후보 12곳은 함께 채점된다 — 같은 격자 둘이 동시에 빗나가면 비싼
    백테스트(미스 1건 ≈ 1.3 CPU초)가 두 번 돌았다. 첫 호출만 계산하고 나머지는 그 값을 받는다."""
    import threading

    forecast_svc._quality_cache.clear()
    pts = _points()
    real = forecast_svc.backtest_forecast_points
    calls: list[int] = []
    started = threading.Event()
    release = threading.Event()

    def _slow(points):
        calls.append(1)
        started.set()
        assert release.wait(5)
        return real(points)

    monkeypatch.setattr(forecast_svc, "backtest_forecast_points", _slow)
    results: list = [None] * 4

    def _run(slot: int) -> None:
        results[slot] = forecast_svc._cached_backtest(pts, 35.836, 129.210)

    first = threading.Thread(target=_run, args=(0,))
    first.start()
    assert started.wait(5)
    others = [threading.Thread(target=_run, args=(i,)) for i in range(1, 4)]
    for thread in others:
        thread.start()
    time.sleep(0.05)
    release.set()
    for thread in [first, *others]:
        thread.join(5)

    assert len(calls) == 1, f"같은 키의 백테스트가 {len(calls)}번 돌았다"
    assert all(result is results[0] for result in results)
    assert results[0] == real(pts)
    assert not forecast_svc._quality_inflight


def test_a_failed_backtest_is_not_shared_and_the_next_caller_recomputes(monkeypatch):
    forecast_svc._quality_cache.clear()
    pts = _points()
    real = forecast_svc.backtest_forecast_points

    def _boom(points):
        raise RuntimeError("boom")

    monkeypatch.setattr(forecast_svc, "backtest_forecast_points", _boom)
    with pytest.raises(RuntimeError):
        forecast_svc._cached_backtest(pts, 35.836, 129.210)
    assert not forecast_svc._quality_inflight
    assert not forecast_svc._quality_cache

    monkeypatch.setattr(forecast_svc, "backtest_forecast_points", real)
    assert forecast_svc._cached_backtest(pts, 35.836, 129.210) == real(pts)


def test_the_backtest_cache_survives_concurrent_worker_threads(monkeypatch):
    """to_thread 워커 여러 개가 상한에 닿은 캐시를 동시에 넣고 빼도 예외가 나면 안 된다.

    락이 없으면 한 워커의 min()/items() 순회 중 다른 워커가 삽입·축출해
    RuntimeError('dictionary keys changed during iteration') 나 KeyError 가 났고,
    그 요청 전체가 503 이 됐다(대기판 골든에서 실측). 전환 간격을 극단적으로 줄여
    경합 창을 넓힌다 — 락이 빠지면 이 테스트는 수천 건의 예외로 실패한다.
    """
    import sys
    import threading

    monkeypatch.setattr(
        forecast_svc, "backtest_forecast_points",
        lambda _pts: {"sample_count": 0, "mae": None, "baseline_mae": None, "improvement_rate": None},
    )
    forecast_svc._quality_cache.clear()
    pts = _points(4)
    errors: list[str] = []

    def _worker(tid: int) -> None:
        for i in range(600):
            try:
                forecast_svc._cached_backtest(pts, 35.0 + tid * 0.5 + i * 0.001, 129.0)
            except Exception as exc:  # noqa: BLE001 — 예외 자체가 검사 대상이다
                errors.append(repr(exc))

    previous = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        threads = [threading.Thread(target=_worker, args=(tid,)) for tid in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    finally:
        sys.setswitchinterval(previous)
        forecast_svc._quality_cache.clear()

    assert not errors, f"동시 접근에서 캐시가 깨졌다: {len(errors)}건, 예: {errors[:2]}"


@pytest.mark.asyncio
async def test_the_backtest_runs_off_the_event_loop_and_returns_the_same_result(monkeypatch):
    """비싼 백테스트(후보당 0.28~6.4초)가 이벤트 루프 위에서 동기로 돌면 안 된다.

    Render 무료 플랜은 워커가 하나다 — 여기서 루프를 잡으면 같은 프로세스의 다른 요청까지
    함께 멈추고, 프런트 타임아웃은 20초다. 오프로드는 '어디서 도느냐' 만 바꿔야 하므로
    같은 입력이 같은 출력을 내는지도 함께 잠근다.
    """
    import threading

    async def _resolved(value):
        return value

    def _async_value(value):
        return _resolved(value)

    points = _weekly_points(16)
    monkeypatch.setattr(
        forecast_svc, "_load_points",
        lambda _lat, _lng, _now: _async_value(points),
    )

    real_cached_backtest = forecast_svc._cached_backtest
    ran_on: list[int] = []

    def _spy(pts, lat, lng):
        ran_on.append(threading.get_ident())
        return real_cached_backtest(pts, lat, lng)

    monkeypatch.setattr(forecast_svc, "_cached_backtest", _spy)

    forecast_svc._quality_cache.clear()
    now = datetime(2026, 8, 1, tzinfo=timezone.utc)
    result = await forecast_svc.get_area_demand_forecast_quality(35.836, 129.210, now=now)

    # 추천 경로도 같은 백테스트를 탄다 — 두 진입점 모두 잠근다.
    # (2·3번 자리가 반드시 오는 경로가 바로 이쪽이다.)
    await forecast_svc.get_historical_area_demand_forecast(
        35.836, 129.210, datetime(2026, 8, 3, 1, tzinfo=timezone.utc), now=now
    )

    assert len(ran_on) == 2, f"_cached_backtest 호출 수가 예상과 다르다: {len(ran_on)}"
    loop_thread = threading.get_ident()
    assert all(ident != loop_thread for ident in ran_on), (
        "백테스트가 이벤트 루프 스레드에서 동기로 돌았다 — to_thread 오프로드가 빠졌다"
    )

    # 같은 입력 → 같은 출력. 오프로드가 값을 바꾸지 않는다.
    forecast_svc._quality_cache.clear()
    direct = real_cached_backtest(points, 35.836, 129.210)
    assert direct["sample_count"] > 0, "표본이 0이면 '같은 값' 비교가 무의미하다"
    assert {key: result[key] for key in direct} == direct


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


# ── 격자 캐시 메모리 — 512MB 인스턴스가 OOM 으로 재시작한 경로 ─────────────────
# 2026-09-21: Render nextspot-api(0.5 CPU · 512MB · 단일 워커)가 15~60분마다
# "Ran out of memory" 로 재시작했다. 격자 하나가 그 반경의 스냅샷 전량(실측 4,172점 ·
# 0.46MB)이라 상한 256이면 118MB 다. 아래 테스트들은 (1) 점 하나가 작아진 상태,
# (2) 격자 간 값 공유, (3) 상한과 축출 순서를 잠근다. **값은 하나도 바뀌지 않아야 한다.**


def _shared_rows() -> list[list]:
    """같은 시각·수준을 담은 RPC 행. 호출마다 **새 객체**로 만든다.

    level 을 float 리터럴로 두면 파이썬이 이미 같은 객체를 주므로 인턴 효과를 검증할 수
    없다(테스트가 자기도 모르게 통과한다). 그래서 float("...") 로 매번 새로 만든다.
    """
    return [
        ["2026-08-01T01:00:00+00:00", float("0.25"), 3],
        ["2026-08-01T01:10:00+00:00", float("0.5"), 4],
    ]


def test_two_grids_share_the_same_timestamp_and_level_objects():
    """격자마다 같은 스냅샷 시각을 복제하면 그게 곧 118MB 다 — 한 벌만 들고 공유한다."""
    rows = _shared_rows()
    first = forecast_svc._points_from_payload({"points": _shared_rows()})
    second = forecast_svc._points_from_payload({"points": _shared_rows()})

    for left, right, row in zip(first, second, rows):
        assert left.observed_at is right.observed_at, "격자마다 observed_at 을 새로 만든다"
        assert left.level is right.level, "격자마다 level 을 새로 만든다"
        # 공유해도 값과 표시 문자열은 입력 그대로여야 한다.
        assert left.observed_at.isoformat() == row[0]
        assert left.level == row[1]
        assert left.lot_count == row[2]
    assert first == second

    # reset 이 인턴 표까지 비우지 않으면 테스트 간에 객체가 새어 격리가 깨진다.
    forecast_svc.reset_points_cache()
    third = forecast_svc._points_from_payload({"points": _shared_rows()})
    assert third[0].observed_at is not first[0].observed_at
    assert third == first


def test_interning_never_changes_the_isoformat_of_a_point():
    """aware datetime 의 ==/hash 는 **순간만** 본다 — tzinfo 표기가 다르면 공유하면 안 된다.

    01:00+00:00 과 10:00+09:00 은 같다고 판정되므로 datetime 만 키로 쓰면 먼저 들어온
    쪽의 tzinfo 를 돌려주고, 관리자 응답의 `data_from`·`observed_at` 문자열이 조용히 바뀐다.
    """
    utc = forecast_svc._points_from_payload({"points": [["2026-08-01T01:00:00+00:00", 0.4, 2]]})
    kst = forecast_svc._points_from_payload({"points": [["2026-08-01T10:00:00+09:00", 0.4, 2]]})
    assert utc[0].observed_at == kst[0].observed_at, "같은 순간이 아니면 이 테스트가 무의미하다"
    assert utc[0].observed_at is not kst[0].observed_at
    assert utc[0].observed_at.isoformat() == "2026-08-01T01:00:00+00:00"
    assert kst[0].observed_at.isoformat() == "2026-08-01T10:00:00+09:00"

    # RPC 가 실제로 주는 두 표기("Z" / "+00:00")와 tz 없는 값은 예전처럼 모두 UTC 다.
    same_instant = forecast_svc._points_from_payload({"points": [
        ["2026-08-01T01:00:00Z", 0.4, 2],
        ["2026-08-01T01:00:00", 0.4, 2],
    ]})
    for point in same_instant:
        assert point.observed_at.isoformat() == "2026-08-01T01:00:00+00:00"
        assert point.observed_at is utc[0].observed_at


def test_a_point_has_no_instance_dict_and_stays_frozen():
    """slots 로 __dict__ 를 없애 점 하나가 ~106B → ~65B 가 된다(격자당 4,172점 실측)."""
    observed_at = datetime(2026, 8, 1, 1, tzinfo=timezone.utc)
    positional = AreaDemandPoint(observed_at, 0.4, 2)
    keyword = AreaDemandPoint(observed_at=observed_at, level=0.4, lot_count=2)

    assert not hasattr(positional, "__dict__"), "__dict__ 가 살아 있으면 slots 가 빠졌다"
    assert AreaDemandPoint.__slots__ == ("observed_at", "level", "lot_count")
    assert positional == keyword
    assert hash(positional) == hash(keyword)
    assert {positional, keyword} == {positional}
    with pytest.raises(FrozenInstanceError):
        positional.level = 0.9


def test_the_intern_tables_stay_bounded_and_keep_the_same_values():
    """상한을 넘으면 그냥 비운다 — 공유만 잠시 풀리고 값은 같다(56일 × 144 = 8,064 이니 여유)."""
    forecast_svc.reset_points_cache()
    limit = forecast_svc._INTERN_MAX_ENTRIES
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    started = time.monotonic()
    for index in range(limit + 500):
        moment = base + timedelta(minutes=index)
        level = index / 3.0
        assert forecast_svc._intern_datetime(moment) == moment
        assert forecast_svc._intern_level(level) == level
    assert time.monotonic() - started < 1.0, "인턴이 파싱 경로를 눈에 띄게 느리게 만든다"

    assert len(forecast_svc._datetime_intern) <= limit + 1
    assert len(forecast_svc._level_intern) <= limit + 1

    # 비워진 뒤에도 값·표시 문자열은 그대로.
    again = base + timedelta(minutes=7)
    assert forecast_svc._intern_datetime(again) == again
    assert forecast_svc._intern_datetime(again).isoformat() == again.isoformat()
    assert forecast_svc._intern_level(0.375) == 0.375


def test_the_points_cache_cap_fits_the_512mb_instance():
    """격자 하나가 0.46MB(56일 창이 차면 0.9MB)다 — 상한이 곧 상주 메모리다."""
    cap = forecast_svc._POINTS_CACHE_MAX_ENTRIES
    # 코스 요청 하나가 새 격자 24개 안팎을 만든다. 3회분 미만이면 TTL 5분이 무의미해지고,
    # 128을 넘으면 56일 창이 찬 시점에 100MB 를 넘어 다시 OOM 이다.
    assert 24 * 3 <= cap <= 128
    assert cap == 96


def test_the_points_cache_drops_expired_entries_before_live_ones():
    forecast_svc.reset_points_cache()
    cap = forecast_svc._POINTS_CACHE_MAX_ENTRIES
    ttl = forecast_svc._POINTS_CACHE_TTL_SECONDS
    now = time.monotonic()
    pts = _points(3)

    expired = [(0.0, float(index)) for index in range(3)]
    live = [(1.0, float(index)) for index in range(cap - 3)]
    for key in expired:
        forecast_svc._points_cache[key] = (now - ttl - 10.0, pts)
    for offset, key in enumerate(live):
        forecast_svc._points_cache[key] = (now - 60.0 + offset * 0.001, pts)
    assert len(forecast_svc._points_cache) == cap

    forecast_svc._points_cache_put((2.0, 0.0), pts)

    assert all(key not in forecast_svc._points_cache for key in expired), "만료분이 남았다"
    assert all(key in forecast_svc._points_cache for key in live), "살아 있는 격자가 먼저 나갔다"
    assert (2.0, 0.0) in forecast_svc._points_cache
    assert len(forecast_svc._points_cache) <= cap


def test_the_points_cache_evicts_the_oldest_when_nothing_has_expired():
    """만료분이 없으면 오래된 순으로 버려 상한을 지킨다(무한 성장 = OOM)."""
    forecast_svc.reset_points_cache()
    cap = forecast_svc._POINTS_CACHE_MAX_ENTRIES
    now = time.monotonic()
    pts = _points(3)
    keys = [(3.0, float(index)) for index in range(cap)]
    for offset, key in enumerate(keys):
        forecast_svc._points_cache[key] = (now - 30.0 + offset * 0.001, pts)

    forecast_svc._points_cache_put((4.0, 0.0), pts)

    assert len(forecast_svc._points_cache) <= cap
    assert keys[0] not in forecast_svc._points_cache, "가장 오래된 격자가 남았다"
    assert keys[-1] in forecast_svc._points_cache
    assert (4.0, 0.0) in forecast_svc._points_cache


def _indexed_series(seed: int) -> list[AreaDemandPoint]:
    """자정(KST) 경계·같은 순간의 다른 tz 표기·중복 시각·동률 수준이 섞인 정렬된 시계열."""
    rng = random.Random(seed)
    kst = timezone(timedelta(hours=9))
    start = datetime(2026, 7, 1, 14, 3, 17, tzinfo=timezone.utc)  # 23:03 KST
    points: list[AreaDemandPoint] = []
    at = start
    for step in range(2_500):
        at += timedelta(minutes=rng.choice([1, 7, 10, 10, 13, 31]), seconds=rng.randint(0, 59))
        observed = at.astimezone(kst) if step % 3 == 0 else at
        points.append(AreaDemandPoint(observed, rng.choice([0.0, 0.5, 1.0, round(rng.random(), 2)]), 2))
        if step % 17 == 0:
            other = at if observed is not at else at.astimezone(kst)
            points.append(AreaDemandPoint(other, round(rng.random(), 1), 1))
    points.sort(key=lambda point: point.observed_at)
    return points


def test_indexed_forecast_is_identical_to_the_full_scan():
    """격자 캐시용 색인 경로는 전수 필터와 **같은 dict**(값·float 비트·isoformat·키 순서)를 내야 한다."""
    for seed in (1, 2, 3):
        points = _indexed_series(seed)
        index = forecast_svc._SeriesIndex.build(points)
        assert index is not None
        last = points[-1].observed_at
        nows = [last, last + timedelta(minutes=20), points[len(points) // 2].observed_at,
                points[0].observed_at, last - timedelta(days=3, seconds=1)]
        compared = non_null = 0
        for now in nows:
            for minutes in range(0, 60 * 26, 23):
                arrival = now + timedelta(minutes=minutes)
                expected = forecast_from_points(points, arrival, now=now)
                actual = forecast_svc._forecast_from_points(points, arrival, now, index)
                assert actual == expected and repr(actual) == repr(expected), (seed, now, arrival)
                compared += 1
                non_null += expected is not None
        assert non_null > compared // 3  # 대부분 실제 예측값을 비교했다(모두 None 이면 무의미)


def test_series_index_refuses_inputs_it_cannot_prove_equal():
    points = _indexed_series(4)[:200]
    assert forecast_svc._SeriesIndex.build(list(reversed(points))) is None  # 정렬 안 됨
    naive = [AreaDemandPoint(p.observed_at.replace(tzinfo=None), p.level, 1) for p in points]
    assert forecast_svc._SeriesIndex.build(naive) is None  # naive 시각


def test_series_index_is_only_kept_for_the_cached_list_and_dropped_with_it():
    points = _indexed_series(5)[:300]
    key = (35.836, 129.21)
    assert forecast_svc._series_index_for(key, points) is None  # 캐시에 없는 리스트는 색인하지 않는다
    forecast_svc._points_cache_put(key, points)
    index = forecast_svc._series_index_for(key, points)
    assert index is not None and forecast_svc._series_index_for(key, points) is index
    assert forecast_svc._series_index_for(key, list(points)) is None  # 다른 리스트 객체
    forecast_svc._points_cache_put(key, list(points))
    assert key not in forecast_svc._series_indexes  # 덮어쓰면 함께 버린다
    forecast_svc.reset_points_cache()
    assert not forecast_svc._series_indexes


# ══ 원본 분기(AREA_DEMAND_SOURCE) — 스펙 §8 T27-T32 ══════════════════════════════════════════════════════
# rpc(기본)는 도입 전 경로 그대로여야 하고(T31 원본 고정), matrix 는 같은 좌표에 RPC 경로와 같은 값을 내야 한다(T27·T28).
# 행렬이 답하지 못하면 그 호출만 RPC 경로로 답하고, 다시 답하기 시작하면 RPC 캐시를 비운다(T29). 두 차선(T32).

_P2_END = START + timedelta(days=DAYS)  # 합성 자료의 마지막 버킷 다음(2026-09-28 00:00 UTC)
_P2_NOW = _P2_END + timedelta(minutes=20, seconds=11, microseconds=5)  # 56일 경계가 자료 앞머리를 가른다
_P2_CENTER = (35.8361, 129.2105)
_P2_SECOND = (35.84317, 129.21871)
_P2_FAR = (35.70, 129.0)


class _RecordingLogger:
    """structlog 대신 끼우는 기록기 — (level, event, fields)."""

    def __init__(self) -> None:
        self.events: list[tuple[str, str, dict]] = []

    def __getattr__(self, level):
        if level not in ("debug", "info", "warning", "error", "exception", "critical"):
            raise AttributeError(level)

        def emit(event, **fields):
            self.events.append((level, event, fields))

        return emit

    def named(self, event: str) -> list[dict]:
        return [fields for _, name, fields in self.events if name == event]


@pytest.fixture
def source_env(monkeypatch):
    """분기 시험 — 기록 로거, 그리고 행렬 메모·분기 상태·적재 상태를 시험 앞뒤로 비운다."""
    logs = _RecordingLogger()
    monkeypatch.setattr(forecast_svc, "logger", logs)
    forecast_svc.reset_matrix_memos()
    forecast_svc.reset_source_dispatch()
    ph.reset_for_tests()
    yield logs
    ph.reset_for_tests()
    forecast_svc.reset_matrix_memos()
    forecast_svc.reset_source_dispatch()


def _use_source(monkeypatch, value: str) -> None:
    monkeypatch.setattr(settings, "AREA_DEMAND_SOURCE", value)


def _serve_from(snapshot) -> None:
    """적재 루프 없이 저장소를 '준비됨 · 방금 동기화' 로 만든다(servable 이 이 스냅샷을 준다)."""
    ph._loader.snapshot = snapshot
    ph._loader.ready = True
    ph._loader.last_ok_sync = ph._mono()


@lru_cache(maxsize=2)
def _patterned_snapshot(now: datetime = _P2_NOW):
    """적재 루프의 전량 적재와 같은 병합 — 고치지 말 것(공유)."""
    return ph.merge(None, ph.parse_page(patterned_fixture().rows, aware=forecast_svc._aware), now=now)


def _since_rpc_client() -> _SinceRpcClient:
    fixture = patterned_fixture()
    return _SinceRpcClient(fixture.parents, fixture.lots)


def _expected_since(now: datetime) -> str:
    return (now - timedelta(days=56)).astimezone(timezone.utc).isoformat()


class _NoIO:
    """행렬이 답할 수 있을 때 DB 를 한 번도 부르지 않는지 — 부르면 실패."""

    def __init__(self) -> None:
        self.touched: list[str] = []

    def rpc(self, *_args, **_kwargs):
        self.touched.append("rpc")
        raise AssertionError("matrix 모드가 RPC 를 불렀다")

    def table(self, *_args, **_kwargs):
        self.touched.append("table")
        raise AssertionError("matrix 모드가 테이블을 읽었다")


def _t27_draws() -> list[tuple[float, float, datetime, datetime]]:
    """(위도, 경도, now, 도착) 20개 — 동점(.x5) 아닌 좌표, KST 자정·금→토를 건너는 도착, 56일 경계가 자료를 가르는 now."""
    rng = random.Random(27)
    coordinates = [_P2_CENTER, _P2_SECOND, (35.79, 129.13), north_of(LOTS[1][1], LOTS[1][2], 1999.93), _P2_FAR]
    while len(coordinates) < 10:
        latitude = _P2_CENTER[0] + rng.uniform(-0.012, 0.012)
        longitude = _P2_CENTER[1] + rng.uniform(-0.015, 0.015)
        if not _is_tie(latitude, longitude):
            coordinates.append((latitude, longitude))
    nows = (_P2_NOW, NOW_EDGE, NOW_EDGE + timedelta(days=2, hours=5, minutes=7, microseconds=3))
    draws = []
    for k in range(20):
        latitude, longitude = coordinates[k % len(coordinates)]
        now = nows[k % len(nows)]
        day = now.replace(hour=0, minute=0, second=0, microsecond=0)
        special = {
            3: day + timedelta(hours=14, minutes=55),  # 23:55 KST
            4: day + timedelta(hours=15, minutes=5),  # 00:05 KST(다음 날)
            8: datetime(2026, 10, 2, 14, 50, tzinfo=timezone.utc),  # 금 23:50 KST
            9: datetime(2026, 10, 2, 15, 10, tzinfo=timezone.utc),  # 토 00:10 KST
        }
        arrival = special.get(k, now + timedelta(minutes=rng.uniform(30, 360)))
        assert arrival > now
        draws.append((latitude, longitude, now, arrival))
    return draws


# ── T27 ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_matrix_forecast_equals_rpc_path_for_the_same_coordinate(monkeypatch, source_env):
    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    snapshot = _patterned_snapshot()
    real_matrix_forecast = forecast_svc._matrix_forecast
    offloaded: list[tuple[float, float]] = []

    def _spy(snap, latitude, longitude, arrival, now):
        offloaded.append((latitude, longitude))
        return real_matrix_forecast(snap, latitude, longitude, arrival, now)

    monkeypatch.setattr(forecast_svc, "_matrix_forecast", _spy)
    usable = 0
    for latitude, longitude, now, arrival in _t27_draws():
        assert not _is_tie(latitude, longitude)
        forecast_svc.reset_points_cache()
        forecast_svc._quality_cache.clear()
        _use_source(monkeypatch, "rpc")
        calls = len(client.calls)
        expected = await forecast_svc.get_historical_area_demand_forecast(latitude, longitude, arrival, now=now)
        assert len(client.calls) == calls + 1
        assert client.calls[-1]["p_since"] == _expected_since(now)
        assert (client.calls[-1]["p_latitude"], client.calls[-1]["p_longitude"]) == (latitude, longitude)

        _use_source(monkeypatch, "matrix")
        _serve_from(snapshot)
        got = await forecast_svc.get_historical_area_demand_forecast(latitude, longitude, arrival, now=now)
        offloaded_before = len(offloaded)
        again = await forecast_svc.get_historical_area_demand_forecast(latitude, longitude, arrival, now=now)
        assert len(client.calls) == calls + 1, "matrix 모드가 RPC 를 불렀다"
        assert repr(got) == repr(expected), (latitude, longitude, now, arrival)
        assert repr(again) == repr(expected)
        if expected is not None:
            usable += 1
            # 메모가 모두 맞는 두 번째 호출은 스레드로 넘기지 않고 이벤트 루프에서 바로 답한다.
            assert len(offloaded) == offloaded_before
    assert usable >= 12, f"쓸 만한 전망이 {usable}/20 뿐이면 비교가 공허하다"
    assert forecast_svc._fallback_served == 0
    assert not source_env.named("area_demand_source_fallback")


# ── T28 ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("now", (_P2_NOW, NOW_EDGE))
async def test_matrix_quality_equals_rpc_quality(monkeypatch, source_env, now):
    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    snapshot = _patterned_snapshot()
    for latitude, longitude in (_P2_CENTER, (35.79, 129.13), north_of(LOTS[1][1], LOTS[1][2], 2000.02), _P2_FAR):
        forecast_svc.reset_points_cache()
        forecast_svc._quality_cache.clear()
        _use_source(monkeypatch, "rpc")
        expected = await forecast_svc.get_area_demand_forecast_quality(latitude, longitude, now=now)
        assert client.calls[-1]["p_since"] == _expected_since(now)
        _use_source(monkeypatch, "matrix")
        _serve_from(snapshot)
        calls = len(client.calls)
        got = await forecast_svc.get_area_demand_forecast_quality(latitude, longitude, now=now)
        assert len(client.calls) == calls
        assert repr(got) == repr(expected), (latitude, longitude)
        assert {"point_count", "data_from", "data_to", "usable"} <= set(got)
        if (latitude, longitude) == _P2_FAR:
            assert got["point_count"] == 0 and got["data_from"] is None and got["usable"] is False
        elif (latitude, longitude) == _P2_CENTER:
            assert got["usable"] is True and got["point_count"] > 6_000


# ── T29 ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_matrix_mode_falls_back_when_not_ready_then_clears_rpc_caches(monkeypatch, source_env):
    logs = source_env
    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    latitude, longitude = _P2_CENTER
    now, arrival = _P2_NOW, _P2_NOW + timedelta(minutes=90)

    _use_source(monkeypatch, "rpc")
    expected = await forecast_svc.get_historical_area_demand_forecast(latitude, longitude, arrival, now=now)
    assert expected is not None
    forecast_svc.reset_points_cache()
    forecast_svc._quality_cache.clear()

    # 1) 저장소가 비어 있다 → RPC 경로로 답한다(값은 rpc 모드와 같다).
    _use_source(monkeypatch, "matrix")
    got = await forecast_svc.get_historical_area_demand_forecast(latitude, longitude, arrival, now=now)
    assert len(client.calls) == 2 and client.calls[-1]["p_since"] == _expected_since(now)
    assert repr(got) == repr(expected)
    assert [f["reason"] for f in logs.named("area_demand_source_fallback")] == ["not_ready"]
    assert forecast_svc._fallback_served == 1
    assert forecast_svc._health_extra()["fallback_served"] == 1
    grid = forecast_svc._grid_key(latitude, longitude)
    assert grid in forecast_svc._points_cache and grid in forecast_svc._series_indexes
    assert len(forecast_svc._quality_cache) == 1
    lock = forecast_svc._points_locks[grid]

    # 2) 저장소가 준비됐다 → 행렬이 답하고, 그 첫 호출이 RPC 캐시를 비운다(_points_locks 는 그대로).
    _serve_from(_patterned_snapshot())
    served = await forecast_svc.get_historical_area_demand_forecast(latitude, longitude, arrival, now=now)
    assert len(client.calls) == 2
    assert repr(served) == repr(expected)
    assert len(forecast_svc._points_cache) == len(forecast_svc._series_indexes) == len(forecast_svc._quality_cache) == 0
    assert not forecast_svc._datetime_intern and not forecast_svc._level_intern
    assert forecast_svc._points_locks[grid] is lock
    assert logs.named("area_demand_rpc_caches_cleared") == [{"points_entries": 1, "quality_entries": 1}]
    assert forecast_svc._fallback_served == 1

    # 3) 폴백이 진행 중일 때 행렬이 다시 답해도 비우지 않는다 — 그 폴백이 끝나며 캐시를 채우므로, 끝난 뒤 첫 호출이 비운다.
    release, entered = threading.Event(), threading.Event()

    def _hold(_params):
        entered.set()
        assert release.wait(10)

    client.before_execute = _hold
    ph._loader.last_ok_sync = ph._mono() - (ph.SERVABLE_MAX_SYNC_AGE_S + 1)  # 오래됨 → 폴백
    other = _P2_SECOND
    pending = asyncio.create_task(
        forecast_svc.get_historical_area_demand_forecast(*other, arrival, now=now)
    )
    assert await asyncio.to_thread(entered.wait, 10)
    assert forecast_svc._rpc_fallback_inflight == 1
    _serve_from(_patterned_snapshot())  # 동기화 회복
    during = await forecast_svc.get_historical_area_demand_forecast(latitude, longitude, arrival, now=now)
    assert repr(during) == repr(expected)
    assert forecast_svc._rpc_caches_dirty is True
    assert len(logs.named("area_demand_rpc_caches_cleared")) == 1
    release.set()
    fallback_value = await pending
    assert forecast_svc._rpc_fallback_inflight == 0
    other_grid = forecast_svc._grid_key(*other)
    assert other_grid in forecast_svc._points_cache  # 끝난 폴백이 채웠다
    after = await forecast_svc.get_historical_area_demand_forecast(*other, arrival, now=now)
    assert repr(after) == repr(fallback_value)
    assert not forecast_svc._points_cache and not forecast_svc._quality_cache
    assert forecast_svc._rpc_caches_dirty is False
    assert len(logs.named("area_demand_rpc_caches_cleared")) == 2
    assert [f["reason"] for f in logs.named("area_demand_source_fallback")] == ["not_ready", "stale"]
    assert forecast_svc._fallback_served == 2
    assert len(client.calls) == 3


def test_fallback_log_is_rate_limited_per_reason(source_env):
    logs = source_env
    for _ in range(5):
        forecast_svc._log_fallback("not_ready")
    forecast_svc._log_fallback("stale")
    assert logs.named("area_demand_source_fallback") == [
        {"reason": "not_ready", "suppressed": 0}, {"reason": "stale", "suppressed": 0},
    ]
    at, suppressed = forecast_svc._fallback_logged["not_ready"]
    assert suppressed == 4
    forecast_svc._fallback_logged["not_ready"] = (at - forecast_svc._FALLBACK_LOG_INTERVAL_S - 1, suppressed)
    forecast_svc._log_fallback("not_ready")
    assert logs.named("area_demand_source_fallback")[-1] == {"reason": "not_ready", "suppressed": 4}


# ── T30 ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_matrix_mode_never_calls_rpc_when_servable(monkeypatch, source_env):
    no_io = _NoIO()
    monkeypatch.setattr(forecast_svc, "supabase_admin", no_io)
    monkeypatch.setattr(forecast_svc, "fetch_all_rows", no_io.table)
    _use_source(monkeypatch, "matrix")
    snapshot = _patterned_snapshot()
    _serve_from(snapshot)
    now = _P2_NOW
    forecast = await forecast_svc.get_historical_area_demand_forecast(
        *_P2_CENTER, now + timedelta(minutes=45), now=now
    )
    assert forecast is not None and forecast["validation"]["sample_count"] >= 30
    quality = await forecast_svc.get_area_demand_forecast_quality(*_P2_CENTER, now=now)
    assert repr(quality) == repr(forecast_svc._matrix_quality(snapshot, *_P2_CENTER, now))
    assert await forecast_svc.prefetch_area_demand_points([_P2_CENTER, _P2_SECOND, _P2_FAR], now=now) == 0
    assert no_io.touched == []
    assert not forecast_svc._points_cache and not forecast_svc._quality_cache
    assert forecast_svc._fallback_served == 0 and not source_env.named("area_demand_source_fallback")
    extra = forecast_svc._health_extra()
    assert extra["memo"] == {"series": 1, "near": 1, "quality": 1} and extra["fallback_served"] == 0


@pytest.mark.asyncio
async def test_far_coordinate_returns_none_without_io(monkeypatch, source_env):
    no_io = _NoIO()
    monkeypatch.setattr(forecast_svc, "supabase_admin", no_io)
    _use_source(monkeypatch, "matrix")
    _serve_from(_patterned_snapshot())
    now = _P2_NOW
    assert await forecast_svc.get_historical_area_demand_forecast(*_P2_FAR, now + timedelta(hours=2), now=now) is None
    quality = await forecast_svc.get_area_demand_forecast_quality(*_P2_FAR, now=now)
    assert quality["point_count"] == 0 and quality["usable"] is False and quality["sample_count"] == 0
    assert no_io.touched == [] and forecast_svc._fallback_served == 0


@pytest.mark.asyncio
async def test_matrix_failure_falls_back_to_rpc(monkeypatch, source_env):
    logs = source_env
    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    now, arrival = _P2_NOW, _P2_NOW + timedelta(minutes=120)
    _use_source(monkeypatch, "rpc")
    expected = await forecast_svc.get_historical_area_demand_forecast(*_P2_CENTER, arrival, now=now)
    expected_quality = await forecast_svc.get_area_demand_forecast_quality(*_P2_CENTER, now=now)
    forecast_svc.reset_points_cache()
    forecast_svc._quality_cache.clear()

    def _boom(*_args, **_kwargs):
        raise RuntimeError("kernel bug at 35.8361")

    monkeypatch.setattr(forecast_svc, "_matrix_forecast", _boom)
    monkeypatch.setattr(forecast_svc, "_matrix_quality", _boom)
    _use_source(monkeypatch, "matrix")
    _serve_from(_patterned_snapshot())
    got = await forecast_svc.get_historical_area_demand_forecast(*_P2_CENTER, arrival, now=now)
    got_quality = await forecast_svc.get_area_demand_forecast_quality(*_P2_CENTER, now=now)
    assert repr(got) == repr(expected) and repr(got_quality) == repr(expected_quality)
    failed = logs.named("area_demand_matrix_failed")
    assert [(f["kind"], f["error_type"]) for f in failed] == [("forecast", "RuntimeError"), ("quality", "RuntimeError")]
    assert [f["reason"] for f in logs.named("area_demand_source_fallback")] == ["matrix_failed"]
    assert forecast_svc._fallback_served == 2
    assert forecast_svc._rpc_caches_dirty is True


@pytest.mark.asyncio
async def test_prefetch_warms_the_rpc_path_only_when_matrix_cannot_answer(monkeypatch, source_env):
    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    _use_source(monkeypatch, "matrix")  # 저장소 비어 있음
    now = _P2_NOW
    filled = await forecast_svc.prefetch_area_demand_points([_P2_CENTER, _P2_SECOND], now=now)
    assert filled == 2 and len(client.calls) == 2
    assert all(call["p_since"] == _expected_since(now) for call in client.calls)
    assert forecast_svc._fallback_served == 0  # 예열은 답이 아니다
    assert [f["reason"] for f in source_env.named("area_demand_source_fallback")] == ["not_ready"]
    assert forecast_svc._rpc_caches_dirty is True and forecast_svc._rpc_fallback_inflight == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ("rpc", "off", "", " RPC "))
async def test_non_matrix_modes_never_touch_the_matrix_path(monkeypatch, source_env, source):
    """rpc(기본)·모르는 값은 도입 전 경로 그대로 — 행렬·적재·차선을 건드리지 않는다(shadow 는 shadow 시험이 본다)."""

    def _forbidden(*_args, **_kwargs):
        raise AssertionError("rpc 경로가 행렬 쪽을 건드렸다")

    for name in ("servable", "ensure_running", "current"):
        monkeypatch.setattr(ph, name, _forbidden)
    for name in ("_serve_matrix_forecast", "_serve_matrix_quality", "_matrix_servable", "_lane", "_matrix_forecast"):
        monkeypatch.setattr(forecast_svc, name, _forbidden)
    client = _since_rpc_client()
    monkeypatch.setattr(forecast_svc, "supabase_admin", client)
    _use_source(monkeypatch, source)
    now = _P2_NOW
    forecast = await forecast_svc.get_historical_area_demand_forecast(
        *_P2_CENTER, now + timedelta(minutes=60), now=now, interactive=True
    )
    quality = await forecast_svc.get_area_demand_forecast_quality(*_P2_CENTER, now=now)
    filled = await forecast_svc.prefetch_area_demand_points([_P2_SECOND], now=now)
    assert forecast is not None and quality["usable"] is True and filled == 1
    assert len(client.calls) == 2  # 격자 캐시 그대로(같은 격자는 한 번)
    assert forecast_svc._fallback_served == 0 and forecast_svc._lanes is None
    assert source_env.events == [("info", "area_demand_prefetch", {"grids": 1, "requested": 1})]


# ── T31 ──────────────────────────────────────────────────────────────────────
# RPC 경로의 원본을 고정한다. P2b 에서 삭제; 바꾸려면 PM 승인.
# 해시는 구현 시점에 계산해 박았다(sha256, 줄바꿈 '\n'). 모두 production main(3cf5bf9)의 같은 부분과도 같다:
#   · 전체: inspect.getsource 의 정의 첫 줄부터 끝까지.
#   · 독스트링 뒤: 독스트링에 lockstep 안내 한 줄만 더한 두 함수(aggregate_nearby_points · backtest_forecast_points).
#   · _rpc_*: 정의 줄(시그니처) 뒤 전부 — 3cf5bf9 의 같은 이름 공개 함수 본문(독스트링 포함)과 같은 해시.

_PINNED_ALL = {
    "_load_points": "28aeb48c9165941e1879c50596e0700b4f4bf1b15a2822f2b800520f7d286466",
    "_load_points_uncached": "6e873de61154ae2549277a6d412dffb5a9b2ee32c084f537d1516399085209dc",
    "_fetch_points_via_rpc": "f5f2d6a31b9fc9f552772042f6b6f5c128ed2be3bfa0955c16ac115382cd49c2",
    "_points_from_payload": "370a8911f52e6a4500c39c4393f529bcfbb65a919d6e8970de58fa750a07bd69",
    "_load_raw_history": "6eb31842ca78879d7e5b2b2ab4cb3c79b43ee9d057a24c80f118c795755c4425",
    "_cached_backtest": "d676cdddff4f93edb8979a2d1a23e6a41e11e9e51bd5dd629bf232e34a962dab",
    "_backtest_forecast_level": "5db6416bd2e268efbf0fe0c0df4d3f1b5c596e910745137b043a1f7c5aba0f7f",
    "_forecast_from_points": "c17bddbf4ed8c9fe3b0574b2bea1bd51c92f8ae9e220bcbca6c81ee28ea71308",
    "_SeriesIndex": "5198e616d2cbc09e0edf9318bcb2633a97e12a0720fb0acb2a4aabaeb5738e1c",
}
_PINNED_AFTER_DOCSTRING = {
    "aggregate_nearby_points": "2467f22fea1a9a428567d682ab2371b0fb809fbc2e151c4f2503bd1f11cdc153",
    "backtest_forecast_points": "c021f4ade532bd178318f056b492ef1c223b76578ff33b4f40877a8360f4ee8b",
}
_PINNED_RPC_BODIES = {  # 3cf5bf9 의 get_historical_area_demand_forecast · get_area_demand_forecast_quality · prefetch_area_demand_points
    "_rpc_get_historical_area_demand_forecast": "59ca496e21f23518cbfccbd87525ce4bb053ffdbad2e1ac25d570f9d29374e3f",
    "_rpc_get_area_demand_forecast_quality": "9211236418904ab66eebf444daa7a2985dbf634e58d53eaab8463b709e4bf21c",
    "_rpc_prefetch_area_demand_points": "6d56d23de4d9e47046af3b9d42a316c8ff3e10e17d094577f2afa3ee0e339c9f",
}


def _source_hash(obj, part: str) -> str:
    source = inspect.getsource(obj)
    node = ast.parse(source).body[0]
    first = {"all": node.lineno, "body": node.body[0].lineno, "after_docstring": node.body[1].lineno}[part]
    text = "\n".join(source.splitlines()[first - 1:node.end_lineno])
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def test_rpc_path_source_is_pinned():
    changed = [name for name, digest in _PINNED_ALL.items()
               if _source_hash(getattr(forecast_svc, name), "all") != digest]
    changed += [name for name, digest in _PINNED_AFTER_DOCSTRING.items()
                if _source_hash(getattr(forecast_svc, name), "after_docstring") != digest]
    changed += [name for name, digest in _PINNED_RPC_BODIES.items()
                if _source_hash(getattr(forecast_svc, name), "body") != digest]
    assert not changed, f"RPC 경로 원본이 바뀌었다(P2b 전에는 PM 승인 없이 바꾸지 않는다): {changed}"
    # 옮긴 본문의 시그니처도 도입 전 공개 함수와 같다(interactive 는 공개 분기에만 있다).
    assert str(inspect.signature(forecast_svc._rpc_get_historical_area_demand_forecast)) == (
        "(latitude: 'float', longitude: 'float', arrival: 'datetime', *, now: 'datetime | None' = None)"
        " -> 'dict[str, Any] | None'"
    )
    assert str(inspect.signature(forecast_svc._rpc_get_area_demand_forecast_quality)) == (
        "(latitude: 'float', longitude: 'float', *, now: 'datetime | None' = None) -> 'dict[str, Any]'"
    )
    assert str(inspect.signature(forecast_svc._rpc_prefetch_area_demand_points)) == (
        "(coordinates: 'list[tuple[float, float]]', *, now: 'datetime | None' = None,"
        " max_concurrency: 'int' = 6) -> 'int'"
    )


# ── T32 ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_interactive_lane_is_not_queued_behind_ranking(monkeypatch, source_env):
    _use_source(monkeypatch, "matrix")
    _serve_from(_patterned_snapshot())
    interactive_coordinate = (35.8400, 129.2100)
    active = {"ranking": 0, "interactive": 0}
    peak = dict(active)
    guard = threading.Lock()

    def _slow(_snapshot, latitude, longitude, _arrival, _now):
        lane = "interactive" if (latitude, longitude) == interactive_coordinate else "ranking"
        with guard:
            active[lane] += 1
            peak[lane] = max(peak[lane], active[lane])
        try:
            time.sleep(0.3 if lane == "ranking" else 0.05)
        finally:
            with guard:
                active[lane] -= 1
        return None

    monkeypatch.setattr(forecast_svc, "_matrix_forecast", _slow)
    now = _P2_NOW
    arrival = now + timedelta(minutes=60)
    ranking = [
        asyncio.create_task(forecast_svc.get_historical_area_demand_forecast(
            35.83 + index * 1e-4, 129.21, arrival, now=now
        ))
        for index in range(36)
    ]
    await asyncio.sleep(0.05)  # 채점 차선이 찼다(2개 계산 중, 34개 대기)
    started = time.perf_counter()
    result = await forecast_svc.get_historical_area_demand_forecast(
        *interactive_coordinate, arrival, now=now, interactive=True
    )
    elapsed = time.perf_counter() - started
    assert result is None
    assert elapsed < 1.0, f"대기 화면 호출이 채점 뒤에 줄 섰다: {elapsed:.2f}s"
    assert not all(task.done() for task in ranking)
    await asyncio.gather(*ranking)
    assert peak == {"ranking": 2, "interactive": 1}
    assert forecast_svc._fallback_served == 0
