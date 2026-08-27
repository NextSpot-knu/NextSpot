import httpx
import pytest

from app.services import kakao_place_search_service as service
from app.services.kakao_place_search_service import (
    expand_place_search_queries,
    normalize_place_documents,
    search_kakao_places,
)


def _document(place_id: str, *, name: str | None = None) -> dict:
    return {
        "id": place_id,
        "place_name": name or f"식당-{place_id}",
        "road_address_name": "경북 경주시 포석로 1",
        "x": "129.2105",
        "y": "35.8361",
        "category_group_code": "FD6",
        "category_name": "음식점 > 한식",
    }


class _Response:
    def __init__(self, documents: list[dict]):
        self._documents = documents

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {"documents": self._documents}


class _Client:
    def __init__(self, results: dict[str, list[dict] | Exception]):
        self._results = results

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, _url, *, params, headers):
        result = self._results[params["query"]]
        if isinstance(result, Exception):
            raise result
        return _Response(result)


def _stub_client(monkeypatch, results: dict[str, list[dict] | Exception]) -> None:
    monkeypatch.setattr(service.settings, "KAKAO_REST_API_KEY", "test-key")
    monkeypatch.setattr(service.httpx, "AsyncClient", lambda **_kwargs: _Client(results))


def test_expand_search_queries_adds_bounded_menu_synonyms():
    assert expand_place_search_queries("돼지고기") == ["돼지고기", "삼겹살", "돼지갈비"]
    assert expand_place_search_queries("라떼 맛집") == ["라떼 맛집", "카페라떼"]
    assert expand_place_search_queries("테라로사") == ["테라로사"]


def test_expand_search_queries_does_not_treat_fish_words_as_meat_intent():
    assert expand_place_search_queries("물고기 체험") == ["물고기 체험"]
    assert expand_place_search_queries("고기잡이") == ["고기잡이"]
    assert expand_place_search_queries("고기 먹고 싶어") == ["고기 먹고 싶어", "고깃집", "삼겹살"]
    assert expand_place_search_queries("구이 추천") == ["구이 추천", "고깃집", "숯불구이"]


def test_normalize_keeps_name_address_and_coordinates_from_same_place():
    rows = normalize_place_documents([{
        "id": "1526605585",
        "place_name": "테라로사 경주점",
        "road_address_name": "경북 경주시 포석로 988",
        "x": "129.209947126629",
        "y": "35.8296691510212",
        "category_group_code": "CE7",
        "category_name": "음식점 > 카페",
        "place_url": "https://place.map.kakao.com/1526605585",
    }])
    assert rows == [{
        "place_id": "1526605585",
        "name": "테라로사 경주점",
        "type": "cafe",
        "latitude": 35.8296691510212,
        "longitude": 129.209947126629,
        "address": "경북 경주시 포석로 988",
        "phone": None,
        "place_url": "https://place.map.kakao.com/1526605585",
        "category_name": "음식점 > 카페",
    }]


def test_normalize_rejects_non_gyeongju_and_invalid_coordinates():
    assert normalize_place_documents([
        {"id": "1", "place_name": "서울점", "address_name": "서울 강남구", "x": "127", "y": "37"},
        {"id": "2", "place_name": "좌표오류", "address_name": "경북 경주시", "x": "x", "y": "y"},
    ]) == []


@pytest.mark.asyncio
async def test_search_keeps_original_results_when_synonym_request_fails(monkeypatch):
    original = _document("original")
    _stub_client(monkeypatch, {
        "라떼": [original],
        "카페라떼": httpx.ReadTimeout("synonym timeout"),
    })

    rows = await search_kakao_places("라떼")

    assert [row["place_id"] for row in rows] == ["original"]


@pytest.mark.asyncio
async def test_search_deduplicates_by_place_id_preserves_original_order_and_caps_ten(monkeypatch):
    original = [_document(str(index)) for index in range(1, 9)]
    first_synonym = [
        _document("1", name="동의어가 반환한 중복 이름"),
        *[_document(str(index)) for index in range(9, 13)],
    ]
    second_synonym = [_document(str(index)) for index in range(13, 18)]
    _stub_client(monkeypatch, {
        "돼지고기": original,
        "삼겹살": first_synonym,
        "돼지갈비": second_synonym,
    })

    rows = await search_kakao_places("돼지고기")

    assert [row["place_id"] for row in rows] == [str(index) for index in range(1, 11)]
    assert rows[0]["name"] == "식당-1"
