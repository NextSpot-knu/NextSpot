"""/admin/model-trust 가 recommendation_snapshot 을 통째로 받지 않고도 같은 결과를 내는지.

2026-09-25 18:15 KST OOM 의 가장 큰 몫: model-trust 가 스냅샷 전체(칸 ~20개)를 최대 10,000행 받아
쥐었다. 이제 읽는 칸만 JSON 경로로 받는다(_TRUST_REC_SELECT). 여기서는
  1) 추천 조회가 스냅샷 열을 통째로 고르지 않는지,
  2) PostgREST 가 JSON 경로 별칭으로 돌려줄 '얇은 행' 과 예전의 '통째 스냅샷 행' 이 같은 응답을 내는지
를 본다.
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import admin
from tests.conftest import admin_headers

_MODEL_INFO = {"trained": True, "version": "v-test", "real_data_count": 500, "mae": 0.05, "refresh_error": None}


class _Resp:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, rows, selects, table):
        self._rows, self._selects, self._table = rows, selects, table
        self._range = None

    def select(self, columns):
        self._selects.append((self._table, columns))
        return self

    def eq(self, *_a, **_k):
        return self

    gte = order = limit = is_ = eq

    def range(self, start, end):
        self._range = (start, end)
        return self

    def execute(self):
        rows = self._rows
        if self._range is not None:
            rows = rows[self._range[0]:self._range[1] + 1]
        return _Resp(rows[:1000])


class _Fake:
    def __init__(self, tables):
        self.tables, self.selects = tables, []

    def table(self, name):
        return _Query(self.tables.get(name, []), self.selects, name)


def _snapshots(now):
    """가드레일 분기를 모두 밟는 스냅샷 몇 개(순위·마감·도보 초과·근거 없는 수치·영업시간)."""
    fresh = now.isoformat()
    return [
        {"rank": 1, "scoring_mode": "spot", "max_walk_minutes": 10, "breakdown": {"travel_time": 15, "wait_time": 5},
         "congestion": {"level": 0.4, "source": "measured", "timestamp": fresh, "evidence_tier": "verified"},
         "tourapi_facts": {"operating_hours": "09:00-18:00", "barrier_free": True}, "open_status_at_arrival": "open",
         "congestion_estimate": {"level": 0.3, "why": "x" * 400}, "availability_evidence": {"k": "v" * 300}},
        {"rank": 2, "scoring_mode": "degraded_rules", "breakdown": {"wait_time": 7},
         "congestion": {"level": 0.2, "source": "none"}, "open_status_at_arrival": "closed_confirmed"},
        {"rank": 5, "scoring_mode": "area_stats_rules", "breakdown": {"travel_time": 3},
         "congestion": {"level": None, "source": "predicted"}, "tourapi_facts": {"operating_hours": None}},
        {"rank": 3},
        {},
    ]


def _slim(snapshot: dict) -> dict:
    """PostgREST 가 _TRUST_REC_SELECT 의 `별칭:recommendation_snapshot->키` 로 돌려줄 모양."""
    bd = snapshot.get("breakdown") if isinstance(snapshot.get("breakdown"), dict) else {}
    tf = snapshot.get("tourapi_facts") if isinstance(snapshot.get("tourapi_facts"), dict) else {}
    return {
        "s_scoring_mode": snapshot.get("scoring_mode"),
        "s_rank": snapshot.get("rank"),
        "s_open_status_at_arrival": snapshot.get("open_status_at_arrival"),
        "s_max_walk_minutes": snapshot.get("max_walk_minutes"),
        "s_travel_time": bd.get("travel_time"),
        "s_wait_time": bd.get("wait_time"),
        "s_congestion": snapshot.get("congestion"),
        "s_operating_hours": tf.get("operating_hours"),
    }


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _call(client, rec_rows):
    fake = _Fake({"recommendations": rec_rows, "model_registry": [], "recommendation_outcomes": [],
                  "congestion_logs": [], "facilities": []})
    with patch("app.routers.admin.supabase_admin", new=fake), \
            patch("app.services.predict_service.get_model_info", return_value=dict(_MODEL_INFO)):
        res = client.get("/api/v1/admin/model-trust?days=30", headers=admin_headers())
    assert res.status_code == 200
    body = res.json()
    body.pop("since", None)
    return body, fake.selects


def test_recommendations_are_not_fetched_with_the_whole_snapshot(client):
    _, selects = _call(client, [])
    rec_selects = [cols for table, cols in selects if table == "recommendations"]
    assert rec_selects, "model-trust 가 추천을 조회하지 않았다"
    for cols in rec_selects:
        for column in cols.split(","):
            # 스냅샷은 JSON 경로(->)로만 — 열 통째 선택은 OOM 원인이었다.
            assert column != "recommendation_snapshot", cols
            assert column.split(":")[-1].startswith(("id", "created_at", "recommendation_snapshot->")), column


def test_slim_rows_give_the_same_answer_as_whole_snapshots(client):
    now = datetime.now(timezone.utc)
    snaps = _snapshots(now)
    created = [(now - timedelta(minutes=i)).isoformat() for i in range(len(snaps))]
    whole = [{"id": f"r{i}", "created_at": created[i], "recommendation_snapshot": s} for i, s in enumerate(snaps)]
    slim = [{"id": f"r{i}", "created_at": created[i], **_slim(s)} for i, s in enumerate(snaps)]

    body_whole, _ = _call(client, whole)
    body_slim, _ = _call(client, slim)

    assert body_slim == body_whole
    g = body_slim["guardrails"]
    assert g["closed_recommendations"] == 1
    assert g["walk_limit_violations"] == 1
    assert g["ungrounded_numeric_exposures"] == 1  # 두 조건을 다 밟아도 한 행은 한 번
    assert body_slim["top3_evidence"]["count"] == 3
    assert body_slim["top3_evidence"]["operating_hours_rate"] == round(1 / 3, 4)


def test_trust_snapshot_maps_every_field_the_endpoint_reads():
    row = {"s_scoring_mode": "spot", "s_rank": 1, "s_open_status_at_arrival": "open", "s_max_walk_minutes": 9,
           "s_travel_time": 4, "s_wait_time": 2, "s_congestion": {"source": "measured"}, "s_operating_hours": "9-18"}
    snap = admin._trust_snapshot(row)
    assert snap["scoring_mode"] == "spot" and snap["rank"] == 1 and snap["open_status_at_arrival"] == "open"
    assert snap["max_walk_minutes"] == 9
    assert snap["breakdown"] == {"travel_time": 4, "wait_time": 2}
    assert snap["congestion"] == {"source": "measured"}
    assert snap["tourapi_facts"] == {"operating_hours": "9-18"}
    # 없는 칸은 None — 예전 `.get()` 결과와 같다.
    assert admin._trust_snapshot({})["rank"] is None


class _RejectsJsonPath(_Fake):
    """운영 PostgREST 가 JSON 경로 select 를 거부하는 경우를 흉내 낸다."""

    def table(self, name):
        query = super().table(name)
        original_select = query.select

        def select(columns):
            if "->" in columns:
                raise RuntimeError("PGRST100 failed to parse select parameter")
            return original_select(columns)

        query.select = select
        return query


def test_rejected_json_path_select_falls_back_to_whole_snapshot(client):
    now = datetime.now(timezone.utc)
    whole = [{"id": f"r{i}", "created_at": now.isoformat(), "recommendation_snapshot": s}
             for i, s in enumerate(_snapshots(now))]
    expected, _ = _call(client, whole)

    fake = _RejectsJsonPath({"recommendations": whole, "model_registry": [], "recommendation_outcomes": [],
                             "congestion_logs": [], "facilities": []})
    with patch("app.routers.admin.supabase_admin", new=fake), \
            patch("app.services.predict_service.get_model_info", return_value=dict(_MODEL_INFO)):
        res = client.get("/api/v1/admin/model-trust?days=30", headers=admin_headers())

    assert res.status_code == 200  # 관제 화면이 500 으로 깨지지 않는다
    body = res.json()
    body.pop("since", None)
    assert body == expected


# ── 경주가 아닌 추천(개발자의 서울 테스트베드)은 관제 숫자에 섞이지 않는다 ────────────────────────────


class _FilteringQuery(_Query):
    """eq · is_ · gte 를 실제로 적용한다(`열->>키` JSON 경로 포함). 나머지는 _Query 와 같다.

    방문 결과 → 추천 임베드(`recommendation:recommendations!inner(id)`)와 그 칸의 필터(`recommendation.열->>키`)도
    흉내 낸다 — !inner 라 필터에 걸린 자식이면 행째 빠진다. 기록: 표·select·필터(fake.queries).
    """

    def __init__(self, rows, selects, table, fake=None):
        super().__init__(rows, selects, table)
        self._filters: list[tuple[str, str, object]] = []
        self._columns = "*"
        self._fake = fake
        self._orders: list[str] = []
        if fake is not None:
            fake.queries.append(self)

    @staticmethod
    def _cell(row, column):
        if "->>" in column:
            head, key = column.split("->>", 1)
            value = row.get(head)
            return value.get(key) if isinstance(value, dict) else None
        return row.get(column)

    def select(self, columns):
        self._columns = columns
        return super().select(columns)

    def eq(self, column, value):
        self._filters.append(("eq", column, value))
        return self

    def is_(self, column, value):
        self._filters.append(("is", column, value))
        return self

    def gte(self, column, value):
        self._filters.append(("gte", column, value))
        return self

    def order(self, column, **_k):
        self._orders.append(column)
        return self

    limit = _Query.eq

    def _embedded(self) -> bool:
        return self._table == "recommendation_outcomes" and "recommendations!inner" in self._columns

    def execute(self):
        kept = []
        recs = {r.get("id"): r for r in (self._fake.tables.get("recommendations", []) if self._fake else [])}
        for source in self._rows:
            row = dict(source)
            if self._embedded():
                child = recs.get(row.get("recommendation_id"))
                if child is None:
                    continue
                row["recommendation"] = child
            ok = True
            for op, column, value in self._filters:
                target = row
                if column.startswith("recommendation.") and self._embedded():
                    target, column = row["recommendation"], column.split(".", 1)[1]
                cell = self._cell(target, column)
                if op == "eq" and cell != value:
                    ok = False
                if op == "is" and value == "null" and cell is not None:
                    ok = False
                if op == "gte" and cell is not None and str(cell) < str(value):
                    ok = False  # 시각이 없는 행(테스트 단순화)은 남긴다 — 걸린 필터는 queries 로 따로 본다
            if ok:
                if self._embedded():
                    row["recommendation"] = {"id": row["recommendation"].get("id")}
                kept.append(row)
        if self._range is not None:
            kept = kept[self._range[0]:self._range[1] + 1]
        return _Resp(kept[:1000])


class _FilteringFake(_Fake):
    def __init__(self, tables):
        super().__init__(tables)
        self.queries: list[_FilteringQuery] = []

    def table(self, name):
        return _FilteringQuery(self.tables.get(name, []), self.selects, name, fake=self)


def _trust(client, recs, outcomes):
    fake = _FilteringFake({"recommendations": recs, "model_registry": [], "recommendation_outcomes": outcomes,
                           "congestion_logs": [], "facilities": []})
    with patch("app.routers.admin.supabase_admin", new=fake), \
            patch("app.services.predict_service.get_model_info", return_value=dict(_MODEL_INFO)):
        res = client.get("/api/v1/admin/model-trust?days=30", headers=admin_headers())
    assert res.status_code == 200, res.text
    body = res.json()
    body.pop("since", None)
    return body


def test_internal_region_recommendations_and_outcomes_do_not_move_gyeongju_numbers(client):
    now = datetime.now(timezone.utc)
    snaps = _snapshots(now)
    gyeongju = [{"id": f"g{i}", "created_at": now.isoformat(), "source": "spot", "recommendation_snapshot": s}
                for i, s in enumerate(snaps)]
    gj_outcomes = [{"recommendation_id": "g0", "arrival_confirmed_at": now.isoformat(), "rating": "up"}]
    seoul_snap = {"rank": 1, "scoring_mode": "measured_rules", "region": "seoul",
                  "congestion": {"level": 0.125, "source": "measured", "timestamp": now.isoformat(),
                                 "evidence_tier": "zone_measured"},
                  "tourapi_facts": {"operating_hours": "09:00-18:00"}, "open_status_at_arrival": "closed_confirmed"}
    seoul = [{"id": f"s{i}", "created_at": now.isoformat(), "source": "spot", "recommendation_snapshot": dict(seoul_snap)}
             for i in range(4)]
    seoul_outcomes = [{"recommendation_id": f"s{i}", "arrival_confirmed_at": now.isoformat(), "rating": "up"}
                      for i in range(4)]

    baseline = _trust(client, gyeongju, gj_outcomes)
    mixed = _trust(client, gyeongju + seoul, gj_outcomes + seoul_outcomes)

    assert mixed == baseline
    assert mixed["funnel"]["exposures"] == len(gyeongju)
    assert mixed["funnel"]["arrivals"] == 1
    assert "measured_rules" not in mixed["guardrails"]["scoring_modes"]


def test_internal_region_rows_are_dropped_on_the_whole_snapshot_fallback_too(client):
    now = datetime.now(timezone.utc)
    gyeongju = [{"id": f"g{i}", "created_at": now.isoformat(), "source": "spot", "recommendation_snapshot": s}
                for i, s in enumerate(_snapshots(now))]
    seoul = [{"id": "s0", "created_at": now.isoformat(),
              "recommendation_snapshot": {"rank": 1, "scoring_mode": "measured_rules", "region": "seoul"}}]
    expected = _trust(client, gyeongju, [])

    class _RejectingFiltering(_FilteringFake):
        def table(self, name):
            query = super().table(name)
            original_select = query.select

            def select(columns):
                if "->" in columns:
                    raise RuntimeError("PGRST100 failed to parse select parameter")
                return original_select(columns)

            query.select = select
            return query

    fake = _RejectingFiltering({"recommendations": gyeongju + seoul, "model_registry": [],
                                "recommendation_outcomes": [], "congestion_logs": [], "facilities": []})
    with patch("app.routers.admin.supabase_admin", new=fake), \
            patch("app.services.predict_service.get_model_info", return_value=dict(_MODEL_INFO)):
        res = client.get("/api/v1/admin/model-trust?days=30", headers=admin_headers())
    body = res.json()
    body.pop("since", None)
    assert body == expected


def _seoul_and_gyeongju(now):
    gyeongju = [{"id": f"g{i}", "created_at": now.isoformat(), "source": "spot", "recommendation_snapshot": s}
                for i, s in enumerate(_snapshots(now))]
    seoul = [{"id": f"s{i}", "created_at": now.isoformat(), "source": "spot",
              "recommendation_snapshot": {"rank": 1, "scoring_mode": "measured_rules", "region": "seoul"}}
             for i in range(3)]
    gj_outcomes = [{"recommendation_id": "g0", "created_at": now.isoformat(),
                    "arrival_confirmed_at": now.isoformat(), "rating": "up"}]
    seoul_outcomes = [{"recommendation_id": f"s{i}", "created_at": now.isoformat(),
                       "arrival_confirmed_at": now.isoformat(), "rating": "up"} for i in range(3)]
    return gyeongju, seoul, gj_outcomes, seoul_outcomes


def _run(client, fake):
    with patch("app.routers.admin.supabase_admin", new=fake), \
            patch("app.services.predict_service.get_model_info", return_value=dict(_MODEL_INFO)):
        res = client.get("/api/v1/admin/model-trust?days=30", headers=admin_headers())
    assert res.status_code == 200, res.text
    body = res.json()
    body.pop("since", None)
    return body


def test_internal_region_outcomes_are_excluded_in_the_outcome_query_without_an_unbounded_id_scan(client):
    """서울 방문 결과는 방문 결과 조회 **안에서** 빠진다(추천 임베드의 지역 표시). 기간 없는 추천 id 전수 조회는 없다."""
    now = datetime.now(timezone.utc)
    gyeongju, seoul, gj_outcomes, seoul_outcomes = _seoul_and_gyeongju(now)
    baseline = _trust(client, gyeongju, gj_outcomes)
    fake = _FilteringFake({"recommendations": gyeongju + seoul, "model_registry": [],
                           "recommendation_outcomes": gj_outcomes + seoul_outcomes,
                           "congestion_logs": [], "facilities": []})
    body = _run(client, fake)
    assert body == baseline
    assert body["funnel"]["arrivals"] == 1
    outcome_queries = [q for q in fake.queries if q._table == "recommendation_outcomes"]
    assert outcome_queries and all("recommendations!inner" in q._columns for q in outcome_queries)
    assert all(("is", "recommendation.recommendation_snapshot->>region", "null") in q._filters
               for q in outcome_queries)
    # 추천 표 읽기는 모두 기간(created_at ≥ since) 안이다 — 서울 id 를 기간 없이 훑는 조회가 없다.
    rec_queries = [q for q in fake.queries if q._table == "recommendations"]
    assert rec_queries and all(any(op == "gte" and col == "created_at" for op, col, _ in q._filters)
                               for q in rec_queries)


def test_rejected_outcome_embed_falls_back_to_a_time_bounded_id_exclusion(client):
    """임베드 필터가 거부되면(운영 PostgREST 가 모르는 모양) 예전 방식으로 물러서되, 서울 id 조회는 지표 기간에 묶인다."""
    now = datetime.now(timezone.utc)
    gyeongju, seoul, gj_outcomes, seoul_outcomes = _seoul_and_gyeongju(now)
    baseline = _trust(client, gyeongju, gj_outcomes)

    class _RejectingEmbed(_FilteringFake):
        def table(self, name):
            query = super().table(name)
            original_select = query.select

            def select(columns):
                if "!inner" in columns:
                    raise RuntimeError("PGRST100 failed to parse filter")
                return original_select(columns)

            query.select = select
            return query

    fake = _RejectingEmbed({"recommendations": gyeongju + seoul, "model_registry": [],
                            "recommendation_outcomes": gj_outcomes + seoul_outcomes,
                            "congestion_logs": [], "facilities": []})
    body = _run(client, fake)
    assert body == baseline
    id_queries = [q for q in fake.queries if q._table == "recommendations" and q._columns == "id"]
    assert id_queries, "물러선 경로는 서울 추천 id 로 방문 결과를 뺀다"
    for q in id_queries:
        assert any(op == "gte" and col == "created_at" for op, col, _ in q._filters)
        assert q._orders and q._orders[0] == "created_at"


def test_fallback_fails_closed_when_the_seoul_id_query_also_fails(client):
    """임베드도, 서울 id 조회도 거부되면 서울 방문 결과를 셀 수 없다 — 방문 결과 지표를 비우고 절단(truncated)으로 알린다."""
    now = datetime.now(timezone.utc)
    gyeongju, seoul, gj_outcomes, seoul_outcomes = _seoul_and_gyeongju(now)

    class _RejectingRegionFilters(_FilteringFake):
        def table(self, name):
            query = super().table(name)
            original_select, original_eq = query.select, query.eq

            def select(columns):
                if "!inner" in columns:
                    raise RuntimeError("PGRST100 failed to parse filter")
                return original_select(columns)

            def eq(column, value):
                if "->>" in column:
                    query._fail = True
                return original_eq(column, value)

            original_execute = query.execute

            def execute():
                if getattr(query, "_fail", False):
                    raise RuntimeError("statement timeout")
                return original_execute()

            query.select, query.eq, query.execute = select, eq, execute
            return query

    fake = _RejectingRegionFilters({"recommendations": gyeongju + seoul, "model_registry": [],
                                    "recommendation_outcomes": gj_outcomes + seoul_outcomes,
                                    "congestion_logs": [], "facilities": []})
    body = _run(client, fake)
    funnel = body["funnel"]
    assert funnel["arrivals"] == 0 and funnel["positive_ratings"] == 0  # 서울 방문 결과(3건)를 세지 않는다
    assert body["truncated"] is True
    assert "metrics_truncated" in body["guardrails"]["warnings"]
