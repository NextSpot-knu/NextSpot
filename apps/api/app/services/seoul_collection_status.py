"""서울 수집 **상태 판정** — 대상지별 주기를 아는 신선도·채움률·호출 예산(순수 함수, DB 없음).

`docs/SEOUL_TESTBED_PLAN.md` §6 S6 · §4 V1. 관리자 '실시간 데이터 리허설' 화면(`routers/engine_validation_admin.py`)과
대안 패널(`seoul_alternatives_service`)이 같은 규칙으로 '오래됐다' 를 말하게 한 곳에 둔다. 수집기
(`seoul_citydata_service`)의 동작은 바꾸지 않고, 그 모듈의 설정 해석(`configured_schedule`·`daily_call_budget`)만 읽는다.

## 왜 주기를 알아야 하나

예전에는 모든 대상지가 10분마다 불렸고 "최신 버킷이 30분보다 오래됐으면 멈춘 것" 이 맞았다. 대상지별 주기
(기본 설정 — 홍대 권역 10분, 종로 4곳·명동·동대문 30분)가 들어오면 그 규칙은 건강한 30분 대상지를 매 주기
'멈춤' 으로 보인다: 버킷 :20 의 행은 :24 에 들어오고, 다음 차례 :50 의 행은 :54 에 들어온다 — 그 직전 나이는
약 34분이다. 주기는 설정에서 읽으므로(`configured_schedule`) 20분 같은 다른 주기에도 같은 식이 적용된다.

## 신선도 기준: max(30, 2 × 주기 + 8)

  · **2 × 주기** — 한 번 빠뜨리는 것까지는 '멈춤' 이 아니다. 서울 API 한 번의 실패(타임아웃·일시 오류)는
    흔하고, 다음 차례에 저절로 메워진다. 두 번 연속 빠지면 그때 사람에게 알린다.
  · **+ 8분** — 행의 시각(`bucket_at`)은 버킷의 **시작**이고 pg_cron 주 호출은 버킷 시작 4분 뒤(:x4)에 돈다.
    그 요청은 pg_cron 요청 제한(90초) 안에 끝나거나 버려진다 — 수집기는 버킷당 최대 7곳을 4개씩 동시에
    부르므로(묶음 2개 × 10초 + 관광 성분 15초 + 저장) 보통 1분 안이다. 그래서 행은 늦어도 버킷 시작 + 5.5분에
    들어온다. 나머지 2.5분은 여유다: Render 가 잠들었다 깨는 첫 요청 지연, DB·API 서버 시계 차이.
    5분으로 두면 한 번 놓친 30분 대상지의 나이(30 × 2 + 4 + 처리 시간 ≈ 64~65.5분)가 기준 65분과 겹쳤다.
  · **max(30, …)** — 10분 대상지는 2 × 10 + 8 = 28 이 되지만, 예전 기준(30분)을 그대로 둔다. 10분 주기에서
    화면·경보가 갑자기 더 예민해지면 '주기를 아는 기준' 이 아니라 '기준을 조인 변경' 이 된다.

결과: 10분 → 30분(그대로) · 20분 → 48분 · 30분 → 68분.

## 채움률의 분모는 '그 대상지의 차례였던 버킷 수' 다

하루 144가 아니다. 30분 대상지는 하루 48번만 불리므로 48이 분모다. 창 안에 차례가 아닌 버킷의 행(예전 10분 설정
때의 행·수동 호출)은 분자에 넣지 않고 `off_schedule_buckets` 로 따로 센다 — 넣으면 채움률이 100% 를 넘는다.
아직 수집 시각(버킷 시작 + 8분)이 지나지 않은 지금 버킷은 분모에 넣지 않는다.

분모는 **창 시작과 그 대상지의 첫 버킷(표 전체에서) 중 늦은 쪽**부터 센다. 창(예: 14일)보다 나중에 수집을
시작한 대상지(S2 의 종로 4곳)를 창 시작부터 세면 두 주 내내 7% 같은 숫자가 '수집이 빠진다' 로 읽힌다.
첫 버킷 이후의 누락은 그대로 분모에 남는다. 어느 시각부터 셌는지는 `counted_since_at` 으로 함께 준다.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from app.services import seoul_citydata_service as seoul
from app.services.seoul_citydata_service import SeoulCitydataError, TargetSchedule

BUCKET_MINUTES = 10
BUCKETS_PER_DAY = 144
_BUCKET = timedelta(minutes=BUCKET_MINUTES)
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

# pg_cron 주 호출이 버킷 시작 4분 뒤(:x4)에 돌고 90초 안에 끝나거나 버려진다 + 여유 2.5분(위 모듈 설명).
COLLECTION_OFFSET_MINUTES = 8
# 10분 주기 시절의 기준. 이보다 예민해지지는 않는다.
BASE_STALE_AFTER_MINUTES = 30
# 서울 열린데이터광장 인증키 일 호출 한도(대상지 1곳 = 1회).
DAILY_CALL_LIMIT = 1_000
# 보충 호출 — 마이그레이션 20260920140000: '9,39 * * * *' 에 그 버킷 행이 0개일 때만 같은 엔드포인트를 부른다.
# :09 는 :00 버킷, :39 는 :30 버킷이므로 버킷 번호 n 이 n % 3 == 0 인 버킷만 다시 불린다.
# ⚠️ 이 예약은 코드가 아니라 DB(pg_cron)에 있다 — 여기 값은 그 마이그레이션이 **적용됐다는 가정**이다(S0 점검
#    쿼리 C 결과 '9,39 * * * *' 로 확인, 2026-10-31). 예약을 바꾸면 이 세 값과 보충 최악값을 함께 고친다.
RETRY_CRON = "9,39 * * * *"
RETRY_EVERY = 3
RETRY_OFFSET = 0
RETRY_MIGRATION = "20260920140000_seoul_citydata_retry_budget.sql"
STALE_RULE = f"max(30, 2 × 주기 + {COLLECTION_OFFSET_MINUTES})분"

TARGET_FRESH = "fresh"
TARGET_STALE = "stale"
TARGET_EMPTY = "empty"
TARGET_NOT_MIGRATED = "not_migrated"
TARGET_INVALID_CONFIG = "invalid_config"
TARGET_NOT_CONFIGURED = "not_configured"


def cadence_minutes(every: int) -> int:
    return int(every) * BUCKET_MINUTES


def stale_after_minutes(cadence: int | None) -> int:
    """주기(분) → '오래됨' 기준(분). 주기를 모르면 10분 시절의 기준(30분)."""
    if cadence is None or cadence <= 0:
        return BASE_STALE_AFTER_MINUTES
    return max(BASE_STALE_AFTER_MINUTES, 2 * int(cadence) + COLLECTION_OFFSET_MINUTES)


def load_schedule() -> tuple[list[TargetSchedule] | None, str | None]:
    """(주기 목록, 오류 코드). 표기가 틀리면 (None, 'seoul_targets_invalid') — 수집기도 그때 멈춘다."""
    try:
        return seoul.configured_schedule(), None
    except SeoulCitydataError as exc:
        return None, exc.code


def stale_after_by_target(schedule: list[TargetSchedule] | None = None) -> dict[str, int]:
    """대상지 이름 → 신선도 기준(분). 설정이 틀리면 빈 dict(부르는 쪽은 30분으로 떨어진다)."""
    if schedule is None:
        schedule, _ = load_schedule()
    return {item.area_nm: stale_after_minutes(cadence_minutes(item.every)) for item in schedule or []}


def fastest_stale_after(schedule: list[TargetSchedule] | None) -> int:
    """수집기 전체가 멈췄는지 볼 기준 — 가장 자주 부르는 대상지의 기준. 그보다 오래 아무 행도 없으면 멈춘 것이다."""
    if not schedule:
        return BASE_STALE_AFTER_MINUTES
    return stale_after_minutes(cadence_minutes(min(item.every for item in schedule)))


# ── 호출 예산 ─────────────────────────────────────────────────────────────────


def retry_calls_per_day(item: TargetSchedule) -> int:
    """보충 호출이 이 대상지를 하루에 최대 몇 번 다시 부르나(주 호출이 전부 실패한 최악의 날).

    보충 버킷(n % 3 == 0)과 차례(n % every == offset)가 겹치는 버킷 수다. 중국인의 나머지 정리로
    겹침은 offset ≡ 0 (mod gcd(3, every)) 일 때만 있고, 그때 lcm(3, every) 버킷마다 한 번이다.
    """
    gcd = math.gcd(RETRY_EVERY, item.every)
    if (item.offset - RETRY_OFFSET) % gcd != 0:
        return 0
    period = RETRY_EVERY * item.every // gcd
    return math.ceil(BUCKETS_PER_DAY / period)


def call_budget(schedule: list[TargetSchedule]) -> dict[str, Any]:
    primary = seoul.daily_call_budget(schedule)
    retry = sum(retry_calls_per_day(item) for item in schedule)
    worst = primary + retry
    return {
        "primary_per_day": primary,
        "retry_worst_case_per_day": retry,
        "worst_case_per_day": worst,
        "limit_per_day": DAILY_CALL_LIMIT,
        "headroom_per_day": DAILY_CALL_LIMIT - worst,
        "within_limit": worst <= DAILY_CALL_LIMIT,
        "retry_cron": RETRY_CRON,
        "retry_migration": RETRY_MIGRATION,
    }


# ── 차례였던 버킷 세기 ─────────────────────────────────────────────────────────


def _index_ceil(moment: datetime) -> int:
    return math.ceil((moment - _EPOCH) / _BUCKET)


def _index_floor(moment: datetime) -> int:
    return int((moment - _EPOCH) // _BUCKET)


def last_collectable_index(now: datetime) -> int:
    """지금까지 수집됐어야 하는 마지막 버킷 번호 — 시작 + COLLECTION_OFFSET_MINUTES(8분)이 지난 버킷까지."""
    return _index_floor(now - timedelta(minutes=COLLECTION_OFFSET_MINUTES))


def expected_due_buckets(item: TargetSchedule, start: datetime, now: datetime) -> int:
    """[start, now] 안에서 이 대상지의 차례였고 수집 시각도 지난 버킷 수."""
    first = _index_ceil(start)
    last = last_collectable_index(now)
    if last < first:
        return 0
    # first..last 에서 n ≡ offset (mod every) 인 n 의 개수.
    return (last - item.offset) // item.every - (first - 1 - item.offset) // item.every


@dataclass
class Coverage:
    expected_buckets: int | None
    collected_buckets: int
    off_schedule_buckets: int

    @property
    def fill_rate(self) -> float | None:
        if not self.expected_buckets:
            return None
        return round(min(1.0, self.collected_buckets / self.expected_buckets), 4)

    def as_dict(self) -> dict[str, Any]:
        return {
            "expected_buckets": self.expected_buckets,
            "collected_buckets": self.collected_buckets,
            "off_schedule_buckets": self.off_schedule_buckets,
            "fill_rate": self.fill_rate,
        }


def coverage(item: TargetSchedule | None, buckets: Iterable[datetime], start: datetime, now: datetime) -> Coverage:
    """창 [start, now] 의 채움. 주기를 모르면(설정 오류·설정 밖 대상지) 분모 없이 실제 버킷 수만.

    `start` 는 부르는 쪽이 정한다 — 대상지가 창 안에서 수집을 시작했으면 그 첫 버킷(`target_status`)."""
    first = _index_ceil(start)
    last = last_collectable_index(now)
    indices = {_index_floor(bucket) for bucket in buckets if start <= bucket <= now}
    if item is None:
        return Coverage(expected_buckets=None, collected_buckets=len(indices), off_schedule_buckets=0)
    due = {n for n in indices if item.is_due(n) and first <= n <= last}
    # 지금 버킷이 수집 시각 전에 이미 들어왔으면(수동 호출 등) 분자에도 분모에도 넣지 않는다 — 100% 를 넘지 않게.
    off = {n for n in indices if not item.is_due(n)}
    return Coverage(
        expected_buckets=expected_due_buckets(item, start, now),
        collected_buckets=len(due),
        off_schedule_buckets=len(off),
    )


# ── 대상지 한 곳의 상태 ───────────────────────────────────────────────────────


def _iso(moment: datetime | None) -> str | None:
    return moment.astimezone(timezone.utc).isoformat() if moment is not None else None


def target_status(
    area_nm: str,
    *,
    item: TargetSchedule | None,
    configured: bool,
    schedule_valid: bool,
    table_missing: bool,
    buckets: list[datetime],
    latest_bucket: datetime | None,
    window_start: datetime,
    now: datetime,
    last_run: dict[str, Any] | None,
    zone_id: str | None,
    zone_rows_24h: int | None,
    first_bucket_ever: datetime | None = None,
) -> dict[str, Any]:
    """대상지 한 곳의 수집 상태. **행이 없거나 오래됐으면 절대 fresh 가 아니다.**

    state 판정 순서(앞이 이긴다):
      not_migrated    원본 표가 없다
      invalid_config  주기 표기가 틀려 수집기가 멈춰 있다(주기를 모르니 신선도도 말하지 않는다)
      not_configured  창 안에 행은 있지만 지금 설정에는 없는 대상지
      empty           이 대상지의 행이 한 줄도 없다
      stale           최신 버킷 나이 > 기준
      fresh           기준 안

    채움률 분모의 시작은 max(창 시작, `first_bucket_ever`) 다(모듈 설명). `first_bucket_ever` 는 표 전체에서
    이 대상지의 첫 버킷이고, 모르면(None) 창 시작부터 센다.
    """
    cadence = cadence_minutes(item.every) if item else None
    threshold = stale_after_minutes(cadence)
    age = round((now - latest_bucket).total_seconds() / 60.0, 1) if latest_bucket else None
    if table_missing:
        state = TARGET_NOT_MIGRATED
    elif not schedule_valid:
        state = TARGET_INVALID_CONFIG
    elif not configured:
        state = TARGET_NOT_CONFIGURED
    elif latest_bucket is None:
        state = TARGET_EMPTY
    elif age is not None and age > threshold:
        state = TARGET_STALE
    else:
        state = TARGET_FRESH
    day_start = now - timedelta(days=1)
    counted_since = max(window_start, first_bucket_ever) if first_bucket_ever is not None else window_start
    window = coverage(item, buckets, counted_since, now)
    last_day = coverage(item, buckets, max(day_start, counted_since), now)
    rows_24h = sum(1 for bucket in buckets if day_start <= bucket <= now)
    in_window = [bucket for bucket in buckets if window_start <= bucket <= now]
    return {
        "area_nm": area_nm,
        "zone_id": zone_id,
        "configured": configured,
        "state": state,
        "every_buckets": item.every if item else None,
        "offset_buckets": item.offset if item else None,
        "cadence_minutes": cadence,
        "stale_after_minutes": threshold if item else None,
        "latest_bucket_at": _iso(latest_bucket),
        "latest_age_minutes": age,
        # 창 안 첫 버킷 — 창 시작보다 늦으면 그 전에는 이 대상지를 부르지 않았거나 끊겨 있었다(채움률이 낮은 이유).
        "first_bucket_in_window_at": _iso(min(in_window)) if in_window else None,
        # 채움률 분모를 센 시작 시각 — 창 시작보다 늦으면 이 대상지가 그때 수집을 시작했다는 뜻이다.
        "counted_since_at": _iso(counted_since),
        "window": window.as_dict(),
        "last_24h": last_day.as_dict(),
        "rows_24h": rows_24h,
        "zone_rows_24h": zone_rows_24h,
        "primary_calls_per_day": math.ceil(BUCKETS_PER_DAY / item.every) if item else None,
        "retry_calls_per_day_worst": retry_calls_per_day(item) if item else None,
        "last_run": last_run,
    }


def last_run_entry(status: dict[str, Any], area_nm: str) -> dict[str, Any] | None:
    """프로세스 메모리의 마지막 시도(수집기 `get_collection_status()['targets']`). 재시작 뒤 첫 수집 전에는 None."""
    entry = (status.get("targets") or {}).get(area_nm)
    if not isinstance(entry, dict):
        return None
    return {
        "state": entry.get("state"),
        "checked_at": entry.get("checked_at"),
        "error_code": entry.get("error_code"),
        "upstream_code": entry.get("upstream_code"),
        "last_success_at": entry.get("last_success_at"),
    }
