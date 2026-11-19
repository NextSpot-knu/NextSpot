"""KST 달력 · 시간대 평균(climatology) 도우미 — S4 분산 결정 재생과 엔진 검증 지표가 **같은 정의**를 쓰게 한다.

`docs/SEOUL_TESTBED_PLAN.md` §4(V3·V4)와 부록 "지표 설계의 약점"(S4 에서 함께 고친다)의 공용 부품이다.
재생 스크립트(`scripts/crowd_dispersion_replay.py`)의 기준선(climatology_choice · trailing climatology 예측)과
`engine_validation_metrics`·`congestion_calibration_service` 의 지표 보강(시간대 평균을 뺀 순위 상관,
학습 날짜 시간대 평균 MAE, 순위 관문)이 각자 "평일/주말" 이나 "하루의 경계" 를 따로 정하면, 같은 데이터에서
두 숫자가 서로 다른 칸을 비교하게 된다. 그래서 정의를 여기 하나에 둔다. 표준 라이브러리만 쓰는 순수 함수다.

## 공휴일을 주말로 세는 이유

서울 관광지 인파는 "요일" 보다 "쉬는 날인가" 를 따른다. 추석 연휴 목요일의 홍대·경복궁은 평일 목요일보다
토요일에 훨씬 가깝다. 공휴일을 평일 칸에 넣으면 평일 평균이 부풀고(연휴 하루가 한 칸 표본의 1/4 을 차지할
수 있다 — 창이 40일이면 한 칸에 평일이 28일 남짓), 그 부푼 평균과 비교되는 실제 평일은 모두 "평균보다 한산"
으로 보인다. 그래서 `day_type` 은 토·일·**공휴일(대체공휴일 포함)** 을 모두 'weekend' 로 센다.

## LODO 가 "그때 가질 수 있던 것보다 강한" 기준인 이유

LODO(leave-one-date-out)는 어떤 날의 기준값을 **그날만 뺀 나머지 모든 날** — 뒤에 올 날까지 포함해 — 로
만든다. 실제 서비스는 그 순간 앞선 날만 알 수 있으므로, LODO 시간대 평균은 현실에서 가질 수 있던 것보다
표본이 많고 더 정확한 기준이다. 이 기준을 이겨야 통과로 치면 시험은 **보수적**(우리 쪽에 불리)이 된다.
반대로 결정 재생(V3)처럼 "그때 내릴 수 있던 결정" 을 흉내 내는 곳은 **trailing**(엄격히 앞선 서비스 날짜만)을
써야 미래 누수가 없다. 지표 보강 #2 처럼 학습/홀드아웃을 날짜로 가른 곳은 **train_dates**(학습 날짜만)를 쓴다.

## 하루의 경계

  · KST 날짜 — 서울 현장 달력 날짜. LODO·train_dates 의 날짜 단위이자 `day_type` 의 기준(calibration 의
    `split_by_date` 와 같은 단위).
  · 서비스 날짜 — KST 05:00 에 넘어가는 하루(`service_day`). 홍대 심야(01~04시) 인파는 "전날 밤" 이라,
    자정에서 끊으면 한 밤이 두 블록으로 쪼개진다. 부트스트랩 블록과 trailing 의 "앞선 날" 판정에 쓴다.

## 공휴일 목록 — [확인 필요] 관보 대조

`KR_PUBLIC_HOLIDAYS` 는 수집 창(2026-09-01 ~ 2027-02-28)에 걸리는 날만 담는다. 2026년은 관공서의 공휴일에
관한 규정(대체공휴일 포함)을 요일에 대조해 적었다 — 개천절(10-03 토)의 대체공휴일 10-05(월).
추석(09-24~26)은 토요일과만 겹쳐 대체공휴일이 없다. **2027 설 연휴는 음력 정월 초하루가 한국 시각으로
2027-02-07(일)이라는 계산에 기댄다**(연휴 02-06~08, 일요일과 겹쳐 대체공휴일 02-09). 임시공휴일은
지정 전이라 넣지 않았다. 창을 넘어서는 날짜는 `HOLIDAY_COVERAGE` 밖이며, 그 날짜는 공휴일이 없는 것으로 본다.
"""

from __future__ import annotations

import math
from bisect import bisect_left
from collections.abc import Callable, Hashable, Iterable
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Generic, Literal, TypeVar

KST = timezone(timedelta(hours=9))

WEEKEND = "weekend"
WEEKDAY = "weekday"
DayType = Literal["weekend", "weekday"]

ClimatologyMode = Literal["lodo", "trailing", "train_dates"]
MODES: tuple[str, ...] = ("lodo", "trailing", "train_dates")

# 서비스 날짜가 넘어가는 KST 시각(05:00). 부트스트랩 블록 정의와 같다(SEOUL_TESTBED_PLAN S4 기준 상수).
SERVICE_DAY_CUT_HOUR = 5

# 목록이 책임지는 기간(양끝 포함). 이 밖의 날짜는 공휴일이 없는 것으로 본다.
HOLIDAY_COVERAGE: tuple[date, date] = (date(2026, 9, 1), date(2027, 2, 28))

# [확인 필요] 관보 대조 — 모듈 독스트링 "공휴일 목록" 참조.
KR_PUBLIC_HOLIDAYS: frozenset[date] = frozenset({
    date(2026, 9, 24),  # 추석 연휴(목)
    date(2026, 9, 25),  # 추석(금)
    date(2026, 9, 26),  # 추석 연휴(토)
    date(2026, 10, 3),  # 개천절(토)
    date(2026, 10, 5),  # 개천절 대체공휴일(월)
    date(2026, 10, 9),  # 한글날(금)
    date(2026, 12, 25),  # 성탄절(금)
    date(2027, 1, 1),  # 신정(금)
    date(2027, 2, 6),  # 설날 연휴(토)
    date(2027, 2, 7),  # 설날(일)
    date(2027, 2, 8),  # 설날 연휴(월)
    date(2027, 2, 9),  # 설날 대체공휴일(화)
})

P = TypeVar("P")


# ── 달력 ──────────────────────────────────────────────────────────────────────


def to_kst(dt: datetime) -> datetime:
    """tz-aware 는 KST 로 바꾸고, 시간대가 없으면 KST 로 본다(engine_validation_metrics.parse_time 과 같은 규칙)."""
    if not isinstance(dt, datetime):
        raise TypeError(f"datetime 이 필요하다: {type(dt).__name__}")
    if dt.tzinfo is None or dt.utcoffset() is None:
        return dt.replace(tzinfo=KST)
    return dt.astimezone(KST)


def kst_date(dt: datetime) -> date:
    """KST 달력 날짜."""
    return to_kst(dt).date()


def service_day(dt: datetime, cut_hour: int = SERVICE_DAY_CUT_HOUR) -> date:
    """KST ``cut_hour`` 시에 넘어가는 서비스 날짜. 기본 05시 — 04:59 는 전날, 05:00 은 그날."""
    if not 0 <= int(cut_hour) <= 23:
        raise ValueError(f"cut_hour 는 0~23: {cut_hour}")
    return (to_kst(dt) - timedelta(hours=int(cut_hour))).date()


def is_kr_public_holiday(d: date) -> bool:
    """`KR_PUBLIC_HOLIDAYS` 에 든 날인가(`HOLIDAY_COVERAGE` 밖은 언제나 False)."""
    if isinstance(d, datetime):
        d = kst_date(d)
    return d in KR_PUBLIC_HOLIDAYS


def day_type(value: datetime | date) -> DayType:
    """'weekend'(토·일·공휴일) | 'weekday'. datetime 은 KST 달력 날짜로 판정한다."""
    d = kst_date(value) if isinstance(value, datetime) else value
    if not isinstance(d, date):
        raise TypeError(f"date 또는 datetime 이 필요하다: {type(value).__name__}")
    if d.weekday() >= 5 or d in KR_PUBLIC_HOLIDAYS:
        return WEEKEND
    return WEEKDAY


def climatology_key(dt: datetime) -> tuple[int, DayType]:
    """(KST 시, day_type) — 시간대 평균 칸의 열쇠."""
    local = to_kst(dt)
    return local.hour, day_type(local.date())


DEFAULT_SLOT_MINUTES = 60


def _check_slot_minutes(slot_minutes: int) -> int:
    value = int(slot_minutes)
    if value < 1 or 1440 % value:
        raise ValueError(f"slot_minutes 는 하루(1440분)를 나누는 양수: {slot_minutes}")
    return value


def slot_key(dt: datetime, slot_minutes: int = DEFAULT_SLOT_MINUTES) -> tuple[int, DayType]:
    """(KST 하루 안 칸 번호, day_type). 칸 = ``slot_minutes`` 분. 60분이면 `climatology_key` 와 같다(칸 번호 = 시)."""
    local = to_kst(dt)
    width = _check_slot_minutes(slot_minutes)
    return (local.hour * 60 + local.minute) // width, day_type(local.date())


# ── 시간대 평균(climatology) ──────────────────────────────────────────────────


@dataclass(frozen=True)
class ClimatologyStats:
    """한 칸에서 쓸 수 있는 표본(문턱 적용 전). ``mean`` 은 표본이 0개면 None."""

    mean: float | None
    n: int
    days: int


_NO_GROUP: Any = object()


def _coerce_date(value: Any) -> date:
    if isinstance(value, datetime):
        return kst_date(value)
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        return date.fromisoformat(value)
    raise TypeError(f"날짜로 읽을 수 없다: {value!r}")


class Climatology(Generic[P]):
    """(묶음, KST 칸, day_type) 칸별 평균. 호출하면 ``point`` 의 시각·묶음으로 기준값(또는 None)을 준다.

    칸은 기본 한 시간(``slot_minutes=60`` — 칸 번호 = KST 시)이다.

    결과는 입력 순서와 무관하다(값은 ``math.fsum`` — 정확 반올림이라 더하는 순서가 비트를 바꾸지 않는다).
    """

    def __init__(
        self,
        *,
        cells: dict[tuple[Hashable, int, str], dict[date, list[float]]],
        value_fn: Callable[[P], float | None],
        time_fn: Callable[[P], datetime | None],
        group_fn: Callable[[P], Hashable] | None,
        mode: str,
        min_samples: int,
        min_dates: int,
        day_of: Callable[[datetime], date],
        slot_minutes: int = DEFAULT_SLOT_MINUTES,
    ) -> None:
        self.mode = mode
        self.slot_minutes = _check_slot_minutes(slot_minutes)
        self.min_samples = min_samples
        self.min_dates = min_dates
        self._value_fn = value_fn
        self._time_fn = time_fn
        self._group_fn = group_fn
        self._day_of = day_of
        # 칸 → (정렬된 날짜, 날짜별 값 목록(정렬))
        self._cells: dict[tuple[Hashable, int, str], tuple[list[date], list[list[float]]]] = {}
        for key, by_day in cells.items():
            days = sorted(by_day)
            self._cells[key] = (days, [sorted(by_day[d]) for d in days])
        self._cache: dict[tuple[Any, ...], ClimatologyStats] = {}

    # 공개 API ---------------------------------------------------------------

    def __call__(self, point: P) -> float | None:
        when = self._time_fn(point)
        if when is None:
            return None
        group = self._group_fn(point) if self._group_fn is not None else _NO_GROUP
        return self.value_at(when, group=group)

    def value_at(self, when: datetime, *, group: Any = _NO_GROUP, day: date | None = None) -> float | None:
        """``when`` 의 칸 기준값. 표본·날짜 수 문턱을 못 넘으면 None.

        ``day`` 는 제외/마감 기준 날짜를 덮어쓴다(기본: ``when`` 의 날짜 — lodo·train_dates 는 KST 날짜,
        trailing 은 서비스 날짜). 재생에서 도착 시각의 칸을 보되 **결정 시점의 서비스 날짜** 이전만 쓰려면
        ``day=service_day(t)`` 를 준다.
        """
        stats = self.stats_at(when, group=group, day=day)
        if stats.mean is None or stats.n < self.min_samples or stats.days < self.min_dates:
            return None
        return stats.mean

    def stats_at(self, when: datetime, *, group: Any = _NO_GROUP, day: date | None = None) -> ClimatologyStats:
        """문턱 적용 전 표본 요약(보고서의 '대체 비율'·표본 수 표기용)."""
        slot, dtype = slot_key(when, self.slot_minutes)
        key = (self._group_key(group), slot, dtype)
        ref_day = day if day is not None else self._day_of(when)
        cache_key = (key, ref_day) if self.mode != "train_dates" else (key,)
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached
        stats = self._compute(key, ref_day)
        self._cache[cache_key] = stats
        return stats

    def cells(self) -> list[tuple[Hashable, int, str]]:
        """표본이 있는 칸 목록(결정적 순서 — repr 정렬). 묶음 없이 만들었으면 묶음 자리는 None."""
        return sorted(
            (((None if g is _NO_GROUP else g), h, t) for (g, h, t) in self._cells),
            key=repr,
        )

    # 내부 -------------------------------------------------------------------

    def _group_key(self, group: Any) -> Hashable:
        if self._group_fn is None:
            return _NO_GROUP
        return group

    def _compute(self, key: tuple[Hashable, int, str], ref_day: date) -> ClimatologyStats:
        entry = self._cells.get(key)
        if entry is None:
            return ClimatologyStats(mean=None, n=0, days=0)
        days, values = entry
        if self.mode == "lodo":
            chosen = [v for d, v in zip(days, values) if d != ref_day]
        elif self.mode == "trailing":
            chosen = values[: bisect_left(days, ref_day)]
        else:  # train_dates — 표본 자체가 학습 날짜로 이미 걸러져 있다.
            chosen = values
        flat = [x for day_values in chosen for x in day_values]
        if not flat:
            return ClimatologyStats(mean=None, n=0, days=0)
        return ClimatologyStats(mean=math.fsum(flat) / len(flat), n=len(flat), days=len(chosen))


def climatology(
    points: Iterable[P],
    *,
    value: Callable[[P], float | None],
    time: Callable[[P], datetime | None],
    mode: ClimatologyMode,
    min_samples: int,
    train_dates: Iterable[date | str] | None = None,
    min_dates: int = 1,
    group: Callable[[P], Hashable] | None = None,
    day_of: Callable[[datetime], date] | None = None,
    slot_minutes: int = DEFAULT_SLOT_MINUTES,
) -> Climatology[P]:
    """(KST 시, day_type[, 묶음]) 칸별 평균을 만들어 ``callable(point) -> float | None`` 로 돌려준다.

    ``slot_minutes`` 를 주면 칸이 한 시간 대신 그 폭(예: 10분 — 데이터의 버킷 폭)이 된다. 한 시간 칸은 한 시간 안의
    오르내림을 지우지 못한다 — 하루 모양만 따라 그리는 추정을 거르려면 데이터의 해상도로 칸을 잡는다.

    mode
      · 'lodo'        — 그 점의 날짜만 뺀 나머지 모든 날(뒤 날짜 포함 — 실제보다 강한 기준, 보수적 시험).
      · 'trailing'    — 그 점의 날짜보다 **엄격히 앞선** 날만(미래 누수 없음 — 결정 재생용).
      · 'train_dates' — ``train_dates`` 에 든 날만(자기 날짜를 빼지 않는다 — 홀드아웃 채점용).
    날짜 단위(``day_of``) 기본값: trailing 은 서비스 날짜(KST 05시 경계), lodo·train_dates 는 KST 날짜.
    ``value`` 가 None·NaN·무한을 주거나 ``time`` 이 None 을 주는 점은 버린다.
    ``min_samples`` (표본 수)와 ``min_dates`` (서로 다른 날짜 수)를 모두 넘어야 값을 준다 — 못 넘으면 None.
    ``group`` 을 주면 칸이 묶음(예: 구역)별로 갈린다.
    """
    if mode not in MODES:
        raise ValueError(f"mode 는 {MODES} 중 하나: {mode!r}")
    if int(min_samples) < 1:
        raise ValueError(f"min_samples 는 1 이상: {min_samples}")
    if int(min_dates) < 1:
        raise ValueError(f"min_dates 는 1 이상: {min_dates}")
    width = _check_slot_minutes(slot_minutes)
    if mode == "train_dates":
        if train_dates is None:
            raise ValueError("mode='train_dates' 에는 train_dates 가 필요하다")
        allowed: frozenset[date] | None = frozenset(_coerce_date(d) for d in train_dates)
    else:
        if train_dates is not None:
            raise ValueError(f"train_dates 는 mode='train_dates' 에서만 쓴다(지금 {mode!r})")
        allowed = None
    if day_of is None:
        day_of = service_day if mode == "trailing" else kst_date

    cells: dict[tuple[Hashable, int, str], dict[date, list[float]]] = {}
    for point in points:
        when = time(point)
        if when is None:
            continue
        raw = value(point)
        if raw is None:
            continue
        number = float(raw)
        if not math.isfinite(number):
            continue
        day = day_of(when)
        if allowed is not None and day not in allowed:
            continue
        slot, dtype = slot_key(when, width)
        group_key = group(point) if group is not None else _NO_GROUP
        cells.setdefault((group_key, slot, dtype), {}).setdefault(day, []).append(number)

    return Climatology(
        cells=cells,
        value_fn=value,
        time_fn=time,
        group_fn=group,
        mode=mode,
        min_samples=int(min_samples),
        min_dates=int(min_dates),
        day_of=day_of,
        slot_minutes=width,
    )


__all__ = [
    "HOLIDAY_COVERAGE",
    "KR_PUBLIC_HOLIDAYS",
    "KST",
    "MODES",
    "SERVICE_DAY_CUT_HOUR",
    "WEEKDAY",
    "WEEKEND",
    "DEFAULT_SLOT_MINUTES",
    "Climatology",
    "ClimatologyStats",
    "climatology",
    "climatology_key",
    "day_type",
    "is_kr_public_holiday",
    "kst_date",
    "service_day",
    "slot_key",
    "to_kst",
]
