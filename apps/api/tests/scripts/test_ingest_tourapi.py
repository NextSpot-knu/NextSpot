# scripts/ingest_tourapi.py 일배치의 일시 실패 내성.
#
# 2026-09-15·19·20·22 일배치 실패는 전부 첫 locationBasedList2 가 10초 만에 httpx 타임아웃
# (str(e) 가 빈 문자열 → 로그 `error=` 공란)으로 죽은 것이었다.
# 목록 호출에 재시도가 없어 한 번의 끊김이 배치 전체를 exit 1 로 끝냈다.
#   A. client._get 이 전송 실패만 TourAPITransientError 로 구분하는지
#   B. 배치의 목록 호출이 일시 실패만, 정해진 횟수까지 재시도하는지

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
async def test_get_classifies_5xx_as_transient(monkeypatch):
    _use_transport(monkeypatch, lambda request: httpx.Response(503, text="busy"))
    with pytest.raises(TourAPITransientError):
        await tourapi_client._get("locationBasedList2", {"pageNo": 1})


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
