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

    gte = order = limit = eq

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
