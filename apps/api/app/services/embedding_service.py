"""음성 '선호 필터' 의미매칭 — 로컬 키워드/부분문자열 매칭.

(대회 종료 후 Vertex AI 텍스트 임베딩 + Firestore 코사인 검색을 제거하고, 후보 이름·종류(cuisine)에
대한 키워드/부분문자열 매칭으로 음성 선호 필터를 구현한다. 외부 의존성 0.)

역할: 사용자가 "짜장면 먹고싶어"/"고깃집" 처럼 메뉴·종류를 말하면, 후보 식당의 이름·종류 텍스트와
발화 토큰을 부분문자열로 대조해 가장 맞는 후보 id 들을 좁힌다. 정밀분류(intent_category)가 주어지고
후보에 그 분류 정보가 있으면 그 분류로 게이트한다(임베딩 코사인의 대체이며 정밀도는 더 거칠다).

공개 시그니처 `filter_candidates(utterance, candidates, intent_category=)` / `enrich_candidates(candidates)`
는 불변(라우터가 그대로 소비).
"""

import re

import structlog

logger = structlog.get_logger()

# 분류 미상(자유발화) 시 반환 후보 상한.
_MAX_FILTER_RESULTS = 10

# TourAPI 음식점 메타는 대표메뉴가 비어 있거나 ``육류,고기``처럼 넓은 태그만 있는 경우가 많다.
# 사용자의 구체 메뉴 표현을 데이터의 상위 태그에도 연결해, LLM이 올바른 검색어를 만들고도
# 정확 문자열이 없어서 0건이 되는 일을 막는다. 점수용 검색 토큰만 확장하며 SPOT 산식은 건드리지 않는다.
_FOOD_QUERY_ALIASES = {
    "돼지고기": ("고기", "육류", "삼겹살", "목살"),
    "삼겹살": ("돼지고기", "고기", "육류"),
    "목살": ("돼지고기", "고기", "육류"),
    "소고기": ("고기", "육류", "한우"),
    "한우": ("소고기", "고기", "육류"),
}


def cuisine_to_str(cuisine) -> str:
    """cuisine_tags(['한식','육류,고기'] 또는 '양식')를 공백 구분 문자열로."""
    if not cuisine:
        return ""
    if isinstance(cuisine, (list, tuple)):
        return " ".join(str(x) for x in cuisine if x)
    return str(cuisine)


async def enrich_candidates(candidates: list) -> list:
    """로컬 모드에서는 시드 메타(Firestore 분류·대표메뉴) 보강이 없으므로 no-op passthrough.

    음성 'details' 응답은 프런트가 후보별로 보내는 name·congestion·distance_m·cuisine·menu 로 구성된다.
    """
    return candidates or []


def _tokens(text: str) -> list[str]:
    """발화를 공백·구두점으로 토큰화(소문자). 부분문자열 매칭은 2글자 이상 토큰만 사용."""
    if not text:
        return []
    parts = re.split(r"[\s,./|·]+", str(text).lower())
    return [p for p in parts if p]


async def filter_candidates(
    utterance: str,
    candidates: list,
    margin: float = None,
    top_k: int = None,
    intent_category: str = None,
) -> list:
    """발화('짜장면 먹고싶어')에 키워드/부분문자열로 맞는 후보 id 들을 반환.

    - 후보의 haystack = name + cuisine + category(있으면) + menu(있으면).
    - 발화 토큰(+intent_category)이 haystack 에 부분문자열로 들어가면 점수 가산.
    - intent_category 가 주어지고 후보에 그 분류(category) 정보가 있으면 그 분류로 게이트
      (해당 분류 후보만 반환; 없으면 빈 리스트 → 라우터가 next 로 강등).
    - 매칭 실패/빈 입력 시 빈 리스트.

    margin/top_k 인자는 시그니처 호환을 위해 유지(키워드 매칭에선 top_k 만 상한으로 사용).
    """
    utterance = (utterance or "").strip()
    if not utterance or not candidates:
        return []

    ic = (intent_category or "").strip()
    limit = top_k if isinstance(top_k, int) and top_k > 0 else _MAX_FILTER_RESULTS

    qtokens = set(_tokens(utterance))
    for token in tuple(qtokens):
        qtokens.update(_FOOD_QUERY_ALIASES.get(token, ()))
    if ic:
        qtokens.add(ic.lower())

    scored = []
    cat_present = False
    for c in candidates:
        cid = c.get("id")
        if cid is None:
            continue
        cat = (c.get("category") or "").strip()
        if cat:
            cat_present = True
        hay = " ".join([
            str(c.get("name") or ""),
            cuisine_to_str(c.get("cuisine")),
            cat,
            str(c.get("menu") or ""),
        ]).lower()
        score = sum(1 for t in qtokens if len(t) >= 2 and t in hay)
        if ic and cat and cat == ic:
            score += 2  # 시드 분류 일치 가산
        if score > 0:
            scored.append((score, cid))

    # 분류 게이트: intent_category 가 분명하고 후보에 분류 정보가 있으면 그 분류만 반환.
    if ic and cat_present:
        same = [c.get("id") for c in candidates if (c.get("category") or "").strip() == ic]
        logger.info("keyword_filter_resolved", mode="category_gate", n_selected=len(same), intent_category=ic)
        return same[:limit]

    if not scored:
        logger.info("keyword_filter_resolved", mode="substring", n_candidates=len(candidates), n_selected=0)
        return []
    scored.sort(key=lambda x: x[0], reverse=True)
    selected = [cid for _s, cid in scored][:limit]
    logger.info("keyword_filter_resolved", mode="substring", n_candidates=len(candidates), n_selected=len(selected))
    return selected
