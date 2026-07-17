from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.services.wikimedia import find_reusable_place_image


def _response(payload: dict) -> httpx.Response:
    return httpx.Response(200, json=payload, request=httpx.Request("GET", "https://example.test"))


@pytest.mark.asyncio
async def test_returns_exact_nearby_public_domain_image():
    page = {"query": {"pages": {"1": {
        "title": "첨성대", "coordinates": [{"lat": 35.8347, "lon": 129.2191}],
        "pageimage": "Cheomseongdae.jpg", "thumbnail": {"source": "https://upload.wikimedia.org/a.jpg"},
        "fullurl": "https://ko.wikipedia.org/wiki/첨성대",
    }}}}
    metadata = {"query": {"pages": {"2": {"imageinfo": [{
        "descriptionurl": "https://commons.wikimedia.org/wiki/File:Cheomseongdae.jpg",
        "extmetadata": {"LicenseShortName": {"value": "Public domain"}},
    }]}}}}
    with patch("httpx.AsyncClient.get", new=AsyncMock(side_effect=[_response(page), _response(metadata)])):
        result = await find_reusable_place_image("첨성대", 35.8347, 129.2191)
    assert result and result["url"] == "https://upload.wikimedia.org/a.jpg"
    assert result["license"] == "Public domain"


@pytest.mark.asyncio
async def test_rejects_non_public_domain_image():
    page = {"query": {"pages": {"1": {
        "title": "첨성대", "coordinates": [{"lat": 35.8347, "lon": 129.2191}],
        "pageimage": "Cheomseongdae.jpg", "thumbnail": {"source": "https://upload.wikimedia.org/a.jpg"},
    }}}}
    metadata = {"query": {"pages": {"2": {"imageinfo": [{
        "extmetadata": {"LicenseShortName": {"value": "All rights reserved"}},
    }]}}}}
    with patch("httpx.AsyncClient.get", new=AsyncMock(side_effect=[_response(page), _response(metadata)])):
        assert await find_reusable_place_image("첨성대", 35.8347, 129.2191) is None
