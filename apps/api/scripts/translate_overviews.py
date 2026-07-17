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

한글 잔존 검증 게이트(2026-07-17, 전수 스캔 57/67곳 실측 후 도입): en/ja/zh 출력에 한글이
남으면 교정 재시도 1회, 그래도 남으면 해당 로케일의 기존 번역을 삭제(정화)한다 — 오염 문장을
심사 화면에 남기느니 프런트의 한국어 원문 폴백이 정직하다. LLM 자체 실패(타임아웃/오류)와는
구분해, 후자는 기존 번역을 보존한다(일시 장애가 데이터를 파괴하지 않게). 종료 코드:
0=전 로케일 성공, 2=부분 실패(정화·LLM 실패 포함), 1=갱신 0건.

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
import re
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

# 한글 잔존 검출(완성형+자모+호환 자모) — 번역 결과 검증 게이트.
# 2026-07-17 전수 스캔 실측: 초기 프롬프트('원문 괄호 병기' 허용)로 67곳 중 57곳에 한글 잔존
# (고유명사 수준이 아니라 문장 통째 미번역 사례 다수). 대상 언어(en/ja/zh) 출력에 한글이
# 한 글자라도 있으면 해당 로케일 실패로 취급한다 — 심사 화면에 미번역 문장을 내보내지 않는다.
# 범위: 자모(U+1100)·호환 자모(U+3130)·완성형(U+AC00)·자모 확장 A/B(U+A960/U+D7B0)·반각 자모(U+FFA0)
# + 톤 마크(U+302E-F)·괄호 한글(U+3200-321E, ㈜ 등 상호명 실존)·원문자 한글(U+3260-327E) — Codex P1.
_HANGUL_CLASS = r"[ᄀ-ᇿ㄰-㆏가-힣ꥠ-꥿ힰ-퟿ﾠ-ￜ〮〯㈀-㈞㉠-㉾]"
_HANGUL_RE = re.compile(_HANGUL_CLASS)
_HANGUL_FRAGMENT_RE = re.compile(_HANGUL_CLASS + "+")
# 최초 1회 + 한글 잔존 시 교정 재시도 1회(잔존 조각을 보여주면 교정률이 높다).
_MAX_ATTEMPTS_PER_LOCALE = 2

# translate_locale 의 결과 상태 — 실패 2종을 구분한다(Codex P0 반영의 핵심):
#   llm_failed(타임아웃/오류) → 기존 번역 보존(일시 장애가 데이터를 파괴하면 안 된다)
#   hangul_residual(검증 게이트 최종 실패) → 기존 번역 삭제(정화). 오염 문장을 심사 화면에
#     남기느니 프런트가 한국어 원문으로 폴백하는 쪽이 정직하다(RecommendationCard/waiting 기존 동작).
STATUS_OK = "ok"
STATUS_LLM_FAILED = "llm_failed"
STATUS_HANGUL_RESIDUAL = "hangul_residual"
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


def missing_locales(row: dict, locales: list[str]) -> list[str]:
    """요청 로케일 중 이 행에 번역이 없는(빈 문자열 포함) 것만 순서 유지로 반환 — 순수 함수.

    --fill-missing 의 판정 기준: 정화(삭제)된 로케일만 재시도하고, 이미 검증을 통과한
    번역은 건드리지 않는다(재번역 churn 방지 — 잘 된 번역이 재시도에서 정화될 위험 차단).
    """
    features = row.get("features")
    i18n = features.get("overview_i18n") if isinstance(features, dict) else None
    i18n = i18n if isinstance(i18n, dict) else {}
    return [loc for loc in locales if not (i18n.get(loc) or "").strip()]


def select_targets_fill_missing(rows: list[dict], locales: list[str]) -> list[dict]:
    """overview 가 있고 요청 로케일 중 하나라도 번역이 빠진 행만 선정(--fill-missing 전용)."""
    targets: list[dict] = []
    for row in rows:
        if not (row.get("overview") or "").strip():
            continue
        if missing_locales(row, locales):
            targets.append(row)
    return targets


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


# 로케일별 고유명사 표기 규칙 — 대상 언어 규칙만 프롬프트에 싣는다(타 언어 규칙 혼입 방지).
_NOTATION_RULES: dict[str, str] = {
    "en": "로마자 표기",
    "ja": "가타카나 또는 한자 표기",
    # zh 실측(2026-07-17 fill 루프): 창작 상호명(카페능 등)은 한자 표기가 마땅찮아 모델이 한글을
    # 유지하며 실패 — 로마자 탈출구를 준다(중국어 텍스트에서 외국 브랜드명 로마자 표기는 관례).
    "zh": "중국어 한자 표기(마땅한 한자 표기가 없는 상호명은 로마자 표기 허용)",
}


def build_prompt(locale: str, name: str, overview: str) -> tuple[str, str]:
    """로케일별 system/user 프롬프트 — 사실·수치 추가 금지 + 완전 번역(한글 0자) 지시."""
    lang_label = LOCALE_LABELS.get(locale, locale)
    notation = _NOTATION_RULES.get(locale, f"{lang_label} 표기")
    system = (
        f"관광지/가게 소개문을 자연스러운 {lang_label}로 번역하는 전문 번역가입니다. "
        "사실·수치를 추가하지 마세요(원문에 없는 내용 금지). "
        # 초기 프롬프트의 '원문 괄호 병기' 허용이 한글 잔존(57/67곳 실측)의 원인 — 병기 금지로 전환.
        f"출력에 한글을 한 글자도 남기지 마세요. 고유명사(상호명·지명)도 반드시 {notation}로 옮기세요. "
        "번역문만 출력하고 설명·따옴표·머리말을 덧붙이지 마세요. "
        # ja 실측(2026-07-17): 첫 줄에 장소명 제목 + 마크다운式 줄바꿈을 붙이는 버릇 → 명시 금지
        "장소명을 제목처럼 별도 줄로 반복하지 말고, 줄바꿈 없는 하나의 문단으로만 출력하세요."
    )
    user = f"[장소명] {name}\n[소개문]\n{overview}"
    return system, user


def contains_hangul(text: str) -> bool:
    """대상 언어 출력에 한글이 남았는지 검사 — 순수 함수(검증 게이트의 판정 기준)."""
    return bool(_HANGUL_RE.search(text or ""))


def build_prompt_via_en(locale: str, name: str, en_overview: str) -> tuple[str, str]:
    """영어 번역문을 소스로 쓰는 우회 프롬프트(--via-en).

    zh 실측(2026-07-17): 한국어 원문→zh 직번역은 창작 상호명에서 한글 잔존이 반복돼
    로마자 허용 후에도 일부가 끝내 실패했다. 이미 검증을 통과한 en 번역(한글 0자)을
    소스로 쓰면 출력에 한글이 섞일 여지가 구조적으로 없다 — 정확도는 2단 번역이라
    소폭 손실될 수 있으나, zh 결손(한국어 폴백)보다 낫다는 판단.
    """
    lang_label = LOCALE_LABELS.get(locale, locale)
    notation = _NOTATION_RULES.get(locale, f"{lang_label} 표기")
    system = (
        f"관광지/가게의 영어 소개문을 자연스러운 {lang_label}로 번역하는 전문 번역가입니다. "
        "사실·수치를 추가하지 마세요(원문에 없는 내용 금지). "
        f"출력에 한글을 절대 쓰지 마세요. 고유명사(상호명·지명)는 반드시 {notation}로 옮기세요. "
        "번역문만 출력하고 설명·따옴표·머리말을 덧붙이지 마세요. "
        "장소명을 제목처럼 별도 줄로 반복하지 말고, 줄바꿈 없는 하나의 문단으로만 출력하세요."
    )
    user = f"[장소명] {name}\n[영어 소개문]\n{en_overview}"
    return system, user


def merge_overview_i18n(
    features: dict | None,
    new_translations: dict[str, str],
    purge_locales: list[str] | tuple[str, ...] = (),
) -> dict:
    """기존 features 에 새 번역을 overview_i18n 하위로 병합.

    다른 키(주소·전화 등)는 그대로 보존하고, overview_i18n 내부의 이번에 다루지 않은 로케일
    (예: 이전 실행에서 저장된 en 은 두고 이번엔 ja 만 재번역)도 보존한다.
    purge_locales(한글 잔존 검증 최종 실패 로케일)는 기존 값을 삭제한다 — Codex P0:
    검증 실패 로케일이 기존 '오염된' 번역을 조용히 보존하면 정화 배치가 목적을 달성하지 못한다.
    """
    merged = dict(features) if isinstance(features, dict) else {}
    existing_i18n = dict(merged.get("overview_i18n") or {})
    for locale in purge_locales:
        existing_i18n.pop(locale, None)
    existing_i18n.update(new_translations)
    merged["overview_i18n"] = existing_i18n
    return merged


async def translate_locale(
    locale: str,
    name: str,
    overview: str,
    *,
    source_en: str | None = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> tuple[str, str | None]:
    """로케일 1건 번역 + 한글 잔존 검증 게이트. 반환: (상태, 번역문 또는 None).

    한글이 남으면 잔존 조각을 보여주는 교정 지시로 1회 재시도하고, 그래도 남으면
    STATUS_HANGUL_RESIDUAL — 호출자는 해당 로케일의 기존 번역을 삭제(정화)한다.
    LLM 자체 실패(타임아웃/오류)는 STATUS_LLM_FAILED 로 구분 — 기존 번역을 보존한다.
    source_en 이 주어지면 한국어 원문 대신 영어 번역문을 소스로 쓴다(--via-en 우회).
    """
    if source_en is not None:
        system, user = build_prompt_via_en(locale, name, source_en)
    else:
        system, user = build_prompt(locale, name, overview)
    lang_label = LOCALE_LABELS.get(locale, locale)
    for attempt in range(_MAX_ATTEMPTS_PER_LOCALE):
        text = await llm_client.chat_text(system, user, max_tokens=max_tokens, timeout=timeout)
        if not text or not text.strip():
            # LLM 실패(타임아웃/오류) — 교정 재시도 대상이 아니므로 즉시 포기(재시도는 llm_client 밖 책임)
            return STATUS_LLM_FAILED, None
        candidate = text.strip()
        if not contains_hangul(candidate):
            return STATUS_OK, candidate
        fragments = _HANGUL_FRAGMENT_RE.findall(candidate)[:10]
        print(
            f"[translate]   {locale}: 한글 잔존 감지(시도 {attempt + 1}/{_MAX_ATTEMPTS_PER_LOCALE}) — "
            f"조각 예: {', '.join(fragments[:3])}"
        )
        # 교정 재시도 — 직전 출력의 잔존 조각을 근거로 완전 번역을 재지시한다(소스 종류 유지).
        source_block = (
            f"[장소명] {name}\n[영어 소개문]\n{source_en}"
            if source_en is not None
            else f"[장소명] {name}\n[소개문]\n{overview}"
        )
        user = (
            f"{source_block}\n\n"
            f"[교정 지시] 직전 번역에 다음 한글이 남았습니다: {', '.join(fragments)}. "
            f"이 단어들을 포함해 전체를 한글 없이 완전한 {lang_label}로만 다시 번역하세요."
        )
    return STATUS_HANGUL_RESIDUAL, None


async def translate_facility(
    row: dict,
    locales: list[str],
    *,
    source_en: str | None = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> tuple[dict[str, str], list[str]]:
    """시설 1건에 대해 로케일별 번역(검증 게이트 포함). 반환: (성공 번역, 정화 대상 로케일).

    LLM 자체 실패 로케일은 둘 다에서 빠진다(기존값 보존 — 부분 성공 허용).
    한글 잔존 최종 실패 로케일은 정화 목록으로 반환 — 호출자가 기존 번역을 삭제한다(Codex P0).
    source_en 이 주어지면 en 이외 로케일을 영어 번역문에서 우회 번역한다(--via-en).
    """
    name = row.get("name") or ""
    overview = (row.get("overview") or "").strip()
    results: dict[str, str] = {}
    purge: list[str] = []
    for locale in locales:
        status, translated = await translate_locale(
            locale,
            name,
            overview,
            source_en=source_en if locale != "en" else None,
            max_tokens=max_tokens,
            timeout=timeout,
        )
        if status == STATUS_OK and translated is not None:
            results[locale] = translated
        elif status == STATUS_HANGUL_RESIDUAL:
            purge.append(locale)
            print(f"[translate]   {locale}: 한글 잔존 최종 실패 → 기존 번역 삭제(정화) — id={row.get('id')} name={name}")
        else:
            print(f"[translate]   {locale}: LLM 실패(기존값 보존) — id={row.get('id')} name={name}")
    return results, purge


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
    if args.force and args.fill_missing:
        print("[translate] --force 와 --fill-missing 은 동시 사용 불가(의미 상충). 중단합니다.")
        return 1
    if args.via_en and not args.fill_missing:
        # 전량 배치를 en 경유로 돌리면 2단 번역 손실이 기본값이 된다 — 잔존 결손 보충 전용.
        print("[translate] --via-en 은 --fill-missing 과 함께만 사용 가능합니다. 중단합니다.")
        return 1
    if args.via_en and "en" in locales:
        print("[translate] --via-en 은 en 을 대상 로케일로 가질 수 없습니다(--locales 확인). 중단합니다.")
        return 1

    rows = fetch_candidate_rows()
    if args.fill_missing:
        targets = select_targets_fill_missing(rows, locales)
    else:
        targets = select_targets(rows, force=args.force)
    if args.limit:
        targets = targets[: args.limit]

    print(
        f"[translate] overview 보유 {len(rows)}건 중 번역 대상 {len(targets)}건 선정 "
        f"(force={args.force}, fill_missing={args.fill_missing}, locales={','.join(locales)})"
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
    save_failed = 0
    locale_success = {locale: 0 for locale in locales}
    locale_purged = {locale: 0 for locale in locales}   # 한글 잔존 최종 실패 → 기존 번역 삭제
    locale_fail = {locale: 0 for locale in locales}     # LLM 자체 실패 또는 저장 실패

    for idx, row in enumerate(targets, start=1):
        name = row.get("name") or "(이름 없음)"
        # --fill-missing 은 빠진 로케일만 재시도(검증 통과한 기존 번역은 재번역 churn 없이 보존).
        row_locales = missing_locales(row, locales) if args.fill_missing else locales
        if not row_locales:
            continue
        source_en = None
        if args.via_en:
            features = row.get("features")
            i18n = features.get("overview_i18n") if isinstance(features, dict) else None
            source_en = ((i18n or {}).get("en") or "").strip() or None
            if source_en is None:
                # en 소스가 없으면 우회 불가 — 이 행은 건너뛴다(직번역 재시도는 이미 소진된 케이스).
                print(f"[translate]   -> en 번역 없음, --via-en 건너뜀: id={row.get('id')}")
                for locale in row_locales:
                    locale_fail[locale] += 1
                continue
        print(
            f"[translate] ({idx}/{len(targets)}) {name} (id={row.get('id')}) 번역 시작"
            + (f" — 대상 로케일 {row_locales}" if args.fill_missing else "")
            + (" [en 경유]" if source_en is not None else "")
        )
        translations, purge = await translate_facility(row, row_locales, source_en=source_en)
        # LLM 자체 실패는 저장 여부와 무관하게 여기서 계상. 성공·정화 카운터는 DB UPDATE
        # 성공 후에만 증가시킨다(Codex P2: 저장 실패를 성공으로 위장하지 않기).
        for locale in row_locales:
            if locale not in translations and locale not in purge:
                locale_fail[locale] += 1

        if not translations and not purge:
            print(f"[translate]   -> 전 로케일 LLM 실패, 건너뜀(기존값 보존): id={row.get('id')}")
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
        merged_features = merge_overview_i18n(base_features, translations, purge_locales=purge)
        try:
            supabase_admin.table("facilities").update({"features": merged_features}).eq(
                "id", row["id"]
            ).execute()
            updated += 1
            for locale in row_locales:
                if locale in translations:
                    locale_success[locale] += 1
                elif locale in purge:
                    locale_purged[locale] += 1
            saved = f"저장 {sorted(translations.keys())}"
            if purge:
                saved += f", 정화(삭제) {sorted(purge)}"
            print(f"[translate]   -> 완료: {saved}")
        except Exception as e:  # noqa: BLE001 — 개별 시설 저장 실패는 로그만 남기고 나머지 계속(부분 성공 허용)
            save_failed += 1
            # 저장이 안 됐으니 이 행의 번역·정화도 DB 에 반영되지 않았다 — 실패로 계상.
            for locale in row_locales:
                if locale in translations or locale in purge:
                    locale_fail[locale] += 1
            print(f"[translate]   -> 저장 실패(id={row.get('id')}): {e}")

    total_purged = sum(locale_purged.values())
    total_fail = sum(locale_fail.values())
    print(
        f"\n[translate] 완료: {updated}/{len(targets)} 시설 갱신. 로케일별 성공/정화/실패 — "
        + ", ".join(
            f"{locale}={locale_success[locale]}/{locale_purged[locale]}/{locale_fail[locale]}"
            for locale in locales
        )
        + (f" (저장 실패 {save_failed}건 포함)" if save_failed else "")
    )
    if updated == 0:
        return 1
    if total_purged or total_fail:
        # Codex P1: 부분 실패를 성공(0)으로 위장하면 '정화 완료' 오판을 부른다 — 별도 코드 2.
        print("[translate] 일부 로케일 실패 — 잔존 확인 후 --force 재실행이 필요할 수 있습니다(종료 코드 2).")
        return 2
    return 0


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
        help=(
            "기존 features.overview_i18n 이 있어도 재번역. 지정 로케일은 성공 시 덮어쓰고, "
            "한글 잔존 최종 실패 시 기존 번역을 삭제(정화 — 한국어 원문 폴백), "
            "LLM 자체 실패 시 보존한다. 미지정 로케일은 항상 보존."
        ),
    )
    parser.add_argument(
        "--fill-missing", action="store_true",
        help=(
            "지정 로케일 중 번역이 빠진(정화 포함) 것만 시설별로 재시도. "
            "검증을 통과한 기존 번역은 건드리지 않는다(--force 와 달리 churn 없음)."
        ),
    )
    parser.add_argument(
        "--via-en", action="store_true",
        help=(
            "(--fill-missing 전용) 한국어 원문 대신 기존 en 번역을 소스로 우회 번역. "
            "직번역이 한글 잔존으로 반복 실패한 로케일(주로 zh)의 결손 보충용 — "
            "en 소스에는 한글이 없어 잔존이 구조적으로 차단된다."
        ),
    )
    args = parser.parse_args()

    exit_code = asyncio.run(run(args))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
