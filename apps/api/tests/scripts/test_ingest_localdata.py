from pathlib import Path

import pytest

from scripts import ingest_localdata
from scripts.ingest_localdata import decode_csv, parser, read_csv


def test_csv_decodes_utf8_bom_and_cp949(tmp_path: Path):
    content = "관리번호,사업장명\n1,한옥카페\n"
    for encoding in ("utf-8-sig", "cp949"):
        path = tmp_path / f"sample-{encoding}.csv"
        path.write_bytes(content.encode(encoding))
        assert read_csv(path)[0]["사업장명"] == "한옥카페"


def test_invalid_csv_encoding_fails_closed():
    with pytest.raises(ValueError):
        decode_csv(b"\xff\xfe\x00\x81")


def test_cli_defaults_to_dry_run_and_seven_day_delta():
    args = parser().parse_args(["delta"])
    assert args.apply is False
    assert args.start_date is None


# =============================================================================
# 중복 판정 인덱스는 **전량**이어야 한다
# =============================================================================
# 여기서 한 행이라도 빠지면 읽기 오류로 끝나지 않는다. build_actions 가 매칭 없는 항목을
# facility_id=None 으로 만들고, apply_localdata_sync RPC 가 그것을 facilities 에 **INSERT**
# 한다 — 이미 있는 가게가 인덱스에서 빠지면 --apply 가 중복 시설을 만든다.
# 이 배치는 매일 04:00 KST 에 --apply 로 돈다(.github/workflows/ingest.yml).


class _CappedTable:
    """PostgREST 1000행 캡을 **실제로 강제하는** 페이크.

    캡을 흉내내지 않으면 이 테스트는 단발 .execute() 로 되돌려도 통과한다 —
    결함이 다시 들어와도 못 잡는다는 뜻이다.
    """

    CAP = 1000

    def __init__(self, rows, journal, name):
        self._rows = rows
        self._journal = journal
        self._name = name
        self._start = None
        self._end = None

    def select(self, *_a, **_k):
        return self

    def eq(self, column, value):
        self._rows = [r for r in self._rows if r.get(column) == value]
        return self

    def order(self, column, **_k):
        self._rows = sorted(self._rows, key=lambda r: str(r.get(column) or ""))
        return self

    def range(self, start, end):
        self._start, self._end = start, end
        return self

    def limit(self, _n):
        return self

    def execute(self):
        from types import SimpleNamespace

        if self._start is None:
            page = self._rows
        else:
            page = self._rows[self._start : self._end + 1]
        self._journal.append((self._name, self._start, len(page)))
        # ★ 단일 응답은 무조건 잘린다.
        return SimpleNamespace(data=page[: self.CAP])


class _CappedClient:
    def __init__(self, tables):
        self.tables = tables
        self.calls = []

    def table(self, name):
        return _CappedTable(list(self.tables.get(name, [])), self.calls, name)


def test_the_duplicate_index_reads_every_facility(monkeypatch):
    """1,000행 캡 너머의 시설이 인덱스에 들어오는가.

    되돌림 검증: 단발 `.execute()` 로 돌리면 1,000곳만 잡혀 마지막 시설이 빠진다.
    """
    from app.core import supabase as supabase_module

    facilities = [
        {"id": f"f-{i:05d}", "name": f"가게{i}", "address": f"주소{i}",
         "latitude": 35.8, "longitude": 129.2, "type": "cafe", "features": {}, "is_active": True}
        for i in range(1664)
    ]
    refs = [
        {"facility_id": "f-00000", "source": "localdata", "external_id": "L-1",
         "source_status": "영업", "source_updated_at": None, "source_hash": "h"},
        # 캡을 먼저 소진시키는 타 출처 ref — 예전에는 전량을 받아 파이썬에서 걸러서,
        # 이것들 때문에 localdata 인덱스가 더 얇아졌다.
        *[{"facility_id": f"f-{i:05d}", "source": "tourapi", "external_id": f"T-{i}",
           "source_status": None, "source_updated_at": None, "source_hash": None}
          for i in range(1200)],
    ]
    client = _CappedClient({"facilities": facilities, "facility_source_refs": refs})
    monkeypatch.setattr(supabase_module, "supabase_admin", client)

    loaded, ref_index = ingest_localdata.load_db_context()

    assert len(loaded) == 1664, f"시설이 캡에서 잘렸다: {len(loaded)}곳만 읽었다"
    assert loaded[-1]["id"] == "f-01663"
    # 두 번째 페이지를 실제로 요청했는가.
    facility_pages = [c for c in client.calls if c[0] == "facilities"]
    assert len(facility_pages) >= 2, f"페이지네이션이 없다: {facility_pages}"

    # refs 는 source 필터를 쿼리에 걸어, 타 출처가 캡을 소진하지 못하게 한다.
    assert set(ref_index) == {"L-1"}, ref_index
