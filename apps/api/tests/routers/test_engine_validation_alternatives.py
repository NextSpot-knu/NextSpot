"""시연 권역 대안 추천 API — 순위·거리·상태·출발지 검증을 잠근다.

페이크는 summary 테스트와 같은 이유로 **1000행 캡을 실제로 강제**하고, 이 엔드포인트가 쓰는
`in_` 필터도 흉내 낸다(필터를 빼면 명동·동대문 행이 권역에 섞여 들어온다 — 그건 걸어갈 수 없는 곳이다).
"""

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import engine_validation_admin as router_module
from app.services import engine_validation_metrics as metrics
from app.services import seoul_alternatives_service as alternatives
from app.services import seoul_citydata_service
from app.services.spot.wait_time import calculate_predicted_wait_time
from tests.conftest import admin_headers

# 21:00 KST — 대기 공식의 시간대 계수가 1.0인 시각이라 기대값을 손으로 확인할 수 있다.
NOW = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)
_ROW_CAP = 1000

PATH = "/api/v1/admin/engine-validation/seoul/alternatives"


class _Response:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, table: "_Table"):
        self._table = table
        self._gte: tuple[str, str] | None = None
        self._in: tuple[str, list] | None = None
        self._orders: list[tuple[str, bool]] = []
        self._range: tuple[int, int] | None = None
        self._limit: int | None = None

    def select(self, columns: str):
        self._table.selects.append(columns)
        return self

    def gte(self, column, value):
        self._gte = (column, value)
        return self

    def in_(self, column, values):
        self._in = (column, list(values))
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
        if self._in:
            column, values = self._in
            rows = [row for row in rows if row[column] in values]
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


class _Client:
    def __init__(self, table: _Table):
        self._table = table

    def table(self, name):
        assert name == "seoul_citydata_snapshots"
        return _Query(self._table)


def _row(area_nm: str, area_cd: str, *, at: datetime, lvl: str, ppltn: int) -> dict:
    return {
        "area_cd": area_cd,
        "area_nm": area_nm,
        "bucket_at": at.isoformat(),
        "observed_at": (at - timedelta(minutes=4)).isoformat(),
        "congest_lvl": lvl,
        "ppltn_min": ppltn - 1000,
        "ppltn_max": ppltn + 1000,
    }


def _cluster_rows(*, at: datetime, hongdae="붐빔", yeonnam="여유", hapjeong="보통") -> list[dict]:
    return [
        _row("홍대 관광특구", "POI007", at=at, lvl=hongdae, ppltn=60000),
        _row("연남동", "POI073", at=at, lvl=yeonnam, ppltn=12000),
        _row("합정역", "POI053", at=at, lvl=hapjeong, ppltn=20000),
    ]


def _install(monkeypatch, table: _Table):
    monkeypatch.setattr(router_module, "supabase_admin", _Client(table))


def _client():
    app = FastAPI()
    app.include_router(router_module.router)
    return TestClient(app)


def _card(body: dict, area_nm: str) -> dict:
    return next(place for place in body["places"] if place["area_nm"] == area_nm)


# --- 권한 · 출발지 -------------------------------------------------------------


def test_requires_admin():
    assert _client().get(PATH).status_code == 401


def test_unknown_origin_is_422_not_silent_default(monkeypatch):
    _install(monkeypatch, _Table(rows=_cluster_rows(at=NOW)))
    response = _client().get(f"{PATH}?origin=경주 황리단길", headers=admin_headers())
    assert response.status_code == 422
    assert response.json() == {"detail": "unknown_origin"}


def test_origin_defaults_to_hongdae():
    assert alternatives.resolve_origin(None) == "홍대 관광특구"
    assert alternatives.resolve_origin("  ") == "홍대 관광특구"
    assert alternatives.DEFAULT_ORIGIN == "홍대 관광특구"


def test_origin_accepts_name_and_area_code():
    assert alternatives.resolve_origin("연남동") == "연남동"
    assert alternatives.resolve_origin("POI053") == "합정역"
    assert alternatives.resolve_origin("poi073") == "연남동"
    assert alternatives.resolve_origin("홍대  관광특구") == "홍대 관광특구"
    assert alternatives.resolve_origin("명동 관광특구") is None  # 걸어갈 수 없는 곳은 권역이 아니다


# --- 상태 ---------------------------------------------------------------------


def test_missing_table_is_not_migrated_not_500(monkeypatch):
    _install(monkeypatch, _Table(error=Exception("{'code': 'PGRST205', 'message': \"Could not find the table 'public.seoul_citydata_snapshots' in the schema cache\"}")))
    response = _client().get(PATH, headers=admin_headers())
    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "not_migrated"
    assert body["places"] == [] and body["recommendation"] is None
    # 표가 없어도 무엇을 기다리는지는 말한다.
    assert [place["area_nm"] for place in body["cluster"]] == ["홍대 관광특구", "연남동", "합정역"]


def test_empty_state_still_renders_three_cards(monkeypatch):
    _install(monkeypatch, _Table(rows=[]))
    body = router_module.build_alternatives("홍대 관광특구", now=NOW)
    assert body["state"] == "empty"
    assert body["latest_bucket_at"] is None
    assert len(body["places"]) == 3
    assert all(place["has_data"] is False and place["congest_lvl"] is None for place in body["places"])
    assert all(place["reason"] for place in body["places"])
    assert body["ranking"] == []
    assert body["recommendation"]["better"] is False
    assert body["recommendation"]["reason"] == "출발지의 실측 등급이 아직 없어 비교할 수 없다."


def test_rows_only_outside_lookback_is_stale(monkeypatch):
    _install(monkeypatch, _Table(rows=_cluster_rows(at=NOW - timedelta(days=30))))
    body = router_module.build_alternatives("홍대 관광특구", now=NOW)
    assert body["state"] == "stale"
    assert body["latest_age_minutes"] == pytest.approx(30 * 24 * 60, rel=1e-6)


def test_old_bucket_inside_lookback_is_stale_not_ready(monkeypatch):
    _install(monkeypatch, _Table(rows=_cluster_rows(at=NOW - timedelta(minutes=45))))
    body = router_module.build_alternatives("홍대 관광특구", now=NOW)
    assert body["state"] == "stale"
    assert body["latest_age_minutes"] == 45.0
    assert all(place["stale"] is True for place in body["places"])
    # 값 자체는 그대로 보여 준다 — 감추지 않고 '지금이 아니다' 라고만 말한다.
    assert _card(body, "홍대 관광특구")["congest_lvl"] == "붐빔"


def test_fresh_bucket_is_ready(monkeypatch):
    _install(monkeypatch, _Table(rows=_cluster_rows(at=NOW - timedelta(minutes=7))))
    body = router_module.build_alternatives("홍대 관광특구", now=NOW)
    assert body["state"] == "ready"
    assert all(place["stale"] is False for place in body["places"])
    assert body["latest_age_minutes"] == 7.0


def test_one_missing_place_does_not_break_the_others(monkeypatch):
    rows = [row for row in _cluster_rows(at=NOW - timedelta(minutes=5)) if row["area_nm"] != "합정역"]
    _install(monkeypatch, _Table(rows=rows))
    body = router_module.build_alternatives("홍대 관광특구", now=NOW)
    assert body["state"] == "ready"
    assert _card(body, "합정역")["has_data"] is False
    assert _card(body, "합정역")["rank"] is None
    assert body["ranking"] == ["연남동"]


# --- 순위 ---------------------------------------------------------------------


def test_less_crowded_wins_even_when_slightly_farther(monkeypatch):
    _install(monkeypatch, _Table(rows=_cluster_rows(at=NOW - timedelta(minutes=5))))
    body = router_module.build_alternatives("홍대 관광특구", now=NOW)
    # 합정역이 직선으로는 더 가깝지만(아래 거리 검증) 보통 > 여유라 연남동이 앞선다.
    assert body["ranking"] == ["연남동", "합정역"]
    assert _card(body, "합정역")["straight_distance_m"] < _card(body, "연남동")["straight_distance_m"]
    recommendation = body["recommendation"]
    assert recommendation["best"] == "연남동" and recommendation["better"] is True
    assert recommendation["origin_congest_lvl"] == "붐빔" and recommendation["best_congest_lvl"] == "여유"
    assert recommendation["grade_gap"] == 3
    # 걷는 시간(≈15분)이 붐빔 대기(13.1분)보다 커서 '비용' 으로는 머무는 편이 싸다 — 숨기지 않는다.
    assert recommendation["beats_origin_cost"] is False
    assert recommendation["origin_cost_minutes"] is not None


def test_ranking_flips_with_the_measured_grades(monkeypatch):
    _install(monkeypatch, _Table(rows=_cluster_rows(at=NOW, yeonnam="붐빔", hapjeong="여유")))
    body = router_module.build_alternatives("홍대 관광특구", now=NOW)
    assert body["ranking"] == ["합정역", "연남동"]
    assert body["recommendation"]["best"] == "합정역"


def test_all_equally_crowded_is_not_a_recommendation(monkeypatch):
    _install(monkeypatch, _Table(rows=_cluster_rows(at=NOW, hongdae="보통", yeonnam="보통", hapjeong="보통")))
    body = router_module.build_alternatives("홍대 관광특구", now=NOW)
    # 순위는 나오지만(거리가 다르다) '덜 붐빈다' 고는 말하지 않는다.
    assert body["ranking"] == ["합정역", "연남동"]
    recommendation = body["recommendation"]
    assert recommendation["better"] is False and recommendation["best"] is None
    assert recommendation["grade_gap"] == 0
    assert recommendation["top_ranked"] == "합정역"
    assert recommendation["reason"] == "지금은 이웃 대상지가 출발지보다 덜 붐비지 않는다 — 옮길 이유가 없다."


def test_nearest_can_win_the_ranking_while_a_farther_place_is_the_recommendation(monkeypatch):
    """순위(비용)와 추천(덜 붐빔)은 다른 질문이다 — 붐벼도 가까우면 비용에서는 앞설 수 있다."""
    _install(monkeypatch, _Table(rows=_cluster_rows(at=NOW, hongdae="붐빔", yeonnam="여유", hapjeong="붐빔")))
    body = router_module.build_alternatives("연남동", now=NOW)
    # 홍대는 붐비지만 합정역보다 2배 가깝다 → 비용 1등.
    assert body["ranking"][0] == "홍대 관광특구"
    recommendation = body["recommendation"]
    assert recommendation["top_ranked"] == "홍대 관광특구"
    # 출발지(연남동)가 여유라 더 덜 붐비는 곳은 없다 → 추천하지 않는다.
    assert recommendation["best"] is None and recommendation["better"] is False


def test_origin_switches_the_whole_comparison(monkeypatch):
    _install(monkeypatch, _Table(rows=_cluster_rows(at=NOW)))
    body = router_module.build_alternatives("연남동", now=NOW)
    assert _card(body, "연남동")["is_origin"] is True
    assert _card(body, "연남동")["walk_minutes"] == 0.0
    assert set(body["ranking"]) == {"홍대 관광특구", "합정역"}
    # 홍대(붐빔)가 합정역(보통)보다 2배 가까워 비용 순위에서는 앞선다.
    assert body["ranking"][0] == "홍대 관광특구"
    assert body["recommendation"]["origin_congest_lvl"] == "여유"
    assert body["recommendation"]["better"] is False  # 여유보다 덜 붐빈 곳은 없다


def test_place_without_grade_is_excluded_from_ranking(monkeypatch):
    _install(monkeypatch, _Table(rows=_cluster_rows(at=NOW, hapjeong="알 수 없음")))
    body = router_module.build_alternatives("홍대 관광특구", now=NOW)
    assert body["ranking"] == ["연남동"]
    assert _card(body, "합정역")["grade"] is None
    assert _card(body, "합정역")["cost_minutes"] is None
    assert "등급" in _card(body, "합정역")["reason"]


def test_tie_breaks_on_normalized_population():
    """비용이 같으면 '그 장소의 평소 대비' 가 낮은 쪽이 앞선다 — 인원수를 직접 비교하지 않는다."""
    cards = [
        {"area_nm": "가", "is_origin": False, "cost_minutes": 20.0, "normalized_population": 0.9, "rank": None},
        {"area_nm": "나", "is_origin": False, "cost_minutes": 20.0, "normalized_population": 0.3, "rank": None},
        {"area_nm": "출발", "is_origin": True, "cost_minutes": 5.0, "normalized_population": 0.1, "rank": None},
    ]
    ranked = alternatives.rank_alternatives(cards)
    assert [card["area_nm"] for card in ranked] == ["나", "가"]
    assert cards[2]["rank"] is None  # 출발지는 자기 자신의 대안이 아니다


# --- 거리 · 걷는 시간 ------------------------------------------------------------


def test_distance_and_walk_time_use_the_repo_constants(monkeypatch):
    _install(monkeypatch, _Table(rows=_cluster_rows(at=NOW)))
    body = router_module.build_alternatives("홍대 관광특구", now=NOW)
    yeonnam = _card(body, "연남동")
    # 홍대 ↔ 연남동은 걸어서 오갈 수 있는 거리다(직선 700~1000m).
    assert 700 < yeonnam["straight_distance_m"] < 1000
    assert yeonnam["walk_distance_m"] == pytest.approx(
        yeonnam["straight_distance_m"] * 1.18, rel=1e-3
    )
    assert yeonnam["walk_minutes"] == pytest.approx(yeonnam["walk_distance_m"] / 66.67, abs=0.1)
    assert 10 < yeonnam["walk_minutes"] < 20
    assert body["walking"]["speed_m_per_min"] == 66.67 and body["walking"]["route_factor"] == 1.18


def test_cost_is_walk_plus_the_repo_wait_formula(monkeypatch):
    _install(monkeypatch, _Table(rows=_cluster_rows(at=NOW)))
    body = router_module.build_alternatives("홍대 관광특구", now=NOW)
    yeonnam = _card(body, "연남동")
    expected_wait = asyncio.run(
        calculate_predicted_wait_time("attraction", yeonnam["level"], None, hour=NOW.astimezone(alternatives._KST).hour)
    )
    assert yeonnam["crowd_wait_minutes"] == expected_wait
    assert yeonnam["cost_minutes"] == pytest.approx(yeonnam["walk_minutes"] + expected_wait, abs=0.05)


def test_wait_formula_matches_spot_across_the_day():
    for hour in range(24):
        for level in (0.125, 0.375, 0.625, 0.875):
            assert alternatives.crowd_wait_minutes(level, hour) == asyncio.run(
                calculate_predicted_wait_time("attraction", level, None, hour=hour)
            )


# --- 등급 ↔ 수준 ---------------------------------------------------------------


def test_grade_level_round_trips_through_the_validation_edges():
    """등급 → 수준 → 등급이 항상 제자리로 온다. 두 화면이 다른 눈금을 쓰지 않는다는 보증."""
    for grade in range(len(metrics.GRADE_LABELS)):
        level = alternatives.grade_level(grade)
        assert level is not None
        assert metrics.estimated_grade(level) == grade
    assert alternatives.grade_level(None) is None
    assert alternatives.grade_level(4) is None
    assert alternatives.GRADE_LEVELS == {"여유": 0.125, "보통": 0.375, "약간 붐빔": 0.625, "붐빔": 0.875}


# --- 계약 ---------------------------------------------------------------------


def test_cluster_coordinates_match_the_collector(monkeypatch):
    """좌표가 수집기와 갈라지면 거리·걷는 시간이 조용히 틀린다."""
    for place in alternatives.DEMO_CLUSTER:
        profile = seoul_citydata_service.target_profile(place.area_nm)
        assert profile is not None, place.area_nm
        assert (profile.latitude, profile.longitude) == (place.latitude, place.longitude)


def test_query_reads_only_the_measured_columns(monkeypatch):
    table = _Table(rows=_cluster_rows(at=NOW))
    _install(monkeypatch, table)
    router_module.build_alternatives("홍대 관광특구", now=NOW)
    for columns in table.selects:
        fields = columns.split(",")
        # 추정치·주차 원문은 이 화면에 들어오지 않는다(실측만으로 돈다는 것이 주장의 핵심).
        assert "level_est" not in fields and "prk" not in fields
        assert "parking_level" not in fields and "tourism_level" not in fields


def test_endpoint_returns_contract(monkeypatch):
    _install(monkeypatch, _Table(rows=_cluster_rows(at=datetime.now(timezone.utc) - timedelta(minutes=3))))
    response = _client().get(f"{PATH}?origin=POI007", headers=admin_headers())
    assert response.status_code == 200
    body = response.json()
    assert set(body) >= {
        "state", "generated_at", "table", "migration", "origin", "default_origin", "cluster",
        "source", "source_note", "attribution", "stale_after_minutes", "lookback_days",
        "grade_labels", "grade_levels", "walking", "latest_bucket_at", "latest_age_minutes",
        "places", "ranking", "recommendation",
    }
    assert body["state"] == "ready" and body["origin"] == "홍대 관광특구"
    assert body["source"] == "measured"
    place = _card(body, "연남동")
    assert set(place) >= {
        "area_cd", "area_nm", "latitude", "longitude", "is_origin", "has_data", "source",
        "bucket_at", "observed_at", "age_minutes", "stale", "congest_lvl", "grade", "level",
        "ppltn_min", "ppltn_max", "ppltn_midpoint", "normalized_population",
        "straight_distance_m", "walk_distance_m", "walk_minutes", "crowd_wait_minutes",
        "cost_minutes", "rank", "reason",
    }


def test_unexpected_failure_is_503(monkeypatch):
    _install(monkeypatch, _Table(error=RuntimeError("connection reset")))
    response = _client().get(PATH, headers=admin_headers())
    assert response.status_code == 503
    assert response.json() == {"detail": "engine_validation_unavailable"}


def test_full_lookback_pages_past_postgrest_cap(monkeypatch):
    # 3곳 × 7일 × 144버킷 = 3,024행. 한 번의 select 로는 1000행만 온다.
    start = NOW - timedelta(days=7) + timedelta(minutes=10)
    rows: list[dict] = []
    for index in range(7 * 144 - 1):
        rows.extend(_cluster_rows(at=start + timedelta(minutes=10 * index)))
    _install(monkeypatch, _Table(rows=rows))
    body = router_module.build_alternatives("홍대 관광특구", now=NOW)
    assert body["state"] == "ready"
    assert _card(body, "연남동")["lookback_buckets"] == 7 * 144 - 1
    # 정규화 최대값이 창 전체에서 나온다 — 1000행에서 잘렸다면 여기서 드러난다.
    assert _card(body, "연남동")["lookback_max_midpoint"] == 12000.0
