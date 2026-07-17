import pytest

from app.services import restroom_service
from app.services.restroom_service import _distance_m, find_nearby_restrooms


def test_distance_is_zero_for_same_point():
    assert _distance_m(35.8361, 129.2105, 35.8361, 129.2105) == 0


def test_distance_is_symmetric():
    forward = _distance_m(35.8361, 129.2105, 35.8347, 129.2191)
    reverse = _distance_m(35.8347, 129.2191, 35.8361, 129.2105)
    assert forward == reverse
    assert 700 < forward < 900


# --- '화장실' 키워드 검색의 노이즈 필터·페이지네이션 (2026-07-18 실측 기반 회귀 가드) ---------
# 배경: '공중화장실' 키워드는 황리단길에서 1건뿐이었고 그마저 월정교(문화유적) 오탐이었다.
# '화장실' 키워드 + 카테고리('가정,생활 > 화장실') 필터 + 최대 3페이지 수집으로 교체.

_LAT, _LNG = 35.8380, 129.2115


def _doc(doc_id: str, name: str, category: str, lat: float, lng: float) -> dict:
    return {"id": doc_id, "place_name": name, "category_name": category,
            "y": str(lat), "x": str(lng), "address_name": "경주시", "place_url": ""}


class _FakeResponse:
    def __init__(self, payload: dict):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _FakeClient:
    """페이지 순서대로 canned 응답을 돌려주는 httpx.AsyncClient 대역."""

    def __init__(self, pages: list[dict]):
        self._pages = pages
        self.requested_pages: list[int] = []

    def __call__(self, *args, **kwargs):  # httpx.AsyncClient(timeout=...) 흉내
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url, params=None, headers=None):
        self.requested_pages.append(int(params["page"]))
        return _FakeResponse(self._pages[min(len(self.requested_pages) - 1, len(self._pages) - 1)])


@pytest.mark.asyncio
async def test_filters_non_restroom_categories(monkeypatch):
    # 키워드 노이즈(문화유적 월정교)는 카테고리 필터로 제외돼야 한다.
    pages = [{
        "documents": [
            _doc("1", "대릉원 화장실", "가정,생활 > 화장실", _LAT + 0.001, _LNG),
            _doc("2", "월정교", "여행 > 관광,명소 > 문화유적", _LAT + 0.002, _LNG),
        ],
        "meta": {"is_end": True},
    }]
    fake = _FakeClient(pages)
    monkeypatch.setattr(restroom_service.settings, "KAKAO_REST_API_KEY", "test-key")
    monkeypatch.setattr(restroom_service.httpx, "AsyncClient", fake)
    results = await find_nearby_restrooms(_LAT, _LNG)
    assert [r["name"] for r in results] == ["대릉원 화장실"]


@pytest.mark.asyncio
async def test_paginates_until_is_end_and_dedupes(monkeypatch):
    # is_end=False 면 다음 페이지를 이어 받고(최대 3페이지), 중복 id 는 1건으로 합친다.
    page1 = {
        "documents": [_doc("1", "화장실A", "가정,생활 > 화장실", _LAT + 0.001, _LNG)],
        "meta": {"is_end": False},
    }
    page2 = {
        "documents": [
            _doc("1", "화장실A", "가정,생활 > 화장실", _LAT + 0.001, _LNG),  # 중복
            _doc("2", "화장실B", "가정,생활 > 화장실", _LAT + 0.002, _LNG),
        ],
        "meta": {"is_end": True},
    }
    fake = _FakeClient([page1, page2])
    monkeypatch.setattr(restroom_service.settings, "KAKAO_REST_API_KEY", "test-key")
    monkeypatch.setattr(restroom_service.httpx, "AsyncClient", fake)
    results = await find_nearby_restrooms(_LAT, _LNG)
    assert fake.requested_pages == [1, 2]
    assert sorted(r["name"] for r in results) == ["화장실A", "화장실B"]


@pytest.mark.asyncio
async def test_radius_filter_still_applies(monkeypatch):
    # 카카오 radius 는 근사치 — 서비스의 Haversine 재검증이 반경 밖(약 5.5km)을 걸러야 한다.
    pages = [{
        "documents": [
            _doc("1", "가까운 화장실", "가정,생활 > 화장실", _LAT + 0.001, _LNG),
            _doc("2", "먼 화장실", "가정,생활 > 화장실", _LAT + 0.05, _LNG),
        ],
        "meta": {"is_end": True},
    }]
    fake = _FakeClient(pages)
    monkeypatch.setattr(restroom_service.settings, "KAKAO_REST_API_KEY", "test-key")
    monkeypatch.setattr(restroom_service.httpx, "AsyncClient", fake)
    results = await find_nearby_restrooms(_LAT, _LNG, radius_m=3000)
    assert [r["name"] for r in results] == ["가까운 화장실"]


@pytest.mark.asyncio
async def test_missing_key_returns_empty(monkeypatch):
    monkeypatch.setattr(restroom_service.settings, "KAKAO_REST_API_KEY", "")
    assert await find_nearby_restrooms(_LAT, _LNG) == []
