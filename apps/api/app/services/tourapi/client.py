"""한국관광공사 TourAPI 4.0 비동기 클라이언트 (KorService2).

공모전 필수 데이터 소스(docs/NEXTSPOT_PIVOT.md §3). 담당 범위:
  - locationBasedList2 : 좌표 반경 POI 조회 (황리단길 후보군)
  - areaBasedList2     : 지역코드 기반 POI 목록
  - detailCommon2 / detailIntro2 / detailInfo2 : 상세(운영시간·무장애 등)
  - searchFestival2    : 행사/축제 (혼잡 예측 외부 변수)

설계 메모:
  - httpx.AsyncClient 를 lazy 싱글턴으로 재사용 (spot/travel.py 와 동일 패턴).
  - 목록성 호출은 파라미터 키 기준 24시간 TTL 캐시 — 피벗 문서의 "Static 레이어: 일 1회 캐싱".
  - TOURAPI_KEY 미설정 시 import 시점이 아니라 호출 시점에 한국어 RuntimeError 로 실패시킨다
    (키 없이도 API 서버 자체는 기동돼야 하므로).
  - 오류 응답/네트워크 예외의 원문은 structlog 서버 로그로만 남기고, 밖으로는 일반화된
    TourAPIError 메시지만 던진다(내부 정보·인증키 노출 방지).
"""

import time
from typing import Any, Optional

import httpx
import structlog

from app.core.config import settings

_logger = structlog.get_logger()

BASE_URL = "https://apis.data.go.kr/B551011/KorService2"

# 목록성 응답 캐시 TTL — 피벗 문서(§3-2)의 "일 1회 캐싱" 정책.
CACHE_TTL_SECONDS = 24 * 60 * 60

# {(endpoint, 정렬된 파라미터 튜플): (저장 시각 epoch, payload)}
_list_cache: dict[tuple, tuple[float, dict]] = {}

# Kakao Directions(travel.py)와 동일하게 lazy 생성 — 이벤트 루프 밖 생성/누수 방지.
_client: Optional[httpx.AsyncClient] = None


class TourAPIError(RuntimeError):
    """TourAPI 호출 실패(비정상 resultCode, 네트워크 오류 등). 메시지는 일반화된 한국어 문구만 담는다."""


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=10.0, limits=httpx.Limits(max_connections=10))
    return _client


def _require_key() -> str:
    """TOURAPI_KEY 를 호출 시점에 검증한다(부팅 시 강제하지 않음)."""
    key = (settings.TOURAPI_KEY or "").strip()
    if not key:
        raise RuntimeError(
            "TOURAPI_KEY 가 설정되지 않았습니다. 공공데이터포털(data.go.kr)에서 "
            "한국관광공사 TourAPI(B551011) 활용신청 후 발급받은 인증키를 "
            "apps/api/.env 의 TOURAPI_KEY 에 넣어주세요."
        )
    return key


def _common_params() -> dict:
    return {
        "serviceKey": _require_key(),
        "MobileOS": "ETC",
        "MobileApp": "NextSpot",
        "_type": "json",
    }


def parse_items(payload: Any) -> list[dict]:
    """TourAPI 응답에서 item 목록을 안전하게 추출하는 순수 함수.

    응답 형태: response.body.items.item (단건이면 dict, 다건이면 list).
    주의: 결과가 0건이면 items 가 객체가 아니라 **빈 문자열 ""** 로 온다 — dict 검사로 흡수.
    어떤 비정형 입력에도 예외 없이 list[dict] 를 반환한다.
    """
    if not isinstance(payload, dict):
        return []
    response = payload.get("response")
    if not isinstance(response, dict):
        return []
    body = response.get("body")
    if not isinstance(body, dict):
        return []
    items = body.get("items")
    if not isinstance(items, dict):  # 0건이면 "" (빈 문자열)
        return []
    item = items.get("item")
    if isinstance(item, list):
        return [i for i in item if isinstance(i, dict)]
    if isinstance(item, dict):
        return [item]
    return []


def parse_total_count(payload: Any) -> int:
    """response.body.totalCount 를 안전하게 int 로 추출(실패 시 0). 페이지네이션 종료 판정용."""
    try:
        return int(payload["response"]["body"]["totalCount"])
    except (TypeError, KeyError, ValueError):
        return 0


def _check_result(payload: Any, endpoint: str) -> None:
    """resultCode '0000' 이 아니면 로그 후 TourAPIError. 원문 메시지는 서버 로그에만 남긴다."""
    header = {}
    if isinstance(payload, dict):
        response = payload.get("response")
        if isinstance(response, dict) and isinstance(response.get("header"), dict):
            header = response["header"]
    code = str(header.get("resultCode", ""))
    if code != "0000":
        _logger.warning(
            "tourapi_bad_result",
            endpoint=endpoint,
            result_code=code or None,
            result_msg=header.get("resultMsg"),
        )
        raise TourAPIError(f"TourAPI 응답 오류입니다(endpoint={endpoint}, resultCode={code or '알 수 없음'}).")


async def _get(endpoint: str, params: dict) -> dict:
    """공통 GET. None 파라미터 제거 + 공통 파라미터 병합 + resultCode 검증."""
    query = {**_common_params(), **{k: v for k, v in params.items() if v is not None}}
    try:
        response = await _get_client().get(f"{BASE_URL}/{endpoint}", params=query)
        response.raise_for_status()
        payload = response.json()  # 인증키 오류 등은 XML 로 와서 여기서 실패 → 아래 except 로 포섭
    except Exception as e:
        # 예외 원문(스택·URL 내 인증키 포함 가능)은 서버 로그로만 — 밖으로는 일반화된 메시지.
        _logger.warning("tourapi_request_failed", endpoint=endpoint, error=str(e))
        raise TourAPIError(
            f"TourAPI 호출에 실패했습니다(endpoint={endpoint}). 인증키/네트워크 상태를 확인하세요."
        ) from None
    _check_result(payload, endpoint)
    return payload


async def _get_cached(endpoint: str, params: dict) -> dict:
    """목록성 호출용 TTL 캐시 래퍼(일 1회 캐싱). serviceKey 는 키에 포함하지 않는다."""
    cache_key = (endpoint, tuple(sorted((k, str(v)) for k, v in params.items() if v is not None)))
    now = time.time()
    hit = _list_cache.get(cache_key)
    if hit is not None and (now - hit[0]) < CACHE_TTL_SECONDS:
        return hit[1]
    payload = await _get(endpoint, params)
    _list_cache[cache_key] = (now, payload)
    return payload


# ---------------------------------------------------------------------------
# 공개 API — 반환값은 TourAPI 원문 payload(dict). parse_items()/parse_total_count() 로 소비.
# ---------------------------------------------------------------------------

async def location_based_list(
    map_x: float,
    map_y: float,
    radius_m: int,
    content_type_id: Optional[int] = None,
    page: int = 1,
    rows: int = 100,
) -> dict:
    """locationBasedList2 — 좌표(mapX=경도, mapY=위도) 반경(m) 내 POI 목록."""
    return await _get_cached("locationBasedList2", {
        "mapX": map_x,
        "mapY": map_y,
        "radius": radius_m,
        "contentTypeId": content_type_id,
        "pageNo": page,
        "numOfRows": rows,
    })


async def area_based_list(
    area_code: int,
    sigungu_code: Optional[int] = None,
    content_type_id: Optional[int] = None,
    page: int = 1,
    rows: int = 100,
) -> dict:
    """areaBasedList2 — 지역코드(경북=35, 경주 시군구=2) 기반 POI 목록."""
    return await _get_cached("areaBasedList2", {
        "areaCode": area_code,
        "sigunguCode": sigungu_code,
        "contentTypeId": content_type_id,
        "pageNo": page,
        "numOfRows": rows,
    })


async def area_based_sync_list(
    area_code: int,
    sigungu_code: Optional[int] = None,
    content_type_id: Optional[int] = None,
    modified_time: Optional[str] = None,
    page: int = 1,
    rows: int = 100,
) -> dict:
    """areaBasedSyncList2 — 변경분 동기화 목록(표출여부 showflag 포함).

    폐업/비표출(showflag) 감지용 일배치 전용이라 캐시하지 않는다(항상 최신 변경분).
    modified_time 은 YYYYMMDD — 해당 일자 이후 변경분만. 실제 수용 파라미터는
    응답 실측으로 확정할 것(문서·실서버 간 차이 전례 있음).
    """
    return await _get("areaBasedSyncList2", {
        "areaCode": area_code,
        "sigunguCode": sigungu_code,
        "contentTypeId": content_type_id,
        "modifiedtime": modified_time,
        "pageNo": page,
        "numOfRows": rows,
    })


async def search_keyword(
    keyword: str,
    area_code: Optional[int] = None,
    sigungu_code: Optional[int] = None,
    content_type_id: Optional[int] = None,
    page: int = 1,
    rows: int = 10,
) -> dict:
    """searchKeyword2 — 전체 TourAPI POI 키워드 검색(적재 85곳 밖 커버리지).

    런타임 검색 폴백용 — 키워드별 24h 캐시(_get_cached)로 쿼터를 보호하고,
    호출 빈도 제한(레이트리밋)은 라우터 계층에서 별도로 건다.
    """
    return await _get_cached("searchKeyword2", {
        "keyword": keyword,
        "areaCode": area_code,
        "sigunguCode": sigungu_code,
        "contentTypeId": content_type_id,
        "pageNo": page,
        "numOfRows": rows,
    })


async def detail_common(content_id: str) -> dict:
    """detailCommon2 — 공통 상세(개요·주소·좌표·대표이미지 등)."""
    return await _get("detailCommon2", {"contentId": content_id})


async def detail_intro(content_id: str, content_type_id: int) -> dict:
    """detailIntro2 — 타입별 소개(운영시간·휴무일 등. 필드명이 contentTypeId 마다 다름)."""
    return await _get("detailIntro2", {"contentId": content_id, "contentTypeId": content_type_id})


async def detail_info(content_id: str, content_type_id: int) -> dict:
    """detailInfo2 — 반복 상세정보. 무장애(barrier-free)/이용 안내 텍스트 추출에 사용."""
    return await _get("detailInfo2", {"contentId": content_id, "contentTypeId": content_type_id})


async def search_festival(
    event_start_date: str,
    ldong_regn_cd: Optional[int] = None,
    ldong_signgu_cd: Optional[int] = None,
    page: int = 1,
    rows: int = 100,
) -> dict:
    """searchFestival2 — 행사/축제 조회 (혼잡 예측 외부 변수).

    NOTE: 피벗 문서(docs/NEXTSPOT_PIVOT.md §3-1)는 "eventBasedList" 로 표기하지만,
    TourAPI 4.0(KorService2)의 실제 엔드포인트명은 searchFestival2 다.
    event_start_date 형식: YYYYMMDD.

    ⚠️ 지역 필터는 법정동 코드만 동작한다(2026-07 실측): 구 areaCode=35(경북)는
    조용히 0건을 반환하고, lDongRegnCd=47(경상북도)+lDongSignguCd=130(경주시)이 정답.
    (areaBasedList2 는 legacy areaCode 도 여전히 동작 — 이 엔드포인트만 다르다.)
    """
    return await _get_cached("searchFestival2", {
        "eventStartDate": event_start_date,
        "lDongRegnCd": ldong_regn_cd,
        "lDongSignguCd": ldong_signgu_cd,
        "pageNo": page,
        "numOfRows": rows,
    })
