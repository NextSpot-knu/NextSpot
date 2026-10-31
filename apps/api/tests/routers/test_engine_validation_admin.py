"""관리자 엔진 검증 조회 API — 상태 판정·권한·PostgREST 1000행 캡을 잠근다.

페이크는 **1000행 캡을 실제로 강제한다**(test_admin_row_cap.py 와 같은 이유) — 14일 창은 2,016행이라
`fetch_all_rows` 대신 단일 select 로 되돌리면 지표가 앞쪽 1000행으로 쪼그라드는데, 관대한 페이크로는
그 회귀를 잡을 수 없다.
"""

from datetime import datetime, timedelta, timezone

from fastapi import FastAPI
from fastapi.testclient import TestClient

import pytest

from app.core.config import settings
from app.routers import engine_validation_admin as router_module
from app.services import seoul_citydata_service as seoul
from tests.conftest import admin_headers

NOW = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)
_ROW_CAP = 1000


class _Response:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, table: "_Table"):
        self._table = table
        self._gte: tuple[str, str] | None = None
        self._eq: tuple[str, str] | None = None
        self._orders: list[tuple[str, bool]] = []
        self._range: tuple[int, int] | None = None
        self._limit: int | None = None

    def select(self, columns: str):
        self._table.selects.append(columns)
        return self

    def gte(self, column, value):
        self._gte = (column, value)
        return self

    def eq(self, column, value):
        self._eq = (column, value)
        return self

    def order(self, column, desc=False):
        self._orders.append((column, desc))
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def limit(self, size):
        self._limit = size
        return self

    def execute(self):
        if self._table.error is not None:
            raise self._table.error
        rows = list(self._table.rows)
        if self._eq:
            column, value = self._eq
            rows = [row for row in rows if row[column] == value]
        if self._gte:
            column, value = self._gte
            rows = [row for row in rows if row[column] >= value]
        for column, desc in reversed(self._orders):
            rows.sort(key=lambda row: row[column], reverse=desc)
        if self._range:
            rows = rows[self._range[0] : self._range[1] + 1]
        if self._limit is not None:
            rows = rows[: self._limit]
        return _Response(rows[:_ROW_CAP])


class _Table:
    def __init__(self, rows=None, error: Exception | None = None):
        self.rows = rows or []
        self.error = error
        self.selects: list[str] = []


_ZONE_MISSING = Exception(
    "{'code': 'PGRST205', 'message': \"Could not find the table 'public.zone_crowd_snapshots' in the schema cache\"}"
)


class _Client:
    """원본 표(seoul_citydata_snapshots)와 정규화 표(zone_crowd_snapshots). 정규화 표를 안 주면 '미적용' 이다."""

    def __init__(self, table: _Table, zone_table: _Table | None = None):
        self._table = table
        self._zone_table = zone_table if zone_table is not None else _Table(error=_ZONE_MISSING)

    def table(self, name):
        if name == "zone_crowd_snapshots":
            return _Query(self._zone_table)
        assert name == "seoul_citydata_snapshots"
        return _Query(self._table)


def _row(i: int, *, start: datetime, lvl="보통", est=0.4) -> dict:
    bucket = start + timedelta(minutes=10 * i)
    return {
        "id": f"id-{i:05d}",
        "area_cd": "POI014",
        "area_nm": "홍대 관광특구",
        # PostgREST 가 돌려주는 형태(ISO 문자열) — gte 비교도 문자열로 한다.
        "bucket_at": bucket.isoformat(),
        "observed_at": (bucket - timedelta(minutes=4)).isoformat(),
        "fetched_at": bucket.isoformat(),
        "congest_lvl": lvl,
        "ppltn_min": 20000 + (i % 30) * 500,
        "ppltn_max": 22000 + (i % 30) * 500,
        "fcst": [],
        "live_lot_count": 2,
        "parking_level": est,
        "tourism_level": None,
        "level_est": est,
        "estimator_version": "v1",
    }


def _install(monkeypatch, table: _Table, zone_table: _Table | None = None):
    monkeypatch.setattr(router_module, "supabase_admin", _Client(table, zone_table))


# 대상지·주기는 설정값이고 바뀐다(S2 이후에도 조정 중). 테스트는 기본값에 기대지 않고 이 표기를 고정한다:
# 홍대 권역 10분(매 버킷) · 종로 4곳 30분(:10/:40) · 명동·동대문 30분(:20/:50).
PINNED_TARGETS = (
    "홍대 관광특구,연남동,합정역,"
    "경복궁@3+1,북촌한옥마을@3+1,인사동@3+1,창덕궁·종묘@3+1,"
    "명동 관광특구@3+2,동대문 관광특구@3+2"
)
MYEONGDONG_OFFSET = 2


@pytest.fixture(autouse=True)
def _fresh_collector_state(monkeypatch):
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", PINNED_TARGETS)
    # 수집기 상태는 프로세스 메모리다 — 다른 테스트가 남긴 마지막 실행이 이 화면에 새지 않게.
    seoul.reset_state()
    yield
    seoul.reset_state()


def _client():
    app = FastAPI()
    app.include_router(router_module.router)
    return TestClient(app)


def test_requires_admin():
    assert _client().get("/api/v1/admin/engine-validation/seoul/summary").status_code == 401


def test_days_is_bounded():
    response = _client().get("/api/v1/admin/engine-validation/seoul/summary?days=29", headers=admin_headers())
    assert response.status_code == 422


def test_missing_table_is_not_migrated_state_not_500(monkeypatch):
    _install(monkeypatch, _Table(error=Exception("{'code': 'PGRST205', 'message': \"Could not find the table 'public.seoul_citydata_snapshots' in the schema cache\"}")))
    response = _client().get("/api/v1/admin/engine-validation/seoul/summary", headers=admin_headers())
    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "not_migrated"
    assert body["migration"] == "20260920120000_seoul_citydata_snapshots.sql"
    assert body["places"] == [] and body["collection"] is None


def test_missing_column_is_not_mistaken_for_missing_table(monkeypatch):
    _install(monkeypatch, _Table(error=Exception("{'code': '42703', 'message': 'column seoul_citydata_snapshots.level_est does not exist'}")))
    response = _client().get("/api/v1/admin/engine-validation/seoul/summary", headers=admin_headers())
    assert response.status_code == 503
    assert response.json() == {"detail": "engine_validation_unavailable"}


def test_empty_state(monkeypatch):
    _install(monkeypatch, _Table(rows=[]))
    body = router_module.build_summary(14, now=NOW)
    assert body["state"] == "empty"
    assert body["collection"]["row_count"] == 0 and body["collection"]["latest_bucket_at"] is None


def test_rows_only_outside_window_is_stalled(monkeypatch):
    old = [_row(i, start=NOW - timedelta(days=20)) for i in range(5)]
    _install(monkeypatch, _Table(rows=old))
    body = router_module.build_summary(14, now=NOW)
    assert body["state"] == "stalled"
    assert body["collection"]["stale"] is True
    assert body["collection"]["latest_bucket_at"].startswith("2026-09-15")


def test_few_rows_is_collecting_with_insufficient_metrics(monkeypatch):
    rows = [_row(i, start=NOW - timedelta(hours=2)) for i in range(12)]
    _install(monkeypatch, _Table(rows=rows))
    body = router_module.build_summary(14, now=NOW)
    assert body["state"] == "collecting"
    place = body["places"][0]
    assert place["area_nm"] == "홍대 관광특구" and place["sufficient"] is False
    exact = next(metric for metric in place["metrics"] if metric["key"] == "grade_exact")
    assert exact["status"] == "insufficient" and exact["n"] == 12
    assert body["collection"]["stale"] is False


def test_full_window_pages_past_postgrest_cap(monkeypatch):
    # 14일 × 144 = 2,016행. 한 번의 select 로는 1000행만 온다.
    start = NOW - timedelta(days=14) + timedelta(minutes=10)
    rows = [_row(i, start=start) for i in range(14 * 144 - 1)]
    table = _Table(rows=rows)
    _install(monkeypatch, table)
    body = router_module.build_summary(14, now=NOW)
    assert body["state"] == "ready"
    assert body["collection"]["row_count"] == len(rows)
    place = body["places"][0]
    assert place["bucket_count"] == len(rows)
    assert len(place["series"]) == len(rows)
    assert place["days_covered"] >= 14
    # 주차장 원문(prk)은 조회하지 않는다 — 행마다 커서 응답을 부풀린다.
    assert all("prk" not in columns.split(",") for columns in table.selects)


def test_endpoint_returns_contract(monkeypatch):
    rows = [_row(i, start=datetime.now(timezone.utc) - timedelta(hours=10)) for i in range(50)]
    _install(monkeypatch, _Table(rows=rows))
    response = _client().get("/api/v1/admin/engine-validation/seoul/summary?days=7", headers=admin_headers())
    assert response.status_code == 200
    body = response.json()
    assert set(body) >= {
        "state", "window_days", "window_start", "generated_at", "grade_labels", "estimate_grade_edges",
        "min_samples", "min_danger_samples", "omitted_metrics", "collection", "places",
    }
    assert body["window_days"] == 7
    assert body["state"] == "ready"
    place = body["places"][0]
    assert {metric["key"] for metric in place["metrics"]} == {
        "grade_exact", "grade_within_one", "spearman", "danger_misclassification",
        "forecast_mae_30m", "seoul_forecast_mae_30m", "coverage",
    }
    assert body["omitted_metrics"][0]["key"] == "distinguishability"


def test_unexpected_failure_is_503(monkeypatch):
    _install(monkeypatch, _Table(error=RuntimeError("connection reset")))
    response = _client().get("/api/v1/admin/engine-validation/seoul/summary", headers=admin_headers())
    assert response.status_code == 503
    assert response.json() == {"detail": "engine_validation_unavailable"}


# ---------------------------------------------------------------------------
# 실시간 데이터 리허설 — 대상지별 수집 상태(pipeline) · 정규화 표 · 결정 품질
# ---------------------------------------------------------------------------

HONGDAE = "홍대 관광특구"
MYEONGDONG = "명동 관광특구"
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_BUCKET = timedelta(minutes=10)
_SEOUL_MISSING = Exception(
    "{'code': 'PGRST205', 'message': \"Could not find the table 'public.seoul_citydata_snapshots' in the schema cache\"}"
)


def _bucket_index(moment: datetime) -> int:
    return int((moment - _EPOCH) // _BUCKET)


def _site_row(area_nm: str, bucket: datetime) -> dict:
    row = _row(0, start=bucket)
    row.update({"id": f"{area_nm}-{bucket.isoformat()}", "area_nm": area_nm, "area_cd": None})
    return row


def _due_buckets(*, every: int, offset: int, since: datetime, until: datetime) -> list[datetime]:
    """(since, until] 안에서 n % every == offset 인 버킷 시작 시각."""
    first = _bucket_index(since) + 1
    last = _bucket_index(until)
    return [_EPOCH + _BUCKET * n for n in range(first, last + 1) if n % every == offset]


def _target(body: dict, area_nm: str) -> dict:
    return next(t for t in body["pipeline"]["targets"] if t["area_nm"] == area_nm)


def test_pipeline_lists_every_configured_target_even_without_rows(monkeypatch):
    # 9곳. 홍대만 행이 있어도 9곳 모두 나오고, 행이 없는 곳은 'empty' 지 '가동 중' 이 아니다.
    buckets = _due_buckets(every=1, offset=0, since=NOW - timedelta(hours=3), until=NOW)
    _install(monkeypatch, _Table(rows=[_site_row(HONGDAE, b) for b in buckets]))
    body = router_module.build_summary(14, now=NOW)
    pipeline = body["pipeline"]
    assert pipeline["schedule_state"] == "ok"
    assert [t["area_nm"] for t in pipeline["targets"]] == seoul.configured_targets()
    assert len(pipeline["targets"]) == 9
    hongdae = _target(body, HONGDAE)
    assert hongdae["state"] == "fresh"
    assert hongdae["cadence_minutes"] == 10 and hongdae["stale_after_minutes"] == 30
    assert hongdae["zone_id"] == "seoul:POI007"
    assert _target(body, "경복궁")["cadence_minutes"] == 30
    empty = _target(body, "경복궁")
    assert empty["state"] == "empty" and empty["latest_bucket_at"] is None
    assert empty["window"]["collected_buckets"] == 0 and empty["window"]["fill_rate"] == 0.0
    assert {t["state"] for t in pipeline["targets"]} <= {"fresh", "empty"}


@pytest.mark.parametrize(("age_minutes", "expected"), [(34, "fresh"), (64, "fresh"), (66, "stale")])
def test_thirty_minute_target_is_not_stale_between_its_own_collections(monkeypatch, age_minutes, expected):
    # 명동은 30분 주기(@3+2) — 차례 직전 나이는 약 34분이다. 예전 30분 고정 기준이면 매 주기 '멈춤' 이었다.
    _install(monkeypatch, _Table(rows=[_site_row(MYEONGDONG, NOW - timedelta(minutes=age_minutes))]))
    myeongdong = _target(router_module.build_summary(14, now=NOW), MYEONGDONG)
    assert myeongdong["cadence_minutes"] == 30
    assert myeongdong["stale_after_minutes"] == 65
    assert myeongdong["state"] == expected


@pytest.mark.parametrize(("age_minutes", "expected"), [(29, "fresh"), (31, "stale")])
def test_ten_minute_target_keeps_the_thirty_minute_rule(monkeypatch, age_minutes, expected):
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", HONGDAE)
    _install(monkeypatch, _Table(rows=[_site_row(HONGDAE, NOW - timedelta(minutes=age_minutes))]))
    body = router_module.build_summary(14, now=NOW)
    hongdae = _target(body, HONGDAE)
    assert hongdae["cadence_minutes"] == 10 and hongdae["stale_after_minutes"] == 30
    assert hongdae["state"] == expected
    assert body["collection"]["stale_after_minutes"] == 30
    assert body["collection"]["stale"] is (expected == "stale")


@pytest.mark.parametrize(("age_minutes", "expected"), [(44, "fresh"), (46, "stale")])
def test_twenty_minute_target_allows_one_missed_collection(monkeypatch, age_minutes, expected):
    # 20분 주기(@2) — max(30, 2×20+5) = 45분.
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", "홍대 관광특구@2")
    _install(monkeypatch, _Table(rows=[_site_row(HONGDAE, NOW - timedelta(minutes=age_minutes))]))
    hongdae = _target(router_module.build_summary(14, now=NOW), HONGDAE)
    assert hongdae["stale_after_minutes"] == 45 and hongdae["state"] == expected


def test_whole_collector_staleness_uses_the_fastest_cadence(monkeypatch):
    # 가장 잦은 주기가 30분이면 65분 기준. 40분 전 행은 수집기 전체 '멈춤' 이 아니다(예전 30분 고정이면 멈춤).
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", "명동 관광특구@3+2,동대문 관광특구@3+2")
    _install(monkeypatch, _Table(rows=[_site_row(HONGDAE, NOW - timedelta(minutes=40))]))
    collection = router_module.build_summary(14, now=NOW)["collection"]
    assert collection["stale_after_minutes"] == 65 and collection["stale"] is False


def test_target_with_rows_only_outside_window_is_stale_not_empty(monkeypatch):
    _install(monkeypatch, _Table(rows=[_site_row(MYEONGDONG, NOW - timedelta(days=20))]))
    myeongdong = _target(router_module.build_summary(7, now=NOW), MYEONGDONG)
    assert myeongdong["state"] == "stale"
    assert myeongdong["latest_bucket_at"].startswith("2026-09-15")
    assert myeongdong["window"]["collected_buckets"] == 0


def test_fill_rate_denominator_is_due_buckets_not_144(monkeypatch):
    # 명동 30분 주기 — 하루 48번이 분모다. 차례 버킷을 전부 채우면 100%(144 를 분모로 쓰면 33% 로 보였다).
    due = _due_buckets(every=3, offset=MYEONGDONG_OFFSET, since=NOW - timedelta(days=1), until=NOW - timedelta(minutes=5))
    _install(monkeypatch, _Table(rows=[_site_row(MYEONGDONG, b) for b in due]))
    last_day = _target(router_module.build_summary(1, now=NOW), MYEONGDONG)["last_24h"]
    assert last_day["expected_buckets"] == len(due) == 48
    assert last_day["collected_buckets"] == 48
    assert last_day["fill_rate"] == 1.0


def test_off_schedule_rows_are_counted_apart_and_never_push_fill_over_100(monkeypatch):
    # 예전 설정(10분마다) 때의 행이 창에 남아 있다 — 차례가 아닌 버킷은 분자에 넣지 않고 따로 센다.
    start = NOW - timedelta(hours=6)
    every_bucket = [
        _EPOCH + _BUCKET * n
        for n in range(_bucket_index(start) + 1, _bucket_index(NOW - timedelta(minutes=5)) + 1)
    ]
    _install(monkeypatch, _Table(rows=[_site_row(MYEONGDONG, b) for b in every_bucket]))
    last_day = _target(router_module.build_summary(1, now=NOW), MYEONGDONG)["last_24h"]
    due = [b for b in every_bucket if _bucket_index(b) % 3 == MYEONGDONG_OFFSET]
    assert last_day["collected_buckets"] == len(due)
    assert last_day["off_schedule_buckets"] == len(every_bucket) - len(due)
    # 하루 중 앞 18시간은 비어 있다 — 그 사실이 채움률에 그대로 남고, 100% 를 넘지도 않는다.
    assert last_day["fill_rate"] < 0.3


def test_current_bucket_before_its_collection_time_is_not_expected(monkeypatch):
    # 10분 대상지, 지금은 버킷 시작 2분 뒤 — 이 버킷은 아직 수집 전(:x4)이라 분모에 없다.
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", HONGDAE)
    now = NOW + timedelta(minutes=2)
    buckets = [_EPOCH + _BUCKET * n for n in range(_bucket_index(now) - 143, _bucket_index(now))]
    _install(monkeypatch, _Table(rows=[_site_row(HONGDAE, b) for b in buckets]))
    last_day = _target(router_module.build_summary(1, now=now), HONGDAE)["last_24h"]
    assert last_day["expected_buckets"] == 143
    assert last_day["fill_rate"] == 1.0


def test_invalid_cadence_is_invalid_config_never_running(monkeypatch):
    monkeypatch.setattr(settings, "SEOUL_CITYDATA_TARGETS", "홍대 관광특구@0,연남동")
    _install(monkeypatch, _Table(rows=[_site_row(HONGDAE, NOW - timedelta(minutes=3))]))
    pipeline = router_module.build_summary(14, now=NOW)["pipeline"]
    assert pipeline["schedule_state"] == "invalid_config"
    assert pipeline["schedule_error"] == "seoul_targets_invalid"
    assert pipeline["budget"] is None
    assert {t["state"] for t in pipeline["targets"]} == {"invalid_config"}
    assert all(t["window"]["fill_rate"] is None for t in pipeline["targets"])


def test_not_migrated_pipeline_names_the_human_step(monkeypatch):
    _install(monkeypatch, _Table(error=_SEOUL_MISSING))
    body = router_module.build_summary(14, now=NOW)
    assert body["state"] == "not_migrated"
    pipeline = body["pipeline"]
    assert pipeline["table_state"] == "not_migrated"
    assert "20260920120000_seoul_citydata_snapshots.sql" in pipeline["human_step"]
    assert {t["state"] for t in pipeline["targets"]} == {"not_migrated"}


def test_call_budget_counts_primary_and_worst_case_retries(monkeypatch):
    _install(monkeypatch, _Table(rows=[]))
    budget = router_module.build_summary(14, now=NOW)["pipeline"]["budget"]
    # 주 호출 3×144 + 4×48 + 2×48 = 720. 보충(:09·:39 → :00·:30 버킷, n % 3 == 0)은 그 버킷이 차례인
    # 홍대 권역 3곳만 다시 부른다: 3 × 48 = 144. 최악 864(한도 1,000).
    assert budget["primary_per_day"] == 720
    assert budget["retry_worst_case_per_day"] == 144
    assert budget["worst_case_per_day"] == 864
    assert budget["limit_per_day"] == 1000 and budget["within_limit"] is True


def test_zone_table_missing_is_reported_with_the_human_step(monkeypatch):
    _install(monkeypatch, _Table(rows=[_site_row(HONGDAE, NOW - timedelta(minutes=3))]))
    body = router_module.build_summary(14, now=NOW)
    zones = body["pipeline"]["zones"]
    assert zones["table_state"] == "not_migrated"
    assert "20261031120000_crowd_zones.sql" in zones["human_step"]
    assert "NOTIFY pgrst" in zones["human_step"]
    assert _target(body, HONGDAE)["zone_rows_24h"] is None


def test_zone_last_write_comes_from_the_collector_status(monkeypatch):
    seoul._status["zone_snapshots"] = {
        "state": "migration_not_applied", "stored_count": 0, "errors": {"seoul:POI007": "migration_not_applied"},
    }
    seoul._status["last_run_at"] = (NOW - timedelta(minutes=6)).isoformat()
    seoul._status["targets"][HONGDAE] = {
        "state": "failed", "checked_at": "x", "error_code": "seoul_timeout", "upstream_code": None,
    }
    _install(monkeypatch, _Table(rows=[]), zone_table=_Table(rows=[]))
    body = router_module.build_summary(14, now=NOW)
    zones = body["pipeline"]["zones"]
    assert zones["last_write"]["state"] == "migration_not_applied"
    assert zones["human_step"] is not None, "표 확인이 '비어 있음' 이어도 마지막 쓰기가 미적용이면 사람 작업을 말한다"
    assert _target(body, HONGDAE)["last_run"]["error_code"] == "seoul_timeout"
    assert body["pipeline"]["last_run"]["memory_only"] is True


def test_zone_rows_are_counted_per_target(monkeypatch):
    recent = NOW - timedelta(minutes=13)
    zone_rows = [
        {"zone_id": "seoul:POI007", "bucket_at": recent.isoformat()},
        {"zone_id": "seoul:POI007", "bucket_at": (recent - timedelta(minutes=20)).isoformat()},
    ]
    _install(monkeypatch, _Table(rows=[_site_row(HONGDAE, recent)]), zone_table=_Table(rows=zone_rows))
    body = router_module.build_summary(14, now=NOW)
    zones = body["pipeline"]["zones"]
    assert zones["table_state"] == "has_rows" and zones["rows_24h"] == 2 and zones["human_step"] is None
    assert _target(body, HONGDAE)["zone_rows_24h"] == 2
    assert _target(body, "연남동")["zone_rows_24h"] == 0


def test_empty_zone_table_is_empty_not_missing(monkeypatch):
    _install(monkeypatch, _Table(rows=[]), zone_table=_Table(rows=[]))
    zones = router_module.build_summary(14, now=NOW)["pipeline"]["zones"]
    assert zones["table_state"] == "empty" and zones["human_step"] is None


def test_zone_table_failure_does_not_break_the_summary(monkeypatch):
    _install(monkeypatch, _Table(rows=[]), zone_table=_Table(error=RuntimeError("connection reset")))
    body = router_module.build_summary(14, now=NOW)
    assert body["state"] == "empty"
    assert body["pipeline"]["zones"]["table_state"] == "unavailable"


def test_decision_quality_is_explicitly_not_evaluated(monkeypatch):
    # S4 재생 평가 전 — 숫자처럼 보이는 자리를 만들지 않는다.
    _install(monkeypatch, _Table(rows=[_site_row(HONGDAE, NOW - timedelta(minutes=3))]))
    quality = router_module.build_summary(14, now=NOW)["decision_quality"]
    assert quality["state"] == "not_evaluated" and quality["stage"] == "S4"
    assert quality["result"] is None


def test_places_carry_their_cadence_and_bucket_gap(monkeypatch):
    buckets = _due_buckets(every=3, offset=MYEONGDONG_OFFSET, since=NOW - timedelta(days=2), until=NOW)
    _install(monkeypatch, _Table(rows=[_site_row(MYEONGDONG, b) for b in buckets]))
    place = router_module.build_summary(14, now=NOW)["places"][0]
    assert place["cadence_minutes"] == 30
    assert place["median_bucket_gap_minutes"] == 30.0
