"""자연어 선호 입력 → 구조화 선호로 변환하는 서비스 (로컬 키워드 규칙).

(대회 종료 후 Vertex AI Gemini 의존성을 제거하고, 기존 한국어 키워드 폴백을 단일 경로로 승격.)
관광객이 "조용한 한옥카페랑 무장애 되는 관광지가 좋아요" 처럼 자연어로 말하면 이 서비스가
그것을 추천 알고리즘이 쓰는 구조(선호 카테고리 + 속성 + 8차원 선호 벡터)로 바꾼다.

공개 시그니처 `parse_preference(text) -> dict` 와 반환 키(preferred_categories/attributes/summary/
vector/is_fallback)는 불변. 키워드 규칙만 쓰므로 is_fallback 은 항상 True.
"""

import structlog

from app.core.vector import l2_normalize
from app.services.spot.preference import get_category_average_vector

logger = structlog.get_logger()

# 서비스의 4개 표준 카테고리 (음식점/카페/관광지/문화시설).
VALID_CATEGORIES = ["restaurant", "cafe", "attraction", "culture"]
CATEGORY_KO = {
    "restaurant": "음식점",
    "cafe": "카페",
    "attraction": "관광지",
    "culture": "문화시설",
}

# 허용 속성 → 8차원 선호 벡터의 보정 차원 인덱스.
# (preference.py 의 features 보정과 동일 의미축: idx4=맛/평점, idx5=감성/인스타, idx6=접근성/무장애, idx7=한적함)
ATTR_DIM = {
    "tasty": 4,            # 맛집/평점
    "instagrammable": 5,   # 감성/인스타
    "barrier_free": 6,     # 무장애/접근성
    "quiet": 7,            # 한적/조용
}
VALID_ATTRIBUTES = list(ATTR_DIM.keys()) + ["near", "indoor"]  # near/indoor 는 벡터 보정 없이 요약/메타에만 사용

# 한국어 키워드 규칙
_CATEGORY_KEYWORDS = {
    "restaurant": ["맛집", "밥", "식당", "점심", "저녁", "먹을", "먹고", "먹는", "한식", "국밥", "쌈밥", "고기", "분식", "맛있"],
    "cafe": ["카페", "커피", "디저트", "빵", "베이커리", "브런치", "감성카페", "차 한잔"],
    "attraction": ["관광", "명소", "구경", "볼거리", "유적", "고분", "첨성대", "대릉원", "월지", "야경", "포토"],
    "culture": ["문화", "박물관", "전시", "한옥", "공예", "체험", "고택", "역사"],
}
_ATTR_KEYWORDS = {
    "tasty": ["맛집", "맛있", "유명", "현지", "로컬", "평점", "웨이팅"],
    "instagrammable": ["감성", "인스타", "예쁜", "분위기", "포토", "사진", "뷰"],
    "barrier_free": ["무장애", "휠체어", "유모차", "배리어프리", "접근"],
    "quiet": ["조용", "한적", "여유", "붐비지", "한산", "방해", "집중"],
    "near": ["가까", "근처", "가깝", "인근", "주변"],
    "indoor": ["실내", "지붕", "비 안", "비안"],
}


def build_preference_vector(preferred_categories: list[str], attributes: list[str]) -> list[float]:
    """파싱된 카테고리/속성으로 8차원 선호 벡터를 구성(추천이 그대로 사용하는 포맷)."""
    base = get_category_average_vector(preferred_categories)  # 이미 L2 정규화됨
    vec = list(base)
    for attr in attributes:
        dim = ATTR_DIM.get(attr)
        if dim is not None:
            vec[dim] += 0.3  # 해당 의미축 부스트
    return l2_normalize(vec)


def _build_summary(preferred_categories: list[str], attributes: list[str]) -> str:
    """표시용 결정적 한국어 요약."""
    cats = [CATEGORY_KO[c] for c in preferred_categories if c in CATEGORY_KO]
    attr_ko = {
        "tasty": "맛집",
        "instagrammable": "감성·인스타",
        "barrier_free": "무장애·접근성",
        "quiet": "한적한 곳",
        "near": "가까운 곳",
        "indoor": "실내",
    }
    attrs = [attr_ko[a] for a in attributes if a in attr_ko]
    if not cats and not attrs:
        return "선호 정보를 충분히 파악하지 못했어요. 다시 말씀해 주세요."
    cat_str = "·".join(cats) if cats else "관광 장소"
    attr_str = (", ".join(attrs) + " 선호") if attrs else "선호"
    return f"{cat_str} 중심으로 {attr_str}로 이해했어요."


def _keyword_fallback(text: str) -> dict:
    """한국어 키워드 규칙으로 구조화."""
    low = (text or "").lower()
    cats = [c for c, kws in _CATEGORY_KEYWORDS.items() if any(k in low for k in kws)]
    attrs = [a for a, kws in _ATTR_KEYWORDS.items() if any(k in low for k in kws)]
    return {"preferred_categories": cats, "attributes": attrs}


def _coerce(parsed: dict) -> dict:
    """출력에서 허용 enum 만 남기고 중복 제거(오타·비-리스트 방어)."""
    raw_c = parsed.get("preferred_categories")
    raw_a = parsed.get("attributes")
    cats, seen = [], set()
    for c in (raw_c if isinstance(raw_c, (list, tuple)) else []):
        c = str(c).strip().lower()
        if c in VALID_CATEGORIES and c not in seen:
            seen.add(c)
            cats.append(c)
    attrs, seen_a = [], set()
    for a in (raw_a if isinstance(raw_a, (list, tuple)) else []):
        a = str(a).strip().lower()
        if a in VALID_ATTRIBUTES and a not in seen_a:
            seen_a.add(a)
            attrs.append(a)
    return {"preferred_categories": cats, "attributes": attrs}


async def parse_preference(text: str) -> dict:
    """자연어 선호 문장을 구조화 선호로 변환.

    반환: { preferred_categories, attributes, summary, vector, is_fallback }
    키워드 규칙 단일 경로이므로 is_fallback 은 항상 True. 예외 없이 구조화 결과를 반환한다.
    """
    text = (text or "").strip()
    coerced = _coerce(_keyword_fallback(text))
    preferred_categories = coerced["preferred_categories"]
    attributes = coerced["attributes"]
    summary = _build_summary(preferred_categories, attributes)
    vector = build_preference_vector(preferred_categories, attributes)

    logger.info(
        "preference_parsed",
        categories=preferred_categories,
        attributes=attributes,
        is_fallback=True,
    )
    return {
        "preferred_categories": preferred_categories,
        "attributes": attributes,
        "summary": summary,
        "vector": vector,
        "is_fallback": True,
    }
