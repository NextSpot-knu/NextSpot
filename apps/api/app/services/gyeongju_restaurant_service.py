"""경주시 메뉴별음식점 공공데이터(data.go.kr 15114465) 어댑터.

경주 문화관광 메뉴별음식점을 제공하는 REST/JSON API를 페이지네이션 호출해 정규화한 dict
리스트로 반환한다. 반환 계약(항목 1건):
  {con_uid, name, address, menu(대표메뉴), hours(영업시간), closed(휴무일),
   parking(주차 안내 bool|str|None), amenities(편의시설), homepage, lat, lng}

확정된 스펙(팀 실측):
  GET {BASE_URL}/getMenuRstrt   (BASE_URL 예: https://apis.data.go.kr/5050000/menuRstrtService)
  파라미터: serviceKey, pageNo, numOfRows, type=json
  성공 판정: response.header.resultCode == "00"  (KorService2 의 "0000" 이 아니다 — 주의)
  총건수  : response.body.totalCount (약 111곳 — 1~2페이지면 전량)
  목록    : response.body.items.item (배열, 단건이면 dict → [dict] 정규화)
  대표메뉴·영업시간·휴무일·주차·편의시설은 별도 필드가 아니라 CON_SUMMARY 자유 텍스트에
  "라벨 : 값<br />" 형식으로 함께 들어온다 — parse_summary 가 라벨별로 분리한다.

⚠️ base URL·serviceKey 는 팀의 활용신청 승인 후에만 확정되므로 env(기본값 빈 문자열)로 두고
   하드코딩하지 않는다(오퍼레이션 getMenuRstrt 만 경로가 확정이라 코드 상수). base URL 또는
   키가 비면 즉시 빈 리스트로 무해하게 no-op 하고, 타임아웃·응답 오류도 삼켜서 빈 리스트를
   반환한다(weather_service·parking_demand_service 관례와 동일 — 데모/배치 안정성).
   이 서비스(제공기관 5050000)는 TourAPI(B551011) 와 다른 활용신청이라 TOURAPI_KEY 로
   폴백하지 않는다(다른 서비스 키로는 미승인 오류가 난다).
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any
from xml.etree import ElementTree

import httpx
import structlog

from app.core.config import settings

logger = structlog.get_logger()

_OPERATION = "getMenuRstrt"  # 경로 확정 — 오퍼레이션명만 코드 상수(base URL·키는 env).
_CACHE_TTL_SECONDS = 24 * 60 * 60.0
# 이 서비스는 일배치(scripts/ingest_gyeongju_restaurants.py) 전용이다 — 사용자 요청 경로에서 부르지 않는다.
# 2026-09-20·21·22 일배치의 '0건 수신'은 일부 GitHub 러너가 apis.data.go.kr 첫 연결을 10초 안에
# 맺지 못한 타임아웃이었다(같은 러너의 TourAPI 도 동일). 배치라 기다려도 되므로 25초로 늘리고,
# 타임아웃·연결 끊김에 한해 짧게 재시도한다. 최악(요청당 3회 시도) ≈ 25·3 + 5 + 15 = 95초.
_REQUEST_TIMEOUT_SECONDS = 25.0
_RETRY_DELAYS_S: tuple[float, ...] = (5.0, 15.0)
# 재시도 대상 — 다시 부르면 통과할 수 있는 전송 실패만. 4xx/5xx·resultCode·파싱 오류는 다시 불러도
# 같으므로(또는 서버 쪽 문제라) 즉시 포기하고 빈 리스트로 끝낸다(본 배치에는 non-fatal).
_TRANSIENT_ERRORS: tuple[type[Exception], ...] = (
    httpx.TimeoutException,  # ConnectTimeout·ReadTimeout 등
    httpx.NetworkError,  # ConnectError·ReadError 등
    httpx.RemoteProtocolError,  # 응답 없이 연결이 끊김
)
_PAGE_SIZE = 100
_MAX_PAGES = 10

# 성공(비어 있지 않은) 결과만 24h 캐시(빈 결과·실패는 캐시하지 않아 다음 호출이 재시도한다).
_cache: tuple[float, list[dict[str, Any]]] | None = None
_cache_lock = asyncio.Lock()

# CON_SUMMARY 자유 텍스트의 라벨 → 정규화 키.
_SUMMARY_LABELS = {
    "대표메뉴": "menu",
    "영업시간": "hours",
    "휴무일": "closed",
    "주차": "parking",
    "편의시설": "amenities",
}
_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
_LABEL_RE = re.compile(r"^\s*([^:：]+?)\s*[:：]\s*(.*)$")

# 주차 안내 원문 → bool 판정(정확 일치만). 안내 문구("매장 옆 공용주차장 이용" 등)는 원문 유지.
_PARKING_TRUE = {"y", "가능", "있음", "true", "1", "o", "가", "완비", "무료", "유료", "yes"}
_PARKING_FALSE = {"n", "불가", "불가능", "없음", "false", "0", "x", "no"}


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _to_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def _to_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return None


def _parking(value: str | None) -> bool | str | None:
    """주차 안내를 bool 로 정규화하되, 애매한 안내 문구는 원문 문자열을 그대로 반환한다."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.casefold() in _PARKING_TRUE:
        return True
    if text.casefold() in _PARKING_FALSE:
        return False
    return text


def parse_summary(summary: str | None) -> dict[str, str | None]:
    """CON_SUMMARY 자유 텍스트에서 라벨별 값을 추출한다.

    형식 예: "대표메뉴 : 밀면, 연탄불고기&nbsp;<br />\\r\\n영업시간 : 11:00-20:00<br />\\r\\n
             휴무일 : 인스타공지<br />\\r\\n주차 : 매장 옆 공용주차장 이용<br />\\r\\n
             편의시설 : 현금/카드결제, 화장실, 무선인터넷, 단체석, 포장가능"
    각 값은 라벨 뒤부터 다음 <br>/개행 전까지. &nbsp; 제거, 앞뒤 공백 trim. 라벨 없으면 None.
    """
    result: dict[str, str | None] = dict.fromkeys(_SUMMARY_LABELS.values(), None)
    if not summary:
        return result
    text = str(summary).replace("&nbsp;", " ")
    segments: list[str] = []
    for part in _BR_RE.split(text):
        for line in part.replace("\r", "\n").split("\n"):
            stripped = line.strip()
            if stripped:
                segments.append(stripped)
    for segment in segments:
        match = _LABEL_RE.match(segment)
        if not match:
            continue
        key = _SUMMARY_LABELS.get(match.group(1).strip())
        value = match.group(2).strip()
        if key and value and result.get(key) is None:
            result[key] = value
    return result


def normalize_restaurant(row: Any) -> dict[str, Any] | None:
    """API item 1건(CON_* 필드) → 정규화 dict. name/lat/lng 중 하나라도 없으면 None(스킵).

    좌표는 배치의 이름+근접 매칭에 필수이므로, 이름·좌표가 없는 행은 사용할 수 없는 것으로 본다.
    좌석수·전화는 이 데이터셋이 제공하지 않으므로 지어내지 않는다('지어내지 않기' 원칙).
    """
    if not isinstance(row, dict):
        return None
    name = _text(row.get("CON_TITLE"))
    lat = _to_float(row.get("CON_LATITUDE"))
    lng = _to_float(row.get("CON_LONGITUDE"))
    if not name or lat is None or lng is None:
        return None
    summary = parse_summary(_text(row.get("CON_SUMMARY")))
    return {
        "con_uid": _to_int(row.get("CON_UID")),
        "name": name,
        "address": _text(row.get("CON_ADDRESS")),
        "homepage": _text(row.get("CON_HOMEPAGE")),
        "menu": summary["menu"],
        "hours": summary["hours"],
        "closed": summary["closed"],
        "parking": _parking(summary["parking"]),
        "amenities": summary["amenities"],
        "lat": lat,
        "lng": lng,
    }


def _service_key() -> str:
    return settings.GYEONGJU_FOOD_API_KEY.strip()


def _xml_payload(text: str) -> dict[str, Any]:
    """방어용 XML 파서 — type=json 이 확정이라 폴백 경로다. 표준 봉투 구조로 변환한다."""
    root = ElementTree.fromstring(text.lstrip("﻿\r\n\t "))
    items: list[dict[str, Any]] = []
    for item in root.findall(".//item"):
        items.append({child.tag: (child.text or "").strip() for child in item})
    code_node = root.find(".//resultCode")
    result_code = (code_node.text or "").strip() if code_node is not None else "00"
    total_node = root.find(".//totalCount")
    total = (total_node.text or "0").strip() if total_node is not None else "0"
    return {
        "response": {
            "header": {"resultCode": result_code or "00"},
            "body": {"items": {"item": items}, "totalCount": total},
        }
    }


def _payload_from_response(response: httpx.Response) -> Any:
    """JSON 을 우선 파싱하고, XML(<...>)이면 표준 봉투 dict 로 변환한다(방어용)."""
    text = response.text.strip()
    if not text:
        return {}
    if text.startswith("<"):
        return _xml_payload(text)
    return json.loads(text)


def _result_code(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    try:
        return str(payload.get("response", {}).get("header", {}).get("resultCode", ""))
    except AttributeError:
        return ""


def _extract_items(payload: Any) -> list[dict[str, Any]]:
    """response.body.items.item 을 추출한다(배열/단건 dict 모두 정규화)."""
    if not isinstance(payload, dict):
        return []
    body = payload.get("response")
    if isinstance(body, dict):
        body = body.get("body", {})
    if not isinstance(body, dict):
        return []
    items = body.get("items")
    if isinstance(items, dict):
        item = items.get("item")
        if isinstance(item, list):
            return [row for row in item if isinstance(row, dict)]
        if isinstance(item, dict):
            return [item]
    if isinstance(items, list):
        return [row for row in items if isinstance(row, dict)]
    return []


def _total_count(payload: Any) -> int:
    if not isinstance(payload, dict):
        return 0
    try:
        raw = payload.get("response", {}).get("body", {}).get("totalCount")
    except AttributeError:
        return 0
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 0


async def _get_with_retry(
    client: httpx.AsyncClient, url: str, params: dict[str, Any]
) -> httpx.Response:
    """GET 1회를 전송 실패(_TRANSIENT_ERRORS)에 한해 _RETRY_DELAYS_S 간격으로 다시 시도한다."""
    attempt = 0
    while True:
        try:
            return await client.get(url, params=params)
        except _TRANSIENT_ERRORS as exc:
            if attempt >= len(_RETRY_DELAYS_S):
                raise
            delay = _RETRY_DELAYS_S[attempt]
            attempt += 1
            # httpx 타임아웃은 str(exc) 가 빈 문자열이라 error_type 으로 원인을 남긴다.
            logger.warning(
                "gyeongju_food_fetch_retry",
                error_type=type(exc).__name__,
                attempt=attempt,
                max_retries=len(_RETRY_DELAYS_S),
                delay_s=delay,
            )
            await asyncio.sleep(delay)


async def _fetch_all() -> list[dict[str, Any]]:
    """getMenuRstrt 를 페이지네이션 호출해 원시 item 을 전량 수집한다(에러는 삼켜 빈 리스트)."""
    base_url = settings.GYEONGJU_FOOD_API_BASE_URL.strip().rstrip("/")
    key = _service_key()
    if not base_url or not key:
        return []  # 미설정 — 무해 no-op.
    url = f"{base_url}/{_OPERATION}"

    rows: list[dict[str, Any]] = []
    try:
        async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SECONDS, follow_redirects=True) as client:
            for page in range(1, _MAX_PAGES + 1):
                response = await _get_with_retry(client, url, {
                    "serviceKey": key,
                    "pageNo": page,
                    "numOfRows": _PAGE_SIZE,
                    "type": "json",
                })
                response.raise_for_status()
                payload = _payload_from_response(response)
                code = _result_code(payload)
                if code != "00":
                    logger.warning("gyeongju_food_bad_result", result_code=code or None)
                    break
                page_items = _extract_items(payload)
                if not page_items:
                    break
                rows.extend(page_items)
                total = _total_count(payload)
                if total and len(rows) >= total:
                    break
                if len(page_items) < _PAGE_SIZE:
                    break
    except (httpx.HTTPError, ValueError, TypeError, ElementTree.ParseError) as exc:
        logger.warning("gyeongju_food_fetch_failed", error_type=type(exc).__name__, error=str(exc))
        return []
    return rows


async def get_gyeongju_restaurants(*, use_cache: bool = True) -> list[dict[str, Any]]:
    """경주 메뉴별음식점 목록을 정규화해 반환한다(미설정/에러 시 빈 리스트).

    base URL/키가 비면 빈 리스트로 무해하게 no-op 한다. 성공(비어 있지 않은) 결과만 24h 캐시한다.
    """
    global _cache
    if use_cache and _cache and time.monotonic() - _cache[0] < _CACHE_TTL_SECONDS:
        return _cache[1]
    async with _cache_lock:
        if use_cache and _cache and time.monotonic() - _cache[0] < _CACHE_TTL_SECONDS:
            return _cache[1]
        raw = await _fetch_all()
        normalized: list[dict[str, Any]] = []
        seen: set[tuple[str, float, float]] = set()
        for row in raw:
            item = normalize_restaurant(row)
            if item is None:
                continue
            dedupe = (item["name"], round(item["lat"], 5), round(item["lng"], 5))
            if dedupe in seen:
                continue
            seen.add(dedupe)
            normalized.append(item)
        if normalized:
            _cache = (time.monotonic(), normalized)
        return normalized


def clear_cache() -> None:
    """테스트/재적재용 캐시 초기화."""
    global _cache
    _cache = None
