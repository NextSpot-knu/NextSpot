"""빠른 백테스트가 명세 구현과 **비트 단위로 같은 값**을 내는지 고정한다.

`backtest_forecast_points` 는 운영 경로의 CPU 대부분을 쓰던 함수를 증분 계산으로 바꾼 것이다.
응답에는 백테스트 숫자가 직접 실리지 않고 `usable` 판정만 바꾸므로, HTTP 골든만으로는 작은
오차를 놓칠 수 있다. 그래서 함수 수준에서 dict 와 repr(부동소수 비트)을 함께 비교한다.
"""

import random
from datetime import datetime, timedelta, timezone

import pytest

from app.services import area_demand_forecast_service as forecast_svc
from app.services.area_demand_forecast_service import AreaDemandPoint

KST = timezone(timedelta(hours=9))


def _series(
    rng: random.Random,
    count: int,
    *,
    tz_mix: bool = False,
    ties: bool = False,
    steps: tuple[int, ...] = (10, 15),
    gap_p: float = 0.01,
    weekend_only: bool = False,
    bounds: bool = False,
) -> list[AreaDemandPoint]:
    at = datetime(2026, 8, 1, tzinfo=timezone.utc) + timedelta(minutes=rng.randint(0, 1440))
    points: list[AreaDemandPoint] = []
    for _ in range(count):
        at += timedelta(minutes=rng.choice(steps), seconds=rng.randint(0, 200))
        if rng.random() < gap_p:
            at += timedelta(hours=rng.randint(1, 72))
        if weekend_only:
            while at.astimezone(KST).weekday() < 5:
                at += timedelta(days=1)
        observed = at.astimezone(KST) if tz_mix and rng.random() < 0.5 else at
        if bounds and rng.random() < 0.3:
            level = rng.choice([0.0, 1.0, 0.5])
        else:
            level = round(rng.random(), 6)
        points.append(AreaDemandPoint(observed, level, 4))
        if ties and rng.random() < 0.1:
            points.append(AreaDemandPoint(observed, round(rng.random(), 6), 3))
    rng.shuffle(points)
    return points


def _assert_same(points: list[AreaDemandPoint]) -> dict:
    expected = forecast_svc._backtest_forecast_points_reference(points)
    actual = forecast_svc.backtest_forecast_points(points)
    assert repr(actual) == repr(expected)
    return actual


_VARIANTS = [
    {},
    {"tz_mix": True},
    {"ties": True},
    {"tz_mix": True, "ties": True, "bounds": True},
    {"weekend_only": True, "steps": (10,)},
    {"gap_p": 0.2, "steps": (15, 30, 60)},
]


@pytest.mark.parametrize("variant", range(len(_VARIANTS)))
def test_fast_backtest_matches_reference_on_adversarial_series(variant):
    rng = random.Random(1000 + variant)
    nontrivial = 0
    for count in (0, 1, 5, 9, 30, 200, 900, 1600):
        result = _assert_same(_series(rng, count, **_VARIANTS[variant]))
        nontrivial += bool(result["sample_count"])
    assert nontrivial >= 1


def test_fast_backtest_matches_reference_on_regular_ten_minute_history():
    # 운영과 같은 모양: 10분 간격, 6주, 최근 28일이 평가 구간.
    start = datetime(2026, 8, 20, 15, tzinfo=timezone.utc)
    rng = random.Random(7)
    points = [
        AreaDemandPoint(start + timedelta(minutes=10 * i), round(rng.random(), 4), 5)
        for i in range(6 * 7 * 144)
    ]
    result = _assert_same(points)
    assert result["sample_count"] > 300


def test_naive_and_nan_inputs_fall_back_to_reference():
    rng = random.Random(3)
    aware = _series(rng, 400)
    naive = [AreaDemandPoint(p.observed_at.replace(tzinfo=None), p.level, p.lot_count) for p in aware]
    _assert_same(naive)
    with_nan = [
        AreaDemandPoint(p.observed_at, float("nan") if i % 37 == 0 else p.level, p.lot_count)
        for i, p in enumerate(aware)
    ]
    _assert_same(with_nan)
