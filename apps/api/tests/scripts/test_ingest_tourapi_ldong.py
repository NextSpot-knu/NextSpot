# scripts/ingest_tourapi.py — 법정동 코드 목록으로 TourAPI 사각지대 메우기(PM 승인 2026-09-29).
#
# 2026-09-29 실측: 경주 음식점·문화시설 243건 중 127건은 구 areacode/sigungucode 가 빈 값이라 locationBasedList2 와
# 구 지역코드 목록(35/2)에 나오지 않는다. areaBasedList2(lDongRegnCd=47·lDongSignguCd=130)는 전부 준다.
#   A. 목록 합치기 — 같은 반경 안만, contentid 중복 없이, 문화시설·음식점만, 실패하면 반경 목록만
#   B. 신분류 FD05 → 카페(cat3 공란일 때) · 사진 공공누리 유형 적재
#   C. 새 행 가드 — 같은 가게가 이미 Kakao 보완 행으로 있으면(지점 표시만 달라도) 넣지 않는다 ·
#      법정동 목록에만 나온 사진 없는 새 행은 넣지 않는다
#   D. 사람이 뺀 contentid(황리단길 생활문화센터 · 옛 신라고분정보센터 3442528)는 넣지도, showflag 로 다시 켜지도 않는다
#   E. showflag 동기화도 법정동 목록을 합친다

import argparse

import httpx
import pytest

import scripts.ingest_tourapi as ingest_tourapi
from app.services.tourapi import client as tourapi_client
from app.services.tourapi import map_facility_type, transform_poi
from app.services.tourapi.client import TourAPIError, TourAPITransientError

CENTER = (35.8361, 129.2105)


def _ok(items: list[dict]) -> dict:
    return {"response": {"header": {"resultCode": "0000", "resultMsg": "OK"},
                         "body": {"items": {"item": items} if items else "", "totalCount": len(items)}}}


def _item(contentid: str, ctid: int, *, lat: float = 35.8362, lng: float = 129.2100, title: str | None = None,
          **extra) -> dict:
    return {"contentid": contentid, "contenttypeid": str(ctid), "title": title or f"장소{contentid}",
            "mapy": str(lat), "mapx": str(lng), **extra}


@pytest.fixture
def no_retry_sleep(monkeypatch):
    monkeypatch.setattr(ingest_tourapi, "LIST_RETRY_DELAYS_S", (0.0, 0.0, 0.0))


# ---------------------------------------------------------------------------
# A. 목록 합치기
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_fetch_pois_adds_ldong_only_records_inside_the_radius(monkeypatch, no_retry_sleep):
    location = {
        12: [_item("12001", 12)],
        14: [_item("3442528", 14, title="신라고분정보센터")],
        39: [_item("2736687", 39, title="도솔마을")],
    }
    ldong = {
        14: [
            _item("3442528", 14, title="신라고분정보센터"),                # 반경 목록에도 있음 — 한 번만
            _item("3532127", 14, title="신라고분정보센터", lat=35.8360),    # 구 코드가 빈 새 레코드
            _item("3486762", 14, title="오아르미술관", lat=35.8400),
            _item("9999001", 14, title="먼 곳", lat=35.90, lng=129.30),     # 반경(3km) 밖 — 버린다
        ],
        39: [_item("2902488", 39, title="황남밀면"), _item("2902488", 39, title="황남밀면"),  # 같은 목록 안 중복
             _item("bad", 39, lat=None)],                                                      # 좌표 없음 — 버린다
    }
    ldong_calls: list[dict] = []

    async def fake_location(**kwargs):
        return _ok(location[kwargs["content_type_id"]])

    async def fake_area(**kwargs):
        ldong_calls.append(kwargs)
        return _ok(ldong[kwargs["content_type_id"]])

    monkeypatch.setattr(ingest_tourapi, "location_based_list", fake_location)
    monkeypatch.setattr(ingest_tourapi, "area_based_list", fake_area)
    collected = await ingest_tourapi.fetch_pois(*CENTER, 3000, limit=0)

    assert [i["contentid"] for i in collected[14]] == ["3442528", "3532127", "3486762"]
    assert [i["contentid"] for i in collected[39]] == ["2736687", "2902488"]
    assert [i["contentid"] for i in collected[12]] == ["12001"]  # 관광지는 승인 범위 밖 — 법정동 목록을 부르지 않는다
    assert sorted(c["content_type_id"] for c in ldong_calls) == [14, 39]
    for call in ldong_calls:
        assert call["ldong_regn_cd"] == 47 and call["ldong_signgu_cd"] == 130
    # 법정동 목록에서만 온 항목에만 표시가 붙는다(가드 실패 때 이것만 뺀다).
    marked = {i["contentid"] for items in collected.values() for i in items if i.get(ingest_tourapi.LDONG_ONLY_MARK)}
    assert marked == {"3532127", "3486762", "2902488"}


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [TourAPIError("resultCode=10"), TourAPITransientError("timeout")])
async def test_ldong_list_failure_falls_back_to_the_radius_list(monkeypatch, no_retry_sleep, error):
    async def fake_location(**kwargs):
        return _ok([_item(f"{kwargs['content_type_id']}01", kwargs["content_type_id"])])

    async def broken_area(**kwargs):
        raise error

    monkeypatch.setattr(ingest_tourapi, "location_based_list", fake_location)
    monkeypatch.setattr(ingest_tourapi, "area_based_list", broken_area)
    collected = await ingest_tourapi.fetch_pois(*CENTER, 3000, limit=0)  # 올리지 않는다(75 는 반경 목록 실패에서만)
    assert {ctid: [i["contentid"] for i in items] for ctid, items in collected.items()} == {
        12: ["1201"], 14: ["1401"], 39: ["3901"],
    }


@pytest.mark.asyncio
async def test_area_based_list_sends_ldong_codes_to_tourapi(monkeypatch):
    seen: list[httpx.Request] = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=_ok([]))

    monkeypatch.setattr(tourapi_client.settings, "TOURAPI_KEY", "test-key")
    monkeypatch.setattr(tourapi_client, "_list_cache", {})
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(tourapi_client, "_get_client", lambda: client)
    await tourapi_client.area_based_list(content_type_id=39, rows=1000, ldong_regn_cd=47, ldong_signgu_cd=130)
    await tourapi_client.area_based_sync_list(page=1, ldong_regn_cd=47, ldong_signgu_cd=130)

    for request in seen:
        params = request.url.params
        assert params["lDongRegnCd"] == "47" and params["lDongSignguCd"] == "130"
        assert "areaCode" not in params and "sigunguCode" not in params
    assert seen[0].url.path.endswith("/areaBasedList2") and seen[1].url.path.endswith("/areaBasedSyncList2")


# ---------------------------------------------------------------------------
# B. FD05 → 카페 · 공공누리 유형
# ---------------------------------------------------------------------------

def test_fd05_maps_to_cafe_only_when_cat3_is_blank():
    assert map_facility_type(39, None, "FD05") == "cafe"
    assert map_facility_type(39, "", "FD05") == "cafe"
    assert map_facility_type(39, None, "FD01") == "restaurant"
    assert map_facility_type(39, "A05020100", "FD05") == "restaurant"  # cat3 가 있으면 cat3 가 이긴다
    assert map_facility_type(39, "A05020900", "FD01") == "cafe"
    assert map_facility_type(14, None, "FD05") == "culture"


def test_transform_poi_uses_new_classification_and_keeps_photo_licence_type():
    # 법정동 목록에만 나오는 경주 카페(스테이550) 실측 모양 — cat1~3 공란, lclsSystm2=FD05.
    row = transform_poi(_item("2903989", 39, title="스테이550", cat1="", cat2="", cat3="",
                              lclsSystm1="FD", lclsSystm2="FD05", lclsSystm3="FD050100",
                              firstimage="http://tong.visitkorea.or.kr/cms/resource/1_image2_1.jpg",
                              cpyrhtDivCd="Type3"))
    assert row["type"] == "cafe"
    assert row["capacity"] == 30
    assert row["image_url"].startswith("https://")
    assert row["features"]["lcls_systm2"] == "FD05"
    assert row["features"]["firstimage_cpyrht_div_cd"] == "Type3"
    assert transform_poi(_item("1", 39, cpyrhtDivCd=""))["features"]["firstimage_cpyrht_div_cd"] is None


# ---------------------------------------------------------------------------
# C. 새 행 중복 가드
# ---------------------------------------------------------------------------

def _facility(fid, name, *, type_="restaurant", lat=35.8362, lng=129.2100, contentid=None, is_active=True):
    return {"id": fid, "name": name, "type": type_, "latitude": lat, "longitude": lng,
            "contentid": contentid, "is_active": is_active}


def _row(contentid, name, *, type_="restaurant", lat=35.8362, lng=129.2100):
    return {"contentid": contentid, "name": name, "type": type_, "latitude": lat, "longitude": lng}


def test_new_row_matching_an_existing_kakao_row_is_a_probable_duplicate():
    facilities = [
        _facility("kakao-dongyang", "동양백반", lat=35.8363),                              # 약 11m, 이름을 품는다
        _facility("70231629", "신라고분정보센터", type_="culture", contentid="3442528"),   # 다른 contentid 로 이미 있음
        _facility("kakao-hidden", "숨긴가게"),
        _facility("tour-existing", "백년손님", contentid="2906690"),
    ]
    facilities[2]["is_active"] = False
    rows = [
        _row("2907353", "동양백반 경주황리단길 본점"),
        _row("3532127", "신라고분정보센터", type_="culture"),
        _row("9000001", "숨긴가게"),                                    # 숨긴 행과만 겹친다 — 넣는다
        _row("9000002", "동양백반", type_="culture"),                   # 부류가 다르다 — 넣는다
        _row("9000003", "동양백반", lat=35.8380),                       # 200m 떨어짐 — 넣는다
        _row("2906690", "백년손님"),                                    # 이미 DB 에 있는 contentid — 평소처럼 갱신
        _row("9000004", "시골쌈밥"),                                    # 겹치는 곳 없음
    ]
    duplicates = ingest_tourapi.find_probable_duplicates(rows, facilities)
    assert set(duplicates) == {"2907353", "3532127"}
    assert duplicates["2907353"]["id"] == "kakao-dongyang"
    assert duplicates["2907353"]["distance_m"] <= ingest_tourapi.DUPLICATE_GUARD_MAX_M
    assert duplicates["3532127"]["contentid"] == "3442528"


class _Recorder:
    def __init__(self):
        self.enriched: list[str] = []
        self.upserted: list[str] = []


def _run_env(monkeypatch, collected, *, guard_facilities=None, guard_error=None) -> _Recorder:
    rec = _Recorder()

    async def fake_fetch(lat, lng, radius_m, limit):
        return collected

    async def fake_enrich(row):
        rec.enriched.append(row["contentid"])

    def fake_upsert(rows):
        rec.upserted.extend(r["contentid"] for r in rows)
        return len(rows)

    def fake_guard():
        if guard_error is not None:
            raise guard_error
        return guard_facilities or []

    class _Events:
        def table(self, name):
            return self

        def insert(self, payload):
            return self

        def execute(self):
            return None

    monkeypatch.setattr(ingest_tourapi, "fetch_pois", fake_fetch)
    monkeypatch.setattr(ingest_tourapi, "enrich_row", fake_enrich)
    monkeypatch.setattr(ingest_tourapi, "upsert_facilities", fake_upsert)
    monkeypatch.setattr(ingest_tourapi, "_load_guard_facilities", fake_guard)
    monkeypatch.setattr("app.core.supabase.supabase_admin", _Events())
    monkeypatch.delenv("KAKAO_REST_API_KEY", raising=False)
    return rec


def _args(**overrides) -> argparse.Namespace:
    base = dict(lat=CENTER[0], lng=CENTER[1], radius=3000, limit=0, details=True, dry_run=False, sync=False)
    base.update(overrides)
    return argparse.Namespace(**base)


def _ldong(item):
    return {**item, ingest_tourapi.LDONG_ONLY_MARK: True}


_PHOTO = "http://tong.visitkorea.or.kr/cms/resource/1_image2_1.jpg"


@pytest.mark.asyncio
async def test_run_skips_duplicates_and_excluded_before_detail_calls(monkeypatch):
    collected = {
        14: [_item("3453492", 14, title="경주중앙도서관"),
             _item("3442528", 14, title="신라고분정보센터"),
             _ldong(_item("3451999", 14, title="황리단길 생활문화센터")),
             _ldong(_item("3486762", 14, title="오아르미술관", firstimage=_PHOTO))],
        39: [_ldong(_item("2907353", 39, title="동양백반 경주황리단길 본점", firstimage=_PHOTO)),
             _ldong(_item("2904007", 39, title="시골쌈밥", lat=35.8340, firstimage=_PHOTO))],
    }
    facilities = [_facility("library", "경주중앙도서관", type_="culture", contentid="3453492"),
                  _facility("70231629", "신라고분정보센터", type_="culture", contentid="3532127"),
                  _facility("kakao-dongyang", "동양백반")]
    rec = _run_env(monkeypatch, collected, guard_facilities=facilities)

    assert await ingest_tourapi.run(_args()) == 0
    expected = ["3453492", "3486762", "2904007"]
    assert rec.upserted == expected
    assert rec.enriched == expected  # 가드·제외는 상세 조회(쿼터) 전에 걸린다


def test_branch_suffix_does_not_hide_the_same_shop():
    # 2026-09-29 리뷰: 같은 주소(탑리3길 2) 0m — 지점 표시만 다르다.
    facilities = [_facility("d30b8c1a", "교리김밥 경주본점"),
                  _facility("kakao-cafe", "카페 마르쉐", type_="cafe"),
                  _facility("kakao-bread", "황남빵", type_="cafe")]
    rows = [_row("2932986", "교리김밥 본점"),
            _row("9000010", "카페 경주", type_="cafe"),       # 뗀 이름이 2글자('카페') — 품음으로 보지 않는다
            _row("9000011", "황남밀면 경주황리단길점", type_="cafe")]  # 뗀 이름 '황남밀면' ≠ '황남빵'
    duplicates = ingest_tourapi.find_probable_duplicates(rows, facilities)
    assert set(duplicates) == {"2932986"}
    assert duplicates["2932986"]["id"] == "d30b8c1a"


def test_attraction_guard_reaches_wide_sites_but_not_neighbouring_tourapi_records():
    # 2026-09-29 운영 대조(관광지 법정동 사각지대 26곳). 관광지는 넓은 터라 같은 곳의 두 좌표가 80m 보다 멀 수 있다.
    kyochon = _facility("f4000000-0000-0000-0000-000000000002", "경주 교촌마을", type_="culture",
                        lat=35.8296, lng=129.2156)                                   # 시드 행(Kakao 검증 좌표)
    woljeong = _facility("f3000000-0000-0000-0000-000000000004", "월정교", type_="attraction",
                         lat=35.8316, lng=129.2167)
    barley = _facility("88005625", "분황사 청보리밭", type_="attraction", contentid="2774279",
                       lat=35.8398, lng=129.2338)                                    # 다른 TourAPI 레코드
    choi = _facility("f4000000-0000-0000-0000-000000000003", "경주 최부자댁", type_="culture",
                     lat=35.8302, lng=129.2161, is_active=False)                     # 꺼진 시드(검증 안 된 데모)
    wolseong_record = _facility("35ae8de0", "경주 월성", type_="attraction", contentid="9990001",
                                lat=35.8300, lng=129.2250)
    rows = [
        _row("128676", "경주 교촌마을", type_="attraction", lat=35.8291, lng=129.2133),  # 약 220m — 시드 행과 같은 곳
        _row("2603509", "월정교", type_="attraction", lat=35.8316, lng=129.2167),
        _row("317503", "분황사", type_="attraction", lat=35.8401, lng=129.2336),        # 약 40m — 이웃 명소, 넣는다
        _row("2614343", "경주 최부자댁", type_="attraction", lat=35.8297, lng=129.2160),  # 꺼진 시드와만 겹친다 — 넣는다
        _row("9990002", "경주 월성", type_="attraction", lat=35.8310, lng=129.2250),     # 다른 레코드와 같은 이름 111m — 겹친다
        _row("9990003", "경주교촌마을", type_="attraction", lat=35.8340, lng=129.2156),   # 약 490m — 너무 멀다
    ]
    duplicates = ingest_tourapi.find_probable_duplicates(rows, [kyochon, woljeong, barley, choi, wolseong_record])
    assert set(duplicates) == {"128676", "2603509", "9990002"}
    assert duplicates["128676"]["id"] == "f4000000-0000-0000-0000-000000000002"
    assert 150 < duplicates["128676"]["distance_m"] <= ingest_tourapi.ATTRACTION_DUPLICATE_GUARD_MAX_M
    assert duplicates["128676"]["manual"] is True and duplicates["2603509"]["manual"] is True
    assert duplicates["9990002"]["manual"] is False


def test_wider_attraction_reach_does_not_change_the_shop_and_culture_guard():
    # 음식점·문화시설 새 행은 승인된 80m·품음 규칙 그대로다.
    facilities = [_facility("kakao-a", "동양백반", lat=35.8372),                                  # 약 110m
                  _facility("rec-b", "황룡사 역사문화관 별관", type_="culture", contentid="9990010")]  # 다른 레코드, 품음
    rows = [_row("9000020", "동양백반"),
            _row("9000021", "황룡사 역사문화관", type_="culture")]
    assert set(ingest_tourapi.find_probable_duplicates(rows, facilities)) == {"9000021"}


@pytest.mark.parametrize(("name", "core"), [
    ("교리김밥본점", "교리김밥"),
    ("교리김밥경주본점", "교리김밥"),
    ("신라제면경주황리단길점", "신라제면"),
    ("천년애황남점", "천년애"),
    ("스테이550경주점", "스테이550"),
    ("엽기떡볶이2호점", "엽기떡볶이"),
    ("경주점", "경주점"),          # 떼면 빈 이름 — 그대로 둔다
    ("동양백반", "동양백반"),
])
def test_core_name_strips_only_the_branch_suffix(name, core):
    assert ingest_tourapi._core_name(name) == core


@pytest.mark.asyncio
async def test_photo_less_new_ldong_rows_are_not_inserted(monkeypatch):
    # PM 승인 범위는 '사진이 있는 새 장소' — 경주문화원(130030)처럼 사진 없는 새 카드는 넣지 않는다.
    collected = {
        14: [_ldong(_item("130030", 14, title="경주문화원")),                                   # 새 · 사진 없음 → 뺀다
             _ldong(_item("3486762", 14, title="오아르미술관", firstimage=_PHOTO))],             # 새 · 사진 있음 → 넣는다
        39: [_ldong(_item("2839014", 39, title="료미")),                                         # 이미 이은 행 → 갱신
             _item("2736687", 39, title="도솔마을")],                                            # 반경 목록 → 도입 전 그대로
    }
    facilities = [_facility("f1847615", "료미", contentid="2839014", lat=35.8400)]
    rec = _run_env(monkeypatch, collected, guard_facilities=facilities)
    assert await ingest_tourapi.run(_args()) == 0
    assert rec.upserted == ["3486762", "2839014", "2736687"]
    assert "130030" not in rec.enriched  # 상세 조회(쿼터) 전에 걸린다


@pytest.mark.asyncio
async def test_old_silla_tomb_record_stays_out_even_when_the_guard_lookup_fails(monkeypatch):
    # 통합(행 70231629 → 3532127) 뒤 옛 3442528 은 반경 목록에 계속 나온다. 가드 조회가 실패하면 법정동 폴백으로는
    # 안 빠지므로, 제외 목록이 결정적으로 막아야 두 번째 신라고분정보센터 카드가 생기지 않는다.
    assert "3442528" in ingest_tourapi.EXCLUDED_CONTENTIDS
    collected = {14: [_item("3442528", 14, title="신라고분정보센터"), _item("3453492", 14, title="경주중앙도서관")]}
    rec = _run_env(monkeypatch, collected, guard_error=RuntimeError("supabase 503"))
    assert await ingest_tourapi.run(_args(details=False)) == 0
    assert rec.upserted == ["3453492"]


@pytest.mark.asyncio
async def test_guard_lookup_failure_drops_only_ldong_only_rows(monkeypatch):
    collected = {39: [_item("2736687", 39, title="도솔마을"),
                      _ldong(_item("2904007", 39, title="시골쌈밥", firstimage=_PHOTO))]}
    rec = _run_env(monkeypatch, collected, guard_error=RuntimeError("supabase down"))
    assert await ingest_tourapi.run(_args(details=False)) == 0
    assert rec.upserted == ["2736687"]  # 가릴 수 없으면 도입 전 동작(반경 목록만)


@pytest.mark.asyncio
async def test_dry_run_does_not_read_the_database_for_the_guard(monkeypatch):
    collected = {39: [_ldong(_item("2904007", 39, title="시골쌈밥"))]}
    rec = _run_env(monkeypatch, collected, guard_error=AssertionError("dry-run 이 DB 를 읽었다"))
    assert await ingest_tourapi.run(_args(details=False, dry_run=True)) == 0
    assert rec.upserted == []


# ---------------------------------------------------------------------------
# D·E. showflag 동기화
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_gyeongju_showflags_union_legacy_and_ldong(monkeypatch, no_retry_sleep):
    calls: list[dict] = []

    async def fake_sync(**kwargs):
        calls.append(kwargs)
        if kwargs.get("ldong_regn_cd"):
            return _ok([{"contentid": "1", "showflag": "0"}, {"contentid": "3532127", "showflag": "1"}])
        return _ok([{"contentid": "1", "showflag": "1"}, {"contentid": "2", "showflag": "0"}])

    monkeypatch.setattr(ingest_tourapi, "area_based_sync_list", fake_sync)
    result = await ingest_tourapi.fetch_gyeongju_showflags()
    # 구 코드 값이 이긴다(도입 전 동작), 법정동에만 있는 레코드가 더해진다.
    assert result == {"1": "1", "2": "0", "3532127": "1"}
    ldong_call = next(c for c in calls if c.get("ldong_regn_cd"))
    assert ldong_call["ldong_regn_cd"] == 47 and ldong_call["ldong_signgu_cd"] == 130
    assert ldong_call["area_code"] is None and ldong_call["sigungu_code"] is None


@pytest.mark.asyncio
async def test_gyeongju_showflags_falls_back_to_legacy_when_ldong_fails(monkeypatch, no_retry_sleep):
    async def fake_sync(**kwargs):
        if kwargs.get("ldong_regn_cd"):
            raise TourAPIError("resultCode=10")
        return _ok([{"contentid": "1", "showflag": "1"}])

    monkeypatch.setattr(ingest_tourapi, "area_based_sync_list", fake_sync)
    assert await ingest_tourapi.fetch_gyeongju_showflags() == {"1": "1"}


class _SyncTable:
    def __init__(self, rows):
        self.rows = rows
        self.updates: list[tuple[dict, tuple]] = []
        self._op = None
        self._payload = None
        self._range = None

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

    def eq(self, *args):
        if self._op == "update":
            self.updates.append((self._payload, args))
        return self

    def update(self, payload):
        self._op = "update"
        self._payload = payload
        return self

    def execute(self):
        class _R:
            pass

        result = _R()
        if self._op == "select":
            start, end = self._range or (0, len(self.rows) - 1)
            result.data = self.rows[start:end + 1]
        else:
            result.data = []
        return result


class _SyncAdmin:
    def __init__(self, facilities):
        self.facilities = facilities

    def table(self, name):
        if name == "facilities":
            return self.facilities
        raise RuntimeError("facility_source_refs 없음")  # sync_showflags 는 이 실패를 하위호환으로 흡수한다


def test_sync_never_reactivates_an_excluded_contentid(monkeypatch):
    table = _SyncTable([
        {"id": "a", "contentid": "3451999", "is_active": False, "features": {}},
        {"id": "b", "contentid": "3486762", "is_active": False, "features": {}},
    ])
    monkeypatch.setattr("app.core.supabase.supabase_admin", _SyncAdmin(table))
    summary = ingest_tourapi.sync_showflags({"3451999": "1", "3486762": "1"})
    assert summary["reactivated"] == 1
    assert summary["reactivation_deferred"] == 1
    assert [args for _payload, args in table.updates] == [("id", "b")]
