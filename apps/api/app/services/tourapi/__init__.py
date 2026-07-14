"""한국관광공사 TourAPI 연동 패키지 — 공모전 필수 데이터 소스.

client.py    : KorService2 비동기 HTTP 클라이언트(일 1회 TTL 캐시 포함)
transform.py : 응답 → facilities 행 변환 순수 함수(단위 테스트 대상)
"""

from app.services.tourapi.client import (
    BASE_URL,
    CACHE_TTL_SECONDS,
    TourAPIError,
    area_based_list,
    detail_common,
    detail_info,
    detail_intro,
    location_based_list,
    parse_items,
    parse_total_count,
    search_festival,
)
from app.services.tourapi.transform import (
    CAPACITY_DEFAULTS,
    CAT3_CAFE,
    CONTENT_TYPE_IDS,
    extract_barrier_free,
    extract_detail_common,
    extract_operating_hours,
    map_facility_type,
    transform_poi,
)

__all__ = [
    "BASE_URL",
    "CACHE_TTL_SECONDS",
    "TourAPIError",
    "area_based_list",
    "detail_common",
    "detail_info",
    "detail_intro",
    "location_based_list",
    "parse_items",
    "parse_total_count",
    "search_festival",
    "CAPACITY_DEFAULTS",
    "CAT3_CAFE",
    "CONTENT_TYPE_IDS",
    "extract_barrier_free",
    "extract_detail_common",
    "extract_operating_hours",
    "map_facility_type",
    "transform_poi",
]
