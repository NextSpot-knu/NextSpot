"""퍼블릭 도메인 Wikimedia 장소 이미지의 보수적 폴백 조회."""

import math
import re
from typing import Any
from urllib.parse import unquote

import httpx

API_URL = "https://ko.wikipedia.org/w/api.php"
USER_AGENT = "NextSpot/1.0 (tourism contest; https://github.com/NextSpot-knu/NextSpot)"


def _distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6_371_000 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


async def find_reusable_place_image(name: str, lat: float, lng: float) -> dict[str, str] | None:
    """정확한 문서명·1km 이내 좌표·재사용 가능 라이선스를 모두 만족할 때만 반환한다."""
    params = {
        "action": "query", "format": "json", "origin": "*", "redirects": "1",
        "titles": name, "prop": "coordinates|pageimages|info", "piprop": "name|thumbnail",
        "pithumbsize": "1200", "inprop": "url",
    }
    async with httpx.AsyncClient(timeout=8.0, headers={"User-Agent": USER_AGENT}) as client:
        response = await client.get(API_URL, params=params)
        response.raise_for_status()
        pages = response.json().get("query", {}).get("pages", {})
        page = next((p for p in pages.values() if "missing" not in p), None)
        if not isinstance(page, dict) or str(page.get("title", "")).strip() != name.strip():
            return None
        coords = page.get("coordinates") or []
        if not coords or _distance_m(lat, lng, float(coords[0]["lat"]), float(coords[0]["lon"])) > 1000:
            return None
        filename = page.get("pageimage")
        thumbnail = (page.get("thumbnail") or {}).get("source")
        if not filename or not thumbnail:
            return None

        meta_response = await client.get(API_URL, params={
            "action": "query", "format": "json", "origin": "*", "titles": f"File:{filename}",
            "prop": "imageinfo", "iiprop": "extmetadata|descriptionurl",
        })
        meta_response.raise_for_status()
        meta_pages: dict[str, Any] = meta_response.json().get("query", {}).get("pages", {})
        image_info = next(iter(meta_pages.values())).get("imageinfo", [{}])[0]
        metadata = image_info.get("extmetadata", {})
        license_name = unquote(str((metadata.get("LicenseShortName") or {}).get("value", "")))
        allowed = "public domain" in license_name.lower() or license_name.upper() in {"CC0", "PDM"}
        allowed = allowed or license_name.upper().startswith(("CC BY", "CC-BY"))
        if not allowed:
            return None
        artist_html = str((metadata.get("Artist") or {}).get("value", ""))
        artist = re.sub(r"<[^>]+>", "", artist_html).strip()
        return {
            "url": str(thumbnail),
            "source_url": str(image_info.get("descriptionurl") or page.get("fullurl") or ""),
            "license": license_name,
            "artist": artist,
        }
