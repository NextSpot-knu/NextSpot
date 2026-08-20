"""경주시 ITS와 한국교통안전공단 주차정보를 지역 수요 신호로 변환한다.

주차 점유율은 특정 카페·식당 내부 혼잡이 아니다. 후보 반경 2km의 공영 주차 수요를
거리·주차면수로 가중해 ``parking_live`` 지역 신호만 만든다. 시설 위치는 하루, 실시간
가용면은 5분 캐시한다. 키가 필요 없는 경주시 ITS를 우선하고 전국 API를 보조로 사용한다.
"""

from __future__ import annotations

import asyncio
import json
import re
import ssl
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

import httpx
import structlog

from app.core.config import settings
from app.services.spot.travel import calculate_haversine_distance

logger = structlog.get_logger()

_FACILITY_ENDPOINT = "PrkSttusInfo"
_REALTIME_ENDPOINT = "PrkRealtimeInfo"
_FACILITY_TTL = 24 * 60 * 60.0
_REALTIME_TTL = 5 * 60.0
_FAIL_TTL = 10 * 60.0
_RADIUS_M = 2_000.0
_PAGE_SIZE = 1_000
_MAX_PAGES = 20
_REQUEST_TIMEOUT_SECONDS = 20.0
_CITY_REQUEST_TIMEOUT_SECONDS = 8.0
_MAX_ATTEMPTS = 2
_GYEONGJU_ITS_INTERMEDIATE_CA = (
    Path(__file__).resolve().parent.parent / "certs" / "sectigo_rsa_organization_validation_secure_server_ca.crt"
)

_facility_cache: tuple[float, float, list[dict[str, Any]]] | None = None
_realtime_cache: tuple[float, float, dict[str, dict[str, int]]] | None = None
_facility_lock = asyncio.Lock()
_realtime_lock = asyncio.Lock()
_facility_status: dict[str, Any] = {
    "state": "not_checked", "checked_at": None, "error_code": None, "source": None
}
_realtime_status: dict[str, Any] = {
    "state": "not_checked", "checked_at": None, "error_code": None, "source": None
}
_refresh_tasks: dict[str, asyncio.Task[Any]] = {}


class ParkingUpstreamError(RuntimeError):
    """외부 API의 실패를 키나 원문 응답 없이 안전한 코드로 전달한다."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _service_key() -> str:
    return (settings.PARKING_API_KEY or settings.TOURAPI_KEY).strip()


def _items(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    # 이 API는 운영 시점에 따라 표준 response.body와 자체 최상위 배열을 모두 반환해 왔다.
    for key in (_FACILITY_ENDPOINT, _REALTIME_ENDPOINT):
        raw_top_level = payload.get(key)
        if isinstance(raw_top_level, dict):
            return [raw_top_level]
        if isinstance(raw_top_level, list):
            return [row for row in raw_top_level if isinstance(row, dict)]
    body = payload.get("response", {}).get("body", {})
    raw = body.get("items", {})
    if isinstance(raw, dict):
        raw = raw.get("item", [])
    if isinstance(raw, dict):
        return [raw]
    return [row for row in raw if isinstance(row, dict)] if isinstance(raw, list) else []


def _total_count(payload: Any) -> int:
    try:
        nested = payload.get("response", {}).get("body", {}).get("totalCount")
        return int(payload.get("totalCount", nested or 0))
    except (AttributeError, TypeError, ValueError):
        return 0


def _xml_payload(text: str) -> dict[str, Any]:
    """공공데이터포털 XML을 기존 JSON과 같은 최소 구조로 변환한다."""
    try:
        root = ElementTree.fromstring(text.lstrip("\ufeff\r\n\t "))
    except ElementTree.ParseError as exc:
        raise ParkingUpstreamError("invalid_response") from exc

    def value(path: str, default: str = "") -> str:
        node = root.find(path)
        return (node.text or "").strip() if node is not None else default

    items: list[dict[str, Any]] = []
    for item in root.findall("./body/items/item"):
        items.append({child.tag: (child.text or "").strip() for child in item})
    return {
        "response": {
            "header": {
                "resultCode": value("./header/resultCode"),
                "resultMsg": value("./header/resultMsg"),
            },
            "body": {
                "items": {"item": items},
                "totalCount": value("./body/totalCount", "0"),
            },
        }
    }


def _parse_payload(response: httpx.Response) -> dict[str, Any]:
    """정상 JSON/XML과 공공데이터 게이트웨이의 비표준 오류 응답을 구분한다."""
    text = response.text.strip()
    if not text:
        raise ParkingUpstreamError("empty_response")
    if text.startswith("<"):
        return _xml_payload(text)
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        # 일부 장애/미승인 응답은 JSON처럼 보이지만 키에 따옴표가 없는 text/html이다.
        result_code = re.search(r"result_code\s*:\s*['\"]?([^,'\"}\s]+)", text)
        if result_code:
            code = result_code.group(1)
            raise ParkingUpstreamError("upstream_rejected" if code == "-999" else f"upstream_{code}") from exc
        raise ParkingUpstreamError("invalid_response") from exc
    if not isinstance(payload, dict):
        raise ParkingUpstreamError("invalid_response")
    return payload


def _result_code(payload: dict[str, Any]) -> str:
    try:
        if "resultCode" in payload:
            return str(payload["resultCode"])
        return str(payload["response"]["header"]["resultCode"])
    except (KeyError, TypeError):
        raise ParkingUpstreamError("invalid_response") from None


def _checked_at() -> str:
    return datetime.now(timezone.utc).isoformat()


def _float(row: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        try:
            value = float(row.get(key))
        except (TypeError, ValueError):
            continue
        return value
    return None


def _int(row: dict[str, Any], *keys: str) -> int | None:
    value = _float(row, *keys)
    return max(0, int(value)) if value is not None else None


def _is_gyeongju(row: dict[str, Any], lat: float, lng: float) -> bool:
    address = str(row.get("prk_plce_adres") or "")
    return "경주" in address or (35.5 <= lat <= 36.2 and 128.8 <= lng <= 129.6)


def normalize_facilities(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = []
    for row in rows:
        parking_id = str(row.get("prk_center_id") or "").strip()
        lat = _float(row, "prk_plce_entrc_la")
        lng = _float(row, "prk_plce_entrc_lo")
        if not parking_id or lat is None or lng is None or not _is_gyeongju(row, lat, lng):
            continue
        normalized.append({
            "id": parking_id,
            "name": str(row.get("prk_plce_nm") or "").strip() or parking_id,
            "latitude": lat,
            "longitude": lng,
        })
    return normalized


def normalize_realtime(rows: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    normalized: dict[str, dict[str, int]] = {}
    for row in rows:
        parking_id = str(row.get("prk_center_id") or "").strip()
        total = _int(row, "pkfc_ParkingLots_total", "pkfc_parkinglots_total")
        available = _int(row, "pkfc_Available_ParkingLots_total", "pkfc_available_parkinglots_total")
        if not parking_id or total is None or total <= 0 or available is None:
            continue
        normalized[parking_id] = {"total": total, "available": min(total, available)}
    return normalized


def normalize_gyeongju_its(
    rows: list[dict[str, Any]], details: dict[str, dict[str, Any]]
) -> tuple[list[dict[str, Any]], dict[str, dict[str, int]]]:
    """경주시 ITS 공개 응답을 공통 시설/실시간 구조로 변환한다."""
    facilities: list[dict[str, Any]] = []
    realtime: dict[str, dict[str, int]] = {}
    for row in rows:
        parking_id = str(row.get("FCLTS_SN") or "").strip()
        latitude = _float(row, "Y_DNTS")
        longitude = _float(row, "X_CNTS")
        if not parking_id or latitude is None or longitude is None:
            continue
        facilities.append({
            "id": f"gyeongju-its:{parking_id}",
            "name": str(row.get("FCLTS_NM") or "").strip() or parking_id,
            "latitude": latitude,
            "longitude": longitude,
        })
        detail = details.get(parking_id) or {}
        total = _int(detail, "TOT_PARKNG_NOPG")
        available = _int(detail, "TOTAL_IMP_CNT")
        if str(row.get("STTS") or "").upper() != "Y":
            continue
        if total is None or total <= 0 or available is None:
            continue
        realtime[f"gyeongju-its:{parking_id}"] = {
            "total": total,
            "available": min(total, available),
        }
    return facilities, realtime


async def _fetch_gyeongju_its() -> tuple[list[dict[str, Any]], dict[str, dict[str, int]]]:
    """경주시 공식 주차 화면이 사용하는 공개 JSON에서 실시간 잔여면을 조회한다."""
    base_url = settings.GYEONGJU_ITS_BASE_URL.rstrip("/")
    if not base_url:
        raise ParkingUpstreamError("city_its_not_configured")
    headers = {
        "Accept": "application/json",
        "Referer": f"{base_url}/pisinfo.do",
        "User-Agent": "NextSpot/1.0 (+public-tourism-service)",
    }
    # 경주시 서버가 Sectigo 중간 인증서를 전송하지 않아 일반 Python CA 번들에서는 검증이 실패한다.
    # 검증을 끄지 않고, 인증서 AIA가 가리키는 2030-12-31 만료 중간 CA를 보완해 체인을 완성한다.
    tls_context = ssl.create_default_context()
    tls_context.load_verify_locations(cafile=str(_GYEONGJU_ITS_INTERMEDIATE_CA))
    try:
        async with httpx.AsyncClient(
            timeout=_CITY_REQUEST_TIMEOUT_SECONDS,
            follow_redirects=True,
            headers=headers,
            verify=tls_context,
        ) as client:
            response = await client.get(f"{base_url}/selectPisListAjax.do")
            response.raise_for_status()
            payload = response.json()
            rows = payload.get("searchList") if isinstance(payload, dict) else None
            if not isinstance(rows, list):
                raise ParkingUpstreamError("city_its_invalid_response")

            async def fetch_detail(row: dict[str, Any]) -> tuple[str, dict[str, Any]]:
                parking_id = str(row.get("FCLTS_SN") or "").strip()
                if not parking_id or str(row.get("STTS") or "").upper() != "Y":
                    return parking_id, {}
                detail_response = await client.get(
                    f"{base_url}/getPopupDetail.do", params={"fclts_sn": parking_id}
                )
                detail_response.raise_for_status()
                detail_payload = detail_response.json()
                detail_rows = detail_payload.get("parkDetail") if isinstance(detail_payload, dict) else None
                detail = detail_rows[0] if isinstance(detail_rows, list) and detail_rows else {}
                return parking_id, detail if isinstance(detail, dict) else {}

            detail_pairs = await asyncio.gather(
                *(fetch_detail(row) for row in rows if isinstance(row, dict))
            )
    except ParkingUpstreamError:
        raise
    except (httpx.HTTPError, json.JSONDecodeError, TypeError) as exc:
        code = "city_its_timeout" if isinstance(exc, httpx.TimeoutException) else "city_its_unavailable"
        raise ParkingUpstreamError(code) from exc

    details = {parking_id: detail for parking_id, detail in detail_pairs if parking_id}
    facilities, realtime = normalize_gyeongju_its(
        [row for row in rows if isinstance(row, dict)], details
    )
    if not facilities:
        raise ParkingUpstreamError("city_its_no_facilities")
    return facilities, realtime


async def _fetch_pages(endpoint: str) -> list[dict[str, Any]]:
    key = _service_key()
    if not key:
        raise RuntimeError("parking api key unavailable")
    rows: list[dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS, follow_redirects=True) as client:
        for page in range(1, _MAX_PAGES + 1):
            response: httpx.Response | None = None
            for attempt in range(_MAX_ATTEMPTS):
                try:
                    response = await client.get(
                        f"{settings.PARKING_API_BASE_URL.rstrip('/')}/{endpoint}",
                        params={"serviceKey": key, "pageNo": page, "numOfRows": _PAGE_SIZE, "format": 2},
                    )
                    response.raise_for_status()
                    break
                except httpx.TimeoutException as exc:
                    if attempt + 1 >= _MAX_ATTEMPTS:
                        raise ParkingUpstreamError("timeout") from exc
                    await asyncio.sleep(0.25)
                except httpx.HTTPError as exc:
                    raise ParkingUpstreamError("http_error") from exc
            if response is None:
                raise ParkingUpstreamError("network_error")
            payload = _parse_payload(response)
            code = _result_code(payload)
            if code not in {"0", "00"}:
                raise ParkingUpstreamError(f"upstream_{code}" if code else "upstream_error")
            batch = _items(payload)
            rows.extend(batch)
            total = _total_count(payload)
            if not batch or len(rows) >= total:
                break
        else:
            raise ParkingUpstreamError("page_limit_exceeded")
    return rows


def _start_refresh(name: str, loader: Any) -> None:
    """외부 API 갱신을 요청 응답과 분리한다. 같은 종류의 갱신은 한 번만 실행한다."""
    global _facility_status, _realtime_status
    existing = _refresh_tasks.get(name)
    if existing is not None and not existing.done():
        return
    checking = {"state": "checking", "checked_at": None, "error_code": None, "source": None}
    if name in {"sources", "facilities"}:
        _facility_status = dict(checking)
    if name in {"sources", "realtime"}:
        _realtime_status = dict(checking)
    task = asyncio.create_task(loader(), name=f"parking-{name}-refresh")
    _refresh_tasks[name] = task

    def cleanup(done: asyncio.Task[Any]) -> None:
        _refresh_tasks.pop(name, None)
        try:
            done.result()
        except asyncio.CancelledError:
            pass
        except Exception as exc:  # loaders가 예외를 삼키지만, 회귀 시 요청 경로로 전파하지 않는다.
            logger.warning("parking_background_refresh_failed", source=name, error_type=type(exc).__name__)

    task.add_done_callback(cleanup)


def _sources_stale_while_revalidate() -> tuple[list[dict[str, Any]], dict[str, dict[str, int]]]:
    """현재 캐시를 즉시 반환하고, 누락/만료 데이터는 백그라운드에서 갱신한다."""
    now = time.monotonic()
    facilities = _facility_cache[2] if _facility_cache else []
    realtime = _realtime_cache[2] if _realtime_cache else {}
    facility_stale = _facility_cache is None or now - _facility_cache[0] >= _facility_cache[1]
    realtime_stale = _realtime_cache is None or now - _realtime_cache[0] >= _realtime_cache[1]
    if facility_stale or realtime_stale:
        _start_refresh("sources", _refresh_sources)
    return facilities, realtime


async def _facilities_cached() -> list[dict[str, Any]]:
    global _facility_cache, _facility_status
    now = time.monotonic()
    if _facility_cache and now - _facility_cache[0] < _facility_cache[1]:
        return _facility_cache[2]
    async with _facility_lock:
        now = time.monotonic()
        if _facility_cache and now - _facility_cache[0] < _facility_cache[1]:
            return _facility_cache[2]
        try:
            facilities = normalize_facilities(await _fetch_pages(_FACILITY_ENDPOINT))
            _facility_cache = (now, _FACILITY_TTL, facilities)
            _facility_status = {
                "state": "available" if facilities else "no_gyeongju_data",
                "checked_at": _checked_at(),
                "error_code": None,
                "source": "national_parking_api",
            }
            logger.info("parking_facilities_loaded", gyeongju_count=len(facilities))
        except Exception as exc:
            facilities = []
            _facility_cache = (now, _FAIL_TTL, facilities)
            error_code = exc.code if isinstance(exc, ParkingUpstreamError) else "unexpected_error"
            _facility_status = {
                "state": "unavailable",
                "checked_at": _checked_at(),
                "error_code": error_code,
                "source": "national_parking_api",
            }
            logger.warning("parking_facilities_unavailable", error_code=error_code)
        return facilities


async def _realtime_cached() -> dict[str, dict[str, int]]:
    global _realtime_cache, _realtime_status
    now = time.monotonic()
    if _realtime_cache and now - _realtime_cache[0] < _realtime_cache[1]:
        return _realtime_cache[2]
    async with _realtime_lock:
        now = time.monotonic()
        if _realtime_cache and now - _realtime_cache[0] < _realtime_cache[1]:
            return _realtime_cache[2]
        try:
            realtime = normalize_realtime(await _fetch_pages(_REALTIME_ENDPOINT))
            _realtime_cache = (now, _REALTIME_TTL, realtime)
            _realtime_status = {
                "state": "available" if realtime else "no_realtime_data",
                "checked_at": _checked_at(),
                "error_code": None,
                "source": "national_parking_api",
            }
            logger.info("parking_realtime_loaded", count=len(realtime))
        except Exception as exc:
            realtime = {}
            _realtime_cache = (now, _FAIL_TTL, realtime)
            error_code = exc.code if isinstance(exc, ParkingUpstreamError) else "unexpected_error"
            _realtime_status = {
                "state": "unavailable",
                "checked_at": _checked_at(),
                "error_code": error_code,
                "source": "national_parking_api",
            }
            logger.warning("parking_realtime_unavailable", error_code=error_code)
        return realtime


async def _refresh_sources() -> None:
    """경주시 ITS를 우선 적재하고 실패한 경우에만 전국 API를 시도한다."""
    global _facility_cache, _realtime_cache, _facility_status, _realtime_status
    now = time.monotonic()
    try:
        facilities, realtime = await _fetch_gyeongju_its()
        checked_at = _checked_at()
        _facility_cache = (now, _FACILITY_TTL, facilities)
        _realtime_cache = (now, _REALTIME_TTL, realtime)
        _facility_status = {
            "state": "available",
            "checked_at": checked_at,
            "error_code": None,
            "source": "gyeongju_its",
        }
        _realtime_status = {
            "state": "available" if realtime else "no_realtime_data",
            "checked_at": checked_at,
            "error_code": None,
            "source": "gyeongju_its",
        }
        logger.info(
            "gyeongju_its_parking_loaded",
            facility_count=len(facilities),
            realtime_count=len(realtime),
        )
        return
    except ParkingUpstreamError as exc:
        logger.warning("gyeongju_its_parking_unavailable", error_code=exc.code)
        city_error = exc.code

    if _service_key():
        await asyncio.gather(_facilities_cached(), _realtime_cached())
        return

    checked_at = _checked_at()
    _facility_cache = (now, _FAIL_TTL, [])
    _realtime_cache = (now, _FAIL_TTL, {})
    _facility_status = {
        "state": "unavailable",
        "checked_at": checked_at,
        "error_code": city_error,
        "source": "gyeongju_its",
    }
    _realtime_status = dict(_facility_status)


def _nearby_totals(
    facilities: list[dict[str, Any]], realtime: dict[str, dict[str, int]], latitude: float, longitude: float
) -> tuple[int, int, int, tuple[float, str] | None, float, float]:
    count = total_spaces = available_spaces = 0
    nearest: tuple[float, str] | None = None
    weighted = weight_total = 0.0
    for facility in facilities:
        live = realtime.get(facility["id"])
        if live is None:
            continue
        distance_m = calculate_haversine_distance(
            latitude, longitude, facility["latitude"], facility["longitude"]
        )
        if distance_m > _RADIUS_M:
            continue
        occupancy = 1.0 - live["available"] / live["total"]
        weight = min(live["total"], 500) / (1.0 + distance_m / 500.0)
        weighted += occupancy * weight
        weight_total += weight
        total_spaces += live["total"]
        available_spaces += live["available"]
        count += 1
        if nearest is None or distance_m < nearest[0]:
            nearest = (distance_m, facility["name"])
    return count, total_spaces, available_spaces, nearest, weighted, weight_total


async def get_parking_coverage_status(latitude: float, longitude: float) -> dict[str, Any]:
    """키를 노출하지 않고 경주/주변 실시간 주차 데이터의 실제 사용 가능성을 설명한다."""
    facilities, realtime = _sources_stale_while_revalidate()
    gyeongju_realtime_count = sum(1 for facility in facilities if facility["id"] in realtime)
    nearby_count, total_spaces, available_spaces, _, _, _ = _nearby_totals(
        facilities, realtime, latitude, longitude
    )
    available = nearby_count > 0
    configured = bool(settings.GYEONGJU_ITS_BASE_URL.strip() or _service_key())
    if not configured:
        state = "not_configured"
    elif available:
        state = "available"
    elif _facility_status["state"] in {"not_checked", "checking"} or _realtime_status["state"] in {
        "not_checked", "checking"
    }:
        state = "checking"
    elif _facility_status["state"] == "unavailable" or _realtime_status["state"] == "unavailable":
        state = "upstream_unavailable"
    elif not facilities:
        state = "no_gyeongju_facilities"
    elif not gyeongju_realtime_count:
        state = "no_gyeongju_realtime"
    else:
        state = "no_nearby_realtime"
    return {
        "configured": configured,
        "national_api_configured": bool(_service_key()),
        "source": _realtime_status.get("source") or _facility_status.get("source"),
        "state": state,
        "available": available,
        "gyeongju_facility_count": len(facilities),
        "gyeongju_realtime_count": gyeongju_realtime_count,
        "nearby_realtime_count": nearby_count,
        "total_spaces": total_spaces if available else None,
        "available_spaces": available_spaces if available else None,
        "facility_checked_at": _facility_status["checked_at"],
        "realtime_checked_at": _realtime_status["checked_at"],
        "facility_error_code": _facility_status["error_code"],
        "realtime_error_code": _realtime_status["error_code"],
    }


async def get_nearby_parking_signal(latitude: float, longitude: float) -> dict[str, Any] | None:
    facilities, realtime = _sources_stale_while_revalidate()
    count, total_spaces, available_spaces, nearest, weighted, weight_total = _nearby_totals(
        facilities, realtime, latitude, longitude
    )
    if not count or weight_total <= 0:
        return None
    return {
        "level": round(max(0.0, min(1.0, weighted / weight_total)), 4),
        "source": "parking_live",
        "provider": _realtime_status.get("source"),
        "observed_at": _realtime_status["checked_at"],
        "parking_count": count,
        "total_spaces": total_spaces,
        "available_spaces": available_spaces,
        "nearest_parking_name": nearest[1] if nearest else None,
    }
