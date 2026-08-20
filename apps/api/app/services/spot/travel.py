"""Key-free, conservative walking travel estimates."""
import math
from dataclasses import dataclass

WALKING_SPEED_M_PER_MIN = 66.67
FALLBACK_ROUTE_FACTOR = 1.18


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
    """Return deterministic estimates in input order without an external provider."""
    return [estimate_walking_route(start_lat, start_lng, lat, lng) for lat, lng in destinations]


async def get_travel_time_and_distance(
    start_lat: float, start_lng: float,
    end_lat: float, end_lng: float
) -> tuple[float, float]:
    route = (await get_walking_routes(start_lat, start_lng, [(end_lat, end_lng)]))[0]
    return route.duration_min, route.distance_m
