from datetime import datetime, timedelta, timezone

import pytest

from app.services import area_demand_reliability_service as reliability


NOW = datetime(2026, 8, 20, 12, 37, tzinfo=timezone.utc)


def _latest():
    return {
        "id": "snapshot-latest",
        "source": "gyeongju_its",
        "observed_at": "2026-08-20T12:31:00+00:00",
        "bucket_at": "2026-08-20T12:30:00+00:00",
        "total_spaces": 300,
        "available_spaces": 120,
        "occupancy": 0.6,
        "live_lot_count": 1,
    }


def _lot():
    return {
        "source_lot_id": "its:1",
        "name": "공영주차장",
        "latitude": 35.84,
        "longitude": 129.21,
        "total_spaces": 300,
        "available_spaces": 120,
        "occupancy": 0.6,
    }


def _patch_queries(monkeypatch, *, rows, earliest, latest, lots=None):
    monkeypatch.setattr(reliability, "_query_window", lambda *_args: rows)
    monkeypatch.setattr(
        reliability,
        "_query_boundary",
        lambda _source, *, latest: latest_value if latest else earliest,
    )
    latest_value = latest
    monkeypatch.setattr(reliability, "_query_lots", lambda _snapshot_id: lots or [])


@pytest.mark.asyncio
async def test_reliability_uses_only_completed_buckets_and_reports_real_gap(monkeypatch):
    rows = [
        {"id": "1", "bucket_at": "2026-08-20T11:30:00+00:00"},
        {"id": "2", "bucket_at": "2026-08-20T11:40:00+00:00"},
        {"id": "3", "bucket_at": "2026-08-20T12:00:00+00:00"},
        {"id": "4", "bucket_at": "2026-08-20T12:10:00+00:00"},
        {"id": "5", "bucket_at": "2026-08-20T12:20:00+00:00"},
        # 현재 진행 중 12:30 버킷은 최신값에는 쓰지만 수집률 분모에는 아직 넣지 않는다.
    ]
    _patch_queries(
        monkeypatch,
        rows=rows,
        earliest={"id": "0", "bucket_at": "2026-08-20T11:20:00+00:00"},
        latest=_latest(),
        lots=[_lot()],
    )

    result = await reliability.get_area_demand_reliability(hours=1, now=NOW)

    assert result["history_state"] == "sufficient_history"
    assert result["window"] == {
        "hours": 1,
        "bucket_minutes": 10,
        "start_at": "2026-08-20T11:30:00+00:00",
        "end_at": "2026-08-20T12:30:00+00:00",
        "end_exclusive": True,
        "expected_bucket_count": 6,
        "received_bucket_count": 5,
        "missing_bucket_count": 1,
        "missing_rate": 0.1667,
        "missing_buckets": ["2026-08-20T11:50:00+00:00"],
        "longest_gap_buckets": 1,
        "longest_gap_minutes": 10,
        "complete": False,
    }
    assert result["latest"] == {
        "snapshot_id": "snapshot-latest",
        "observed_at": "2026-08-20T12:31:00+00:00",
        "bucket_at": "2026-08-20T12:30:00+00:00",
        "age_minutes": 6.0,
        "freshness_state": "fresh",
        "live_lot_count": 1,
        "total_spaces": 300,
        "available_spaces": 120,
        "occupancy": 0.6,
        "lot_detail_count": 1,
        "lot_details_complete": True,
    }
    assert result["lots"] == [_lot()]


@pytest.mark.asyncio
async def test_reliability_truthfully_marks_short_history(monkeypatch):
    _patch_queries(
        monkeypatch,
        rows=[
            {"id": "1", "bucket_at": "2026-08-20T12:00:00+00:00"},
            {"id": "2", "bucket_at": "2026-08-20T12:10:00+00:00"},
        ],
        earliest={"id": "1", "bucket_at": "2026-08-20T12:00:00+00:00"},
        latest=_latest(),
        lots=[],
    )

    result = await reliability.get_area_demand_reliability(hours=1, now=NOW)

    assert result["history_state"] == "insufficient_history"
    assert result["first_bucket_at"] == "2026-08-20T12:00:00+00:00"
    assert result["window"]["missing_bucket_count"] == 4
    assert result["window"]["longest_gap_minutes"] == 30
    assert result["latest"]["lot_details_complete"] is False


@pytest.mark.asyncio
async def test_reliability_empty_table_returns_no_data_without_values(monkeypatch):
    _patch_queries(monkeypatch, rows=[], earliest=None, latest=None)

    result = await reliability.get_area_demand_reliability(hours=1, now=NOW)

    assert result["history_state"] == "no_data"
    assert result["first_bucket_at"] is None
    assert result["latest"] is None
    assert result["lots"] == []
    assert result["window"]["received_bucket_count"] == 0
    assert result["window"]["missing_bucket_count"] == 6


@pytest.mark.asyncio
async def test_reliability_wraps_missing_table_or_query_failure(monkeypatch):
    def fail(*_args, **_kwargs):
        raise RuntimeError("relation does not exist")

    monkeypatch.setattr(reliability, "_query_window", fail)

    with pytest.raises(reliability.AreaDemandReliabilityError, match="snapshot_query_failed"):
        await reliability.get_area_demand_reliability(hours=24, now=NOW)


@pytest.mark.asyncio
async def test_reliability_rejects_unbounded_window_before_query():
    with pytest.raises(ValueError, match="invalid_reliability_window"):
        await reliability.get_area_demand_reliability(hours=169, now=NOW)


# ── PostgREST 행수 캡 — 관대한 페이크는 이 결함을 못 잡는다 ─────────────────
# 아래 페이크는 **캡을 실제로 강제한다**: 단일 응답을 1000행에서 자르고, 요청된
# range 를 하나씩 기록한다. 요청한 만큼 다 돌려주는 페이크였다면 `.limit(1008)` 로
# 되돌려도 테스트가 그대로 통과해 결함이 다시 들어온다.

_POSTGREST_ROW_CAP = 1000


class _FakeResponse:
    def __init__(self, data: list[dict]) -> None:
        self.data = data


class _FakeQuery:
    """PostgREST 쿼리 빌더의 최소 흉내 — 필터/정렬/캡을 실제로 적용한다."""

    def __init__(self, rows: list[dict], calls: list) -> None:
        self._rows = rows
        self._calls = calls
        self._columns: list[str] = []
        self._filters: list[tuple[str, str, object]] = []
        self._order: tuple[str, bool] | None = None
        self._limit: int | None = None
        self._range: tuple[int, int] | None = None

    def select(self, columns: str) -> "_FakeQuery":
        self._columns = [c.strip() for c in columns.split(",")]
        return self

    def eq(self, column: str, value) -> "_FakeQuery":
        self._filters.append(("eq", column, value))
        return self

    def gte(self, column: str, value) -> "_FakeQuery":
        self._filters.append(("gte", column, value))
        return self

    def lt(self, column: str, value) -> "_FakeQuery":
        self._filters.append(("lt", column, value))
        return self

    def order(self, column: str, desc: bool = False) -> "_FakeQuery":
        self._order = (column, desc)
        return self

    def limit(self, count: int) -> "_FakeQuery":
        self._limit = count
        return self

    def range(self, start: int, end: int) -> "_FakeQuery":
        self._range = (start, end)
        return self

    def _matches(self, row: dict) -> bool:
        for op, column, value in self._filters:
            cell = row.get(column)
            if op == "eq" and cell != value:
                return False
            if op == "gte" and not cell >= value:
                return False
            if op == "lt" and not cell < value:
                return False
        return True

    def execute(self) -> _FakeResponse:
        rows = [row for row in self._rows if self._matches(row)]
        if self._order is not None:
            column, desc = self._order
            rows.sort(key=lambda row: row[column], reverse=desc)
        if self._range is not None:
            start, end = self._range
            self._calls.append(("range", start, end))
            rows = rows[start:end + 1]
        elif self._limit is not None:
            self._calls.append(("limit", self._limit))
            rows = rows[:self._limit]
        # ⚠️ 여기가 이 페이크의 핵심: 무엇을 요청했든 단일 응답은 캡에서 잘린다.
        rows = rows[:_POSTGREST_ROW_CAP]
        if self._columns:
            rows = [{c: row[c] for c in self._columns if c in row} for row in rows]
        return _FakeResponse(rows)


class _FakeClient:
    def __init__(self, rows: list[dict], calls: list) -> None:
        self._rows = rows
        self._calls = calls

    def table(self, _name: str) -> _FakeQuery:
        return _FakeQuery(self._rows, self._calls)


@pytest.mark.asyncio
async def test_query_window_pages_past_the_postgrest_row_cap(monkeypatch):
    """168시간 창은 1008 버킷이라 캡(1000)을 넘는다 — 단발 조회면 뒤 8개가 잘린다.

    잘린 8개는 창 **끝**에 몰리므로 '80분 연속 공백' 이라는 실재하지 않는 장애가
    관리자 화면에 뜬다. 수집은 멀쩡한데 사람이 조사에 들어간다.
    """
    end_at = reliability._floor_to_bucket(NOW)
    start_at = end_at - timedelta(hours=168)
    rows = [
        {
            "id": f"row-{offset}",
            "source": "gyeongju_its",
            "bucket_minutes": 10,
            "bucket_at": reliability._iso(start_at + timedelta(minutes=10 * offset)),
        }
        for offset in range(1008)
    ]
    # 필터가 apply_filters 콜백으로 실제 전달되는지도 같이 잠근다 — 아래 세 행이
    # 새어 들어오면 received_bucket_count 가 부풀거나 창 밖 버킷이 섞인다.
    rows += [
        {  # 창 시작 직전
            "id": "before", "source": "gyeongju_its", "bucket_minutes": 10,
            "bucket_at": reliability._iso(start_at - timedelta(minutes=10)),
        },
        {  # 진행 중(창 끝 이후) 버킷
            "id": "current", "source": "gyeongju_its", "bucket_minutes": 10,
            "bucket_at": reliability._iso(end_at),
        },
        {  # 다른 수집원
            "id": "other-source", "source": "national_parking_api", "bucket_minutes": 10,
            "bucket_at": reliability._iso(start_at),
        },
    ]
    calls: list = []
    monkeypatch.setattr(reliability, "supabase_admin", _FakeClient(rows, calls))
    monkeypatch.setattr(
        reliability,
        "_query_boundary",
        lambda _source, *, latest: (
            _latest() if latest
            else {"id": "row-0", "bucket_at": reliability._iso(start_at)}
        ),
    )
    monkeypatch.setattr(reliability, "_query_lots", lambda _snapshot_id: [_lot()])

    result = await reliability.get_area_demand_reliability(hours=168, now=NOW)

    window = result["window"]
    assert window["expected_bucket_count"] == 1008
    assert window["received_bucket_count"] == 1008, (
        "캡에서 잘렸다 — 두 번째 페이지를 받지 않았다"
    )
    assert window["missing_bucket_count"] == 0
    assert window["missing_buckets"] == []
    assert window["longest_gap_minutes"] == 0, "있지도 않은 공백을 보고했다"
    assert window["complete"] is True
    # 두 번째 페이지가 **실제로** 요청됐는가. 캡을 넘긴 단발 .limit() 이면 여기서 갈린다.
    assert calls == [("range", 0, 999), ("range", 1000, 1999)], calls
