import asyncio
from datetime import datetime, timedelta, timezone
from pydantic import BaseModel
from app.services.spot.preference import calculate_preference_similarity
from app.services.spot.wait_time import calculate_predicted_wait_time
from app.services.spot.travel import get_travel_time_and_distance
from app.services.event_boost import get_event_congestion_boost
from app.services.predict_service import predict_congestion

# 가중치 정의 — 2026 관광데이터 활용 공모전 제안서 기준 (0.40 / 0.40 / 0.20).
# ⚠️ 이 상수는 packages/shared-types/spot.ts 의 SPOT_WEIGHTS 와 정합해야 한다
# (프론트 시뮬레이터/미러가 그 파일을 import). tests/services/test_spot.py 의
# 패리티 테스트가 CI 에서 양쪽 일치를 강제한다 — 한쪽만 바꾸면 CI 가 실패한다.
W1 = 0.40  # 선호도(취향 일치율) 가중치
W2 = 0.40  # 시간 비용(도착시점 예측 대기 + 이동) 가중치
W3 = 0.20  # 인센티브 가중치 — D1 재결정(2026-07-07): 쿠폰 강도 + 수요 재배치 기여 결합

# 인센티브 항 내부 구성 — incentive = COUPON_SHARE·쿠폰강도 + (1−COUPON_SHARE)·재배치기여
#  · 쿠폰강도  = min(1, coupon_rate / COUPON_RATE_CAP) — 제휴 등급(할인율)을 연속값으로 반영
#  · 재배치기여 = max(0, min(1, 원본혼잡 − 후보 '도착시점' 예측혼잡)) — 수요 분산 기여(B2G 관점).
#    후보 혼잡을 도착시점 예측치로 써서 w2(대기시간)와 시간 기준을 통일한다(과거 '현재 혼잡' 사용
#    시점 불일치 해소). 두 성분 모두 [0,1] 이라 incentive ∈ [0,1] — 정규화 상하한이 보존된다.
INCENTIVE_COUPON_SHARE = 0.5
COUPON_RATE_CAP = 0.20  # 할인율 20% 이상은 만점 취급

class SPOTScoreResult(BaseModel):
    score: float
    breakdown: dict  # { preference, wait_time, travel_time, incentive }

async def calculate_spot_score(
    user_id: str,
    preferred_categories: list[str],
    original_congestion_level: float,
    candidate_facility: dict,      # id, type, latitude, longitude, capacity, features, coupon_rate 등 포함
    user_lat: float,
    user_lng: float,
    user_vector: list[float] | None = None,  # 호출측에서 1회 조회해 넘기면 후보마다 선호 벡터 저장소 재조회 안 함
    depart_time: datetime | None = None,  # 후보를 향해 '출발하는' 기준 시각(UTC). 멀티스톱 코스(courses)가
                                          # 누적 도착을 반영하도록 전달. None 이면 지금 출발(datetime.now) — 단일 대안 추천의 기존 동작.
) -> SPOTScoreResult:
    """
    사용자 정보, 원본 시설 혼잡도, 후보 대안 시설 정보 및 사용자 현재 위치를 입력받아
    SPOT(Smart Place Optimization for Tourism) 추천 스코어를 산출합니다.

    (원본 시설 '타입'·후보 '현재 혼잡도' 인자는 산식에서 쓰이지 않아 제거 — 대기시간과
     재배치기여는 후보의 '도착 예상 시점' 예측 혼잡도를 사용하며, 후보의 현재 혼잡도는
     라우터가 추천 '사유' 생성과 응답 표시에만 사용한다.)
    """
    # 1. 선호도 코사인 유사도 (w1)
    # TourAPI 적재 행은 barrier_free 가 features JSONB 가 아닌 정규 컬럼에 있으므로,
    # 선호 벡터 보정(접근성 차원)이 두 경로 모두에서 동작하도록 features 로 브리지한다.
    features = dict(candidate_facility.get("features") or {})
    if candidate_facility.get("barrier_free") is not None:
        features.setdefault("barrier_free", candidate_facility["barrier_free"])

    preference_sim = await calculate_preference_similarity(
        user_id=user_id,
        facility_type=candidate_facility["type"],
        preferred_categories=preferred_categories,
        facility_features=features,
        user_vector=user_vector,
    )

    # 2. 이동 시간 우선 획득 (거리는 산식 미사용 — 라우터가 Haversine 으로 별도 계산)
    travel_time_min, _ = await get_travel_time_and_distance(
        start_lat=user_lat,
        start_lng=user_lng,
        end_lat=candidate_facility["latitude"],
        end_lng=candidate_facility["longitude"]
    )

    # 3. 도착 예상 시점 혼잡도 예측
    # 모델은 UTC 시각 기준으로 학습됨(train.py: fromisoformat(+00:00).hour).
    # 로컬/다른 타임존 호스트에서 datetime.now()가 흔들리지 않도록 명시적으로 UTC를 사용한다.
    # depart_time 이 오면 '그 출발 시각 + 이 구간 이동시간' = 코스의 누적 도착 시각(2~3번째 정류지 정합).
    # 없으면 지금 출발 기준(단일 대안 추천). 이 arrival 은 아래 wait_time·재배치기여에 함께 쓰인다.
    base_time = depart_time or datetime.now(timezone.utc)
    arrival_dt = base_time + timedelta(minutes=travel_time_min)
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

    # 관광공사 관광지 집중률은 향후 30일 '일별 상대지수'(0~100)이지 실시간 혼잡이 아니다.
    # 이름이 정확히 매칭돼 적재된 후보에만 보수적으로 25% prior로 결합하고, 자체 도착시점
    # 시간대 모델을 75% 유지한다. 미매칭/미승인 환경은 기존 결과가 완전히 동일하다.
    tourapi_rate = candidate_facility.get("tourapi_concentration_rate")
    tourapi_prior = None
    if tourapi_rate is not None:
        try:
            tourapi_prior = max(0.0, min(1.0, float(tourapi_rate) / 100.0))
            predicted_congestion = 0.75 * predicted_congestion + 0.25 * tourapi_prior
        except (TypeError, ValueError):
            tourapi_prior = None

    # 3-1. 행사 혼잡 보정(A4) — 도착시점에 인근에서 진행 중인 축제가 있으면 예측 혼잡을
    # 거리 감쇠 가중으로 상향한다(모델이 모르는 외부 변수). 축제 조회 실패는 (0, None)
    # 무해 폴백이라 채점 플로우를 막지 않는다. 보정된 값이 아래 대기시간·재배치기여에
    # 일관되게 쓰인다(한 산식 안에서 같은 '도착시점 혼잡' 기준 유지).
    event_boost, event_title = await get_event_congestion_boost(
        candidate_facility["latitude"], candidate_facility["longitude"], arrival_dt
    )
    predicted_congestion = min(1.0, predicted_congestion + event_boost)

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

    # 5. 인센티브 (w3) — 쿠폰 강도 + 수요 재배치 기여 결합 (D1 재결정 2026-07-07).
    #  · 쿠폰강도: 제휴 할인율(coupon_rate, 예 0.10=10%)을 20% 캡으로 정규화 — 0/1 이 아닌
    #    제휴 등급의 연속 반영. 컬럼 미존재/NULL(구 스키마·TourAPI 미보강 행)은 0 안전 처리.
    #  · 재배치기여: 혼잡한 원본에서 '도착시점에 여유로울' 후보로 옮길수록 커지는 수요 분산
    #    기여분 — w2(개인의 대기 비용)와 달리 시스템 관점의 혼잡 완화를 보상한다(B2G 지표).
    coupon_term = min(1.0, (candidate_facility.get("coupon_rate") or 0.0) / COUPON_RATE_CAP)
    relief_term = max(0.0, min(1.0, original_congestion_level - predicted_congestion))
    incentive = INCENTIVE_COUPON_SHARE * coupon_term + (1.0 - INCENTIVE_COUPON_SHARE) * relief_term

    # 6. SPOT 종합 스코어 계산 및 Min-Max 정규화 적용
    # 공식: w1 * preference - w2 * time_cost + w3 * incentive
    spot_score = (W1 * preference_sim) - (W2 * time_cost) + (W3 * incentive)

    # 시간비용 감산 패널티로 인한 점수 하향 왜곡 방지를 위해 Min-Max 정규화 적용
    # (preference∈[0,1], time_cost∈[0,1], incentive∈[0,1] 이므로
    #  min_possible = -W2, max_possible = W1 + W3, range_width = W1 + W2 + W3 — 가중치 무관하게 성립)
    normalized_score = (spot_score + W2) / (W1 + W2 + W3)
    final_score = round(max(0.0, min(1.0, normalized_score)), 3)

    return SPOTScoreResult(
        score=final_score,
        breakdown={
            "preference": round(preference_sim, 3),
            "wait_time": predicted_wait,
            "travel_time": travel_time_min,
            "incentive": round(incentive, 3),
            # 인센티브 구성 성분(추천 사유·시뮬레이터 설명용): 쿠폰강도 / 수요 재배치 기여
            "incentive_coupon": round(coupon_term, 3),
            "incentive_relief": round(relief_term, 3),
            # 행사 혼잡 보정(A4) — 프런트 배지·투명성 표기용. 보정 없으면 0 / None.
            "event_boost": round(event_boost, 3),
            "event_title": event_title,
            # 관광공사 30일 일별 상대 전망. None이면 미승인/미매칭이며 실시간 실측으로 표시하면 안 된다.
            "tourapi_concentration_prior": round(tourapi_prior, 3) if tourapi_prior is not None else None,
        }
    )
