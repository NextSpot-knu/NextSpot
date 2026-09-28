"""주차 이력 행렬 저장소 — 권역 수요 전망(app/services/area_demand_forecast_service.py)의 원본을 메모리에 든다(P2a).

무엇이 문제였나
  권역 수요 전망은 좌표 격자(약 100m)마다 area_demand_points_near RPC 로 56일 시계열을 다시 읽는다. 격자 하나가
  1MB 남짓이라 캐시가 최대 96격자까지 쌓이고, 같은 격자 안의 다른 장소는 먼저 물은 장소의 시계열·품질을 5~30분
  동안 받는다. 원본은 주차장 4곳 × 10분 스냅샷 약 8천 개 — 행렬 하나(1MB 미만)면 모든 좌표를 메모리에서 계산할 수 있다.

이 모듈이 하는 일 — 자료구조·순수 함수(I/O 없음)
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

이 모듈이 하는 일 — 적재 루프(_Loader, AREA_DEMAND_SOURCE 가 rpc 가 아닐 때만 돈다)
  · 부팅 적재: lifespan 이 warmup_done 뒤에 start() — 첫 적재는 참조 스냅샷이 준비될 때까지(최대 30초) 기다린다
    (부팅 CPU 를 지도 첫 적재와 나누지 않게). area_demand_snapshots(+주차장 행)를 bucket_at keyset 으로 1000행씩
    읽고, 쪽마다 최대 3번 시도한다(2초·4초 쉼 — 끝낸 쪽은 다시 읽지 않는다). 준비 전 실패 백오프 5→15→45→60초.
  · 꼬리 동기화: 5분마다(수집 직후 kick_tail 이면 곧바로) 최근 2시간을 다시 읽어 병합한다. 실패가 이어지면 창을
    '마지막 성공 + 1시간' 으로 넓히고, 24시간을 넘으면 전량 다시 읽는다. 배포가 겹쳐 다른 인스턴스가 쓴 행도 이것이 잡는다.
  · 대조: 30분마다 행 수·최신 버킷만 DB 와 비교한다. 어긋나면 꼬리를 한 번 읽고 다시 세고, 또 어긋나면 전량 재적재.
  · 모든 변경은 적재 스레드의 _apply() 하나가 한다(그 시점의 스냅샷에 병합해 참조를 바꿔 끼운다). 루프는 결과로
    부기(준비·마지막 성공·실패 수·다음 시각)만 고친다.
  · 전용 데몬 스레드 nextspot-parking — 참조 스냅샷(nextspot-ref)과 나누지 않는다(한쪽의 느린 읽기가 다른 쪽을 줄
    세우지 않게). 요청 경로는 적재를 깨우지 않는다 — 준비 전·오래됨이면 오늘의 RPC 경로가 답한다.
  · rpc 모드(코드 기본값)에서는 스레드·태스크·DB 호출이 하나도 없다. /health 칸도 {"mode": "rpc"} 뿐이다.

이 모듈은 전망 서비스를 import 하지 않는다(전망 서비스가 이 모듈을 import 한다). 그래서 _LOOKBACK_DAYS 를 여기에
한 번 더 적고 시험이 두 값이 같은지 잠근다. 시각 파서도 호출자가 넘긴다(parse_page 의 ``aware`` — 적재 루프는 실행
시점에 전망 서비스의 _aware 를 지연 import 한다). 전망 서비스가 /health 에 더할 숫자와 shadow 자기 탐침은 전망
서비스가 import 될 때 register_health_extra · register_shadow_probe 로 알려 온다.
"""

from __future__ import annotations

import asyncio
import hashlib
import itertools
import math
import time
from array import array
from bisect import bisect_left
from collections import deque
from collections.abc import Awaitable, Callable, Iterable, Mapping
from concurrent.futures import Future
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, NamedTuple

import structlog
from postgrest.types import CountMethod

from app.core.config import settings
from app.core.daemon_executor import DaemonExecutor
from app.core.supabase import supabase_admin

logger = structlog.get_logger()

# 전망 서비스의 _LOOKBACK_DAYS(56)와 같아야 한다 — tests/services/test_parking_history.py 가 잠근다.
LOOKBACK_DAYS = 56
LOOKBACK = timedelta(days=LOOKBACK_DAYS)
# 창을 1시간 넉넉히 들고 있는다: 요청의 since(= now − 56일)가 마지막 병합 시각보다 조금 뒤여도 창 안에 있게.
WINDOW_MARGIN = timedelta(hours=1)
# 열(주차장 × 좌표)이 이보다 많으면 행렬로 답하지 않는다(servable 이 판단).
MAX_COLUMNS = 64

# ── 적재 루프 ─────────────────────────────────────────────────────────────────
PAGE_SIZE = 1000                        # PostgREST 단일 응답 상한과 같다
TAIL_INTERVAL_S = 300.0                 # 꼬리 동기화 주기(수집은 10분마다 — kick_tail 이 곧바로 깨운다)
TAIL_WINDOW = timedelta(hours=2)        # 꼬리가 다시 읽는 최근 구간(배포 겹침·:06 재시도 버킷 교체를 덮는다)
TAIL_GAP_MARGIN = timedelta(hours=1)    # 실패가 이어졌을 때 창 = 마지막 성공 읽기 시작 + 이만큼
TAIL_FULL_RELOAD_AFTER = timedelta(hours=24)  # 창이 이보다 넓어지면 꼬리 대신 전량 다시 읽는다
RECONCILE_INTERVAL_S = 1800.0           # 행 수·최신 버킷 대조
SERVABLE_MAX_SYNC_AGE_S = 900.0         # 마지막 정상 동기화가 이보다 오래면 행렬로 답하지 않는다(RPC 폴백)
BACKOFF_INITIAL_S = 5.0
BACKOFF_FACTOR = 3.0
BACKOFF_MAX_BEFORE_READY_S = 60.0       # 준비 전 — 그동안 RPC 경로가 답하므로 1분이면 충분하다(B2)
BACKOFF_MAX_S = 300.0
PAGE_RETRIES = 3                        # 한 쪽을 한 시도 안에서 최대 몇 번 읽는가
PAGE_RETRY_SLEEP_S = (2.0, 4.0)         # 쪽 재시도 사이 쉼(적재 스레드에서)
BOOT_WAIT_REFERENCE_S = 30.0            # 첫 적재가 참조 스냅샷 준비를 기다리는 상한
BOOT_POLL_S = 1.0
KICK_TAIL_MIN_INTERVAL_S = 20.0
# shadow 자기 탐침 상한 — 최근 24시간 288회(꼬리 주기 5분 기준) + 탐침 사이 최소 290초. kick 꼬리·대조 꼬리가 타이머 꼬리
# 몇 초 뒤에 이어 와도 탐침 RPC 를 한 번 더 부르지 않는다(그 탐침은 다음 꼬리로 미뤄질 뿐이다). 간격만 300초로 두면
# 수집 지연 요동(2~6초)에 탐침이 하루 ~210회로 줄어 종류별 표본(§5.3, 하루 ≥ 8)이 모자란다 — 그래서 간격 290초 + 24시간 개수.
SHADOW_PROBES_PER_DAY = 288
SHADOW_PROBE_MIN_INTERVAL_S = 290.0
_DAY_S = 86_400.0
LOOP_ERROR_PAUSE_S = 5.0
# 종료(stop) 때 shadow 마지막 요약 전에, 아직 도는 비교(자기 탐침·요청 비교)를 합쳐서 최대 이만큼 기다린다 — 그 결과가
# final 줄에 들어가게. shadow 모드에서만 기다리고, 아무것도 돌지 않으면 곧바로 지나간다.
SHADOW_DRAIN_TIMEOUT_S = 3.0
MIN_LOOP_SLEEP_S = 0.05                 # 루프가 한 바퀴마다 최소한 쉬는 시간(판정이 어긋나도 헛돌지 않게)
MODES = ("rpc", "shadow", "matrix")

# 전망 서비스의 _SOURCE 와 같아야 한다 — 시험이 잠근다.
SOURCE = "gyeongju_its"
_TABLE = "area_demand_snapshots"
_SELECT = (
    "bucket_at,observed_at,"
    "area_demand_snapshot_lots(source_lot_id,latitude,longitude,total_spaces,available_spaces)"
)
_HEALTH_EXTRA_KEYS = ("memo", "fallback_served", "shadow")

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


def _parse_cell(lot: Any, intern: dict[Any, Any] | None = None) -> tuple[LotColumn, int, int] | None:
    """주차장 행 하나 → (열, total, available). aggregate_nearby_points(:254-262)가 건너뛰는 행은 None.

    ``intern`` 이 있으면 같은 값의 열은 처음 만든 객체 하나를 돌려준다(적재 한 번 동안 — 칸마다 열 객체를 새로
    만들면 전량 적재가 수만 개의 작은 객체를 들고 있게 된다).
    """
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
    column = LotColumn(lot_id, lot_lat, lot_lng)
    if intern is not None:
        column = intern.setdefault(column, column)
    return column, total, available


def parse_page(
    rows: Iterable[Any],
    *,
    aware: Callable[[Any], datetime | None],
    counts: dict[str, int] | None = None,
    intern: dict[Any, Any] | None = None,
) -> list[_Row]:
    """PostgREST 응답 한 쪽을 _Row 로 옮긴다. 순수 함수(I/O 없음).

    ``aware`` 는 전망 서비스의 ``_aware`` (문자열 → aware datetime, 실패하면 None)를 호출자가 넘긴다.
    시각을 못 읽는 행은 건너뛰고 ``counts["skipped_rows"]`` 에, 무효 칸은 ``counts["invalid_cells"]`` 에 센다.
    주차장 칸이 하나도 유효하지 않은 행도 행으로 남긴다(DB 행 수와 대조할 수 있게 — 시계열에서는 빠진다).
    ``intern`` (적재 한 번에 하나)을 넘기면 같은 값의 열·(total, available) 칸은 객체 하나를 함께 쓴다 — 값은 같고
    전량 적재가 들고 있는 파싱 결과가 절반 아래로 준다(열 객체·칸 튜플이 칸마다 새로 생기지 않게).
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
            cell = _parse_cell(lot, intern)
            if cell is None:
                _count(counts, "invalid_cells")
                continue
            column, total, available = cell
            if column in cells:  # (snapshot_id, source_lot_id) 가 PK 라 불가능 — 뒤의 것을 쓴다
                _count(counts, "invalid_cells")
            value = (total, available)
            if intern is not None:
                value = intern.setdefault(value, value)
            cells[column] = value
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


# =============================================================================
# 적재 루프
# =============================================================================


def _mono() -> float:
    """판정 시각(monotonic). 시험이 바꿔 끼운다."""
    return time.monotonic()


def _utcnow() -> datetime:
    """읽기 창의 기준 시각. 시험이 바꿔 끼운다."""
    return datetime.now(timezone.utc)


_thread_sleep = time.sleep  # 쪽 재시도 사이 쉼(적재 스레드) — 시험이 바꿔 끼운다

# 전망 서비스가 import 될 때 알려 온다(이 모듈은 전망 서비스를 import 하지 않는다).
_health_extra: Callable[[], Mapping[str, Any]] | None = None
_shadow_probe: Callable[[HistorySnapshot], None] | None = None
_shadow_flush: Callable[[], None] | None = None
_shadow_drain: Callable[[float], Awaitable[int]] | None = None


def mode() -> str:
    """AREA_DEMAND_SOURCE 의 실효 값. 앞뒤 공백·대소문자는 무시하고, 모르는 값은 전부 rpc(도입 전 경로)."""
    value = str(getattr(settings, "AREA_DEMAND_SOURCE", "rpc")).strip().lower()
    return value if value in MODES else "rpc"


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _aware_parser() -> Callable[[Any], datetime | None]:
    # 지연 import — 전망 서비스가 이 모듈을 import 한다(최상단에서 부르면 순환). RPC 경로와 **같은** 파서를 써야
    # 관측 시각 객체(tz=UTC)와 isoformat() 표기가 같다.
    from app.services.area_demand_forecast_service import _aware

    return _aware


def _reference_ready() -> bool:
    """첫 적재를 시작해도 되는가 — 참조 스냅샷이 준비됐거나, 참조 스냅샷이 꺼져 있다(legacy: 적재 루프가 없다)."""
    try:
        from app.services import reference_snapshot

        state = reference_snapshot.health()
        return bool(state.get("ready")) or state.get("serve") != "snapshot"
    except Exception:  # noqa: BLE001 — 판정 실패는 '아직' 으로(상한 30초 뒤에는 어차피 시작한다)
        return False


def _page_query(client, since_iso: str, after_bucket: str | None):
    """적재 쿼리 한 쪽: observed_at >= since(SQL 과 같은 기준)인 행을 bucket_at keyset 으로.

    GET area_demand_snapshots?select=bucket_at,observed_at,area_demand_snapshot_lots(...)
        &source=eq.gyeongju_its&observed_at=gte.<since>[&bucket_at=gt.<last>]&order=bucket_at.asc&limit=1000
    bucket_at 은 (source, bucket_at) UNIQUE 라 keyset 이 행을 빠뜨리거나 두 번 주지 않는다(offset 은 그 사이
    수집이 끼면 경계가 밀린다).
    """
    query = client.table(_TABLE).select(_SELECT).eq("source", SOURCE).gte("observed_at", since_iso)
    if after_bucket is not None:
        query = query.gt("bucket_at", after_bucket)
    return query.order("bucket_at").limit(PAGE_SIZE)


def _count_query(client, since_iso: str):
    """대조 쿼리: 창 안의 행 수(Prefer: count=exact) + 최신 bucket_at 한 행."""
    return (
        client.table(_TABLE)
        .select("bucket_at", count=CountMethod.exact)
        .eq("source", SOURCE)
        .gte("observed_at", since_iso)
        .order("bucket_at", desc=True)
        .limit(1)
    )


def _fetch_page(client, since_iso: str, after_bucket: str | None) -> tuple[list[Any], int]:
    """한 쪽을 최대 PAGE_RETRIES 번 읽는다 → (행들, 다시 시도한 횟수). 끝내 실패하면 마지막 예외를 올린다."""
    retries = 0
    while True:
        try:
            response = _page_query(client, since_iso, after_bucket).execute()
            return list(getattr(response, "data", None) or []), retries
        except Exception:
            retries += 1
            if retries >= PAGE_RETRIES:
                raise
            _thread_sleep(PAGE_RETRY_SLEEP_S[min(retries - 1, len(PAGE_RETRY_SLEEP_S) - 1)])


def _bucket_us_of(row: Any, aware: Callable[[Any], datetime | None]) -> int:
    raw = row.get("bucket_at") if isinstance(row, Mapping) else None
    parsed = aware(raw) if raw is not None else None
    if parsed is None:
        raise RuntimeError(f"{_TABLE}: unreadable bucket_at in keyset cursor")
    return to_us(parsed)


def _change_counts(prev: HistorySnapshot | None, new: HistorySnapshot, rows: list[_Row]) -> dict[str, int]:
    """로그용 (added, replaced, trimmed) — 들어온 행만 본다(O(행 수 × 열 수))."""
    if prev is None:
        return {"added": len(new.bucket_us), "replaced": 0, "trimmed": 0}
    prev_index = {bucket: i for i, bucket in enumerate(prev.bucket_us)}
    new_index = {bucket: i for i, bucket in enumerate(new.bucket_us)}
    added = sum(1 for bucket in new_index if bucket not in prev_index)
    trimmed = sum(1 for bucket in prev_index if bucket not in new_index)
    replaced = 0
    for bucket in {row.bucket_us for row in rows}:
        i, j = prev_index.get(bucket), new_index.get(bucket)
        if i is None or j is None:
            continue
        if prev.observed_us[i] != new.observed_us[j] or _cells_at(prev, i) != _cells_at(new, j):
            replaced += 1
    return {"added": added, "replaced": replaced, "trimmed": trimmed}


class _Loader:
    """주차 이력 적재 루프 하나(모듈 인스턴스 _loader). 루프 태스크는 이벤트 루프에서, 읽기·병합은 전용 스레드에서."""

    def __init__(self) -> None:
        self.snapshot: HistorySnapshot | None = None
        self.ready = False
        self.last_ok_sync: float | None = None          # 마지막 정상 동기화(전량·꼬리)가 끝난 시각(monotonic)
        self.last_ok_sync_wall: datetime | None = None  # 그 읽기의 기준 시각 — 다음 꼬리 창이 여기서부터 덮는다
        self.failures = 0                               # 동기화(전량·꼬리) 연속 실패 — kick_tail 은 이때 아무것도 안 한다
        self.reconcile_failures = 0                     # 대조 연속 실패(따로 센다: 꼬리 성공이 대조 백오프를 지우지 않게)
        self.last_error_type: str | None = None
        self.next_sync_due = 0.0                        # 준비 전엔 전량, 준비 후엔 꼬리
        self.next_reconcile_due = math.inf
        self._tail_requested = False                    # kick_tail — 진행 중인 적재가 성공해도 남는다(실패하면 버린다)
        self._last_kick = -math.inf
        self._probe_times: deque[float] = deque()       # 최근 24시간 자기 탐침을 시작한 시각(monotonic, ≤288개)
        self._probe_future: Future | None = None        # 마지막 자기 탐침(적재 스레드) — stop 이 final 요약 전에 기다린다
        self._gate_done = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._task: asyncio.Task | None = None
        self._wake: asyncio.Event | None = None
        self._executor: DaemonExecutor | None = None
        self._started = False

    # ── 수명 ────────────────────────────────────────────────────────────────
    def start(self) -> None:
        current_mode = mode()
        if current_mode == "rpc":
            return  # 도입 전 그대로: 스레드·태스크·DB 호출·로그 모두 없음
        if self._task is not None and not self._task.done():
            return
        self._loop = asyncio.get_running_loop()
        self._wake = asyncio.Event()
        if self._executor is None:
            # 전용 데몬 스레드 1개: 적재는 서로 겹치지 않고(단일 비행), 요청용 I/O 풀을 잡아먹지 않으며,
            # 매달린 읽기(httpx 120초)가 프로세스 종료를 붙잡지 않는다.
            self._executor = DaemonExecutor("nextspot-parking")
        self._started = True
        self._task = self._loop.create_task(self._run(), name="parking-history")
        logger.info("parking_history_started", mode=current_mode)

    async def stop(self) -> None:
        self._started = False
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except BaseException:  # noqa: BLE001 — 취소·정리 실패가 종료를 막지 않게
                pass
        executor, self._executor = self._executor, None
        if executor is not None:
            executor.shutdown(wait=False, cancel_futures=True)

    def ensure_running(self) -> None:
        """루프 태스크가 (버그로) 죽었으면 다시 띄운다 — 이벤트 루프에서만 부른다(요청 경로의 감독자)."""
        if not self._started or self._loop is None:
            return
        if self._task is not None and not self._task.done():
            return
        try:
            if asyncio.get_running_loop() is not self._loop:
                return
        except RuntimeError:
            return
        died = None
        if self._task is not None and not self._task.cancelled():
            died = self._task.exception()
        logger.error(
            "parking_history_loop_error",
            restarted=True, error_type=type(died).__name__ if died is not None else None,
            error=str(died)[:300] if died is not None else None,
        )
        self._task = self._loop.create_task(self._run(), name="parking-history")

    async def _in_thread(self, fn, *args):
        executor = self._executor
        if executor is None:
            raise RuntimeError("parking history loader is not running")
        return await asyncio.get_running_loop().run_in_executor(executor, fn, *args)

    # ── 루프 ────────────────────────────────────────────────────────────────
    async def _run(self) -> None:
        if not self._gate_done:
            await self._boot_gate()
            self._gate_done = True
        while True:
            try:
                await self._step()
                await self._sleep()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — 한 바퀴의 버그가 루프를 죽이지 않게(감독)
                logger.error(
                    "parking_history_loop_error", error_type=type(exc).__name__, error=str(exc)[:300],
                )
                await asyncio.sleep(LOOP_ERROR_PAUSE_S)

    async def _boot_gate(self) -> None:
        """첫 적재는 참조 스냅샷이 준비될 때까지(최대 BOOT_WAIT_REFERENCE_S) 기다린다 — 0.5 CPU 부팅에서 지도
        첫 적재·시각 판정과 CPU 를 나누지 않게. 기다리는 동안 CPU 를 쓰지 않는다(1초마다 메모리 읽기 한 번)."""
        started = _mono()
        while not _reference_ready():
            remaining = BOOT_WAIT_REFERENCE_S - (_mono() - started)
            if remaining <= 0:
                logger.info("parking_history_boot_gate_timeout", waited_s=round(_mono() - started, 1))
                return
            await asyncio.sleep(min(BOOT_POLL_S, remaining))

    async def _step(self) -> None:
        """지금 할 일을 한다(잠들지는 않는다 — _sleep 이 따로)."""
        if not self.ready:
            if _mono() >= self.next_sync_due:
                await self._full("boot")
            return
        if self._tail_requested or _mono() >= self.next_sync_due:
            await self._tail()
        due = self._reconcile_due_at()
        if due is not None and _mono() >= due:
            await self._reconcile()

    def _reconcile_due_at(self) -> float | None:
        """대조할 시각. 준비 전이거나 동기화가 실패 중이면 None — 장애 중에는 세어 봐야 소용없고(꼬리 백오프가
        먼저), 동기화가 돌아오면 밀린 대조가 곧바로 돈다. _step(할 일)과 _sleep(깰 시각)이 **이 한 함수**를 쓴다 —
        둘이 어긋나면 루프가 할 일 없이 깨어 헛돈다(reference_snapshot 에서 재현된 모양)."""
        if not self.ready or self.failures > 0:
            return None
        return self.next_reconcile_due

    async def _sleep(self) -> None:
        wake = self._wake
        if wake is not None:
            # 깨울 이유(_tail_requested·next_due)는 전부 상태에 남아 있어 여기서 지워도 잃는 신호가 없다.
            wake.clear()
        now = _mono()
        deadlines = [self.next_sync_due]
        reconcile_due = self._reconcile_due_at()
        if reconcile_due is not None:
            deadlines.append(reconcile_due)
        if self.ready and self._tail_requested:
            deadlines.append(now)
        timeout = max(min(deadlines) - now, MIN_LOOP_SLEEP_S)
        if wake is None:
            await asyncio.sleep(timeout)
            return
        try:
            await asyncio.wait_for(wake.wait(), timeout)
        except asyncio.TimeoutError:
            pass

    def _wake_up(self) -> None:
        loop, event = self._loop, self._wake
        if loop is None or event is None or loop.is_closed():
            return
        try:
            try:
                running = asyncio.get_running_loop()
            except RuntimeError:
                running = None
            if running is loop:
                event.set()
            else:
                loop.call_soon_threadsafe(event.set)
        except RuntimeError:
            pass

    # ── 부기(루프에서만) ─────────────────────────────────────────────────────
    def _synced(self, started_wall: datetime) -> None:
        now = _mono()
        first = not self.ready
        self.ready = self.snapshot is not None
        self.last_ok_sync = now
        self.last_ok_sync_wall = started_wall
        self.failures = 0
        self.next_sync_due = now + TAIL_INTERVAL_S
        if first and self.ready:
            self.next_reconcile_due = now + RECONCILE_INTERVAL_S

    def _fail(self, phase: str, exc: BaseException, *, track: str) -> None:
        """실패 한 번 = 경고 한 줄(백오프가 빈도를 묶는다). track: 'sync'(전량·꼬리) | 'reconcile'."""
        now = _mono()
        self.last_error_type = type(exc).__name__[:64]
        if track == "reconcile":
            self.reconcile_failures += 1
            failures = self.reconcile_failures
            cap = BACKOFF_MAX_S
        else:
            self.failures += 1
            failures = self.failures
            cap = BACKOFF_MAX_S if self.ready else BACKOFF_MAX_BEFORE_READY_S
            # 실패한 동기화가 도는 동안 들어온 kick 은 버린다 — 남겨 두면 곧바로 다시 읽어 백오프를 건너뛴다(kick 은
            # 실패 백오프 중인 다음 시각을 앞당기지 않는다, 스펙 §3.3). 백오프 뒤의 꼬리가 그 행까지 읽는다.
            self._tail_requested = False
        retry_in = min(cap, BACKOFF_INITIAL_S * BACKOFF_FACTOR ** min(failures - 1, 16))
        if track == "reconcile":
            self.next_reconcile_due = now + retry_in
        else:
            self.next_sync_due = now + retry_in
        logger.warning(
            "parking_history_sync_failed",
            phase=phase, error_type=type(exc).__name__, error=str(exc)[:300],
            failures=failures, retry_in_s=retry_in, ready=self.ready,
        )

    # ── 단계(루프 쪽) ────────────────────────────────────────────────────────
    async def _full(self, reason: str) -> bool:
        now = _utcnow()
        try:
            summary = await self._in_thread(self._full_load, now)
        except Exception as exc:  # noqa: BLE001
            self._fail("boot" if not self.ready else "full", exc,
                       track="reconcile" if reason == "reconcile" else "sync")
            return False
        self._synced(now)
        if reason == "reconcile":
            self.reconcile_failures = 0
        logger.info(
            "parking_history_loaded",
            reason=reason, rows=summary["rows"], lots=summary["lots"], generation=summary["generation"],
            since=summary["since"], pages=summary["pages"], page_retries=summary["page_retries"],
            elapsed_ms=summary["elapsed_ms"], digest=summary.get("digest"),
        )
        return True

    async def _tail(self) -> bool:
        kicked, self._tail_requested = self._tail_requested, False
        now = _utcnow()
        last = self.last_ok_sync_wall
        window = TAIL_WINDOW if last is None else max(TAIL_WINDOW, now - last + TAIL_GAP_MARGIN)
        if window > TAIL_FULL_RELOAD_AFTER:
            return await self._full("tail_gap")
        try:
            summary = await self._in_thread(self._tail_sync, now, window)
        except Exception as exc:  # noqa: BLE001
            self._fail("tail", exc, track="sync")
            return False
        self._synced(now)
        if summary["changed"]:
            logger.info(
                "parking_history_synced",
                kind="kick" if kicked else "tail", added=summary["added"], replaced=summary["replaced"],
                trimmed=summary["trimmed"], rows=summary["rows"], generation=summary["generation"],
                last_bucket_at=summary["last_bucket_at"],
            )
        await self._run_shadow_probe()
        return True

    async def _reconcile(self) -> None:
        self.next_reconcile_due = _mono() + RECONCILE_INTERVAL_S
        try:
            match, _ = await self._in_thread(self._count_matches, _utcnow())
        except Exception as exc:  # noqa: BLE001
            self._fail("reconcile", exc, track="reconcile")
            return
        if match:
            self.reconcile_failures = 0
            return
        # 한 번 어긋남 — 대개 마지막 꼬리 뒤에 들어온 수집이다. 꼬리를 한 번 읽고 다시 센다.
        if not await self._tail():
            self.next_reconcile_due = _mono()  # 꼬리가 되살아나면(실패 0) 곧바로 다시 대조한다
            return
        try:
            match, info = await self._in_thread(self._count_matches, _utcnow())
        except Exception as exc:  # noqa: BLE001
            self._fail("reconcile", exc, track="reconcile")
            return
        if match:
            self.reconcile_failures = 0
            return
        logger.warning("parking_history_reconcile_mismatch", **info)
        await self._full("reconcile")

    async def _run_shadow_probe(self) -> None:
        """shadow 모드: 꼬리가 성공할 때마다 자기 탐침 한 번(적재 스레드에서) — 단 앞 탐침에서 290초 안이거나 최근 24시간에
        이미 288회면 건너뛴다. 탐침의 실패는 적재 상태와 무관하다."""
        probe = _shadow_probe
        if probe is None or mode() != "shadow":
            return
        now = _mono()
        times = self._probe_times
        while times and now - times[0] >= _DAY_S:
            times.popleft()
        if len(times) >= SHADOW_PROBES_PER_DAY or (times and now - times[-1] < SHADOW_PROBE_MIN_INTERVAL_S):
            return
        times.append(now)
        try:
            executor = self._executor
            if executor is None:
                raise RuntimeError("parking history loader is not running")
            # run_in_executor 와 같지만 스레드 쪽 Future 를 남긴다: 루프 태스크가 취소돼도 탐침은 스레드에서 끝까지 돌므로,
            # stop 이 그 끝을 (짧게) 기다린 뒤 final 요약을 남길 수 있게.
            self._probe_future = executor.submit(self._call_probe, probe)
            await asyncio.wrap_future(self._probe_future)
        except Exception as exc:  # noqa: BLE001
            logger.warning("parking_history_shadow_probe_failed", error_type=type(exc).__name__)

    # ── 단계(적재 스레드 쪽) ─────────────────────────────────────────────────
    def _read_since(self, since: datetime) -> tuple[list[_Row], dict[str, int]]:
        """observed_at >= since 인 행 전부를 쪽 단위로 읽고 곧바로 파싱한다. 끝낸 쪽과 커서는 시도 끝까지 들고 있어
        실패한 쪽만 다시 읽는다."""
        client = supabase_admin
        aware = _aware_parser()
        since_iso = _iso(since)
        rows: list[_Row] = []
        stats = {"pages": 0, "page_retries": 0}
        counts: dict[str, int] = {}
        intern: dict[Any, Any] = {}  # 이 읽기 동안만 — 열·칸 객체를 쪽 사이에서도 함께 쓴다
        after: str | None = None
        after_us: int | None = None
        while True:
            data, retries = _fetch_page(client, since_iso, after)
            stats["pages"] += 1
            stats["page_retries"] += retries
            rows.extend(parse_page(data, aware=aware, counts=counts, intern=intern))
            if len(data) < PAGE_SIZE:
                break
            cursor = _bucket_us_of(data[-1], aware)
            if after_us is not None and cursor <= after_us:
                raise RuntimeError(f"{_TABLE}: keyset pagination did not advance")
            after_us, after = cursor, _iso(from_us(cursor))
        stats.update(counts)
        return rows, stats

    def _apply(self, rows: list[_Row], *, full: bool, now: datetime) -> dict[str, Any]:
        """유일한 변경 지점(적재 스레드). **실행 시점의** 스냅샷에 병합하고, 바뀌었으면 돌아가기 전에 참조를 바꿔 끼운다."""
        prev = self.snapshot
        if not full and prev is None:
            raise RuntimeError("parking history: tail merge before the first full load")
        new = merge(None if full else prev, rows, now=now)
        summary: dict[str, Any] = {
            "changed": False,
            "rows": len(prev.observed) if prev is not None else 0,
            "lots": len(prev.columns) if prev is not None else 0,
            "generation": prev.generation if prev is not None else None,
        }
        if new is None:
            return summary
        if prev is not None and new.generation <= prev.generation:
            logger.error(
                "parking_history_generation_regressed",
                error_type="AssertionError", error=f"generation {new.generation} <= {prev.generation}",
            )
            return summary
        self.snapshot = new  # 속성 하나 바꾸기 — 읽는 쪽은 옛 참조 또는 새 참조 하나를 통째로 본다
        summary.update(
            changed=True,
            rows=len(new.observed),
            lots=len(new.columns),
            generation=new.generation,
            digest=new.digest,
            last_bucket_at=from_us(max(new.bucket_us)).isoformat() if len(new.bucket_us) else None,
            **_change_counts(prev, new, rows),
        )
        return summary

    def _full_load(self, now: datetime) -> dict[str, Any]:
        started = time.perf_counter()
        since = now - LOOKBACK - WINDOW_MARGIN  # merge 의 잘라내기 경계와 같은 now → floor_us == since
        rows, stats = self._read_since(since)
        summary = self._apply(rows, full=True, now=now)
        summary.update(stats, since=_iso(since), elapsed_ms=round((time.perf_counter() - started) * 1000))
        return summary

    def _tail_sync(self, now: datetime, window: timedelta) -> dict[str, Any]:
        rows, stats = self._read_since(now - window)
        summary = self._apply(rows, full=False, now=now)
        summary.setdefault("added", 0)
        summary.setdefault("replaced", 0)
        summary.setdefault("trimmed", 0)
        summary.setdefault("last_bucket_at", None)
        summary.update(stats)
        return summary

    def _count_matches(self, now: datetime) -> tuple[bool, dict[str, Any]]:
        """DB 와 스냅샷의 (창 안 행 수, 최신 bucket_at) 이 같은가."""
        snapshot = self.snapshot
        if snapshot is None:
            raise RuntimeError("parking history: reconcile before the first full load")
        since = now - LOOKBACK
        response = _count_query(supabase_admin, _iso(since)).execute()
        db_count = getattr(response, "count", None)
        if not isinstance(db_count, int):
            raise RuntimeError(f"{_TABLE}: exact count unavailable")
        data = list(getattr(response, "data", None) or [])
        db_last = _bucket_us_of(data[0], _aware_parser()) if data else None
        start = window_start(snapshot, since)
        local_count = len(snapshot.observed_us) - start
        local_last = max(snapshot.bucket_us[start:]) if local_count else None
        info = {
            "db_count": db_count,
            "local_count": local_count,
            "db_last": from_us(db_last).isoformat() if db_last is not None else None,
            "local_last": from_us(local_last).isoformat() if local_last is not None else None,
        }
        return db_count == local_count and db_last == local_last, info

    def _call_probe(self, probe: Callable[[HistorySnapshot], None]) -> None:
        snapshot = self.snapshot  # 병합도 이 스레드에서만 일어난다 — 탐침이 도는 동안 이 스냅샷이 곧 저장소다
        if snapshot is not None:
            probe(snapshot)

    # ── 외부 신호 · 읽기 ─────────────────────────────────────────────────────
    def kick_tail(self) -> None:
        if not self._started or not self.ready or self.failures > 0:
            return  # 준비 전·실패 백오프 중에는 앞당기지 않는다(장애 중 수집마다 두드리지 않게)
        now = _mono()
        if now - self._last_kick < KICK_TAIL_MIN_INTERVAL_S:
            return
        self._last_kick = now
        self._tail_requested = True
        self._wake_up()

    def servable(self, since: datetime) -> tuple[HistorySnapshot | None, str]:
        snapshot = self.snapshot
        if snapshot is None or not self.ready:
            return None, "not_ready"
        ok_at = self.last_ok_sync
        if ok_at is None or _mono() - ok_at > SERVABLE_MAX_SYNC_AGE_S:
            return None, "stale"
        if to_us(since) < snapshot.floor_us:
            return None, "coverage"
        if len(snapshot.columns) > MAX_COLUMNS:
            return None, "columns"
        return snapshot, ""

    def health(self) -> dict[str, Any]:
        current_mode = mode()
        if current_mode == "rpc":
            return {"mode": "rpc"}
        snapshot, ok_at = self.snapshot, self.last_ok_sync
        body: dict[str, Any] = {
            "mode": current_mode,
            "ready": bool(self.ready and snapshot is not None),
            "rows": len(snapshot.observed) if snapshot is not None else 0,
            "lots": len(snapshot.columns) if snapshot is not None else 0,  # 열 수(주차장 × 좌표)
            "generation": snapshot.generation if snapshot is not None else None,
            "last_sync_age_s": None if ok_at is None else int(max(0.0, _mono() - ok_at)),
            "failures": int(self.failures),
            "last_error_type": self.last_error_type,
        }
        extra = _health_extra
        if extra is not None:
            try:
                values = extra()
                body.update({key: values[key] for key in _HEALTH_EXTRA_KEYS if key in values})
            except Exception:  # noqa: BLE001 — 전망 서비스 숫자를 못 읽으면 그 칸만 뺀다
                pass
        return body


_loader = _Loader()


# =============================================================================
# 공개 API
# =============================================================================


def start() -> None:
    """lifespan 에서 warmup_done 뒤에 부른다. rpc 모드면 아무것도 하지 않는다. 기다리지 않는다."""
    _loader.start()


async def stop() -> None:
    await _loader.stop()
    if mode() == "shadow":
        await _drain_shadow(SHADOW_DRAIN_TIMEOUT_S)
    flush = _shadow_flush
    if flush is not None:
        try:
            flush()  # shadow 숫자의 마지막 요약 한 줄 — 재시작 전 누적을 로그에 남긴다(다른 모드는 아무것도 안 한다)
        except Exception as exc:  # noqa: BLE001 — 종료를 막지 않는다
            logger.warning("parking_history_shadow_flush_failed", error_type=type(exc).__name__)


async def _drain_shadow(timeout: float) -> None:
    """(stop, shadow 모드) 아직 도는 자기 탐침과 요청 비교를 합쳐 최대 timeout 초 기다린다 — 그 숫자가 final 요약에 들어가게.
    다 못 끝나면 남은 수를 한 줄 남기고 넘어간다(종료를 막거나 던지지 않는다)."""
    try:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        pending = 0
        probe = _loader._probe_future
        if probe is not None and not probe.done():
            waiter = asyncio.wrap_future(probe)
            _, left = await asyncio.wait([waiter], timeout=timeout)
            pending += len(left)
            if waiter.done() and not waiter.cancelled():
                waiter.exception()  # 탐침의 실패는 이미 탐침 쪽에서 셌다 — 여기서는 '가져가지 않은 예외' 경고만 막는다
        drain = _shadow_drain
        if drain is not None:
            pending += await drain(max(0.0, deadline - loop.time()))
        if pending:
            logger.warning("parking_history_shadow_drain_timeout", pending=pending, timeout_s=timeout)
    except Exception as exc:  # noqa: BLE001 — 종료를 막지 않는다
        logger.warning("parking_history_shadow_drain_failed", error_type=type(exc).__name__)


def current() -> HistorySnapshot | None:
    """지금의 스냅샷(불변 — 읽기만 할 것). 준비 전이면 None."""
    return _loader.snapshot


def servable(since: datetime) -> tuple[HistorySnapshot | None, str]:
    """행렬로 답해도 되는가 — (스냅샷, "") 또는 (None, "not_ready" | "stale" | "coverage" | "columns").

    **순수 읽기**: 어느 스레드에서 불러도 되고, 적재를 깨우거나 태스크를 만들지 않는다. since = 요청의 now − 56일.
    """
    return _loader.servable(since)


def ensure_running() -> None:
    """이벤트 루프에서만 부른다(스레드로 넘어가기 전). 죽은 루프 태스크를 다시 띄운다."""
    _loader.ensure_running()


def kick_tail() -> None:
    """수집이 새 행을 저장한 직후(이벤트 루프) 부른다 — 꼬리 동기화를 곧바로 한 번. 절대 던지거나 막지 않는다.

    시작 전·준비 전·실패 백오프 중·20초 안에 이미 깨웠으면 아무것도 하지 않는다.
    """
    try:
        _loader.kick_tail()
    except Exception as exc:  # noqa: BLE001 — 수집 응답이 이 알림 때문에 실패하면 안 된다
        logger.warning("parking_history_kick_failed", error_type=type(exc).__name__)


def register_health_extra(fn: Callable[[], Mapping[str, Any]]) -> None:
    """전망 서비스가 /health 에 더할 숫자(memo · fallback_served · shadow)를 돌려주는 함수를 알린다."""
    global _health_extra
    _health_extra = fn


def register_shadow_probe(fn: Callable[[HistorySnapshot], None]) -> None:
    """shadow 자기 탐침. 꼬리 동기화가 성공할 때마다 적재 스레드에서 그 시점의 스냅샷으로 한 번 부른다."""
    global _shadow_probe
    _shadow_probe = fn


def register_shadow_flush(fn: Callable[[], None]) -> None:
    """종료(stop) 때 한 번 부를 shadow 요약 기록 — 재시작 전 누적 숫자가 10분 창을 기다리다 사라지지 않게."""
    global _shadow_flush
    _shadow_flush = fn


def register_shadow_drain(fn: Callable[[float], Awaitable[int]]) -> None:
    """종료(stop) 때 final 요약 전에 부를 기다림 — 인자는 남은 초, 돌려주는 값은 그 안에 못 끝난 요청 비교 수."""
    global _shadow_drain
    _shadow_drain = fn


def health() -> dict[str, Any]:
    """/health 의 parking_history 칸 — 메모리만 읽고 절대 던지지 않는다. 정수·참거짓·모드·예외 **종류 이름**만
    (오류 원문·좌표·digest·시각은 싣지 않는다 — 공개 엔드포인트)."""
    try:
        return _loader.health()
    except Exception:  # noqa: BLE001
        return {"mode": mode()}


def reset_for_tests() -> None:
    """적재 상태 초기화(시험 격리). 등록된 콜백(전망 서비스가 import 때 한 번 건다)은 건드리지 않는다."""
    executor, task = _loader._executor, _loader._task
    if executor is not None:
        executor.shutdown(wait=False, cancel_futures=True)
    if task is not None and not task.done():
        try:
            task.cancel()
        except RuntimeError:  # 이미 닫힌 이벤트 루프
            pass
    _loader.__init__()
