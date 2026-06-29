"""추천 사유(한국어 1~2문장) 생성 — 로컬 결정적 템플릿.

(대회 종료 후 Vertex AI Gemini 의존성을 제거하고, 기존 결정적 템플릿 폴백을 단일 경로로 승격.)
입력으로 주어진 수치(혼잡도·도보·예상 대기)만 사용해 환각 없는 사유 문장을 만든다.
공개 시그니처 `generate_reason(context) -> str` 는 불변(라우터가 await 로 호출).
"""


def _build_template(ctx: dict) -> str:
    """주어진 수치만으로 만드는 결정적 사유 문장."""
    name = ctx.get("recommended_facility_name") or "대안 시설"
    wait = ctx.get("predicted_wait")
    travel = ctx.get("travel_time")
    cand_cong = ctx.get("candidate_congestion")

    parts = []
    if isinstance(travel, (int, float)):
        parts.append(f"도보 {round(travel)}분")
    if isinstance(wait, (int, float)):
        parts.append(f"예상 대기 {round(wait)}분")
    if isinstance(cand_cong, (int, float)):
        parts.append(f"혼잡도 {round(cand_cong * 100)}%")

    # 혼잡(>=0.75)이면 추천하지 않고 혼잡·대기를 솔직히 안내한다.
    is_congested = isinstance(cand_cong, (int, float)) and cand_cong >= 0.75
    if parts:
        if is_congested:
            return f"{name}: " + ", ".join(parts) + " 수준으로 지금은 붐벼 대기가 길 수 있어요."
        return f"{name} 추천: " + ", ".join(parts) + " 수준으로 여유가 있습니다."
    if is_congested:
        return f"{name}은(는) 현재 혼잡해 대기가 길 수 있어요."
    return f"{name}을(를) 추천합니다."


async def generate_reason(context: dict) -> str:
    """추천 1건의 점수 구성요소를 받아 한국어 사유를 반환. 항상 문자열(폴백 보장)."""
    return _build_template(context)
