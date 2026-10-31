"""서울 수집기 — 대상지별 주기(S2)와 정규화 이중 저장(S1).

지키는 것:
  · 버킷은 그대로 UTC 10분이고, 주기는 '그 버킷에 누구를 부르나' 만 바꾼다.
  · 기본 9곳의 하루 호출 산수(주 600 · 보충 최악 +168)와 버킷당 최대 6곳(pg_cron 90초).
  · 보충 호출(같은 버킷 :09·:39)도 차례인 대상지만 다시 부른다.
  · 이중 저장은 기존 저장·응답을 바꾸지 않고, 표가 없어도 수집을 멈추지 않는다.
"""

from __future__ import annotations

import asyncio
import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.core.config import settings
from app.services import seoul_citydata_service as seoul
from app.services.crowd import store as crowd_store

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
KST = timezone(timedelta(hours=9))
FAKE_KEY = "SEOULKEY0123456789abcdef"
HONGDAE = "홍대 관광특구"
DEFAULT_TARGETS = type(settings).model_fields["SEOUL_CITYDATA_TARGETS"].default
# 2026-09-20 05:40 UTC 버킷 — 번호 n 은 짝수이고 n % 3 == 1 이다(아래 테스트가 확인).
HONGDAE_FETCHED_AT = datetime(2026, 9, 20, 14, 41, 30, tzinfo=KST).astimezone(timezone.utc)


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
    yield
    seoul.reset_state()


class _Recorder:
    def __init__(self):
        self.legacy: list[dict] = []
        self.zone: list[dict] = []
        self.fetched: list[str] = []


def _wire(monkeypatch, *, zone_upsert=None) -> _Recorder:
    recorder = _Recorder()

    async def fetch(_client, key, area_nm):
        assert key == FAKE_KEY
        recorder.fetched.append(area_nm)
        return copy.deepcopy(_payload_for(area_nm))

    monkeypatch.setattr(seoul, "fetch_citydata", fetch)
    monkeypatch.setattr(seoul, "_upsert_row", recorder.legacy.append)
    monkeypatch.setattr(crowd_store, "_upsert_row", zone_upsert or recorder.zone.append)
    return recorder


def _at_bucket(index: int, minute_offset: int = 4) -> datetime:
    return datetime(1970, 1, 1, tzinfo=timezone.utc) + seoul.BUCKET * index + timedelta(minutes=minute_offset)


# ── 설정 표기 ─────────────────────────────────────────────────────────────────


def test_cadence_suffix_is_stripped_from_names_and_parsed(monkeypatch):
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", " 홍대 관광특구 @ 2 , 연남동@3+2,합정역,홍대  관광특구@5")
    assert seoul.configured_targets() == [HONGDAE, "연남동", "합정역"]
    assert seoul.configured_schedule() == [
        seoul.TargetSchedule(HONGDAE, 2, 0),
        seoul.TargetSchedule("연남동", 3, 2),
        seoul.TargetSchedule("합정역", 1, 0),
    ]


@pytest.mark.parametrize("spec", ["홍대 관광특구@0", "홍대 관광특구@2+2", "홍대 관광특구@x", "홍대 관광특구@145", "홍대 관광특구@"])
def test_bad_cadence_stops_collection_instead_of_guessing(monkeypatch, spec):
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", spec)
    # 상태 화면용 이름 목록은 그대로 읽힌다.
    assert seoul.configured_targets() == [HONGDAE]
    with pytest.raises(seoul.SeoulCitydataError) as info:
        asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))
    assert info.value.code == "seoul_targets_invalid"
    assert seoul.get_collection_status()["error_code"] == "seoul_targets_invalid"


# ── 기본 9곳의 호출 산수 ───────────────────────────────────────────────────────


def test_default_schedule_call_arithmetic():
    schedule = seoul.configured_schedule()
    assert len(schedule) == 9
    assert seoul.daily_call_budget(schedule) == 600

    per_bucket = [len(seoul.due_targets(schedule, _at_bucket(n))[0]) for n in range(144)]
    assert sum(per_bucket) == 600
    assert max(per_bucket) <= 6, "pg_cron 요청 제한(90초) 안 — 한 버킷에 10초×6 까지"
    assert min(per_bucket) >= 1

    # 보충 호출은 :09·:39 — 그 시각이 속한 버킷(:00·:30)의 차례만 다시 부른다.
    retry_buckets = [n for n in range(144) if _at_bucket(n, minute_offset=0).minute in (0, 30)]
    assert len(retry_buckets) == 48
    worst_retry = sum(per_bucket[n] for n in retry_buckets)
    assert worst_retry == 168
    assert 600 + worst_retry == 768 < 1000


def test_each_cluster_is_measured_in_the_same_bucket():
    schedule = seoul.configured_schedule()
    clusters = {
        "jongno": {"경복궁", "북촌한옥마을", "인사동", "창덕궁·종묘"},
        "hongdae": {HONGDAE, "연남동", "합정역"},
        "validation": {"명동 관광특구", "동대문 관광특구"},
    }
    for n in range(144):
        due = set(seoul.due_targets(schedule, _at_bucket(n))[0])
        for members in clusters.values():
            assert due & members in (set(), members), "권역은 함께 재거나 함께 쉰다"


def test_validation_sites_keep_thirty_minute_pairs():
    """주차 추정의 30분 전망 지표는 t 와 t+30 을 짝짓는다 — 검증 지점은 그 짝이 늘 있어야 한다."""
    schedule = seoul.configured_schedule()
    for n in range(144):
        due = seoul.due_targets(schedule, _at_bucket(n))[0]
        if "명동 관광특구" in due:
            assert "명동 관광특구" in seoul.due_targets(schedule, _at_bucket(n + 3))[0]


def test_bucket_index_matches_bucket_start():
    assert seoul.bucket_index(_at_bucket(5, minute_offset=9)) == 5
    assert seoul.bucket_start(_at_bucket(5, minute_offset=9)) == _at_bucket(5, minute_offset=0)


# ── 수집: 차례인 대상지만 ──────────────────────────────────────────────────────


def test_collect_calls_only_due_targets_and_reports_the_rest(monkeypatch):
    recorder = _wire(monkeypatch)
    index = seoul.bucket_index(HONGDAE_FETCHED_AT)
    assert index % 2 == 0 and index % 3 == 1

    result = asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))

    # 짝수 버킷 = 홍대 권역, n % 3 == 1 = 검증 지점. 종로는 쉰다.
    assert recorder.fetched == [HONGDAE, "연남동", "합정역", "명동 관광특구", "동대문 관광특구"]
    assert result["state"] == "ok"
    assert result["stored_count"] == 5
    assert result["skipped_targets"] == ["경복궁", "북촌한옥마을", "인사동", "창덕궁·종묘"]
    assert {row["bucket_at"] for row in recorder.legacy} == {"2026-09-20T05:40:00+00:00"}
    status = seoul.get_collection_status()
    assert status["skipped_targets"] == result["skipped_targets"]


def test_retry_in_the_same_bucket_respects_the_cadence(monkeypatch):
    """pg_cron 보충 호출(같은 버킷 5분 뒤)은 주 호출과 같은 대상지만 다시 부른다."""
    recorder = _wire(monkeypatch)
    primary = _at_bucket(3, minute_offset=4)
    asyncio.run(seoul.collect_seoul_citydata(now=primary))
    first = list(recorder.fetched)
    recorder.fetched.clear()
    asyncio.run(seoul.collect_seoul_citydata(now=primary + timedelta(minutes=5)))
    assert recorder.fetched == first == ["경복궁", "북촌한옥마을", "인사동", "창덕궁·종묘"]


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

    assert len(recorder.legacy) == len(recorder.zone) == 5
    assert [row["zone_id"] for row in recorder.zone] == [
        "seoul:POI007", "seoul:POI073", "seoul:POI053", "seoul:POI003", "seoul:POI002",
    ]
    assert {row["bucket_at"] for row in recorder.zone} == {"2026-09-20T05:40:00+00:00"}
    assert result["zone_snapshots"] == {"state": "stored", "stored_count": 5, "errors": {}}
    assert seoul.get_collection_status()["zone_snapshots"]["state"] == "stored"
    # 기존 행 모양은 그대로다(정규화 필드가 새지 않는다).
    assert "zone_id" not in recorder.legacy[0] and "replace_yn" not in recorder.legacy[0]


def test_missing_zone_table_does_not_change_the_collection(monkeypatch):
    def missing(_row):
        raise Exception("Could not find the table 'public.zone_crowd_snapshots' in the schema cache")

    recorder = _wire(monkeypatch, zone_upsert=missing)
    result = asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))

    assert result["state"] == "ok"
    assert result["stored_count"] == 5
    assert len(recorder.legacy) == 5
    assert result["zone_snapshots"]["state"] == "migration_not_applied"
    assert seoul.get_collection_status()["zone_snapshots"]["state"] == "migration_not_applied"


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
