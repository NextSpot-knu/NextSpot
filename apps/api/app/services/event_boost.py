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
"""
import time
from datetime import date, datetime, timedelta, timezone
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
        festivals.append({"title": title, "latitude": lat, "longitude": lng})
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
    """
    today = when_utc.astimezone(_KST).date()
    festivals = await _get_festivals_cached(today)

    best_boost = 0.0
    best_title: Optional[str] = None
    for fest in festivals:
        dist_m = calculate_haversine_distance(
            latitude, longitude, fest["latitude"], fest["longitude"]
        )
        boost = MAX_BOOST * max(0.0, 1.0 - dist_m / RADIUS_M)
        if boost > best_boost:
            best_boost = boost
            best_title = fest["title"]
    return round(best_boost, 4), best_title
