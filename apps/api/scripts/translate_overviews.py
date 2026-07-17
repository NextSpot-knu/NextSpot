"""시설 소개(overview) 다국어 번역 배치 — features.overview_i18n 에 저장(스키마 변경 없음).

PM 결정(2026-07-17): facilities.overview(한국어, 67/85곳 보유)를 en/ja/zh 로 배치 번역해
features.overview_i18n = {"en": ..., "ja": ..., "zh": ...} 에 저장한다. 마이그레이션 없이
기존 JSONB 컬럼(features)에 얹는다 — 프런트는 apps/web/components/RecommendationCard.tsx,
apps/web/app/waiting/page.tsx 에서 현재 로케일이 ko 가 아니면 이 값을 overview 대신 쓴다
(번역이 없으면 지금처럼 한국어 원문 표시 — 기존 동작 불변).

번역은 app/services/llm_client.py(Upstage Solar 어댑터)를 배치 전용으로 호출한다 — 데모 중
실시간(런타임) LLM 호출은 없다(외부 의존 0 원칙, llm_client.py 모듈 docstring의 재도입 조건 참고).
llm_client 는 '무해 폴백' 계약이라 키 미설정/타임아웃/오류는 예외 없이 None — 이 스크립트는
그 None 을 '해당 로케일 실패'로 받아 건너뛰고 나머지 로케일/시설은 계속 처리한다(부분 성공 허용).

대상 선정(SELECT 후 파이썬 필터, 패턴 참고: scripts/ingest_tourapi.py 의 Supabase 접근·
SELECT 후 INSERT/UPDATE 폴백 관례):
  - facilities.overview 가 있고(공백 제외)
  - features.overview_i18n 이 아직 없는 시설만 대상(--force 로 기존 번역 있어도 재번역)

사용 예:
  python scripts/translate_overviews.py --dry-run --limit 1   # LLM 호출/DB 기록 없이 대상 선정만 확인
  python scripts/translate_overviews.py --limit 5              # 상위 5곳만 실번역
  python scripts/translate_overviews.py --locales en,ja        # zh 제외하고 두 로케일만
  python scripts/translate_overviews.py --force                # 기존 번역이 있어도 재번역(로케일별 덮어씀)

주의: --dry-run 도 대상 선정을 위해 facilities 를 읽기 전용으로 SELECT 한다(뮤테이션 없음) —
LLM 호출과 UPDATE 만 건너뛴다. ingest_tourapi.py --dry-run(외부 API 는 호출하되 DB 기록만
생략)과 동일한 원칙이며, 이 스크립트는 소스 데이터 자체가 Supabase 라 SELECT 는 불가피하다.
"""

import argparse
import asyncio
import os
import sys

# scripts/ingest_tourapi.py 와 동일 부트스트랩(train.py 컨벤션) — apps/api 를 sys.path 에 추가해야
# 아래 `from app.services...` 가 어떤 실행 위치에서도 동작한다.
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.append(parent_dir)

from dotenv import load_dotenv

# 프로젝트 루트 밖에서 실행할 때를 대비한 .env 로드(ingest_tourapi.py 와 동일).
load_dotenv(os.path.join(parent_dir, ".env"))

from app.services import llm_client  # noqa: E402 — sys.path 부트스트랩 뒤 임포트(scripts/* ruff 예외)

# 번역 대상 로케일 — ko(원문)는 제외. 프런트 4로케일(ko/en/ja/zh) 중 ko 를 뺀 셋(I18nProvider 참고).
SUPPORTED_LOCALES: tuple[str, ...] = ("en", "ja", "zh")
LOCALE_LABELS: dict[str, str] = {"en": "영어", "ja": "일본어", "zh": "중국어(간체)"}
DEFAULT_LOCALES = ",".join(SUPPORTED_LOCALES)

# overview 는 수백 자 한국어 — 번역 결과(특히 영어)가 원문보다 길어질 수 있어 넉넉히 잡는다.
DEFAULT_MAX_TOKENS = 800
# llm_client 기본 타임아웃(3초)은 실시간 음성 UX 상한 기준 — 배치 컨텍스트에는 과하게 짧아
# chat_text 의 timeout 파라미터로 넉넉히 override 한다(설정 전역값 settings.LLM_TIMEOUT_SECONDS 는 불변).
DEFAULT_TIMEOUT_SECONDS = 15.0


def parse_locales(raw: str) -> list[str]:
    """콤마 구분 로케일 문자열 → 지원 로케일만 순서 유지·중복 제거. 미지원 값은 경고 후 무시(예외 없음)."""
    result: list[str] = []
    for token in raw.split(","):
        code = token.strip().lower()
        if not code:
            continue
        if code not in SUPPORTED_LOCALES:
            print(f"[translate] 미지원 로케일 무시: {code!r} (지원: {', '.join(SUPPORTED_LOCALES)})")
            continue
        if code not in result:
            result.append(code)
    return result


def select_targets(rows: list[dict], *, force: bool = False) -> list[dict]:
    """overview 가 있고(공백 제외) features.overview_i18n 이 없는(또는 force) 행만 선정.

    순수 함수 — Supabase 응답 형태(list[dict])만 받아 DB 접속 없이 테스트 가능하다.
    """
    targets: list[dict] = []
    for row in rows:
        overview = (row.get("overview") or "").strip()
        if not overview:
            continue
        features = row.get("features")
        existing_i18n = features.get("overview_i18n") if isinstance(features, dict) else None
        if existing_i18n and not force:
            continue
        targets.append(row)
    return targets


def build_prompt(locale: str, name: str, overview: str) -> tuple[str, str]:
    """로케일별 system/user 프롬프트 — 사실·수치 추가 금지 + 고유명사 관례 표기 지시(요구사항 원문 반영)."""
    lang_label = LOCALE_LABELS.get(locale, locale)
    system = (
        f"관광지/가게 소개문을 자연스러운 {lang_label}로 번역하는 전문 번역가입니다. "
        "사실·수치를 추가하지 마세요(원문에 없는 내용 금지). "
        "고유명사(상호명·지명)는 관례적 표기 또는 원문을 괄호로 병기하세요. "
        "번역문만 출력하고 설명·따옴표·머리말을 덧붙이지 마세요. "
        # ja 실측(2026-07-17): 첫 줄에 장소명 제목 + 마크다운式 줄바꿈을 붙이는 버릇 → 명시 금지
        "장소명을 제목처럼 별도 줄로 반복하지 말고, 줄바꿈 없는 하나의 문단으로만 출력하세요."
    )
    user = f"[장소명] {name}\n[소개문]\n{overview}"
    return system, user


def merge_overview_i18n(features: dict | None, new_translations: dict[str, str]) -> dict:
    """기존 features 에 새 번역을 overview_i18n 하위로 병합.

    다른 키(주소·전화 등)는 그대로 보존하고, overview_i18n 내부의 이번에 다루지 않은 로케일
    (예: 이전 실행에서 저장된 en 은 두고 이번엔 ja 만 재번역)도 보존한다.
    """
    merged = dict(features) if isinstance(features, dict) else {}
    existing_i18n = dict(merged.get("overview_i18n") or {})
    existing_i18n.update(new_translations)
    merged["overview_i18n"] = existing_i18n
    return merged


async def translate_facility(
    row: dict,
    locales: list[str],
    *,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, str]:
    """시설 1건에 대해 로케일당 1콜씩 번역. 실패한 로케일은 결과에서 빠진다(부분 성공 허용)."""
    name = row.get("name") or ""
    overview = (row.get("overview") or "").strip()
    results: dict[str, str] = {}
    for locale in locales:
        system, user = build_prompt(locale, name, overview)
        text = await llm_client.chat_text(system, user, max_tokens=max_tokens, timeout=timeout)
        if text and text.strip():
            results[locale] = text.strip()
        else:
            print(f"[translate]   {locale}: 실패(건너뜀) — id={row.get('id')} name={name}")
    return results


def fetch_candidate_rows() -> list[dict]:
    """facilities 에서 overview 가 있는 행만 id/name/overview/features 로 SELECT(동기 — 스크립트 컨텍스트,
    admin.py 등 라우터의 asyncio.to_thread 오프로드는 불필요 — DB I/O 를 막아도 이벤트루프 경합 상대가 없다).

    force/limit 등 나머지 조건은 select_targets() 에서 파이썬으로 순수 필터링한다(JSONB 키 존재
    여부를 PostgREST 필터 표현으로 쓰는 것보다 단순 명확).
    """
    from app.core.supabase import supabase_admin  # 지연 임포트 — 테스트에서 이 함수만 모킹하면 됨

    res = (
        supabase_admin.table("facilities")
        .select("id, name, overview, features")
        .not_.is_("overview", "null")
        .order("id")
        .execute()
    )
    return res.data or []


async def run(args: argparse.Namespace) -> int:
    locales = parse_locales(args.locales)
    if not locales:
        print("[translate] 유효한 로케일이 없습니다(--locales 확인). 중단합니다.")
        return 1

    rows = fetch_candidate_rows()
    targets = select_targets(rows, force=args.force)
    if args.limit:
        targets = targets[: args.limit]

    print(
        f"[translate] overview 보유 {len(rows)}건 중 번역 대상 {len(targets)}건 선정 "
        f"(force={args.force}, locales={','.join(locales)})"
    )
    for row in targets:
        print(f"[translate]   대상: id={row.get('id')} name={row.get('name')}")

    if args.dry_run:
        print("\n--dry-run: LLM 호출/DB 기록 없이 대상 선정 결과만 출력했습니다.\n")
        return 0

    if not targets:
        print("[translate] 번역할 시설이 없습니다(이미 전부 번역됐거나 overview 보유 시설이 없음).")
        return 0

    if not llm_client.is_enabled():
        # 무해 폴백 원칙(llm_client.py) — 키 미설정은 스크립트 오류가 아니라 조용한 스킵.
        print("[translate] UPSTAGE_API_KEY 미설정 — LLM 비활성 상태입니다. 번역 없이 종료합니다.")
        return 0

    from app.core.supabase import supabase_admin  # 지연 임포트 — 쓰기 경로에서만 필요

    updated = 0
    locale_success = {locale: 0 for locale in locales}
    locale_fail = {locale: 0 for locale in locales}

    for idx, row in enumerate(targets, start=1):
        name = row.get("name") or "(이름 없음)"
        print(f"[translate] ({idx}/{len(targets)}) {name} (id={row.get('id')}) 번역 시작")
        translations = await translate_facility(row, locales)
        for locale in locales:
            if locale in translations:
                locale_success[locale] += 1
            else:
                locale_fail[locale] += 1

        if not translations:
            print(f"[translate]   -> 전 로케일 실패, 건너뜀: id={row.get('id')}")
            continue

        # 저장 직전 최신 features 재조회 후 병합(Codex 리뷰 P2): 번역하는 몇 초 사이 인제스트/
        # 관리자 작업이 같은 행의 다른 features 키를 갱신했을 때 낡은 스냅샷으로 덮지 않게 한다.
        # (재조회~UPDATE 사이의 극소 경합 창은 잔존 — 일 1회 배치 특성상 허용)
        try:
            fresh = (
                supabase_admin.table("facilities")
                .select("features").eq("id", row["id"]).execute()
            )
            base_features = (fresh.data[0].get("features") if fresh.data else None) or row.get("features")
        except Exception:  # noqa: BLE001 — 재조회 실패 시 기존 스냅샷으로 진행(종전 동작)
            base_features = row.get("features")
        merged_features = merge_overview_i18n(base_features, translations)
        try:
            supabase_admin.table("facilities").update({"features": merged_features}).eq(
                "id", row["id"]
            ).execute()
            updated += 1
            print(f"[translate]   -> 저장 완료: {sorted(translations.keys())}")
        except Exception as e:  # noqa: BLE001 — 개별 시설 저장 실패는 로그만 남기고 나머지 계속(부분 성공 허용)
            print(f"[translate]   -> 저장 실패(id={row.get('id')}): {e}")

    print(
        f"\n[translate] 완료: {updated}/{len(targets)} 시설 갱신. 로케일별 성공/실패 — "
        + ", ".join(f"{locale}={locale_success[locale]}/{locale_fail[locale]}" for locale in locales)
    )
    return 0 if updated > 0 else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="시설 소개(overview) 다국어 번역 배치")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="LLM 호출/DB 기록 없이 대상 선정 결과만 출력(facilities SELECT 는 수행)",
    )
    parser.add_argument("--limit", type=int, default=0, help="번역할 시설 수 상한(0=전체)")
    parser.add_argument(
        "--locales", type=str, default=DEFAULT_LOCALES,
        help=f"번역할 로케일 콤마 구분(기본 {DEFAULT_LOCALES})",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="기존 features.overview_i18n 이 있어도 재번역(지정 로케일만 덮어씀, 나머지 로케일은 보존)",
    )
    args = parser.parse_args()

    exit_code = asyncio.run(run(args))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
