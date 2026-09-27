"""참조 스냅샷 — 지도(GET /api/v1/infrastructures)가 읽는 시설·혼잡·영업 근거의 단일 소유자(P1).

무엇이 문제였나
  /infrastructures 는 요청마다 시설 2페이지 · 출처 표 · 최신 혼잡 RPC · 영업 근거 12조각을 서울 Supabase 에서
  다시 읽고 1,682개 pydantic 모델을 만들었다. 오리건 → 서울 왕복이 4단계 직렬이라 TTFB 2.7~4.2초(실측),
  요청당 스레드 16회 · 순간 힙 17~25MB. 웹은 4초 안에 못 받으면 결함 있는 Supabase 직접 읽기로 돈다.

무엇을 하나(프레임워크가 아니다 — 원본 두 개와 갱신 루프 하나)
  · FacilityBase — 활성 시설 행(출처 표기 부착)의 불변 스냅샷 + 행마다 미리 직렬화한 지도 JSON 조각.
  · LiveOverlay  — 시설별 최신 혼잡 로그(RPC 원본 행)와 유효 영업 근거(원본 행). 시각에 따라 뒤집히는 값
    (is_current 30분 · is_stale 24시간 · 영업 근거 expires_at)은 **원본 행으로 들고** 요청 시각에 판정한다.
  · 갱신 루프 하나(lifespan 에서 시작) — 베이스는 60초마다 싼 변경 탐침(count + 최신 updated_at)을 보고 바뀌었거나
    30분이 지났으면 전량 재적재, 오버레이는 60초마다. 전용 스레드 1개에서 읽고(단일 비행), 참조 하나를 바꿔
    끼우며(원자적), 실패하면 마지막 정상본을 그대로 쓴다.
  · 지도 바이트 — (베이스 판, 오버레이 판, 유효 구간, 필터) 마다 한 번만 조립한다. ETag 는 본문 해시.

안전장치(레드팀 B1·B2)
  · 유효 구간(B1): 조립한 바이트에는 valid_until = 어떤 시설의 is_current/is_stale/영업 근거가 처음 뒤집히는
    시각이 붙는다. 요청이 그 시각을 넘겼으면 **메모리의 원본 행으로** 뒤집힌 시설만 다시 계산하고 새로
    조립한 뒤 낸다(I/O 없음 · 이벤트 루프에서 동기 실행 — await 가 없으니 그 자체로 단일 비행). 유효 구간을
    넘긴 바이트는 내보내지 않는다. 갱신 루프가 느리거나 멈춰도 이 판정은 멈추지 않는다.
  · 부팅(B2): 한 번도 못 만들었으면 map_payload() 는 None — 라우터는 **오늘의 실시간 경로**로 답한다
    (스냅샷이 503 을 새로 만들지 않는다). 만들 때까지 재시도 간격은 15초 상한이고, 요청이 즉시 시도를
    한 번 깨울 수 있다(5초에 한 번).
  · 정상본이 오래되면(오버레이 10분 · 베이스 3시간 · 베이스 재적재가 실패 중인데 반영 못 한 시설 쓰기가 있거나
    10분 넘게 확인 못 함) 라우터는 실시간 경로를 먼저 시도하고 그게 실패할 때만 이 바이트를 낸다 — 어느 장애
    모양에서도 도입 전보다 나빠지지 않게. 출처 표만 못 읽으면 출처 표기는 정상본으로 채우고 시설 행은 반영한다.
  · 건전성 관문: 활성 시설 수가 정상본보다 20% 넘게 줄어든 베이스는 연속 두 번 같은 수가 나올 때까지 바꿔
    끼우지 않는다. 0곳짜리 베이스는 정상본이 있으면 받지 않는다(RLS·스키마 캐시 흔들림을 사실로 믿지 않는다).
  · 쓰기 직후: 프로세스 안의 쓰기(제보·관리자 혼잡 설정·좌석 방송·시설 CRUD…)는 mark_dirty() 로 알린다 →
    1초 디바운스 뒤 해당 부분을 다시 읽는다(쓰기발 재적재는 탐침 없이). 그 사이 들어온 지도 요청은 최대
    2.5초까지 그 갱신을 기다린다 — 도입 전의 '다음 지도 요청에 곧바로 반영' 을 지킨다. 쓰기발 베이스 재적재
    끼리는 3초 간격을 둔다(연타가 연속 전량 재적재가 되지 않게).

일부러 하지 않은 것(다음 단계)
  · 추천·코스·예측·추정기 소비자 이전(P3), facility_cache.py · memory_guard 삭제(P3/P6). 원본 행은 P3 소비자가
    옮겨 올 때 붙인다(지금은 들고 있지 않는다 — 약 4MB).
  · /congestion/estimates 는 이 스냅샷에서 파생되지 않는다(주차 스냅샷·관광 통계·보정 곡선은 추정기 자체 캐시가
    소유 — P2 에서 옮긴다). 그래서 그대로 둔다.
  · 다중 워커 일관성 — 이 앱은 uvicorn 워커 1개가 전제다. 프로세스 밖 쓰기(일배치·SQL 편집기)는 60초 탐침과
    30분 전량 재적재가 잡는다.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import queue
import threading
import time
from collections import OrderedDict
from concurrent.futures import Executor, Future
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from types import MappingProxyType
from typing import Any, Mapping, NamedTuple

import structlog
from postgrest.types import CountMethod

from app.core.config import settings
from app.core.supabase import fetch_all_rows, supabase_admin, supabase_client
from app.services.availability_service import is_effective_availability_evidence
from app.services.congestion_evidence import RANKING_FRESHNESS, TRUSTED_EVIDENCE_TIERS

logger = structlog.get_logger()

# ── 갱신 주기 ─────────────────────────────────────────────────────────────────
BASE_PROBE_INTERVAL_S = 60.0        # 베이스 변경 탐침(count + 최신 updated_at, 행 2개)
BASE_BACKSTOP_S = 30 * 60.0         # 탐침이 못 보는 변경(트랜잭션 시작 시각 updated_at 등)을 위한 전량 재적재
OVERLAY_INTERVAL_S = 60.0           # 최신 혼잡 RPC + 영업 근거
DEBOUNCE_S = 1.0                    # mark_dirty 묶음(연속 쓰기를 한 번의 재적재로)
SANITY_RETRY_S = 30.0               # 건전성 관문에 걸린 뒤 재확인 간격
BACKOFF_INITIAL_S = 5.0
BACKOFF_MAX_S = 300.0               # 정상본이 있을 때
BACKOFF_MAX_BEFORE_READY_S = 15.0   # 한 번도 못 만들었을 때(B2) — Supabase 가 돌아오면 15초 안에 따라잡는다
KICK_MIN_INTERVAL_S = 5.0           # 준비 전 요청이 즉시 시도를 깨우는 최소 간격
LOOP_ERROR_PAUSE_S = 5.0
MIN_LOOP_SLEEP_S = 0.05             # 갱신 루프가 한 바퀴마다 최소한 쉬는 시간 — 상태 판정이 어긋나도 헛돌지 않게
BASE_WRITE_RELOAD_MIN_GAP_S = 3.0   # 쓰기발 베이스 재적재 사이 최소 간격(좌석 방송 연타가 연속 전량 재적재가 되지 않게)

# ── 신선도·쓰기 직후 ──────────────────────────────────────────────────────────
OVERLAY_STALE_AFTER_S = 10 * 60.0   # 넘으면 라우터가 실시간 경로를 먼저 시도한다
BASE_STALE_AFTER_S = 3 * 60 * 60.0
BASE_FAILING_STALE_AFTER_S = 10 * 60.0  # 베이스 재적재가 실패 중이고 이만큼 확인 못 했으면 실시간을 먼저 시도한다
# 쓰기 직후 지도 요청이 그 갱신을 기다리는 상한. 웹의 4초 경주는 **응답 헤더까지**만 잰다(api-client 가 fetch 가
# 풀리면 타이머를 끈다) — 2.5초 대기 + 오리건 왕복·조립으로 여유가 남는다. 2초는 오리건→서울 호출 5회짜리
# 재적재(호출당 0.4초 이상)를 못 기다렸다(리뷰 재현). 탐침 생략·RPC 1000개 조각으로 호출 수도 줄였다.
DIRTY_WAIT_S = 2.5
DIRTY_WAIT_WINDOW_S = 15.0          # 이보다 오래된 미반영 쓰기는 기다리지 않는다(갱신이 막힌 것)
SANITY_DROP_RATIO = 0.20

# ── 적재 ──────────────────────────────────────────────────────────────────────
PAGE_SIZE = 1000                    # PostgREST 단일 응답 상한과 같다
# RPC 결과도 1000행 상한이지만 결과는 시설당 최대 1행이다 — id 1000개씩이면 상한 안에서 전부 온다.
# (500개씩이면 1,682곳에 직렬 4회, 1000개씩이면 2회.) 실시간 경로(fetch_latest_congestion_for_all)도 이 크기를 쓴다.
RPC_CHUNK = 1000
MAP_LRU_SIZE = 2                    # REGION 외 필터 조합(제3자·구 번들) — 본문 하나가 최대 2MB 대라 적게 둔다

# 지도가 쓰는 열만 읽는다(select * 는 created_at·coupon_rate 등 지도에 없는 열까지 매분 끌어온다).
# InfrastructureItem 이 읽는 열 + 출처 추정용 updated_at. 라우터의 _infrastructure_item 과 짝이다.
BASE_COLUMNS = (
    "id,name,type,latitude,longitude,capacity,operating_hours,features,image_url,contentid,"
    "contenttypeid,gallery_images,address,phone,homepage,overview,barrier_free,is_active,updated_at"
)
_REF_COLUMNS = "id,facility_id,source,source_updated_at,updated_at"   # updated_at: 변경 탐침 서명용
_AVAILABILITY_COLUMNS = "id,facility_id,status,evidence_tier,corroborating_count,reported_at,expires_at"
_LATEST_CONGESTION_RPC = "latest_congestion_for_facilities"

_ONE_MICROSECOND = timedelta(microseconds=1)

# mark_dirty 종류 → 다시 읽을 부분. timesales 는 아직 이 스냅샷에 없다(P3 에서 추천이 옮겨 올 때 붙는다) —
# 호출부는 지금부터 알려 두고, 여기서는 아무것도 하지 않는다.
_KIND_PARTS: dict[str, tuple[str, ...]] = {
    "facilities": ("base",),
    "congestion": ("overlay",),
    "availability": ("overlay",),
    "timesales": (),
}
_PARTS = ("base", "overlay")


def _utcnow() -> datetime:
    """판정 시각. 테스트가 바꿔 끼운다."""
    return datetime.now(timezone.utc)


def _serve_mode() -> str:
    """REFERENCE_SNAPSHOT_SERVE 의 실효 모드. **정확히 'snapshot' 일 때만** 스냅샷, 그 밖의 값은 전부 legacy.

    되돌림 스위치는 장애 중에 손으로 친다 — 'off'·'false'·'0'·오타가 스냅샷을 켠 채로 두면 Render 재시작을
    한 번 더 치러야 한다. 모르는 값은 도입 전 경로(안전한 쪽)로 떨어진다.
    """
    raw = getattr(settings, "REFERENCE_SNAPSHOT_SERVE", "snapshot")
    return "snapshot" if str(raw).strip().lower() == "snapshot" else "legacy"


def _serving() -> bool:
    """legacy 면 갱신 루프도 돌리지 않는다(메모리·DB 부하까지 원래대로)."""
    return _serve_mode() == "snapshot"


def _infra():
    # 지연 import — 라우터가 이 모듈을 import 한다(최상단에서 부르면 순환). 응답 모델·행 조립 함수를
    # 라우터 한 곳에 두어야 실시간 경로와 스냅샷의 JSON 이 갈라지지 않는다.
    from app.routers import infrastructures

    return infrastructures


# =============================================================================
# 데이터
# =============================================================================


class MapKey(NamedTuple):
    """/infrastructures 의 필터 5종(정규화). type 빈 문자열은 필터 없음 — 실시간 경로의 `if type:` 과 같다."""

    type: str | None
    min_lat: float | None
    max_lat: float | None
    min_lng: float | None
    max_lng: float | None

    @classmethod
    def of(cls, type=None, min_lat=None, max_lat=None, min_lng=None, max_lng=None) -> "MapKey":
        return cls(type or None, min_lat, max_lat, min_lng, max_lng)


NO_FILTER = MapKey(None, None, None, None, None)
# 웹이 늘 보내는 범위(apps/web/lib/region.ts REGION.bounds) — 메인 지도와 혼잡 알림 폴링이 둘 다 이 키다.
REGION_KEY = MapKey(None, 35.82, 35.85, 129.19, 129.24)


@dataclass(frozen=True, slots=True)
class _MapRow:
    """시설 1곳의 지도 JSON 을 시각과 무관한 세 조각으로 미리 직렬화한 것.

    완성된 항목 = head + <congestion JSON|null> + mid + <availability_evidence JSON|null> + tail.
    필드 순서는 InfrastructureItem 정의 순서 그대로다(실시간 경로와 바이트 모양까지 같게).
    """

    id: str
    type: str
    lat: float
    lng: float
    head: bytes
    mid: bytes
    tail: bytes


@dataclass(frozen=True)
class FacilityBase:
    version: str                    # 지도 조각 전체의 해시 — 내용이 같으면 판도 같다
    ids: tuple[str, ...]            # 활성 시설 id(id 순) — 오버레이가 이 id 로 최신 혼잡을 읽는다
    map_rows: tuple[_MapRow, ...]   # 검증을 통과한 행만(실패 행은 로그 후 제외)
    dropped: int
    loaded_at: float                # time.monotonic()
    # 시설별로 고른 출처 표(facility_id → (source, source_updated_at)). None = 출처 표를 한 번도 못 읽었다.
    # 출처 표만 읽기에 실패하면 이 정상본으로 출처 표기를 채우고 시설 행 변경은 그대로 반영한다.
    source_refs: Mapping[str, tuple] | None = None
    # 원본 행(약 4MB)은 들고 있지 않는다 — 지금 소비자는 지도 조각뿐이다(P3 소비자가 옮겨 올 때 붙인다).


@dataclass(frozen=True)
class _Fragments:
    cong: dict[str, bytes]
    avail: dict[str, bytes]
    flips: dict[str, datetime]      # 시설별 다음 판정 뒤집힘 시각(없으면 키 없음)


@dataclass(frozen=True)
class LiveOverlay:
    version: str
    congestion: Mapping[str, dict]                  # facility_id → RPC 원본 행
    availability: Mapping[str, tuple[dict, ...]]    # facility_id → 유효 후보 행(reported_at 내림차순)
    fragments: _Fragments                           # 적재 시각 기준으로 미리 계산한 조각
    loaded_at: float


@dataclass(frozen=True, slots=True)
class _Body:
    body: bytes
    etag: str


@dataclass(frozen=True, slots=True)
class MapPayload:
    body: bytes
    etag: str
    age_s: int      # 가장 오래 확인 못 한 부분의 나이(초) — X-Snapshot-Age
    stale: bool     # True 면 라우터가 실시간을 먼저 시도한다


# =============================================================================
# 조립(순수 함수 — 어느 스레드에서 불러도 된다)
# =============================================================================

_SEGMENTS: tuple[frozenset, frozenset, frozenset] | None = None


def _segments() -> tuple[frozenset, frozenset, frozenset]:
    """InfrastructureItem 필드를 congestion·availability_evidence 앞/사이/뒤 세 묶음으로."""
    global _SEGMENTS
    if _SEGMENTS is None:
        names = list(_infra().InfrastructureItem.model_fields)
        ci, ai = names.index("congestion"), names.index("availability_evidence")
        if not 0 < ci < ai:
            raise RuntimeError("InfrastructureItem field order changed — update reference_snapshot")
        _SEGMENTS = (frozenset(names[:ci]), frozenset(names[ci + 1:ai]), frozenset(names[ai + 1:]))
    return _SEGMENTS


def _dump_inner(item: Any, fields: frozenset) -> bytes:
    """모델의 일부 필드를 JSON 객체 **안쪽**(중괄호 없이)으로. FastAPI 응답과 같은 pydantic 직렬화기다."""
    if not fields:
        return b""
    raw = item.__pydantic_serializer__.to_json(item, include=set(fields), by_alias=True)
    return bytes(raw[1:-1])


def _map_row(row: dict) -> _MapRow:
    infra = _infra()
    item = infra._infrastructure_item(row, None, None)
    head_f, mid_f, tail_f = _segments()
    mid_inner = _dump_inner(item, mid_f)
    tail_inner = _dump_inner(item, tail_f)
    return _MapRow(
        id=str(item.id),
        type=item.type,
        lat=float(item.latitude),
        lng=float(item.longitude),
        head=b"{" + _dump_inner(item, head_f) + b',"congestion":',
        mid=(b"," + mid_inner if mid_inner else b"") + b',"availability_evidence":',
        tail=(b"," + tail_inner if tail_inner else b"") + b"}",
    )


def _build_base(
    rows: list[dict], loaded_at: float, source_refs: Mapping[str, tuple] | None = None
) -> FacilityBase:
    map_rows: list[_MapRow] = []
    dropped = 0
    for row in rows:
        try:
            map_rows.append(_map_row(row))
        except Exception as exc:  # noqa: BLE001 — 행 하나의 오염이 지도 전체를 죽이면 안 된다
            # 실시간 경로는 이런 행 하나로 요청 전체가 500 이었다(웹은 결함 있는 직접 읽기로 폴백).
            # 스냅샷은 그 행만 빼고 로그를 남긴다 — 나머지 1,600여 곳은 정상 표시된다.
            dropped += 1
            if dropped <= 20:
                logger.warning(
                    "reference_snapshot_row_invalid",
                    facility_id=str(row.get("id")), error=str(exc)[:300],
                )
    digest = hashlib.blake2b(digest_size=16)
    for r in map_rows:
        digest.update(r.head)
        digest.update(r.mid)
        digest.update(r.tail)
    return FacilityBase(
        version=digest.hexdigest(),
        ids=tuple(str(r["id"]) for r in rows if r.get("id")),
        map_rows=tuple(map_rows),
        dropped=dropped,
        loaded_at=loaded_at,
        source_refs=source_refs,
    )


def _parse_ts(value: object) -> datetime | None:
    """infrastructures._is_stale · congestion_evidence._parse_timestamp 와 같은 해석(naive 는 UTC)."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _congestion_flips(row: dict) -> list[datetime]:
    """이 로그의 판정이 뒤집힐 수 있는 시각들. 지나면 다시 판정한다(뒤집히지 않았어도 무해).

      · is_stale  : (now - ts) > 24h → ts + 24h + 1µs 부터 True
      · is_current: 신뢰등급이고 0 <= (now - ts) <= 30분 → ts 부터 True, ts + 30분 + 1µs 부터 False
    """
    ts = _parse_ts(row.get("timestamp"))
    if ts is None:
        return []
    stale_after = timedelta(hours=_infra()._STALE_AFTER_HOURS)
    flips = [ts + stale_after + _ONE_MICROSECOND]
    if row.get("evidence_tier") in TRUSTED_EVIDENCE_TIERS:
        flips += [ts, ts + RANKING_FRESHNESS + _ONE_MICROSECOND]
    return flips


def _facility_fragments(
    congestion_row: dict | None,
    availability_rows: tuple[dict, ...] | None,
    now: datetime,
) -> tuple[bytes | None, bytes | None, datetime | None]:
    """시설 1곳의 (congestion JSON, availability_evidence JSON, 다음 뒤집힘 시각) — ``now`` 기준."""
    infra = _infra()
    cong = avail = None
    flips: list[datetime] = []
    if congestion_row is not None:
        try:
            info = infra._congestion_info(congestion_row, now=now)
            cong = infra.CongestionInfo(**info).model_dump_json(by_alias=True).encode()
        except Exception as exc:  # noqa: BLE001 — 이 시설의 혼잡만 '없음' 으로(실시간 경로는 전체 500)
            logger.warning(
                "reference_snapshot_congestion_invalid",
                facility_id=str(congestion_row.get("facility_id")), error=str(exc)[:300],
            )
        flips += _congestion_flips(congestion_row)
    if availability_rows:
        # 실시간 경로(fetch_effective_availability_map)와 같은 선택: reported_at 최신순 첫 유효 행.
        # 유효성은 시간이 지나면 True → False 로만 바뀌므로, 선택이 바뀌는 순간은 고른 행의 만료뿐이다.
        selected = next(
            (r for r in availability_rows if is_effective_availability_evidence(r, at=now)), None
        )
        if selected is not None:
            try:
                avail = infra.AvailabilityEvidence.model_validate(selected).model_dump_json(
                    by_alias=True
                ).encode()
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "reference_snapshot_availability_invalid",
                    facility_id=str(selected.get("facility_id")), error=str(exc)[:300],
                )
            expires_at = _parse_ts(selected.get("expires_at"))
            if expires_at is not None:
                flips.append(expires_at)
    future = [t for t in flips if t > now]
    return cong, avail, (min(future) if future else None)


def _compute_fragments(
    congestion: Mapping[str, dict],
    availability: Mapping[str, tuple[dict, ...]],
    now: datetime,
) -> _Fragments:
    cong: dict[str, bytes] = {}
    avail: dict[str, bytes] = {}
    flips: dict[str, datetime] = {}
    for fid in set(congestion) | set(availability):
        c, a, f = _facility_fragments(congestion.get(fid), availability.get(fid), now)
        if c is not None:
            cong[fid] = c
        if a is not None:
            avail[fid] = a
        if f is not None:
            flips[fid] = f
    return _Fragments(cong, avail, flips)


def _overlay_version(congestion: Mapping[str, dict], availability: Mapping[str, tuple]) -> str:
    canonical = json.dumps(
        [sorted(congestion.items()), sorted(availability.items())],
        sort_keys=True, default=str, separators=(",", ":"),
    ).encode()
    return hashlib.blake2b(canonical, digest_size=16).hexdigest()


def _pg_ge(value: float, bound: float) -> bool:
    """Postgres 의 float8 비교(NaN 은 모든 수보다 크고 NaN 과 같다) — 실시간 경로의 gte 필터와 같게."""
    if math.isnan(value):
        return True
    if math.isnan(bound):
        return False
    return value >= bound


def _pg_le(value: float, bound: float) -> bool:
    if math.isnan(bound):
        return True
    if math.isnan(value):
        return False
    return value <= bound


def _matches(row: _MapRow, key: MapKey) -> bool:
    if key.type is not None and row.type != key.type:
        return False
    if key.min_lat is not None and not _pg_ge(row.lat, key.min_lat):
        return False
    if key.max_lat is not None and not _pg_le(row.lat, key.max_lat):
        return False
    if key.min_lng is not None and not _pg_ge(row.lng, key.min_lng):
        return False
    if key.max_lng is not None and not _pg_le(row.lng, key.max_lng):
        return False
    return True


def _etag(body: bytes) -> str:
    return '"' + hashlib.blake2b(body, digest_size=16).hexdigest() + '"'


class _MapView:
    """베이스 × 오버레이 한 조합의 지도 바이트.

    이벤트 루프에서만 만지고 메서드에 await 가 없다 — 그래서 동시 요청이 몰려도 뒤집힘 재계산·조립은 한 번만
    일어난다(단일 비행). 요청당 할당은 캐시 적중이면 0(시설 수에 비례하는 것이 없다).
    """

    def __init__(self, base: FacilityBase, overlay: LiveOverlay, now: datetime):
        self.base = base
        self.overlay = overlay
        fragments = overlay.fragments
        self.cong = dict(fragments.cong)
        self.avail = dict(fragments.avail)
        self.flips = dict(fragments.flips)
        self.epoch = 0
        self.valid_until: datetime | None = min(self.flips.values(), default=None)
        self._region: _Body | None = None
        self._lru: OrderedDict[MapKey, _Body] = OrderedDict()
        self.ensure_valid(now)

    def ensure_valid(self, now: datetime) -> bool:
        """유효 구간을 넘겼으면 뒤집힌 시설만 다시 계산하고 조립본을 버린다. 재계산했으면 True."""
        if self.valid_until is None or now < self.valid_until:
            return False
        due = [fid for fid, at in self.flips.items() if at <= now]
        for fid in due:
            c, a, f = _facility_fragments(
                self.overlay.congestion.get(fid), self.overlay.availability.get(fid), now
            )
            _put(self.cong, fid, c)
            _put(self.avail, fid, a)
            _put(self.flips, fid, f)
        self.epoch += 1
        self.valid_until = min(self.flips.values(), default=None)
        self._region = None
        self._lru.clear()
        return True

    def body_for(self, key: MapKey) -> _Body:
        if key == REGION_KEY:
            if self._region is None:
                self._region = self._compose(key)
            return self._region
        hit = self._lru.get(key)
        if hit is not None:
            self._lru.move_to_end(key)
            return hit
        body = self._compose(key)
        self._lru[key] = body
        while len(self._lru) > MAP_LRU_SIZE:
            self._lru.popitem(last=False)
        return body

    def _compose(self, key: MapKey) -> _Body:
        cong, avail = self.cong, self.avail
        parts: list[bytes] = [b"["]
        first = True
        for r in self.base.map_rows:
            if not _matches(r, key):
                continue
            if not first:
                parts.append(b",")
            first = False
            parts += (r.head, cong.get(r.id, b"null"), r.mid, avail.get(r.id, b"null"), r.tail)
        parts.append(b"]")
        body = b"".join(parts)
        return _Body(body=body, etag=_etag(body))


def _put(target: dict, key: str, value: Any) -> None:
    if value is None:
        target.pop(key, None)
    else:
        target[key] = value


# =============================================================================
# 적재(전용 스레드에서 돈다 — 동기 Supabase 호출)
# =============================================================================


def _keyset_rows(client, table: str, select: str, *, filters=None) -> list[dict]:
    """id 순 keyset 페이지네이션(order=id&id=gt.<마지막>&limit=1000).

    offset 페이지는 요청 사이에 행이 끼거나 빠지면 경계에서 한 행이 두 번 오거나 빠진다 — keyset 은
    동시 UPDATE·INSERT 에도 그런 일이 없다.
    """
    rows: list[dict] = []
    last: str | None = None
    while True:
        query = client.table(table).select(select)
        if filters is not None:
            query = filters(query)
        if last is not None:
            query = query.gt("id", last)
        data = list(query.order("id").limit(PAGE_SIZE).execute().data or [])
        rows.extend(data)
        if len(data) < PAGE_SIZE:
            return rows
        nxt = str(data[-1]["id"])
        if last is not None and nxt <= last:
            raise RuntimeError(f"{table}: keyset pagination did not advance")
        last = nxt


def _first_value(response, column: str):
    data = getattr(response, "data", None) or []
    return data[0].get(column) if data else None


def _probe() -> tuple:
    """베이스가 바뀌었는지 싸게 본다 — 활성 시설·출처 표의 (행 수, 최신 updated_at). 둘 다 트리거가 갱신한다.

    PostgREST 집계(max)는 Supabase 에서 기본으로 꺼져 있어 order=updated_at.desc&limit=1 로 읽는다.
    시설은 **활성 행만** 센다 — 지도가 읽는 집합과 같아야 전량 적재한 행에서 같은 서명(_data_signature)을
    만들 수 있다(비활성 행의 변경은 지도에 보이지 않는다). 놓치는 경우(긴 트랜잭션의 시작 시각 updated_at 등)는
    30분 전량 재적재가 잡는다.
    """
    signature: list = []
    for table, active_only in (("facilities", True), ("facility_source_refs", False)):
        query = supabase_client.table(table).select("updated_at", count=CountMethod.exact)
        if active_only:
            query = query.eq("is_active", True)
        res = query.order("updated_at", desc=True).limit(1).execute()
        signature += [getattr(res, "count", None), _first_value(res, "updated_at")]
    return tuple(signature)


def _latest_updated_at(rows: list[dict]) -> object:
    """행들 가운데 가장 늦은 updated_at 의 **원문**(탐침이 돌려주는 값과 같은 문자열)."""
    best_ts: datetime | None = None
    best_raw: object = None
    for row in rows:
        raw = row.get("updated_at")
        ts = _parse_ts(raw)
        if ts is not None and (best_ts is None or ts > best_ts):
            best_ts, best_raw = ts, raw
    return best_raw


def _data_signature(rows: list[dict], refs: list[dict]) -> tuple:
    """방금 전량 읽은 행으로 만든 탐침 서명(_probe 와 같은 모양).

    탐침 없이 읽은 적재(쓰기 알림·첫 적재·30분 전량)도 서명을 남겨야 다음 탐침이 같은 내용을 또 전량 읽지
    않는다. 읽은 **뒤에** 바뀐 행은 다음 탐침에서 행 수나 최신 updated_at 이 달라져 잡힌다. 두 서명이 표기
    차이로 어긋나도 대가는 전량 재적재 한 번이다(놓치는 쪽으로는 틀리지 않는다).
    """
    return (len(rows), _latest_updated_at(rows), len(refs), _latest_updated_at(refs))


def _load_base(
    prev_signature: tuple | None,
    force: bool,
    prev_refs: Mapping[str, tuple] | None = None,
) -> tuple[tuple | None, FacilityBase | None, BaseException | None, BaseException | None]:
    """(탐침 서명, 새 베이스 또는 None=다시 읽지 않음, 탐침 오류, 출처 표 오류).

    · force(첫 적재·쓰기 알림·30분 전량)면 탐침을 건너뛴다 — 쓰기 직후 재적재에서 서울 왕복 2회를 아낀다.
      서명은 읽은 행에서 만든다(_data_signature).
    · 탐침만 실패하면(권한·일시 오류) 전량 재적재를 **하지 않는다** — 매분 2MB 를 끌어오는 대신 30분 전량
      재적재(force)가 잡는다.
    · 출처 표만 못 읽으면 **정상본의 출처 표기**(prev_refs)로 채우고 시설 행은 새로 반영한다 — 실시간 경로도
      이 오류를 삼키고 답하므로, 여기서 베이스 전체를 실패로 올리면 좌석 방송·시설 수정이 최대 3시간
      멈춘다(리뷰 재현). 정상본이 없으면(첫 적재) 실시간 경로와 똑같이 출처 표기 없이 만든다. 서명은 None —
      출처 표가 돌아오면 다음 탐침이 전량 다시 읽는다.
    """
    signature: tuple | None = None
    if not force:
        try:
            signature = _probe()
        except Exception as exc:  # noqa: BLE001
            return prev_signature, None, exc, None
        if signature == prev_signature:
            return signature, None, None, None
    rows = _keyset_rows(
        supabase_client, "facilities", BASE_COLUMNS, filters=lambda q: q.eq("is_active", True)
    )
    refs_error: BaseException | None = None
    try:
        refs: list[dict] | None = _keyset_rows(supabase_client, "facility_source_refs", _REF_COLUMNS)
    except Exception as exc:  # noqa: BLE001
        refs, refs_error = None, exc
    if refs is not None:
        chosen = _infra().attach_place_data_source(rows, refs)
        if force:
            signature = _data_signature(rows, refs)
    else:
        signature = None
        chosen = None
        if prev_refs is not None:
            carried = [
                {"facility_id": fid, "source": source, "source_updated_at": updated}
                for fid, (source, updated) in prev_refs.items()
            ]
            chosen = _infra().attach_place_data_source(rows, carried)
    source_refs = None
    if chosen is not None:
        source_refs = MappingProxyType({
            fid: (ref.get("source"), ref.get("source_updated_at")) for fid, ref in chosen.items()
        })
    return signature, _build_base(rows, time.monotonic(), source_refs), None, refs_error


def _load_congestion(ids: tuple[str, ...]) -> Mapping[str, dict]:
    out: dict[str, dict] = {}
    for start in range(0, len(ids), RPC_CHUNK):
        chunk = list(ids[start:start + RPC_CHUNK])
        res = supabase_client.rpc(_LATEST_CONGESTION_RPC, {"facility_ids": chunk}).execute()
        for row in res.data or []:
            fid = row.get("facility_id")
            if fid is not None:
                out[str(fid)] = row
    return MappingProxyType(out)


def _load_availability(now: datetime) -> Mapping[str, tuple[dict, ...]]:
    """만료 전 corroborated 영업 근거 전부(표가 작다 — IN 목록 없이 한 조회). 시설별 reported_at 최신순."""
    rows = fetch_all_rows(
        supabase_admin,
        "facility_availability_reports",
        _AVAILABILITY_COLUMNS,
        apply_filters=lambda q: q.eq("evidence_tier", "corroborated")
        .gt("expires_at", now.isoformat())
        .order("reported_at", desc=True)
        .order("id"),
    )
    by_fid: dict[str, list[dict]] = {}
    for row in rows:
        fid = str(row.get("facility_id") or "")
        if fid:
            by_fid.setdefault(fid, []).append(row)
    return MappingProxyType({fid: tuple(v) for fid, v in by_fid.items()})


def _load_overlay(
    ids: tuple[str, ...], prev: LiveOverlay | None, now: datetime
) -> tuple[LiveOverlay | None, list[tuple[str, BaseException]]]:
    """(오버레이, 부분 실패 목록). 한 부분이 실패하면 그 부분만 정상본으로 채운다.

    최신 혼잡을 한 번도 못 읽었으면 None — 지도가 '혼잡 없음' 으로 준비된 척하지 않는다.
    영업 근거는 실시간 경로도 실패를 빈 값으로 삼키므로(availability_service) 같은 방향으로 둔다.
    """
    errors: list[tuple[str, BaseException]] = []
    try:
        congestion = _load_congestion(ids)
    except Exception as exc:  # noqa: BLE001
        errors.append(("congestion", exc))
        if prev is None:
            return None, errors
        congestion = prev.congestion
    try:
        availability = _load_availability(now)
    except Exception as exc:  # noqa: BLE001
        errors.append(("availability", exc))
        availability = prev.availability if prev is not None else MappingProxyType({})
    version = _overlay_version(congestion, availability)
    if prev is not None and version == prev.version:
        return prev, errors     # 내용이 같다 — 판을 올리지 않는다(조립본·ETag 유지)
    return (
        LiveOverlay(
            version=version,
            congestion=congestion,
            availability=availability,
            fragments=_compute_fragments(congestion, availability, now),
            loaded_at=time.monotonic(),
        ),
        errors,
    )


# =============================================================================
# 갱신 루프
# =============================================================================


class _DaemonExecutor(Executor):
    """적재 전용 **데몬** 스레드 1개짜리 실행기.

    concurrent.futures.ThreadPoolExecutor 의 워커는 비데몬이고 인터프리터가 끝날 때 join 된다 — Supabase 호출
    하나가 매달려 있으면(httpx 타임아웃 단계당 120초) lifespan 이 끝나도 프로세스가 그만큼 남는다(배포가 겹칠 때
    옛 인스턴스가 늦게 빠진다 — 리뷰 재현: stop() 0초, 프로세스 종료 8초). 적재는 읽기 전용이라 종료 때
    버려도 잃는 것이 없다. 작업은 넣은 순서대로 하나씩 돈다(단일 비행).
    """

    def __init__(self, name: str) -> None:
        self._queue: queue.SimpleQueue = queue.SimpleQueue()
        self._lock = threading.Lock()
        self._closed = False
        self._thread = threading.Thread(target=self._work, name=name, daemon=True)
        self._thread.start()

    def submit(self, fn, /, *args, **kwargs) -> Future:
        with self._lock:
            if self._closed:
                raise RuntimeError("cannot schedule new futures after shutdown")
            future: Future = Future()
            self._queue.put((future, fn, args, kwargs))
            return future

    def _work(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                return
            future, fn, args, kwargs = item
            if not future.set_running_or_notify_cancel():
                continue
            try:
                result = fn(*args, **kwargs)
            except BaseException as exc:  # noqa: BLE001 — 호출한 쪽(await)이 받는다
                future.set_exception(exc)
            else:
                future.set_result(result)

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        with self._lock:
            if not self._closed:
                self._closed = True
                if cancel_futures:
                    while True:
                        try:
                            item = self._queue.get_nowait()
                        except queue.Empty:
                            break
                        if item is not None:
                            item[0].cancel()
                self._queue.put(None)
        if wait and self._thread is not threading.current_thread():
            self._thread.join()


@dataclass
class _Part:
    ok_at: float | None = None          # 마지막으로 정상 확인한 시각(monotonic)
    next_due: float = 0.0
    failures: int = 0
    last_error: str | None = None
    hold_until: float = 0.0             # 건전성 관문에 걸려 재확인을 기다리는 중

    def blocked(self, now: float) -> bool:
        """실패 중이거나 관문에 걸려 있으면 쓰기 알림도 정해진 재시도 시각을 따른다(두드리지 않는다)."""
        return self.failures > 0 or now < self.hold_until


@dataclass
class _Refresher:
    base: FacilityBase | None = None
    overlay: LiveOverlay | None = None
    view: _MapView | None = None
    parts: dict[str, _Part] = field(default_factory=lambda: {p: _Part() for p in _PARTS})

    def __post_init__(self) -> None:
        self._lock = threading.Lock()
        self._dirty_seq = {p: 0 for p in _PARTS}
        self._applied_seq = {p: 0 for p in _PARTS}
        # 반영 안 된 알림 묶음의 첫 알림 시각(디바운스 기준)
        self._dirty_at: dict[str, float | None] = {p: None for p in _PARTS}
        # 적재가 seq 를 잡은 뒤 들어온 첫 알림 시각 — 그 적재가 끝나면 다음 묶음의 디바운스 기준이 된다
        self._marked_since_capture: dict[str, float | None] = {p: None for p in _PARTS}
        self._base_signature: tuple | None = None
        self._last_full_load: float | None = None
        self._write_reload_at: float | None = None      # 마지막 쓰기발 베이스 재적재가 끝난 시각
        self._refs_failures = 0                          # 출처 표만 연속으로 못 읽은 횟수(정상본으로 채우는 중)
        self._suspect_count: int | None = None
        self._urgent = {p: False for p in _PARTS}       # 지도 요청이 이 부분의 쓰기 반영을 기다리는 중
        self._last_kick = -math.inf
        self._loop: asyncio.AbstractEventLoop | None = None
        self._task: asyncio.Task | None = None
        self._wake: asyncio.Event | None = None
        self._changed: asyncio.Event | None = None
        self._busy: asyncio.Lock | None = None
        self._executor: _DaemonExecutor | None = None
        self._started = False

    # ── 수명 ────────────────────────────────────────────────────────────────
    def start(self) -> None:
        raw = getattr(settings, "REFERENCE_SNAPSHOT_SERVE", None)
        mode = _serve_mode()
        if mode != "snapshot":
            logger.info("reference_snapshot_disabled", serve=mode, configured=repr(raw)[:40])
            return
        if self._task is not None and not self._task.done():
            return
        self._loop = asyncio.get_running_loop()
        self._wake = asyncio.Event()
        self._changed = None
        self._busy = asyncio.Lock()
        now = time.monotonic()
        for part in self.parts.values():
            part.next_due = min(part.next_due, now)
        self._started = True
        self._task = self._loop.create_task(self._run(), name="reference-snapshot")
        logger.info("reference_snapshot_started", serve=mode, configured=repr(raw)[:40])

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

    def _ensure_running(self) -> None:
        """루프 태스크가 (버그로) 죽었으면 다시 띄운다 — 요청 경로의 감독자."""
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
        logger.error("reference_snapshot_refresher_restarted", error=repr(died)[:300])
        self._task = self._loop.create_task(self._run(), name="reference-snapshot")

    def _executor_or_new(self) -> _DaemonExecutor:
        if self._executor is None:
            # 전용 데몬 스레드 1개: 적재는 서로 겹치지 않고(단일 비행), 요청용 I/O 풀(16)을 잡아먹지 않으며,
            # 매달린 적재가 프로세스 종료를 붙잡지 않는다.
            self._executor = _DaemonExecutor("nextspot-ref")
        return self._executor

    async def _in_thread(self, fn, *args):
        return await asyncio.get_running_loop().run_in_executor(self._executor_or_new(), fn, *args)

    # ── 루프 ────────────────────────────────────────────────────────────────
    async def _run(self) -> None:
        while True:
            try:
                await self._step()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — 한 바퀴의 버그가 루프를 죽이지 않게(감독)
                logger.error(
                    "reference_snapshot_loop_error",
                    error_type=type(exc).__name__, error=str(exc)[:300],
                )
                await asyncio.sleep(LOOP_ERROR_PAUSE_S)

    async def _step(self) -> None:
        if self._due("base"):
            await self.refresh_base()
        if self._due("overlay"):
            await self.refresh_overlay()
        await self._sleep()

    def _pending(self, part: str) -> tuple[bool, float | None]:
        with self._lock:
            return self._dirty_seq[part] > self._applied_seq[part], self._dirty_at[part]

    def _capture(self, part: str) -> tuple[int, bool]:
        """적재 시작 — (지금까지의 알림 번호, 반영 안 된 알림이 있는지)를 한 번에 잡는다. 이 뒤의 알림은 다음 묶음이다."""
        with self._lock:
            self._marked_since_capture[part] = None
            seq = self._dirty_seq[part]
            return seq, seq > self._applied_seq[part]

    def _write_due_at(self, part: str, now: float, *, urgent: bool | None = None) -> float | None:
        """반영 안 된 쓰기가 이 부분을 다시 읽게 하는 시각. 없으면(알림 없음·실패 백오프·관문 대기) None.

        _due(할 일 판정)와 _sleep(깰 시각)이 **이 한 함수**를 쓴다 — 둘이 어긋나면 루프가 할 일 없이 깨어
        헛돈다(리뷰 재현: 베이스가 없을 때 혼잡 쓰기 한 번에 이벤트 루프가 CPU 100%).
        """
        if part == "overlay" and self.base is None:
            return None     # 오버레이는 베이스가 있어야 읽는다 — 베이스가 먼저다
        pending, at = self._pending(part)
        # 실패 중(또는 관문 대기)이면 쓰기 알림도 백오프를 따른다(장애 중 쓰기마다 재적재를 두드리지 않게).
        if not pending or self.parts[part].blocked(now):
            return None
        if urgent is None:
            urgent = self._urgent[part]
        due = now if (urgent or at is None) else at + DEBOUNCE_S
        if part == "base" and self._write_reload_at is not None:
            # 쓰기발 전량 재적재끼리는 최소 간격을 둔다 — 기다리는 요청이 있어도(연타 폭주의 상한).
            due = max(due, self._write_reload_at + BASE_WRITE_RELOAD_MIN_GAP_S)
        return due

    def _due(self, part: str) -> bool:
        if part == "overlay" and self.base is None:
            return False
        now = time.monotonic()
        if now >= self.parts[part].next_due:
            return True
        due = self._write_due_at(part, now)
        return due is not None and now >= due

    async def _sleep(self) -> None:
        now = time.monotonic()
        deadlines = [self.parts["base"].next_due]
        if self.base is not None:
            deadlines.append(self.parts["overlay"].next_due)
        for part in _PARTS:
            due = self._write_due_at(part, now)
            if due is not None:
                deadlines.append(due)
        # 바닥을 둔다: 어떤 상태 조합에서도 sleep(0) 헛돌기가 되지 않게(할 일이 있으면 50ms 늦을 뿐이다).
        timeout = max(min(deadlines) - now, MIN_LOOP_SLEEP_S)
        if self._wake is None:
            await asyncio.sleep(timeout)
            return
        # 깨울 이유는 전부 상태(next_due·dirty)에 반영돼 있어 여기서 지워도 잃는 신호가 없다.
        self._wake.clear()
        try:
            await asyncio.wait_for(self._wake.wait(), timeout)
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

    def _notify(self) -> None:
        event, self._changed = self._changed, None
        if event is not None:
            event.set()

    def _ok(self, part: str, seq: int, next_in: float) -> None:
        now = time.monotonic()
        state = self.parts[part]
        state.ok_at = now
        state.failures = 0
        state.hold_until = 0.0
        state.next_due = now + next_in
        with self._lock:
            self._applied_seq[part] = max(self._applied_seq[part], seq)
            if self._applied_seq[part] >= self._dirty_seq[part]:
                self._dirty_at[part] = None
            else:
                # 적재 중에 들어온 알림이 남았다 — 디바운스는 그 묶음의 첫 알림부터 다시 잰다. 가장 오래된
                # 알림 시각을 그대로 두면 다음 재적재가 곧바로 시작돼 연속 쓰기가 연속 전량 재적재가 된다.
                self._dirty_at[part] = self._marked_since_capture[part] or self._dirty_at[part]

    def _fail(self, part: str, exc: BaseException) -> None:
        now = time.monotonic()
        state = self.parts[part]
        state.failures += 1
        state.last_error = type(exc).__name__
        cap = BACKOFF_MAX_BEFORE_READY_S if self.view is None else BACKOFF_MAX_S
        retry_in = min(cap, BACKOFF_INITIAL_S * (2 ** (state.failures - 1)))
        state.next_due = now + retry_in
        logger.warning(
            "reference_snapshot_refresh_failed",
            part=part, error_type=type(exc).__name__, error=str(exc)[:300],
            failures=state.failures, retry_in_s=retry_in, ready=self.view is not None,
        )

    def _rebuild_view(self) -> None:
        if self.base is None or self.overlay is None:
            return
        try:
            view = _MapView(self.base, self.overlay, _utcnow())
            view.body_for(REGION_KEY)   # 웹이 늘 보내는 키는 미리 조립해 둔다
        except Exception as exc:  # noqa: BLE001 — 조립 버그가 이전 조립본까지 버리게 하지 않는다
            logger.error("reference_snapshot_view_failed", error_type=type(exc).__name__, error=str(exc)[:300])
            return
        self.view = view

    # ── 갱신(루프와 테스트가 같은 코드를 탄다) ───────────────────────────────
    def _busy_lock(self) -> asyncio.Lock:
        if self._busy is None:
            self._busy = asyncio.Lock()
        return self._busy

    async def refresh_base(self) -> None:
        async with self._busy_lock():
            await self._refresh_base()
        self._notify()

    async def refresh_overlay(self) -> None:
        async with self._busy_lock():
            await self._refresh_overlay()
        self._notify()

    async def _refresh_base(self) -> None:
        started = time.monotonic()
        seq, pending = self._capture("base")
        self._urgent["base"] = False
        force = (
            self.base is None
            or pending
            or self._last_full_load is None
            or started - self._last_full_load >= BASE_BACKSTOP_S
        )
        prev_refs = self.base.source_refs if self.base is not None else None
        try:
            signature, new, probe_error, refs_error = await self._in_thread(
                _load_base, self._base_signature, force, prev_refs
            )
        except Exception as exc:  # noqa: BLE001
            self._fail("base", exc)
            return
        if new is None and probe_error is not None:
            # 탐침만 실패 — 확인하지 못했으니 ok_at 은 그대로(오래되면 라우터가 실시간을 먼저 시도한다),
            # 실패 백오프도 걸지 않는다(베이스는 30분 전량 재적재가 따로 잡는다).
            state = self.parts["base"]
            state.last_error = f"probe:{type(probe_error).__name__}"
            state.next_due = time.monotonic() + BASE_PROBE_INTERVAL_S
            logger.warning(
                "reference_snapshot_probe_failed",
                error_type=type(probe_error).__name__, error=str(probe_error)[:300],
            )
            return
        if new is None:                         # 탐침: 바뀐 것 없음
            self._base_signature = signature
            self._ok("base", seq, BASE_PROBE_INTERVAL_S)
            return
        self._last_full_load = time.monotonic()
        if pending:
            self._write_reload_at = self._last_full_load
        if not self._passes_sanity_gate(new):
            # 정상본을 그대로 쓰고 SANITY_RETRY_S 뒤 다시 읽는다. 쓰기 알림이 있어도 앞당기지 않는다 —
            # 몇 초 사이 두 번 읽어 둘 다 흔들린 값이면 '연속 두 번 일치' 가 의미가 없다.
            # (아직 한 번도 못 만들었으면 B2 의 15초 상한을 따른다.)
            state = self.parts["base"]
            hold = SANITY_RETRY_S if self.view is not None else BACKOFF_MAX_BEFORE_READY_S
            state.hold_until = time.monotonic() + hold
            state.next_due = state.hold_until
            return
        # None(출처 표를 못 읽었다) 이면 다음으로 성공한 탐침이 전량 다시 읽는다.
        self._base_signature = signature
        old = self.base
        if old is None or new.version != old.version:
            self.base = new
            self._rebuild_view()
            if old is None or new.ids != old.ids:
                # 활성 시설이 바뀌었다 — 새 시설의 혼잡을 곧바로 읽는다(좌석 방송처럼 행 내용만 바뀐
                # 재적재마다 오버레이까지 다시 읽지 않는다).
                self.parts["overlay"].next_due = time.monotonic()
            logger.info(
                "reference_snapshot_base_swapped",
                version=new.version[:12], active=len(new.ids), dropped=new.dropped,
                elapsed_ms=round((time.monotonic() - started) * 1000),
            )
        elif new.source_refs is not old.source_refs:
            # 지도 조각은 같다(조립본·ETag 유지) — 다음 출처 표 장애 때 쓸 정상본만 새것으로.
            self.base = replace(old, source_refs=new.source_refs)
        if refs_error is not None:
            # 출처 표만 실패 — 시설 행은 반영했다(확인한 것은 확인한 것). 출처 표기는 정상본으로 채웠고,
            # 탐침은 백오프 간격으로(출처 표가 돌아오면 서명이 달라 전량 다시 읽는다).
            self._refs_failures += 1
            retry_in = min(BACKOFF_MAX_S, BACKOFF_INITIAL_S * (2 ** (self._refs_failures - 1)))
            self._ok("base", seq, retry_in)
            self.parts["base"].last_error = f"refs:{type(refs_error).__name__}"
            logger.warning(
                "reference_snapshot_source_refs_failed",
                error_type=type(refs_error).__name__, error=str(refs_error)[:300],
                failures=self._refs_failures, carried=prev_refs is not None, retry_in_s=retry_in,
            )
            return
        self._refs_failures = 0
        self._ok("base", seq, BASE_PROBE_INTERVAL_S)

    def _passes_sanity_gate(self, new: FacilityBase) -> bool:
        prev = self.base
        count = len(new.ids)
        if prev is None:
            if count == 0:
                # 첫 베이스가 0곳 — 준비된 척하지 않는다(실시간 경로가 계속 답한다).
                logger.warning("reference_snapshot_sanity_gate_held", reason="empty_first_base")
                return False
            return True
        prev_count = len(prev.ids)
        if count == 0 and prev_count > 0:
            logger.error("reference_snapshot_sanity_gate_held", reason="empty_base", previous=prev_count)
            return False
        if count >= (1.0 - SANITY_DROP_RATIO) * prev_count:
            self._suspect_count = None
            return True
        if self._suspect_count == count:
            logger.warning(
                "reference_snapshot_sanity_gate_confirmed", active=count, previous=prev_count,
            )
            self._suspect_count = None
            return True
        self._suspect_count = count
        logger.warning(
            "reference_snapshot_sanity_gate_held", reason="active_drop", active=count, previous=prev_count,
        )
        return False

    async def _refresh_overlay(self) -> None:
        base = self.base
        if base is None:
            return
        seq, _ = self._capture("overlay")
        self._urgent["overlay"] = False
        started = time.monotonic()
        try:
            overlay, errors = await self._in_thread(_load_overlay, base.ids, self.overlay, _utcnow())
        except Exception as exc:  # noqa: BLE001
            self._fail("overlay", exc)
            return
        if overlay is None:
            self._fail("overlay", errors[0][1])
            return
        if overlay is not self.overlay:
            self.overlay = overlay
            self._rebuild_view()
            logger.info(
                "reference_snapshot_overlay_swapped",
                version=overlay.version[:12], congestion=len(overlay.congestion),
                availability=len(overlay.availability),
                elapsed_ms=round((time.monotonic() - started) * 1000),
            )
        congestion_error = next((exc for part, exc in errors if part == "congestion"), None)
        if congestion_error is not None:
            self._fail("overlay", congestion_error)
            return
        # 영업 근거만 실패 — 혼잡은 새로 읽었다. 영업 근거는 정상본(만료는 요청 시각에 판정)으로 두고
        # 혼잡 갱신 주기·쓰기 직후 반영은 늦추지 않는다(영업 근거 장애가 혼잡 신선도를 끌고 가지 않게).
        self._ok("overlay", seq, OVERLAY_INTERVAL_S)
        for part, exc in errors:
            self.parts["overlay"].last_error = f"{part}:{type(exc).__name__}"
            logger.warning(
                "reference_snapshot_overlay_part_failed",
                part=part, error_type=type(exc).__name__, error=str(exc)[:300],
            )

    async def refresh_once(self) -> None:
        """베이스와 오버레이를 지금 한 번 갱신한다(루프와 같은 코드). 테스트·수동 확인용."""
        await self.refresh_base()
        if self.base is not None:
            await self.refresh_overlay()

    # ── 외부 신호 ───────────────────────────────────────────────────────────
    def mark_dirty(self, kind: str) -> None:
        try:
            parts = _KIND_PARTS.get(kind)
            if parts is None:
                logger.warning("reference_snapshot_unknown_dirty_kind", kind=kind)
                return
            if not parts:
                return
            now = time.monotonic()
            with self._lock:
                for part in parts:
                    self._dirty_seq[part] += 1
                    if self._dirty_at[part] is None:
                        self._dirty_at[part] = now
                    if self._marked_since_capture[part] is None:
                        self._marked_since_capture[part] = now
            self._wake_up()
        except Exception as exc:  # noqa: BLE001 — 쓰기 요청이 이 알림 때문에 실패하면 안 된다
            logger.warning("reference_snapshot_mark_dirty_failed", kind=kind, error=str(exc)[:200])

    def kick(self) -> None:
        """준비 전 요청이 즉시 적재를 한 번 깨운다(5초에 한 번 — 요청 폭주가 적재 폭주가 되지 않게)."""
        if not self._started:
            return
        now = time.monotonic()
        if now - self._last_kick < KICK_MIN_INTERVAL_S:
            return
        self._last_kick = now
        if self.base is None:
            self.parts["base"].next_due = min(self.parts["base"].next_due, now)
        if self.overlay is None:
            self.parts["overlay"].next_due = min(self.parts["overlay"].next_due, now)
        self._wake_up()

    async def _await_pending_writes(self) -> None:
        """방금 프로세스 안에서 쓴 값이 아직 반영 전이면 그 갱신을 잠깐(최대 DIRTY_WAIT_S) 기다린다."""
        if not self._started:
            return
        deadline = time.monotonic() + DIRTY_WAIT_S
        while True:
            now = time.monotonic()
            if now >= deadline:
                return
            waiting: list[str] = []
            for part in _PARTS:
                pending, at = self._pending(part)
                if not pending or at is None or now - at >= DIRTY_WAIT_WINDOW_S:
                    continue
                # 실패 백오프·관문 대기·재적재 간격 때문에 기다려도 이 요청 안에 반영될 수 없으면 기다리지 않는다.
                due = self._write_due_at(part, now, urgent=True)
                if due is not None and due < deadline:
                    waiting.append(part)
            if not waiting:
                return
            for part in waiting:
                self._urgent[part] = True
            if self._changed is None:
                self._changed = asyncio.Event()
            changed = self._changed
            self._wake_up()
            try:
                await asyncio.wait_for(changed.wait(), deadline - now)
            except asyncio.TimeoutError:
                return

    async def map_payload(self, key: MapKey) -> MapPayload | None:
        if not _serving():
            return None
        self._ensure_running()
        if self.view is None:
            self.kick()
            return None
        await self._await_pending_writes()
        try:
            view = self.view
            if view is None:
                return None
            view.ensure_valid(_utcnow())
            body = view.body_for(key)
        except Exception as exc:  # noqa: BLE001 — 조립 버그는 실시간 경로로(도입 전 동작)
            logger.error("reference_snapshot_serve_failed", error_type=type(exc).__name__, error=str(exc)[:300])
            return None
        base_age, overlay_age = self._age("base"), self._age("overlay")
        return MapPayload(
            body=body.body,
            etag=body.etag,
            age_s=int(max(base_age, overlay_age)),
            stale=(
                base_age > BASE_STALE_AFTER_S
                or overlay_age > OVERLAY_STALE_AFTER_S
                or self._base_stuck(base_age)
            ),
        )

    def _base_stuck(self, base_age: float) -> bool:
        """베이스 재적재가 실패 중인데 반영 못 한 시설 쓰기가 있거나 10분 넘게 확인하지 못했다.

        이 상태의 스냅샷은 방금 쓴 좌석 상태·시설 수정을 보여 주지 못한다(실패 백오프는 최대 5분). 라우터가
        실시간 경로를 먼저 시도하게 한다 — 스냅샷만의 적재 실패(열 목록·페이지네이션)면 실시간은 성공하고,
        실시간마저 실패하면 이 바이트가 마지막 정상본으로 나간다(도입 전보다 나빠지지 않게).
        """
        if self.parts["base"].failures <= 0:
            return False
        return self._pending("base")[0] or base_age > BASE_FAILING_STALE_AFTER_S

    def _age(self, part: str) -> float:
        ok_at = self.parts[part].ok_at
        return math.inf if ok_at is None else time.monotonic() - ok_at

    def health(self) -> dict:
        def part(name: str) -> dict:
            state = self.parts[name]
            age = self._age(name)
            return {
                "age_s": None if math.isinf(age) else int(age),
                "failures": state.failures,
                "last_error": state.last_error,
            }

        base, overlay, view = self.base, self.overlay, self.view
        return {
            "serve": _serve_mode(),
            "running": self._task is not None and not self._task.done(),
            "ready": view is not None,
            "base": {
                **part("base"),
                "version": base.version[:12] if base else None,
                "active": len(base.ids) if base else None,
                "dropped": base.dropped if base else None,
                "refs_failures": self._refs_failures,
            },
            "overlay": {
                **part("overlay"),
                "version": overlay.version[:12] if overlay else None,
                "congestion": len(overlay.congestion) if overlay else None,
                "availability": len(overlay.availability) if overlay else None,
            },
            "map_epoch": view.epoch if view else None,
        }


_refresher = _Refresher()


# =============================================================================
# 공개 API
# =============================================================================


def start() -> None:
    """lifespan 에서 부른다. 기다리지 않는다 — 첫 적재 전 요청은 실시간 경로가 답한다."""
    _refresher.start()


async def stop() -> None:
    await _refresher.stop()


def mark_dirty(kind: str) -> None:
    """프로세스 안의 쓰기가 끝난 뒤 부른다: 'facilities' | 'congestion' | 'availability' | 'timesales'.

    절대 예외를 올리지 않고, 어느 스레드에서 불러도 된다. 1초 디바운스 뒤 해당 부분을 다시 읽는다.
    """
    _refresher.mark_dirty(kind)


async def map_payload(key: MapKey) -> MapPayload | None:
    """지도 바이트. None 이면 스냅샷을 쓸 수 없다(꺼짐·아직 준비 전·조립 실패) — 실시간 경로로 답할 것."""
    return await _refresher.map_payload(key)


def health() -> dict:
    """준비 여부·부분별 나이·실패·판 번호. /health 가 싣는다(메모리 읽기만)."""
    return _refresher.health()


def current_base() -> FacilityBase | None:
    """지금의 시설 베이스(활성 id · 지도 조각 · 출처 표기 정상본). 불변 — 읽기만 할 것."""
    return _refresher.base


async def refresh_once() -> None:
    await _refresher.refresh_once()


def reset_for_tests() -> None:
    """상태 전부 초기화(테스트 격리). 루프 태스크는 테스트가 stop() 으로 먼저 끈다."""
    executor = _refresher._executor
    if executor is not None:
        executor.shutdown(wait=False, cancel_futures=True)
    _refresher.__init__()
