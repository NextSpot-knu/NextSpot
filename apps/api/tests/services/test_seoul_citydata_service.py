"""서울 실시간 도시데이터 수집기 — 파서·오류 코드·키 비노출·멱등 버킷·마이그레이션 미적용.

픽스처 두 개:
  · seoul_citydata_gwanghwamun_sample.json — 2026-09-20 공개 샘플키로 받은 **실제 응답**(인구·주차 블록만
    남기고 도로·충전기 등 큰 블록은 잘라냈다). 29곳 중 실시간 대수를 주는 주차장은 1곳.
  · seoul_citydata_hongdae_synthetic.json — 홍대 관광특구 모양의 **합성** 응답(실시간 2곳 + 걸러져야 할 3곳).
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

from app.core.config import settings
from app.services import seoul_citydata_service as seoul
from app.services.congestion_estimator_service import blend_level
from app.services.parking_derived_congestion_service import ParkingLot, cell_demand_level

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
KST = timezone(timedelta(hours=9))
FAKE_KEY = "SEOULKEY0123456789abcdef"
HONGDAE = "홍대 관광특구"
GWANGHWAMUN = "광화문·덕수궁"


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _sample() -> dict:
    return _fixture("seoul_citydata_gwanghwamun_sample.json")


def _hongdae() -> dict:
    return _fixture("seoul_citydata_hongdae_synthetic.json")


# 합성 픽스처의 수집 시각: KST 14:41 — 주차장 A·B(14:3x)는 신선, E(12:00)는 60분 초과.
HONGDAE_FETCHED_AT = datetime(2026, 9, 20, 14, 41, 30, tzinfo=KST).astimezone(timezone.utc)
# 샘플의 세종로 주차장 CUR_PRK_TIME 은 KST 02:59:35.
SAMPLE_FETCHED_AT = datetime(2026, 9, 20, 3, 2, 0, tzinfo=KST).astimezone(timezone.utc)


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    seoul.reset_state()
    monkeypatch.setattr(settings, "SEOUL_OPENDATA_KEY", "")
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", HONGDAE)
    monkeypatch.setattr(settings, "TOURAPI_KEY", "")
    yield
    seoul.reset_state()


# ── 파서: 실제 샘플 ─────────────────────────────────────────────────────────────


def test_real_sample_parses_ground_truth_and_keeps_area_code():
    parsed = seoul.parse_citydata(_sample(), GWANGHWAMUN)

    assert parsed["area_nm"] == GWANGHWAMUN
    assert parsed["area_cd"] == "POI009"
    assert parsed["congest_lvl"] == "여유"
    assert (parsed["ppltn_min"], parsed["ppltn_max"]) == (3000, 3500)
    # PPLTN_TIME 은 시간대 표기 없는 KST 다.
    assert parsed["observed_at"] == datetime(2026, 9, 20, 2, 30, tzinfo=KST)
    assert len(parsed["fcst"]) == 12
    assert set(parsed["fcst"][0]) == {"FCST_TIME", "FCST_CONGEST_LVL", "FCST_PPLTN_MIN", "FCST_PPLTN_MAX"}
    assert len(parsed["prk_rows"]) == 29


def test_real_sample_has_exactly_one_live_lot_and_estimates_from_its_centroid():
    parsed = seoul.parse_citydata(_sample(), GWANGHWAMUN)
    row, stale = seoul.build_snapshot_row(parsed, fetched_at=SAMPLE_FETCHED_AT, tourism_level=None)

    assert row["live_lot_count"] == 1
    assert stale == 0
    assert [lot["PRK_CD"] for lot in row["prk"]] == ["171721"]
    # 프로필 없는 대상지 → 실시간 주차장 중심에서 잰다. 한 곳이면 그 주차장 점유율 그대로.
    assert row["parking_level"] == pytest.approx(round(121 / 1260, 4))
    assert row["tourism_level"] is None
    assert row["level_est"] == row["parking_level"]
    assert row["estimator_version"] == seoul.ESTIMATOR_VERSION
    assert row["bucket_at"] == "2026-09-19T18:00:00+00:00"
    assert row["observed_at"] == "2026-09-20T02:30:00+09:00"


def test_sample_key_answer_for_another_place_is_rejected_not_stored():
    """샘플키는 무엇을 요청해도 광화문을 준다 — 이름을 대조하지 않으면 다른 곳 정답이 섞인다."""
    with pytest.raises(seoul.SeoulCitydataError) as info:
        seoul.parse_citydata(_sample(), HONGDAE)
    assert info.value.code == "seoul_area_mismatch"


# ── 파서: 합성 홍대 ─────────────────────────────────────────────────────────────


def test_hongdae_two_live_lots_uses_hotspot_reference_and_existing_estimator():
    parsed = seoul.parse_citydata(_hongdae(), HONGDAE)
    row, stale = seoul.build_snapshot_row(parsed, fetched_at=HONGDAE_FETCHED_AT, tourism_level=None)

    # C(실시간 없음)·D(대수 > 총면)는 조건에서, E(2시간 전 값)는 신선도에서 빠진다.
    assert row["live_lot_count"] == 2
    assert stale == 1
    assert sorted(lot["PRK_CD"] for lot in row["prk"]) == ["SYN-A", "SYN-B"]
    assert row["area_cd"] == "POI_SYNTHETIC"

    lots = [
        ParkingLot("SYN-A", "A", 37.5560, 126.9230, 200, 50),
        ParkingLot("SYN-B", "B", 37.5510, 126.9200, 100, 60),
    ]
    profile = seoul.target_profile(HONGDAE)
    assert profile is not None
    assert (profile.latitude, profile.longitude) == (37.55391867558625, 126.92127401787192)
    expected = cell_demand_level(lots, profile.latitude, profile.longitude)
    assert expected is not None
    assert row["parking_level"] == expected["level"]
    assert row["level_est"] == blend_level(expected["level"], None)


def test_hongdae_tourism_component_blends_with_the_shared_weights():
    parsed = seoul.parse_citydata(_hongdae(), HONGDAE)
    row, _ = seoul.build_snapshot_row(parsed, fetched_at=HONGDAE_FETCHED_AT, tourism_level=0.5)

    assert row["tourism_level"] == 0.5
    assert row["level_est"] == blend_level(row["parking_level"], 0.5)
    assert row["level_est"] != row["parking_level"]


def test_hongdae_zero_live_lots_stores_ground_truth_without_inventing_an_estimate():
    payload = _hongdae()
    for lot in payload["CITYDATA"]["PRK_STTS"]:
        lot["CUR_PRK_YN"] = "N"
        lot["CUR_PRK_CNT"] = ""
    parsed = seoul.parse_citydata(payload, HONGDAE)
    row, _ = seoul.build_snapshot_row(parsed, fetched_at=HONGDAE_FETCHED_AT, tourism_level=0.8)

    assert row["live_lot_count"] == 0
    assert row["prk"] == []
    assert row["parking_level"] is None
    # 관광 성분만으로는 '지금' 을 만들지 않는다(blend_level 규칙).
    assert row["level_est"] is None
    assert row["tourism_level"] == 0.8
    assert row["congest_lvl"] == "약간 붐빔"
    assert (row["ppltn_min"], row["ppltn_max"]) == (42000, 44000)


def test_inverted_population_range_keeps_grade_but_drops_range():
    payload = _hongdae()
    live = payload["CITYDATA"]["LIVE_PPLTN_STTS"][0]
    live["AREA_PPLTN_MIN"], live["AREA_PPLTN_MAX"] = "50000", "40000"
    parsed = seoul.parse_citydata(payload, HONGDAE)
    assert parsed["congest_lvl"] == "약간 붐빔"
    assert (parsed["ppltn_min"], parsed["ppltn_max"]) == (None, None)


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (lambda p: p["CITYDATA"].pop("LIVE_PPLTN_STTS"), "seoul_no_population"),
        (lambda p: p["CITYDATA"]["LIVE_PPLTN_STTS"][0].update(AREA_CONGEST_LVL="매우 붐빔"), "seoul_no_population"),
        (lambda p: p["CITYDATA"]["LIVE_PPLTN_STTS"][0].update(PPLTN_TIME=""), "seoul_no_population"),
        (lambda p: p.pop("CITYDATA"), "seoul_invalid_response"),
    ],
)
def test_broken_payloads_map_to_codes(mutate, code):
    payload = _hongdae()
    mutate(payload)
    with pytest.raises(seoul.SeoulCitydataError) as info:
        seoul.parse_citydata(payload, HONGDAE)
    assert info.value.code == code


@pytest.mark.parametrize(
    ("upstream", "code"),
    [
        ("INFO-100", "seoul_key_invalid"),
        ("INFO-200", "seoul_no_data"),
        ("ERROR-337", "seoul_quota_exceeded"),
        ("ERROR-336", "seoul_bad_request"),
        ("ERROR-500", "seoul_upstream_error"),
        ("ERROR-999", "seoul_upstream_error"),
    ],
)
def test_upstream_result_codes_are_mapped(upstream, code):
    payload = {"RESULT": {"RESULT.CODE": upstream, "RESULT.MESSAGE": "원문 메시지는 버린다"}}
    with pytest.raises(seoul.SeoulCitydataError) as info:
        seoul.parse_citydata(payload, HONGDAE)
    assert info.value.code == code
    assert info.value.upstream_code == upstream
    assert "원문" not in str(info.value)


def test_bucket_start_floors_to_ten_minutes_utc():
    assert seoul.bucket_start(datetime(2026, 9, 20, 5, 47, 59, tzinfo=timezone.utc)) == datetime(
        2026, 9, 20, 5, 40, tzinfo=timezone.utc
    )
    assert seoul.bucket_start(datetime(2026, 9, 20, 5, 40, tzinfo=timezone.utc)) == datetime(
        2026, 9, 20, 5, 40, tzinfo=timezone.utc
    )
    # KST 입력도 UTC 경계로 내린다.
    assert seoul.bucket_start(datetime(2026, 9, 20, 14, 49, 59, tzinfo=KST)) == datetime(
        2026, 9, 20, 5, 40, tzinfo=timezone.utc
    )


def test_congest_levels_match_the_migration_check():
    root = Path(__file__).resolve().parents[4]
    sql = (root / "supabase/migrations/20260920120000_seoul_citydata_snapshots.sql").read_text(encoding="utf-8")
    quoted = ", ".join(f"'{level}'" for level in seoul.CONGEST_LEVELS)
    assert f"congest_lvl IN ({quoted})" in sql


def test_targets_are_a_comma_separated_setting(monkeypatch):
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", " 홍대 관광특구 ,  광화문·덕수궁,,홍대  관광특구")
    assert seoul.configured_targets() == [HONGDAE, GWANGHWAMUN]


# ── HTTP: 오류 코드와 키 비노출 ──────────────────────────────────────────────────


def _run_fetch(handler, area_nm: str = HONGDAE):
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=1.0) as client:
            return await seoul.fetch_citydata(client, FAKE_KEY, area_nm)

    return asyncio.run(run())


def test_request_url_puts_encoded_name_after_key():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.raw_path.decode()
        return httpx.Response(200, json=_hongdae())

    _run_fetch(handler)
    assert seen["path"] == f"/{FAKE_KEY}/json/citydata/1/5/%ED%99%8D%EB%8C%80%20%EA%B4%80%EA%B4%91%ED%8A%B9%EA%B5%AC"


def test_invalid_key_xml_answer_maps_to_key_invalid():
    """2026-09-20 실측: 잘못된 키는 JSON 을 요청해도 HTTP 200 + XML 로 온다."""
    xml = (
        "<RESULT><CODE>INFO-100</CODE><MESSAGE><![CDATA[인증키가 유효하지 않습니다.]]></MESSAGE></RESULT>"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=xml, headers={"Content-Type": "text/xml;charset=UTF-8"})

    with pytest.raises(seoul.SeoulCitydataError) as info:
        _run_fetch(handler)
    assert info.value.code == "seoul_key_invalid"
    assert info.value.upstream_code == "INFO-100"


@pytest.mark.parametrize(
    ("handler", "code"),
    [
        (lambda request: httpx.Response(500, text="oops"), "seoul_http_error"),
        (lambda request: httpx.Response(200, text="<html>maintenance</html>"), "seoul_invalid_response"),
    ],
)
def test_http_failures_map_to_codes(handler, code):
    with pytest.raises(seoul.SeoulCitydataError) as info:
        _run_fetch(handler)
    assert info.value.code == code


@pytest.mark.parametrize(
    ("exc", "code"),
    [
        (httpx.ReadTimeout("timed out"), "seoul_timeout"),
        (httpx.ConnectError("refused"), "seoul_unavailable"),
    ],
)
def test_network_failures_drop_the_url_carrying_cause(exc, code):
    def handler(request: httpx.Request) -> httpx.Response:
        raise type(exc)(f"failed for {request.url}", request=request)

    with pytest.raises(seoul.SeoulCitydataError) as info:
        _run_fetch(handler)
    assert info.value.code == code
    # 원인 예외 문자열에는 키가 든 URL 이 있다 — 체인을 끊어 트레이스백에도 남지 않게 한다.
    assert info.value.__cause__ is None
    assert info.value.__suppress_context__ is True
    assert FAKE_KEY not in str(info.value)


def test_httpx_request_log_never_contains_the_key(caplog):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_hongdae())

    with caplog.at_level(logging.INFO, logger="httpx"):
        _run_fetch(handler)
    httpx_records = [r for r in caplog.records if r.name == "httpx"]
    assert httpx_records, "httpx 가 요청 로그를 남기지 않으면 이 테스트는 아무것도 증명하지 않는다"
    assert FAKE_KEY not in caplog.text
    assert "[redacted]" in caplog.text


# ── 수집: 대상지 격리·멱등·미적용 ────────────────────────────────────────────────


class _FakeTable:
    """(area_nm, bucket_at) 유니크 제약을 흉내 내는 upsert 저장소."""

    def __init__(self):
        self.rows: dict[tuple[str, str], dict] = {}
        self.calls = 0

    def upsert(self, row: dict) -> None:
        self.calls += 1
        self.rows[(row["area_nm"], row["bucket_at"])] = copy.deepcopy(row)


def _enable(monkeypatch, targets: str = HONGDAE) -> _FakeTable:
    monkeypatch.setattr(settings, "SEOUL_OPENDATA_KEY", FAKE_KEY)
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", targets)
    table = _FakeTable()
    monkeypatch.setattr(seoul, "_upsert_row", table.upsert)
    return table


def _fake_fetch(responses: dict):
    calls: list[str] = []

    async def fetch(_client, key, area_nm):
        assert key == FAKE_KEY
        calls.append(area_nm)
        answer = responses[area_nm]
        if isinstance(answer, Exception):
            raise answer
        return copy.deepcopy(answer)

    return fetch, calls


def test_collect_without_key_fails_fast_with_clear_code():
    with pytest.raises(seoul.SeoulCitydataError) as info:
        asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))
    assert info.value.code == "seoul_key_missing"
    status = seoul.get_collection_status()
    assert status["state"] == "failed"
    assert status["error_code"] == "seoul_key_missing"


def test_one_failed_target_does_not_block_the_others(monkeypatch):
    table = _enable(monkeypatch, f"{GWANGHWAMUN},{HONGDAE}")
    fetch, calls = _fake_fetch({
        GWANGHWAMUN: seoul.SeoulCitydataError("seoul_key_invalid", "INFO-100"),
        HONGDAE: _hongdae(),
    })
    monkeypatch.setattr(seoul, "fetch_citydata", fetch)

    result = asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))

    assert calls == [GWANGHWAMUN, HONGDAE]
    assert result["state"] == "partial"
    assert (result["stored_count"], result["failed_count"]) == (1, 1)
    failed, stored = result["targets"]
    assert failed["error_code"] == "seoul_key_invalid" and failed["upstream_code"] == "INFO-100"
    assert stored["state"] == "stored" and stored["area_cd"] == "POI_SYNTHETIC"
    assert list(table.rows) == [(HONGDAE, "2026-09-20T05:40:00+00:00")]

    status = seoul.get_collection_status()
    assert status["state"] == "partial"
    assert status["last_success_at"] is not None
    assert status["targets"][GWANGHWAMUN]["error_code"] == "seoul_key_invalid"
    assert status["targets"][HONGDAE]["area_cd"] == "POI_SYNTHETIC"
    assert FAKE_KEY not in json.dumps(result, ensure_ascii=False)
    assert FAKE_KEY not in json.dumps(status, ensure_ascii=False)


def test_unexpected_bug_in_one_target_is_isolated(monkeypatch):
    _enable(monkeypatch, f"{GWANGHWAMUN},{HONGDAE}")
    fetch, _ = _fake_fetch({GWANGHWAMUN: KeyError("boom"), HONGDAE: _hongdae()})
    monkeypatch.setattr(seoul, "fetch_citydata", fetch)

    result = asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))
    assert [t["state"] for t in result["targets"]] == ["failed", "stored"]
    assert result["targets"][0]["error_code"] == "unexpected_error"


def test_same_bucket_twice_keeps_one_row(monkeypatch):
    table = _enable(monkeypatch)
    fetch, _ = _fake_fetch({HONGDAE: _hongdae()})
    monkeypatch.setattr(seoul, "fetch_citydata", fetch)

    asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))
    asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT + timedelta(minutes=5)))
    assert table.calls == 2
    assert len(table.rows) == 1, "같은 10분 버킷 재호출(보충 cron·수동)은 한 행이어야 한다"

    asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT + timedelta(minutes=10)))
    assert len(table.rows) == 2


def test_missing_table_stops_the_run_with_migration_code(monkeypatch):
    monkeypatch.setattr(settings, "SEOUL_OPENDATA_KEY", FAKE_KEY)
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", f"{HONGDAE},{GWANGHWAMUN}")
    fetch, calls = _fake_fetch({HONGDAE: _hongdae(), GWANGHWAMUN: _sample()})
    monkeypatch.setattr(seoul, "fetch_citydata", fetch)

    class _PostgrestLikeError(Exception):
        code = "PGRST205"
        message = "Could not find the table 'public.seoul_citydata_snapshots' in the schema cache"

    def missing(_row):
        raise _PostgrestLikeError(_PostgrestLikeError.message)

    monkeypatch.setattr(seoul, "_upsert_row", missing)

    with pytest.raises(seoul.SeoulSnapshotPersistenceError) as info:
        asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))
    assert info.value.code == "migration_not_applied"
    # 저장할 곳이 없으면 나머지 대상지로 호출 한도를 쓰지 않는다.
    assert calls == [HONGDAE]
    assert seoul.get_collection_status()["error_code"] == "migration_not_applied"


def test_other_persistence_errors_stay_per_target(monkeypatch):
    _enable(monkeypatch)
    fetch, _ = _fake_fetch({HONGDAE: _hongdae()})
    monkeypatch.setattr(seoul, "fetch_citydata", fetch)

    def broken(_row):
        raise RuntimeError('new row violates check constraint "seoul_citydata_snapshots_ppltn_range"')

    monkeypatch.setattr(seoul, "_upsert_row", broken)
    result = asyncio.run(seoul.collect_seoul_citydata(now=HONGDAE_FETCHED_AT))
    assert result["state"] == "failed"
    assert result["targets"][0]["error_code"] == "seoul_persistence_failed"


@pytest.mark.parametrize(
    ("exc", "expected"),
    [
        (Exception("Could not find the table 'public.seoul_citydata_snapshots' in the schema cache"), True),
        (Exception('relation "public.seoul_citydata_snapshots" does not exist'), True),
        (Exception('column seoul_citydata_snapshots.level_est does not exist'), False),
        (Exception("connection reset"), False),
    ],
)
def test_missing_table_detection(exc, expected):
    assert seoul.is_missing_table(exc) is expected


# ── 관광 성분(선택) ───────────────────────────────────────────────────────────


def test_tourism_level_is_none_without_tourapi_key(monkeypatch):
    async def must_not_call(_signgu):
        raise AssertionError("키가 없으면 부르지 않는다")

    monkeypatch.setattr(seoul, "_load_signgu_concentration", must_not_call)
    assert asyncio.run(seoul.tourism_level_for(HONGDAE, date_kst="2026-09-20")) is None


def test_tourism_level_matches_exact_name_for_today_and_caches(monkeypatch):
    monkeypatch.setattr(settings, "TOURAPI_KEY", "tour-key")
    calls: list[int] = []

    async def rows(signgu):
        calls.append(signgu)
        return [
            {"tourist_attraction_name": "홍대걷고싶은거리", "forecast_date": "2026-09-20", "concentration_rate": 64.0},
            {"tourist_attraction_name": "홍대걷고싶은거리", "forecast_date": "2026-09-21", "concentration_rate": 10.0},
            {"tourist_attraction_name": "홍대앞 어딘가", "forecast_date": "2026-09-20", "concentration_rate": 99.0},
        ]

    monkeypatch.setattr(seoul, "_load_signgu_concentration", rows)
    assert asyncio.run(seoul.tourism_level_for(HONGDAE, date_kst="2026-09-20")) == 0.64
    assert asyncio.run(seoul.tourism_level_for(HONGDAE, date_kst="2026-09-20")) == 0.64
    assert calls == [11440], "집중률은 하루 한 값 — 10분마다 다시 부르지 않는다"


def test_tourism_level_failure_is_harmless(monkeypatch):
    monkeypatch.setattr(settings, "TOURAPI_KEY", "tour-key")

    async def boom(_signgu):
        raise RuntimeError("403 https://apis.data.go.kr/...serviceKey=tour-key")

    monkeypatch.setattr(seoul, "_load_signgu_concentration", boom)
    assert asyncio.run(seoul.tourism_level_for(HONGDAE, date_kst="2026-09-20")) is None


def test_tourism_level_needs_a_profile(monkeypatch):
    monkeypatch.setattr(settings, "TOURAPI_KEY", "tour-key")
    assert asyncio.run(seoul.tourism_level_for(GWANGHWAMUN, date_kst="2026-09-20")) is None


def test_match_tourism_level_is_exact_not_partial():
    rows = [{"tourist_attraction_name": "홍대 관광특구 주변 상가", "forecast_date": "2026-09-20", "concentration_rate": 80}]
    assert seoul.match_tourism_level(rows, ("홍대 관광특구",), "2026-09-20") is None


def test_concentration_forecast_defaults_stay_gyeongju(monkeypatch):
    from app.services.tourapi import insights

    seen: list[dict] = []

    async def capture(_base, _endpoint, params):
        seen.append(params)
        return {}

    monkeypatch.setattr(insights, "_insight_get", capture)
    asyncio.run(insights.concentration_forecast(page=1, rows=10))
    asyncio.run(insights.concentration_forecast(page=1, rows=10, area_code=11, signgu_code=11440))
    assert (seen[0]["areaCd"], seen[0]["signguCd"]) == (47, 47130)
    assert (seen[1]["areaCd"], seen[1]["signguCd"]) == (11, 11440)
