"""offset 페이지네이션의 페이지 경계 고정 + 출처 표 전량 조회(P0a).

fetch_all_rows 는 range() 페이지를 서로 다른 HTTP 요청으로 받는다. 정렬이 없으면 두 요청 사이에 행이
옮겨질 때(좌석 방송·일배치 upsert) 한 시설이 두 번 오고 다른 시설이 빠진다. 그리고 출처 표
(facility_source_refs)는 단발 select 라 PostgREST 캡(1000행)에서 조용히 잘렸다.
"""
import asyncio

from app.routers import infrastructures, preference_stats, safety


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    CAP = 1000

    def __init__(self, table: "_Table"):
        self._table = table
        self._range = None

    def select(self, *_a, **_k):
        return self

    def eq(self, field, value):
        self._table.filters.append((field, value))
        return self

    def order(self, field, **_k):
        self._table.orders.append(field)
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def execute(self):
        rows = self._table.rows
        if self._range is not None:
            start, end = self._range
            rows = rows[start:end + 1]
        return _Result(rows[: self.CAP])


class _Table:
    def __init__(self, rows):
        self.rows = rows
        self.orders: list[str] = []
        self.filters: list[tuple] = []


class _Client:
    def __init__(self, tables: dict[str, list[dict]]):
        self.tables = {name: _Table(rows) for name, rows in tables.items()}

    def table(self, name):
        return _Query(self.tables[name])


def _fid(i: int) -> str:
    return f"00000000-0000-4000-8000-{i:012d}"


def test_active_facilities_are_ordered_by_id_and_refs_are_paginated():
    facilities = [
        {"id": _fid(i), "name": f"f{i}", "type": "cafe", "is_active": True, "features": {}}
        for i in range(1200)
    ]
    # 시설마다 tourapi 출처 1건 + 앞 1,300곳에는 localdata 출처 1건 → 2,500행(캡 1000의 2.5배).
    refs = [{"facility_id": _fid(i), "source": "tourapi", "source_updated_at": "t"} for i in range(1200)]
    refs += [
        {"facility_id": _fid(i), "source": "localdata", "source_updated_at": f"l{i}"} for i in range(1200)
    ]
    refs += [{"facility_id": _fid(10_000 + i), "source": "tourapi", "source_updated_at": "x"} for i in range(100)]
    assert len(refs) == 2500
    client = _Client({"facilities": facilities, "facility_source_refs": refs})

    rows = asyncio.run(infrastructures.fetch_active_facilities(client, "*"))

    assert len(rows) == 1200
    assert "id" in client.tables["facilities"].orders
    assert "id" in client.tables["facility_source_refs"].orders
    # 캡에 잘렸다면 1000번째 이후 localdata 출처가 빠져 tourapi 로 되돌아갔을 것이다.
    assert all(row["place_data_source"] == "localdata" for row in rows)
    assert rows[-1]["data_updated_at"] == "l1199"


def test_safety_facility_list_is_ordered_by_id(monkeypatch):
    client = _Client({"facilities": [{"id": _fid(1)}]})
    monkeypatch.setattr(safety, "supabase_client", client)

    asyncio.run(safety._fetch_facilities())

    assert client.tables["facilities"].orders == ["id"]


def test_preference_shares_user_scan_is_ordered_by_id(monkeypatch):
    client = _Client({"users": [{"preferred_categories": ["cafe"]}]})
    monkeypatch.setattr(preference_stats, "supabase_admin", client)
    monkeypatch.setattr(preference_stats, "_cache", None)

    asyncio.run(preference_stats.category_preference_shares())

    assert client.tables["users"].orders == ["id"]
