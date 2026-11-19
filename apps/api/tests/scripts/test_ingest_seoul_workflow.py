"""서울 적재 워크플로(.github/workflows/ingest-seoul.yml) 계약 — 수동 전용 · 별도 동시성 · 미리보기 기본."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
WORKFLOW = ROOT / ".github" / "workflows" / "ingest-seoul.yml"
GYEONGJU = ROOT / ".github" / "workflows" / "ingest.yml"
GUARD = ROOT / ".github" / "workflows" / "region-guard.yml"


def _text() -> str:
    return WORKFLOW.read_text(encoding="utf-8")


def _yaml() -> dict:
    yaml = pytest.importorskip("yaml")
    return yaml.safe_load(_text())


def test_text_contract_holds_without_pyyaml():
    """PyYAML 이 없는 CI 에서도 도는 글자 계약 — 스케줄 없음 · 별도 동시성 그룹 · 미리보기 기본."""
    text = _text()
    assert not re.search(r"^\s*schedule\s*:", text, re.M)
    assert re.search(r"^\s*group:\s*tourapi-ingest-seoul\s*$", text, re.M)
    assert not re.search(r"^\s*group:\s*tourapi-ingest\s*$", text, re.M)
    dry_run = text.split("dry_run:", 1)[1].split("details_budget:", 1)[0]
    assert re.search(r"default:\s*'true'", dry_run)
    assert "scripts/map_facility_zones.py --apply --sync-geometry" in text


def test_workflow_has_no_schedule():
    text = _text()
    assert not re.search(r"^\s*schedule\s*:", text, re.M)
    assert "cron" not in text
    triggers = _yaml().get(True) or _yaml().get("on")  # PyYAML 은 'on' 을 True 로 읽는다
    assert set(triggers) == {"workflow_dispatch"}


def test_concurrency_is_separate_from_the_gyeongju_ingest():
    data = _yaml()
    group = data["concurrency"]["group"]
    assert group != "tourapi-ingest"
    assert group == "tourapi-ingest-seoul"
    assert data["concurrency"]["cancel-in-progress"] is False


def test_inputs_default_to_a_dry_run():
    inputs = (_yaml().get(True) or _yaml().get("on"))["workflow_dispatch"]["inputs"]
    assert inputs["dry_run"]["default"] == "true"
    assert inputs["details_budget"]["default"] == "400"
    assert inputs["clusters"]["default"] == "all"
    assert inputs["map_zones"]["default"] is True
    assert inputs["reactivate"]["default"] is False


def test_steps_run_ingest_then_mapping_only_when_applying():
    steps = _yaml()["jobs"]["ingest"]["steps"]
    runs = [s.get("run", "") for s in steps]
    ingest = next(s for s in steps if "ingest_tourapi_seoul.py" in s.get("run", ""))
    mapping = next(s for s in steps if "map_facility_zones.py" in s.get("run", ""))
    assert steps.index(ingest) < steps.index(mapping)
    assert "--apply --sync-geometry" in mapping["run"]
    assert "dry_run == 'false'" in mapping["if"]
    assert "--reactivate" in ingest["run"]
    assert not any("ingest_tourapi.py" in r for r in runs)  # 경주 일배치는 부르지 않는다


def test_inputs_reach_shell_only_through_env():
    for step in _yaml()["jobs"]["ingest"]["steps"]:
        assert "${{ inputs." not in step.get("run", ""), step.get("name")


def test_secrets_and_no_kakao():
    text = _text()
    for name in ("TOURAPI_KEY", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
                 "REGION_PROBE_TOURIST_EMAIL", "REGION_PROBE_TOURIST_PASSWORD"):
        assert f"secrets.{name}" in text
    assert "vars.BACKEND_HEALTH_URL" in text
    assert "KAKAO" not in text.upper().replace("KAKAO 키는 쓰지 않는다", "")


def test_region_guard_recovery_note_points_at_this_input():
    """region-guard.yml 머리말의 복구 안내(reactivate=true)가 실제 입력과 맞는다."""
    assert "reactivate=true" in GUARD.read_text(encoding="utf-8")
    assert "reactivate" in (_yaml().get(True) or _yaml().get("on"))["workflow_dispatch"]["inputs"]


def test_gyeongju_ingest_workflow_is_unchanged_in_shape():
    text = GYEONGJU.read_text(encoding="utf-8")
    assert "group: tourapi-ingest\n" in text
    assert "ingest_tourapi_seoul" not in text
