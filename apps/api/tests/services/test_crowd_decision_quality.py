"""결정 품질 요약 읽기(crowd/decision_quality.py) — 커밋된 S4 재생 요약만, 틀리면 숫자 없이 이유만.

유효한 요약은 손으로 만들지 않는다 — WP1 재생(`build_decision_quality_summary`)을 합성 반출 하나에 실제로 돌려 얻는다.
그래야 재생 산출물의 모양이 바뀌었을 때 화면 쪽 검사기가 함께 깨진다(두 모듈은 서로 import 하지 않는다).
"""

from __future__ import annotations

import ast
import copy
import json
from pathlib import Path

import pytest

from app.services.crowd import decision_quality as dq


@pytest.fixture(scope="module")
def hongdae_summary(tmp_path_factory) -> dict:
    from app.services.batch import crowd_dispersion_replay as replay
    from app.services.batch.crowd_dispersion_replay import ReplayConfig
    from app.services.batch.crowd_replay_data import load_replay_inputs
    from scripts.crowd_dispersion_replay import discover, read_csv
    from tests.fixtures.crowd_replay.synthetic import write_export

    folder = tmp_path_factory.mktemp("hongdae_export")
    write_export(folder, "hongdae", days=2)
    found = discover(folder)
    data = load_replay_inputs(
        "hongdae", observations=[read_csv(p) for p in found["obs"]], forecasts=[read_csv(p) for p in found["fcst"]],
        counts=read_csv(found["counts"]),
    )
    report, _ = replay.run_replay(data, ReplayConfig(cluster="hongdae", code_version="test", sensitivity=False))
    summary = replay.build_decision_quality_summary(report)
    assert summary["schema_version"] == dq.SCHEMA_VERSION, "재생 쪽 스키마 버전과 화면 쪽 상수가 같아야 한다"
    return summary


def _write(folder: Path, name: str, payload) -> Path:
    path = folder / name
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    path.write_text(text, encoding="utf-8")
    return path


def _as(summary: dict, cluster: str) -> dict:
    other = copy.deepcopy(summary)
    other["cluster"] = cluster
    return other


# ── 없음 · 정상 ────────────────────────────────────────────────────────────────


def test_empty_dir_is_exactly_the_old_constant(tmp_path):
    assert dq.load_decision_quality(tmp_path) == {
        "state": "not_evaluated",
        "stage": "S4",
        "criterion": (
            "V3 — 붐비는 출발지에서 대안이 2곳 이상인 결정에서, 추천지가 도착 시 1단계 이상 덜 붐빌 확률이 "
            "'가장 가까운 곳' 기준선보다 10%p 이상 높고, 그 차의 판정 하한(일 블록 부트스트랩 95% 하한과 날짜 군집 t "
            "95% 하한 중 작은 쪽) > 0"
        ),
        "result": None,
    }


def test_missing_dir_and_non_json_files_are_not_evaluated(tmp_path):
    assert dq.load_decision_quality(tmp_path / "nope")["state"] == "not_evaluated"
    (tmp_path / "README.md").write_text("# 설명", encoding="utf-8")
    (tmp_path / "sub").mkdir()
    _write(tmp_path / "sub", "hongdae.json", "{broken")  # 하위 폴더는 보지 않는다
    assert dq.load_decision_quality(tmp_path) == dq.NOT_EVALUATED


def test_returned_constant_is_a_copy(tmp_path):
    block = dq.load_decision_quality(tmp_path)
    block["state"] = "mutated"
    assert dq.NOT_EVALUATED["state"] == "not_evaluated"


def test_committed_folder_has_no_summary_yet_or_only_valid_ones():
    # 저장소에 커밋된 폴더 자체도 검사를 통과해야 한다(README 만 있으면 not_evaluated).
    assert dq.load_decision_quality()["state"] in {"not_evaluated", "evaluated"}


def test_valid_replay_summary_is_evaluated(tmp_path, hongdae_summary):
    _write(tmp_path, "hongdae.json", hongdae_summary)
    block = dq.load_decision_quality(tmp_path)
    assert block["state"] == "evaluated" and block["stage"] == "S4"
    assert block["criterion"] == dq.CRITERION
    assert block["result"]["schema_version"] == "decision_quality_summary/3"
    assert block["result"]["clusters"] == [hongdae_summary]
    assert "reason" not in block


def test_two_clusters_are_sorted(tmp_path, hongdae_summary):
    jongno = _as(hongdae_summary, "jongno")
    jongno["thin_cluster"] = False
    _write(tmp_path, "jongno.json", jongno)
    _write(tmp_path, "hongdae.json", hongdae_summary)
    clusters = dq.load_decision_quality(tmp_path)["result"]["clusters"]
    assert [c["cluster"] for c in clusters] == ["hongdae", "jongno"]


def test_null_rates_are_allowed(tmp_path, hongdae_summary):
    # 표본이 없으면 재생이 비율을 null 로 쓴다 — 0% 로 바꾸지 않고 그대로 싣는다.
    summary = copy.deepcopy(hongdae_summary)
    summary["hit_rate"]["engine"] = None
    summary["verdicts"]["V3"].update(diff=None, ci_low=None, ci_high=None, ci_label=None)
    _write(tmp_path, "hongdae.json", summary)
    assert dq.load_decision_quality(tmp_path)["state"] == "evaluated"


# ── 틀린 파일 → invalid_summary ──────────────────────────────────────────────────


def _mutate(summary: dict, fn) -> dict:
    other = copy.deepcopy(summary)
    fn(other)
    return other


INVALID_CASES = {
    "wrong_schema": (lambda s: s.update(schema_version="decision_quality_summary/1"), "schema_version"),
    "rate_above_one": (lambda s: s["hit_rate"].update(engine=1.2), "hit_rate.engine"),
    "negative_rate": (lambda s: s.update(opportunity_rate=-0.1), "opportunity_rate"),
    "bad_status": (lambda s: s["verdicts"]["V3"].update(status="passed"), "verdicts.V3.status"),
    "bad_run_label": (lambda s: s.update(run_label="final"), "run_label"),
    "bad_ci_label": (lambda s: s["verdicts"]["V3"].update(ci_label="bca"), "ci_label"),
    "bad_recommendation": (lambda s: s["verdicts"]["V4"].update(recommendation="ours"), "recommendation"),
    "diff_out_of_range": (lambda s: s["contrasts"]["engine_minus_greedy"].update(diff=1.5), "engine_minus_greedy"),
    "long_array": (lambda s: s.update(zones=[f"z{i}" for i in range(500)]), "배열"),
    "rows_payload": (lambda s: s.update(decisions=[{"t": i} for i in range(20)]), "배열"),
    "unknown_key": (lambda s: s.update(per_decision={"a": 1}), "모르는 필드"),
    "missing_key": (lambda s: s.pop("limits"), "필드가 없다"),
    "too_many_notes": (lambda s: s.update(notes=[f"n{i}" for i in range(9)]), "notes"),
    "limits_first_not_no_users": (lambda s: s.update(limits=list(reversed(s["limits"]))), "limits[0]"),
    "forbidden_word": (lambda s: s["notes"].append("분산 효과가 컸다"), "표현"),
    "bool_as_count": (lambda s: s.update(n_decisions=True), "n_decisions"),
    "attainable_not_bool": (lambda s: s["verdicts"]["V3"].update(criterion_attainable="no"), "criterion_attainable"),
    "missing_n_distinct": (lambda s: s["verdicts"]["V3"].pop("n_distinct"), "n_distinct"),
    "distinct_above_n": (lambda s: s["verdicts"]["V3"].update(n_distinct=s["verdicts"]["V3"]["n"] + 1), "서로 다른"),
    "disagree_distinct_not_int": (lambda s: s["verdicts"]["V3"].update(n_disagree_distinct=1.5), "n_disagree_distinct"),
    "unknown_cluster": (lambda s: s.update(cluster="gangnam"), "cluster"),
    "old_schema_2": (lambda s: s.update(schema_version="decision_quality_summary/2"), "schema_version"),
    "missing_gate_low": (lambda s: s["verdicts"]["V3"].pop("gate_low"), "gate_low"),
    "gate_low_not_number": (lambda s: s["verdicts"]["V3"].update(gate_low="0.1"), "gate_low"),
    "fail_without_reason": (lambda s: s["verdicts"]["V3"].update(status="fail", reason=None), "reason"),
}


@pytest.mark.parametrize("case", sorted(INVALID_CASES))
def test_invalid_summary_cases(tmp_path, hongdae_summary, case):
    mutate, needle = INVALID_CASES[case]
    summary = _mutate(hongdae_summary, mutate)
    stem = summary["cluster"] if case == "unknown_cluster" else "hongdae"
    _write(tmp_path, f"{stem}.json", summary)
    block = dq.load_decision_quality(tmp_path)
    assert block["state"] == "invalid_summary", case
    assert block["result"] is None
    assert block["reason"].startswith(f"{stem}.json: ")
    assert needle in block["reason"], block["reason"]


def test_malformed_json(tmp_path):
    _write(tmp_path, "hongdae.json", '{"schema_version": "decision_quality_summary/3",')
    block = dq.load_decision_quality(tmp_path)
    assert block["state"] == "invalid_summary" and "JSON 형식 오류" in block["reason"]


def test_nan_is_rejected(tmp_path, hongdae_summary):
    text = json.dumps(hongdae_summary, ensure_ascii=False).replace('"headroom": ', '"headroom": NaN, "x": ', 1)
    _write(tmp_path, "hongdae.json", text)
    block = dq.load_decision_quality(tmp_path)
    assert block["state"] == "invalid_summary" and "NaN" in block["reason"]


def test_oversized_file_is_not_parsed(tmp_path, hongdae_summary):
    summary = copy.deepcopy(hongdae_summary)
    summary["notes"] = ["가" * 590] * 8  # 문자열 하나하나는 허용 길이 안 — 파일 전체가 16KB 를 넘는다
    path = _write(tmp_path, "hongdae.json", summary)
    assert path.stat().st_size > 16 * 1024
    block = dq.load_decision_quality(tmp_path)
    assert block["state"] == "invalid_summary" and "16KB" in block["reason"]


def test_twenty_kb_padding_is_rejected(tmp_path, hongdae_summary):
    text = json.dumps(hongdae_summary, ensure_ascii=False) + " " * (20 * 1024)
    _write(tmp_path, "hongdae.json", text)
    assert dq.load_decision_quality(tmp_path)["state"] == "invalid_summary"


def test_stem_must_equal_cluster(tmp_path, hongdae_summary):
    _write(tmp_path, "hongdae_v2.json", hongdae_summary)
    block = dq.load_decision_quality(tmp_path)
    assert block["state"] == "invalid_summary"
    assert block["reason"].startswith("hongdae_v2.json: ") and "파일 이름" in block["reason"]


def test_duplicate_cluster_is_rejected(tmp_path, hongdae_summary):
    first = _write(tmp_path, "hongdae.json", hongdae_summary)
    (tmp_path / "copy").mkdir()
    second = _write(tmp_path / "copy", "hongdae.json", hongdae_summary)
    block = dq.load_decision_quality_files([first, second])
    assert block["state"] == "invalid_summary" and "둘 이상" in block["reason"]


def test_one_bad_file_hides_the_good_ones(tmp_path, hongdae_summary):
    # 일부만 보이면 "홍대만 평가됐다" 로 읽힌다 — 하나라도 틀리면 숫자를 하나도 싣지 않는다.
    _write(tmp_path, "hongdae.json", hongdae_summary)
    _write(tmp_path, "jongno.json", _mutate(_as(hongdae_summary, "jongno"), lambda s: s.update(headroom=3)))
    block = dq.load_decision_quality(tmp_path)
    assert block["state"] == "invalid_summary" and block["reason"].startswith("jongno.json: ")


def test_invalid_summary_logs_a_warning(tmp_path, monkeypatch):
    seen = []
    monkeypatch.setattr(dq.logger, "warning", lambda event, **kw: seen.append((event, kw)))
    _write(tmp_path, "hongdae.json", "[]")
    dq.load_decision_quality(tmp_path)
    assert seen and seen[0][0] == "decision_quality_summary_invalid" and seen[0][1]["file"] == "hongdae.json"


def test_module_does_not_import_batch():
    source = Path(dq.__file__).read_text(encoding="utf-8")
    modules = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            modules += [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            modules.append(node.module or "")
    assert not [m for m in modules if "batch" in m], modules
