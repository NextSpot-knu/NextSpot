"""Snapshot-only recommendation explanations with harmless Solar polishing."""
import json
import re

from app.services import llm_client

QUESTION_CODES = {"why_first", "difference", "family_check"}


def _num_tokens(text: str) -> set[str]:
    return set(re.findall(r"\d+(?:\.\d+)?", text))


def build_template(question: str, snapshots: list[dict]) -> str:
    primary = snapshots[0]
    name = str(primary.get("facility_name") or "이 장소")
    score = round(float(primary.get("spot_score") or 0) * 100)
    breakdown = primary.get("breakdown") or {}
    walk = round(float(breakdown.get("travel_time") or 0))
    wait = round(float(breakdown.get("wait_time") or 0))
    if question == "difference" and len(snapshots) > 1:
        other = snapshots[1]
        other_name = str(other.get("facility_name") or "비교 장소")
        other_score = round(float(other.get("spot_score") or 0) * 100)
        return f"{name}은 SPOT {score}점, {other_name}은 SPOT {other_score}점입니다. 서버가 저장한 생성 당시 순위와 수치이며, 최종 순서는 SPOT 점수로 결정됐습니다."
    if question == "family_check":
        facts = primary.get("tourapi_facts") or {}
        accessibility = "무장애 정보가 확인됐습니다" if facts.get("barrier_free") is True else "무장애 정보는 확인이 필요합니다"
        return f"{name}까지 도보 약 {walk}분, 예상 대기 {wait}분입니다. {accessibility}. 운영시간과 현장 상황은 출발 전에 다시 확인해 주세요."
    return f"{name}은 생성 당시 SPOT {score}점으로 {int(primary.get('rank') or 1)}위였습니다. 도보 약 {walk}분, 예상 대기 {wait}분을 포함한 서버 점수 결과입니다."


async def explain(question: str, snapshots: list[dict]) -> tuple[str, list[str], str]:
    template = build_template(question, snapshots)
    if not llm_client.is_enabled():
        return template, ["SPOT 근거 설명", "TourAPI 정보"], "disabled"
    # The deterministic template has already selected the allowed facts. Do not send raw TourAPI/free-text
    # fields to the model: they are unnecessary for polishing and could contain prompt-like content.
    payload = json.dumps({"question": question, "template": template}, ensure_ascii=False)
    polished = await llm_client.chat_text(
        "제공된 JSON 사실만 사용해 한국어 두 문장 이내로 설명하세요. 새 장소·수치·운영정보·순위를 만들거나 재해석하지 마세요.",
        payload,
        max_tokens=180,
    )
    if not polished:
        return template, ["SPOT 근거 설명", "TourAPI 정보"], "llm_failed"
    names = {str(s.get("facility_name") or "") for s in snapshots}
    if not all(name in polished for name in names if name) or not _num_tokens(polished).issubset(_num_tokens(template)):
        return template, ["SPOT 근거 설명", "TourAPI 정보"], "rejected"
    return polished.strip(), ["SPOT 근거 설명", "TourAPI 정보", "AI 요약"], "llm"
