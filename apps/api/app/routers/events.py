"""경주 축제/행사 라우터 — TourAPI searchFestival2 (공모전 필수 데이터 소스).

GET /api/v1/events : 지금 경주에서 진행 중이거나 곧 시작하는 축제 목록.

설계:
  - 공개 정보라 인증 불요(관광객 랜딩에서 로그인 전에도 보여야 함).
  - TOURAPI_KEY 미설정·호출 실패 시 500 이 아니라 200 + source="unavailable" 무해 폴백
    → 프런트는 events 가 비면 섹션 자체를 숨긴다(기존 목업 폴백 관례와 동일).
  - 쿼터 보호는 client._get_cached 의 24h TTL 캐시가 담당(일 1회 캐싱 정책).
  - 지역 필터는 법정동 코드(경상북도=47, 경주시=130) — searchFestival2 는 구 areaCode 를
    조용히 무시한다(client.search_festival 도크 참조).
"""
from datetime import date, datetime, timedelta, timezone
from typing import Literal, Optional

import structlog
from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.services.tourapi import client as tourapi
from app.services.tourapi.transform import upgrade_image_scheme

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1", tags=["events"])

# 법정동 코드 — searchFestival2 지역 필터(경상북도/경주시). 실측 검증값(2026-07).
_LDONG_GYEONGBUK = 47
_LDONG_GYEONGJU = 130

# 조회 기준일을 오늘보다 얼마나 과거로 잡을지(일). searchFestival2 의 eventStartDate 는
# "행사 시작일" 필터라, 오래전 시작해 아직 진행 중인 장기 행사(반년짜리 전시 등)를 놓치지
# 않도록 1년 물러선 뒤 종료일(end_date >= 오늘)로 다시 거른다. 실측: 2026-03 시작 상설전이
# 120일 룩백 경계에 걸렸음 — 호출 수는 동일(캐시 1회)이라 넉넉히 잡는 비용이 없다.
_LOOKBACK_DAYS = 365

_KST = timezone(timedelta(hours=9))


class FestivalEvent(BaseModel):
    content_id: str
    title: str
    start_date: str  # YYYY-MM-DD
    end_date: str    # YYYY-MM-DD
    address: Optional[str] = None
    image_url: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    tel: Optional[str] = None
    is_ongoing: bool


class EventsResponse(BaseModel):
    events: list[FestivalEvent]
    source: Literal["tourapi", "unavailable"]


def _parse_yyyymmdd(raw: object) -> Optional[date]:
    """TourAPI 날짜 문자열("20261009")을 date 로. 비정형 입력은 None."""
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


def transform_festival(item: dict, today: date) -> Optional[FestivalEvent]:
    """searchFestival2 item → FestivalEvent. 종료됐거나 날짜가 비정형이면 None(목록 제외)."""
    start = _parse_yyyymmdd(item.get("eventstartdate"))
    end = _parse_yyyymmdd(item.get("eventenddate"))
    if start is None or end is None or end < today:
        return None
    title = str(item.get("title") or "").strip()
    if not title:
        return None
    image = upgrade_image_scheme(str(item.get("firstimage") or item.get("firstimage2") or "").strip() or None)
    return FestivalEvent(
        content_id=str(item.get("contentid") or ""),
        title=title,
        start_date=start.isoformat(),
        end_date=end.isoformat(),
        address=str(item.get("addr1") or "").strip() or None,
        image_url=image,
        latitude=_parse_coord(item.get("mapy")),   # mapy=위도
        longitude=_parse_coord(item.get("mapx")),  # mapx=경도
        tel=str(item.get("tel") or "").strip() or None,
        is_ongoing=start <= today <= end,
    )


@router.get("/events", response_model=EventsResponse)
async def list_events(limit: int = Query(20, ge=1, le=50)):
    """경주 축제 목록 — 진행 중 우선, 그다음 시작일 순.

    실패(키 미설정·네트워크·쿼터)는 전부 source="unavailable" 빈 목록으로 흡수한다.
    축제는 부가 정보라 이 엔드포인트 장애가 관광객 플로우를 막아선 안 된다.
    """
    today = datetime.now(_KST).date()
    lookback = (today - timedelta(days=_LOOKBACK_DAYS)).strftime("%Y%m%d")
    try:
        payload = await tourapi.search_festival(
            lookback,
            ldong_regn_cd=_LDONG_GYEONGBUK,
            ldong_signgu_cd=_LDONG_GYEONGJU,
        )
        items = tourapi.parse_items(payload)
    except Exception as e:  # RuntimeError(키 미설정)·TourAPIError 모두 무해 폴백
        logger.warning("events_fetch_failed", error=str(e))
        return EventsResponse(events=[], source="unavailable")

    events = [ev for ev in (transform_festival(i, today) for i in items) if ev is not None]
    # 진행 중 → 임박한 시작일 순. 동순위는 제목으로 안정 정렬.
    events.sort(key=lambda ev: (not ev.is_ongoing, ev.start_date, ev.title))
    return EventsResponse(events=events[:limit], source="tourapi")
