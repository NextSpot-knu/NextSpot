"""Walking travel estimates with an optional real pedestrian-network matrix."""
import math
from dataclasses import dataclass

import httpx
import structlog

from app.core.config import settings

logger = structlog.get_logger()

WALKING_SPEED_M_PER_MIN = 66.67
FALLBACK_ROUTE_FACTOR = 1.18
ORS_MATRIX_URL = "https://api.openrouteservice.org/v2/matrix/foot-walking"
ORS_DESTINATION_CHUNK = 40


@dataclass(frozen=True)
class WalkingRoute:
    duration_min: float
    distance_m: float
    source: str

def calculate_haversine_distance(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r_lat1, r_lng1, r_lat2, r_lng2 = map(math.radians, [lat1, lng1, lat2, lng2])
    
    d_lat = r_lat2 - r_lat1
    d_lng = r_lng2 - r_lng1
    
    a = math.sin(d_lat / 2)**2 + math.cos(r_lat1) * math.cos(r_lat2) * math.sin(d_lng / 2)**2
    c = 2 * math.asin(min(1.0, math.sqrt(a)))
    
    distance = 6371000 * c
    return round(distance, 1)


def estimate_walking_route(start_lat: float, start_lng: float, end_lat: float, end_lng: float) -> WalkingRoute:
    straight = calculate_haversine_distance(start_lat, start_lng, end_lat, end_lng)
    distance = straight * FALLBACK_ROUTE_FACTOR
    return WalkingRoute(round(distance / WALKING_SPEED_M_PER_MIN, 1), round(distance, 1), "estimated")


async def get_walking_routes(
    start_lat: float, start_lng: float, destinations: list[tuple[float, float]]
) -> list[WalkingRoute]:
    """Return routes in input order; external failures preserve availability via estimates."""
    fallback = [estimate_walking_route(start_lat, start_lng, lat, lng) for lat, lng in destinations]
    if not destinations or not settings.OPENROUTESERVICE_API_KEY:
        return fallback

    resolved = list(fallback)
    headers = {
        "Authorization": settings.OPENROUTESERVICE_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            for offset in range(0, len(destinations), ORS_DESTINATION_CHUNK):
                chunk = destinations[offset:offset + ORS_DESTINATION_CHUNK]
                locations = [[start_lng, start_lat], *[[lng, lat] for lat, lng in chunk]]
                response = await client.post(
                    ORS_MATRIX_URL,
                    headers=headers,
                    json={
                        "locations": locations,
                        "sources": ["0"],
                        "destinations": [str(i) for i in range(1, len(locations))],
                        "metrics": ["duration", "distance"],
                        "units": "m",
                    },
                )
                response.raise_for_status()
                body = response.json()
                durations = (body.get("durations") or [[]])[0]
                distances = (body.get("distances") or [[]])[0]
                for local_idx, (seconds, metres) in enumerate(zip(durations, distances)):
                    if seconds is None or metres is None:
                        continue
                    resolved[offset + local_idx] = WalkingRoute(
                        round(float(seconds) / 60.0, 1), round(float(metres), 1), "openrouteservice"
                    )
    except (httpx.HTTPError, ValueError, TypeError, IndexError) as exc:
        logger.warning("walking_matrix_fallback", error=str(exc))
    return resolved


async def get_travel_time_and_distance(
    start_lat: float, start_lng: float,
    end_lat: float, end_lng: float
) -> tuple[float, float]:
    route = (await get_walking_routes(start_lat, start_lng, [(end_lat, end_lng)]))[0]
    return route.duration_min, route.distance_m
