"""Snapshot-only recommendation explanations with harmless Solar polishing."""
import json
import re

from app.services import llm_client

QUESTION_CODES = {"why_first", "difference", "family_check"}
LOCALES = {"ko", "en", "ja", "zh"}
SOURCE_LABELS = {
    "ko": ["SPOT 근거 설명", "TourAPI 정보"],
    "en": ["SPOT rationale", "TourAPI facts"],
    "ja": ["SPOT根拠説明", "TourAPI情報"],
    "zh": ["SPOT依据说明", "TourAPI信息"],
}
AI_LABELS = {"ko": "AI 요약", "en": "AI summary", "ja": "AI要約", "zh": "AI摘要"}
LANGUAGE_NAMES = {"ko": "한국어", "en": "English", "ja": "日本語", "zh": "简体中文"}


def _num_tokens(text: str) -> set[str]:
    return set(re.findall(r"\d+(?:\.\d+)?", text))


def build_template(question: str, snapshots: list[dict], locale: str = "ko") -> str:
    locale = locale if locale in LOCALES else "ko"
    primary = snapshots[0]
    fallback_names = {"ko": "이 장소", "en": "This place", "ja": "この場所", "zh": "这个地点"}
    other_fallbacks = {"ko": "비교 장소", "en": "the other place", "ja": "比較対象", "zh": "对比地点"}
    name = str(primary.get("facility_name") or fallback_names[locale])
    score = round(float(primary.get("spot_score") or 0) * 100)
    breakdown = primary.get("breakdown") or {}
    walk = round(float(breakdown.get("travel_time") or 0))
    wait = round(float(breakdown.get("wait_time") or 0))
    if question == "difference" and len(snapshots) > 1:
        other = snapshots[1]
        other_name = str(other.get("facility_name") or other_fallbacks[locale])
        other_score = round(float(other.get("spot_score") or 0) * 100)
        templates = {
            "ko": f"{name}은 SPOT {score}점, {other_name}은 SPOT {other_score}점입니다. 서버가 저장한 생성 당시 순위와 수치이며, 최종 순서는 SPOT 점수로 결정됐습니다.",
            "en": f"{name} scored {score} SPOT points and {other_name} scored {other_score}. These are the server-stored values from recommendation time, and SPOT score determined the order.",
            "ja": f"{name}はSPOT {score}点、{other_name}はSPOT {other_score}点です。推薦時にサーバーが保存した順位と数値で、最終順位はSPOTスコアで決まりました。",
            "zh": f"{name}的SPOT分数为{score}分，{other_name}为{other_score}分。这是服务器保存的推荐生成时数值，最终顺序由SPOT分数决定。",
        }
        return templates[locale]
    if question == "family_check":
        facts = primary.get("tourapi_facts") or {}
        verified = facts.get("barrier_free") is True
        templates = {
            "ko": f"{name}까지 도보 약 {walk}분, 예상 대기 {wait}분입니다. {'무장애 정보가 확인됐습니다' if verified else '무장애 정보는 확인이 필요합니다'}. 운영시간과 현장 상황은 출발 전에 다시 확인해 주세요.",
            "en": f"It is about a {walk}-minute walk to {name}, with an estimated {wait}-minute wait. Accessibility information {'is verified' if verified else 'needs confirmation'}. Recheck opening hours and on-site conditions before leaving.",
            "ja": f"{name}までは徒歩約{walk}分、予想待ち時間は{wait}分です。バリアフリー情報は{'確認済みです' if verified else '確認が必要です'}。出発前に営業時間と現地状況を再確認してください。",
            "zh": f"步行到{name}约需{walk}分钟，预计等待{wait}分钟。无障碍信息{'已确认' if verified else '需要确认'}。出发前请再次确认营业时间和现场情况。",
        }
        return templates[locale]
    rank = int(primary.get("rank") or 1)
    templates = {
        "ko": f"{name}은 생성 당시 SPOT {score}점으로 {rank}위였습니다. 도보 약 {walk}분, 예상 대기 {wait}분을 포함한 서버 점수 결과입니다.",
        "en": f"{name} ranked #{rank} with a SPOT score of {score} when generated. This server score includes an approximately {walk}-minute walk and {wait}-minute estimated wait.",
        "ja": f"{name}は生成時のSPOTスコア{score}点で{rank}位でした。徒歩約{walk}分と予想待ち時間{wait}分を含むサーバー計算結果です。",
        "zh": f"{name}生成推荐时以SPOT {score}分排名第{rank}。这是包含约{walk}分钟步行和{wait}分钟预计等待的服务器评分结果。",
    }
    return templates[locale]


async def explain(question: str, snapshots: list[dict], locale: str = "ko") -> tuple[str, list[str], str]:
    locale = locale if locale in LOCALES else "ko"
    template = build_template(question, snapshots, locale)
    labels = SOURCE_LABELS[locale]
    if not llm_client.is_enabled():
        return template, labels, "disabled"
    # The deterministic template has already selected the allowed facts. Do not send raw TourAPI/free-text
    # fields to the model: they are unnecessary for polishing and could contain prompt-like content.
    payload = json.dumps({"question": question, "template": template}, ensure_ascii=False)
    polished = await llm_client.chat_text(
        f"제공된 JSON 사실만 사용해 {LANGUAGE_NAMES[locale]} 두 문장 이내로 설명하세요. 새 장소·수치·운영정보·순위를 만들거나 재해석하지 마세요.",
        payload,
        max_tokens=180,
    )
    if not polished:
        return template, labels, "llm_failed"
    names = {str(s.get("facility_name") or "") for s in snapshots}
    if not all(name in polished for name in names if name) or not _num_tokens(polished).issubset(_num_tokens(template)):
        return template, labels, "rejected"
    return polished.strip(), [*labels, AI_LABELS[locale]], "llm"
