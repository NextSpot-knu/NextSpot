# pyrefly: ignore [missing-import]
import math
from app.services.preference_vector_service import preference_vector_service

# 8차원 카테고리 벡터 매핑 테이블 (관광 4타입: 음식점/카페/관광지/문화시설)
# dim0-3: 카테고리 원핫 / dim4: 맛·평점 / dim5: 감성·인스타 / dim6: 접근성·무장애 / dim7: 한적함
CATEGORY_VECTORS = {
    "restaurant": [1.0, 0.0, 0.0, 0.0, 0.3, 0.0, 0.0, 0.0],
    "cafe":       [0.0, 1.0, 0.0, 0.0, 0.1, 0.3, 0.0, 0.0],
    "attraction": [0.0, 0.0, 1.0, 0.0, 0.0, 0.1, 0.2, 0.0],
    "culture":    [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.2, 0.2],
}

def get_category_average_vector(preferred_categories: list[str]) -> list[float]:
    """
    온보딩 카테고리 리스트의 평균 벡터를 생성합니다. (Cold Start 방지용)
    """
    if not preferred_categories:
        # 선호 설정이 없으면 전체 카테고리의 중간값을 디폴트로 제공
        preferred_categories = list(CATEGORY_VECTORS.keys())

    sum_vec = [0.0] * 8
    count = 0
    for cat in preferred_categories:
        if cat in CATEGORY_VECTORS:
            sum_vec = [s + v for s, v in zip(sum_vec, CATEGORY_VECTORS[cat])]
            count += 1
            
    if count == 0:
        return [1.0 / math.sqrt(8)] * 8

    # 평균 연산
    avg_vec = [x / count for x in sum_vec]
    
    # L2 정규화
    sq_sum = sum(x ** 2 for x in avg_vec)
    norm = math.sqrt(sq_sum) if sq_sum > 0 else 1.0
    return [x / norm for x in avg_vec]


async def calculate_preference_similarity(
    user_id: str,
    facility_type: str,
    preferred_categories: list[str],
    facility_features: dict = None,
    user_vector: list[float] | None = None,
) -> float:
    """
    선호 벡터 저장소에서 사용자 선호 벡터를 획득(없으면 Cold Start 벡터 생성 후 적재)하고,
    후보 시설의 특성 벡터 간 코사인 유사도를 계산합니다.

    user_vector 가 주어지면(추천 루프에서 1회만 조회해 전달) 선호 벡터 저장소 재조회를 생략한다.
    """
    # 1. 사용자 선호 벡터 조회 (호출측에서 미리 넘겨줬으면 재사용)
    if user_vector is None:
        user_vector = await preference_vector_service.get_user_vector(user_id)
        if not user_vector:
            # Cold Start: 온보딩 선호 목록 기반 생성 및 저장
            user_vector = get_category_average_vector(preferred_categories)
            await preference_vector_service.upsert_user_vector(user_id, user_vector)

    # 2. 시설 특징 벡터 구성
    # 기본적으로 시설 카테고리 전용 벡터를 기준값으로 획득
    facility_vector = CATEGORY_VECTORS.get(facility_type, [0.0] * 8)
    
    # 시설 features 메타 정보에 맞춰 세부 차원 보정 (예: 친환경 설비가 있으면 주차 벡터 보정 등)
    if facility_features:
        # copy하여 수정
        facility_vector = list(facility_vector)
        if facility_features.get("barrier_free"):
            facility_vector[6] += 0.3  # 접근성/무장애 차원 부스트
        if facility_features.get("instagrammable") and facility_type == "cafe":
            facility_vector[5] += 0.2  # 감성/인스타 차원 부스트
            
    # 시설 벡터 정규화
    sq_sum = sum(x ** 2 for x in facility_vector)
    norm = math.sqrt(sq_sum) if sq_sum > 0 else 1.0
    facility_vector = [x / norm for x in facility_vector]

    # 사용자 벡터 방어적 정규화: user_vector 인자는 '호출측이 넘긴 임의 벡터'일 수 있어
    # (프로덕션 경로는 이미 정규화되어 있어 결과 불변) 비정규화 입력에도 코사인 의미가 깨지지 않도록 한다.
    u_sq = sum(x ** 2 for x in user_vector)
    u_norm = math.sqrt(u_sq) if u_sq > 0 else 1.0
    user_vector = [x / u_norm for x in user_vector]

    # 3. 코사인 유사도(Cosine Similarity) 계산 (정규화된 두 벡터의 내적)
    similarity = sum(u * f for u, f in zip(user_vector, facility_vector))
    
    # 유사도 범위 [0.0, 1.0] 제한
    return max(0.0, min(1.0, similarity))
