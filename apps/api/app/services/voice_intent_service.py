"""음성 응답 의도/선호 해석 — 로컬 키워드 분류기.

(대회 종료 후 Vertex AI Gemini 의존성을 제거하고, 키워드 규칙 기반 분류를 단일 경로로 사용.)
음성 비서가 추천 카드를 안내한 뒤 사용자의 자유발화를 받아 다음 중 하나로 분류한다:
  accept(수락·길안내) / next(다음) / reject(별로) / details(자세히) / select(특정 후보 지정) /
  filter(메뉴·종류 선호로 좁히기) / stop(그만) / unknown(불명확).
filter 의 경우 어떤 후보가 맞는지는 라우터의 키워드 의미매칭(embedding_service.filter_candidates)이 정한다.

공개 시그니처 `interpret_turn(...) -> dict` 와 반환 키(action/target_facility_id/match_ids/
search_query/intent_category/spoken)는 불변(라우터가 그대로 소비).
"""

from typing import Optional

import structlog

from app.services.spot.travel import WALKING_SPEED_M_PER_MIN

logger = structlog.get_logger()

VALID_ACTIONS = ["accept", "next", "reject", "details", "select", "filter", "stop", "unknown"]

# 라우터 분류 enum 과 일치하는 정밀분류 라벨(intent_category).
_INTENT_CATEGORIES = [
    "고깃집", "곱창집", "갈비집", "족발보쌈", "순댓국", "국밥집", "찌개전골", "샤브샤브", "닭갈비찜닭",
    "치킨집", "횟집", "일식", "중식", "양식", "분식", "국수칼국수", "해물", "아시안", "카페", "술집", "한식",
]

# 음식 키워드 → 정밀분류. 더 구체적인 키워드를 앞에 둬 먼저 매칭한다('부대찌개'가 '찌개'보다,
# '돼지국밥'이 '국밥'보다 먼저). 인접분류 혼선('부대찌개'→국밥, '순대'→고깃집)을 방지한다.
_FOOD_KEYWORDS = [
    ("부대찌개", "찌개전골"), ("김치찌개", "찌개전골"), ("된장찌개", "찌개전골"), ("전골", "찌개전골"), ("찌개", "찌개전골"),
    ("순댓국", "순댓국"), ("순대국밥", "순댓국"), ("순대", "순댓국"),
    ("돼지국밥", "국밥집"), ("해장국", "국밥집"), ("국밥", "국밥집"),
    ("삼겹살", "고깃집"), ("삼겹", "고깃집"), ("목살", "고깃집"), ("소고기", "고깃집"), ("숯불", "고깃집"), ("고깃집", "고깃집"), ("고기", "고깃집"),
    ("갈비", "갈비집"),
    ("막창", "곱창집"), ("대창", "곱창집"), ("곱창", "곱창집"),
    ("족발", "족발보쌈"), ("보쌈", "족발보쌈"),
    ("샤브", "샤브샤브"),
    ("닭갈비", "닭갈비찜닭"), ("찜닭", "닭갈비찜닭"),
    ("후라이드", "치킨집"), ("양념치킨", "치킨집"), ("닭강정", "치킨집"), ("치킨", "치킨집"),
    ("물회", "횟집"), ("횟집", "횟집"), ("회덮밥", "횟집"),
    ("초밥", "일식"), ("스시", "일식"), ("사시미", "일식"), ("돈까스", "일식"), ("돈가스", "일식"), ("우동", "일식"), ("라멘", "일식"), ("일식", "일식"),
    ("짜장", "중식"), ("짬뽕", "중식"), ("탕수육", "중식"), ("중식", "중식"), ("중국집", "중식"),
    ("피자", "양식"), ("파스타", "양식"), ("스테이크", "양식"), ("리조또", "양식"), ("양식", "양식"),
    ("떡볶이", "분식"), ("김밥", "분식"), ("분식", "분식"), ("라면", "분식"),
    ("칼국수", "국수칼국수"), ("잔치국수", "국수칼국수"), ("국수", "국수칼국수"),
    ("해물", "해물"), ("조개", "해물"), ("해산물", "해물"),
    ("쌀국수", "아시안"), ("팟타이", "아시안"), ("아시안", "아시안"),
    ("커피", "카페"), ("카페", "카페"), ("디저트", "카페"), ("베이커리", "카페"),
    ("이자카야", "술집"), ("포차", "술집"), ("술집", "술집"), ("맥주", "술집"), ("소주", "술집"),
    ("백반", "한식"), ("한정식", "한식"), ("한식", "한식"),
]

_STOP_KW = ["그만", "취소", "중지", "종료", "됐어", "관둬", "멈춰"]
_DETAILS_KW = ["자세히", "정보", "메뉴", "얼마", "가격", "혼잡", "몇 분", "몇분", "거리", "뭐 있", "뭐있", "어때", "설명"]
_REJECT_KW = ["별로", "싫어", "싫다", "아니", "안 가", "안가", "안 갈", "말고", "마음에 안", "그닥"]
_NEXT_KW = ["다음", "넘겨", "넘어가", "다른거", "다른 거", "딴거", "딴 거", "패스", "또 다른"]
_ACCEPT_KW = ["가자", "갈래", "갈게", "길 안내", "길안내", "안내", "거기로", "가 줘", "가줘", "수락", "좋아", "오케이", "콜", "데려다"]
_ACCEPT_EXACT = {"네", "예", "응", "어", "그래", "ok", "yes", "넵", "응응", "네네", "좋아"}

# select(특정 후보 지정) — 명시적 서수만 사용(짧은 숫자 substring 오매칭 방지).
_ORDINALS = {
    "첫번째": 0, "첫 번째": 0, "첫째": 0, "처음": 0, "1번": 0, "일번": 0,
    "두번째": 1, "두 번째": 1, "둘째": 1, "2번": 1, "이번": 1,
    "세번째": 2, "세 번째": 2, "셋째": 2, "3번": 2, "삼번": 2,
    "네번째": 3, "네 번째": 3, "넷째": 3, "4번": 3,
}


def _cuisine_str(cuisine) -> str:
    if not cuisine:
        return ""
    if isinstance(cuisine, (list, tuple)):
        return ", ".join(str(x) for x in cuisine if x)
    return str(cuisine)


def _details_spoken(current_name: Optional[str], candidates: list[dict]) -> Optional[str]:
    """현재 추천(또는 첫 후보)의 실제 데이터로 한국어 상세 안내문을 구성."""
    target = None
    if current_name:
        for c in candidates:
            if c.get("name") == current_name:
                target = c
                break
    if target is None and candidates:
        target = candidates[0]
    if not target:
        return None
    name = target.get("name") or "이 시설"
    bits = []
    cong = target.get("congestion")
    dist = target.get("distance_m")
    if isinstance(cong, (int, float)):
        bits.append(f"혼잡도 {round(cong * 100)}%")
    if isinstance(dist, (int, float)):
        bits.append(f"도보 {max(1, round(dist / WALKING_SPEED_M_PER_MIN))}분")
    cui = _cuisine_str(target.get("cuisine"))
    detail = ", ".join(bits) if bits else "상세 정보가 제한적이에요"
    if cui:
        return f"{name}은(는) {detail}이고, 종류는 {cui}입니다."
    return f"{name}은(는) {detail}입니다."


def _match_food_category(low: str) -> Optional[str]:
    for kw, cat in _FOOD_KEYWORDS:
        if kw in low:
            return cat
    return None


def _keyword_interpret(utterance: str, current_name: Optional[str], candidates: list[dict]) -> dict:
    """발화를 키워드 규칙으로 action 분류. 우선순위: stop→details→reject→next→select→filter→accept→unknown."""
    base = {
        "action": "unknown", "target_facility_id": None, "match_ids": [],
        "search_query": None, "intent_category": None, "spoken": None,
    }
    low = (utterance or "").strip().lower()
    if not low:
        return base
    stripped = low.rstrip(" .!~?,")

    if any(k in low for k in _STOP_KW):
        return {**base, "action": "stop", "spoken": "안내를 종료할게요."}
    if any(k in low for k in _DETAILS_KW):
        return {**base, "action": "details", "spoken": _details_spoken(current_name, candidates)}
    if any(k in low for k in _REJECT_KW):
        return {**base, "action": "reject"}
    if any(k in low for k in _NEXT_KW):
        return {**base, "action": "next"}
    for key, idx in _ORDINALS.items():
        if key in low and idx < len(candidates):
            cid = candidates[idx].get("id")
            if cid is not None:
                return {**base, "action": "select", "target_facility_id": cid, "spoken": "네, 그곳으로 안내할게요."}
    cat = _match_food_category(low)
    if cat:
        return {
            **base, "action": "filter", "intent_category": cat,
            "search_query": utterance.strip(), "spoken": f"{cat} 쪽으로 찾아볼게요.",
        }
    if stripped in _ACCEPT_EXACT or any(k in low for k in _ACCEPT_KW):
        return {**base, "action": "accept"}
    return base


def _fallback() -> dict:
    """발화가 비었거나 분류 불가 — unknown 으로 두어 프런트가 '다시 말씀해 주세요'로 재질문하게 한다."""
    return {"action": "unknown", "target_facility_id": None, "match_ids": [], "search_query": None, "intent_category": None, "spoken": None}


def _coerce(parsed: dict, valid_ids: set) -> dict:
    """분류 결과에서 허용 action·후보 id 만 남긴다(환각 방지·이중 안전망)."""
    action = str(parsed.get("action", "")).strip().lower()
    if action not in VALID_ACTIONS:
        action = "unknown"
    tid = parsed.get("target_facility_id")
    tid = tid if (isinstance(tid, str) and tid in valid_ids) else None
    # match_ids 는 유효 후보 id 만(중복 제거, 순서 보존)
    match_ids, seen = [], set()
    for m in (parsed.get("match_ids") or []):
        if isinstance(m, str) and m in valid_ids and m not in seen:
            seen.add(m)
            match_ids.append(m)
    # select 인데 유효 후보 id 가 없으면 next 로 강등(엉뚱한 선택 방지)
    _demoted_select = action == "select" and not tid
    if _demoted_select:
        action = "next"
    # filter 는 여기서 강등하지 않는다. 어떤 후보가 맞는지는 라우터의 키워드 의미매칭이 정하고,
    # 매칭이 빈값일 때만 라우터가 next 로 강등한다(선택지 폐기 아님, 우선순위만 조정).
    spoken = parsed.get("spoken")
    spoken = spoken.strip()[:200] if isinstance(spoken, str) and spoken.strip() else None
    if _demoted_select:
        spoken = None
    sq = parsed.get("search_query")
    sq = sq.strip()[:200] if isinstance(sq, str) and sq.strip() else None
    ic = parsed.get("intent_category")
    ic = ic.strip() if isinstance(ic, str) and ic.strip() in _INTENT_CATEGORIES else None
    if action != "filter":
        sq = None
        ic = None
    return {"action": action, "target_facility_id": tid, "match_ids": match_ids, "search_query": sq, "intent_category": ic, "spoken": spoken}


async def interpret_turn(
    utterance: str,
    facility_type_ko: str,
    current_name: Optional[str],
    candidates: list[dict],
) -> dict:
    """음성 응답 1턴을 해석. 항상 {action, target_facility_id, match_ids, search_query, intent_category, spoken} 반환."""
    valid_ids = {c.get("id") for c in (candidates or [])}
    if not (utterance or "").strip():
        return _fallback()
    parsed = _keyword_interpret(utterance, current_name, candidates or [])
    result = _coerce(parsed, valid_ids)
    logger.info("voice_intent_resolved", action=result["action"], has_target=bool(result["target_facility_id"]), mode="keyword")
    return result
