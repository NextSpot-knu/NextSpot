import math

# 도보 속도: 4 km/h = 4000 m / 60 분 = 66.67 m/min
WALKING_SPEED_M_PER_MIN = 66.67

def calculate_haversine_distance(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """
    두 좌표 간의 직선 거리(미터)를 Haversine 공식으로 산출합니다.
    """
    # 라디안 변환
    r_lat1, r_lng1, r_lat2, r_lng2 = map(math.radians, [lat1, lng1, lat2, lng2])
    
    d_lat = r_lat2 - r_lat1
    d_lng = r_lng2 - r_lng1
    
    a = math.sin(d_lat / 2)**2 + math.cos(r_lat1) * math.cos(r_lat2) * math.sin(d_lng / 2)**2
    c = 2 * math.asin(min(1.0, math.sqrt(a)))
    
    # 지구 반경 6,371,000m
    distance = 6371000 * c
    return round(distance, 1)


async def get_travel_time_and_distance(
    start_lat: float, start_lng: float,
    end_lat: float, end_lng: float
) -> tuple[float, float]:
    """
    출발지와 도착지 간의 이동 시간(분 단위) 및 이동 거리(미터 단위)를 획득합니다.
    SPOT 계약은 도보 기준이다. Kakao Mobility 자동차 경로를 섞지 않고 동일 도보 속도로 계산한다.
    """
    distance_m = calculate_haversine_distance(start_lat, start_lng, end_lat, end_lng)
    
    travel_time_min = distance_m / WALKING_SPEED_M_PER_MIN
    return round(travel_time_min, 1), round(distance_m, 1)
