from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from app.routers import recommendations

from app.services import availability_service
from app.services.availability_service import (
    _AVAILABILITY_ID_CHUNK,
    attach_availability_evidence,
    fetch_effective_availability_map,
    is_effective_availability_evidence,
)


def test_only_fresh_corroborated_evidence_is_effective():
    now = datetime(2026, 8, 25, 3, tzinfo=timezone.utc)
    base = {
        "status": "open",
        "evidence_tier": "corroborated",
        "corroborating_count": 2,
        "expires_at": (now + timedelta(minutes=10)).isoformat(),
    }
    assert is_effective_availability_evidence(base, at=now)
    assert not is_effective_availability_evidence(
        {**base, "evidence_tier": "single_report"}, at=now
    )
    assert not is_effective_availability_evidence(
        {**base, "corroborating_count": 1}, at=now
    )
    assert not is_effective_availability_evidence(
        {**base, "expires_at": (now - timedelta(seconds=1)).isoformat()}, at=now
    )


def test_attach_evidence_does_not_mutate_cached_facilities():
    facilities = [{"id": "f1", "name": "one"}, {"id": "f2", "name": "two"}]
    evidence = {"f1": {"status": "closed"}}
    attached = attach_availability_evidence(facilities, evidence)
    assert "availability_evidence" not in facilities[0]
    assert attached[0]["availability_evidence"] == {"status": "closed"}
    assert attached[1]["availability_evidence"] is None


@pytest.mark.asyncio
async def test_recommendation_cache_never_caches_short_lived_availability(monkeypatch):
    cached_facilities = [{"id": "f1", "name": "one"}]
    cached = AsyncMock(return_value=cached_facilities)
    evidence = AsyncMock(
        side_effect=[
            {},
            {
                "f1": {
                    "status": "open",
                    "evidence_tier": "corroborated",
                    "corroborating_count": 2,
                }
            },
        ]
    )
    monkeypatch.setattr(recommendations, "get_facilities_cached", cached)
    monkeypatch.setattr(recommendations, "fetch_effective_availability_map", evidence)

    first = await recommendations.fetch_all_facilities()
    second = await recommendations.fetch_all_facilities()

    assert first[0]["availability_evidence"] is None
    assert second[0]["availability_evidence"]["status"] == "open"
    assert "availability_evidence" not in cached_facilities[0]
    assert evidence.await_count == 2


class _FakeQuery:
    """supabase-py 체이닝 흉내 — .in_ 에 들어온 id 목록만 기록하고 준비된 행을 돌려준다."""

    def __init__(self, recorder, rows_by_id):
        self._recorder = recorder
        self._rows_by_id = rows_by_id
        self._ids: list[str] = []
        self._in_called = False
        self._range: tuple[int, int] | None = None

    def select(self, *_args, **_kwargs):
        return self

    def in_(self, _column, ids):
        self._ids = list(ids)
        self._in_called = True
        self._recorder.append(self._ids)
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def gt(self, *_args, **_kwargs):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def execute(self):
        if not self._in_called:  # id 목록 없는 한 번 조회(P3a3) — 준비된 행 전부를 페이지 단위로
            rows = list(self._rows_by_id.values())
            if self._range is not None:
                rows = rows[self._range[0]:self._range[1] + 1]
            return type("Result", (), {"data": rows})()
        rows = [self._rows_by_id[i] for i in self._ids if i in self._rows_by_id]
        return type("Result", (), {"data": rows})()


@pytest.mark.asyncio
async def test_availability_query_is_chunked_and_covers_every_id(monkeypatch):
    """id 를 한 요청에 다 싣지 않는다.

    PostgREST 의 in.(...) 는 id 를 URL 에 싣기 때문에, 시설 전체(1,600곳+)를 한 번에 넣으면
    URL 이 수십 KB 가 되어 Supabase 앞단이 520 을 낼 때까지 ~9초를 소모했다. 그 결과
    except 가 {} 를 돌려주며 **영업 근거가 항상 비어 있었고**, 그 지연이 /courses/recommend 를
    프런트 타임아웃 밖으로 밀어냈다(2026-08-27). 이 테스트는 조각 크기 상한과 전체 커버리지를 잠근다.

    P3a3(2026-09-29): 조각이 둘 이상이면 id 목록 없이 한 번(페이지 단위) 받고 요청 id 만 고른다 — URL 에 id 가
    하나도 실리지 않는다. 조각 하나(코스 후보 풀)는 오늘의 in_ 조회 그대로다(test_availability_single_query.py).
    """
    now = datetime.now(timezone.utc)
    ids = [f"f{i}" for i in range(_AVAILABILITY_ID_CHUNK * 2 + 7)]
    fresh = {
        "status": "open",
        "evidence_tier": "corroborated",
        "corroborating_count": 2,
        "reported_at": now.isoformat(),
        "expires_at": (now + timedelta(minutes=10)).isoformat(),
    }
    # 첫 조각과 마지막 조각에 각각 한 건씩 — 조각 결과가 실제로 합쳐지는지 본다.
    rows_by_id = {
        "f0": {**fresh, "facility_id": "f0"},
        ids[-1]: {**fresh, "facility_id": ids[-1]},
    }
    chunks: list[list[str]] = []

    class _FakeAdmin:
        def table(self, _name):
            return _FakeQuery(chunks, rows_by_id)

    monkeypatch.setattr(availability_service, "supabase_admin", _FakeAdmin())

    evidence = await fetch_effective_availability_map(ids)

    assert chunks == []  # URL 에 id 를 싣지 않는다(한 번 조회)
    assert set(evidence) == {"f0", ids[-1]}  # 빠짐 없이 전부 고른다


@pytest.mark.asyncio
async def test_single_query_failure_empties_the_evidence_like_an_upstream_outage(monkeypatch):
    """P3a3 에서 바뀐(공개·PM 수락) 실패 범위: 예전에는 실패한 조각의 id 만 근거가 비었지만, 이제 한 번 조회가
    실패하면 이번 호출의 근거가 통째로 빈다 — 상류 전체가 실패했을 때 오늘도 그렇듯. 추천은 막히지 않는다."""
    ids = [f"f{i}" for i in range(_AVAILABILITY_ID_CHUNK + 1)]
    calls = {"n": 0}

    class _FailingQuery(_FakeQuery):
        def execute(self):
            calls["n"] += 1
            raise RuntimeError("boom")

    class _FakeAdmin:
        def table(self, _name):
            return _FailingQuery([], {})

    monkeypatch.setattr(availability_service, "supabase_admin", _FakeAdmin())

    evidence = await fetch_effective_availability_map(ids)

    assert calls["n"] == 1
    assert evidence == {}
