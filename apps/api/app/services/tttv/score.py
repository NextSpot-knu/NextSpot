import asyncio
from datetime import datetime, timedelta, timezone
from pydantic import BaseModel
from app.services.tttv.preference import calculate_preference_similarity
from app.services.tttv.wait_time import calculate_predicted_wait_time
from app.services.tttv.travel import get_travel_time_and_distance
from app.services.predict_service import predict_congestion

# 가중치 정의 (황금비: 0.45 : 0.25 : 0.30)
W1 = 0.45  # 선호도 가중치
W2 = 0.25  # 시간 비용(대기+이동) 가중치
W3 = 0.30  # 혼잡 분산 인센티브 가중치

class TTTVScoreResult(BaseModel):
    score: float
    breakdown: dict  # { preference, wait_time, travel_time, incentive }

async def calculate_tttv_score(
    user_id: str,
    preferred_categories: list[str],
    original_facility_type: str,
    original_congestion_level: float,
    candidate_facility: dict,      # id, type, latitude, longitude, capacity, features 등 포함
    candidate_congestion_level: float,
    user_lat: float,
    user_lng: float,
    user_vector: list[float] | None = None,  # 호출측에서 1회 조회해 넘기면 후보마다 선호 벡터 저장소 재조회 안 함
) -> TTTVScoreResult:
    """
    사용자 정보, 원본 시설 혼잡 정보, 후보 대안 시설 정보 및 사용자 현재 위치를 입력받아
    TTTV(Total Time to Value) 추천 스코어를 산출합니다.
    """
    # 1. 선호도 코사인 유사도 (w1)
    preference_sim = await calculate_preference_similarity(
        user_id=user_id,
        facility_type=candidate_facility["type"],
        preferred_categories=preferred_categories,
        facility_features=candidate_facility.get("features"),
        user_vector=user_vector,
    )

    # --- 시간비용 계산 수정 전후 명시 ---
    # [수정 전 - 기존 시간비용 계산 로직]
    # predicted_wait = await calculate_predicted_wait_time(
    #     facility_type=candidate_facility["type"],
    #     congestion_level=candidate_congestion_level,
    #     facility_features=candidate_facility.get("features")
    # )
    # travel_time_min, distance_m = await get_travel_time_and_distance(
    #     start_lat=user_lat,
    #     start_lng=user_lng,
    #     end_lat=candidate_facility["latitude"],
    #     end_lng=candidate_facility["longitude"]
    # )
    # total_time = predicted_wait + travel_time_min
    # time_cost = min(1.0, total_time / 60.0)

    # [수정 후 - 변경된 시간비용 계산 로직]
    # 2. 이동 시간 우선 획득
    travel_time_min, distance_m = await get_travel_time_and_distance(
        start_lat=user_lat,
        start_lng=user_lng,
        end_lat=candidate_facility["latitude"],
        end_lng=candidate_facility["longitude"]
    )

    # 3. 도착 예상 시점 혼잡도 예측
    # 모델은 UTC 시각 기준으로 학습됨(train.py: fromisoformat(+00:00).hour). Cloud Run 런타임도 UTC라
    # 정합하나, 로컬/다른 타임존 호스트에서 datetime.now()가 흔들리지 않도록 명시적으로 UTC를 사용한다.
    arrival_dt = datetime.now(timezone.utc) + timedelta(minutes=travel_time_min)
    arrival_hour = arrival_dt.hour
    arrival_dow = arrival_dt.weekday()
    # predict_congestion 은 동기 함수(로컬 sklearn 추론)이므로, async 컨텍스트의 이벤트 루프를
    # 막지 않도록 워커 스레드로 오프로드한다.
    predicted_congestion = await asyncio.to_thread(
        predict_congestion,
        candidate_facility["type"],
        arrival_hour,
        arrival_dow,
    )

    # 4. 예측 혼잡도를 적용한 대기 시간 계산
    #    피크 시간대 보정도 predict_congestion 과 동일하게 '도착 예상 시점(UTC) hour' 기준을 공유한다
    #    (한 산식 안에서 대기시간만 '현재 시각'으로 보정되던 시점 불일치 제거).
    predicted_wait = await calculate_predicted_wait_time(
        facility_type=candidate_facility["type"],
        congestion_level=predicted_congestion,
        facility_features=candidate_facility.get("features"),
        hour=arrival_hour,
    )

    total_time = predicted_wait + travel_time_min
    time_cost = min(1.0, total_time / 60.0)

    # 5. 혼잡도 분산 기여 인센티브 (w3)
    # 기존에 요청했던 혼잡 시설에서 덜 혼잡한 후보 시설로 갈수록 높은 인센티브를 부여
    # 주의(설계 메모): 이 항은 원본/후보 모두 '현재' 혼잡도를 쓴다(호출측 fetch_latest_congestion).
    # 반면 위 time_cost(대기시간)는 후보의 '도착 예상 시점' 예측 혼잡도를 쓴다. 두 항의 혼잡도 기준
    # 시점이 다른 것은 의도된 단순화이며(원본 도착시점 정의 모호 + 가중치/랭킹 동작 보존), 도착시점으로
    # 통일하려면 가중치 고정 정책상 사전 합의가 필요하다. 현 시점에선 시점 차이를 명시만 한다.
    incentive = max(0.0, original_congestion_level - candidate_congestion_level)

    # 6. TTTV 종합 스코어 계산 및 Min-Max 정규화 적용
    # 공식: w1 * preference - w2 * time_cost + w3 * incentive
    tttv_score = (W1 * preference_sim) - (W2 * time_cost) + (W3 * incentive)

    # 시간비용 감산 패널티로 인한 점수 하향 왜곡 방지를 위해 Min-Max 정규화 적용
    # min_possible = -W2, max_possible = W1 + W3, range_width = W1 + W2 + W3
    normalized_score = (tttv_score + W2) / (W1 + W2 + W3)
    final_score = round(max(0.0, min(1.0, normalized_score)), 3)

    return TTTVScoreResult(
        score=final_score,
        breakdown={
            "preference": round(preference_sim, 3),
            "wait_time": predicted_wait,
            "travel_time": travel_time_min,
            "incentive": round(incentive, 3)
        }
    )
