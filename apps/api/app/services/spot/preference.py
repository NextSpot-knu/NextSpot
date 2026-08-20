# pyrefly: ignore [missing-import]
import math
import re
from app.services.preference_vector_service import preference_vector_service

# 8차원 카테고리 벡터 매핑 테이블 (관광 4타입: 음식점/카페/관광지/문화시설)
# dim0-3: 카테고리 원핫 / dim4: 맛·평점 / dim5: 감성·인스타 / dim6: 접근성·무장애 / dim7: 한적함
CATEGORY_VECTORS = {
    "restaurant": [1.0, 0.0, 0.0, 0.0, 0.3, 0.0, 0.0, 0.0],
    "cafe":       [0.0, 1.0, 0.0, 0.0, 0.1, 0.3, 0.0, 0.0],
    "attraction": [0.0, 0.0, 1.0, 0.0, 0.0, 0.1, 0.2, 0.0],
    "culture":    [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.2, 0.2],
}

CUISINE_GROUPS = {
    "한식": {"한식", "국밥", "찌개", "백반", "불고기", "갈비", "비빔밥"},
    "고기": {"고기", "육류", "삼겹살", "갈비", "불고기", "구이"},
    "분식": {"분식", "김밥", "떡볶이", "라면", "순대"},
    "중식": {"중식", "중국", "짜장", "짬뽕", "마라", "탕수육"},
    "일식": {"일식", "일본", "초밥", "스시", "라멘", "돈카츠", "우동"},
    "양식": {"양식", "파스타", "피자", "스테이크", "브런치"},
    "채식": {"채식", "비건", "사찰음식", "샐러드"},
    "디저트": {"디저트", "베이커리", "빵", "케이크", "아이스크림"},
}


def build_facility_preference_vector(facility_type: str, features: dict | None = None) -> list[float]:
    """Map facility-level facts into the existing stable eight-dimensional schema."""
    vector = list(CATEGORY_VECTORS.get(facility_type, [0.0] * 8))
    facts = features or {}
    if facts.get("barrier_free") or facts.get("accessible_verified"):
        vector[6] += 0.3
    if facts.get("instagrammable") or facts.get("scenic") or facts.get("hanok"):
        vector[5] += 0.2
    if facts.get("quiet") or facts.get("relaxed"):
        vector[7] += 0.2
    if any(facts.get(key) for key in ("first_menu", "treat_menu", "menu", "cuisine_tags", "category")):
        vector[4] += 0.15
    return vector


def _cuisine_match(intent: str | None, name: str | None, features: dict) -> float | None:
    if not intent or not intent.strip():
        return None
    haystack = " ".join(str(value) for value in [
        name or "", features.get("cuisine_tags") or "", features.get("category") or "",
        features.get("first_menu") or "", features.get("treat_menu") or "", features.get("menu") or "",
    ]).lower()
    query = intent.strip().lower()
    terms = {token for token in re.split(r"[\s,·/]+", query) if len(token) >= 2}
    for label, aliases in CUISINE_GROUPS.items():
        if label in query or any(alias in query for alias in aliases):
            terms.update(alias.lower() for alias in aliases)
    if not terms:
        return None
    return 1.0 if any(term in haystack for term in terms) else 0.15

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
    facility_features: dict | None = None,
    user_vector: list[float] | None = None,
    facility_name: str | None = None,
    preference_intent: str | None = None,
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
    facility_vector = build_facility_preference_vector(facility_type, facility_features)
            
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
    cuisine_match = _cuisine_match(preference_intent, facility_name, facility_features or {})
    if facility_type == "restaurant" and cuisine_match is not None:
        similarity = 0.3 * similarity + 0.7 * cuisine_match
    
    # 유사도 범위 [0.0, 1.0] 제한
    return max(0.0, min(1.0, similarity))
