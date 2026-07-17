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
# build_prompt
# ---------------------------------------------------------------------------
def test_build_prompt_contains_instructions_and_content():
    system, user = translate_overviews.build_prompt("en", "황리단길", "경주의 대표 거리입니다.")
    assert "영어" in system
    assert "사실" in system and "추가" in system  # 사실·수치 추가 금지 지시
    assert "고유명사" in system
    assert "황리단길" in user
    assert "경주의 대표 거리입니다." in user


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
        return f"translated:{system[:2]}"

    with patch.object(translate_overviews.llm_client, "chat_text", new=AsyncMock(side_effect=fake_chat_text)):
        results = await translate_overviews.translate_facility(row, ["en", "ja", "zh"])

    assert "ja" not in results
    assert set(results.keys()) == {"en", "zh"}
    assert all(v for v in results.values())


@pytest.mark.asyncio
async def test_translate_facility_all_fail_returns_empty_dict():
    row = {"id": "f-2", "name": "이름", "overview": "내용"}
    with patch.object(translate_overviews.llm_client, "chat_text", new=AsyncMock(return_value=None)):
        results = await translate_overviews.translate_facility(row, ["en", "ja"])
    assert results == {}


@pytest.mark.asyncio
async def test_translate_facility_calls_chat_text_once_per_locale():
    row = {"id": "f-3", "name": "이름", "overview": "내용"}
    mock = AsyncMock(return_value="번역결과")
    with patch.object(translate_overviews.llm_client, "chat_text", new=mock):
        results = await translate_overviews.translate_facility(row, ["en", "ja", "zh"])
    assert mock.await_count == 3  # 로케일당 정확히 1콜
    assert set(results.keys()) == {"en", "ja", "zh"}
