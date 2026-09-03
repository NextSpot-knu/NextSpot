# scripts/translate_overviews.py 순수 함수 테스트 — 시설 소개(overview) 다국어 번역 배치.
# DB/LLM 네트워크 없이 대상 선정·프롬프트 구성·병합·부분 성공(로케일별 실패 허용) 로직만 검증한다.
# import 패턴은 tests/test_facility_lifecycle.py 의 `import scripts.ingest_tourapi` 와 동일
# (apps/api/conftest.py 가 apps/api 를 sys.path 에 앵커 — scripts 는 네임스페이스 패키지로 임포트된다).
from unittest.mock import AsyncMock, patch

import pytest

import scripts.translate_overviews as translate_overviews


# ---------------------------------------------------------------------------
# parse_locales
# ---------------------------------------------------------------------------
def test_parse_locales_default_order_and_dedupe():
    assert translate_overviews.parse_locales("en,ja,zh") == ["en", "ja", "zh"]
    # 중복 제거 + 앞뒤 공백/대소문자 무시
    assert translate_overviews.parse_locales(" EN , en, Ja ") == ["en", "ja"]


def test_parse_locales_ignores_unsupported_without_raising():
    # ko(원문) 나 미지원 코드가 섞여도 예외 없이 무시하고 나머지만 반환
    assert translate_overviews.parse_locales("en,ko,fr,zh") == ["en", "zh"]
    assert translate_overviews.parse_locales("") == []
    assert translate_overviews.parse_locales(",,") == []


# ---------------------------------------------------------------------------
# select_targets
# ---------------------------------------------------------------------------
def test_select_targets_requires_nonblank_overview():
    rows = [
        {"id": "1", "name": "A", "overview": "소개문", "features": {}},
        {"id": "2", "name": "B", "overview": "", "features": {}},
        {"id": "3", "name": "C", "overview": "   ", "features": {}},
        {"id": "4", "name": "D", "overview": None, "features": {}},
    ]
    targets = translate_overviews.select_targets(rows)
    assert [r["id"] for r in targets] == ["1"]


def test_select_targets_skips_when_overview_i18n_already_present():
    rows = [
        {"id": "1", "name": "A", "overview": "소개문", "features": {"overview_i18n": {"en": "..."}}},
        {"id": "2", "name": "B", "overview": "소개문", "features": {"address": "경주"}},
        {"id": "3", "name": "C", "overview": "소개문", "features": None},
    ]
    targets = translate_overviews.select_targets(rows)
    assert [r["id"] for r in targets] == ["2", "3"]


def test_select_targets_force_includes_already_translated():
    rows = [
        {"id": "1", "name": "A", "overview": "소개문", "features": {"overview_i18n": {"en": "..."}}},
    ]
    targets = translate_overviews.select_targets(rows, force=True)
    assert [r["id"] for r in targets] == ["1"]


def test_select_targets_empty_overview_i18n_dict_is_not_blocking():
    # overview_i18n 키가 있어도 값이 빈 dict(falsy) 면 '아직 번역 안 됨'으로 취급해 대상에 포함.
    rows = [{"id": "1", "name": "A", "overview": "소개문", "features": {"overview_i18n": {}}}]
    assert [r["id"] for r in translate_overviews.select_targets(rows)] == ["1"]


# ---------------------------------------------------------------------------
# missing_locales / select_targets_fill_missing — 정화된 로케일만 재시도(--fill-missing)
# ---------------------------------------------------------------------------
def test_missing_locales_reports_absent_and_blank_only():
    row = {"features": {"overview_i18n": {"en": "ok", "ja": "", "zh": "   "}}}
    # ja(빈 문자열)·zh(공백)는 없음으로, en 은 있음으로 판정. 순서는 요청 순서 유지.
    assert translate_overviews.missing_locales(row, ["en", "ja", "zh"]) == ["ja", "zh"]
    assert translate_overviews.missing_locales({"features": None}, ["en"]) == ["en"]


def test_select_targets_fill_missing_picks_only_rows_with_gaps():
    rows = [
        {"id": "1", "overview": "소개", "features": {"overview_i18n": {"en": "x", "ja": "y", "zh": "z"}}},
        {"id": "2", "overview": "소개", "features": {"overview_i18n": {"en": "x"}}},  # ja/zh 정화됨
        {"id": "3", "overview": "", "features": {}},  # overview 없음 — 제외
        {"id": "4", "overview": "소개", "features": {}},  # 전 로케일 없음
    ]
    targets = translate_overviews.select_targets_fill_missing(rows, ["ja", "zh"])
    assert [r["id"] for r in targets] == ["2", "4"]
    # 요청 로케일이 전부 차 있으면 대상 아님
    assert translate_overviews.select_targets_fill_missing(rows, ["en"]) == [
        rows[3]
    ]


# ---------------------------------------------------------------------------
# build_prompt
# ---------------------------------------------------------------------------
def test_build_prompt_contains_instructions_and_content():
    system, user = translate_overviews.build_prompt("en", "황리단길", "경주의 대표 거리입니다.")
    assert "영어" in system
    assert "사실" in system and "추가" in system  # 사실·수치 추가 금지 지시
    assert "고유명사" in system
    assert "황리단길" in user
    assert "경주의 대표 거리입니다." in user


def test_build_prompt_forbids_hangul_and_source_annotation():
    # 초기 프롬프트의 '원문 괄호 병기' 허용이 한글 잔존(57/67곳 실측)의 원인 — 병기 지시가
    # 되살아나면 회귀. 대신 '한글 0자' 지시가 있어야 한다.
    system, _ = translate_overviews.build_prompt("ja", "이름", "내용")
    assert "병기" not in system
    assert "한글을 한 글자도" in system


def test_build_prompt_unknown_locale_falls_back_to_code():
    system, _ = translate_overviews.build_prompt("xx", "이름", "내용")
    assert "xx" in system


# ---------------------------------------------------------------------------
# merge_overview_i18n
# ---------------------------------------------------------------------------
def test_merge_overview_i18n_preserves_other_feature_keys():
    features = {"address": "경주시 ...", "overview_i18n": {"en": "old-en"}}
    merged = translate_overviews.merge_overview_i18n(features, {"ja": "new-ja"})
    assert merged["address"] == "경주시 ..."
    # 이번 실행에서 다루지 않은 기존 en 번역은 보존, 새 ja 는 추가.
    assert merged["overview_i18n"] == {"en": "old-en", "ja": "new-ja"}


def test_merge_overview_i18n_overwrites_same_locale():
    features = {"overview_i18n": {"en": "old-en"}}
    merged = translate_overviews.merge_overview_i18n(features, {"en": "new-en"})
    assert merged["overview_i18n"] == {"en": "new-en"}


def test_merge_overview_i18n_handles_missing_features():
    merged = translate_overviews.merge_overview_i18n(None, {"en": "hello"})
    assert merged == {"overview_i18n": {"en": "hello"}}


def test_merge_overview_i18n_purges_contaminated_locale():
    # Codex P0: 한글 잔존 최종 실패 로케일은 기존(오염) 번역을 삭제해야 정화 배치가 성립한다.
    features = {"address": "경주시", "overview_i18n": {"en": "old-en", "ja": "오염된 ja", "zh": "old-zh"}}
    merged = translate_overviews.merge_overview_i18n(features, {"en": "new-en"}, purge_locales=["ja"])
    assert merged["overview_i18n"] == {"en": "new-en", "zh": "old-zh"}  # ja 삭제, zh 보존
    assert merged["address"] == "경주시"


def test_merge_overview_i18n_purge_missing_locale_is_noop():
    merged = translate_overviews.merge_overview_i18n({"overview_i18n": {"en": "x"}}, {}, purge_locales=["ja"])
    assert merged["overview_i18n"] == {"en": "x"}


# ---------------------------------------------------------------------------
# contains_hangul — 한글 잔존 검증 게이트의 판정 기준(순수 함수)
# ---------------------------------------------------------------------------
def test_contains_hangul_detects_syllables_and_jamo():
    assert translate_overviews.contains_hangul("Gyeongju 황리단길 street")
    assert translate_overviews.contains_hangul("발명체험교육館は")  # 부분 미번역(실측 사례)
    assert translate_overviews.contains_hangul("ㅋㅋ")  # 호환 자모
    # Codex P1: 상호명에 실존하는 괄호 한글(㈜)·원문자 한글(㉠)·톤 마크도 검출해야 한다.
    assert translate_overviews.contains_hangul("㈜NextSpot Inc.")
    assert translate_overviews.contains_hangul("item ㉠ first")
    assert translate_overviews.contains_hangul("old text〮 mark")


def test_contains_hangul_passes_clean_target_languages():
    assert not translate_overviews.contains_hangul("A historic street in Gyeongju.")
    assert not translate_overviews.contains_hangul("慶州の代表的な通りです。")  # ja(한자·가나)
    assert not translate_overviews.contains_hangul("庆州的代表性街道。")  # zh
    assert not translate_overviews.contains_hangul("")
    assert not translate_overviews.contains_hangul(None)


# ---------------------------------------------------------------------------
# translate_locale — 한글 잔존 시 교정 재시도 1회, 그래도 남으면 None(저장 안 함)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_translate_locale_retries_once_on_residual_hangul_then_succeeds():
    calls = []

    async def fake_chat_text(system, user, *, max_tokens=800, timeout=None):
        calls.append(user)
        if len(calls) == 1:
            return "Hwangnidan 황리단길 is a famous street."  # 1차: 한글 잔존
        return "Hwangnidan-gil is a famous street."  # 2차(교정): 깨끗

    with patch.object(translate_overviews.llm_client, "chat_text", new=AsyncMock(side_effect=fake_chat_text)):
        status, result = await translate_overviews.translate_locale("en", "황리단길", "소개문")

    assert status == translate_overviews.STATUS_OK
    assert result == "Hwangnidan-gil is a famous street."
    assert len(calls) == 2
    # 교정 재시도 프롬프트에는 잔존 조각과 교정 지시가 들어간다.
    assert "교정 지시" in calls[1] and "황리단길" in calls[1]


@pytest.mark.asyncio
async def test_translate_locale_gives_up_after_retry_still_hangul():
    mock = AsyncMock(return_value="여전히 한글이 남은 출력")
    with patch.object(translate_overviews.llm_client, "chat_text", new=mock):
        status, result = await translate_overviews.translate_locale("ja", "이름", "내용")
    assert status == translate_overviews.STATUS_HANGUL_RESIDUAL
    assert result is None
    assert mock.await_count == 2  # 최초 1회 + 교정 재시도 1회에서 중단


@pytest.mark.asyncio
async def test_translate_locale_via_en_uses_english_source_prompt():
    # --via-en: 한국어 원문 대신 en 번역을 소스로 쓴다(zh 한글 잔존의 구조적 차단).
    captured = []

    async def fake_chat_text(system, user, *, max_tokens=800, timeout=None):
        captured.append((system, user))
        return "庆州著名的咖啡街。"

    with patch.object(translate_overviews.llm_client, "chat_text", new=AsyncMock(side_effect=fake_chat_text)):
        status, result = await translate_overviews.translate_locale(
            "zh", "카페능", "한국어 소개문", source_en="A famous cafe street in Gyeongju."
        )

    assert status == translate_overviews.STATUS_OK
    assert result == "庆州著名的咖啡街。"
    system, user = captured[0]
    assert "영어 소개문" in user and "A famous cafe street" in user
    assert "한국어 소개문" not in user  # 한국어 원문은 프롬프트에 싣지 않는다


def test_build_prompt_via_en_forbids_hangul():
    system, user = translate_overviews.build_prompt_via_en("zh", "카페능", "English overview.")
    assert "한글을 절대" in system
    assert "English overview." in user


@pytest.mark.asyncio
async def test_translate_locale_llm_failure_returns_none_without_retry():
    mock = AsyncMock(return_value=None)
    with patch.object(translate_overviews.llm_client, "chat_text", new=mock):
        status, result = await translate_overviews.translate_locale("en", "이름", "내용")
    assert status == translate_overviews.STATUS_LLM_FAILED
    assert result is None
    assert mock.await_count == 1  # LLM 자체 실패(타임아웃 등)는 교정 재시도 대상이 아니다


# ---------------------------------------------------------------------------
# translate_facility — 부분 성공(로케일별 실패 허용) 계약 검증. llm_client.chat_text 만 모킹.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_translate_facility_partial_success_skips_failed_locale():
    row = {"id": "f-1", "name": "황리단길", "overview": "경주의 대표 거리입니다."}

    async def fake_chat_text(system, user, *, max_tokens=800, timeout=None):
        # user 프롬프트에 로케일 지시가 직접 들어있진 않으므로 system 라벨로 로케일을 구분한다.
        if "일본어" in system:
            return None  # ja 실패 시뮬레이션(타임아웃/오류 등 llm_client 의 None 폴백)
        return "clean translated output"  # 한글 없는 출력(검증 게이트 통과)

    with patch.object(translate_overviews.llm_client, "chat_text", new=AsyncMock(side_effect=fake_chat_text)):
        results, purge = await translate_overviews.translate_facility(row, ["en", "ja", "zh"])

    assert "ja" not in results
    assert set(results.keys()) == {"en", "zh"}
    assert purge == []  # LLM 자체 실패는 정화 대상이 아니다(기존값 보존)
    assert all(v for v in results.values())


@pytest.mark.asyncio
async def test_translate_facility_purges_locale_when_hangul_persists():
    row = {"id": "f-4", "name": "이름", "overview": "내용"}

    async def fake_chat_text(system, user, *, max_tokens=800, timeout=None):
        if "일본어" in system:
            return "일본어인 척하는 한국어 출력"  # ja 만 한글 잔존(재시도에도 동일)
        return "clean output"

    with patch.object(translate_overviews.llm_client, "chat_text", new=AsyncMock(side_effect=fake_chat_text)):
        results, purge = await translate_overviews.translate_facility(row, ["en", "ja", "zh"])

    assert set(results.keys()) == {"en", "zh"}
    assert purge == ["ja"]  # 오염된 ja 는 정화(기존 번역 삭제) 대상으로 반환 — Codex P0


@pytest.mark.asyncio
async def test_translate_facility_all_fail_returns_empty_dict():
    row = {"id": "f-2", "name": "이름", "overview": "내용"}
    with patch.object(translate_overviews.llm_client, "chat_text", new=AsyncMock(return_value=None)):
        results, purge = await translate_overviews.translate_facility(row, ["en", "ja"])
    assert results == {}
    assert purge == []


@pytest.mark.asyncio
async def test_translate_facility_calls_chat_text_once_per_locale():
    row = {"id": "f-3", "name": "이름", "overview": "내용"}
    mock = AsyncMock(return_value="clean translation")
    with patch.object(translate_overviews.llm_client, "chat_text", new=mock):
        results, purge = await translate_overviews.translate_facility(row, ["en", "ja", "zh"])
    assert mock.await_count == 3  # 깨끗한 출력이면 로케일당 정확히 1콜(재시도 없음)
    assert set(results.keys()) == {"en", "ja", "zh"}
    assert purge == []
