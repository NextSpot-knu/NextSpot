"""Solar 음식 분류 태깅 배치 — features.cuisine_tags / features.category 결손 보충(스키마 변경 없음).

배경(2026-07-18): 식당 43곳 대부분이 features.cuisine_tags 와 features.category(정밀분류)가
비어 있어 음성 의미매칭 오탐('삼겹살'→화덕피자)과 라우터 분류 게이트 무력화의 근본 원인이 됐다.
Upstage Solar 에게 오프라인 배치로 태깅 자율권을 주되, 화이트리스트 검증 게이트 + dry-run 기본
+ 출처 기록(tagging_source)으로 통제한다.

원칙:
  - fill-missing only — cuisine_tags 또는 category 가 비어 있는 restaurant/cafe 만 대상이고,
    이미 채워진 값은 절대 건드리지 않는다(병합 시에도 기존 키 보존 — ed690df 통째 교체 사고 참고).
  - 근거 텍스트는 name + features.first_menu/treat_menu(+cuisine) 뿐 — 지어내기 금지를 프롬프트에 명시.
  - category 는 voice_intent_service._INTENT_CATEGORIES(단일 정본)를 import 해 화이트리스트 검증.
    복사본을 만들지 않는다 — 정본이 바뀌면 이 게이트도 같이 바뀌어야 한다.
  - cuisine_tags 는 1~3개, 각각 2~10자 한국어(숫자·URL·영문 불허), 중복 제거. 게이트 하나라도
    실패하면 그 시설은 skip 으로 기록하고 쓰지 않는다(부분 성공 허용).
  - dry-run 기본(reconcile_kakao_coordinates.py 관례) — LLM 제안까지 수행하되 DB 쓰기는 --apply
    명시 시에만. 시설별 제안·skip 사유는 JSON 감사 보고서로 저장(--report, 기본 스크립트 옆).
  - llm_client 는 '무해 폴백' 계약(실패는 None) — 시설당 1콜, 실패 시 1회 재시도 후 skip.

사용 예:
  python scripts/tag_cuisines.py                      # dry-run: 제안 + 보고서만(DB 쓰기 없음)
  python scripts/tag_cuisines.py --limit 5            # 상위 5곳만 dry-run
  python scripts/tag_cuisines.py --apply              # 검증 통과 제안을 features 병합으로 반영
  python scripts/tag_cuisines.py --report out.json    # 보고서 경로 지정
"""

import argparse
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# scripts/translate_overviews.py 와 동일 부트스트랩 — apps/api 를 sys.path 에 추가해야
# 아래 `from app...` 이 어떤 실행 위치에서도 동작한다.
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.append(parent_dir)

from dotenv import load_dotenv

load_dotenv(os.path.join(parent_dir, ".env"))

from app.services import llm_client
# 분류 화이트리스트 단일 정본 — 라우터 분류 게이트·LLM 의도 분류와 같은 리스트를 공유한다(복사 금지).
from app.services.voice_intent_service import _INTENT_CATEGORIES

# 대상 시설 타입 — 음식 분류가 의미 있는 두 타입만.
TARGET_TYPES: tuple[str, ...] = ("restaurant", "cafe")

# cuisine_tags 형식 게이트: 2~10자 한글 음절만(숫자·URL·영문·공백·기호 불허).
_TAG_RE = re.compile(r"^[가-힣]{2,10}$")
MIN_TAGS = 1
MAX_TAGS = 3

# 배치 컨텍스트 — llm_client 기본 3초(실시간 음성 상한)는 과하게 짧다(translate_overviews 관례).
DEFAULT_TIMEOUT_SECONDS = 15.0
DEFAULT_MAX_TOKENS = 200
# 시설당 1콜 + 실패 시 1회 재시도.
_MAX_ATTEMPTS = 2

DEFAULT_REPORT_PATH = Path(__file__).resolve().parent / "tag_cuisines_report.json"

# skip 사유 코드 — 감사 보고서에 기록.
SKIP_LLM_FAILED = "llm_failed"
SKIP_INVALID_CATEGORY = "invalid_category"
SKIP_INVALID_TAGS = "invalid_tags"
SKIP_NAME_FRAGMENT_TAGS = "name_fragment_tags"
SKIP_SAVE_FAILED = "save_failed"


def _is_blank(value) -> bool:
    """features 값의 '비어 있음' 판정 — None/빈 문자열/빈 리스트/공백만."""
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, tuple)):
        return len(value) == 0
    return False


def needs_tagging(row: dict) -> bool:
    """cuisine_tags 또는 category 가 비어 있으면 True(fill-missing 판정 기준) — 순수 함수."""
    features = row.get("features")
    features = features if isinstance(features, dict) else {}
    return _is_blank(features.get("cuisine_tags")) or _is_blank(features.get("category"))


def select_targets(rows: list[dict]) -> list[dict]:
    """restaurant/cafe 이고 cuisine_tags 또는 category 결손인 행만 선정 — 순수 함수.

    이미 둘 다 채워진 시설은 건드리지 않는다(fill-missing only).
    """
    return [row for row in rows if row.get("type") in TARGET_TYPES and needs_tagging(row)]


def allowed_categories(facility_type: str) -> set[str]:
    """화이트리스트 — 정본은 _INTENT_CATEGORIES. 카페 타입이면 '카페'를 강제 허용(정본에서
    빠지더라도 카페 시설의 자명한 분류는 막지 않는다)."""
    allowed = set(_INTENT_CATEGORIES)
    if facility_type == "cafe":
        allowed.add("카페")
    return allowed


def _menu_evidence(row: dict) -> str:
    """상호 조각 판정용 근거 텍스트 — 메뉴·음식 종류만(이름 제외)."""
    features = row.get("features")
    features = features if isinstance(features, dict) else {}
    parts = [features.get("first_menu"), features.get("treat_menu"), features.get("cuisine")]
    return " ".join(str(p) for p in parts if isinstance(p, str) and p.strip())


def validate_proposal(parsed: dict | None, row: dict) -> tuple[dict | None, str | None]:
    """Solar 출력 검증 게이트 — 통과 시 ({"category", "cuisine_tags"}, None), 실패 시 (None, 사유).

    하나라도 실패하면 그 시설은 skip(쓰지 않음)이 계약이다 — 관대한 부분 채택은
    화이트리스트 게이트를 무력화한다.
    """
    facility_type = row.get("type") or ""
    if not isinstance(parsed, dict):
        return None, SKIP_LLM_FAILED
    category = parsed.get("category")
    category = category.strip() if isinstance(category, str) else ""
    if category not in allowed_categories(facility_type):
        return None, SKIP_INVALID_CATEGORY
    raw_tags = parsed.get("cuisine_tags")
    if not isinstance(raw_tags, list):
        return None, SKIP_INVALID_TAGS
    tags: list[str] = []
    for tag in raw_tags:
        if not isinstance(tag, str):
            return None, SKIP_INVALID_TAGS
        tag = tag.strip()
        if not _TAG_RE.match(tag):
            return None, SKIP_INVALID_TAGS
        if tag not in tags:  # 중복 제거(순서 유지)
            tags.append(tag)
    if not (MIN_TAGS <= len(tags) <= MAX_TAGS):
        return None, SKIP_INVALID_TAGS
    # 상호 조각 태그 차단(1차 dry-run 실측: '소소밀밀 서악점' → 태그 [소소밀밀, 서악점]) —
    # 이름에는 있는데 메뉴 근거에는 없는 태그는 음식이 아니라 상호·지점명 조각이다. 그런 태그만
    # 걸러내고, 남는 태그가 없으면 시설 자체를 skip(억지 태깅보다 결손이 정직하다).
    # '황남빵'처럼 상호=대표메뉴인 경우는 메뉴 텍스트에도 등장하므로 살아남는다.
    name = str(row.get("name") or "")
    evidence = _menu_evidence(row)
    tags = [t for t in tags if not (t in name and t not in evidence)]
    if not tags:
        return None, SKIP_NAME_FRAGMENT_TAGS
    return {"category": category, "cuisine_tags": tags}, None


def build_prompt(row: dict) -> tuple[str, str]:
    """system/user 프롬프트 — 화이트리스트 제시 + '제공 텍스트만 근거, 지어내기 금지' 명시."""
    features = row.get("features")
    features = features if isinstance(features, dict) else {}
    categories = ", ".join(_INTENT_CATEGORIES)
    system = (
        "너는 경주 관광 앱의 음식점/카페 분류 태거다.\n"
        "입력으로 가게 이름과 공식 메뉴 텍스트가 주어진다. 반드시 이 텍스트만 근거로 판단하고, "
        "텍스트에 없는 정보를 지어내지 마라(추측으로 구체 메뉴를 만들어내기 금지).\n"
        f"category 는 다음 목록 중 정확히 하나만 골라라: {categories}\n"
        "cuisine_tags 는 이 가게의 대표 음식을 나타내는 한국어 단어 1~3개다. 각 단어는 2~10자 "
        "한글로만 쓰고 숫자·영문·URL·기호를 넣지 마라(예: 삼겹살, 아메리카노, 칼국수).\n"
        "cuisine_tags 에 가게 이름(상호·지점명)의 조각을 쓰지 마라 — 메뉴 텍스트에 실제로 있는 "
        "음식만 써라. 메뉴 정보가 부족하면 확실한 것 1개만 적고 억지로 3개를 채우지 마라.\n"
        "category 판단의 최우선 근거는 메뉴다. '분식'은 떡볶이·김밥·라면 같은 분식류에만 쓰고, "
        "비빔밥·쌈밥·백반·정식 같은 밥상 차림은 '한식'이다.\n"
        '출력은 JSON 객체 하나만(설명·마크다운 금지). 스키마: {"category": "...", "cuisine_tags": ["...", ...]}'
    )
    lines = [f"[가게 이름] {row.get('name') or ''}", f"[시설 타입] {row.get('type') or ''}"]
    first_menu = features.get("first_menu")
    treat_menu = features.get("treat_menu")
    cuisine = features.get("cuisine")
    if isinstance(first_menu, str) and first_menu.strip():
        lines.append(f"[대표 메뉴] {first_menu.strip()}")
    if isinstance(treat_menu, str) and treat_menu.strip():
        lines.append(f"[취급 메뉴] {treat_menu.strip()}")
    if isinstance(cuisine, str) and cuisine.strip():
        lines.append(f"[음식 종류] {cuisine.strip()}")
    return system, "\n".join(lines)


def merge_tagging(features: dict | None, proposal: dict, tagged_at: str) -> dict:
    """기존 features 에 검증 통과 제안을 병합 — 기존 키 무손실(translate_overviews 병합 관례).

    fill-missing 계약: 이미 채워진 cuisine_tags/category 는 덮지 않는다(결손 필드만 채움).
    tagging_source 로 출처를 기록한다 — 합성/실측 구분 가드레일(AGENTS.md)의 데이터판.
    """
    merged = dict(features) if isinstance(features, dict) else {}
    if _is_blank(merged.get("cuisine_tags")):
        merged["cuisine_tags"] = list(proposal["cuisine_tags"])
    if _is_blank(merged.get("category")):
        merged["category"] = proposal["category"]
    merged["tagging_source"] = {"source": "solar", "tagged_at": tagged_at}
    return merged


async def propose_tags(row: dict, *, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> tuple[dict | None, str | None]:
    """시설 1건 태깅 제안 — 시설당 1콜, LLM 실패(None) 시 1회 재시도 후 skip.

    반환: (검증 통과 제안, None) 또는 (None, skip 사유). 검증 게이트 실패는 재시도하지 않는다
    — 형식 위반은 일시 장애가 아니라 모델 판단의 문제라 같은 입력 재호출의 기대 가치가 낮다.
    """
    system, user = build_prompt(row)
    parsed = None
    for _ in range(_MAX_ATTEMPTS):
        parsed = await llm_client.chat_json(system, user, max_tokens=DEFAULT_MAX_TOKENS, timeout=timeout)
        if parsed is not None:
            break
    if parsed is None:
        return None, SKIP_LLM_FAILED
    return validate_proposal(parsed, row)


def fetch_candidate_rows() -> list[dict]:
    """restaurant/cafe 를 id/name/type/features 로 SELECT(동기 — 스크립트 컨텍스트).

    결손 여부는 select_targets() 에서 파이썬으로 순수 필터링한다(JSONB 결손 판정을
    PostgREST 필터로 쓰는 것보다 단순 명확 — translate_overviews 관례).
    """
    from app.core.supabase import supabase_admin  # 지연 임포트 — 테스트에서 이 함수만 모킹하면 됨

    res = (
        supabase_admin.table("facilities")
        .select("id, name, type, features")
        .in_("type", list(TARGET_TYPES))
        .order("id")
        .execute()
    )
    return res.data or []


def apply_update(facility_id, merged_features: dict) -> None:
    """features 병합 결과 1건 UPDATE — --apply 경로 전용(테스트는 이 함수만 모킹해 쓰기 0회 검증)."""
    from app.core.supabase import supabase_admin  # 지연 임포트 — dry-run 경로는 쓰기 클라이언트 불필요

    supabase_admin.table("facilities").update({"features": merged_features}).eq("id", facility_id).execute()


def write_report(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


async def run(args: argparse.Namespace) -> int:
    rows = fetch_candidate_rows()
    targets = select_targets(rows)
    if args.limit:
        targets = targets[: args.limit]
    mode = "apply" if args.apply else "dry-run"
    print(f"[tag] restaurant/cafe {len(rows)}곳 중 태깅 대상 {len(targets)}곳 선정 (mode={mode})")

    if targets and not llm_client.is_enabled():
        # 무해 폴백 원칙(llm_client.py) — 키 미설정은 스크립트 오류가 아니라 조용한 스킵.
        print("[tag] UPSTAGE_API_KEY 미설정 — LLM 비활성 상태입니다. 태깅 없이 종료합니다.")
        return 0

    tagged_at = datetime.now(timezone.utc).isoformat()
    report: list[dict] = []
    proposed = 0
    applied = 0
    skipped = 0
    for idx, row in enumerate(targets, start=1):
        name = row.get("name") or "(이름 없음)"
        print(f"[tag] ({idx}/{len(targets)}) {name} (id={row.get('id')}) 제안 요청")
        proposal, skip_reason = await propose_tags(row)
        if proposal is None:
            skipped += 1
            print(f"[skip] {name}: {skip_reason}")
            report.append({
                "id": row.get("id"), "name": name, "type": row.get("type"),
                "status": "skip", "reason": skip_reason,
            })
            continue
        proposed += 1
        entry = {
            "id": row.get("id"), "name": name, "type": row.get("type"),
            "status": "proposed", "category": proposal["category"],
            "cuisine_tags": proposal["cuisine_tags"],
        }
        if args.apply:
            merged = merge_tagging(row.get("features"), proposal, tagged_at)
            try:
                apply_update(row["id"], merged)
                applied += 1
                entry["status"] = "applied"
                print(f"[apply] {name}: {proposal['category']} / {', '.join(proposal['cuisine_tags'])}")
            except Exception as e:  # noqa: BLE001 — 개별 저장 실패는 기록만 하고 나머지 계속(부분 성공 허용)
                skipped += 1
                proposed -= 1
                entry = {
                    "id": row.get("id"), "name": name, "type": row.get("type"),
                    "status": "skip", "reason": SKIP_SAVE_FAILED,
                }
                print(f"[skip] {name}: 저장 실패 — {e}")
        else:
            print(f"[proposed] {name}: {proposal['category']} / {', '.join(proposal['cuisine_tags'])}")
        report.append(entry)

    report_path = Path(args.report)
    if not report_path.is_absolute():
        report_path = Path.cwd() / report_path
    write_report(report_path, {
        "mode": mode, "tagged_at": tagged_at, "total_candidates": len(rows),
        "targets": len(targets), "proposed": proposed, "applied": applied,
        "skipped": skipped, "facilities": report,
    })
    print(
        f"[tag] 완료: 대상 {len(targets)} / 제안 {proposed} / 반영 {applied} / skip {skipped}"
        f" — 감사 보고서: {report_path}"
    )
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Solar 음식 분류 태깅 배치(cuisine_tags/category 결손 보충)")
    parser.add_argument(
        "--apply", action="store_true",
        help="검증 통과 제안을 DB(features 병합)에 반영. 기본은 dry-run(제안+보고서만, 쓰기 없음)",
    )
    parser.add_argument("--limit", type=int, default=0, help="태깅할 시설 수 상한(0=전체)")
    parser.add_argument(
        "--report", default=str(DEFAULT_REPORT_PATH),
        help=f"감사 보고서 JSON 경로(기본 {DEFAULT_REPORT_PATH})",
    )
    args = parser.parse_args()
    sys.exit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
