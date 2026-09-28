# scripts/ingest_tourapi.py 의 facilities 쓰기 모양 — 일배치가 좋은 값을 NULL 로 덮지 않는가.
#
# postgrest-py 의 bulk upsert·insert 는 `columns=` 를 조각 안 모든 행의 키 합집합으로 보내고
# (default_to_null=True), PostgREST 는 행에 없는 열을 NULL 로 채워 쓴다. 상세 조회가 실패한 행이
# 성공한 행과 한 조각에 섞이면 overview·phone·운영시간 등이 NULL 로 덮인다.
# 그래서 여기서는 "요청 하나에 실린 행들의 키 집합이 모두 같은가"를 직접 본다 — 같으면 합집합이
# 곧 각 행의 키라 빈칸 채우기가 생길 수 없다.

from unittest.mock import patch

import scripts.ingest_tourapi as ingest_tourapi


class _Result:
    def __init__(self, data):
        self.data = data


class _FacilitiesTable:
    """facilities 대역 — 기존 행 SELECT(페이지네이션 흉내)와 쓰기 요청을 요청 단위로 기록한다."""

    def __init__(self, existing=(), upsert_error: Exception | None = None):
        self.existing = list(existing)
        self.upsert_error = upsert_error
        self.requests: list[dict] = []  # {"op", "rows"|"payload", "eq"}
        self._op = None
        self._payload = None
        self._range = None
        self._eq = None

    # --- 읽기(fetch_all_rows 체인) ---
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

    # --- 쓰기 ---
    def upsert(self, rows, **_k):
        self._op = "upsert"
        self._payload = [dict(r) for r in rows]
        return self

    def insert(self, rows):
        self._op = "insert"
        self._payload = [dict(r) for r in rows]
        return self

    def update(self, payload):
        self._op = "update"
        self._payload = dict(payload)
        return self

    def eq(self, field, value):
        self._eq = (field, value)
        return self

    def execute(self):
        if self._op == "select":
            start, end = self._range or (0, len(self.existing) - 1)
            return _Result(self.existing[start:end + 1])
        if self._op == "upsert" and self.upsert_error is not None:
            raise self.upsert_error
        if self._op == "update":
            self.requests.append({"op": "update", "payload": self._payload, "eq": self._eq})
        else:
            self.requests.append({"op": self._op, "rows": self._payload})
        return _Result([])

    def bulk(self, op: str) -> list[list[dict]]:
        return [r["rows"] for r in self.requests if r["op"] == op]


class _Admin:
    def __init__(self, facilities: _FacilitiesTable):
        self.facilities = facilities

    def table(self, name: str):
        assert name == "facilities"
        return self.facilities


def _upsert(rows, table: _FacilitiesTable) -> int:
    with patch("app.core.supabase.supabase_admin", _Admin(table)):
        return ingest_tourapi.upsert_facilities(rows)


def _assert_uniform(requests: list[list[dict]]) -> None:
    """요청마다 모든 행의 키 집합이 같다 = postgrest-py 가 보내는 columns 합집합이 곧 각 행의 키."""
    for rows in requests:
        sent_columns = {k for r in rows for k in r}
        for r in rows:
            assert set(r) == sent_columns, (
                f"contentid={r.get('contentid')} 에 없는 열 {sorted(sent_columns - set(r))} 이 "
                "같은 요청에 실려 NULL 로 채워진다"
            )


def _base(contentid: str, **extra) -> dict:
    return {"contentid": contentid, "name": f"시설{contentid}", "type": "attraction",
            "latitude": 35.83, "longitude": 129.21, "features": {"source": "tourapi"}, **extra}


# ---------------------------------------------------------------------------
# (b) 키가 섞인 조각은 키 집합이 같은 요청들로 나뉜다
# ---------------------------------------------------------------------------

def test_mixed_chunk_is_split_into_uniform_key_upserts():
    rows = [
        _base("1", overview="개요1", phone="054-1"),   # 상세 성공
        _base("2"),                                      # 상세 전부 실패
        _base("3", overview="개요3", phone="054-3"),
        _base("4", operating_hours={"open": "09:00"}),  # 운영시간만 성공
        _base("5"),
    ]
    table = _FacilitiesTable()

    written = _upsert(rows, table)

    assert written == 5
    upserts = table.bulk("upsert")
    _assert_uniform(upserts)
    # 처음 나온 키 집합 순서대로, 묶음 안은 입력 순서 그대로.
    assert [[r["contentid"] for r in req] for req in upserts] == [["1", "3"], ["2", "5"], ["4"]]
    failed = next(req for req in upserts if req[0]["contentid"] == "2")
    assert all("overview" not in r and "phone" not in r and "operating_hours" not in r for r in failed)


def test_uniform_groups_still_respect_chunk_size(monkeypatch):
    monkeypatch.setattr(ingest_tourapi, "UPSERT_CHUNK", 2)
    rows = [_base(str(i)) for i in range(5)] + [_base("x", overview="o")]
    table = _FacilitiesTable()

    assert _upsert(rows, table) == 6

    upserts = table.bulk("upsert")
    _assert_uniform(upserts)
    assert [len(req) for req in upserts] == [2, 2, 1, 1]
    assert [r["contentid"] for req in upserts for r in req] == ["0", "1", "2", "3", "4", "x"]


def test_fallback_insert_is_also_split_into_uniform_key_requests():
    # 운영 DB 에서는 contentid 부분 유니크 인덱스를 ON CONFLICT 대상으로 못 써(42P10) 매번 이 폴백이 돈다.
    rows = [_base("1", overview="개요"), _base("2"), _base("3", overview="개요3")]
    table = _FacilitiesTable(upsert_error=RuntimeError(
        "there is no unique or exclusion constraint matching the ON CONFLICT specification"))

    assert _upsert(rows, table) == 3

    inserts = table.bulk("insert")
    _assert_uniform(inserts)
    assert [[r["contentid"] for r in req] for req in inserts] == [["1", "3"], ["2"]]
