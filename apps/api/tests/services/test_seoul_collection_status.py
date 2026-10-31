"""서울 수집 상태 판정 — 주기를 아는 신선도 · 채움률 분모 · 보충 호출 최악값을 잠근다(순수 함수)."""

from datetime import datetime, timedelta, timezone

import pytest

from app.core.config import settings
from app.services import seoul_citydata_service as seoul
from app.services import seoul_collection_status as status

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_BUCKET = timedelta(minutes=10)


def _at(index: int, minutes: int = 0) -> datetime:
    return _EPOCH + _BUCKET * index + timedelta(minutes=minutes)


@pytest.mark.parametrize(
    ("cadence", "expected"),
    [(10, 30), (20, 45), (30, 65), (60, 125), (None, 30)],
)
def test_stale_threshold_allows_one_missed_collection_and_keeps_ten_minutes(cadence, expected):
    assert status.stale_after_minutes(cadence) == expected


def test_healthy_thirty_minute_target_never_crosses_its_threshold():
    # 30분 주기: 차례 버킷 :10 의 행은 :14 에 들어오고 다음 차례 :40 행은 :44 에 들어온다.
    # 그 직전(:43:59)의 나이 ≈ 34분 — 예전 30분 기준이면 매 주기 '멈춤' 이었다.
    worst_healthy_age = 30 + status.COLLECTION_OFFSET_MINUTES - 1
    assert worst_healthy_age > status.BASE_STALE_AFTER_MINUTES
    assert worst_healthy_age < status.stale_after_minutes(30)


@pytest.mark.parametrize(
    ("every", "offset", "expected"),
    [(1, 0, 48), (2, 0, 24), (2, 1, 24), (3, 0, 48), (3, 1, 0), (3, 2, 0), (6, 0, 24), (6, 3, 24), (6, 1, 0)],
)
def test_retry_calls_overlap_only_with_the_hh00_and_hh30_buckets(every, offset, expected):
    item = seoul.TargetSchedule("x", every, offset)
    brute = sum(1 for n in range(144) if n % 3 == 0 and item.is_due(n))
    assert status.retry_calls_per_day(item) == brute == expected


def test_call_budget_adds_worst_case_retries(monkeypatch):
    monkeypatch.setattr(
        settings,
        "SEOUL_CITYDATA_TARGETS",
        "홍대 관광특구,연남동,합정역,경복궁@3+1,북촌한옥마을@3+1,인사동@3+1,창덕궁·종묘@3+1,"
        "명동 관광특구@3+2,동대문 관광특구@3+2",
    )
    schedule, error = status.load_schedule()
    assert error is None
    budget = status.call_budget(schedule)
    assert budget["primary_per_day"] == 720
    assert budget["retry_worst_case_per_day"] == 144
    assert budget["worst_case_per_day"] == 864
    assert budget["headroom_per_day"] == 136 and budget["within_limit"] is True


def test_budget_over_the_limit_is_flagged(monkeypatch):
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", ",".join(f"대상{i}" for i in range(7)))
    schedule, _ = status.load_schedule()
    budget = status.call_budget(schedule)
    assert budget["primary_per_day"] == 7 * 144
    assert budget["within_limit"] is False


def test_invalid_schedule_is_reported_not_guessed(monkeypatch):
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", "홍대 관광특구@0")
    assert status.load_schedule() == (None, "seoul_targets_invalid")
    assert status.stale_after_by_target() == {}


def test_expected_due_buckets_counts_only_due_and_already_collectable_buckets():
    item = seoul.TargetSchedule("x", 3, 1)
    start = _at(300)
    now = _at(300 + 144, minutes=2)  # 마지막 버킷(444)은 시작 2분 뒤 — 아직 수집 전
    brute = sum(1 for n in range(300, 444) if n % 3 == 1)
    assert status.expected_due_buckets(item, start, now) == brute == 48
    # 5분이 지나면 444 가 차례인 경우에만 하나 는다(444 % 3 == 0 → 차례 아님).
    assert status.expected_due_buckets(item, start, _at(444, minutes=6)) == 48
    assert status.expected_due_buckets(item, start, _at(445, minutes=6)) == 49


def test_coverage_never_exceeds_one_and_counts_off_schedule_apart():
    item = seoul.TargetSchedule("x", 3, 1)
    start = _at(300)
    now = _at(330, minutes=6)
    buckets = [_at(n) for n in range(300, 331)]
    result = status.coverage(item, buckets, start, now)
    assert result.expected_buckets == sum(1 for n in range(300, 331) if n % 3 == 1)
    assert result.collected_buckets == result.expected_buckets
    assert result.off_schedule_buckets == len(buckets) - result.collected_buckets
    assert result.fill_rate == 1.0


def test_coverage_without_schedule_has_no_denominator():
    result = status.coverage(None, [_at(300)], _at(299), _at(310))
    assert result.expected_buckets is None and result.fill_rate is None and result.collected_buckets == 1


def _status(**overrides):
    base = dict(
        item=seoul.TargetSchedule("명동 관광특구", 3, 2),
        configured=True,
        schedule_valid=True,
        table_missing=False,
        buckets=[],
        latest_bucket=None,
        window_start=_at(0),
        now=_at(1000),
        last_run=None,
        zone_id=None,
        zone_rows_24h=None,
    )
    base.update(overrides)
    return status.target_status("명동 관광특구", **base)


def test_target_state_precedence_never_reports_running_without_fresh_rows():
    now = _at(1000)
    fresh = now - timedelta(minutes=40)
    assert _status(latest_bucket=fresh, buckets=[fresh])["state"] == "fresh"
    assert _status(latest_bucket=now - timedelta(minutes=70))["state"] == "stale"
    assert _status()["state"] == "empty"
    assert _status(table_missing=True, latest_bucket=fresh)["state"] == "not_migrated"
    assert _status(schedule_valid=False, item=None, latest_bucket=fresh)["state"] == "invalid_config"
    assert _status(configured=False, item=None, latest_bucket=fresh)["state"] == "not_configured"


def test_last_run_entry_reads_process_memory_only():
    assert status.last_run_entry({"targets": {}}, "x") is None
    entry = status.last_run_entry(
        {"targets": {"x": {"state": "failed", "error_code": "seoul_timeout", "checked_at": "t"}}}, "x"
    )
    assert entry["state"] == "failed" and entry["error_code"] == "seoul_timeout"
