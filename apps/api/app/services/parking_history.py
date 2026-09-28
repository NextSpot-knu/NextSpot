"""주차 이력 행렬 저장소 — 권역 수요 전망(app/services/area_demand_forecast_service.py)의 원본을 메모리에 든다(P2a).

무엇이 문제였나
  권역 수요 전망은 좌표 격자(약 100m)마다 area_demand_points_near RPC 로 56일 시계열을 다시 읽는다. 격자 하나가
  1MB 남짓이라 캐시가 최대 96격자까지 쌓이고, 같은 격자 안의 다른 장소는 먼저 물은 장소의 시계열·품질을 5~30분
  동안 받는다. 원본은 주차장 4곳 × 10분 스냅샷 약 8천 개 — 행렬 하나(1MB 미만)면 모든 좌표를 메모리에서 계산할 수 있다.

이 모듈이 하는 일(이 커밋: 자료구조와 순수 함수만 — I/O 없음)
  · HistorySnapshot — 주차장 열(LotColumn) × 시각 행의 불변 행렬. 바꿀 때는 새로 만들어 참조 하나를 바꿔 끼운다.
  · parse_page — PostgREST 응답 행(부모 스냅샷 + 끼워 넣은 주차장 행)을 _Row 로 옮긴다.
  · merge — DB 에서 읽은 행(권위 있는 원본)을 버킷 단위로 통째로 바꿔 넣고, 56일 + 1시간 창 밖을 잘라 낸다.
    바뀐 것이 없으면 None(세대 번호를 쓰지 않는다).
  · window_start — SQL 의 ``observed_at >= p_since`` 와 같은 경계(µs 단위)로 창의 시작 행을 찾는다.
  · 세대 번호 — 프로세스 전체에서 한 방향으로만 늘어나는 번호. 전량 재적재 뒤에도 되돌아가지 않으므로 세대를 키에
    넣은 메모는 옛 내용을 돌려줄 수 없다.

지키는 동등성
  · 무효 칸(total ≤ 0, available < 0, available > total, 키 없음, 숫자 아님)은 '없음'(total = 0)으로 저장한다.
    aggregate_nearby_points 가 ``continue`` 로 건너뛰는 집합과 똑같다(변환도 같은 int()/float()).
  · 행 순서는 (observed_at, bucket_at) 오름차순 — RPC 의 ``ORDER BY observed_at`` 과 같다(µs 까지 같은 두 버킷은
    관측된 적 없음, 스펙 R8).
  · 시각 ↔ µs 변환은 정수 연산만 쓴다. ``int(dt.timestamp() * 1e6)`` 은 부동소수 오차로 1µs 틀릴 수 있다.

이 모듈은 전망 서비스를 import 하지 않는다(전망 서비스가 이 모듈을 import 한다). 그래서 _LOOKBACK_DAYS 를 여기에
한 번 더 적고 시험이 두 값이 같은지 잠근다. 시각 파서도 호출자가 넘긴다(parse_page 의 ``aware``).
"""

from __future__ import annotations

import hashlib
import itertools
import math
from array import array
from bisect import bisect_left
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, NamedTuple

# 전망 서비스의 _LOOKBACK_DAYS(56)와 같아야 한다 — tests/services/test_parking_history.py 가 잠근다.
LOOKBACK_DAYS = 56
LOOKBACK = timedelta(days=LOOKBACK_DAYS)
# 창을 1시간 넉넉히 들고 있는다: 요청의 since(= now − 56일)가 마지막 병합 시각보다 조금 뒤여도 창 안에 있게.
WINDOW_MARGIN = timedelta(hours=1)
# 열(주차장 × 좌표)이 이보다 많으면 행렬로 답하지 않는다(servable 이 판단 — 적재 루프 커밋).
MAX_COLUMNS = 64

_LOTS_KEY = "area_demand_snapshot_lots"
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_ONE_US = timedelta(microseconds=1)
_INT32_MAX = 2**31 - 1
_ABSENT = (0, 0)  # 없는/무효 칸의 (total, available)


@dataclass(frozen=True, slots=True, order=True)
class LotColumn:
    """행렬의 열 하나 = (주차장 ID, 위도, 경도). 좌표가 바뀐 주차장은 새 열이 된다(거리 가중이 좌표에 달려 있다)."""

    lot_id: str
    latitude: float
    longitude: float


@dataclass(frozen=True, eq=False)
class HistorySnapshot:
    """주차 이력 행렬 — 만든 뒤에는 바꾸지 않는다. 읽는 쪽은 참조 하나를 잡고 끝까지 그것만 쓴다.

    ``eq=False``: 배열 수천 칸을 ==로 비교하거나 해시하려는 실수를 막는다(같음은 digest 로 본다).
    """

    generation: int  # 프로세스 전체 카운터에서 받은 번호 — 늘어나기만 하고 되돌아가지 않는다
    columns: tuple[LotColumn, ...]  # (lot_id, lat, lng) 정렬 — 합산 순서를 결정적으로 고정한다
    bucket_us: array  # 'q' — bucket_at 의 UTC epoch µs, 행 순서
    observed_us: array  # 'q' — observed_at 의 UTC epoch µs, 오름차순(정렬 키 (observed_us, bucket_us))
    observed: tuple[datetime, ...]  # tz=UTC. 바뀌지 않은 행은 병합을 거쳐도 같은 객체를 재사용한다
    total: tuple[array, ...]  # 열마다 'i', 길이 T. 0 = 없음/무효
    avail: tuple[array, ...]  # 열마다 'i', 길이 T
    floor_us: int  # observed_at >= floor 인 행은 이 스냅샷에 빠짐없이 들어 있다
    digest: str  # blake2b-16(열·시각·칸) — 로그에만 쓴다(/health 에는 내지 않는다)


class _Row(NamedTuple):
    """DB 행 하나(부모 스냅샷 + 유효한 주차장 칸)."""

    bucket_us: int
    observed_us: int
    observed_dt: datetime
    cells: dict[LotColumn, tuple[int, int]]  # 열 → (total, available), 유효한 칸만


# ── 세대 번호 ────────────────────────────────────────────────────────────────
# 프로세스 전체에서 하나. 바꿔 끼우는 스냅샷마다(전량 재적재 포함) 새 번호를 받는다. 병합이 아무것도 바꾸지 않으면
# 번호를 쓰지 않는다. 운영에서는 적재 스레드의 _apply() 만 병합을 부르므로 번호를 받는 곳도 거기 하나다.
_GENERATION = itertools.count(1)


def next_generation() -> int:
    return next(_GENERATION)


# ── 시각 ─────────────────────────────────────────────────────────────────────


def to_us(value: datetime) -> int:
    """aware datetime → UTC epoch µs(정수 연산이라 정확하다). naive 는 TypeError — 조용히 틀리지 않는다."""
    return (value - _EPOCH) // _ONE_US


def from_us(value: int) -> datetime:
    return _EPOCH + timedelta(microseconds=value)


def _as_utc(value: datetime) -> datetime:
    # RPC 경로는 관측 시각을 항상 '+00:00'(timezone.utc)으로 받는다. 같은 isoformat() 을 내도록 UTC 로 맞춘다.
    if value.tzinfo is timezone.utc:
        return value
    return value.astimezone(timezone.utc)


# ── 파싱 ─────────────────────────────────────────────────────────────────────


def _count(counts: dict[str, int] | None, key: str) -> None:
    if counts is not None:
        counts[key] = counts.get(key, 0) + 1


def _parse_cell(lot: Any) -> tuple[LotColumn, int, int] | None:
    """주차장 행 하나 → (열, total, available). aggregate_nearby_points(:254-262)가 건너뛰는 행은 None."""
    if not isinstance(lot, Mapping):
        return None
    try:
        lot_lat = float(lot["latitude"])
        lot_lng = float(lot["longitude"])
        total = int(lot["total_spaces"])
        available = int(lot["available_spaces"])
    except (KeyError, TypeError, ValueError):
        return None
    if total <= 0 or available < 0 or available > total:
        return None
    # DB CHECK 로 불가능한 값들이지만, 행렬('i' 배열)과 열 키(NaN 은 자기 자신과 같지 않다)를 지킨다.
    if total > _INT32_MAX or not (math.isfinite(lot_lat) and math.isfinite(lot_lng)):
        return None
    lot_id = str(lot.get("source_lot_id") or "")
    return LotColumn(lot_id, lot_lat, lot_lng), total, available


def parse_page(
    rows: Iterable[Any],
    *,
    aware: Callable[[Any], datetime | None],
    counts: dict[str, int] | None = None,
) -> list[_Row]:
    """PostgREST 응답 한 쪽을 _Row 로 옮긴다. 순수 함수(I/O 없음).

    ``aware`` 는 전망 서비스의 ``_aware`` (문자열 → aware datetime, 실패하면 None)를 호출자가 넘긴다.
    시각을 못 읽는 행은 건너뛰고 ``counts["skipped_rows"]`` 에, 무효 칸은 ``counts["invalid_cells"]`` 에 센다.
    주차장 칸이 하나도 유효하지 않은 행도 행으로 남긴다(DB 행 수와 대조할 수 있게 — 시계열에서는 빠진다).
    """
    parsed: list[_Row] = []
    for row in rows:
        if not isinstance(row, Mapping):
            _count(counts, "skipped_rows")
            continue
        bucket_at = aware(row.get("bucket_at"))
        observed_at = aware(row.get("observed_at"))
        lots = row.get(_LOTS_KEY)
        if lots is None:
            lots = []
        if bucket_at is None or observed_at is None or not isinstance(lots, list):
            _count(counts, "skipped_rows")
            continue
        observed_at = _as_utc(observed_at)
        cells: dict[LotColumn, tuple[int, int]] = {}
        for lot in lots:
            cell = _parse_cell(lot)
            if cell is None:
                _count(counts, "invalid_cells")
                continue
            column, total, available = cell
            if column in cells:  # (snapshot_id, source_lot_id) 가 PK 라 불가능 — 뒤의 것을 쓴다
                _count(counts, "invalid_cells")
            cells[column] = (total, available)
        parsed.append(_Row(to_us(bucket_at), to_us(observed_at), observed_at, cells))
    return parsed


# ── 병합 ─────────────────────────────────────────────────────────────────────


def _cells_at(snapshot: HistorySnapshot, index: int) -> dict[LotColumn, tuple[int, int]]:
    cells: dict[LotColumn, tuple[int, int]] = {}
    for j, column in enumerate(snapshot.columns):
        total = snapshot.total[j][index]
        if total > 0:
            cells[column] = (total, snapshot.avail[j][index])
    return cells


def _digest(
    columns: tuple[LotColumn, ...],
    bucket_us: array,
    observed_us: array,
    total: tuple[array, ...],
    avail: tuple[array, ...],
) -> str:
    h = hashlib.blake2b(digest_size=16)
    h.update(repr([(c.lot_id, c.latitude, c.longitude) for c in columns]).encode("utf-8"))
    h.update(bucket_us.tobytes())
    h.update(observed_us.tobytes())
    for totals, avails in zip(total, avail):
        h.update(totals.tobytes())
        h.update(avails.tobytes())
    return h.hexdigest()


def merge(
    prev: HistorySnapshot | None,
    rows: Iterable[_Row],
    *,
    now: datetime,
    new_generation: Callable[[], int] = next_generation,
) -> HistorySnapshot | None:
    """DB 행을 버킷 단위로 병합한 새 스냅샷. 바뀐 것이 없으면 None. 순수 함수(세대 번호 발급 외에 부수 효과 없음).

    · 모든 행은 DB 에서 온 권위 있는 원본이다. 같은 버킷의 (observed_at, 칸)이 다르면 그 버킷을 **통째로** 바꾼다
      (DB 의 기록 함수도 더 새 observed_at 이면 부모를 갱신하고 주차장 행을 전부 갈아 끼운다). 없던 버킷은 넣는다.
    · ``observed_at < now − 56일 − 1시간`` 인 행은 잘라 내고, 유효한 칸이 하나도 없는 열은 뺀다.
    · ``prev is None`` 은 빈 바탕에서 시작하는 전량 적재다 — 항상 스냅샷을 돌려준다(행이 0개여도). 호출자는
      ``observed_at >= now − 56일 − 1시간`` 인 행을 **전부** 읽었어야 한다(floor_us 가 그 경계다).
    · O(T·L), 바뀐 경우에만 다시 짓는다.
    """
    cutoff_us = to_us(now - LOOKBACK - WINDOW_MARGIN)

    incoming: dict[int, _Row] = {}
    for row in rows:
        seen = incoming.get(row.bucket_us)
        if seen is None or row.observed_us >= seen.observed_us:  # 한 번에 같은 버킷이 두 번 오면 더 새 것
            incoming[row.bucket_us] = row

    # 버킷이 여러 행에 있을 수 없다(UNIQUE(source, bucket_at)). 예전 스냅샷의 버킷 → 행 번호.
    prev_index: dict[int, int] = {}
    if prev is not None:
        prev_index = {bucket: i for i, bucket in enumerate(prev.bucket_us)}

    replaced: set[int] = set()  # 바뀐(또는 바꿀) 예전 행 번호
    added: list[_Row] = []
    for bucket, row in incoming.items():
        i = prev_index.get(bucket)
        if i is not None:
            assert prev is not None
            if row.observed_us == prev.observed_us[i] and row.cells == _cells_at(prev, i):
                continue
            replaced.add(i)
        if row.observed_us >= cutoff_us:
            added.append(row)

    # (observed_us, bucket_us, observed_dt, 원본) — 원본은 예전 행 번호(int) 또는 새 칸(dict)
    entries: list[tuple[int, int, datetime, int | dict[LotColumn, tuple[int, int]]]] = []
    trimmed = 0
    if prev is not None:
        for i, (bucket, observed) in enumerate(zip(prev.bucket_us, prev.observed_us)):
            if i in replaced:
                continue
            if observed < cutoff_us:
                trimmed += 1
                continue
            entries.append((observed, bucket, prev.observed[i], i))
    if prev is not None and not replaced and not added and not trimmed:
        return None
    for row in added:
        entries.append((row.observed_us, row.bucket_us, row.observed_dt, row.cells))
    entries.sort(key=lambda entry: (entry[0], entry[1]))

    prev_columns = {column: j for j, column in enumerate(prev.columns)} if prev is not None else {}
    candidates = set(prev_columns)
    for row in added:
        candidates.update(row.cells)

    sources = [entry[3] for entry in entries]
    columns: list[LotColumn] = []
    totals_out: list[array] = []
    avails_out: list[array] = []
    for column in sorted(candidates):
        prev_j = prev_columns.get(column)
        if prev is not None and prev_j is not None:
            # 예전 배열에서 무효 칸은 (0, 0) 으로 저장돼 있으므로 그대로 옮기면 된다.
            pt, pa = prev.total[prev_j], prev.avail[prev_j]
            totals = array("i", [pt[s] if s.__class__ is int else s.get(column, _ABSENT)[0] for s in sources])
            avails = array("i", [pa[s] if s.__class__ is int else s.get(column, _ABSENT)[1] for s in sources])
        else:
            totals = array("i", [0 if s.__class__ is int else s.get(column, _ABSENT)[0] for s in sources])
            avails = array("i", [0 if s.__class__ is int else s.get(column, _ABSENT)[1] for s in sources])
        if any(totals):  # 유효한 칸이 하나도 없는 열은 뺀다
            columns.append(column)
            totals_out.append(totals)
            avails_out.append(avails)

    bucket_us = array("q", (entry[1] for entry in entries))
    observed_us = array("q", (entry[0] for entry in entries))
    total_t = tuple(totals_out)
    avail_t = tuple(avails_out)
    columns_t = tuple(columns)
    floor_us = cutoff_us if prev is None else max(prev.floor_us, cutoff_us)
    return HistorySnapshot(
        generation=new_generation(),
        columns=columns_t,
        bucket_us=bucket_us,
        observed_us=observed_us,
        observed=tuple(entry[2] for entry in entries),
        total=total_t,
        avail=avail_t,
        floor_us=floor_us,
        digest=_digest(columns_t, bucket_us, observed_us, total_t, avail_t),
    )


def window_start(snapshot: HistorySnapshot, since: datetime) -> int:
    """``observed_at >= since`` 인 첫 행 번호 — SQL 의 ``snap.observed_at >= p_since`` 와 µs 단위로 같은 경계."""
    return bisect_left(snapshot.observed_us, to_us(since))
