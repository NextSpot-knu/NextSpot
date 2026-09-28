"""영업 근거를 조각별 동시 요청 대신 한 번(페이지 단위)에 받는 경로(P3a3 commit 6)가 같은 근거를 고르는지.

'오늘의 경로' 는 이 커밋이 손대지 않은 `_fetch_availability_chunk`(조각별 in_ 조회) + 10ea2d4 의 선택 루프를
그대로 옮긴 참조 구현이다. 페이크는 in_·eq·gt(타임스탬프 파싱)·order(여러 키)·range 를 실제로 적용한다.
공개된 차이는 둘뿐이다 — 같은 마이크로초 동률의 순서(id 로 고정)와 실패 범위(통째로 빈다).
"""

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from app.services import availability_service
from app.services.availability_service import (
    _AVAILABILITY_ID_CHUNK,
    _fetch_availability_chunk,
    fetch_effective_availability_map,
    is_effective_availability_evidence,
)

_SIX = ("facility_id", "status", "evidence_tier", "corroborating_count", "reported_at", "expires_at")


def _parse(value):
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


class _Query:
    def __init__(self, admin):
        self._admin = admin
        self._rows = list(admin.rows)
        self._orders: list[tuple[str, bool]] = []
        self._range: tuple[int, int] | None = None
        self._in: int | None = None
        self._columns: tuple[str, ...] = ()

    def select(self, columns, *_args, **_kwargs):
        self._columns = tuple(c.strip() for c in columns.split(","))
        return self

    def in_(self, col, values):
        wanted = {str(v) for v in values}
        self._in = len(wanted)
        self._rows = [r for r in self._rows if str(r.get(col)) in wanted]
        return self

    def eq(self, col, value):
        self._rows = [r for r in self._rows if r.get(col) == value]
        return self

    def gt(self, col, value):
        self._rows = [r for r in self._rows if r.get(col) is not None and _parse(r[col]) > _parse(value)]
        return self

    def order(self, col, desc=False):
        self._orders.append((col, desc))
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def execute(self):
        self._admin.calls.append(self._in)
        if self._admin.fail:
            raise RuntimeError("upstream 503")
        rows = self._rows
        for col, desc in reversed(self._orders):  # 안정 정렬 — 뒤 키부터
            key = (lambda r, c=col: _parse(r[c])) if col.endswith("_at") else (lambda r, c=col: r[c])
            rows = sorted(rows, key=key, reverse=desc)
        if self._range is not None:
            rows = rows[self._range[0]:self._range[1] + 1]
        return type("Result", (), {"data": [{c: r[c] for c in self._columns} for r in rows]})()


class _Admin:
    def __init__(self, rows, *, fail=False):
        self.rows = rows
        self.fail = fail
        self.calls: list[int | None] = []

    def table(self, name):
        assert name == "facility_availability_reports"
        return _Query(self)


async def _old_map(facility_ids):
    """10ea2d4 의 fetch_effective_availability_map 본문 그대로(조각 in_ 조회는 손대지 않은 함수)."""
    unique_ids = list(dict.fromkeys(str(fid) for fid in facility_ids if fid))
    if not unique_ids:
        return {}
    now = datetime.now(timezone.utc)
    chunks = [unique_ids[i:i + _AVAILABILITY_ID_CHUNK] for i in range(0, len(unique_ids), _AVAILABILITY_ID_CHUNK)]
    results = await asyncio.gather(*[_fetch_availability_chunk(c, now) for c in chunks])
    evidence_by_id: dict[str, dict] = {}
    for rows in results:
        for row in rows:
            facility_id = str(row.get("facility_id") or "")
            if facility_id and facility_id not in evidence_by_id and is_effective_availability_evidence(row, at=now):
                evidence_by_id[facility_id] = row
    return evidence_by_id


def _reports(ids: list[str]) -> list[dict]:
    """40건: 만료·단일 사용자·두 사용자·최신 우선·후보 밖 시설·상태 이상값이 섞인다(동률 없음)."""
    now = datetime.now(timezone.utc)
    m = timedelta(minutes=1)
    rows: list[dict] = []

    def add(fid, status="open", count=2, reported=-5, expires=25, tier="corroborated"):
        rows.append({
            "id": f"r-{len(rows):03d}",
            "facility_id": fid,
            "status": status,
            "evidence_tier": tier,
            "corroborating_count": count,
            "reported_at": (now + reported * m).isoformat(timespec="microseconds"),
            "expires_at": (now + expires * m).isoformat(),
            "reporter_note": "응답에 실리면 안 되는 열",
        })

    for k, i in enumerate([0, 149, 150, 299, 300, 499]):   # 조각 경계마다 유효 근거
        add(ids[i], status="open" if k % 2 else "closed", reported=-(k + 1))
    add(ids[10], expires=-1)                               # 만료
    add(ids[11], count=1)                                  # 한 사람만 — 유효하지 않다
    add(ids[12], tier="single_report")                     # 등급 미달
    add(ids[13], status="unknown")                         # 상태 이상값
    add(ids[20], status="open", reported=-30)              # 같은 시설 — 오래된 것
    add(ids[20], status="closed", reported=-3)             # 최신이 이긴다
    add(ids[21], status="closed", reported=-2, count=1)    # 최신이지만 무효 → 다음 유효 행
    add(ids[21], status="open", reported=-9)
    for j in range(8):                                     # 후보 밖 시설
        add(f"outside-{j}", reported=-(j + 1))
    for j in range(40 - len(rows)):                        # 나머지: 후보 안 여러 시설, 일부 만료
        add(ids[400 + j], reported=-(j + 2), expires=(20 if j % 3 else -2))
    assert len(rows) == 40
    return rows


@pytest.mark.asyncio
async def test_single_query_selects_the_same_evidence_as_the_chunks(monkeypatch):
    ids = [f"00000000-0000-0000-0000-{i:012d}" for i in range(500)]
    admin = _Admin(_reports(ids))
    monkeypatch.setattr(availability_service, "supabase_admin", admin)

    new = await fetch_effective_availability_map(ids)
    new_calls = list(admin.calls)
    admin.calls.clear()
    old = await _old_map(ids)

    assert new == old
    assert len(new) >= 10
    assert all(set(row) == set(_SIX) for row in new.values())
    assert new[ids[20]]["status"] == "closed" and new[ids[21]]["status"] == "open"
    assert not any(fid.startswith("outside-") for fid in new)
    assert new_calls == [None]  # 한 번, in_ 없이
    assert sorted(admin.calls) == [50, 150, 150, 150]  # 오늘은 동시 4건


@pytest.mark.asyncio
async def test_single_query_pages_past_the_row_cap(monkeypatch):
    """행수 캡이 없다 — fetch_all_rows 가 페이지를 넘긴다(페이지 크기를 줄여 확인)."""
    from app.core import supabase as supabase_module

    ids = [f"00000000-0000-0000-0000-{i:012d}" for i in range(500)]
    admin = _Admin(_reports(ids))
    monkeypatch.setattr(availability_service, "supabase_admin", admin)
    real = supabase_module.fetch_all_rows

    def _small_pages(*args, **kwargs):
        return real(*args, page_size=7, **kwargs)

    monkeypatch.setattr(availability_service, "fetch_all_rows", _small_pages)
    new = await fetch_effective_availability_map(ids)
    assert len(admin.calls) > 1 and set(admin.calls) == {None}
    assert new == await _old_map(ids)


@pytest.mark.asyncio
@pytest.mark.parametrize("n_ids", [1, _AVAILABILITY_ID_CHUNK])
async def test_single_chunk_path_unchanged(monkeypatch, n_ids):
    """조각 하나(코스 후보 풀)는 오늘의 in_ 조회 한 번 그대로다."""
    ids = [f"00000000-0000-0000-0000-{i:012d}" for i in range(500)]
    admin = _Admin(_reports(ids))
    monkeypatch.setattr(availability_service, "supabase_admin", admin)
    new = await fetch_effective_availability_map(ids[:n_ids])
    assert admin.calls == [n_ids]
    admin.calls.clear()
    assert new == await _old_map(ids[:n_ids])


@pytest.mark.asyncio
async def test_failure_returns_empty_like_today(monkeypatch):
    """실패하면 근거 없이(빈 맵) 돌아온다 — 오늘 상류 전체가 실패했을 때와 같다. 예외는 올라오지 않는다."""
    ids = [f"00000000-0000-0000-0000-{i:012d}" for i in range(500)]
    admin = _Admin(_reports(ids), fail=True)
    monkeypatch.setattr(availability_service, "supabase_admin", admin)
    assert await fetch_effective_availability_map(ids) == {}
    assert admin.calls == [None]
    admin.calls.clear()
    assert await _old_map(ids) == {}  # 오늘: 모든 조각이 실패하면 똑같이 빈 맵


@pytest.mark.asyncio
async def test_same_microsecond_tie_is_broken_by_id(monkeypatch):
    """공개된 차이: 한 시설의 유효 근거 둘이 같은 마이크로초에 보고되면 id 가 앞선 행이 이긴다(오늘은 미정)."""
    now = datetime.now(timezone.utc)
    ids = [f"f{i}" for i in range(_AVAILABILITY_ID_CHUNK + 1)]
    same = (now - timedelta(minutes=2)).isoformat(timespec="microseconds")
    base = {"facility_id": "f5", "evidence_tier": "corroborated", "corroborating_count": 2,
            "reported_at": same, "expires_at": (now + timedelta(minutes=20)).isoformat()}
    admin = _Admin([{**base, "id": "r-b", "status": "closed"}, {**base, "id": "r-a", "status": "open"}])
    monkeypatch.setattr(availability_service, "supabase_admin", admin)
    evidence = await fetch_effective_availability_map(ids)
    assert evidence["f5"]["status"] == "open"
