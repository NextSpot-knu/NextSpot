"""경주 축제/행사 라우터 — TourAPI searchFestival2 (공모전 필수 데이터 소스).

GET /api/v1/events : 지금 경주에서 진행 중이거나 곧 시작하는 축제 목록.

설계:
  - 공개 정보라 인증 불요(관광객 랜딩에서 로그인 전에도 보여야 함).
  - TOURAPI_KEY 미설정·호출 실패 시 500 이 아니라 200 + source="unavailable" 무해 폴백
    → 프런트는 events 가 비면 섹션 자체를 숨긴다(기존 목업 폴백 관례와 동일).
  - 쿼터 보호는 client._get_cached 의 24h TTL 캐시가 담당(일 1회 캐싱 정책).
  - 지역 필터는 법정동 코드(경상북도=47, 경주시=130) — searchFestival2 는 구 areaCode 를
    조용히 무시한다(client.search_festival 도크 참조).

축제 상세 조합(퀵윈 C3):
  - 진행 중(is_ongoing) 축제에 한해 detailCommon2(개요·홈페이지)·detailIntro2(contentTypeId=15,
    공연시간·행사장소·이용요금) 2콜을 추가로 붙여 overview/homepage/playtime/event_place/
    usetime_festival 을 채운다. 예정 축제는 상세를 붙이지 않는다(진행 중 축제 수 × 2콜로
    쿼터를 무해하게 유지 — 목록에 없는 예정 축제까지 상세를 미리 당길 이유가 없다).
  - 캐시: 축제(content_id)당 1h TTL(_get_festival_detail_cached) — 이 라우터 전용 캐시다.
    event_boost.py 의 _playtime_cache 는 스코어링용으로 '파싱된 시간 창'만 24h 보관해
    원문 텍스트(overview/homepage/eventplace/usetimefestival)가 없고 TTL 정책도 달라
    (표시용 1h vs 스코어링용 24h) 그대로 재사용할 수 없다 — 대신 동일한 캐시 패턴(모듈 전역
    dict + monotonic TTL + 실패도 캐싱)을 그대로 미러링한다. 서비스 계층(event_boost)을
    라우터가 들여다보는 결합을 피하기 위해 파일 경계도 분리 유지.
  - 개별 콜 실패(키 미설정·네트워크·쿼터)는 해당 필드만 생략 — 목록 자체·기존 필드는
    영향받지 않는다(무해 폴백, 기존 계약 불변).

축제 소개 다국어 요약(P1-4 — festival_summary_service):
  - 진행 중 + overview 보유 축제에 en/ja/zh AI 요약(overview_i18n)과 관찰 필드
    (summary_llm_status)를 동봉한다. 요청 경로는 LLM 에 블로킹되지 않는다 — 캐시
    히트분만 싣고 빠진 로케일은 fire-and-forget 태스크가 백그라운드에서 채운다.
    상세는 docs/SOLAR_LLM_EXPANSION.md P1-4 와 festival_summary_service 도크 참조.
"""
import time
from asyncio import gather
from datetime import date, datetime, timedelta, timezone
from typing import Literal, Optional

import structlog
from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.services import festival_summary_service
from app.services.tourapi import client as tourapi
from app.services.tourapi.transform import upgrade_image_scheme

logger = structlog.get_logger()
router = APIRouter(prefix="/api/v1", tags=["events"])

# detailIntro2 contentTypeId(행사/축제) — event_boost.py 의 _FESTIVAL_CONTENT_TYPE_ID 와 동일 실측값.
_FESTIVAL_CONTENT_TYPE_ID = 15

# 축제 상세(overview/homepage/playtime/event_place/usetime_festival) 캐시 TTL — 목록 캐시
# (_get_festivals_cached, event_boost.py)와 동일한 1h 정책. content_id → (monotonic 시각, dict).
_DETAIL_TTL_SECONDS = 3600.0
_detail_cache: dict[str, tuple[float, dict]] = {}

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
    # 상세 조합(퀵윈 C3) — 진행 중 축제만 채워진다(무해 폴백: 실패/미조회 시 None, 행 자체 생략은 프런트 몫).
    overview: Optional[str] = None       # detailCommon2.overview
    homepage: Optional[str] = None       # detailCommon2.homepage 원문(HTML anchor 가능 — href 추출은 프런트 몫)
    playtime: Optional[str] = None       # detailIntro2(contentTypeId=15).playtime
    event_place: Optional[str] = None    # detailIntro2.eventplace
    usetime_festival: Optional[str] = None  # detailIntro2.usetimefestival
    # P1-4 다국어 요약(festival_summary_service) — 진행 중 + overview 보유 축제만.
    #   overview_i18n: {en,ja,zh} AI 요약·번역 캐시(부분 채택 가능 — 성공 로케일만 담긴다).
    #     로케일 파라미터 없이 3로케일 일괄 동봉(계약 ②) — 캐시 미적재·키 미설정이면 None
    #     이고 프런트는 한국어 원문(overview)으로 폴백한다(무해). ko 는 항상 원문(계약 ⑤).
    #   summary_llm_status: LLM 관찰 필드(llmStatus 관례, §-15) —
    #     "llm"|"pending"|"rejected"|"llm_failed"|"disabled". 웹은 이 값으로
    #     'nextspot:llm-debug' CustomEvent 를 발행한다(FestivalBanner).
    overview_i18n: Optional[dict[str, str]] = None
    summary_llm_status: Optional[str] = None


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


async def _fetch_festival_detail(content_id: str) -> dict:
    """축제 1건의 상세(overview/homepage/playtime/event_place/usetime_festival) 조회.

    detailCommon2·detailIntro2(contentTypeId=15) 2콜을 각각 독립적으로 시도한다 — 한쪽이
    실패해도 다른 쪽 값은 살린다(무해 폴백). 값이 없는 필드는 dict 에 아예 넣지 않는다
    (extract_detail_common 과 동일한 '빈 값 키 생략' 원칙).
    """
    detail: dict = {}

    try:
        common_payload = await tourapi.detail_common(content_id)
        common_items = tourapi.parse_items(common_payload)
        if common_items:
            item = common_items[0]
            overview = str(item.get("overview") or "").strip()
            if overview:
                detail["overview"] = overview
            # homepage 는 '<a href="...">...</a>' HTML 로 오는 경우가 흔하다. 여기서는 원문을
            # 그대로 넘기고(href 원문), 추출은 프런트가 RecommendationCard 와 동일 정규식으로 한다.
            homepage = str(item.get("homepage") or "").strip()
            if homepage:
                detail["homepage"] = homepage
    except Exception as e:  # RuntimeError(키 미설정)·TourAPIError 모두 무해 폴백
        logger.warning("events_detail_common_failed", content_id=content_id, error=str(e))

    try:
        intro_payload = await tourapi.detail_intro(content_id, _FESTIVAL_CONTENT_TYPE_ID)
        intro_items = tourapi.parse_items(intro_payload)
        if intro_items:
            item = intro_items[0]
            playtime = str(item.get("playtime") or "").strip()
            if playtime:
                detail["playtime"] = playtime
            event_place = str(item.get("eventplace") or "").strip()
            if event_place:
                detail["event_place"] = event_place
            usetime_festival = str(item.get("usetimefestival") or "").strip()
            if usetime_festival:
                detail["usetime_festival"] = usetime_festival
    except Exception as e:  # RuntimeError(키 미설정)·TourAPIError 모두 무해 폴백
        logger.warning("events_detail_intro_failed", content_id=content_id, error=str(e))

    return detail


async def _get_festival_detail_cached(content_id: str) -> dict:
    """축제 상세를 축제당 1h TTL 로 캐싱해 조회한다(_DETAIL_TTL_SECONDS).

    실패해 빈 dict 가 나와도 그대로 캐싱한다 — event_boost._get_playtime_windows_cached 와
    동일하게, 장애 시 재요청마다 다시 두드리지 않기 위함(무해 네거티브 캐싱).
    """
    now = time.monotonic()
    hit = _detail_cache.get(content_id)
    if hit is not None and now - hit[0] < _DETAIL_TTL_SECONDS:
        return hit[1]
    detail = await _fetch_festival_detail(content_id)
    _detail_cache[content_id] = (now, detail)
    return detail


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
    events = events[:limit]

    # 상세 조합(퀵윈 C3) — 진행 중 축제에 한해서만(쿼터 무해). 개별 실패는 그 축제의 상세만 생략.
    ongoing_ids = [ev.content_id for ev in events if ev.is_ongoing and ev.content_id]
    if ongoing_ids:
        details = await gather(*(_get_festival_detail_cached(cid) for cid in ongoing_ids))
        detail_map = dict(zip(ongoing_ids, details))
        for ev in events:
            d = detail_map.get(ev.content_id)
            if not d:
                continue
            ev.overview = d.get("overview")
            ev.homepage = d.get("homepage")
            ev.playtime = d.get("playtime")
            ev.event_place = d.get("event_place")
            ev.usetime_festival = d.get("usetime_festival")

    # P1-4 축제 소개 다국어 요약 — 요청 경로 비블로킹(계약 ①): 캐시 히트분만 동봉하고,
    # 빠진 로케일은 fire-and-forget 태스크가 백그라운드에서 채운다(첫 요청은 원문만,
    # 이후 요청부터 overview_i18n 동봉 — JUDGE_QA "사전 배치+캐시" 서사 정합).
    # 표시 우선순위는 docs/TOURAPI_EXPANSION.md 4-4(공식 해당 언어 > 공식 한국어 원문 >
    # 명시된 AI 번역) — 공식 다국어 자매 서비스(2-1) 적재가 후속 정본이며, 이 요약은
    # 그때까지 'AI 요약·번역' 라벨이 명시된 최하위 계층이다. 키 미설정이면 태스크 자체
    # 미발행(네트워크 0) + status="disabled" 만 동봉(무해 폴백 — 기존 계약 불변).
    for ev in events:
        if not (ev.is_ongoing and ev.content_id and ev.overview):
            continue
        summaries = festival_summary_service.get_summaries(ev.content_id)
        if summaries:
            ev.overview_i18n = summaries
        ev.summary_llm_status = festival_summary_service.status_for(ev.content_id, bool(summaries))
        festival_summary_service.ensure_summaries(ev.content_id, ev.title, ev.overview)

    return EventsResponse(events=events, source="tourapi")
