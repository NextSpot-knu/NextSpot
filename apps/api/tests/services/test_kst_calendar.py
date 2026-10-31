"""KST 달력·시간대 평균 도우미(app/services/kst_calendar.py) — S4 재생과 검증 지표가 같은 정의를 쓰는가.

네트워크·DB 없이 순수 함수만 본다. 기준 시각은 전부 KST 로 적는다(서울 현장 시각).
"""
from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

import pytest

from app.services import kst_calendar as kc

from app.services.kst_calendar import (
    HOLIDAY_COVERAGE,
    KR_PUBLIC_HOLIDAYS,
    KST,
    WEEKDAY,
    WEEKEND,
    Climatology,
    climatology,
    climatology_key,
    day_type,
    is_kr_public_holiday,
    kst_date,
    service_day,
    to_kst,
)

UTC = timezone.utc


def _kst(y: int, mo: int, d: int, h: int = 0, mi: int = 0) -> datetime:
    return datetime(y, mo, d, h, mi, tzinfo=KST)


@dataclass(frozen=True)
class P:
    at: datetime
    v: float | None
    zone: str = "a"


def _build(points, mode, **kwargs) -> Climatology:
    return climatology(points, value=lambda p: p.v, time=lambda p: p.at, mode=mode, **kwargs)


# ── KST · 서비스 날짜 ─────────────────────────────────────────────────────────


def test_to_kst_converts_aware_and_treats_naive_as_kst():
    assert to_kst(datetime(2026, 10, 1, 0, 0, tzinfo=UTC)) == _kst(2026, 10, 1, 9)
    assert to_kst(datetime(2026, 10, 1, 0, 0, tzinfo=UTC)).utcoffset() == timedelta(hours=9)
    assert to_kst(datetime(2026, 10, 1, 7, 30)) == _kst(2026, 10, 1, 7, 30)


def test_to_kst_rejects_non_datetime():
    with pytest.raises(TypeError):
        to_kst(date(2026, 10, 1))  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        to_kst("2026-10-01T00:00:00+09:00")  # type: ignore[arg-type]


def test_kst_date_uses_seoul_calendar_not_utc():
    # UTC 10-01 16:00 = KST 10-02 01:00
    assert kst_date(datetime(2026, 10, 1, 16, 0, tzinfo=UTC)) == date(2026, 10, 2)


def test_service_day_boundary_0459_vs_0500_kst():
    assert service_day(_kst(2026, 10, 10, 4, 59)) == date(2026, 10, 9)
    assert service_day(_kst(2026, 10, 10, 5, 0)) == date(2026, 10, 10)
    assert service_day(_kst(2026, 10, 10, 23, 59)) == date(2026, 10, 10)
    # 같은 순간을 UTC 로 줘도 같은 서비스 날짜다(04:59 KST = 전날 19:59 UTC).
    assert service_day(datetime(2026, 10, 9, 19, 59, tzinfo=UTC)) == date(2026, 10, 9)
    assert service_day(datetime(2026, 10, 9, 20, 0, tzinfo=UTC)) == date(2026, 10, 10)


def test_service_day_custom_cut_hour():
    assert service_day(_kst(2026, 10, 10, 2, 59), cut_hour=3) == date(2026, 10, 9)
    assert service_day(_kst(2026, 10, 10, 3, 0), cut_hour=3) == date(2026, 10, 10)
    assert service_day(_kst(2026, 10, 10, 0, 0), cut_hour=0) == date(2026, 10, 10)
    with pytest.raises(ValueError):
        service_day(_kst(2026, 10, 10), cut_hour=24)


# ── 공휴일 · 요일 구분 ────────────────────────────────────────────────────────


def test_holiday_list_covers_window_and_known_dates():
    start, end = HOLIDAY_COVERAGE
    assert start <= date(2026, 9, 1) and end >= date(2027, 2, 28)
    for d in (
        date(2026, 9, 24), date(2026, 9, 25), date(2026, 9, 26),  # 추석 연휴
        date(2026, 10, 3), date(2026, 10, 5),  # 개천절 · 대체공휴일
        date(2026, 10, 9), date(2026, 12, 25), date(2027, 1, 1),
    ):
        assert d in KR_PUBLIC_HOLIDAYS
    assert any(date(2027, 2, 5) <= d <= date(2027, 2, 10) for d in KR_PUBLIC_HOLIDAYS)  # 2027 설 연휴
    assert all(start <= d <= end for d in KR_PUBLIC_HOLIDAYS)
    assert isinstance(KR_PUBLIC_HOLIDAYS, frozenset)


def test_weekday_holiday_counts_as_weekend():
    # 2026-10-05(월) 개천절 대체공휴일, 2026-10-09(금) 한글날, 2026-09-24(목) 추석 연휴
    for d in (date(2026, 10, 5), date(2026, 10, 9), date(2026, 9, 24)):
        assert d.weekday() < 5
        assert is_kr_public_holiday(d)
        assert day_type(d) == WEEKEND
        assert day_type(datetime(d.year, d.month, d.day, 14, 0, tzinfo=KST)) == WEEKEND


def test_plain_days():
    assert day_type(date(2026, 10, 6)) == WEEKDAY  # 화
    assert day_type(date(2026, 10, 10)) == WEEKEND  # 토
    assert day_type(date(2026, 10, 11)) == WEEKEND  # 일
    assert not is_kr_public_holiday(date(2026, 10, 6))


def test_day_type_of_datetime_uses_kst_date():
    # UTC 금 15:30 = KST 토 00:30 → 주말
    assert day_type(datetime(2026, 10, 16, 15, 30, tzinfo=UTC)) == WEEKEND
    assert climatology_key(datetime(2026, 10, 16, 15, 30, tzinfo=UTC)) == (0, WEEKEND)
    assert climatology_key(_kst(2026, 10, 6, 13, 50)) == (13, WEEKDAY)


# ── climatology: 공통 ─────────────────────────────────────────────────────────

# 평일(화·수·목) 14시 칸 하나에 날마다 값 1개씩.
_TUE, _WED, _THU, _FRI = date(2026, 10, 13), date(2026, 10, 14), date(2026, 10, 15), date(2026, 10, 16)


def _at(d: date, h: int = 14, mi: int = 0) -> datetime:
    return datetime(d.year, d.month, d.day, h, mi, tzinfo=KST)


def _week_points() -> list[P]:
    return [P(_at(_TUE), 1.0), P(_at(_WED), 2.0), P(_at(_THU), 4.0), P(_at(_FRI), 8.0)]


def test_unknown_mode_and_bad_arguments_raise():
    pts = _week_points()
    with pytest.raises(ValueError):
        _build(pts, "median", min_samples=1)
    with pytest.raises(ValueError):
        _build(pts, "lodo", min_samples=0)
    with pytest.raises(ValueError):
        _build(pts, "train_dates", min_samples=1)  # train_dates 누락
    with pytest.raises(ValueError):
        _build(pts, "lodo", min_samples=1, train_dates=[_TUE])  # 다른 모드에 train_dates


def test_cells_keyed_by_hour_and_day_type():
    pts = _week_points() + [P(_at(_WED, 15), 100.0), P(_at(date(2026, 10, 17)), 50.0)]  # 15시 · 토요일
    clim = _build(pts, "train_dates", min_samples=1, train_dates=[_TUE, _WED, _THU, _FRI, date(2026, 10, 17)])
    assert clim.value_at(_at(date(2026, 10, 20))) == pytest.approx((1 + 2 + 4 + 8) / 4)
    assert clim.value_at(_at(date(2026, 10, 20), 15)) == pytest.approx(100.0)
    assert clim.value_at(_at(date(2026, 10, 18))) == pytest.approx(50.0)  # 일요일 → 주말 칸
    assert clim.value_at(_at(date(2026, 10, 9))) == pytest.approx(50.0)  # 금 한글날 → 주말 칸
    assert clim.value_at(_at(date(2026, 10, 20), 3)) is None  # 빈 칸


def test_same_hour_different_minutes_share_a_cell():
    pts = [P(_at(_TUE, 14, 0), 1.0), P(_at(_TUE, 14, 50), 3.0)]
    clim = _build(pts, "train_dates", min_samples=2, train_dates=[_TUE])
    assert clim.value_at(_at(_WED, 14, 20)) == pytest.approx(2.0)


def test_none_and_non_finite_values_are_skipped():
    pts = _week_points() + [P(_at(_TUE), None), P(_at(_WED), float("nan")), P(_at(_THU), float("inf"))]
    clim = _build(pts, "train_dates", min_samples=4, train_dates=[_TUE, _WED, _THU, _FRI])
    assert clim.value_at(_at(date(2026, 10, 20))) == pytest.approx(3.75)
    assert clim.stats_at(_at(date(2026, 10, 20))).n == 4


def test_points_with_missing_time_are_skipped():
    pts = _week_points()
    clim = climatology(
        pts + [P(_at(_TUE), 99.0)],
        value=lambda p: p.v,
        time=lambda p: None if p.v == 99.0 else p.at,
        mode="train_dates",
        min_samples=1,
        train_dates=[_TUE],
    )
    assert clim.value_at(_at(_WED)) == pytest.approx(1.0)


# ── climatology: lodo ─────────────────────────────────────────────────────────


def test_lodo_excludes_own_date():
    clim = _build(_week_points(), "lodo", min_samples=1)
    # 수요일 점: 화·목·금만 → (1+4+8)/3
    assert clim(P(_at(_WED), 2.0)) == pytest.approx(13 / 3)
    assert clim(P(_at(_TUE, 14, 30), 1.0)) == pytest.approx(14 / 3)
    # 데이터에 없는 날짜는 아무것도 빠지지 않는다.
    assert clim.value_at(_at(date(2026, 10, 20))) == pytest.approx(15 / 4)
    # LODO 는 뒤 날짜도 쓴다(화요일 기준값에 목·금이 들어간다) — '그때 가질 수 있던 것보다 강한' 기준.
    assert clim.stats_at(_at(_TUE)).days == 3


def test_lodo_own_date_is_kst_date_by_default():
    # 화요일 02:00 KST 점은 서비스 날짜로는 월요일이지만 LODO 는 KST 날짜(화)로 뺀다.
    pts = [P(_at(_TUE, 2), 1.0), P(_at(_WED, 2), 3.0), P(_at(_THU, 2), 5.0)]
    clim = _build(pts, "lodo", min_samples=1)
    assert clim(pts[0]) == pytest.approx(4.0)


def test_lodo_min_samples_and_min_dates():
    pts = _week_points()
    assert _build(pts, "lodo", min_samples=4)(pts[0]) is None  # 자기 날을 빼면 3개
    assert _build(pts, "lodo", min_samples=3)(pts[0]) == pytest.approx(14 / 3)
    many_one_day = [P(_at(_TUE, 14, m), 1.0) for m in range(0, 60, 10)] + [P(_at(_WED), 9.0)]
    clim = _build(many_one_day, "lodo", min_samples=3, min_dates=2)
    assert clim.value_at(_at(_THU)) == pytest.approx((6 * 1.0 + 9.0) / 7)
    assert clim(P(_at(_WED), 9.0)) is None  # 남는 날짜가 화요일 하루뿐(표본 6개여도)
    with pytest.raises(ValueError):
        _build(pts, "lodo", min_samples=1, min_dates=0)


# ── climatology: trailing ─────────────────────────────────────────────────────


def test_trailing_uses_only_strictly_earlier_service_days():
    clim = _build(_week_points(), "trailing", min_samples=1)
    assert clim(P(_at(_TUE), 1.0)) is None  # 앞선 날 없음
    assert clim(P(_at(_WED), 2.0)) == pytest.approx(1.0)
    assert clim(P(_at(_THU), 4.0)) == pytest.approx(1.5)
    assert clim(P(_at(_FRI), 8.0)) == pytest.approx(7 / 3)
    # 같은 서비스 날짜의 앞선 시각도 쓰지 않는다.
    same_day = [P(_at(_TUE, 14, 0), 5.0), P(_at(_TUE, 14, 50), 7.0)]
    assert _build(same_day, "trailing", min_samples=1)(same_day[1]) is None


def test_trailing_is_blind_to_later_days():
    base = _week_points()
    altered = base[:2] + [P(_at(_THU), 400.0), P(_at(_FRI), -80.0)]
    a = _build(base, "trailing", min_samples=1)
    b = _build(altered, "trailing", min_samples=1)
    assert a(base[1]) == b(altered[1]) == pytest.approx(1.0)


def test_trailing_cutoff_is_service_day_05h():
    # 03:00 KST 점의 서비스 날짜는 전날이다: 월 03:00 → 일, 화 03:00 → 월, 수 03:00 → 화.
    mon = date(2026, 10, 12)
    assert mon.weekday() == 0
    pts = [P(_at(mon, 3), 2.0), P(_at(_TUE, 3), 4.0), P(_at(_WED, 3), 6.0)]
    clim = _build(pts, "trailing", min_samples=1)
    assert clim(pts[2]) == pytest.approx(3.0)  # 서비스 날짜 화 → 일·월 서비스 날짜(월·화 03:00)
    assert clim(pts[1]) == pytest.approx(2.0)  # 서비스 날짜 월 → 일 서비스 날짜(월 03:00)
    assert clim(pts[0]) is None
    # 경계 바로 뒤(화 05:00, 서비스 날짜 화)는 화 03:00(서비스 날짜 월)을 쓴다 — 다른 시 칸이라 값은 없다.
    assert clim.value_at(_at(_TUE, 5)) is None
    # 마감 날짜를 수요일로 주면 일·월·화 서비스 날짜(월·화·수 03:00)가 전부 들어간다.
    assert clim.value_at(_at(_TUE, 3), day=_WED) == pytest.approx(4.0)
    assert clim.value_at(_at(_TUE, 3), day=_TUE) == pytest.approx(3.0)


def test_trailing_explicit_cutoff_day_override():
    clim = _build(_week_points(), "trailing", min_samples=1)
    # 도착 시각은 금 14시지만 결정의 서비스 날짜가 수요일이면 화요일까지만 쓴다.
    assert clim.value_at(_at(_FRI), day=_WED) == pytest.approx(1.0)


def test_trailing_min_samples_returns_none():
    clim = _build(_week_points(), "trailing", min_samples=4)
    assert clim(P(_at(_FRI), 8.0)) is None  # 앞선 날 3개
    assert clim.value_at(_at(date(2026, 10, 20))) == pytest.approx(15 / 4)
    s = clim.stats_at(_at(_FRI))
    assert (s.n, s.days, s.mean) == (3, 3, pytest.approx(7 / 3))


# ── climatology: train_dates ──────────────────────────────────────────────────


def test_train_dates_uses_only_listed_dates_without_self_exclusion():
    clim = _build(_week_points(), "train_dates", min_samples=1, train_dates=[_TUE, _WED])
    assert clim(P(_at(_FRI), 8.0)) == pytest.approx(1.5)
    assert clim(P(_at(_TUE), 1.0)) == pytest.approx(1.5)  # 학습 날짜는 그대로 들어간다
    assert _build(_week_points(), "train_dates", min_samples=3, train_dates=[_TUE, _WED])(
        P(_at(_FRI), 8.0)
    ) is None


def test_train_dates_accepts_iso_strings():
    # congestion_calibration_service.split_by_date 는 KST 날짜를 ISO 문자열로 돌려준다.
    clim = _build(_week_points(), "train_dates", min_samples=1, train_dates=["2026-10-13", "2026-10-14"])
    assert clim.value_at(_at(_FRI)) == pytest.approx(1.5)


# ── climatology: 묶음(group) ──────────────────────────────────────────────────


def test_group_separates_zones():
    pts = [P(_at(_TUE), 1.0, "hongdae"), P(_at(_TUE), 9.0, "yeonnam"), P(_at(_WED), 3.0, "hongdae")]
    clim = climatology(
        pts, value=lambda p: p.v, time=lambda p: p.at, mode="trailing", min_samples=1, group=lambda p: p.zone
    )
    assert clim(P(_at(_THU), 0.0, "hongdae")) == pytest.approx(2.0)
    assert clim(P(_at(_THU), 0.0, "yeonnam")) == pytest.approx(9.0)
    assert clim(P(_at(_THU), 0.0, "hapjeong")) is None
    assert clim.value_at(_at(_THU), group="yeonnam") == pytest.approx(9.0)


# ── 결정성 ────────────────────────────────────────────────────────────────────


def _random_points(seed: int) -> list[P]:
    rng = random.Random(seed)
    pts = []
    start = _kst(2026, 9, 20)
    for i in range(40 * 24 * 6):
        at = start + timedelta(minutes=10 * i)
        pts.append(P(at, rng.random() * 0.1 + 1e-9 * rng.random(), rng.choice(["a", "b", "c"])))
    return pts


@pytest.mark.parametrize("mode", ["lodo", "trailing", "train_dates"])
def test_result_is_independent_of_input_order(mode):
    pts = _random_points(7)
    shuffled = list(pts)
    random.Random(11).shuffle(shuffled)
    kwargs = {"train_dates": [date(2026, 9, 20) + timedelta(days=k) for k in range(0, 40, 2)]} if mode == "train_dates" else {}
    a = climatology(pts, value=lambda p: p.v, time=lambda p: p.at, mode=mode, min_samples=2,
                    group=lambda p: p.zone, **kwargs)
    b = climatology(shuffled, value=lambda p: p.v, time=lambda p: p.at, mode=mode, min_samples=2,
                    group=lambda p: p.zone, **kwargs)
    queries = pts[::37]
    assert [a(q) for q in queries] == [b(q) for q in queries]  # 비트 단위 동일
    assert a.cells() == b.cells()


def test_cells_listing_is_sorted_and_stable():
    clim = climatology(
        _random_points(3)[:500], value=lambda p: p.v, time=lambda p: p.at, mode="lodo", min_samples=1,
        group=lambda p: p.zone,
    )
    cells = clim.cells()
    assert cells == sorted(cells, key=repr)
    assert len(set(cells)) == len(cells)


def test_slot_key_defaults_to_the_hour_and_splits_by_slot_width():
    when = datetime(2026, 10, 12, 14, 37, tzinfo=kc.KST)  # 월요일
    assert kc.slot_key(when) == kc.climatology_key(when) == (14, kc.WEEKDAY)
    assert kc.slot_key(when, 10) == ((14 * 60 + 37) // 10, kc.WEEKDAY)
    with pytest.raises(ValueError):
        kc.slot_key(when, 7)  # 하루를 나누지 않는다


def test_climatology_slot_width_separates_values_inside_one_hour():
    start = datetime(2026, 10, 12, 14, 0, tzinfo=kc.KST)
    points = [(start + timedelta(days=d, minutes=10 * k), float(k)) for d in range(5) for k in range(6)]
    hourly = kc.climatology(points, value=lambda p: p[1], time=lambda p: p[0], mode="lodo", min_samples=1)
    slotted = kc.climatology(
        points, value=lambda p: p[1], time=lambda p: p[0], mode="lodo", min_samples=1, slot_minutes=10
    )
    probe = (start + timedelta(minutes=50), 5.0)
    assert hourly(probe) == pytest.approx(2.5), "한 시간 칸은 :00~:50 을 한 평균으로 섞는다"
    assert slotted(probe) == pytest.approx(5.0), "10분 칸은 같은 10분의 다른 날만 평균한다"
