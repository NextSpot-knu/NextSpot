"""자연어 선호 입력 → 구조화 선호로 변환하는 서비스 (로컬 키워드 규칙).

(대회 종료 후 Vertex AI Gemini 의존성을 제거하고, 기존 한국어 키워드 폴백을 단일 경로로 승격.)
근로자가 "조용한 회의실이랑 전기차 충전되는 주차장이 좋아요" 처럼 자연어로 말하면 이 서비스가
그것을 추천 알고리즘이 쓰는 구조(선호 카테고리 + 속성 + 8차원 선호 벡터)로 바꾼다.

공개 시그니처 `parse_preference(text) -> dict` 와 반환 키(preferred_categories/attributes/summary/
vector/is_fallback)는 불변. 키워드 규칙만 쓰므로 is_fallback 은 항상 True.
"""

import math

import structlog

from app.services.tttv.preference import get_category_average_vector

logger = structlog.get_logger()

# 서비스의 4개 표준 카테고리 (식당/주차장/회의실/휴게 공간).
# rest_area 는 predict_service.normalize_facility_type 에서 ML 버킷 loading_dock 으로 매핑된다.
VALID_CATEGORIES = ["cafeteria", "parking", "meeting_room", "rest_area"]
CATEGORY_KO = {
    "cafeteria": "식당",
    "parking": "주차장",
    "meeting_room": "회의실",
    "rest_area": "휴게 공간",
}

# 허용 속성 → 8차원 선호 벡터의 보정 차원 인덱스.
# (preference.py 의 features 보정과 동일 의미축: idx4=편의/채식, idx6=친환경/충전 …)
ATTR_DIM = {
    "vegetarian": 4,    # 채식/비건
    "convenience": 5,   # 간편/빠름
    "ev_charger": 6,    # 전기차 충전
    "quiet": 7,         # 조용함
}
VALID_ATTRIBUTES = list(ATTR_DIM.keys()) + ["near", "indoor"]  # near/indoor 는 벡터 보정 없이 요약/메타에만 사용

# 한국어 키워드 규칙
_CATEGORY_KEYWORDS = {
    "cafeteria": ["식당", "밥", "점심", "끼니", "먹을", "먹고", "먹는", "구내식당", "카페테리아", "메뉴", "한식", "중식", "양식", "분식"],
    "parking": ["주차", "차 ", "차를", "주차장", "전기차", "충전", "ev충전"],
    "meeting_room": ["회의", "회의실", "미팅", "컨퍼런스", "회의공간"],
    "rest_area": ["휴게", "쉬", "쉴", "낮잠", "안마", "수면", "라운지", "휴식", "잠깐"],
}
_ATTR_KEYWORDS = {
    "vegetarian": ["채식", "비건", "샐러드", "베지"],
    "convenience": ["간편", "빠른", "빨리", "빠르게", "테이크아웃", "포장"],
    "ev_charger": ["전기차", "충전", "ev충전"],
    "quiet": ["조용", "한적", "방해", "집중"],
    "near": ["가까", "근처", "가깝", "인근", "주변"],
    "indoor": ["실내", "지하", "비 안", "비안", "실내주차"],
}


def _normalize(vec: list[float]) -> list[float]:
    sq = sum(x * x for x in vec)
    if sq <= 0:
        return [1.0 / math.sqrt(8)] * 8
    norm = math.sqrt(sq)
    return [x / norm for x in vec]


def build_preference_vector(preferred_categories: list[str], attributes: list[str]) -> list[float]:
    """파싱된 카테고리/속성으로 8차원 선호 벡터를 구성(추천이 그대로 사용하는 포맷)."""
    base = get_category_average_vector(preferred_categories)  # 이미 L2 정규화됨
    vec = list(base)
    for attr in attributes:
        dim = ATTR_DIM.get(attr)
        if dim is not None:
            vec[dim] += 0.3  # 해당 의미축 부스트
    return _normalize(vec)


def _build_summary(preferred_categories: list[str], attributes: list[str]) -> str:
    """표시용 결정적 한국어 요약."""
    cats = [CATEGORY_KO[c] for c in preferred_categories if c in CATEGORY_KO]
    attr_ko = {
        "vegetarian": "채식 가능",
        "convenience": "간편·빠른 이용",
        "ev_charger": "전기차 충전",
        "quiet": "조용한 곳",
        "near": "가까운 곳",
        "indoor": "실내",
    }
    attrs = [attr_ko[a] for a in attributes if a in attr_ko]
    if not cats and not attrs:
        return "선호 정보를 충분히 파악하지 못했어요. 다시 말씀해 주세요."
    cat_str = "·".join(cats) if cats else "공용 시설"
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
