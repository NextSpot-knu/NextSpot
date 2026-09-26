# scripts/ingest_tourapi.py 일배치의 일시 실패 내성.
#
# 2026-09-15·19·20·22 일배치 실패는 전부 첫 locationBasedList2 가 10초 만에 httpx 타임아웃
# (str(e) 가 빈 문자열 → 로그 `error=` 공란)으로 죽은 것이었다.
# 목록 호출에 재시도가 없어 한 번의 끊김이 배치 전체를 exit 1 로 끝냈다.
#   A. client._get 이 전송 실패만 TourAPITransientError 로 구분하는지
#   B. 배치의 목록 호출이 일시 실패만, 정해진 횟수까지 재시도하는지
#   C. 종료 코드 — 75(새 러너 재시도 대상)는 목록 수집 단계의 일시 오류에서만 나오는지.
#      상세 조회를 끝낸 뒤의 실패(예: Supabase 조회 실패로 적재 0행)가 75 가 되면 ingest.yml 이
#      상세 조회를 두 번 더 돌려 TourAPI 쿼터를 세 배로 태운다(2026-09-26 리뷰 지적).

import sys

import httpx
import pytest

import scripts.ingest_tourapi as ingest_tourapi
from app.services.tourapi import client as tourapi_client
from app.services.tourapi.client import TourAPIError, TourAPITransientError


def _ok_payload(items: list[dict]) -> dict:
    return {
        "response": {
            "header": {"resultCode": "0000", "resultMsg": "OK"},
            "body": {"items": {"item": items}, "totalCount": len(items)},
        }
    }


def _use_transport(monkeypatch, handler) -> None:
    monkeypatch.setattr(tourapi_client.settings, "TOURAPI_KEY", "test-key")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(tourapi_client, "_get_client", lambda: client)


# ---------------------------------------------------------------------------
# A. 실패 분류
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_classifies_connect_timeout_as_transient(monkeypatch):
    def handler(request):
        raise httpx.ConnectTimeout("", request=request)

    _use_transport(monkeypatch, handler)
    with pytest.raises(TourAPITransientError):
        await tourapi_client._get("locationBasedList2", {"pageNo": 1})


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [429, 500, 503])
async def test_get_classifies_throttle_and_5xx_as_transient(monkeypatch, status):
    # 429(호출 한도 일시 초과)·5xx(게이트웨이 과부하)는 조금 뒤 다시 부르면 통과할 수 있다.
    _use_transport(monkeypatch, lambda request: httpx.Response(status, text="busy"))
    with pytest.raises(TourAPITransientError):
        await tourapi_client._get("locationBasedList2", {"pageNo": 1})


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 403])
async def test_get_keeps_auth_errors_non_transient(monkeypatch, status):
    # 인증·권한 거부는 다시 불러도 같다 — 재시도·새 러너 재실행 대상이 아니다.
    _use_transport(monkeypatch, lambda request: httpx.Response(status, text="denied"))
    with pytest.raises(TourAPIError) as excinfo:
        await tourapi_client._get("locationBasedList2", {"pageNo": 1})
    assert not isinstance(excinfo.value, TourAPITransientError)


@pytest.mark.asyncio
async def test_get_keeps_non_json_gateway_error_non_transient(monkeypatch):
    # 인증키 오류 등은 200 + XML 로 온다 — 다시 불러도 같으므로 재시도 대상이 아니다.
    xml = "<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>"
    _use_transport(monkeypatch, lambda request: httpx.Response(200, text=xml))
    with pytest.raises(TourAPIError) as excinfo:
        await tourapi_client._get("locationBasedList2", {"pageNo": 1})
    assert not isinstance(excinfo.value, TourAPITransientError)


# ---------------------------------------------------------------------------
# B. 배치 목록 호출 재시도
# ---------------------------------------------------------------------------

@pytest.fixture
def no_retry_sleep(monkeypatch):
    monkeypatch.setattr(ingest_tourapi, "LIST_RETRY_DELAYS_S", (0.0, 0.0, 0.0))


@pytest.mark.asyncio
async def test_fetch_pois_retries_transient_failure_then_succeeds(monkeypatch, no_retry_sleep):
    calls: list[int] = []

    async def flaky_list(**kwargs):
        calls.append(kwargs["content_type_id"])
        if len(calls) <= 2:  # 첫 호출 두 번이 타임아웃 — 실제 실패 로그와 같은 지점
            raise TourAPITransientError("timeout")
        return _ok_payload([{"contentid": str(len(calls))}])

    monkeypatch.setattr(ingest_tourapi, "location_based_list", flaky_list)
    collected = await ingest_tourapi.fetch_pois(35.8, 129.2, 3000, limit=0)

    assert all(len(items) == 1 for items in collected.values())
    # 첫 타입에서 2회 실패 후 성공(3회) + 나머지 타입 각 1회.
    assert len(calls) == 3 + (len(ingest_tourapi.CONTENT_TYPE_IDS) - 1)


@pytest.mark.asyncio
async def test_fetch_pois_gives_up_after_bounded_attempts(monkeypatch, no_retry_sleep):
    calls = 0

    async def always_down(**kwargs):
        nonlocal calls
        calls += 1
        raise TourAPITransientError("timeout")

    monkeypatch.setattr(ingest_tourapi, "location_based_list", always_down)
    with pytest.raises(TourAPITransientError):
        await ingest_tourapi.fetch_pois(35.8, 129.2, 3000, limit=0)
    assert calls == len(ingest_tourapi.LIST_RETRY_DELAYS_S) + 1


@pytest.mark.asyncio
async def test_fetch_pois_does_not_retry_result_code_errors(monkeypatch, no_retry_sleep):
    calls = 0

    async def bad_key(**kwargs):
        nonlocal calls
        calls += 1
        raise TourAPIError("resultCode=30")

    monkeypatch.setattr(ingest_tourapi, "location_based_list", bad_key)
    with pytest.raises(TourAPIError):
        await ingest_tourapi.fetch_pois(35.8, 129.2, 3000, limit=0)
    assert calls == 1


@pytest.mark.asyncio
async def test_fetch_showflag_map_retries_transient_failure(monkeypatch, no_retry_sleep):
    calls = 0

    async def flaky_sync(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise TourAPITransientError("timeout")
        return _ok_payload([{"contentid": "1", "showflag": "1"}])

    monkeypatch.setattr(ingest_tourapi, "area_based_sync_list", flaky_sync)
    result = await ingest_tourapi.fetch_showflag_map()
    assert result == {"1": "1"}
    assert calls == 2


# ---------------------------------------------------------------------------
# C. 종료 코드 — ingest.yml 은 75 일 때만 새 러너로 다시 돈다
# ---------------------------------------------------------------------------

class _RecordingAdmin:
    """supabase_admin 대역 — app_events 기록만 받아 적는다(실 DB·네트워크 없음)."""

    def __init__(self) -> None:
        self.inserts: list[tuple[str, dict]] = []

    def table(self, name: str):
        admin = self

        class _Query:
            def insert(self, payload):
                admin.inserts.append((name, payload))
                return self

            def execute(self):
                return None

        return _Query()


@pytest.fixture
def batch_env(monkeypatch, no_retry_sleep):
    """main() 을 네트워크·DB 없이 돌리는 공통 대역. 호출 기록을 돌려준다."""
    admin = _RecordingAdmin()
    record: dict = {"enrich": 0, "upsert": 0, "admin": admin}
    monkeypatch.setattr("app.core.supabase.supabase_admin", admin)
    monkeypatch.delenv("KAKAO_REST_API_KEY", raising=False)

    async def fake_enrich(row):
        record["enrich"] += 1

    def fake_upsert(rows):
        record["upsert"] += 1
        return len(rows)

    monkeypatch.setattr(ingest_tourapi, "enrich_row", fake_enrich)
    monkeypatch.setattr(ingest_tourapi, "upsert_facilities", fake_upsert)
    return record


def _one_poi_fetch(monkeypatch) -> None:
    """목록 수집이 POI 1곳으로 성공한 상태를 만든다(변환도 고정)."""
    async def fake_fetch(lat, lng, radius_m, limit):
        return {12: [{"contentid": "100"}]}

    monkeypatch.setattr(ingest_tourapi, "fetch_pois", fake_fetch)
    monkeypatch.setattr(ingest_tourapi, "transform_poi", lambda item: {
        "contentid": item["contentid"], "contenttypeid": 12, "type": "attraction",
        "name": "테스트 관광지", "latitude": 35.83, "longitude": 129.21,
    })


def _run_main(monkeypatch, *argv: str) -> int:
    monkeypatch.setattr(sys, "argv", ["ingest_tourapi.py", *argv])
    with pytest.raises(SystemExit) as excinfo:
        ingest_tourapi.main()
    return excinfo.value.code


def test_main_exits_tempfail_when_list_calls_stay_transient(monkeypatch, batch_env):
    # 09-15·19·20·22 모양: 첫 목록 호출이 재시도를 다 써도 타임아웃. 상세 조회·DB 쓰기 전에 75 로 끝난다.
    calls = 0

    async def always_down(**kwargs):
        nonlocal calls
        calls += 1
        raise TourAPITransientError("timeout")

    monkeypatch.setattr(ingest_tourapi, "location_based_list", always_down)
    assert _run_main(monkeypatch, "--details", "--radius", "3000") == ingest_tourapi.EXIT_TEMPFAIL == 75
    assert calls == len(ingest_tourapi.LIST_RETRY_DELAYS_S) + 1
    assert batch_env["enrich"] == 0
    assert batch_env["upsert"] == 0
    assert batch_env["admin"].inserts == []


def test_main_exits_1_on_non_transient_list_error(monkeypatch, batch_env):
    async def bad_key(**kwargs):
        raise TourAPIError("resultCode=30")

    monkeypatch.setattr(ingest_tourapi, "location_based_list", bad_key)
    assert _run_main(monkeypatch, "--details") == 1


def test_main_exits_1_when_nothing_is_written_after_the_sweep(monkeypatch, batch_env):
    # 리뷰 지적 시나리오: 상세 조회를 끝낸 뒤 Supabase 조회가 죽어 upsert 가 0행 → 1(재시도 없음).
    _one_poi_fetch(monkeypatch)
    monkeypatch.setattr(ingest_tourapi, "upsert_facilities", lambda rows: 0)

    async def degraded_sync(written):
        return {"checked": 0, "deactivated": [], "reactivated": 0,
                "degraded": True, "reason": "facilities 조회 실패"}

    monkeypatch.setattr(ingest_tourapi, "run_showflag_sync", degraded_sync)
    assert _run_main(monkeypatch, "--details") == 1
    assert batch_env["enrich"] == 1


def test_main_transient_error_after_list_fetch_is_not_tempfail(monkeypatch, batch_env):
    # 목록 수집 뒤에 새어 나온 일시 오류는(지금은 enrich_row 가 삼키지만 앞으로 누가 호출을 더해도)
    # 75 가 아니라 1 이다 — 상세 조회를 이미 시작했으니 새 러너 재실행은 쿼터만 더 쓴다.
    _one_poi_fetch(monkeypatch)

    async def leaking_enrich(row):
        raise TourAPITransientError("timeout")

    monkeypatch.setattr(ingest_tourapi, "enrich_row", leaking_enrich)
    assert _run_main(monkeypatch, "--details", "--no-sync") == 1
    assert batch_env["upsert"] == 0


def test_main_exits_0_on_success(monkeypatch, batch_env):
    _one_poi_fetch(monkeypatch)
    assert _run_main(monkeypatch, "--details", "--no-sync") == 0
    assert batch_env["enrich"] == 1
    assert batch_env["upsert"] == 1
    assert [name for name, _ in batch_env["admin"].inserts] == ["app_events"]
