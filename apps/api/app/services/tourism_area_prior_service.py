"""Attach KTO daily tourism statistics as conservative regional priors."""

from __future__ import annotations

import math
from typing import Any

from app.services.spot.travel import calculate_haversine_distance
from app.services.tourism_name_matching import match_tourism_forecasts_to_facilities


TOURISM_PRIOR_RADIUS_M = 2_000.0
_PRIOR_KEYS = (
    "tourapi_concentration_rate",
    "tourapi_concentration_basis",
    "tourapi_concentration_distance_m",
    "tourapi_concentration_forecast_date",
    "tourapi_concentration_source_rate",
)


def attach_tourism_area_priors(
    facilities: list[dict[str, Any]], forecasts: list[dict[str, Any]]
) -> None:
    """Mutate facilities with one-to-one anchors and 2 km distance-decayed priors."""
    for facility in facilities:
        for key in _PRIOR_KEYS:
            facility.pop(key, None)

    anchors: list[tuple[float, float, float, str, str | None]] = []
    for match in match_tourism_forecasts_to_facilities(facilities, forecasts):
        facility = match.facility
        row = match.forecast
        try:
            rate = float(row["concentration_rate"])
            lat, lng = float(facility["latitude"]), float(facility["longitude"])
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
        if not math.isfinite(rate) or not math.isfinite(lat) or not math.isfinite(lng):
            continue
        rate = max(0.0, min(100.0, rate))
        source_name = str(row.get("tourist_attraction_name") or "").strip()
        forecast_date = str(row.get("forecast_date") or "").strip() or None
        facility["tourapi_concentration_rate"] = rate
        facility["tourapi_concentration_basis"] = source_name
        facility["tourapi_concentration_distance_m"] = 0.0
        facility["tourapi_concentration_source_rate"] = rate
        facility["tourapi_concentration_forecast_date"] = forecast_date
        anchors.append((lat, lng, rate, source_name, forecast_date))

    for facility in facilities:
        if "tourapi_concentration_rate" in facility or not anchors:
            continue
        try:
            lat, lng = float(facility["latitude"]), float(facility["longitude"])
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
        if not math.isfinite(lat) or not math.isfinite(lng):
            continue
        distance_m, rate, source_name, forecast_date = min(
            (
                (
                    calculate_haversine_distance(lat, lng, anchor_lat, anchor_lng),
                    anchor_rate,
                    anchor_name,
                    anchor_date,
                )
                for anchor_lat, anchor_lng, anchor_rate, anchor_name, anchor_date in anchors
            ),
            key=lambda item: item[0],
        )
        if distance_m > TOURISM_PRIOR_RADIUS_M:
            continue
        decay = 1.0 - distance_m / TOURISM_PRIOR_RADIUS_M
        regional_rate = 50.0 + (rate - 50.0) * decay
        facility["tourapi_concentration_rate"] = round(regional_rate, 2)
        facility["tourapi_concentration_basis"] = source_name
        facility["tourapi_concentration_distance_m"] = round(distance_m, 1)
        facility["tourapi_concentration_source_rate"] = rate
        facility["tourapi_concentration_forecast_date"] = forecast_date
