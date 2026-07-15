"""행사 혼잡 보정 서비스 (A4) — 진행 중 축제 인근 POI 의 예측 혼잡 가중.

배경: 혼잡 예측 모델은 (타입·시각·요일) 수준이라 '오늘 인근에서 열리는 축제' 같은
  외부 변수를 모른다. searchFestival2 로 당일 진행 중인 경주 축제를 받아, 좌표가 있는
  축제로부터의 거리 감쇠 가중치를 예측 혼잡도에 더한다(score.py 도착시점 예측·
  /predict/batch 지도 슬라이더 공용).

설계:
  - 가중치 = MAX_BOOST × max(0, 1 − 거리/RADIUS_M) 의 축제별 최댓값 — 축제 코앞이면
    +MAX_BOOST, 반경 밖이면 0. 선형 감쇠라 심사 설명이 쉽고 clamp01 로 상한이 보존된다.
  - 실패(키 미설정·네트워크·쿼터)는 전부 (0.0, None) 무해 폴백 — events 라우터와 동일
    관례. 이 보정이 추천/지도 플로우를 막아선 안 된다.
  - 캐시: 성공 시 당일 축제 좌표 목록을 1h 캐싱(원시 응답은 client 의 24h TTL 이 이미
    보호 — 여기 캐시는 파싱 생략용). 실패도 10분 네거티브 캐싱해, 키 미설정/장애 시
    후보마다 재시도로 채점 지연이 생기지 않게 한다.
  - 지역 필터는 법정동 코드(경북 47/경주 130) — events 라우터와 동일(구 areaCode 는
    searchFestival2 가 조용히 무시).

공연시간 정밀 보정(구현 2, docs/TOURAPI_EXPANSION.md 1-4):
  - 반경 내(거리 감쇠 boost > 0)인 축제에 한해 detailIntro2(contentTypeId=15)의 playtime 을
    조회해 'HH:MM~HH:MM'/'HH시~HH시' 류 명확한 패턴만 시간 창으로 파싱한다(복수 창 허용).
  - 파싱 성공 시: 도착 예측 시각이 해당 시간 창 ±1h 버퍼 밖이면 그 축제의 보정을 0 으로
    제외한다(공연 없는 시간대까지 종일 가중하지 않도록).
  - 파싱 실패/빈 값/조회 실패(키 미설정·네트워크·쿼터)는 전부 None → 기존 '기간 중 종일'
    보정을 그대로 유지한다(무해 폴백 — 정직한 저하).
  - 축제당 24h 캐시(_playtime_cache) — playtime 은 축제 기간 내 사실상 불변이라 스코어링마다
    재조회하지 않는다.
"""
import re
import time
from datetime import date, datetime, timedelta, timezone
from datetime import time as dtime
from typing import Optional

import structlog

from app.services.spot.travel import calculate_haversine_distance
from app.services.tourapi import client as tourapi

logger = structlog.get_logger()

# 보정 상수 — 황리단길 도보 상권 스케일. RADIUS_M 은 대릉원~황남동 일대가 한 축제의
# 영향권에 들어오는 수준(직선 1.5km), MAX_BOOST 는 혼잡 1단계(0~1 스케일의 15%p) 상향.
MAX_BOOST = 0.15
RADIUS_M = 1500.0

# 법정동 코드 — routers/events.py 와 동일 실측값(2026-07).
_LDONG_GYEONGBUK = 47
_LDONG_GYEONGJU = 130

# searchFestival2 의 eventStartDate 는 '시작일' 필터 — 장기 행사를 놓치지 않도록
# 1년 룩백 후 종료일로 재필터(events 라우터와 동일 근거).
_LOOKBACK_DAYS = 365

_KST = timezone(timedelta(hours=9))

_TTL_OK_SECONDS = 3600.0    # 성공 캐시(파싱 결과) — 축제 일정은 일 단위라 1h 면 충분
_TTL_FAIL_SECONDS = 600.0   # 실패 네거티브 캐시 — 장애 시 채점마다 재시도 방지

# (조회일 ISO, monotonic 시각, TTL, 축제 목록) — 단일 프로세스 데모 서버 전제의 모듈 전역 캐시.
_cache: Optional[tuple[str, float, float, list[dict]]] = None

# --- 공연시간 정밀 보정(구현 2) ---------------------------------------------------------

_FESTIVAL_CONTENT_TYPE_ID = 15
_PLAYTIME_TTL_SECONDS = 24 * 60 * 60  # 축제당 24h 캐시(1-4) — playtime 은 기간 중 사실상 불변
_PLAYTIME_BUFFER_MIN = 60             # 시간 창 ±1h 버퍼

# 'HH:MM ~ HH:MM' / 'HH시 ~ HH시' 류 명확한 패턴만 인식(보수적 파싱 — §구현 2).
# 구분자는 '~'/'-'/'∼' 를 모두 허용(실측 예: "13:00 ~ 22:00").
_TIME_COLON_RE = re.compile(r"(\d{1,2}):(\d{2})\s*[~\-∼]\s*(\d{1,2}):(\d{2})")
_TIME_SI_RE = re.compile(r"(\d{1,2})\s*시\s*[~\-∼]\s*(\d{1,2})\s*시")

# 축제 contentid → (monotonic 시각, 파싱된 시간 창 목록 또는 None) — 24h TTL.
_playtime_cache: dict[str, tuple[float, Optional[list[tuple[dtime, dtime]]]]] = {}


def _valid_clock_time(hour: int, minute: int) -> Optional[dtime]:
    """시:분 → datetime.time. 24:00 은 자정(하루 끝)으로 간주해 23:59 로 정규화(경계 케이스).

    범위를 벗어나면 None — 호출부가 이 매치를 버린다(보수적 파싱, 억지 보정 금지).
    """
    if hour == 24 and minute == 0:
        return dtime(23, 59)
    if 0 <= hour <= 23 and 0 <= minute <= 59:
        return dtime(hour, minute)
    return None


def parse_playtime_windows(raw: object) -> Optional[list[tuple[dtime, dtime]]]:
    """축제 playtime 원문 → (시작, 종료) 시간 창 목록(복수 허용).

    'HH:MM~HH:MM'/'HH시~HH시' 류 명확한 패턴만 인식한다. 원문이 비어 있거나 인식 가능한
    패턴이 하나도 없으면 None(호출부는 기존 '기간 중 종일' 보정을 그대로 유지 — 정직한 저하).
    시작≥종료(자정 넘김 등 모호한 경우)는 이 구현 범위 밖이라 해당 매치만 버린다.
    """
    text = str(raw or "").strip()
    if not text:
        return None

    windows: list[tuple[dtime, dtime]] = []
    for h1, m1, h2, m2 in _TIME_COLON_RE.findall(text):
        start = _valid_clock_time(int(h1), int(m1))
        end = _valid_clock_time(int(h2), int(m2))
        if start is not None and end is not None and start < end:
            windows.append((start, end))
    for h1, h2 in _TIME_SI_RE.findall(text):
        start = _valid_clock_time(int(h1), 0)
        end = _valid_clock_time(int(h2), 0)
        if start is not None and end is not None and start < end:
            windows.append((start, end))

    return windows or None


def _within_buffered_window(now_local: dtime, start: dtime, end: dtime) -> bool:
    """now_local 이 [start-버퍼, end+버퍼] 안에 있는지(자정 넘는 버퍼도 원형으로 처리)."""
    now_min = now_local.hour * 60 + now_local.minute
    lower = start.hour * 60 + start.minute - _PLAYTIME_BUFFER_MIN
    upper = end.hour * 60 + end.minute + _PLAYTIME_BUFFER_MIN
    if lower < 0 or upper >= 24 * 60:
        lo, hi = lower % (24 * 60), upper % (24 * 60)
        if lo <= hi:
            return lo <= now_min <= hi
        return now_min >= lo or now_min <= hi
    return lower <= now_min <= upper


async def _get_playtime_windows_cached(contentid: str) -> Optional[list[tuple[dtime, dtime]]]:
    """축제 1건의 playtime 시간 창을 24h 캐싱해 조회한다.

    client.detail_intro() 를 그대로 재사용(contentTypeId=15 고정). 조회/파싱 실패는 모두
    None 으로 캐싱한다 — 호출부가 기존 종일 보정으로 무해 폴백하고, 실패한 축제를 24h 내
    재요청으로 다시 두들기지 않는다.
    """
    now = time.monotonic()
    hit = _playtime_cache.get(contentid)
    if hit is not None and now - hit[0] < _PLAYTIME_TTL_SECONDS:
        return hit[1]

    windows: Optional[list[tuple[dtime, dtime]]] = None
    try:
        payload = await tourapi.detail_intro(contentid, _FESTIVAL_CONTENT_TYPE_ID)
        items = tourapi.parse_items(payload)
        if items:
            windows = parse_playtime_windows(items[0].get("playtime"))
    except Exception as e:  # TourAPIError · RuntimeError(키 미설정) 등 — 무해 폴백
        logger.warning("event_boost_playtime_fetch_failed", contentid=contentid, error=str(e))
        windows = None

    _playtime_cache[contentid] = (now, windows)
    return windows


def _parse_yyyymmdd(raw: object) -> Optional[date]:
    try:
        return datetime.strptime(str(raw).strip(), "%Y%m%d").date()
    except (TypeError, ValueError):
        return None


def _parse_coord(raw: object) -> Optional[float]:
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        return None
    return value if value != 0.0 else None  # TourAPI 는 좌표 미상이면 0 을 준다


async def _fetch_ongoing_festivals(today: date) -> list[dict]:
    """오늘 진행 중이고 좌표가 있는 경주 축제 목록. 예외는 호출측에서 처리."""
    lookback = (today - timedelta(days=_LOOKBACK_DAYS)).strftime("%Y%m%d")
    payload = await tourapi.search_festival(
        lookback,
        ldong_regn_cd=_LDONG_GYEONGBUK,
        ldong_signgu_cd=_LDONG_GYEONGJU,
    )
    festivals: list[dict] = []
    for item in tourapi.parse_items(payload):
        start = _parse_yyyymmdd(item.get("eventstartdate"))
        end = _parse_yyyymmdd(item.get("eventenddate"))
        lat = _parse_coord(item.get("mapy"))   # mapy=위도
        lng = _parse_coord(item.get("mapx"))   # mapx=경도
        title = str(item.get("title") or "").strip()
        if start is None or end is None or not (start <= today <= end):
            continue
        if lat is None or lng is None or not title:
            continue
        contentid = str(item.get("contentid") or "").strip() or None
        festivals.append({
            "title": title, "latitude": lat, "longitude": lng, "contentid": contentid,
        })
    return festivals


async def _get_festivals_cached(today: date) -> list[dict]:
    global _cache
    key = today.isoformat()
    if _cache is not None:
        cached_key, ts, ttl, festivals = _cache
        if cached_key == key and time.monotonic() - ts < ttl:
            return festivals
    try:
        festivals = await _fetch_ongoing_festivals(today)
        _cache = (key, time.monotonic(), _TTL_OK_SECONDS, festivals)
        logger.info("event_boost_festivals_loaded", count=len(festivals))
    except Exception as e:  # RuntimeError(키 미설정)·TourAPIError 모두 무해 폴백
        festivals = []
        _cache = (key, time.monotonic(), _TTL_FAIL_SECONDS, festivals)
        logger.warning("event_boost_fetch_failed", error=str(e))
    return festivals


async def get_event_congestion_boost(
    latitude: float, longitude: float, when_utc: datetime
) -> tuple[float, Optional[str]]:
    """(예측 혼잡 가중치 [0, MAX_BOOST], 근거 축제명) — 보정 없음이면 (0.0, None).

    when_utc 로 'KST 기준 그날' 진행 중인 축제만 본다(TourAPI 날짜는 KST).

    공연시간 정밀 보정(구현 2): 거리 감쇠로 보정 대상이 된 축제(boost > 0)에 한해 playtime
    시간 창을 조회한다. 파싱에 성공했는데 도착 예측 시각이 창(±1h 버퍼) 밖이면 그 축제는
    제외(보정 0). contentid 가 없거나 조회/파싱에 실패하면 기존 '기간 중 종일' 보정을
    그대로 적용한다(무해 폴백).
    """
    today = when_utc.astimezone(_KST).date()
    now_local = when_utc.astimezone(_KST).time()
    festivals = await _get_festivals_cached(today)

    best_boost = 0.0
    best_title: Optional[str] = None
    for fest in festivals:
        dist_m = calculate_haversine_distance(
            latitude, longitude, fest["latitude"], fest["longitude"]
        )
        boost = MAX_BOOST * max(0.0, 1.0 - dist_m / RADIUS_M)
        if boost <= 0.0:
            continue

        contentid = fest.get("contentid")
        if contentid:
            windows = await _get_playtime_windows_cached(contentid)
            if windows is not None and not any(
                _within_buffered_window(now_local, start, end) for start, end in windows
            ):
                continue  # 시간창 파싱 성공 + 도착 시각이 공연 시간 밖 → 이 축제는 보정 제외

        if boost > best_boost:
            best_boost = boost
            best_title = fest["title"]
    return round(best_boost, 4), best_title
