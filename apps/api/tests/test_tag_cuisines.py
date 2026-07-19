# scripts/tag_cuisines.py 테스트 — Solar 음식 분류 태깅 배치.
# DB/LLM 네트워크 없이 대상 선정(fill-missing)·검증 게이트(화이트리스트/태그 형식)·features 병합
# 무손실·dry-run 무쓰기 계약만 검증한다. import 패턴은 tests/test_translate_overviews.py 와 동일
# (apps/api/conftest.py 가 apps/api 를 sys.path 에 앵커 — scripts 는 네임스페이스 패키지로 임포트).
import argparse
import json
from unittest.mock import AsyncMock, patch

import pytest

import scripts.tag_cuisines as tag_cuisines
from app.services.voice_intent_service import _INTENT_CATEGORIES


def _args(tmp_path, *, apply=False, limit=0):
    return argparse.Namespace(apply=apply, limit=limit, report=str(tmp_path / "report.json"))


# ---------------------------------------------------------------------------
# select_targets — fill-missing only(④): 이미 둘 다 채워진 시설은 대상에서 제외
# ---------------------------------------------------------------------------
def test_select_targets_fill_missing_excludes_already_tagged():
    rows = [
        # 둘 다 있음 — 제외(이미 있는 값은 건드리지 않는다)
        {"id": "1", "type": "restaurant", "features": {"cuisine_tags": ["삼겹살"], "category": "고깃집"}},
        # cuisine_tags 만 결손 — 대상
        {"id": "2", "type": "restaurant", "features": {"category": "중식"}},
        # category 만 결손(빈 문자열 포함) — 대상
        {"id": "3", "type": "cafe", "features": {"cuisine_tags": ["라떼"], "category": "  "}},
        # 둘 다 결손(features 자체 없음) — 대상
        {"id": "4", "type": "restaurant", "features": None},
        # 빈 리스트는 결손으로 판정 — 대상
        {"id": "5", "type": "cafe", "features": {"cuisine_tags": [], "category": "카페"}},
    ]
    assert [r["id"] for r in tag_cuisines.select_targets(rows)] == ["2", "3", "4", "5"]


def test_select_targets_only_restaurant_and_cafe():
    rows = [
        {"id": "1", "type": "attraction", "features": {}},
        {"id": "2", "type": "culture", "features": None},
        {"id": "3", "type": "restaurant", "features": {}},
    ]
    assert [r["id"] for r in tag_cuisines.select_targets(rows)] == ["3"]


# ---------------------------------------------------------------------------
# validate_proposal — 검증 게이트(①②): 하나라도 실패하면 skip(쓰지 않음)
# (시그니처는 row 기반 — 상호 조각 태그 차단이 name·메뉴 근거를 봐야 해서다)
# ---------------------------------------------------------------------------
def _row(facility_type: str = "restaurant", name: str = "테스트가게", **features) -> dict:
    return {"type": facility_type, "name": name, "features": features}


def test_validate_proposal_rejects_category_outside_whitelist():
    # ① 화이트리스트 밖 category("이탈리안"은 _INTENT_CATEGORIES 에 없음) → skip
    proposal, reason = tag_cuisines.validate_proposal(
        {"category": "이탈리안", "cuisine_tags": ["파스타"]}, _row("restaurant")
    )
    assert proposal is None
    assert reason == tag_cuisines.SKIP_INVALID_CATEGORY


def test_validate_proposal_accepts_whitelist_category():
    assert "고깃집" in _INTENT_CATEGORIES  # 화이트리스트 정본(import 재사용, 복사 아님) 전제 확인
    proposal, reason = tag_cuisines.validate_proposal(
        {"category": "고깃집", "cuisine_tags": ["삼겹살", "목살"]}, _row("restaurant")
    )
    assert reason is None
    assert proposal == {"category": "고깃집", "cuisine_tags": ["삼겹살", "목살"]}


def test_validate_proposal_cafe_type_allows_cafe_category():
    # 카페 타입이면 "카페" 강제 허용(정본에 있든 없든 자명한 분류는 통과)
    proposal, reason = tag_cuisines.validate_proposal(
        {"category": "카페", "cuisine_tags": ["아메리카노"]}, _row("cafe")
    )
    assert reason is None
    assert proposal["category"] == "카페"


def test_validate_proposal_rejects_tag_format_violations():
    # ② 형식 위반 3종: 4개 초과 / 영문 / 11자 — 전부 skip(부분 채택 없음)
    four, r_four = tag_cuisines.validate_proposal(
        {"category": "한식", "cuisine_tags": ["불고기", "비빔밥", "국수", "전골"] }, _row("restaurant")
    )
    assert four is None and r_four == tag_cuisines.SKIP_INVALID_TAGS
    english, r_en = tag_cuisines.validate_proposal(
        {"category": "양식", "cuisine_tags": ["pasta"]}, _row("restaurant")
    )
    assert english is None and r_en == tag_cuisines.SKIP_INVALID_TAGS
    eleven, r_len = tag_cuisines.validate_proposal(
        {"category": "한식", "cuisine_tags": ["가" * 11]}, _row("restaurant")
    )
    assert eleven is None and r_len == tag_cuisines.SKIP_INVALID_TAGS


def test_validate_proposal_rejects_numbers_urls_and_empty_or_nonlist():
    for bad_tags in (["삼겹살1"], ["http주소"], [], ["한식", 3], "삼겹살", None):
        proposal, reason = tag_cuisines.validate_proposal(
            {"category": "한식", "cuisine_tags": bad_tags}, _row("restaurant")
        )
        assert proposal is None
        assert reason == tag_cuisines.SKIP_INVALID_TAGS


def test_validate_proposal_dedupes_tags_preserving_order():
    proposal, reason = tag_cuisines.validate_proposal(
        {"category": "국밥집", "cuisine_tags": ["국밥", "수육", "국밥"]}, _row("restaurant")
    )
    assert reason is None
    assert proposal["cuisine_tags"] == ["국밥", "수육"]


def test_validate_proposal_drops_name_fragment_tags():
    # 1차 dry-run 실측 사고: '소소밀밀 서악점' → 태그 [소소밀밀, 서악점](상호 조각).
    # 메뉴 근거에 없는 이름 조각 태그는 걸러지고, 전부 걸러지면 시설 skip.
    row = _row("cafe", name="소소밀밀 서악점")
    proposal, reason = tag_cuisines.validate_proposal(
        {"category": "카페", "cuisine_tags": ["소소밀밀", "서악점"]}, row
    )
    assert proposal is None
    assert reason == tag_cuisines.SKIP_NAME_FRAGMENT_TAGS
    # 일부만 상호 조각이면 그 태그만 탈락하고 나머지는 채택.
    proposal, reason = tag_cuisines.validate_proposal(
        {"category": "카페", "cuisine_tags": ["소소밀밀", "아메리카노"]}, row
    )
    assert reason is None
    assert proposal["cuisine_tags"] == ["아메리카노"]


def test_validate_proposal_keeps_name_tag_when_menu_confirms():
    # 상호=대표메뉴인 경우('황남빵') — 메뉴 텍스트에도 등장하므로 태그 유지.
    row = _row("cafe", name="황남빵", first_menu="황남빵")
    proposal, reason = tag_cuisines.validate_proposal(
        {"category": "카페", "cuisine_tags": ["황남빵"]}, row
    )
    assert reason is None
    assert proposal["cuisine_tags"] == ["황남빵"]


# ---------------------------------------------------------------------------
# merge_tagging — features 병합 무손실(③) + fill-missing(기존 값 보존)
# ---------------------------------------------------------------------------
def test_merge_tagging_preserves_existing_feature_keys():
    # ③ 기존 키(overview_i18n·kakao_place_id 등) 무손실 — ed690df 통째 교체 사고 회귀 방지
    features = {
        "first_menu": "삼겹살", "overview_i18n": {"en": "..."}, "kakao_place_id": "123",
    }
    merged = tag_cuisines.merge_tagging(
        features, {"category": "고깃집", "cuisine_tags": ["삼겹살"]}, "2026-07-18T00:00:00+00:00"
    )
    assert merged["first_menu"] == "삼겹살"
    assert merged["overview_i18n"] == {"en": "..."}
    assert merged["kakao_place_id"] == "123"
    assert merged["cuisine_tags"] == ["삼겹살"]
    assert merged["category"] == "고깃집"
    assert merged["tagging_source"] == {"source": "solar", "tagged_at": "2026-07-18T00:00:00+00:00"}
    # 원본 dict 는 변형하지 않는다(방어적 복사)
    assert "category" not in features


def test_merge_tagging_does_not_overwrite_existing_values():
    # fill-missing 계약: 이미 채워진 category 는 보존, 결손인 cuisine_tags 만 채운다
    features = {"category": "중식", "cuisine_tags": []}
    merged = tag_cuisines.merge_tagging(
        features, {"category": "한식", "cuisine_tags": ["짜장면"]}, "t"
    )
    assert merged["category"] == "중식"  # 기존 값 유지(제안 "한식"으로 덮지 않음)
    assert merged["cuisine_tags"] == ["짜장면"]


def test_merge_tagging_handles_missing_features():
    merged = tag_cuisines.merge_tagging(None, {"category": "카페", "cuisine_tags": ["라떼"]}, "t")
    assert merged["category"] == "카페"
    assert merged["cuisine_tags"] == ["라떼"]
    assert merged["tagging_source"]["source"] == "solar"


# ---------------------------------------------------------------------------
# propose_tags — 시설당 1콜, LLM 실패 시 1회 재시도 후 skip
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_propose_tags_retries_once_then_succeeds():
    row = {"id": "f1", "name": "황남숯불", "type": "restaurant", "features": {"first_menu": "삼겹살"}}
    mock = AsyncMock(side_effect=[None, {"category": "고깃집", "cuisine_tags": ["삼겹살"]}])
    with patch.object(tag_cuisines.llm_client, "chat_json", new=mock):
        proposal, reason = await tag_cuisines.propose_tags(row)
    assert reason is None
    assert proposal == {"category": "고깃집", "cuisine_tags": ["삼겹살"]}
    assert mock.await_count == 2  # 실패 1회 + 재시도 1회


@pytest.mark.asyncio
async def test_propose_tags_skips_after_retry_exhausted():
    row = {"id": "f1", "name": "가게", "type": "restaurant", "features": {}}
    mock = AsyncMock(return_value=None)
    with patch.object(tag_cuisines.llm_client, "chat_json", new=mock):
        proposal, reason = await tag_cuisines.propose_tags(row)
    assert proposal is None
    assert reason == tag_cuisines.SKIP_LLM_FAILED
    assert mock.await_count == 2  # 재시도는 정확히 1회(시설당 최대 2콜)


@pytest.mark.asyncio
async def test_propose_tags_does_not_retry_validation_failure():
    # 형식 위반은 일시 장애가 아니다 — 재호출 없이 즉시 skip(레이트 보호)
    row = {"id": "f1", "name": "가게", "type": "restaurant", "features": {}}
    mock = AsyncMock(return_value={"category": "이탈리안", "cuisine_tags": ["pasta"]})
    with patch.object(tag_cuisines.llm_client, "chat_json", new=mock):
        proposal, reason = await tag_cuisines.propose_tags(row)
    assert proposal is None
    assert reason == tag_cuisines.SKIP_INVALID_CATEGORY
    assert mock.await_count == 1


# ---------------------------------------------------------------------------
# build_prompt — 제공 텍스트만 근거(지어내기 금지) + 화이트리스트 동봉
# ---------------------------------------------------------------------------
def test_build_prompt_includes_whitelist_and_grounding_instruction():
    row = {
        "id": "f1", "name": "황남숯불", "type": "restaurant",
        "features": {"first_menu": "삼겹살", "treat_menu": "목살 / 항정살", "cuisine": "육류,고기"},
    }
    system, user = tag_cuisines.build_prompt(row)
    for category in _INTENT_CATEGORIES:
        assert category in system  # 화이트리스트 전체를 프롬프트에 제시
    assert "지어내지" in system  # 근거 텍스트 밖 정보 금지 지시
    assert "황남숯불" in user
    assert "삼겹살" in user and "목살 / 항정살" in user and "육류,고기" in user


def test_build_prompt_omits_blank_menu_lines():
    row = {"id": "f1", "name": "카페능", "type": "cafe", "features": {"first_menu": "  ", "treat_menu": None}}
    _, user = tag_cuisines.build_prompt(row)
    assert "대표 메뉴" not in user
    assert "취급 메뉴" not in user


# ---------------------------------------------------------------------------
# run — dry-run 무쓰기(⑤) / apply 병합 반영 / skip 사유 보고서 기록
# ---------------------------------------------------------------------------
_ROWS = [
    {"id": "f1", "name": "황남숯불", "type": "restaurant", "features": {"first_menu": "삼겹살"}},
    {"id": "f2", "name": "이미태깅", "type": "restaurant",
     "features": {"cuisine_tags": ["국밥"], "category": "국밥집"}},  # fill-missing 제외 대상
]


@pytest.mark.asyncio
async def test_run_dry_run_writes_report_but_never_db(tmp_path):
    # ⑤ dry-run(기본): LLM 제안·보고서 저장은 수행하되 DB 쓰기는 0회
    chat = AsyncMock(return_value={"category": "고깃집", "cuisine_tags": ["삼겹살"]})
    with patch.object(tag_cuisines, "fetch_candidate_rows", return_value=list(_ROWS)), \
         patch.object(tag_cuisines.llm_client, "chat_json", new=chat), \
         patch.object(tag_cuisines.llm_client, "is_enabled", return_value=True), \
         patch.object(tag_cuisines, "apply_update") as apply_mock:
        code = await tag_cuisines.run(_args(tmp_path))
    assert code == 0
    apply_mock.assert_not_called()  # DB 쓰기 0회
    assert chat.await_count == 1  # 결손 시설(f1)만 호출 — 이미 태깅된 f2 는 LLM 도 안 탄다
    report = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert report["mode"] == "dry-run"
    assert report["targets"] == 1 and report["proposed"] == 1 and report["applied"] == 0
    assert report["facilities"][0]["status"] == "proposed"
    assert report["facilities"][0]["category"] == "고깃집"


@pytest.mark.asyncio
async def test_run_apply_merges_without_losing_existing_keys(tmp_path):
    rows = [{
        "id": "f1", "name": "황남숯불", "type": "restaurant",
        "features": {"first_menu": "삼겹살", "overview_i18n": {"en": "x"}},
    }]
    chat = AsyncMock(return_value={"category": "고깃집", "cuisine_tags": ["삼겹살"]})
    with patch.object(tag_cuisines, "fetch_candidate_rows", return_value=rows), \
         patch.object(tag_cuisines.llm_client, "chat_json", new=chat), \
         patch.object(tag_cuisines.llm_client, "is_enabled", return_value=True), \
         patch.object(tag_cuisines, "apply_update") as apply_mock:
        code = await tag_cuisines.run(_args(tmp_path, apply=True))
    assert code == 0
    apply_mock.assert_called_once()
    facility_id, merged = apply_mock.call_args.args
    assert facility_id == "f1"
    # 병합 무손실: 기존 키 보존 + 신규 태깅 키 + 출처 기록
    assert merged["first_menu"] == "삼겹살"
    assert merged["overview_i18n"] == {"en": "x"}
    assert merged["cuisine_tags"] == ["삼겹살"]
    assert merged["category"] == "고깃집"
    assert merged["tagging_source"]["source"] == "solar"
    report = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert report["mode"] == "apply"
    assert report["facilities"][0]["status"] == "applied"


@pytest.mark.asyncio
async def test_run_records_skip_reason_and_keeps_going(tmp_path):
    rows = [
        {"id": "f1", "name": "화이트리스트밖", "type": "restaurant", "features": {}},
        {"id": "f2", "name": "정상", "type": "restaurant", "features": {}},
    ]

    async def fake_chat(system, user, *, max_tokens=200, timeout=None):
        if "화이트리스트밖" in user:
            return {"category": "이탈리안", "cuisine_tags": ["파스타"]}  # ① 게이트 실패 → skip
        return {"category": "한식", "cuisine_tags": ["비빔밥"]}

    with patch.object(tag_cuisines, "fetch_candidate_rows", return_value=rows), \
         patch.object(tag_cuisines.llm_client, "chat_json", new=AsyncMock(side_effect=fake_chat)), \
         patch.object(tag_cuisines.llm_client, "is_enabled", return_value=True), \
         patch.object(tag_cuisines, "apply_update") as apply_mock:
        code = await tag_cuisines.run(_args(tmp_path, apply=True))
    assert code == 0
    apply_mock.assert_called_once()  # skip 시설은 쓰지 않고 나머지는 계속(부분 성공)
    report = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    by_id = {f["id"]: f for f in report["facilities"]}
    assert by_id["f1"]["status"] == "skip"
    assert by_id["f1"]["reason"] == tag_cuisines.SKIP_INVALID_CATEGORY
    assert by_id["f2"]["status"] == "applied"
    assert report["skipped"] == 1 and report["applied"] == 1


@pytest.mark.asyncio
async def test_run_limit_caps_targets(tmp_path):
    rows = [
        {"id": f"f{i}", "name": f"가게{i}", "type": "restaurant", "features": {}} for i in range(5)
    ]
    chat = AsyncMock(return_value={"category": "한식", "cuisine_tags": ["비빔밥"]})
    with patch.object(tag_cuisines, "fetch_candidate_rows", return_value=rows), \
         patch.object(tag_cuisines.llm_client, "chat_json", new=chat), \
         patch.object(tag_cuisines.llm_client, "is_enabled", return_value=True), \
         patch.object(tag_cuisines, "apply_update"):
        code = await tag_cuisines.run(_args(tmp_path, limit=2))
    assert code == 0
    assert chat.await_count == 2  # --limit N 부분 실행


@pytest.mark.asyncio
async def test_run_llm_disabled_exits_quietly_without_calls(tmp_path):
    # 무해 폴백 원칙 — 키 미설정은 오류가 아니라 조용한 스킵(LLM/DB 무접촉)
    chat = AsyncMock()
    with patch.object(tag_cuisines, "fetch_candidate_rows", return_value=list(_ROWS)), \
         patch.object(tag_cuisines.llm_client, "chat_json", new=chat), \
         patch.object(tag_cuisines.llm_client, "is_enabled", return_value=False), \
         patch.object(tag_cuisines, "apply_update") as apply_mock:
        code = await tag_cuisines.run(_args(tmp_path))
    assert code == 0
    chat.assert_not_awaited()
    apply_mock.assert_not_called()
