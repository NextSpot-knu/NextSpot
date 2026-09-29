# 사람이 숨긴 시설(features.manual_hidden) — 밤 적재 셋 중 어느 것도 다시 켜지 않는다(2026-09-29).
#
# PM 이 중복 카드(백년손님·이재원의과자공방·대구갈비 본점의 Kakao 행)를 is_active=false 로 숨기면:
#   - Kakao 보완 배치는 검색에 다시 잡힌 행마다 is_active 를 새로 쓴다(매일 밤) → 다시 켜졌다
#   - TourAPI showflag 동기화는 표출('1') 행을 복구한다
#   - LOCALDATA 동기화 RPC 는 영업('01') 근거로 복구한다
# 셋 다 manual_hidden 이 있으면 켜지 않아야 한다.

import pytest

import scripts.ingest_localdata as ingest_localdata
import scripts.ingest_tourapi as ingest_tourapi
from app.services.batch.facility_visibility import is_manually_hidden
from scripts.ingest_kakao_places import _is_eligible, _merge_features

_HIDDEN = {"manual_hidden": {"reason": "TourAPI 백년손님(2906690)과 같은 가게 — 중복 카드", "decided": "2026-09-29"}}


def _candidate(category="음식점 > 한식"):
    return {"kakao_place_id": "1", "name": "백년손님", "type": "restaurant", "place_url": None,
            "category_name": category, "queries": ["경주 맛집"], "best_rank": 1, "appearance_count": 1,
            "discovery_source": "keyword_relevance"}


@pytest.mark.parametrize(("features", "expected"), [
    (_HIDDEN, True), ({"manual_hidden": True}, True), ({"manual_hidden": None}, False), ({}, False), (None, False),
])
def test_is_manually_hidden(features, expected):
    assert is_manually_hidden(features) is expected


def test_kakao_discovery_keeps_a_hidden_row_off_and_keeps_the_mark():
    hidden_row = {"id": "c3857ec8", "features": dict(_HIDDEN)}
    assert _is_eligible(hidden_row, _candidate()) is False
    assert _merge_features(hidden_row, _candidate())["manual_hidden"] == _HIDDEN["manual_hidden"]
    # 표시가 없는 행·새 후보는 지금처럼 켠다, 구내식당은 지금처럼 끈다.
    assert _is_eligible({"id": "x", "features": {}}, _candidate()) is True
    assert _is_eligible(None, _candidate()) is True
    assert _is_eligible(None, _candidate("음식점 > 구내식당")) is False


def test_localdata_open_record_does_not_reactivate_a_hidden_row():
    facilities = [{"id": "hidden", "features": dict(_HIDDEN)}, {"id": "open", "features": {}}]
    actions = [
        {"external_id": "1", "facility_id": "hidden", "is_active": True},
        {"external_id": "2", "facility_id": "open", "is_active": True},
        {"external_id": "3", "facility_id": None, "is_active": True},
        {"external_id": "4", "facility_id": "hidden", "is_active": False},
    ]
    assert ingest_localdata.keep_manually_hidden(actions, facilities) == 1
    assert [a["is_active"] for a in actions] == [False, True, True, False]


class _Table:
    def __init__(self, rows):
        self.rows = rows
        self.updates: list[tuple] = []
        self._op = self._payload = self._range = None

    def select(self, *_a, **_k):
        self._op = "select"
        return self

    @property
    def not_(self):
        return self

    def is_(self, *_a, **_k):
        return self

    def order(self, *_a, **_k):
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def update(self, payload):
        self._op, self._payload = "update", payload
        return self

    def eq(self, *args):
        if self._op == "update":
            self.updates.append((self._payload, args))
        return self

    def execute(self):
        class _R:
            data: list = []

        result = _R()
        if self._op == "select":
            start, end = self._range or (0, len(self.rows) - 1)
            result.data = self.rows[start:end + 1]
        return result


class _Admin:
    def __init__(self, table):
        self._table = table

    def table(self, name):
        if name == "facilities":
            return self._table
        raise RuntimeError("facility_source_refs 없음")


def test_tourapi_showflag_sync_does_not_reactivate_a_hidden_row(monkeypatch):
    table = _Table([
        {"id": "hidden", "contentid": "100", "is_active": False, "features": dict(_HIDDEN)},
        {"id": "normal", "contentid": "200", "is_active": False, "features": {}},
    ])
    monkeypatch.setattr("app.core.supabase.supabase_admin", _Admin(table))
    summary = ingest_tourapi.sync_showflags({"100": "1", "200": "1"})
    assert summary["reactivated"] == 1 and summary["reactivation_deferred"] == 1
    assert [args for _payload, args in table.updates] == [("id", "normal")]
