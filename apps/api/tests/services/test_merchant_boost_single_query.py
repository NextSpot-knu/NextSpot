"""활성 타임세일을 조각별 순차 왕복 대신 한 번에 받는 경로(P3a3 commit 5)가 같은 부스트를 내는지.

페이크는 타임스탬프를 **파싱해** 비교하고 in_/is_/lte/gte 를 실제로 적용하며, 쿼리마다 in_ 이 실렸는지 기록한다.
'오늘의 경로' 는 한 번 조회의 행수 캡을 0 으로 내려 강제로 태운 조각 경로다 — 그 루프와 최댓값 환산은
이 커밋이 손대지 않은 코드 그대로다.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.services import merchant_boost
from app.services.merchant_boost import _TIMESALE_ID_CHUNK, apply_merchant_boosts


def _parse(value):
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


class _Query:
    def __init__(self, client):
        self._client = client
        self._rows = list(client.rows)
        self._record = {"in_": None}

    def select(self, *_args, **_kwargs):
        return self

    def in_(self, col, values):
        values = [str(v) for v in values]
        self._record["in_"] = len(values)
        wanted = set(values)
        self._rows = [r for r in self._rows if str(r.get(col)) in wanted]
        return self

    def is_(self, col, value):
        assert value == "null"
        self._rows = [r for r in self._rows if r.get(col) is None]
        return self

    def lte(self, col, value):
        self._rows = [r for r in self._rows if r.get(col) is not None and _parse(r[col]) <= _parse(value)]
        return self

    def gte(self, col, value):
        self._rows = [r for r in self._rows if r.get(col) is not None and _parse(r[col]) >= _parse(value)]
        return self

    def execute(self):
        self._client.queries.append(self._record)
        if self._client.fail:
            raise RuntimeError("upstream 503")
        return type("Result", (), {"data": list(self._rows)})()


class _Client:
    def __init__(self, rows, *, fail=False):
        self.rows = rows
        self.fail = fail
        self.queries: list[dict] = []

    def table(self, name):
        assert name == "merchant_timesales"
        return _Query(self)


def _row(fid, rate, *, start, end, canceled=None):
    # 저장 형식이 섞여 있어도(마이크로초 유무·Z 표기) 파싱 비교라 같은 판정이 나야 한다.
    return {
        "facility_id": fid,
        "rate": rate,
        "starts_at": start.isoformat(timespec="microseconds"),
        "ends_at": end.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "canceled_at": canceled.isoformat() if canceled else None,
    }


def _scenario(n_ids: int = 400):
    now = datetime.now(timezone.utc)
    ids = [f"00000000-0000-0000-0000-{i:012d}" for i in range(n_ids)]
    facilities = [
        {"id": fid, "coupon_rate": (0.1 if i % 7 == 0 else 0.0), "features": {}} for i, fid in enumerate(ids)
    ]
    hour = timedelta(hours=1)
    rows = [
        _row(ids[3], 0.3, start=now - hour, end=now + hour),                    # 활성
        _row(ids[160], 0.25, start=now - hour, end=now + hour),                 # 활성(둘째 조각)
        _row(ids[399], 0.4, start=now - hour, end=now + hour),                  # 활성(마지막 조각)
        _row(ids[7], 0.05, start=now - hour, end=now + hour),                   # 활성이지만 기본 쿠폰율(0.1)보다 낮다
        _row(ids[200], 0.2, start=now - hour, end=now + hour),                  # 한 시설에 둘 — 큰 쪽
        _row(ids[200], 0.35, start=now - hour / 2, end=now + hour / 2),
        _row(ids[201], 0.3, start=now + hour, end=now + 2 * hour),              # 미래
        _row(ids[202], 0.3, start=now - 2 * hour, end=now - hour),              # 만료
        _row(ids[203], 0.3, start=now - hour, end=now + hour, canceled=now - hour / 4),  # 취소
        _row("99999999-0000-0000-0000-000000000000", 0.5, start=now - hour, end=now + hour),  # 후보 밖
        _row(ids[300], None, start=now - hour, end=now + hour),                 # rate 없음
        _row(ids[301], "0.15", start=now - hour, end=now + hour),               # 문자열 rate
    ]
    return facilities, rows


def _boosts(out):
    return [(f["id"], f["coupon_rate"], f.get("timesale_rate")) for f in out]


@pytest.mark.asyncio
async def test_single_query_gives_the_same_boosts_with_one_query_without_in(monkeypatch):
    facilities, rows = _scenario(400)

    new_client = _Client(rows)
    new = await apply_merchant_boosts(new_client, facilities)

    monkeypatch.setattr(merchant_boost, "_TIMESALE_PAGE_CAP", 0)  # 오늘의 조각 경로를 강제로 태운다
    old_client = _Client(rows)
    old = await apply_merchant_boosts(old_client, facilities)

    assert _boosts(new) == _boosts(old)
    assert new == old
    by_id = {f["id"]: f for f in new}
    assert by_id[facilities[3]["id"]]["timesale_rate"] == 0.3
    assert by_id[facilities[399]["id"]]["timesale_rate"] == 0.4
    assert by_id[facilities[200]["id"]]["timesale_rate"] == 0.35
    assert by_id[facilities[7]["id"]]["coupon_rate"] == 0.1 and "timesale_rate" not in by_id[facilities[7]["id"]]
    assert by_id[facilities[301]["id"]]["timesale_rate"] == 0.15
    assert all("timesale_rate" not in by_id[facilities[i]["id"]] for i in (201, 202, 203, 300))

    assert new_client.queries == [{"in_": None}]
    assert [q["in_"] for q in old_client.queries[1:]] == [150, 150, 100]


@pytest.mark.asyncio
@pytest.mark.parametrize("n_ids", [1, _TIMESALE_ID_CHUNK])
async def test_single_chunk_path_unchanged(n_ids):
    """조각 하나(코스 후보 풀·관광지 by-type·쿠폰 발급)는 오늘의 in_ 쿼리 한 번 그대로다."""
    facilities, rows = _scenario(400)
    client = _Client(rows)
    out = await apply_merchant_boosts(client, facilities[:n_ids])
    assert client.queries == [{"in_": n_ids}]
    if n_ids > 3:
        assert out[3]["timesale_rate"] == 0.3


@pytest.mark.asyncio
async def test_cap_falls_back_to_chunks(monkeypatch):
    facilities, rows = _scenario(400)
    monkeypatch.setattr(merchant_boost, "_TIMESALE_PAGE_CAP", 5)  # 활성 9건 ≥ 5 → 캡에 닿은 것으로 본다
    client = _Client(rows)
    out = await apply_merchant_boosts(client, facilities)
    assert [q["in_"] for q in client.queries] == [None, 150, 150, 100]
    assert {f["id"]: f.get("timesale_rate") for f in out}[facilities[399]["id"]] == 0.4


@pytest.mark.asyncio
async def test_failure_drops_boost_like_today():
    facilities, rows = _scenario(400)
    client = _Client(rows, fail=True)
    out = await apply_merchant_boosts(client, facilities)
    assert len(client.queries) == 1
    assert [f["coupon_rate"] for f in out] == [f["coupon_rate"] for f in facilities]
    assert all("timesale_rate" not in f for f in out)
