"""10분 주차 실측 이력으로 주변 권역 수요를 보수적으로 전망한다.

장소 내부 좌석이나 대기시간을 예측하지 않는다. 동일한 반경 2km 안의 주차장 원본을
시점별로 다시 집계하고, 과거의 같은 요일군·시간대 표본이 충분할 때만 상대 수요 수준을
반환한다. 모든 학습 표본은 전망 시점보다 과거여야 하므로 시간 순서 누수를 허용하지 않는다.

집계는 Postgres RPC(``area_demand_points_near``, 마이그레이션 20260904120000)가 한다.
예전에는 56일치 주차장 원본을 프로세스에 통째로(≈52MB) 올려 두고 **후보 한 곳마다**
파이썬 루프로 다시 훑었다 — 후보당 0.28~6.4초라 후보가 몇만 되어도 프런트 10초 타임아웃
안에 추천이 끝나지 않았다. 지금은 후보당 왕복 한 번이고 상주 캐시가 없다.
"""

from __future__ import annotations

import asyncio
import bisect
import statistics
import threading
import time
from array import array
from bisect import bisect_left
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from operator import attrgetter
from typing import Any

import structlog

from app.core.supabase import fetch_all_rows, supabase_admin
from app.services.spot.travel import calculate_haversine_distance
from app.services.travel_context import KST

logger = structlog.get_logger()

_RADIUS_M = 2_000.0
_BUCKET_MINUTES = 10
_LOOKBACK_DAYS = 56
_CACHE_TTL_SECONDS = 5 * 60.0
_MIN_SAMPLES = 6
_MIN_DISTINCT_DATES = 3
_MIN_COVERAGE_DAYS = 7
_TIME_WINDOW_MINUTES = 30
_MAX_RECENT_ADJUSTMENT = 0.08
_SOURCE = "gyeongju_its"
_POINTS_RPC = "area_demand_points_near"


@dataclass(frozen=True, slots=True)
class AreaDemandPoint:
    """권역 수요 시계열의 한 점.

    메모리: 이 점은 격자 캐시에 **격자마다 전량**(2026-09-21 실측 4,172개) 쌓인다.
    ``slots=True`` 로 인스턴스 ``__dict__`` 를 없애 점 하나가 ~106B → ~65B 가 되고
    (tracemalloc 실측, 4,172점 431KB → 265KB), ``observed_at``·``level`` 은 아래 인턴
    표로 격자 간에 **같은 객체를 공유**한다 — 모든 격자가 같은 10분 스냅샷 시각을 쓰는데
    예전에는 격자마다 datetime(하나 57B, 격자당 233KB)을 새로 만들어 복제했다.
    값·비교·isoformat() 결과는 그대로다 — 바뀌는 것은 '몇 개의 객체로 표현하느냐' 뿐이다.
    """

    observed_at: datetime
    level: float
    lot_count: int


# ── 값 인턴(격자 간 공유) ─────────────────────────────────────────────────────
# 격자마다 시계열 전량을 들고 있는데, 그 시각들은 **모든 격자가 동일**하다(10분 스냅샷
# 한 번당 한 점). 2026-09-21 실측으로 격자 하나가 4,172점이라 256격자면 같은 datetime
# 객체가 최대 256벌 복제됐다. 여기서 한 벌만 남기고 공유한다.
#
# 넘치면 그냥 비운다: 공유가 잠시 풀릴 뿐 값은 같다. 56일 × 144버킷 = 8,064 이니
# 20,000 은 넉넉하다(연속 배포 없이 창이 다 차도 여유).
#
# 표 자체의 비용도 재 봤다: 8,064개일 때 1.14MB(항목당 ~148B — 키 tuple + dict 슬롯).
# 격자 96개에서 복제를 걷어내며 줄이는 양(격자당 233KB × 96 ≈ 22MB)에 비하면 무시할 만하다.
_INTERN_MAX_ENTRIES = 20_000
# 키에 tzinfo 표기를 함께 넣는 이유: aware datetime 의 ==/hash 는 **순간만** 본다.
# 01:00+00:00 과 10:00+09:00 은 같다고 판정되므로 datetime 만 키로 쓰면 먼저 들어온
# 쪽의 tzinfo 를 돌려주고, 하류의 isoformat() 출력이 조용히 달라진다(응답 문자열이 바뀐다).
_datetime_intern: dict[tuple[datetime, str], datetime] = {}
_level_intern: dict[float, float] = {}


def _intern_datetime(value: datetime) -> datetime:
    """같은 순간 **그리고 같은 tzinfo 표기**일 때만 객체를 공유한다."""
    if len(_datetime_intern) > _INTERN_MAX_ENTRIES:
        _datetime_intern.clear()
    return _datetime_intern.setdefault((value, str(value.tzinfo)), value)


def _intern_level(value: float) -> float:
    """수요 수준은 반올림하지 않는다 — 값이 **정확히 같을 때만** 공유한다.

    float 키의 유일한 함정인 ``-0.0``(0.0 과 ==/hash 가 같다)은 ``_clamp`` 가
    ``max(0.0, ...)`` 로 항상 ``0.0`` 을 돌려주므로 여기 들어오지 않는다.
    """
    if len(_level_intern) > _INTERN_MAX_ENTRIES:
        _level_intern.clear()
    return _level_intern.setdefault(value, value)


# ── 폴백 전용 상태 ────────────────────────────────────────────────────────────
# 아래 원본 캐시는 **RPC 가 없는 DB** 를 만났을 때만 채워진다(마이그레이션 적용 전 배포
# 창). RPC 가 한 번이라도 성공하면 즉시 비워지고 다시는 채워지지 않는다.
_raw_cache: tuple[float, list[dict[str, Any]], list[dict[str, Any]]] | None = None
_raw_cache_lock = asyncio.Lock()
# RPC 부재를 감지하면 이 시각(monotonic)까지는 RPC 를 건너뛰고 폴백만 쓴다. 후보마다
# 실패하는 왕복을 한 번씩 더 하면 배포 창 동안 지연이 두 배가 된다.
_RPC_MISSING_RETRY_SECONDS = 60.0
_rpc_missing_until: float = 0.0

# ── 좌표 격자별 시계열 캐시 ───────────────────────────────────────────────────
#
# 왜 필요한가: `_load_points` 는 **후보 좌표마다 RPC 왕복 1회**다. 코스 한 요청은 자리마다
# 후보를 현재 위치 기준으로 다시 추리므로 이 함수가 수십 번 불린다(2026-09-06 실측: 서로 다른
# 좌표 12 → 36). 왕복 하나하나는 싸지만 **직렬로 수십 번**이면 Render 무료 인스턴스에서
# 프런트 타임아웃(20초)에 실제로 가까워진다.
#
# 키를 백테스트 캐시(`_cached_backtest`)와 **같은 격자**(round 3자리 ≈ 100m)로 잡는다.
# 그래야 같은 격자의 후보가 RPC 와 백테스트를 함께 재사용한다 — 한쪽만 격자로 묶으면
# 나머지 한쪽이 그대로 비용을 낸다.
#
# ⚠️ 격자를 더 넓히지 않는다. 키에서 좌표를 빼거나 자리수를 줄이면 다른 지점의 시계열을
# 서로 주고받게 되어 "지점별 품질" 계약이 "격자별 품질" 로 바뀐다. 그건 값의 의미를 바꾸는
# 결정이라 여기서 하지 않는다(검토목록 2번 — 사용자가 '캐시 키는 건드리지 말고 선계산으로'
# 를 골랐다).
#
# `now` 는 키에 넣지 않고 TTL 로만 다룬다. 넣으면 초 단위로 키가 갈려 캐시가 무의미해진다.
_POINTS_CACHE_TTL_SECONDS = 5 * 60.0
# 상한. 항목 하나가 **가볍지 않다**: 격자 하나 = 그 반경의 스냅샷 전량이다
# (2026-09-21 실측 4,172점 · 0.46MB, 56일 창이 다 차면 8,064점으로 두 배).
# 256격자면 118MB — 512MB Render 인스턴스가 15~60분마다 OOM 으로 재시작한 주범 중 하나다.
#
# 96 = 코스 요청 3~4회분(요청당 새 격자 ~24개)이고 TTL 이 5분이라 그 이상은 어차피 만료분이다.
# 밀려난 격자를 다시 받아도 CPU 는 늘지 않는다: RPC 재조회는 I/O 0.5~1.2초이고 비싼
# 백테스트 결과는 `_quality_cache`(TTL 30분, 상한 256)가 따로 들고 있다.
_POINTS_CACHE_MAX_ENTRIES = 96
_points_cache: dict[tuple[float, float], tuple[float, list["AreaDemandPoint"]]] = {}
# 같은 격자를 동시에 요청하면 RPC 도 동시에 나간다. 격자마다 락을 하나 두어 **첫 요청만**
# 왕복하고 나머지는 그 결과를 기다리게 한다(예열과 채점이 겹칠 때 실제로 일어난다).
_points_locks: dict[tuple[float, float], asyncio.Lock] = {}
# 격자 시계열의 (요일군, 시각-분) 색인 — `_SeriesIndex` 참조. **캐시에 들어 있는 바로 그 리스트**
# 에 대해서만 만들고, 격자가 `_points_cache` 에서 빠지는 모든 자리(TTL·상한·덮어쓰기·리셋)에서
# 함께 버린다. 그래서 캐시가 이미 붙들고 있는 시계열 외에 아무것도 더 붙들지 않는다.
_series_indexes: dict[tuple[float, float], tuple[list["AreaDemandPoint"], "_SeriesIndex"]] = {}


def _grid_key(latitude: float, longitude: float) -> tuple[float, float]:
    """백테스트 캐시와 **동일한** 격자. 두 캐시가 어긋나면 한쪽이 늘 빗나간다."""
    return (round(latitude, 3), round(longitude, 3))


def _points_cache_get(key: tuple[float, float]) -> list["AreaDemandPoint"] | None:
    hit = _points_cache.get(key)
    if hit is None:
        return None
    if time.monotonic() - hit[0] >= _POINTS_CACHE_TTL_SECONDS:
        _points_cache.pop(key, None)
        _series_indexes.pop(key, None)
        return None
    return hit[1]


def _points_cache_put(key: tuple[float, float], points: list["AreaDemandPoint"]) -> None:
    now = time.monotonic()
    if len(_points_cache) >= _POINTS_CACHE_MAX_ENTRIES:
        for stale in [k for k, (at, _) in _points_cache.items()
                      if now - at >= _POINTS_CACHE_TTL_SECONDS]:
            _points_cache.pop(stale, None)
            _series_indexes.pop(stale, None)
        while len(_points_cache) >= _POINTS_CACHE_MAX_ENTRIES:
            oldest = min(_points_cache, key=lambda k: _points_cache[k][0])
            _points_cache.pop(oldest, None)
            _series_indexes.pop(oldest, None)
    _series_indexes.pop(key, None)
    _points_cache[key] = (now, points)


def reset_points_cache() -> None:
    """테스트 전용 — 모듈 전역 캐시가 테스트 간에 새지 않게 한다.

    인턴 표도 함께 비운다: 남겨 두면 앞 테스트가 만든 객체를 뒤 테스트가 돌려받아
    '같은 객체인가' 를 보는 검사가 자기 테스트와 무관하게 통과한다(테스트 격리).
    """
    _points_cache.clear()
    _points_locks.clear()
    _series_indexes.clear()
    _datetime_intern.clear()
    _level_intern.clear()

# ── 지점별 백테스트 캐시 ──────────────────────────────────────────────────────
_quality_cache: dict[tuple[float, float, int, str], tuple[float, dict[str, Any]]] = {}
# 캐시 상한. 한 번의 추천이 훑는 후보 수보다 넉넉해야 의미가 있고, 항목이 작아
# 메모리 부담은 없다. 넘으면 만료분 → 오래된 순으로 버린다.
#
# 64 였을 때의 근거는 "한 번의 추천이 수십 개" 였는데, courses.py 가 자리마다 '지금 서 있는
# 자리' 기준으로 후보를 다시 추리게 되면서 전제가 깨졌다: 2·3번 자리는 누적 도착(도착 +
# COURSE_DWELL_MIN 40~60분)이 항상 live 지평 30분 밖이라 **반드시** 이 이력 경로로 오고,
# 자리당 MAX_COURSE_CANDIDATES(12)씩 → 코스 요청 하나가 24개 안팎의 **새 키**를 밀어 넣는다.
# 64 면 세 번째 요청이 첫 요청의 항목을 밀어내 TTL 30분이 사실상 몇 분으로 줄어든다.
# 256 = 코스 요청 약 10회분. 항목은 (float,float,int,str) 키와 숫자 4개짜리 dict 라
# 256개라도 수십 KB 수준이다(Render 무료 인스턴스에서도 무시할 만하다).
_QUALITY_CACHE_MAX_ENTRIES = 256
_QUALITY_CACHE_TTL_SECONDS = 30 * 60.0
# 같은 키의 백테스트가 **동시에** 빗나가면 각자 처음부터 다시 돈다(코스 한 자리에서 후보
# 12곳을 asyncio.gather 로 함께 채점하므로, 같은 100m 격자의 두 후보가 둘 다 미스를 본다 —
# 실측: 기본 코스의 미스 17건 중 7건이 이미 돌고 있던 키의 중복 계산). 키마다 진행 중 표시를
# 두어 첫 호출만 계산하고 나머지는 그 결과를 기다린다(single-flight). 값은 그대로다:
# 백테스트는 순수 함수이고, 기다린 쪽이 받는 값은 캐시 적중 때 받았을 바로 그 값이다.
# 같은 락이 캐시 조회·만료 정리·삽입도 감싼다 — 여러 to_thread 워커가 락 없이 dict 를
# 고치면 min() 순회 중 "dictionary keys changed during iteration" 으로 요청이 503 이 된다.
# 비싼 계산 자체는 락 밖에서 돈다.
_quality_lock = threading.Lock()
_quality_inflight: dict[tuple[float, float, int, str], threading.Event] = {}


def _aware(value: Any) -> datetime | None:
    try:
        parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def aggregate_nearby_points(
    parents: list[dict[str, Any]],
    lots: list[dict[str, Any]],
    latitude: float,
    longitude: float,
) -> list[AreaDemandPoint]:
    """저장된 주차장 원본을 현재 실시간 계산과 같은 거리·규모 가중으로 재집계한다.

    ⚠️ 이 수식은 이제 **정본이 아니라 대조본**이다. 운영 경로는 같은 계산을 Postgres 에서
    하는 ``area_demand_points_near`` RPC 다(마이그레이션 20260904120000). 여기는
    (1) RPC 가 아직 없는 DB 를 위한 폴백, (2) RPC 가 같은 값을 내는지 잠그는 테스트의
    기준값 두 가지로만 남는다. 한쪽을 바꾸면 반드시 다른 쪽과 대조 테스트도 같이 바꿀 것.
    """
    parent_times: dict[str, datetime] = {}
    for parent in parents:
        observed_at = _aware(parent.get("observed_at"))
        snapshot_id = str(parent.get("id") or "")
        if snapshot_id and observed_at is not None:
            parent_times[snapshot_id] = observed_at

    grouped: dict[str, tuple[float, float, int]] = {}
    for lot in lots:
        snapshot_id = str(lot.get("snapshot_id") or "")
        if snapshot_id not in parent_times:
            continue
        try:
            lot_lat = float(lot["latitude"])
            lot_lng = float(lot["longitude"])
            total = int(lot["total_spaces"])
            available = int(lot["available_spaces"])
        except (KeyError, TypeError, ValueError):
            continue
        if total <= 0 or available < 0 or available > total:
            continue
        distance_m = calculate_haversine_distance(latitude, longitude, lot_lat, lot_lng)
        if distance_m > _RADIUS_M:
            continue
        occupancy = 1.0 - available / total
        weight = min(total, 500) / (1.0 + distance_m / 500.0)
        weighted, weight_total, count = grouped.get(snapshot_id, (0.0, 0.0, 0))
        grouped[snapshot_id] = (
            weighted + occupancy * weight,
            weight_total + weight,
            count + 1,
        )

    points = [
        AreaDemandPoint(parent_times[snapshot_id], _clamp(weighted / weight_total), count)
        for snapshot_id, (weighted, weight_total, count) in grouped.items()
        if weight_total > 0 and count > 0
    ]
    return sorted(points, key=lambda point: point.observed_at)


def _is_weekend(value: datetime) -> bool:
    return value.astimezone(KST).weekday() >= 5


def _clock_minutes(value: datetime) -> int:
    local = value.astimezone(KST)
    return local.hour * 60 + local.minute


def _circular_minutes(a: int, b: int) -> int:
    direct = abs(a - b)
    return min(direct, 24 * 60 - direct)


_DAY_MINUTES = 24 * 60


@lru_cache(maxsize=None)
def _window_minutes(target_clock: int, window: int) -> tuple[int, ...]:
    """``_circular_minutes(m, target_clock) <= window`` 인 시각-분 m(0~1439) 전부, 오름차순.

    원래 필터의 시간대 조건을 **그 함수 그대로** 1,440개 분에 미리 적용해 둔 것이다.
    항목은 (시각-분 1,440종 x 창 크기) 이하라 상한이 필요 없다.
    """
    return tuple(
        minute for minute in range(_DAY_MINUTES)
        if _circular_minutes(minute, target_clock) <= window
    )


class _SeriesIndex:
    """정렬된 시계열 하나에 대한 (KST 요일군, KST 시각-분) -> 원소 번호 색인.

    왜: 추천·코스가 후보마다 부르는 ``forecast_from_points`` 는 매번 시계열 전량(격자당 4~8천 점)을
    훑으며 점마다 ``astimezone`` 을 2~4번 한다(웜 코스 CPU 의 절반). 그런데 같은 격자 시계열은
    ``_points_cache`` 에 5분 동안 **같은 리스트 객체**로 남아 여러 후보·요청이 되풀이해 쓴다.
    점마다의 요일군·시각-분은 시계열에만 달린 값이라 한 번만 계산해 두고, 호출마다는
    도착 시각 ±30분에 드는 분 버킷만 읽는다.

    값은 원래 필터와 **정확히 같다**: 버킷은 ``_is_weekend``/``_clock_minutes`` 와 같은 식으로
    만들고, 과거 조건(``observed_at < cutoff``)은 정렬된 시계열의 앞부분이므로 이분 탐색으로 자른다.
    그 전제(고정 오프셋 aware 시각·오름차순)가 하나라도 깨지면 ``build`` 가 ``None`` 을 돌려
    호출부가 원래 전수 필터로 돌아간다.
    """

    __slots__ = ("size", "order", "starts")

    def __init__(self, size: int, order: array, starts: array) -> None:
        self.size = size
        self.order = order    # 원소 번호: (주말 여부, 시각-분) 버킷 순, 버킷 안에서는 오름차순
        self.starts = starts  # 버킷 b 의 원소 번호 = order[starts[b]:starts[b + 1]]

    @classmethod
    def build(cls, points: list[AreaDemandPoint]) -> _SeriesIndex | None:
        buckets: list[list[int]] = [[] for _ in range(2 * _DAY_MINUTES)]
        previous: datetime | None = None
        for position, point in enumerate(points):
            observed_at = point.observed_at
            # 고정 오프셋만: 그래야 '비교 순서 = 순간 순서' 가 되어 앞부분 자르기가 원래 필터와 같다.
            if type(observed_at.tzinfo) is not timezone:
                return None
            if previous is not None and not previous <= observed_at:
                return None
            previous = observed_at
            local = observed_at.astimezone(KST)  # _is_weekend·_clock_minutes 와 같은 변환
            weekend = local.weekday() >= 5
            buckets[(_DAY_MINUTES if weekend else 0) + local.hour * 60 + local.minute].append(position)
        order = array("I")
        starts = array("I", [0])
        for bucket in buckets:
            order.extend(bucket)
            starts.append(len(order))
        return cls(len(points), order, starts)

    def eligible(
        self,
        points: list[AreaDemandPoint],
        before: int,
        target_weekend: bool,
        target_clock: int,
    ) -> list[AreaDemandPoint]:
        """원래 ``eligible`` 과 같은 원소를 **같은 순서**(시계열 순)로 돌려준다."""
        base = _DAY_MINUTES if target_weekend else 0
        order, starts = self.order, self.starts
        picked: list[int] = []
        for minute in _window_minutes(target_clock, _TIME_WINDOW_MINUTES):
            low, high = starts[base + minute], starts[base + minute + 1]
            if low != high:
                picked.extend(order[low:bisect_left(order, before, low, high)])
        picked.sort()
        return [points[position] for position in picked]


def _series_index_for(
    key: tuple[float, float], points: list[AreaDemandPoint]
) -> _SeriesIndex | None:
    """``points`` 가 지금 격자 캐시에 든 바로 그 리스트일 때만 색인을 (만들어) 돌려준다."""
    cached = _points_cache.get(key)
    if cached is None or cached[1] is not points:
        return None
    hit = _series_indexes.get(key)
    if hit is not None and hit[0] is points and hit[1].size == len(points):
        return hit[1]
    index = _SeriesIndex.build(points)
    if index is not None:
        _series_indexes[key] = (points, index)
    return index


def forecast_from_points(
    points: list[AreaDemandPoint],
    arrival: datetime,
    *,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """과거 자료만으로 동일 요일군·시간대 중앙값과 제한된 최근 추세를 계산한다."""
    return _forecast_from_points(points, arrival, now, None)


def _forecast_from_points(
    points: list[AreaDemandPoint],
    arrival: datetime,
    now: datetime | None,
    index: _SeriesIndex | None,
) -> dict[str, Any] | None:
    """``forecast_from_points`` 본체. ``index`` 가 있으면 전수 필터 대신 색인으로 같은 표본을 고른다."""
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    if arrival.tzinfo is None:
        arrival = arrival.replace(tzinfo=timezone.utc)

    cutoff = now.astimezone(timezone.utc)
    target_clock = _clock_minutes(arrival)
    target_weekend = _is_weekend(arrival)
    if index is not None and index.size == len(points):
        # 오름차순 시계열에서 'observed_at < cutoff' 인 원소는 정확히 앞의 `before` 개다.
        before = bisect_left(points, cutoff, key=attrgetter("observed_at"))
        eligible = index.eligible(points, before, target_weekend, target_clock)
    else:
        index = None
        eligible = [
            point for point in points
            if point.observed_at.astimezone(timezone.utc) < cutoff
            and _is_weekend(point.observed_at) == target_weekend
            and _circular_minutes(_clock_minutes(point.observed_at), target_clock)
            <= _TIME_WINDOW_MINUTES
        ]
    distinct_dates = {
        point.observed_at.astimezone(KST).date() for point in eligible
    }
    if len(eligible) < _MIN_SAMPLES or len(distinct_dates) < _MIN_DISTINCT_DATES:
        return None
    coverage_days = (
        max(point.observed_at for point in eligible)
        - min(point.observed_at for point in eligible)
    ).total_seconds() / 86_400.0
    if coverage_days < _MIN_COVERAGE_DAYS:
        return None

    baseline = statistics.median(point.level for point in eligible)
    if index is not None:
        # 이미 정렬된 앞부분이라 안정 정렬해도 그대로다. 아래는 끝 9개만 쓰므로 끝 9개만 자른다.
        recent_all = points[max(0, before - 9):before]
    else:
        recent_all = [
            point for point in points if point.observed_at.astimezone(timezone.utc) < cutoff
        ]
        recent_all.sort(key=lambda point: point.observed_at)
    recent_adjustment = 0.0
    # 10분 버킷 3개(최근 30분)와 직전 6개(60분)를 비교한다. 호출 지연이나
    # 전환 전 15분 자료가 섞여도 observed_at 순서를 사용하므로 시간 누수는 없다.
    if len(recent_all) >= 9:
        latest = recent_all[-1]
        freshness = cutoff - latest.observed_at.astimezone(timezone.utc)
        if timedelta(0) <= freshness <= timedelta(minutes=45):
            recent = statistics.median(point.level for point in recent_all[-3:])
            previous = statistics.median(point.level for point in recent_all[-9:-3])
            horizon_minutes = max(0.0, (arrival - now).total_seconds() / 60.0)
            decay = max(0.0, 1.0 - horizon_minutes / 180.0)
            recent_adjustment = max(
                -_MAX_RECENT_ADJUSTMENT,
                min(_MAX_RECENT_ADJUSTMENT, (recent - previous) * decay),
            )

    level = _clamp(baseline + recent_adjustment)
    confidence = "high" if len(eligible) >= 12 and coverage_days >= 21 else "medium"
    return {
        "level": round(level, 4),
        "mode": "forecast",
        "source": "parking_history",
        "sources": ["parking_history"],
        "confidence": confidence,
        "sample_count": len(eligible),
        "distinct_dates": len(distinct_dates),
        "coverage_days": round(coverage_days, 1),
        "bucket_minutes": _BUCKET_MINUTES,
        "observed_at": max(point.observed_at for point in eligible).isoformat(),
        "forecast_for": arrival.isoformat(),
        "baseline_level": round(baseline, 4),
        "recent_adjustment": round(recent_adjustment, 4),
        "radius_m": round(_RADIUS_M),
    }


def _is_missing_points_rpc(exc: BaseException) -> bool:
    """``area_demand_points_near`` 가 아직 없는 DB인가.

    마이그레이션(20260904120000)은 원격 SQL Editor 에서 사람이 적용한다 — 백엔드 배포가
    먼저 나가는 순서가 실제로 가능하다(account.py 의 ``_is_missing_requested_role`` 과 같은
    상황). 그때 이 신호가 통째로 죽으면 **조용히** 나빠진다: 추천 경로는 예외를 삼켜
    ``None`` 을 돌려주므로 권역 수요 근거만 사라진 채 추천이 그대로 나가고, 관리자
    품질 엔드포인트는 503 이 된다. 어느 쪽도 화면에 "지금 데이터가 없다"고 말하지 않는다.
    그래서 이 오류 **하나만** 골라내 기존 파이썬 집계로 폴백한다.
    마이그레이션 적용을 확인하면 폴백 경로(_load_raw_history / aggregate_nearby_points
    호출부)를 지워도 된다.
    """
    text = str(exc).lower()
    if _POINTS_RPC not in text:
        return False
    return (
        "pgrst202" in text
        or "could not find the function" in text
        or "does not exist" in text
        or "schema cache" in text
    )


def _points_from_payload(payload: Any) -> list[AreaDemandPoint]:
    """RPC 의 JSONB 응답을 시계열로 옮긴다. 형식이 깨지면 조용히 비우지 않고 던진다."""
    if isinstance(payload, list):
        payload = payload[0] if payload else None
    if not isinstance(payload, dict):
        raise ValueError(f"{_POINTS_RPC} returned an unexpected payload")
    rows = payload.get("points")
    if not isinstance(rows, list):
        raise ValueError(f"{_POINTS_RPC} returned no points array")
    points: list[AreaDemandPoint] = []
    for row in rows:
        # [관측시각(UTC ISO-8601), 수요 수준, 주차장 수] — 마이그레이션의 jsonb_build_array 순서.
        if not isinstance(row, (list, tuple)) or len(row) < 3:
            raise ValueError(f"{_POINTS_RPC} returned a malformed point")
        observed_at = _aware(row[0])
        if observed_at is None:
            raise ValueError(f"{_POINTS_RPC} returned an unparsable observed_at")
        # 시각·수준은 격자마다 같은 값이 반복되므로 인턴 표를 거쳐 객체를 공유한다
        # (값은 그대로 — AreaDemandPoint 독스트링의 '메모리' 절 참조).
        points.append(AreaDemandPoint(
            _intern_datetime(observed_at),
            _intern_level(_clamp(float(row[1]))),
            int(row[2]),
        ))
    # RPC 가 이미 정렬해 주지만, 뒤의 백테스트·최근추세가 순서를 전제하므로 계약으로 고정한다.
    points.sort(key=lambda point: point.observed_at)
    return points


async def _fetch_points_via_rpc(
    latitude: float, longitude: float, now: datetime
) -> list[AreaDemandPoint]:
    since = (now - timedelta(days=_LOOKBACK_DAYS)).astimezone(timezone.utc).isoformat()

    def _call() -> Any:
        return supabase_admin.rpc(_POINTS_RPC, {
            "p_latitude": float(latitude),
            "p_longitude": float(longitude),
            "p_since": since,
            "p_radius_m": _RADIUS_M,
            "p_source": _SOURCE,
        }).execute()

    response = await asyncio.to_thread(_call)
    return _points_from_payload(getattr(response, "data", None))


async def _load_points(
    latitude: float, longitude: float, now: datetime
) -> list[AreaDemandPoint]:
    """이 좌표 기준 시계열을 얻는다(격자 캐시 경유). 미스일 때만 RPC 한 번, 예외적으로 폴백.

    캐시를 여기 두는 이유: 호출부가 여럿이다(코스 슬롯 루프·추천 두 경로). 어느 한 호출부에
    메모를 두면 나머지는 그대로 왕복한다. 그리고 실패는 캐시하지 않는다 — 일시적 장애를
    5분 동안 '데이터 없음' 으로 굳히면 그게 곧 이 저장소가 계속 지적해 온 '실패를 사실로
    파는' 모양이 된다.
    """
    key = _grid_key(latitude, longitude)
    cached = _points_cache_get(key)
    if cached is not None:
        return cached

    lock = _points_locks.setdefault(key, asyncio.Lock())
    async with lock:
        # 락을 기다리는 동안 다른 코루틴이 채웠을 수 있다.
        cached = _points_cache_get(key)
        if cached is not None:
            return cached
        points = await _load_points_uncached(latitude, longitude, now)
        _points_cache_put(key, points)
        return points


async def _load_points_uncached(
    latitude: float, longitude: float, now: datetime
) -> list[AreaDemandPoint]:
    global _rpc_missing_until, _raw_cache
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    if time.monotonic() >= _rpc_missing_until:
        try:
            points = await _fetch_points_via_rpc(latitude, longitude, now)
        except Exception as exc:
            if not _is_missing_points_rpc(exc):
                raise
            _rpc_missing_until = time.monotonic() + _RPC_MISSING_RETRY_SECONDS
            logger.warning("area_demand_points_rpc_missing", error=str(exc))
        else:
            _rpc_missing_until = 0.0
            if _raw_cache is not None:
                # RPC 가 살아 있으면 폴백용 원본(수십 MB)을 붙들고 있을 이유가 없다.
                _raw_cache = None
            return points
    parents, lots = await _load_raw_history(now)
    return aggregate_nearby_points(parents, lots, latitude, longitude)


async def _load_raw_history(now: datetime) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """폴백 전용 — RPC 가 없는 DB 에서만 호출된다.

    5분 TTL 에 stale-while-revalidate 가 없어 만료 직후 한 요청이 갱신 비용을 전부
    뒤집어쓴다. RPC 경로에는 TTL 캐시 자체가 없어 그 문제가 구조적으로 사라지므로,
    여기는 배포 창 한정 임시 경로로 두고 고치지 않는다(마이그레이션 적용 후 삭제 대상).
    """
    global _raw_cache
    monotonic_now = time.monotonic()
    if _raw_cache and monotonic_now - _raw_cache[0] < _CACHE_TTL_SECONDS:
        return _raw_cache[1], _raw_cache[2]
    async with _raw_cache_lock:
        monotonic_now = time.monotonic()
        if _raw_cache and monotonic_now - _raw_cache[0] < _CACHE_TTL_SECONDS:
            return _raw_cache[1], _raw_cache[2]
        cutoff = (now - timedelta(days=_LOOKBACK_DAYS)).isoformat()
        parents = await asyncio.to_thread(
            fetch_all_rows,
            supabase_admin,
            "area_demand_snapshots",
            "id,source,observed_at,bucket_at",
            1000,
            lambda query: query.eq("source", _SOURCE).gte("observed_at", cutoff),
        )
        parent_ids = [str(row["id"]) for row in parents if row.get("id")]
        lots: list[dict[str, Any]] = []
        for offset in range(0, len(parent_ids), 200):
            batch = parent_ids[offset:offset + 200]
            if not batch:
                continue
            lots.extend(await asyncio.to_thread(
                fetch_all_rows,
                supabase_admin,
                "area_demand_snapshot_lots",
                "snapshot_id,source_lot_id,latitude,longitude,total_spaces,available_spaces",
                1000,
                lambda query, ids=batch: query.in_("snapshot_id", ids),
            ))
        _raw_cache = (monotonic_now, parents, lots)
        return parents, lots


async def prefetch_area_demand_points(
    coordinates: list[tuple[float, float]],
    *,
    now: datetime | None = None,
    max_concurrency: int = 6,
) -> int:
    """후보들의 시계열을 **격자 단위로 한 번에** 미리 받아 둔다. 채운 격자 수를 돌려준다.

    왜 필요한가: 캐시만 두면 왕복 수는 격자 수로 줄지만 **여전히 직렬**이다 — 채점이
    후보를 하나씩 돌며 미스마다 한 번씩 기다린다. 슬롯 루프에 들어가기 전에 여기서 한 번에
    병렬로 채워 두면, 채점 경로는 전부 캐시 히트가 되어 왕복 지연이 겹쳐 사라진다.
    (보행 경로를 슬롯당 1회로 묶은 것과 같은 패턴이다.)

    실패는 삼킨다. 예열은 **최적화이지 계약이 아니다** — 여기서 실패해도 채점 경로가 각자
    다시 시도하고, 거기서 실패하면 그때 정직하게 `None`(신호 없음)으로 닫힌다. 예열 실패를
    이유로 코스를 통째로 실패시키면 최적화가 장애 지점이 된다.

    max_concurrency: Render 무료 인스턴스의 단일 워커를 고려한 상한. 격자가 수십 개여도
    동시 왕복은 이 수를 넘지 않는다.
    """
    now = now or datetime.now(timezone.utc)
    unique: list[tuple[float, float]] = []
    seen: set[tuple[float, float]] = set()
    for lat, lng in coordinates:
        key = _grid_key(lat, lng)
        if key in seen or _points_cache_get(key) is not None:
            continue
        seen.add(key)
        unique.append((lat, lng))
    if not unique:
        return 0

    semaphore = asyncio.Semaphore(max(1, max_concurrency))

    async def _one(lat: float, lng: float) -> None:
        async with semaphore:
            try:
                await _load_points(lat, lng, now)
            except Exception as exc:  # noqa: BLE001 — 위 독스트링 참조
                logger.warning("area_demand_prefetch_failed", error=str(exc))

    await asyncio.gather(*(_one(lat, lng) for lat, lng in unique))
    logger.info("area_demand_prefetch", grids=len(unique), requested=len(coordinates))
    return len(unique)


async def get_historical_area_demand_forecast(
    latitude: float,
    longitude: float,
    arrival: datetime,
    *,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """DB 오류나 부족한 표본은 숫자를 만들지 않고 ``None``으로 닫는다."""
    now = now or datetime.now(timezone.utc)
    try:
        points = await _load_points(latitude, longitude, now)
    except Exception as exc:
        # 예전에는 통째로 삼켰다. 실패해도 추천은 나가므로(신호 하나가 빠질 뿐) 계속
        # 닫되, 조용히 사라지지는 않게 남긴다.
        logger.warning("area_demand_points_unavailable", error=str(exc))
        return None
    # 격자 캐시의 같은 시계열을 후보·요청마다 다시 훑지 않게 색인을 쓴다(값은 그대로 — _SeriesIndex).
    forecast = _forecast_from_points(
        points, arrival, now, _series_index_for(_grid_key(latitude, longitude), points)
    )
    if forecast is None:
        return None
    # ⚠️ 반드시 스레드로 내보낸다 — 캐시 미스 1건이 이벤트 루프를 **초 단위**로 막는다.
    # (미스 = 56일치 최대 ~8,000점을 2시간 간격으로 슬라이스하며 매번 forecast+median+sort:
    #  이 파일 docstring 의 실측으로 후보당 0.28~6.4초.)
    #
    # 코스 추천이 자리마다 '지금 서 있는 자리' 기준으로 후보를 다시 추리게 되면서 한 요청이
    # 훑는 **서로 다른 좌표**가 3배가 됐고, 캐시 키에 좌표가 들어가는 이상 미스도 그만큼
    # 늘었다. 게다가 2·3번 자리는 누적 도착이 항상 live 지평(30분) 밖이라 **반드시** 이
    # 이력 경로로 온다. Render 무료 플랜은 워커가 하나라 여기서 루프를 잡으면 같은
    # 프로세스의 다른 요청까지 함께 멈춘다(프런트 타임아웃 20초).
    # 결과값은 그대로다 — 바뀌는 것은 '어느 스레드에서 도느냐' 뿐이다.
    quality = await asyncio.to_thread(_cached_backtest, points, latitude, longitude)
    usable = bool(
        quality["sample_count"] >= 30
        and quality["mae"] is not None
        and quality["mae"] <= 0.15
        and quality["improvement_rate"] is not None
        and quality["improvement_rate"] >= 0.20
    )
    if not usable:
        return None
    forecast["validation"] = quality
    return forecast


async def get_area_demand_forecast_quality(
    latitude: float,
    longitude: float,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """해당 권역의 시간 순서 백테스트와 현재 데이터 범위를 반환한다."""
    now = now or datetime.now(timezone.utc)
    points = await _load_points(latitude, longitude, now)
    # 위 get_historical_area_demand_forecast 와 같은 이유로 오프로드한다(같은 비용).
    quality = await asyncio.to_thread(_cached_backtest, points, latitude, longitude)
    if not points:
        return {
            **quality, "usable": False, "point_count": 0,
            "data_from": None, "data_to": None,
        }
    # 공식 모델 승격 기준과 같은 MAE 0.15를 넘으면 사용자 행동 근거로 승격하지 않는다.
    usable = bool(
        quality["sample_count"] >= 30
        and quality["mae"] is not None
        and quality["mae"] <= 0.15
        and quality["improvement_rate"] is not None
        and quality["improvement_rate"] >= 0.20
    )
    return {
        **quality,
        "usable": usable,
        "point_count": len(points),
        "data_from": points[0].observed_at.isoformat(),
        "data_to": points[-1].observed_at.isoformat(),
    }


def backtest_forecast_points(points: list[AreaDemandPoint]) -> dict[str, Any]:
    """시간 순서 홀드아웃 MAE. 각 실제값은 그 시점 이전 관측만 사용한다.

    결과는 아래 ``_backtest_forecast_points_reference``(예전 구현)와 **비트 단위로 같다**.
    예전 구현은 2시간 간격 평가점(~321개)마다 앞쪽 전체(최대 ~8,000점)를 다시 훑으며 점마다
    astimezone 을 2~4번 불렀다 — 격자 하나에 CPU 1.3~1.9초, 0.5 CPU 인스턴스에서 벽시계
    2.5~4초였고 코스 한 번(2·3번 자리)과 대기판 by-type 마다 여러 번 돌았다.

    바뀌는 것은 '어떻게 세느냐' 뿐이다.
    - 점마다 UTC 순간·주말 여부·KST 시각(분)·KST 날짜를 **한 번만** 계산한다.
    - 같은 요일군 ±30분 창은 (주말, 시각분) 버킷 61개에서 ``index < i`` 인 점만 읽는다.
      ``_circular_minutes(m, t) <= 30`` 인 m 은 정확히 ``(t + d) % 1440, d ∈ [-30, 30]`` 이다.
      읽은 인덱스를 오름차순으로 정렬해 예전과 **같은 순서**로 median·max·min 에 넣는다.
    - 최근 추세 ``recent_all`` 은 정렬된 앞쪽에서 ``utc < cutoff`` 인 접두부다(정렬이
      안정적이므로 다시 정렬해도 같은 리스트) — bisect 로 끝 위치만 찾는다.
    - 단순 비교치(같은 요일군 중앙값)는 insort 로 유지하는 정렬 리스트에서 구한다. insort_right
      는 같은 값 사이에서 삽입 순서를 지키므로 ``sorted(same_slot)`` 과 원소 단위로 같다.
    - 부동소수 식(baseline·recent_adjustment·round)은 예전과 한 글자도 다르지 않다.
    tz 가 없는(naive) 시각, 고정 오프셋이 아닌 tzinfo, NaN 수준이 하나라도 있으면 예전 구현으로
    그대로 넘긴다(그 경우의 의미를 다시 증명하지 않기 위해). 운영 RPC 점은 늘 고정 오프셋·유한값이다.
    """
    for point in points:
        tzinfo = point.observed_at.tzinfo
        if not isinstance(tzinfo, timezone) or point.level != point.level:
            return _backtest_forecast_points_reference(points)
    ordered = sorted(points, key=lambda point: point.observed_at)
    if not ordered:
        return {"sample_count": 0, "mae": None, "baseline_mae": None, "improvement_rate": None}
    total = len(ordered)
    observed = [point.observed_at for point in ordered]
    levels = [point.level for point in ordered]
    instants = [value.astimezone(timezone.utc) for value in observed]
    weekend = [_is_weekend(value) for value in observed]
    clock = [_clock_minutes(value) for value in observed]
    local_dates = [value.astimezone(KST).date() for value in observed]
    buckets: dict[tuple[bool, int], list[int]] = {}
    for position in range(total):
        buckets.setdefault((weekend[position], clock[position]), []).append(position)
    window_offsets = range(-_TIME_WINDOW_MINUTES, _TIME_WINDOW_MINUTES + 1)
    # 같은 요일군 수준을 앞쪽(ordered[:index])만큼 정렬해 둔다(단순 비교치용).
    same_slot_sorted: dict[bool, list[float]] = {True: [], False: []}
    inserted = 0

    predictions: list[tuple[float, float, float]] = []
    eval_cutoff = observed[-1] - timedelta(days=28)
    first_eval_index = next(
        (index for index, value in enumerate(observed) if value >= eval_cutoff),
        total,
    )
    last_eval_at: datetime | None = None
    for index in range(first_eval_index, total):
        actual_at = observed[index]
        if last_eval_at is not None and actual_at - last_eval_at < timedelta(hours=2):
            continue
        last_eval_at = actual_at
        while inserted < index:
            bisect.insort(same_slot_sorted[weekend[inserted]], levels[inserted])
            inserted += 1
        level = _backtest_forecast_level(
            index, instants[index], clock[index], weekend[index],
            buckets, window_offsets, observed, levels, instants, local_dates,
        )
        if level is None:
            continue
        same_slot = same_slot_sorted[weekend[index]]
        if not same_slot:
            continue
        naive = statistics.median(same_slot)
        predictions.append((float(level), levels[index], naive))
    if not predictions:
        return {"sample_count": 0, "mae": None, "baseline_mae": None, "improvement_rate": None}
    mae = sum(abs(predicted - actual) for predicted, actual, _ in predictions) / len(predictions)
    baseline_mae = sum(abs(naive - actual) for _, actual, naive in predictions) / len(predictions)
    improvement = (baseline_mae - mae) / baseline_mae if baseline_mae > 0 else None
    return {
        "sample_count": len(predictions),
        "mae": round(mae, 4),
        "baseline_mae": round(baseline_mae, 4),
        "improvement_rate": round(improvement, 4) if improvement is not None else None,
    }


def _backtest_forecast_level(
    index: int,
    cutoff: datetime,
    target_clock: int,
    target_weekend: bool,
    buckets: dict[tuple[bool, int], list[int]],
    window_offsets: range,
    observed: list[datetime],
    levels: list[float],
    instants: list[datetime],
    local_dates: list[Any],
) -> float | None:
    """``forecast_from_points(ordered[:index], t, now=t)["level"]`` 와 같은 값(t = 평가 시각).

    arrival == now 이므로 horizon 은 0, decay 는 1.0 이다 — 식은 그대로 둔다.
    """
    eligible: list[int] = []
    for offset in window_offsets:
        bucket = buckets.get((target_weekend, (target_clock + offset) % (24 * 60)))
        if not bucket:
            continue
        for position in bucket[: bisect.bisect_left(bucket, index)]:
            if instants[position] < cutoff:
                eligible.append(position)
    eligible.sort()  # 예전과 같은 순서(앞쪽 리스트 순서)
    if len(eligible) < _MIN_SAMPLES or len({local_dates[p] for p in eligible}) < _MIN_DISTINCT_DATES:
        return None
    coverage_days = (
        max(observed[p] for p in eligible)
        - min(observed[p] for p in eligible)
    ).total_seconds() / 86_400.0
    if coverage_days < _MIN_COVERAGE_DAYS:
        return None
    baseline = statistics.median(levels[p] for p in eligible)
    # recent_all == ordered[:recent_end]: 정렬된 앞쪽에서 utc < cutoff 인 부분은 접두부다.
    recent_end = bisect.bisect_left(instants, cutoff, 0, index)
    recent_adjustment = 0.0
    if recent_end >= 9:
        freshness = cutoff - instants[recent_end - 1]
        if timedelta(0) <= freshness <= timedelta(minutes=45):
            recent = statistics.median(levels[recent_end - 3:recent_end])
            previous = statistics.median(levels[recent_end - 9:recent_end - 3])
            arrival = now = observed[index]
            horizon_minutes = max(0.0, (arrival - now).total_seconds() / 60.0)
            decay = max(0.0, 1.0 - horizon_minutes / 180.0)
            recent_adjustment = max(
                -_MAX_RECENT_ADJUSTMENT,
                min(_MAX_RECENT_ADJUSTMENT, (recent - previous) * decay),
            )
    level = _clamp(baseline + recent_adjustment)
    return round(level, 4)


def _backtest_forecast_points_reference(points: list[AreaDemandPoint]) -> dict[str, Any]:
    """예전 구현(정의). 빠른 경로가 전제를 못 세울 때의 폴백이자 동등성 시험의 기준."""
    predictions: list[tuple[float, float, float]] = []
    ordered = sorted(points, key=lambda point: point.observed_at)
    # 10분 자료와 전환 전 15분 자료가 섞여도 최근 28일을 시간으로 자르고, 실제
    # observed_at 기준 2시간 간격으로만 평가한다. 각 예측은 해당 시점 이전 자료만 사용한다.
    if not ordered:
        return {"sample_count": 0, "mae": None, "baseline_mae": None, "improvement_rate": None}
    eval_cutoff = ordered[-1].observed_at - timedelta(days=28)
    first_eval_index = next(
        (index for index, point in enumerate(ordered) if point.observed_at >= eval_cutoff),
        len(ordered),
    )
    last_eval_at: datetime | None = None
    for index in range(first_eval_index, len(ordered)):
        actual = ordered[index]
        if last_eval_at is not None and actual.observed_at - last_eval_at < timedelta(hours=2):
            continue
        last_eval_at = actual.observed_at
        prior = ordered[:index]
        forecast = forecast_from_points(prior, actual.observed_at, now=actual.observed_at)
        if forecast is None:
            continue
        same_slot = [
            point.level for point in prior
            if _is_weekend(point.observed_at) == _is_weekend(actual.observed_at)
        ]
        if not same_slot:
            continue
        naive = statistics.median(same_slot)
        predictions.append((float(forecast["level"]), actual.level, naive))
    if not predictions:
        return {"sample_count": 0, "mae": None, "baseline_mae": None, "improvement_rate": None}
    mae = sum(abs(predicted - actual) for predicted, actual, _ in predictions) / len(predictions)
    baseline_mae = sum(abs(naive - actual) for _, actual, naive in predictions) / len(predictions)
    improvement = (baseline_mae - mae) / baseline_mae if baseline_mae > 0 else None
    return {
        "sample_count": len(predictions),
        "mae": round(mae, 4),
        "baseline_mae": round(baseline_mae, 4),
        "improvement_rate": round(improvement, 4) if improvement is not None else None,
    }


def _cached_backtest(
    points: list[AreaDemandPoint], latitude: float, longitude: float
) -> dict[str, Any]:
    if not points:
        return backtest_forecast_points(points)
    key = (
        round(latitude, 3),
        round(longitude, 3),
        len(points),
        points[-1].observed_at.isoformat(),
    )
    while True:
        with _quality_lock:
            now = time.monotonic()
            cached = _quality_cache.get(key)
            if cached and now - cached[0] < _QUALITY_CACHE_TTL_SECONDS:
                return cached[1]
            running = _quality_inflight.get(key)
            if running is None:
                done = threading.Event()
                _quality_inflight[key] = done
                break
        # 같은 키를 다른 스레드가 계산 중이다 — 끝나면 캐시를 다시 본다. 그쪽이 실패했으면
        # 캐시가 비어 있으므로 다음 바퀴에서 이 호출이 직접 계산한다(예외를 나눠 갖지 않는다).
        running.wait()

    try:
        quality = backtest_forecast_points(points)
    except BaseException:
        with _quality_lock:
            _quality_inflight.pop(key, None)
        done.set()
        raise

    # 예전에는 여기서 _quality_cache.clear() 를 했다. 그런데 키에 좌표가 들어가므로
    # (round(lat,3), round(lng,3), ...) 한 번의 추천 안에서도 후보마다 키가 다르고,
    # 항목을 하나만 남기면 **모든 후보가 반드시 빗나간다** — TTL 30분짜리 캐시가 사실상
    # 없는 것과 같았고 비싼 백테스트가 후보 수만큼 돌았다.
    #
    # 키는 그대로 둔다(좌표를 빼면 다른 지점의 결과를 서로 주고받게 된다). 대신 크기만
    # 묶는다: 만료된 항목을 먼저 걷어내고, 그래도 넘치면 오래된 것부터 버린다.
    with _quality_lock:
        if len(_quality_cache) >= _QUALITY_CACHE_MAX_ENTRIES:
            for stale_key in [k for k, (at, _) in _quality_cache.items()
                              if now - at >= _QUALITY_CACHE_TTL_SECONDS]:
                _quality_cache.pop(stale_key, None)
            while len(_quality_cache) >= _QUALITY_CACHE_MAX_ENTRIES:
                oldest = min(_quality_cache, key=lambda k: _quality_cache[k][0])
                _quality_cache.pop(oldest, None)

        _quality_cache[key] = (now, quality)
        _quality_inflight.pop(key, None)
    done.set()
    return quality
