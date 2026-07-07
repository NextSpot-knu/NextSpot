import math
import httpx
from app.core.config import settings

# 도보 속도: 4 km/h = 4000 m / 60 분 = 66.67 m/min
WALKING_SPEED_M_PER_MIN = 66.67

# Kakao Directions 호출용 단일 httpx 클라이언트(후보마다 새 클라이언트 생성·TCP/TLS 핸드셰이크 반복 방지).
# import 시점이 아니라 이벤트 루프 안에서 최초 호출 시 lazy 생성(루프 미바인딩·미종료 누수 방지).
_client = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=2.0, limits=httpx.Limits(max_connections=20))
    return _client

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
    Kakao Maps Directions API 키가 존재하면 비동기 호출을 시도하며, 실패하거나 키가 없을 시
    Haversine 도보 계산법으로 fallback 처리합니다.
    """
    distance_m = calculate_haversine_distance(start_lat, start_lng, end_lat, end_lng)
    
    # 기본값: Haversine 도보 속도 기준
    travel_time_min = distance_m / WALKING_SPEED_M_PER_MIN

    # Kakao Mobility Directions API 키가 설정돼 있으면 실거리/실시간 이동시간으로 보정.
    # 키가 없으면(기본) 위 Haversine 도보 환산값을 그대로 사용한다.
    kakao_key = settings.KAKAO_REST_API_KEY
    if kakao_key:
        try:
            headers = {"Authorization": f"KakaoAK {kakao_key}"}
            url = "https://apis-navi.kakaomobility.com/v1/directions"
            params = {
                "origin": f"{start_lng},{start_lat}",
                "destination": f"{end_lng},{end_lat}",
                "priority": "TIME"
            }
            client = _get_client()
            response = await client.get(url, headers=headers, params=params)
            if response.status_code == 200:
                data = response.json()
                # 카카오 API 응답 규격 파싱
                routes = data.get("routes", [])
                if routes:
                    route0 = routes[0]
                    summary = route0.get("summary", {})
                    duration_sec = summary.get("duration")
                    # 경로 성공(result_code 0) + 양수 duration 일 때만 Haversine 폴백값을 덮어쓴다.
                    # Kakao 는 경로 실패(출발/도착 근접 104 등)에도 HTTP 200 + result_code≠0 + duration 누락/0 을
                    # 줄 수 있어, 이를 검사하지 않으면 유효한 Haversine 값이 0 으로 덮여 후보 랭킹이 왜곡된다.
                    if route0.get("result_code", 0) == 0 and duration_sec and duration_sec > 0:
                        travel_time_min = duration_sec / 60.0
                        dist = summary.get("distance")
                        if dist and dist > 0:
                            distance_m = dist
                    else:
                        print(
                            f"[travel] Kakao route invalid "
                            f"(result_code={route0.get('result_code')}, duration={duration_sec}). "
                            f"Keeping Haversine."
                        )
        except Exception as e:
            # 실패 시 로그를 남기고 Haversine 값 유지
            print(f"[travel] Kakao Maps Directions API failed: {str(e)}. Fallback to Haversine.")

    return round(travel_time_min, 1), round(distance_m, 1)
