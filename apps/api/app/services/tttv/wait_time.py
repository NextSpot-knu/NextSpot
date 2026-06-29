from datetime import datetime, timezone

# 시설 타입별 기본 평균 처리 시간 (단위: 분)
DEFAULT_PROCESSING_TIMES = {
    "restaurant": 25,   # 식사·웨이팅
    "cafe": 12,         # 주문·좌석 회전
    "attraction": 15,   # 입장·관람 대기
    "culture": 15,      # 관람 대기
}

async def calculate_predicted_wait_time(
    facility_type: str,
    congestion_level: float,
    facility_features: dict = None,
    hour: int | None = None,
) -> float:
    """
    혼잡도(congestion_level: 0.0 ~ 1.0)와 기본 처리 시간 및 시간대 보정을 적용해
    예측 대기 시간(분 단위)을 계산합니다.

    hour: 보정 기준 시각(0~23). 호출측(score.py)이 '도착 예상 시점(UTC) hour'를 넘기면
          혼잡도 예측(predict_congestion)과 동일한 시점 기준을 공유한다. None 이면 현재 UTC 시각을
          사용한다(모델·런타임이 모두 UTC 기준이므로 datetime.now(timezone.utc)로 통일).
    """
    # 1. 평균 처리 시간 획득
    avg_process_time = DEFAULT_PROCESSING_TIMES.get(facility_type, 15)
    if facility_features and "average_processing_time" in facility_features:
        avg_process_time = facility_features["average_processing_time"]

    # 2. 시간대 보정 계수 산출 (도착 예상 시점 기준, 미지정 시 현재 UTC)
    if hour is None:
        hour = datetime.now(timezone.utc).hour

    time_multiplier = 1.0
    if 11 <= hour < 14:
        # 점심·정오 관광 피크 보정 (11시 ~ 13시 59분)
        time_multiplier = 1.3
    elif 14 <= hour < 18:
        # 오후 관광 피크 보정 (14시 ~ 17시 59분)
        time_multiplier = 1.2

    # 3. 예측 대기 시간 공식 계산
    # 예측 대기 시간 = 혼잡도 * 평균 처리 시간 * 시간대 보정
    predicted_wait = congestion_level * avg_process_time * time_multiplier
    
    return round(predicted_wait, 1)
