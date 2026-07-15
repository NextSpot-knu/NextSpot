"""TourAPI 관광 데이터랩 계열 API 클라이언트.

KorService2와 활용신청이 분리된 세 상품을 다룬다. 기존 TOURAPI_KEY를 공유하지만
해당 상품 승인이 없으면 403이므로 호출부는 반드시 저하 모드로 동작해야 한다.
"""

from typing import Any

from app.services.tourapi.client import _get_client, _require_key, parse_items


GYEONGBUK_TOURISM_AREA_CODE = 47
GYEONGJU_TOURISM_SIGNGU_CODE = 47130


class TourismInsightsError(RuntimeError):
    pass


async def _insight_get(base_url: str, endpoint: str, params: dict[str, Any]) -> dict:
    query = {
        "serviceKey": _require_key(),
        "MobileOS": "ETC",
        "MobileApp": "NextSpot",
        "_type": "json",
        **{key: value for key, value in params.items() if value is not None},
    }
    try:
        response = await _get_client().get(f"{base_url}/{endpoint}", params=query)
        response.raise_for_status()
        payload = response.json()
    except Exception:
        raise TourismInsightsError(
            f"관광 데이터랩 API 호출에 실패했습니다({endpoint}). 별도 활용승인 상태를 확인하세요."
        ) from None
    return payload


async def concentration_forecast(
    *, tourist_name: str | None = None, page: int = 1, rows: int = 100
) -> dict:
    """관광지별 향후 30일 집중률(0~100 상대지수). 실시간 혼잡도로 사용하지 않는다."""
    return await _insight_get(
        "https://apis.data.go.kr/B551011/TatsCnctrRateService",
        "tatsCnctrRatedList",
        {
            "areaCd": GYEONGBUK_TOURISM_AREA_CODE,
            "signguCd": GYEONGJU_TOURISM_SIGNGU_CODE,
            "tAtsNm": tourist_name,
            "pageNo": page,
            "numOfRows": rows,
        },
    )


async def related_attractions(*, base_ym: str, page: int = 1, rows: int = 100) -> dict:
    """Tmap 차량 이동 기반 연관 관광지. 후보 생성 prior로만 사용한다."""
    return await _insight_get(
        "https://apis.data.go.kr/B551011/TarRlteTarService1",
        "areaBasedList1",
        {
            "baseYm": base_ym,
            "areaCd": GYEONGBUK_TOURISM_AREA_CODE,
            "signguCd": GYEONGJU_TOURISM_SIGNGU_CODE,
            "pageNo": page,
            "numOfRows": rows,
        },
    )


def normalized_concentration_rows(payload: Any) -> list[dict]:
    """스키마 버전별 필드명 차이를 흡수해 저장 가능한 집중률 행으로 정규화한다."""
    rows: list[dict] = []
    for item in parse_items(payload):
        name = item.get("tAtsNm") or item.get("tatsNm") or item.get("touristAttractionName")
        code = item.get("tAtsCd") or item.get("tatsCd") or item.get("touristAttractionCode")
        forecast_date = item.get("fcastYmd") or item.get("baseYmd") or item.get("forecastDate")
        raw_rate = item.get("cnctrRate") or item.get("cnctrRt") or item.get("concentrationRate")
        if not name or not forecast_date or raw_rate in (None, ""):
            continue
        try:
            rate = max(0.0, min(100.0, float(raw_rate)))
        except (TypeError, ValueError):
            continue
        date_text = str(forecast_date)
        if len(date_text) == 8 and date_text.isdigit():
            date_text = f"{date_text[:4]}-{date_text[4:6]}-{date_text[6:]}"
        rows.append({
            "tourist_attraction_code": str(code) if code not in (None, "") else None,
            "tourist_attraction_name": str(name).strip(),
            "forecast_date": date_text,
            "concentration_rate": rate,
            "raw": item,
        })
    return rows

