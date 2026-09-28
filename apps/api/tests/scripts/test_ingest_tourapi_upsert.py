# scripts/ingest_tourapi.py 의 facilities 쓰기 모양 — 일배치가 좋은 값을 NULL 로 덮지 않는가.
#
# postgrest-py 의 bulk upsert·insert 는 `columns=` 를 조각 안 모든 행의 키 합집합으로 보내고
# (default_to_null=True), PostgREST 는 행에 없는 열을 NULL 로 채워 쓴다. 상세 조회가 실패한 행이
# 성공한 행과 한 조각에 섞이면 overview·phone·운영시간 등이 NULL 로 덮인다.
# 그래서 여기서는 "요청 하나에 실린 행들의 키 집합이 모두 같은가"를 직접 본다 — 같으면 합집합이
# 곧 각 행의 키라 빈칸 채우기가 생길 수 없다.

from unittest.mock import patch

import pytest

import scripts.ingest_tourapi as ingest_tourapi
from app.services.tourapi import CAPACITY_DEFAULTS, transform_poi
from app.services.tourapi.client import TourAPIError

# 운영 DB 에서 1차 bulk upsert 가 매번 받는 오류(ingest.yml 로그 09-21~27) — 이때 폴백이 실제 경로다.
_NO_CONFLICT_TARGET = RuntimeError(
    "{'message': 'there is no unique or exclusion constraint matching the ON CONFLICT specification', "
    "'code': '42P10'}"
)
# 상세 조회(detailCommon2·Intro2·Info2·Image2)가 채우는 열.
_DETAIL_KEYS = {"overview", "phone", "homepage", "operating_hours", "barrier_free", "gallery_images"}


class _Result:
    def __init__(self, data):
        self.data = data


class _FacilitiesTable:
    """facilities 대역 — 기존 행 SELECT(페이지네이션 흉내)와 쓰기 요청을 요청 단위로 기록한다."""

    def __init__(self, existing=(), upsert_error=None, insert_error=None):
        # upsert_error: 예외(모든 upsert 실패) 또는 rows → 예외|None 함수(조각별로 실패 여부 결정).
        # insert_error: rows → 예외|None 함수(INSERT 요청별로 실패 여부 결정).
        self.existing = list(existing)
        self.upsert_error = upsert_error
        self.insert_error = insert_error
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
            error = self.upsert_error(self._payload) if callable(self.upsert_error) else self.upsert_error
            if error is not None:
                raise error
        if self._op == "insert" and self.insert_error is not None:
            error = self.insert_error(self._payload)
            if error is not None:
                raise error
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


# ---------------------------------------------------------------------------
# 상세 조회 대역 — enrich_row 를 실제로 돌려 "실패한 호출의 키가 행에 생기지 않는다"를 본다
# ---------------------------------------------------------------------------

def _ok(items: list[dict]) -> dict:
    return {"response": {"header": {"resultCode": "0000", "resultMsg": "OK"},
                         "body": {"items": {"item": items}, "totalCount": len(items)}}}


class _Details:
    """상세 4종 + Wikimedia 대역. fail[contentid] 에 든 호출은 TourAPIError 로 실패하고,
    no_photo 에 든 contentid 는 대표 이미지·갤러리 없이 정상 응답한다."""

    def __init__(self):
        self.fail: dict[str, set[str]] = {}
        self.no_photo: set[str] = set()
        self.empty_common: set[str] = set()  # detailCommon2 가 정상 코드로 답했지만 항목이 0개
        self.no_main: set[str] = set()       # 대표 이미지만 없고 갤러리는 있다
        self.wikimedia_calls: list[str] = []

    def _guard(self, endpoint: str, contentid: str) -> None:
        if endpoint in self.fail.get(contentid, set()):
            raise TourAPIError(f"{endpoint} 호출 실패")

    async def common(self, contentid):
        self._guard("common", contentid)
        if contentid in self.empty_common:
            return _ok([])
        item = {"overview": "개요", "tel": "054-000-0000", "homepage": "https://place.example"}
        if contentid not in self.no_photo and contentid not in self.no_main:
            item["firstimage"] = "http://img.example/common.jpg"
        return _ok([item])

    async def intro(self, contentid, ctid):
        self._guard("intro", contentid)
        return _ok([{"usetime": "09:00~18:00", "restdate": "월요일"}])

    async def info(self, contentid, ctid):
        self._guard("info", contentid)
        return _ok([{"infoname": "장애인 편의", "infotext": "휠체어 대여"}])

    async def image(self, contentid):
        self._guard("image", contentid)
        return _ok([] if contentid in self.no_photo else [{"originimgurl": "http://img.example/g1.jpg"}])

    async def wikimedia(self, name, lat, lng):
        self.wikimedia_calls.append(name)
        return {"url": "https://upload.wikimedia.org/wikipedia/commons/thumb/w.jpg", "source_url": "https://commons.example/page",
                "license": "Public domain", "artist": "unknown"}


ALL_DETAILS = {"common", "intro", "info", "image"}


@pytest.fixture
def details(monkeypatch):
    fake = _Details()
    monkeypatch.setattr(ingest_tourapi, "detail_common", fake.common)
    monkeypatch.setattr(ingest_tourapi, "detail_intro", fake.intro)
    monkeypatch.setattr(ingest_tourapi, "detail_info", fake.info)
    monkeypatch.setattr(ingest_tourapi, "detail_image", fake.image)
    monkeypatch.setattr(ingest_tourapi, "find_reusable_place_image", fake.wikimedia)
    return fake


def _poi(contentid: str, *, firstimage: str = "", addr1: str = "") -> dict:
    """실제 transform_poi 로 만든 관광지 행. 목록 firstimage·addr1 이 빈 값이면 image_url·address 가 None."""
    return transform_poi({"title": f"시설{contentid}", "contentid": contentid, "contenttypeid": 12,
                          "mapx": "129.21", "mapy": "35.83", "firstimage": firstimage, "addr1": addr1})


def _sent(table: _FacilitiesTable) -> dict[str, dict]:
    """contentid → 그 행이 DB 로 실제 보낸 열(bulk 는 행 dict, UPDATE 는 payload — contentid 는 eq 필터)."""
    sent: dict[str, dict] = {}
    for req in table.requests:
        if req["op"] == "update":
            sent[req["eq"][1]] = req["payload"]
        else:
            for row in req["rows"]:
                sent[row["contentid"]] = row
    return sent


# ---------------------------------------------------------------------------
# (a) 상세 조회가 실패한 행은 그 키 없이, NULL 열 없이 보낸다
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize("upsert_error", [None, _NO_CONFLICT_TARGET], ids=["bulk_upsert", "fallback_42P10"])
async def test_row_whose_detail_calls_failed_sends_no_detail_keys_and_no_nulls(details, upsert_error):
    ok, failed = _poi("1"), _poi("2")  # 둘 다 목록 firstimage·addr1 이 빈 값
    details.fail["2"] = set(ALL_DETAILS)
    for row in (ok, failed):
        await ingest_tourapi.enrich_row(row)

    assert _DETAIL_KEYS <= set(ok)
    assert not _DETAIL_KEYS & set(failed)
    # 사진 호출이 실패한 날엔 'TourAPI 사진 없음'을 모른다 — Wikimedia 대체 사진으로 갤러리를 덮지 않는다.
    assert details.wikimedia_calls == []

    table = _FacilitiesTable(
        existing=[{"contentid": "1", "features": {}}, {"contentid": "2", "features": {"overview_i18n": {"en": "x"}}}],
        upsert_error=upsert_error,
    )
    assert _upsert([ok, failed], table) == 2

    sent = _sent(table)
    assert not _DETAIL_KEYS & set(sent["2"]), "실패한 상세의 열이 요청에 실리면 기존 값이 NULL 로 덮인다"
    assert "image_url" not in sent["2"] and "address" not in sent["2"]
    assert [k for k, v in sent["2"].items() if v is None] == []
    assert _DETAIL_KEYS <= set(sent["1"])  # 성공한 행은 그대로 갱신된다
    _assert_uniform(table.bulk("upsert") + table.bulk("insert"))


# ---------------------------------------------------------------------------
# (c) capacity 는 매일 밤 타입별 기본값으로 다시 쓴다 — PM 결정(2026-09-28): 10월 심사가 끝날 때까지
#     일배치 초기화를 유지해 공유 관리자 계정의 실수 수정이 데모에 남지 않게 한다(main 3cf5bf9 와 같은 동작).
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("upsert_error", [None, _NO_CONFLICT_TARGET], ids=["bulk_upsert", "fallback_42P10"])
def test_capacity_is_sent_for_existing_and_new_contentids(upsert_error):
    existing = _poi("1", firstimage="http://img.example/1.jpg", addr1="경주시 1")
    new = _poi("2", firstimage="http://img.example/2.jpg", addr1="경주시 2")
    assert "capacity" in existing and "capacity" in new  # transform 은 그대로 둘 다 채운다

    table = _FacilitiesTable(existing=[{"contentid": "1", "features": {}}], upsert_error=upsert_error)
    assert _upsert([existing, new], table) == 2

    sent = _sent(table)
    assert sent["1"]["capacity"] == CAPACITY_DEFAULTS["attraction"]
    assert sent["2"]["capacity"] == CAPACITY_DEFAULTS["attraction"]
    if upsert_error is not None:  # 운영 경로: 신규는 INSERT, 기존은 행마다 UPDATE
        assert [r["contentid"] for req in table.bulk("insert") for r in req] == ["2"]
        assert [r["eq"] for r in table.requests if r["op"] == "update"] == [("contentid", "1")]


@pytest.mark.parametrize("upsert_error", [None, _NO_CONFLICT_TARGET], ids=["bulk_upsert", "fallback_42P10"])
def test_capacity_none_is_never_sent(upsert_error):
    # capacity 는 INT NOT NULL 이다. 값을 얻지 못한 행(None)은 capacity 를 아예 보내지 않는다 — 기존 행은
    # 그대로 남고, 어떤 경로도 capacity=NULL 을 싣지 않는다.
    rows = [_base("1", capacity=None), _base("2", capacity=CAPACITY_DEFAULTS["attraction"])]
    table = _FacilitiesTable(existing=[{"contentid": "1", "features": {}}, {"contentid": "2", "features": {}}],
                             upsert_error=upsert_error)
    assert _upsert(rows, table) == 2

    sent = _sent(table)
    assert "capacity" not in sent["1"]
    assert sent["2"]["capacity"] == CAPACITY_DEFAULTS["attraction"]
    assert not [p for p in sent.values() if "capacity" in p and p["capacity"] is None]
    _assert_uniform(table.bulk("upsert") + table.bulk("insert"))


def test_fallback_resumes_after_partial_upsert_without_reinserting_written_rows():
    # 1차 bulk upsert 가 첫 조각은 쓰고 둘째 조각에서 실패한 모양(키 집합이 달라 조각이 둘 — 둘째 조각은
    # 문장 시간 초과 같은 조각 단위 오류). 폴백은 1차가 이미 쓴 신규 행을 다시 넣지 않는다.
    new = _poi("2", firstimage="http://img.example/2.jpg", addr1="경주시 2")
    existing = _poi("1", firstimage="http://img.example/1.jpg", addr1="경주시 1")
    existing["overview"] = "개요1"  # 상세가 성공한 기존 행 — 신규 행과 다른 조각에 실린다

    def fail_chunk_with_existing_row(rows):
        if any(r["contentid"] == "1" for r in rows):
            return RuntimeError("canceling statement due to statement timeout (57014)")
        return None

    table = _FacilitiesTable(existing=[{"contentid": "1", "features": {}}], upsert_error=fail_chunk_with_existing_row)
    assert _upsert([new, existing], table) == 2

    assert [[r["contentid"] for r in req] for req in table.bulk("upsert")] == [["2"]]
    assert table.bulk("insert") == []
    updates = [r for r in table.requests if r["op"] == "update"]
    assert [r["eq"] for r in updates] == [("contentid", "1")]
    assert updates[0]["payload"]["capacity"] == CAPACITY_DEFAULTS["attraction"]


# ---------------------------------------------------------------------------
# Wikimedia 대체 사진 — TourAPI 가 "사진 없음"이라고 답했을 때만
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_wikimedia_substitute_only_when_both_photo_calls_answered(details):
    details.no_photo = {"3", "4", "5"}
    details.fail["4"] = {"image"}   # 갤러리 호출 실패
    details.fail["5"] = {"common"}  # 대표 이미지 호출 실패
    answered, image_down, common_down = _poi("3"), _poi("4"), _poi("5")
    for row in (answered, image_down, common_down):
        await ingest_tourapi.enrich_row(row)

    # 두 호출이 답했고 사진이 없다 → 기존처럼 Wikimedia 1장 + 출처.
    assert answered["gallery_images"] == ["https://upload.wikimedia.org/wikipedia/commons/thumb/w.jpg"]
    assert answered["features"]["image_source"]["provider"] == "Wikimedia Commons"
    # 하나라도 실패 → 대체 사진을 만들지 않는다(키가 없으니 DB 의 기존 갤러리가 남는다).
    assert "gallery_images" not in image_down and "gallery_images" not in common_down
    assert details.wikimedia_calls == ["시설3"]


# ---------------------------------------------------------------------------
# 대표 이미지 — TourAPI 가 "없다"고 확인한 날에만 지운다(리뷰 #1·#10)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.parametrize("upsert_error", [None, _NO_CONFLICT_TARGET], ids=["bulk_upsert", "fallback_42P10"])
async def test_image_url_is_cleared_only_when_tourapi_confirmed_no_main_image(details, upsert_error):
    # "3": 목록·detailCommon2 모두 대표 이미지 없음 + 두 사진 호출 모두 답함 → Wikimedia 대체.
    #      DB 에 남은 옛 TourAPI 사진이 Wikimedia 출처 아래 뜨지 않게 image_url 을 지운다.
    # "4": 사진 없음이지만 갤러리 호출만 실패 → detailCommon2 는 답했다 → 대표 이미지는 확인된 부재.
    # "5": detailCommon2 실패 → 대표 이미지가 있는지 모른다 → 키를 보내지 않는다(기존 값 유지).
    # "6": 목록에는 사진이 있다 → 그 값을 그대로 쓴다.
    details.no_photo = {"3", "4", "5"}
    details.fail["4"] = {"image"}
    details.fail["5"] = {"common"}
    rows = [_poi("3"), _poi("4"), _poi("5"), _poi("6", firstimage="http://img.example/6.jpg")]
    for row in rows:
        await ingest_tourapi.enrich_row(row)

    table = _FacilitiesTable(
        existing=[{"contentid": c, "features": {}} for c in ("3", "4", "5", "6")], upsert_error=upsert_error,
    )
    assert _upsert(rows, table) == 4

    sent = _sent(table)
    assert "image_url" in sent["3"] and sent["3"]["image_url"] is None
    assert sent["3"]["gallery_images"] == ["https://upload.wikimedia.org/wikipedia/commons/thumb/w.jpg"]
    assert sent["3"]["features"]["image_source"]["provider"] == "Wikimedia Commons"
    assert "image_url" in sent["4"] and sent["4"]["image_url"] is None
    assert "image_url" not in sent["5"]
    assert sent["6"]["image_url"] == "https://img.example/6.jpg"
    # 판정용 표시는 DB 로 가지 않는다.
    assert not [k for payload in sent.values() for k in payload if k.startswith("_")]
    _assert_uniform(table.bulk("upsert") + table.bulk("insert"))


@pytest.mark.asyncio
@pytest.mark.parametrize("upsert_error", [None, _NO_CONFLICT_TARGET], ids=["bulk_upsert", "fallback_42P10"])
async def test_empty_detail_common_reply_confirms_nothing(details, upsert_error):
    # detailCommon2 가 정상 코드(0000)로 답했지만 항목이 0개 — 상세 항목의 firstimage 를 본 적이 없으니
    # "대표 이미지 없음"이 확인된 것이 아니다. DB 의 좋은 사진을 지우지 않고, Wikimedia 로 바꾸지도 않는다.
    details.no_photo = {"7"}
    details.empty_common = {"7"}
    row = _poi("7")
    await ingest_tourapi.enrich_row(row)

    assert details.wikimedia_calls == []
    assert "gallery_images" not in row

    table = _FacilitiesTable(existing=[{"contentid": "7", "features": {}}], upsert_error=upsert_error)
    assert _upsert([row], table) == 1

    sent = _sent(table)
    assert "image_url" not in sent["7"]
    assert "gallery_images" not in sent["7"]
    assert "image_source" not in sent["7"]["features"]


# ---------------------------------------------------------------------------
# Wikimedia 출처 — TourAPI 사진이 다시 생기면 옛 출처 줄을 걷어 낸다
# ---------------------------------------------------------------------------

_WIKIMEDIA_CREDIT = {"provider": "Wikimedia Commons", "source_url": "https://commons.example/page",
                     "license": "CC BY-SA 4.0", "artist": "someone"}


@pytest.mark.asyncio
@pytest.mark.parametrize("upsert_error", [None, _NO_CONFLICT_TARGET], ids=["bulk_upsert", "fallback_42P10"])
async def test_stale_wikimedia_credit_is_removed_when_tourapi_supplies_a_photo(details, upsert_error):
    # 셋 다 예전 밤에 Wikimedia 대체 사진을 받아 features.image_source 가 DB 에 남아 있다.
    # "8": 오늘 목록 firstimage(대표 사진)가 생겼다. "9": 대표 사진은 없고 갤러리만 생겼다.
    # "10": 오늘 사진 호출이 모두 실패 — 사진이 바뀌었는지 모르므로 출처도 그대로 둔다.
    details.no_main = {"9"}
    details.no_photo = {"10"}
    details.fail["10"] = {"common", "image"}
    rows = [_poi("8", firstimage="http://img.example/8.jpg"), _poi("9"), _poi("10")]
    for row in rows:
        await ingest_tourapi.enrich_row(row)
    assert details.wikimedia_calls == []

    table = _FacilitiesTable(
        existing=[{"contentid": c, "gallery_images": list(_WIKIMEDIA_GALLERY),
                   "features": {"source": "tourapi", "image_source": dict(_WIKIMEDIA_CREDIT)}}
                  for c in ("8", "9", "10")],
        upsert_error=upsert_error,
    )
    assert _upsert(rows, table) == 3

    sent = _sent(table)
    assert sent["8"]["image_url"] == "https://img.example/8.jpg"
    assert sent["8"]["features"].get("image_source") is None
    assert sent["9"]["gallery_images"] == ["https://img.example/g1.jpg"]
    assert sent["9"]["features"].get("image_source") is None
    assert sent["10"]["features"]["image_source"] == _WIKIMEDIA_CREDIT
    assert "image_url" not in sent["10"] and "gallery_images" not in sent["10"]
    _assert_uniform(table.bulk("upsert") + table.bulk("insert"))


# ---------------------------------------------------------------------------
# Wikimedia 사진과 그 출처는 함께 남고 함께 사라진다 (PM 규칙 2026-09-28: CC BY/BY-SA 사진은 출처 없이
# 저장·표시되지 않는다). 웹은 [image_url, ...gallery_images] 를 차례로 시도해 대표 사진이 깨지면 갤러리의
# Wikimedia 사진을 띄운다 — 출처만 지우고 Wikimedia 갤러리를 남기면 그 사진이 출처 없이 뜬다.
# ---------------------------------------------------------------------------

_WIKIMEDIA_GALLERY = ["https://upload.wikimedia.org/wikipedia/commons/thumb/old.jpg"]


def _wikimedia_existing(*contentids: str) -> list[dict]:
    return [{"contentid": c, "gallery_images": list(_WIKIMEDIA_GALLERY),
             "features": {"source": "tourapi", "image_source": dict(_WIKIMEDIA_CREDIT)}}
            for c in contentids]


@pytest.mark.asyncio
@pytest.mark.parametrize("upsert_error", [None, _NO_CONFLICT_TARGET], ids=["bulk_upsert", "fallback_42P10"])
@pytest.mark.parametrize("gallery_reply", ["failed", "zero_items"])
async def test_tourapi_main_photo_without_gallery_drops_wikimedia_photo_and_credit_together(
        details, upsert_error, gallery_reply):
    # 예전 밤의 Wikimedia 대체 사진(갤러리) + 출처가 DB 에 있다. 오늘 목록 firstimage 가 생겼지만 detailImage2 는
    # 실패했거나(failed) 항목 0개로 답했다(zero_items) — 오늘 TourAPI 갤러리가 없다.
    row = _poi("11", firstimage="http://img.example/11.jpg")
    if gallery_reply == "failed":
        details.fail["11"] = {"image"}
    else:
        details.no_photo = {"11"}  # detailCommon2 대표 이미지도 없지만 목록 firstimage 가 이긴다
    await ingest_tourapi.enrich_row(row)
    assert details.wikimedia_calls == []

    table = _FacilitiesTable(existing=_wikimedia_existing("11"), upsert_error=upsert_error)
    assert _upsert([row], table) == 1

    sent = _sent(table)["11"]
    assert sent["image_url"] == "https://img.example/11.jpg"
    assert "image_source" in sent["features"] and sent["features"]["image_source"] is None
    assert sent["gallery_images"] == [], "출처를 지우면 Wikimedia 갤러리도 함께 비워야 출처 없는 사진이 안 뜬다"
    assert sent["features"]["source"] == "tourapi"  # 다른 축적 키는 그대로 병합된다
    _assert_uniform(table.bulk("upsert") + table.bulk("insert"))


@pytest.mark.asyncio
@pytest.mark.parametrize("upsert_error", [None, _NO_CONFLICT_TARGET], ids=["bulk_upsert", "fallback_42P10"])
async def test_tourapi_gallery_replaces_wikimedia_gallery_and_credit(details, upsert_error):
    # "12": 대표 사진 없이 갤러리만, "13": 대표 사진 + 갤러리 — 둘 다 오늘 TourAPI 갤러리가 Wikimedia 갤러리를 대신한다.
    details.no_main = {"12"}
    rows = [_poi("12"), _poi("13", firstimage="http://img.example/13.jpg")]
    for row in rows:
        await ingest_tourapi.enrich_row(row)

    table = _FacilitiesTable(existing=_wikimedia_existing("12", "13"), upsert_error=upsert_error)
    assert _upsert(rows, table) == 2

    sent = _sent(table)
    for cid in ("12", "13"):
        assert sent[cid]["gallery_images"] == ["https://img.example/g1.jpg"]
        assert "image_source" in sent[cid]["features"] and sent[cid]["features"]["image_source"] is None
    _assert_uniform(table.bulk("upsert") + table.bulk("insert"))


@pytest.mark.asyncio
@pytest.mark.parametrize("upsert_error", [None, _NO_CONFLICT_TARGET], ids=["bulk_upsert", "fallback_42P10"])
async def test_no_tourapi_photo_this_run_keeps_wikimedia_photo_and_credit(details, upsert_error, monkeypatch):
    # 오늘 TourAPI 사진을 하나도 얻지 못했다 — Wikimedia 사진도 출처도 건드리지 않는다(키를 보내지 않는다).
    # "14": 두 사진 호출 모두 실패. "15": 두 호출 모두 답했고 사진 없음 + 오늘은 Wikimedia 검색도 빈손.
    details.no_photo = {"14", "15"}
    details.fail["14"] = {"common", "image"}

    async def no_wikimedia(name, lat, lng):
        return None

    monkeypatch.setattr(ingest_tourapi, "find_reusable_place_image", no_wikimedia)
    rows = [_poi("14"), _poi("15")]
    for row in rows:
        await ingest_tourapi.enrich_row(row)

    table = _FacilitiesTable(existing=_wikimedia_existing("14", "15"), upsert_error=upsert_error)
    assert _upsert(rows, table) == 2

    sent = _sent(table)
    for cid in ("14", "15"):
        assert "gallery_images" not in sent[cid]
        assert sent[cid]["features"]["image_source"] == _WIKIMEDIA_CREDIT
    assert "image_url" not in sent["14"]


@pytest.mark.parametrize("upsert_error", [None, _NO_CONFLICT_TARGET], ids=["bulk_upsert", "fallback_42P10"])
def test_list_photo_without_details_run_also_retires_wikimedia_photo(upsert_error):
    # --details 없이 돈 밤에도 목록 firstimage 는 TourAPI 대표 사진이다 — 같은 규칙으로 Wikimedia 를 걷어 낸다.
    # 새 행(기존 features 없음)은 건드리지 않는다.
    rows = [_poi("16", firstimage="http://img.example/16.jpg"), _poi("17", firstimage="http://img.example/17.jpg")]
    table = _FacilitiesTable(existing=_wikimedia_existing("16"), upsert_error=upsert_error)
    assert _upsert(rows, table) == 2

    sent = _sent(table)
    assert sent["16"]["gallery_images"] == [] and sent["16"]["features"]["image_source"] is None
    assert "gallery_images" not in sent["17"] and "image_source" not in sent["17"]["features"]
    _assert_uniform(table.bulk("upsert") + table.bulk("insert"))


# ---------------------------------------------------------------------------
# 저장된 TourAPI 갤러리는 detailImage2 가 실패하거나 항목 0개로 답한 날 지워지지도, Wikimedia 로 바뀌지도 않는다
# (2026-09-28 3차 리뷰). main 3cf5bf9 는 image_source 를 지운 적이 없어, Wikimedia 대체를 한 번 받았다가 나중에
# TourAPI 갤러리를 받은 행은 'TourAPI 갤러리 + 옛 Wikimedia 출처'로 남아 있다.
# ---------------------------------------------------------------------------

_TOURAPI_GALLERY = ["https://img.example/stored-g1.jpg", "https://img.example/stored-g2.jpg"]


def _stale_credit_tourapi_gallery(contentid: str, *, image_url: str | None) -> dict:
    return {"contentid": contentid, "image_url": image_url, "gallery_images": list(_TOURAPI_GALLERY),
            "features": {"source": "tourapi", "image_source": dict(_WIKIMEDIA_CREDIT)}}


@pytest.mark.asyncio
@pytest.mark.parametrize("upsert_error", [None, _NO_CONFLICT_TARGET], ids=["bulk_upsert", "fallback_42P10"])
@pytest.mark.parametrize("gallery_reply", ["failed", "zero_items", "not_called"])
async def test_stale_credit_retire_keeps_stored_tourapi_gallery(details, upsert_error, gallery_reply):
    # "20": 저장된 대표 사진 있음, "21": 없음 — 둘 다 저장된 TourAPI 갤러리 + 옛 Wikimedia 출처.
    # 오늘 목록 firstimage 는 있고 detailImage2 는 실패(failed)·항목 0개(zero_items)·호출 안 함(--details 없음).
    rows = [_poi("20", firstimage="http://img.example/20.jpg"), _poi("21", firstimage="http://img.example/21.jpg")]
    if gallery_reply != "not_called":
        for row in rows:
            cid = row["contentid"]
            if gallery_reply == "failed":
                details.fail[cid] = {"image"}
            else:
                details.no_photo.add(cid)
            await ingest_tourapi.enrich_row(row)

    table = _FacilitiesTable(
        existing=[_stale_credit_tourapi_gallery("20", image_url="https://img.example/prev20.jpg"),
                  _stale_credit_tourapi_gallery("21", image_url=None)],
        upsert_error=upsert_error,
    )
    assert _upsert(rows, table) == 2

    sent = _sent(table)
    for cid in ("20", "21"):
        assert "gallery_images" not in sent[cid], "저장된 TourAPI 갤러리를 [] 로 지우면 안 된다"
        assert sent[cid]["image_url"] == f"https://img.example/{cid}.jpg"
        # 남은 사진은 모두 TourAPI 다 — 옛 Wikimedia 출처가 그 아래 뜨지 않게 지운다(사진은 하나도 안 지운다).
        assert "image_source" in sent[cid]["features"] and sent[cid]["features"]["image_source"] is None
    _assert_uniform(table.bulk("upsert") + table.bulk("insert"))


@pytest.mark.parametrize("upsert_error", [None, _NO_CONFLICT_TARGET], ids=["bulk_upsert", "fallback_42P10"])
def test_retire_removes_only_wikimedia_entries_from_a_mixed_stored_gallery(upsert_error):
    row = _poi("22", firstimage="http://img.example/22.jpg")
    stored = {"contentid": "22", "gallery_images": [_TOURAPI_GALLERY[0], _WIKIMEDIA_GALLERY[0]],
              "features": {"image_source": dict(_WIKIMEDIA_CREDIT)}}
    table = _FacilitiesTable(existing=[stored], upsert_error=upsert_error)
    assert _upsert([row], table) == 1

    sent = _sent(table)["22"]
    assert sent["gallery_images"] == [_TOURAPI_GALLERY[0]]
    assert sent["features"]["image_source"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize("upsert_error", [None, _NO_CONFLICT_TARGET], ids=["bulk_upsert", "fallback_42P10"])
async def test_zero_item_gallery_reply_does_not_replace_stored_tourapi_gallery_with_wikimedia(details, upsert_error):
    # 목록·detailCommon2 모두 대표 이미지 없음(확인된 부재 — image_url 은 지운다), detailImage2 는 항목 0개,
    # Wikimedia 는 찾았다. "23": 저장된 TourAPI 대표·갤러리(출처 없음). "24": TourAPI 갤러리 + 옛 Wikimedia 출처.
    # "25": 저장된 갤러리가 없다 — 이때만 Wikimedia 대체 사진이 출처와 한 쌍으로 들어간다.
    details.no_photo = {"23", "24", "25"}
    rows = [_poi("23"), _poi("24"), _poi("25")]
    for row in rows:
        await ingest_tourapi.enrich_row(row)
    assert all(row["gallery_images"] == ["https://upload.wikimedia.org/wikipedia/commons/thumb/w.jpg"]
               for row in rows)

    table = _FacilitiesTable(
        existing=[
            {"contentid": "23", "image_url": "https://img.example/prev23.jpg",
             "gallery_images": list(_TOURAPI_GALLERY), "features": {"source": "tourapi"}},
            _stale_credit_tourapi_gallery("24", image_url=None),
            {"contentid": "25", "image_url": "https://img.example/prev25.jpg", "gallery_images": None,
             "features": {"source": "tourapi"}},
        ],
        upsert_error=upsert_error,
    )
    assert _upsert(rows, table) == 3

    sent = _sent(table)
    for cid in ("23", "24"):
        assert "gallery_images" not in sent[cid], "항목 0개 응답으로 저장된 TourAPI 갤러리를 덮으면 안 된다"
        assert "image_url" in sent[cid] and sent[cid]["image_url"] is None
    assert "image_source" not in sent["23"]["features"]
    assert sent["24"]["features"]["image_source"] is None
    assert sent["25"]["gallery_images"] == ["https://upload.wikimedia.org/wikipedia/commons/thumb/w.jpg"]
    assert sent["25"]["features"]["image_source"]["provider"] == "Wikimedia Commons"
    _assert_uniform(table.bulk("upsert") + table.bulk("insert"))


# ---------------------------------------------------------------------------
# Kakao 로 검증된 좌표 — 이번 실행의 Kakao 매칭이 실패해도 TourAPI 원 좌표로 되돌리지 않는다(리뷰 #3)
# ---------------------------------------------------------------------------

_KAKAO_STORED = {"coordinate_source": "kakao", "kakao_place_id": "9",
                 "tourapi_coordinates": {"latitude": 35.83, "longitude": 129.21}}


@pytest.mark.parametrize("upsert_error", [None, _NO_CONFLICT_TARGET], ids=["bulk_upsert", "fallback_42P10"])
def test_kakao_verified_coordinates_survive_a_failed_kakao_match(upsert_error):
    # "1": DB 좌표는 Kakao 검증값, 오늘 Kakao 매칭 실패(타임아웃·동점 후보) → 행은 TourAPI 좌표 그대로.
    # "2": DB 좌표는 Kakao 검증값, 오늘도 매칭 성공(reconcile_row_coordinate 가 좌표·features 를 고친 모양).
    # "3": Kakao 로 검증된 적 없는 기존 행. "4": 새 행.
    failed_today = _base("1")
    matched_today = _base("2", latitude=35.8401, longitude=129.2101,
                          features={"source": "tourapi", "coordinate_source": "kakao", "kakao_place_id": "9"})
    never_verified, new = _base("3"), _base("4")
    table = _FacilitiesTable(
        existing=[{"contentid": "1", "features": dict(_KAKAO_STORED)},
                  {"contentid": "2", "features": dict(_KAKAO_STORED)},
                  {"contentid": "3", "features": {"source": "tourapi"}}],
        upsert_error=upsert_error,
    )
    assert _upsert([failed_today, matched_today, never_verified, new], table) == 4

    sent = _sent(table)
    assert "latitude" not in sent["1"] and "longitude" not in sent["1"]
    assert sent["1"]["features"]["coordinate_source"] == "kakao"  # 좌표와 출처 표시가 계속 맞는다
    assert (sent["2"]["latitude"], sent["2"]["longitude"]) == (35.8401, 129.2101)
    assert (sent["3"]["latitude"], sent["3"]["longitude"]) == (35.83, 129.21)
    assert (sent["4"]["latitude"], sent["4"]["longitude"]) == (35.83, 129.21)
    _assert_uniform(table.bulk("upsert") + table.bulk("insert"))


# ---------------------------------------------------------------------------
# 폴백 INSERT — 나쁜 행 하나가 같은 키 묶음의 새 장소(최대 100곳)를 막지 않는다(리뷰 #4)
# ---------------------------------------------------------------------------

def test_failed_insert_chunk_is_retried_row_by_row(capsys):
    # "12"·"13": 이름 VARCHAR(255) 초과 같은 행 단위 거부. 같은 키 묶음의 "11"·"14" 는 들어가야 한다.
    rows = [_base("10"), _base("11"), _base("12"), _base("13"), _base("14")]
    bad = {"12", "13"}

    def reject_bad_rows(sent_rows):
        hit = sorted(r["contentid"] for r in sent_rows if r["contentid"] in bad)
        return RuntimeError(f"value too long for type character varying(255) {hit}") if hit else None

    table = _FacilitiesTable(existing=[{"contentid": "10", "features": {}}],
                             upsert_error=_NO_CONFLICT_TARGET, insert_error=reject_bad_rows)

    assert _upsert(rows, table) == 3  # UPDATE "10" + INSERT "11"·"14"

    inserted = [r["contentid"] for req in table.bulk("insert") for r in req]
    assert inserted == ["11", "14"]
    assert [r["eq"] for r in table.requests if r["op"] == "update"] == [("contentid", "10")]
    out = capsys.readouterr().out
    assert "contentid=12" in out and "contentid=13" in out


@pytest.mark.asyncio
async def test_run_appends_written_summary_to_github_step_summary(monkeypatch, tmp_path):
    # 부분 실패(2/3)가 Actions 실행 Summary 에 한 줄로 남는다. 종료 코드 규칙(written>0 → 0)은 그대로다.
    async def fake_fetch(lat, lng, radius_m, limit):
        return {12: [{"contentid": c} for c in ("1", "2", "3")]}

    class _Events:
        def table(self, name):
            assert name == "app_events"
            return self

        def insert(self, payload):
            return self

        def execute(self):
            return None

    summary = tmp_path / "summary.md"
    summary.write_text("# 앞 스텝\n", encoding="utf-8")
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    monkeypatch.delenv("KAKAO_REST_API_KEY", raising=False)
    monkeypatch.setattr("app.core.supabase.supabase_admin", _Events())
    monkeypatch.setattr(ingest_tourapi, "fetch_pois", fake_fetch)
    monkeypatch.setattr(ingest_tourapi, "transform_poi", lambda item: _base(item["contentid"]))
    monkeypatch.setattr(ingest_tourapi, "upsert_facilities", lambda rows: 2)
    args = ingest_tourapi.argparse.Namespace(lat=35.83, lng=129.21, radius=3000, limit=0,
                                             details=False, dry_run=False, sync=False)

    assert await ingest_tourapi.run(args) == 0

    text = summary.read_text(encoding="utf-8")
    assert text.startswith("# 앞 스텝\n")  # 덮어쓰지 않고 덧붙인다
    assert "written 2/3" in text
    assert len(text.splitlines()) == 2
