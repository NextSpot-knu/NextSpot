"""GET /api/v1/infrastructures/live-detail/{contentid} (POI 상세 실시간 조회) 엔드포인트 테스트.

infrastructures 라우터만 격리 마운트하고 tourapi.detail_common/detail_intro 를 패치해
필드 추출·무해 폴백·레이트리밋을 결정적으로 검증한다(외부 TourAPI 호출 없음).
"""

import pytest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import infrastructures


@pytest.fixture(autouse=True)
def _isolate_rate_limit():
    """live-detail 의 인메모리 IP 리밋 저장소(모듈 전역 dict)를 매 테스트 초기화."""
    infrastructures._live_detail_hits.clear()
    yield
    infrastructures._live_detail_hits.clear()


def _make_client() -> TestClient:
    app = FastAPI()
    app.include_router(infrastructures.router)
    return TestClient(app)


def _detail_common_payload(**item) -> dict:
    return {
        "response": {
            "header": {"resultCode": "0000", "resultMsg": "OK"},
            "body": {"items": {"item": item} if item else {"item": ""}, "totalCount": 1 if item else 0},
        }
    }


def _detail_intro_payload(**item) -> dict:
    return {
        "response": {
            "header": {"resultCode": "0000", "resultMsg": "OK"},
            "body": {"items": {"item": item} if item else {"item": ""}, "totalCount": 1 if item else 0},
        }
    }


def test_live_detail_success_returns_fields():
    common = AsyncMock(return_value=_detail_common_payload(
        overview="정갈한 한정식",
        homepage='<a href="http://gyeongju-food.kr" target="_blank">공식</a>',
        firstimage="http://tong.visitkorea.or.kr/img.jpg",
        tel="054-111-2222",
    ))
    # 음식점(39): 운영시간/휴무일 필드명은 opentimefood/restdatefood.
    intro = AsyncMock(return_value=_detail_intro_payload(
        opentimefood="10:00~21:00",
        restdatefood="매주 월요일",
    ))
    with patch.object(infrastructures.tourapi, "detail_common", common), \
         patch.object(infrastructures.tourapi, "detail_intro", intro):
        res = _make_client().get("/api/v1/infrastructures/live-detail/2903556", params={"contentTypeId": 39})

    assert res.status_code == 200
    body = res.json()
    assert body["source"] == "tourapi-live"
    assert body["operatingHours"] == {"open": "10:00~21:00", "closed": "매주 월요일"}
    assert body["overview"] == "정갈한 한정식"
    # homepage 는 anchor 에서 href 만 추출(extract_detail_common), image 는 http→https 승격.
    assert body["homepage"] == "http://gyeongju-food.kr"
    assert body["imageUrl"] == "https://tong.visitkorea.or.kr/img.jpg"
    assert body["phone"] == "054-111-2222"
    # detailIntro2 는 요청한 contentTypeId(39)로 조회돼야 한다.
    assert intro.await_args.args[1] == 39


def test_live_detail_tourapi_exception_returns_unavailable_200():
    # 키 미설정(RuntimeError)·API 오류 모두 500 이 아니라 200 + source="unavailable" 로 흡수돼야 한다.
    with patch.object(infrastructures.tourapi, "detail_common", AsyncMock(side_effect=RuntimeError("TOURAPI_KEY 없음"))), \
         patch.object(infrastructures.tourapi, "detail_intro", AsyncMock(side_effect=RuntimeError("TOURAPI_KEY 없음"))):
        res = _make_client().get("/api/v1/infrastructures/live-detail/2903556", params={"contentTypeId": 39})

    assert res.status_code == 200
    assert res.json() == {"source": "unavailable"}


def test_live_detail_partial_success_keeps_the_half_that_worked():
    # detailCommon2 성공, detailIntro2 실패 — 성공한 절반(개요)만 살고 운영시간은 생략된다.
    with patch.object(infrastructures.tourapi, "detail_common",
                      AsyncMock(return_value=_detail_common_payload(overview="개요"))), \
         patch.object(infrastructures.tourapi, "detail_intro",
                      AsyncMock(side_effect=RuntimeError("network"))):
        res = _make_client().get("/api/v1/infrastructures/live-detail/2903556", params={"contentTypeId": 39})

    assert res.status_code == 200
    body = res.json()
    assert body["source"] == "tourapi-live"
    assert body["overview"] == "개요"
    assert "operatingHours" not in body


def test_live_detail_rate_limited_degrades_silently():
    # 분당 한도(_LIVE_DETAIL_RATE_LIMIT) 초과 요청은 500/429 가 아니라 조용히 unavailable(200).
    with patch.object(infrastructures.tourapi, "detail_common",
                      AsyncMock(return_value=_detail_common_payload(overview="개요"))), \
         patch.object(infrastructures.tourapi, "detail_intro",
                      AsyncMock(return_value=_detail_intro_payload())):
        client = _make_client()
        for _ in range(infrastructures._LIVE_DETAIL_RATE_LIMIT):
            ok = client.get("/api/v1/infrastructures/live-detail/x", params={"contentTypeId": 39})
            assert ok.json()["source"] == "tourapi-live"
        blocked = client.get("/api/v1/infrastructures/live-detail/x", params={"contentTypeId": 39})

    assert blocked.status_code == 200
    assert blocked.json() == {"source": "unavailable"}
