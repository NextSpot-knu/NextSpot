"""공개 데이터로 후보 주변의 지역 수요를 계산한다.

이 값은 매장 내부 혼잡도나 대기시간 예측이 아니다. 공영주차 실시간 점유율을 우선하고,
관광공사 일별 집중률을 통계 기준선으로 보완한다. 축제와 날씨는 기준선이 있을 때만 작은
보정으로 더한다. 근거가 없으면 숫자를 만들지 않고 ``None``을 반환한다.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

from app.services.area_demand_forecast_service import get_historical_area_demand_forecast
from app.services.event_boost import get_event_congestion_boost
from app.services.parking_demand_service import get_nearby_parking_signal
from app.services.weather_service import get_gyeongju_weather

_PARKING_WEIGHT = 0.7
_TOURISM_WEIGHT = 0.3
_MAX_BASE_PENALTY_MIN = 8.0
_MAX_EVENT_PENALTY_MIN = 3.0
_WEATHER_DELTA = 0.06
_LIVE_ARRIVAL_HORIZON = timedelta(minutes=30)


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _tourism_level(candidate: dict[str, Any]) -> float | None:
    try:
        value = float(candidate.get("tourapi_concentration_rate")) / 100.0
    except (TypeError, ValueError):
        return None
    return _clamp(value)


def _tourism_evidence(candidate: dict[str, Any]) -> dict[str, Any] | None:
    """관광공사 상대지수의 기준을 UI가 오해 없이 설명할 수 있게 보존한다."""
    level = _tourism_level(candidate)
    if level is None:
        return None
    reference_name = str(candidate.get("tourapi_concentration_basis") or "").strip()
    forecast_date = str(candidate.get("tourapi_concentration_forecast_date") or "").strip()
    try:
        distance_m = max(0.0, float(candidate.get("tourapi_concentration_distance_m")))
    except (TypeError, ValueError):
        distance_m = None
    try:
        source_rate = max(
            0.0,
            min(
                100.0,
                float(
                    candidate.get("tourapi_concentration_source_rate")
                    if candidate.get("tourapi_concentration_source_rate") is not None
                    else candidate.get("tourapi_concentration_rate")
                ),
            ),
        )
    except (TypeError, ValueError):
        source_rate = None
    return {
        "reference_name": reference_name or None,
        "distance_m": round(distance_m, 1) if distance_m is not None else None,
        "forecast_date": forecast_date or None,
        # 이 값만 화면에 표시한다. 후보에 거리 감쇠해 적용한 내부 ranking level과 구분한다.
        "relative_index": round(source_rate, 1) if source_rate is not None else None,
    }


def _live_parking_applies_to_arrival(
    parking: dict[str, Any] | None, arrival: datetime
) -> bool:
    """현재 주차 실측을 가까운 도착에만 사용한다.

    이력 기반 예측이 검증되기 전에는 현재 관측을 먼 미래의 값처럼 확장하지 않는다.
    관측 시각을 해석할 수 없거나 도착이 관측보다 30분 넘게 뒤라면 통계 근거로 폴백한다.
    """
    if parking is None:
        return False
    try:
        observed_at = datetime.fromisoformat(str(parking["observed_at"]))
    except (KeyError, TypeError, ValueError):
        return False
    if observed_at.tzinfo is None:
        observed_at = observed_at.replace(tzinfo=timezone.utc)
    if arrival.tzinfo is None:
        arrival = arrival.replace(tzinfo=timezone.utc)
    horizon = arrival.astimezone(timezone.utc) - observed_at.astimezone(timezone.utc)
    return timedelta(0) <= horizon <= _LIVE_ARRIVAL_HORIZON


def _is_indoor(candidate: dict[str, Any]) -> bool | None:
    features = candidate.get("features") or {}
    raw = features.get("indoor") if isinstance(features, dict) else None
    if isinstance(raw, bool):
        return raw
    facility_type = str(candidate.get("type") or "")
    if facility_type in {"restaurant", "cafe", "culture"}:
        return True
    if facility_type == "attraction":
        return False
    return None


def _weather_risk(weather: dict[str, Any] | None, arrival: datetime) -> bool:
    if not weather:
        return False
    forecasts = weather.get("forecasts") or []
    nearest: dict[str, Any] | None = None
    nearest_seconds: float | None = None
    for forecast in forecasts:
        try:
            seconds = abs((datetime.fromisoformat(str(forecast["at"])) - arrival).total_seconds())
        except (KeyError, TypeError, ValueError):
            continue
        if nearest_seconds is None or seconds < nearest_seconds:
            nearest, nearest_seconds = forecast, seconds
    point = nearest or weather.get("current") or {}
    try:
        severe = (
            int(point.get("precipitation_type", 0)) > 0
            or int(point.get("precipitation_probability", 0)) >= 60
            or float(point.get("temperature_c", 20)) >= 33
            or float(point.get("temperature_c", 20)) <= -5
            or float(point.get("wind_speed_mps", 0)) >= 9
        )
    except (TypeError, ValueError):
        severe = False
    return severe


async def get_area_demand_signal(
    candidate: dict[str, Any], arrival: datetime
) -> dict[str, Any] | None:
    """검증 가능한 주변 수요 신호와 순위용 제한 패널티를 반환한다."""
    latitude = float(candidate["latitude"])
    longitude = float(candidate["longitude"])
    parking, event, weather = await asyncio.gather(
        get_nearby_parking_signal(latitude, longitude),
        get_event_congestion_boost(latitude, longitude, arrival),
        get_gyeongju_weather(arrival),
    )
    tourism = _tourism_level(candidate)
    tourism_evidence = _tourism_evidence(candidate)
    event_boost, event_title = event

    live_parking_applies = _live_parking_applies_to_arrival(parking, arrival)
    history = None
    if not live_parking_applies:
        parking = None
        history = await get_historical_area_demand_forecast(
            latitude, longitude, arrival
        )

    sources: list[str] = []
    components: dict[str, float] = {}
    observed_at: str | None = None
    if parking is not None:
        parking_level = _clamp(float(parking["level"]))
        sources.append("parking")
        components["parking"] = round(parking_level, 4)
        observed_at = parking.get("observed_at")
        demand_mode = "live"
        confidence = "high"
        parking_evidence = {
            "level": round(parking_level, 4),
            "mode": "live",
            "observed_at": observed_at,
            "radius_m": parking.get("radius_m"),
        }
    elif history is not None:
        parking_level = _clamp(float(history["level"]))
        sources.append("parking_history")
        components["parking_history"] = round(parking_level, 4)
        observed_at = history.get("observed_at")
        demand_mode = "forecast"
        confidence = history.get("confidence") or "medium"
        parking_evidence = {
            "level": round(parking_level, 4),
            "mode": "forecast",
            "observed_at": observed_at,
            "radius_m": history.get("radius_m"),
        }
    else:
        parking_level = None
        demand_mode = None
        confidence = None
        parking_evidence = None
    if tourism is not None:
        sources.append("tourism")
        components["tourism"] = round(tourism, 4)

    if parking_level is not None and tourism is not None:
        base_level = _PARKING_WEIGHT * parking_level + _TOURISM_WEIGHT * tourism
        mode = demand_mode
    elif parking_level is not None:
        base_level = parking_level
        mode = demand_mode
    elif tourism is not None:
        base_level = tourism
        mode = "statistical"
        confidence = "medium"
    else:
        if event_boost <= 0:
            return None
        return {
            "level": None,
            "mode": "contextual",
            "sources": ["festival"],
            "observed_at": None,
            "components": {"festival": round(event_boost, 4)},
            "confidence": "low",
            "ranking_penalty_minutes": round(
                min(_MAX_EVENT_PENALTY_MIN, event_boost * 20.0), 2
            ),
            "parking_penalty_minutes": 0.0,
            "event_boost": round(event_boost, 4),
            "event_title": event_title,
            "parking_evidence": None,
            "tourism_evidence": None,
        }

    level = base_level
    if event_boost > 0:
        level += event_boost
        sources.append("festival")
        components["festival"] = round(event_boost, 4)

    indoor = _is_indoor(candidate)
    weather_delta = 0.0
    if _weather_risk(weather, arrival) and indoor is not None:
        weather_delta = _WEATHER_DELTA if indoor else -_WEATHER_DELTA
        level += weather_delta
        sources.append("weather")
        components["weather"] = round(weather_delta, 4)

    level = _clamp(level)
    penalty = base_level * _MAX_BASE_PENALTY_MIN
    penalty += min(_MAX_EVENT_PENALTY_MIN, event_boost * 20.0)
    penalty += weather_delta * 10.0
    parking_penalty = (parking_level or 0.0) * 4.0
    return {
        "level": round(level, 4),
        "mode": mode,
        "sources": sources,
        "observed_at": observed_at,
        "components": components,
        "confidence": confidence,
        "history": history,
        "ranking_penalty_minutes": round(max(0.0, penalty), 2),
        # 활성 장소 모델이 있을 때 관광 prior·행사 보정과 중복되지 않게 주차 신호만 별도 사용한다.
        "parking_penalty_minutes": round(parking_penalty, 2),
        "event_boost": round(event_boost, 4),
        "event_title": event_title,
        "radius_m": (parking or history or {}).get("radius_m"),
        # 주차 실측/이력과 관광 통계는 측정 대상과 시간 해상도가 다르다. 종합 level은
        # 추천 순위용으로만 유지하고, 화면은 아래 두 근거를 독립적으로 설명한다.
        "parking_evidence": parking_evidence,
        "tourism_evidence": tourism_evidence,
    }
