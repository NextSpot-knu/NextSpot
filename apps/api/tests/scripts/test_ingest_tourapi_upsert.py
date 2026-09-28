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

    def __init__(self, existing=(), upsert_error=None):
        # upsert_error: 예외(모든 upsert 실패) 또는 rows → 예외|None 함수(조각별로 실패 여부 결정).
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
            error = self.upsert_error(self._payload) if callable(self.upsert_error) else self.upsert_error
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
        self.wikimedia_calls: list[str] = []

    def _guard(self, endpoint: str, contentid: str) -> None:
        if endpoint in self.fail.get(contentid, set()):
            raise TourAPIError(f"{endpoint} 호출 실패")

    async def common(self, contentid):
        self._guard("common", contentid)
        item = {"overview": "개요", "tel": "054-000-0000", "homepage": "https://place.example"}
        if contentid not in self.no_photo:
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
        return {"url": "https://commons.example/w.jpg", "source_url": "https://commons.example/page",
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
# (c) capacity 는 새 contentid 에만 — 관리자가 고친 수용 인원을 일배치가 되돌리지 않는다
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("upsert_error", [None, _NO_CONFLICT_TARGET], ids=["bulk_upsert", "fallback_42P10"])
def test_capacity_is_sent_only_for_new_contentids(upsert_error):
    existing = _poi("1", firstimage="http://img.example/1.jpg", addr1="경주시 1")
    new = _poi("2", firstimage="http://img.example/2.jpg", addr1="경주시 2")
    assert "capacity" in existing and "capacity" in new  # transform 은 그대로 둘 다 채운다

    table = _FacilitiesTable(existing=[{"contentid": "1", "features": {}}], upsert_error=upsert_error)
    assert _upsert([existing, new], table) == 2

    sent = _sent(table)
    assert "capacity" not in sent["1"]
    assert sent["2"]["capacity"] == CAPACITY_DEFAULTS["attraction"]
    if upsert_error is not None:  # 운영 경로: 신규는 INSERT, 기존은 행마다 UPDATE
        assert [r["contentid"] for req in table.bulk("insert") for r in req] == ["2"]
        assert [r["eq"] for r in table.requests if r["op"] == "update"] == [("contentid", "1")]


def test_fallback_resumes_after_partial_upsert_without_reinserting_written_rows():
    # 충돌 대상이 살아난 뒤의 모양: capacity 가 빠진 기존 행 조각은 NOT NULL(23502)로 거부된다
    # (ON CONFLICT 판정 전에 제약을 검사한다). 폴백은 1차가 이미 쓴 신규 행을 다시 넣지 않는다.
    new = _poi("2", firstimage="http://img.example/2.jpg", addr1="경주시 2")
    existing = _poi("1", firstimage="http://img.example/1.jpg", addr1="경주시 1")

    def not_null_on_missing_capacity(rows):
        if any("capacity" not in r for r in rows):
            return RuntimeError('null value in column "capacity" violates not-null constraint (23502)')
        return None

    table = _FacilitiesTable(existing=[{"contentid": "1", "features": {}}], upsert_error=not_null_on_missing_capacity)
    assert _upsert([new, existing], table) == 2

    assert [[r["contentid"] for r in req] for req in table.bulk("upsert")] == [["2"]]
    assert table.bulk("insert") == []
    updates = [r for r in table.requests if r["op"] == "update"]
    assert [r["eq"] for r in updates] == [("contentid", "1")]
    assert "capacity" not in updates[0]["payload"]


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
    assert answered["gallery_images"] == ["https://commons.example/w.jpg"]
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
    assert sent["3"]["gallery_images"] == ["https://commons.example/w.jpg"]
    assert sent["3"]["features"]["image_source"]["provider"] == "Wikimedia Commons"
    assert "image_url" in sent["4"] and sent["4"]["image_url"] is None
    assert "image_url" not in sent["5"]
    assert sent["6"]["image_url"] == "https://img.example/6.jpg"
    # 판정용 표시는 DB 로 가지 않는다.
    assert not [k for payload in sent.values() for k in payload if k.startswith("_")]
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
