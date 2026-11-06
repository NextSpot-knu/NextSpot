"""서울 수집기 — 대상지별 주기(S2)와 정규화 이중 저장(S1).

지키는 것:
  · 버킷은 그대로 UTC 10분이고, 주기는 '그 버킷에 누구를 부르나' 만 바꾼다.
  · 모든 주기는 30분의 약수다 — 30분 전망 지표(t ↔ t+30)가 모든 대상지에서 짝을 찾는다.
  · 기본 9곳의 하루 호출 산수(주 720 · 보충 최악 +144 = 864)와 버킷당 최대 7곳 — 조회는 4개씩 동시라
    pg_cron 요청 제한(90초) 안에 저장 몫이 넉넉히 남는다.
  · 동시 조회는 상한(4)을 넘지 않고, 느리거나 실패한 대상지가 다른 대상지를 막거나 결과를 섞지 않는다.
    보충 최악값은 **보충 예약이 20260920140000 의 '9,39 * * * *' 라는 가정**에서 나온다 — 테스트가 그
    마이그레이션 파일에서 분을 읽어 쓴다(예약이 바뀌면 이 테스트가 먼저 깨진다).
  · 보충 호출(같은 버킷 :09·:39)도 차례인 대상지만 다시 부른다.
  · 차례와 저장 버킷은 run_at 으로 한 번 정한다(느린 실행이 경계를 넘어도 차례 밖 버킷에 행이 없다).
  · 이중 저장은 기존 저장·응답을 바꾸지 않고, 표가 없거나 터져도 수집을 멈추지 않는다.
"""

from __future__ import annotations

import asyncio
import copy
import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.core.config import settings
from app.services import seoul_citydata_service as seoul
from app.services.crowd import store as crowd_store

ROOT = Path(__file__).resolve().parents[4]
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
KST = timezone(timedelta(hours=9))
FAKE_KEY = "SEOULKEY0123456789abcdef"
HONGDAE = "홍대 관광특구"
HONGDAE_CLUSTER = [HONGDAE, "연남동", "합정역"]
JONGNO = ["경복궁", "북촌한옥마을", "인사동", "창덕궁·종묘"]
VALIDATION = ["명동 관광특구", "동대문 관광특구"]
DEFAULT_TARGETS = type(settings).model_fields["SEOUL_CITYDATA_TARGETS"].default
DAILY_LIMIT = 1_000
# 2026-09-20 05:40 UTC 버킷 — 번호 n % 3 == 1(:10·:40 계열)이다(아래 테스트가 확인).
HONGDAE_FETCHED_AT = datetime(2026, 9, 20, 14, 41, 30, tzinfo=KST).astimezone(timezone.utc)
RETRY_BUDGET_MIGRATION = ROOT / "supabase/migrations/20260920140000_seoul_citydata_retry_budget.sql"
RETRY_ORIGINAL_MIGRATION = ROOT / "supabase/migrations/20260920121000_schedule_seoul_citydata_collection.sql"


def _payload_for(name: str) -> dict:
    payload = json.loads((FIXTURES / "seoul_citydata_hongdae_synthetic.json").read_text(encoding="utf-8"))
    payload["CITYDATA"]["AREA_NM"] = name
    payload["CITYDATA"]["LIVE_PPLTN_STTS"][0]["AREA_NM"] = name
    return payload


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    seoul.reset_state()
    monkeypatch.setattr(settings, "SEOUL_OPENDATA_KEY", FAKE_KEY)
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", DEFAULT_TARGETS)
    monkeypatch.setattr(settings, "TOURAPI_KEY", "")
    monkeypatch.setattr(seoul, "_probe_table", lambda: None)
    yield
    seoul.reset_state()


class _Recorder:
    def __init__(self):
        self.legacy: list[dict] = []
        self.zone: list[dict] = []
        self.fetched: list[str] = []


def _wire(monkeypatch, *, zone_upsert=None, on_fetch=None) -> _Recorder:
    recorder = _Recorder()

    async def fetch(_client, key, area_nm):
        assert key == FAKE_KEY
        recorder.fetched.append(area_nm)
        if on_fetch is not None:
            on_fetch(area_nm)
        return copy.deepcopy(_payload_for(area_nm))

    monkeypatch.setattr(seoul, "fetch_citydata", fetch)
    monkeypatch.setattr(seoul, "_upsert_row", recorder.legacy.append)
    monkeypatch.setattr(crowd_store, "_upsert_row", zone_upsert or recorder.zone.append)
    return recorder


def _at_bucket(index: int, minute_offset: int = 4) -> datetime:
    return datetime(1970, 1, 1, tzinfo=timezone.utc) + seoul.BUCKET * index + timedelta(minutes=minute_offset)


def _retry_minutes(migration: Path) -> list[int]:
    """그 마이그레이션이 거는 보충 예약(nextspot-seoul-citydata-retry)의 분 목록."""
    sql = migration.read_text(encoding="utf-8")
    match = re.search(r"'nextspot-seoul-citydata-retry',\s*'([\d,]+) \* \* \* \*'", sql)
    assert match, migration.name
    return [int(minute) for minute in match.group(1).split(",")]


# ── 설정 표기 ─────────────────────────────────────────────────────────────────


def test_cadence_suffix_is_stripped_from_names_and_parsed(monkeypatch):
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", " 홍대 관광특구 @ 2 , 연남동@3+2,합정역,홍대  관광특구@2")
    assert seoul.configured_targets() == [HONGDAE, "연남동", "합정역"]
    assert seoul.configured_schedule() == [
        seoul.TargetSchedule(HONGDAE, 2, 0),
        seoul.TargetSchedule("연남동", 3, 2),
        seoul.TargetSchedule("합정역", 1, 0),
    ]


def test_full_width_notation_is_nfkc_normalised(monkeypatch):
    """전각 ＠·＋·숫자가 이름에 붙어 남으면 서울 API 가 모르는 이름을 매 버킷 부른다."""
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", "경복궁＠３＋１，창덕궁·종묘@3+1")
    assert seoul.configured_targets() == ["경복궁", "창덕궁·종묘"]
    assert seoul.configured_schedule() == [
        seoul.TargetSchedule("경복궁", 3, 1),
        seoul.TargetSchedule("창덕궁·종묘", 3, 1),
    ]
    assert "·" in seoul.configured_targets()[1], "공식 이름의 가운뎃점(U+00B7)은 그대로다"


@pytest.mark.parametrize(
    "spec",
    [
        "홍대 관광특구@0", "홍대 관광특구@2+2", "홍대 관광특구@x", "홍대 관광특구@145", "홍대 관광특구@",
        # 같은 이름이 다른 주기로 두 번 — 어느 쪽인지 고르지 않는다.
        "홍대 관광특구@2,홍대 관광특구@3", "홍대 관광특구,홍대 관광특구@3+1",
    ],
)
def test_bad_cadence_stops_collection_instead_of_guessing(monkeypatch, spec):
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", spec)
    # 상태 화면용 이름 목록은 그대로 읽힌다.
    assert seoul.configured_targets() == [HONGDAE]
    with pytest.raises(seoul.SeoulCitydataError) as info:
        asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))
    assert info.value.code == "seoul_targets_invalid"
    assert seoul.get_collection_status()["error_code"] == "seoul_targets_invalid"


@pytest.mark.parametrize("value", ["", " , ,"])
def test_explicitly_empty_setting_is_still_targets_missing(monkeypatch, value):
    """빈 값은 '기본값' 이 아니다 — 기본값을 쓰려면 환경변수를 지운다(.env.example 주석)."""
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", value)
    with pytest.raises(seoul.SeoulCitydataError) as info:
        asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))
    assert info.value.code == "seoul_targets_missing"


# ── 기본 9곳의 호출 산수 ───────────────────────────────────────────────────────


def test_default_schedule_primary_calls_and_per_bucket_ceiling():
    schedule = seoul.configured_schedule()
    assert len(schedule) == 9
    assert seoul.daily_call_budget(schedule) == 720

    per_bucket = [len(seoul.due_targets(schedule, _at_bucket(n))[0]) for n in range(144)]
    assert sum(per_bucket) == 720 == 3 * 144 + 4 * 48 + 2 * 48
    assert sorted(set(per_bucket)) == [3, 5, 7]
    # pg_cron 요청 제한 90초. httpx 제한은 단계별(연결·읽기 덩어리마다)이라 곱셈으로는 상한이 안 나온다 —
    # 그래서 시간은 마감으로 묶는다. 여기서는 (1) 정상 최악(전부 연결 5 + 읽기 10 까지)이 조회 마감 안이고
    # (2) 마감들이 90초 안에 응답을 돌려줄 순서로 놓였는지 본다.
    waves = math.ceil(max(per_bucket) / seoul._FETCH_CONCURRENCY)
    timeout = seoul._SEOUL_HTTP_TIMEOUT
    nominal_fetch = waves * (timeout.connect + timeout.read)
    assert (waves, nominal_fetch) == (2, 30.0)
    # 홍대(첫 묶음)의 관광 성분 조회는 둘째 묶음과 겹치지만, 겹치지 않는다고 쳐도 마감 안이다.
    assert nominal_fetch + seoul._TOURISM_TIMEOUT_SECONDS <= seoul._FETCH_DEADLINE_SECONDS
    assert seoul._PROBE_TIMEOUT_SECONDS + seoul._FETCH_DEADLINE_SECONDS < seoul._RUN_DEADLINE_SECONDS
    assert seoul._WRITE_TIMEOUT_SECONDS < seoul._RUN_DEADLINE_SECONDS <= 90 - 10


def test_worst_case_assumes_retry_job_from_20260920140000():
    """최악 = 주 호출 전부 실패 → 보충 호출이 매번 깨어남. 보충 분(:09·:39)은 140000 에서 읽는다."""
    schedule = seoul.configured_schedule()
    retry_minutes = _retry_minutes(RETRY_BUDGET_MIGRATION)
    assert retry_minutes == [9, 39]
    # 보충 호출은 그 분이 속한 버킷(:00·:30)의 차례만 다시 부른다.
    retry_bucket_minutes = {minute - minute % 10 for minute in retry_minutes}
    retry_buckets = [n for n in range(144) if _at_bucket(n, minute_offset=0).minute in retry_bucket_minutes]
    assert len(retry_buckets) == 48
    for n in retry_buckets:
        assert seoul.due_targets(schedule, _at_bucket(n))[0] == HONGDAE_CLUSTER, "종로·검증은 보충 버킷에 차례가 없다"
    worst_retry = sum(len(seoul.due_targets(schedule, _at_bucket(n))[0]) for n in retry_buckets)
    assert worst_retry == 144
    assert 720 + worst_retry == 864 < DAILY_LIMIT


def test_worst_case_before_retry_budget_migration_for_reference():
    """140000 이전(보충이 매 버킷 :09·:19·…)이라면 최악 +720 = 1,440회로 한도를 넘는다 — 그래서 140000 이 필요하다."""
    schedule = seoul.configured_schedule()
    assert _retry_minutes(RETRY_ORIGINAL_MIGRATION) == [9, 19, 29, 39, 49, 59]
    worst_retry = sum(len(seoul.due_targets(schedule, _at_bucket(n))[0]) for n in range(144))
    assert 720 + worst_retry == 1_440 > DAILY_LIMIT


def test_every_cadence_divides_thirty_minutes():
    """30분 전망 지표는 버킷 t 와 t+30(3칸 뒤)을 짝짓는다 — 모든 대상지가 늘 짝을 가져야 한다."""
    schedule = seoul.configured_schedule()
    for item in schedule:
        assert 3 % item.every == 0, item
    for n in range(144):
        due = set(seoul.due_targets(schedule, _at_bucket(n))[0])
        assert due <= set(seoul.due_targets(schedule, _at_bucket(n + 3))[0])


def test_each_cluster_is_measured_in_the_same_bucket():
    schedule = seoul.configured_schedule()
    clusters = {"jongno": set(JONGNO), "hongdae": set(HONGDAE_CLUSTER), "validation": set(VALIDATION)}
    for n in range(144):
        due = set(seoul.due_targets(schedule, _at_bucket(n))[0])
        for members in clusters.values():
            assert due & members in (set(), members), "권역은 함께 재거나 함께 쉰다"


def test_bucket_index_matches_bucket_start():
    assert seoul.bucket_index(_at_bucket(5, minute_offset=9)) == 5
    assert seoul.bucket_start(_at_bucket(5, minute_offset=9)) == _at_bucket(5, minute_offset=0)


# ── 수집: 차례인 대상지만 ──────────────────────────────────────────────────────


def test_collect_calls_only_due_targets_and_reports_the_rest(monkeypatch):
    recorder = _wire(monkeypatch)
    assert seoul.bucket_index(HONGDAE_FETCHED_AT) % 3 == 1

    result = asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))

    # n % 3 == 1 = 홍대(매 버킷) + 종로. 검증 지점은 쉰다.
    assert recorder.fetched == HONGDAE_CLUSTER + JONGNO
    assert result["state"] == "ok"
    assert result["stored_count"] == 7
    assert result["skipped_targets"] == VALIDATION
    assert {row["bucket_at"] for row in recorder.legacy} == {"2026-09-20T05:40:00+00:00"}
    status = seoul.get_collection_status()
    assert status["skipped_targets"] == result["skipped_targets"]


def test_retry_in_the_same_bucket_respects_the_cadence(monkeypatch):
    """pg_cron 보충 호출(같은 버킷 5분 뒤)은 주 호출과 같은 대상지만 다시 부른다."""
    recorder = _wire(monkeypatch)
    primary = _at_bucket(3, minute_offset=4)  # n % 3 == 0 → :00·:30 계열(보충 버킷)
    asyncio.run(seoul.collect_seoul_citydata(now=primary))
    first = list(recorder.fetched)
    recorder.fetched.clear()
    asyncio.run(seoul.collect_seoul_citydata(now=primary + timedelta(minutes=5)))
    assert recorder.fetched == first == HONGDAE_CLUSTER


def test_slow_run_crossing_a_bucket_boundary_stays_in_its_bucket(monkeypatch):
    """차례는 05:40 버킷으로 정했는데 마지막 대상지를 05:50 이후에 받았다 — 행은 05:40 에 남아야 한다."""
    clock = [datetime(2026, 9, 20, 5, 49, 50, tzinfo=timezone.utc)]
    monkeypatch.setattr(seoul, "_now", lambda: clock[0])

    def tick(_area_nm):
        clock[0] += timedelta(seconds=3)

    recorder = _wire(monkeypatch, on_fetch=tick)
    result = asyncio.run(seoul.collect_seoul_citydata())

    assert recorder.fetched == HONGDAE_CLUSTER + JONGNO
    assert clock[0] > datetime(2026, 9, 20, 5, 50, tzinfo=timezone.utc), "실행이 경계를 넘었다"
    assert {row["bucket_at"] for row in recorder.legacy} == {"2026-09-20T05:40:00+00:00"}
    assert {row["bucket_at"] for row in recorder.zone} == {"2026-09-20T05:40:00+00:00"}
    assert result["bucket_at"] == "2026-09-20T05:40:00+00:00"
    # 받은 시각은 대상지마다 실제 값 그대로다.
    assert max(row["fetched_at"] for row in recorder.legacy) > "2026-09-20T05:50:00"


def test_concurrent_fetch_is_bounded_and_isolates_slow_and_failed_targets(monkeypatch):
    """7곳(n % 3 == 1 버킷): 동시 조회는 4를 넘지 않고, 느린 곳·실패한 곳이 나머지를 막거나 섞지 않는다."""
    in_flight = 0
    peak = 0
    finished: list[str] = []
    slow, broken = "연남동", "인사동"

    async def fetch(_client, key, area_nm):
        nonlocal in_flight, peak
        assert key == FAKE_KEY
        in_flight += 1
        peak = max(peak, in_flight)
        try:
            await asyncio.sleep(0.4 if area_nm == slow else 0.02)
            if area_nm == broken:
                raise seoul.SeoulCitydataError("seoul_timeout")
            return copy.deepcopy(_payload_for(area_nm))
        finally:
            in_flight -= 1
            finished.append(area_nm)

    legacy: list[dict] = []
    zone: list[dict] = []
    monkeypatch.setattr(seoul, "fetch_citydata", fetch)
    monkeypatch.setattr(seoul, "_upsert_row", legacy.append)
    monkeypatch.setattr(crowd_store, "_upsert_row", zone.append)

    result = asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))

    assert peak == seoul._FETCH_CONCURRENCY == 4
    # 느린 곳(설정상 두 번째)이 자리를 하나 잡고 있는 동안 뒤의 5곳은 남은 자리로 끝까지 돈다 —
    # 순차였다면 뒤의 5곳은 느린 곳이 끝난 뒤에야 시작했다.
    assert finished[-1] == slow
    assert sorted(finished[:-1]) == sorted(name for name in HONGDAE_CLUSTER + JONGNO if name != slow)

    # 결과·저장 순서는 설정 순서 그대로(완료 순서가 아니다).
    expected = HONGDAE_CLUSTER + JONGNO
    assert [t["area_nm"] for t in result["targets"]] == expected
    assert [row["area_nm"] for row in legacy] == [name for name in expected if name != broken]
    failed = [t for t in result["targets"] if t["state"] == "failed"]
    assert failed == [{"area_nm": broken, "state": "failed", "error_code": "seoul_timeout", "upstream_code": None}]
    assert result["state"] == "partial"
    assert (result["stored_count"], result["failed_count"]) == (6, 1)
    assert len(zone) == 6 and "seoul:POI078" not in {row["zone_id"] for row in zone}

    status = seoul.get_collection_status()
    assert list(status["targets"]) == expected
    assert status["targets"][broken]["error_code"] == "seoul_timeout"
    assert status["targets"][slow]["state"] == "stored"
    assert status["zone_snapshots"]["stored_count"] == 6


def test_fetch_deadline_keeps_finished_targets_and_marks_the_rest_timeout(monkeypatch):
    """조회 마감까지 못 끝낸 대상지만 seoul_timeout — 끝낸 대상지는 그대로 저장된다."""
    monkeypatch.setattr(seoul, "_FETCH_DEADLINE_SECONDS", 0.2)
    stuck = "북촌한옥마을"

    async def fetch(_client, _key, area_nm):
        await asyncio.sleep(5 if area_nm == stuck else 0.01)
        return copy.deepcopy(_payload_for(area_nm))

    legacy: list[dict] = []
    monkeypatch.setattr(seoul, "fetch_citydata", fetch)
    monkeypatch.setattr(seoul, "_upsert_row", legacy.append)
    monkeypatch.setattr(crowd_store, "_upsert_row", lambda _row: None)

    result = asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))

    expected = HONGDAE_CLUSTER + JONGNO
    assert [t["area_nm"] for t in result["targets"]] == expected
    by_name = {t["area_nm"]: t for t in result["targets"]}
    assert by_name[stuck]["state"] == "failed" and by_name[stuck]["error_code"] == "seoul_timeout"
    assert [row["area_nm"] for row in legacy] == [name for name in expected if name != stuck]
    assert result["state"] == "partial"


def test_stalled_write_is_bounded_and_later_targets_still_written(monkeypatch):
    """기존 표 upsert 하나가 멈춰도 그 대상지만 seoul_persistence_timeout 이고 나머지는 쓴다."""
    import time as _time

    monkeypatch.setattr(seoul, "_WRITE_TIMEOUT_SECONDS", 0.1)
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", f"{HONGDAE},연남동,합정역")
    written: list[str] = []

    def upsert(row):
        if row["area_nm"] == "연남동":
            _time.sleep(0.5)  # 스레드 안의 동기 upsert 가 멈춘 상황(취소할 수 없다)
        written.append(row["area_nm"])

    recorder = _wire(monkeypatch)
    monkeypatch.setattr(seoul, "_upsert_row", upsert)
    result = asyncio.run(seoul.collect_seoul_citydata(now=_at_bucket(6)))

    states = {t["area_nm"]: (t["state"], t["error_code"]) for t in result["targets"]}
    assert states == {
        HONGDAE: ("stored", None),
        "연남동": ("failed", "seoul_persistence_timeout"),
        "합정역": ("stored", None),
    }
    assert [row["zone_id"] for row in recorder.zone] == ["seoul:POI007", "seoul:POI053"]


def test_run_deadline_skips_writes_when_no_time_is_left(monkeypatch):
    monkeypatch.setattr(seoul, "_RUN_DEADLINE_SECONDS", 0.0)
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", HONGDAE)
    recorder = _wire(monkeypatch)
    result = asyncio.run(seoul.collect_seoul_citydata(now=_at_bucket(6)))
    assert recorder.legacy == [] and recorder.zone == []
    assert result["targets"][0]["error_code"] == "seoul_persistence_timeout"
    assert result["zone_snapshots"]["state"] == "skipped"


def test_bucket_with_nobody_due_calls_nothing(monkeypatch):
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", f"{HONGDAE}@2+1")
    recorder = _wire(monkeypatch)
    result = asyncio.run(seoul.collect_seoul_citydata(now=_at_bucket(4)))
    assert recorder.fetched == []
    assert result["state"] == "ok"
    assert (result["stored_count"], result["failed_count"]) == (0, 0)
    assert result["zone_snapshots"]["state"] == "skipped"


def test_plain_names_still_mean_every_bucket(monkeypatch):
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", f"{HONGDAE},연남동")
    recorder = _wire(monkeypatch)
    for n in (6, 7, 8):
        asyncio.run(seoul.collect_seoul_citydata(now=_at_bucket(n)))
    assert recorder.fetched == [HONGDAE, "연남동"] * 3


# ── 이중 저장 ─────────────────────────────────────────────────────────────────


def test_dual_write_stores_normalised_rows_next_to_the_legacy_rows(monkeypatch):
    recorder = _wire(monkeypatch)
    result = asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))

    assert len(recorder.legacy) == len(recorder.zone) == 7
    assert [row["zone_id"] for row in recorder.zone] == [
        "seoul:POI007", "seoul:POI073", "seoul:POI053",
        "seoul:POI008", "seoul:POI066", "seoul:POI078", "seoul:POI012",
    ]
    assert {row["bucket_at"] for row in recorder.zone} == {"2026-09-20T05:40:00+00:00"}
    assert result["zone_snapshots"] == {"state": "stored", "stored_count": 7, "errors": {}}
    assert seoul.get_collection_status()["zone_snapshots"]["state"] == "stored"
    # 기존 행 모양은 그대로다(정규화 필드가 새지 않는다).
    assert "zone_id" not in recorder.legacy[0] and "replace_yn" not in recorder.legacy[0]


def test_missing_zone_table_does_not_change_the_collection(monkeypatch):
    def missing(_row):
        raise Exception("Could not find the table 'public.zone_crowd_snapshots' in the schema cache")

    recorder = _wire(monkeypatch, zone_upsert=missing)
    result = asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))

    assert result["state"] == "ok"
    assert result["stored_count"] == 7
    assert len(recorder.legacy) == 7
    assert result["zone_snapshots"]["state"] == "migration_not_applied"
    assert seoul.get_collection_status()["zone_snapshots"]["state"] == "migration_not_applied"


def test_dual_write_crash_never_breaks_the_collect_result(monkeypatch):
    """persist_observations 가 (계약을 어기고) 터져도 수집 결과·_status 는 정상으로 남는다."""
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", HONGDAE)
    recorder = _wire(monkeypatch)

    async def boom(*_args, **_kwargs):
        raise RuntimeError("unexpected")

    monkeypatch.setattr(crowd_store, "persist_observations", boom)
    result = asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))
    assert result["state"] == "ok" and result["stored_count"] == 1
    assert len(recorder.legacy) == 1
    assert result["zone_snapshots"]["state"] == "failed"
    status = seoul.get_collection_status()
    assert status["state"] == "ok" and status["last_success_at"] is not None
    assert status["zone_snapshots"]["state"] == "failed"


def test_failed_legacy_write_is_not_dual_written(monkeypatch):
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", HONGDAE)
    recorder = _wire(monkeypatch)

    def broken(_row):
        raise RuntimeError("check constraint")

    monkeypatch.setattr(seoul, "_upsert_row", broken)
    result = asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))
    assert result["state"] == "failed"
    assert recorder.zone == []
    assert result["zone_snapshots"]["state"] == "skipped"


def test_normalisation_bug_does_not_break_the_legacy_result(monkeypatch):
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", HONGDAE)
    recorder = _wire(monkeypatch)

    def boom(*_args, **_kwargs):
        raise KeyError("boom")

    monkeypatch.setattr(seoul.crowd_seoul, "observation_from_parsed", boom)
    result = asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))
    assert result["state"] == "ok" and result["stored_count"] == 1
    assert len(recorder.legacy) == 1 and recorder.zone == []


def test_collect_response_model_ignores_the_extra_status_fields(monkeypatch):
    """OpenAPI 계약을 바꾸지 않는다 — 새 필드는 상태(last_run)·로그에만 싣는다."""
    from app.routers.engine_validation import SeoulCollectResponse

    _wire(monkeypatch)
    result = asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))
    dumped = SeoulCollectResponse(**result).model_dump()
    assert "zone_snapshots" not in dumped and "skipped_targets" not in dumped
    assert FAKE_KEY not in json.dumps(result, ensure_ascii=False)
