"""scripts/crowd_dispersion_replay.py — 반출 SQL(읽기 전용) · 실행 · 기준 해시 · 오프라인 · 결정성 · 경로 가드 · 종로 재실행."""

from __future__ import annotations

import json
import re
import shutil
import socket
from datetime import timedelta
from pathlib import Path

import pytest

from app.services.batch import crowd_dispersion_replay as replay
from app.services.batch import crowd_replay_data as data_mod
from scripts import crowd_dispersion_replay as cli
from tests.fixtures.crowd_replay.synthetic import write_export

FORBIDDEN_SQL = re.compile(
    r"\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|call|do|vacuum|set|merge)\b", re.IGNORECASE
)
REPO = Path(__file__).resolve().parents[4]


def _blocks(text: str) -> dict[str, str]:
    """'-- ===== Q… → 파일 =====' 머리줄로 나눈다 → {머리줄: SQL}."""
    out: dict[str, str] = {}
    current = None
    for line in text.splitlines():
        if line.startswith("-- ===== "):
            current = line
            out[current] = ""
        elif current is not None:
            out[current] += line + "\n"
    return out


def _select_aliases(sql: str) -> list[str]:
    start = [m.start() for m in re.finditer(r"^SELECT ", sql, re.MULTILINE)][-1]  # 바깥 SELECT(하위 질의 말고)
    body = sql[start:sql.index("\nFROM ", start)]
    aliases = []
    for line in body.splitlines():
        line = line.strip().rstrip(",")
        match = re.search(r"\bAS (\w+)$", line) or re.search(r"\b[szo]\.(\w+)$", line.replace("z.", "s."))
        if match:
            aliases.append(match.group(1))
    return aliases


def _sql(capsys, *args) -> tuple[int, str, str]:
    code = cli.main(["sql", *args])
    out, err = capsys.readouterr()
    return code, out, err


# ── SQL ───────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("cluster", ["hongdae", "jongno"])
def test_sql_is_select_only_and_names_the_cluster_sites(capsys, cluster):
    code, out, _ = _sql(capsys, "--cluster", cluster, "--from", "2026-09-20", "--to", "2026-10-01")
    assert code == 0
    assert not FORBIDDEN_SQL.search(out), FORBIDDEN_SQL.search(out)
    zones = data_mod.cluster_zones(cluster)
    blocks = _blocks(out)
    for header, sql in blocks.items():
        statement = "\n".join(line for line in sql.splitlines() if not line.strip().startswith("--")).strip()
        assert statement.startswith("WITH params AS"), header
        assert statement.count(";") == 1 and statement.endswith(";"), header
        assert "SELECT" in statement
    q0 = next(sql for h, sql in blocks.items() if "Q0" in h)
    for zone in zones:
        assert f"'{zone.name}'" in q0
    q3_count = next(sql for h, sql in blocks.items() if "Q3-count" in h)
    assert sorted(re.findall(r"'(seoul:POI\d+)'", q3_count)) == sorted(z.zone_id for z in zones)
    q3s = [sql for h, sql in blocks.items() if "Q3(" in h]
    assert len(q3s) == len(zones)  # 구역마다 하나(조각으로 나뉠 수 있다)
    assert sorted(z for sql in q3s for z in re.findall(r"'(seoul:POI\d+)'", sql)) == sorted(z.zone_id for z in zones)
    q1s = [h for h in blocks if "Q1" in h]
    assert len(q1s) == len(zones)  # 대상지마다 하나
    # 다른 권역 대상지 이름은 없다
    others = [z.name for c in data_mod.cluster_names() if c != cluster for z in data_mod.cluster_zones(c)]
    assert not any(f"'{name}'" in out for name in others)


def test_sql_column_aliases_match_the_loader(capsys):
    _, out, _ = _sql(capsys, "--cluster", "hongdae", "--from", "2026-09-20", "--to", "2026-10-01")
    blocks = _blocks(out)
    q0 = next(sql for h, sql in blocks.items() if "Q0" in h)
    q1 = next(sql for h, sql in blocks.items() if "Q1" in h)
    q2 = next(sql for h, sql in blocks.items() if "Q2" in h)
    q3 = next(sql for h, sql in blocks.items() if "Q3(" in h)
    q3_count = next(sql for h, sql in blocks.items() if "Q3-count" in h)
    assert _select_aliases(q3_count) == list(data_mod.REQUIRED_REPLACED_COUNTS_COLUMNS)
    assert _select_aliases(q0) == list(data_mod.REQUIRED_COUNTS_COLUMNS)
    assert _select_aliases(q1) == list(data_mod.REQUIRED_OBS_COLUMNS)
    assert _select_aliases(q2) == list(data_mod.REQUIRED_FCST_COLUMNS)
    assert _select_aliases(q3) == list(data_mod.REQUIRED_REPLACED_COLUMNS)


def test_q0_and_q2_share_the_forecast_filter():
    from datetime import date

    q0 = cli.sql_q0(["연남동"], date(2026, 9, 20), date(2026, 10, 1))
    q2 = cli.sql_q2("연남동", date(2026, 9, 20), date(2026, 10, 1))
    for text in (cli.FCST_LATERAL, cli.FCST_FILTER):
        assert text in q0 and text in q2


def test_sql_refuses_unfinished_days_and_chunks_by_date(capsys, monkeypatch):
    today = cli.today_kst()
    code, _, err = _sql(capsys, "--cluster", "hongdae", "--from", "2026-09-20",
                        "--to", (today + timedelta(days=1)).isoformat())
    assert code != 0 and "KST" in err
    code, out, _ = _sql(capsys, "--cluster", "hongdae", "--from", "2026-09-20", "--to", "2026-10-11",
                        "--site", "연남동", "--chunk-days", "10")
    assert code == 0
    headers = [h for h in _blocks(out) if "Q1" in h]
    assert headers == [
        "-- ===== Q1 → obs_연남동_2026-09-20_2026-09-30.csv =====",
        "-- ===== Q1 → obs_연남동_2026-09-30_2026-10-10.csv =====",
        "-- ===== Q1 → obs_연남동_2026-10-10_2026-10-11.csv =====",
    ]
    # Q3 도 같은 대상지·같은 조각으로 나뉜다(한 번에 전 구역·전 기간을 받다 잘리지 않게). 목록(Q3-count)은 권역 전체.
    assert [h for h in _blocks(out) if "Q3(" in h] == [
        "-- ===== Q3(선택) → replaced_연남동_2026-09-20_2026-09-30.csv =====",
        "-- ===== Q3(선택) → replaced_연남동_2026-09-30_2026-10-10.csv =====",
        "-- ===== Q3(선택) → replaced_연남동_2026-10-10_2026-10-11.csv =====",
    ]
    assert [h for h in _blocks(out) if "Q3-count" in h] == ["-- ===== Q3-count(선택) → counts_replaced.csv ====="]
    monkeypatch.setattr(cli, "today_kst", lambda: __import__("datetime").date(2026, 11, 1))
    code, out, _ = _sql(capsys, "--cluster", "hongdae", "--from", "2026-09-20")
    assert code == 0 and "TIMESTAMPTZ '2026-11-01 00:00:00+09' AS to_at" in out
    code, _, _ = _sql(capsys, "--cluster", "busan", "--from", "2026-09-20", "--to", "2026-10-01")
    assert code == 2


# ── 실행 ──────────────────────────────────────────────────────────────────────


def _export(tmp_path: Path, cluster="hongdae", **kw) -> Path:
    folder = tmp_path / cluster
    write_export(folder, cluster, **kw)
    return folder


def _run(folder: Path, *extra: str) -> int:
    return cli.main(["run", "--cluster", folder.name, "--data-dir", str(folder), "--code-version", "test", *extra])


def _read(folder: Path, name: str) -> str:
    return (folder / "out" / name).read_text(encoding="utf-8")


def test_run_writes_report_summary_and_decision_quality_offline(tmp_path):
    folder = _export(tmp_path, days=2)
    assert _run(folder, "--trace") == 0
    assert cli.LAST_NETWORK_ATTEMPTS == []  # 가드가 켜진 채로 끝까지 돌았고 바깥 연결 시도는 0회
    report = json.loads(_read(folder, "hongdae_replay_report.json"))
    assert report["run"]["run_label"] == "pilot"
    assert report["run"]["criteria_version"] == replay.criteria_version()
    assert report["run"]["code_version"] == "test"
    summary = json.loads(_read(folder, "decision_quality/hongdae.json"))
    assert summary["cluster"] == "hongdae" and summary["run_label"] == "pilot"
    assert len(json.dumps(summary, ensure_ascii=False).encode("utf-8")) <= 16 * 1024
    assert (folder / "out" / "hongdae_decisions_trace.csv").exists()
    assert "SUPABASE_URL" not in _read(folder, "hongdae_replay_report.json")


def test_deliberate_network_access_inside_a_run_is_blocked(tmp_path, monkeypatch):
    folder = _export(tmp_path, days=1)

    async def _phone_home(*_a, **_k):
        socket.create_connection(("203.0.113.10", 443), timeout=1)

    monkeypatch.setattr(replay.engine_mod, "rank_alternatives", _phone_home)
    with pytest.raises(cli.ReplayNetworkBlocked):
        _run(folder, "--no-sensitivity")
    assert cli.LAST_NETWORK_ATTEMPTS and cli.LAST_NETWORK_ATTEMPTS[0].startswith("create_connection")
    # 가드는 끝나면 풀린다
    assert socket.create_connection.__name__ == "create_connection" and "guard" not in repr(socket.getaddrinfo)


def test_guard_blocks_name_resolution_and_allows_loopback_only():
    with cli.network_guard() as attempts:
        with pytest.raises(cli.ReplayNetworkBlocked):
            socket.getaddrinfo("example.com", 443)
        with pytest.raises(cli.ReplayNetworkBlocked):
            socket.socket().connect(("198.51.100.1", 80))
        assert cli._is_loopback_literal("127.0.0.1") and cli._is_loopback_literal("::1")
    assert len(attempts) == 2


def test_env_is_forced_offline_during_run_and_restored(tmp_path, monkeypatch):
    seen = {}
    monkeypatch.setenv("SUPABASE_URL", "https://real-project.supabase.co")
    real = replay.run_replay

    def _spy(data, config, **kw):
        import os

        seen["url"] = os.environ["SUPABASE_URL"]
        seen["llm"] = os.environ["LLM_ENABLED"]
        return real(data, config, **kw)

    monkeypatch.setattr(replay, "run_replay", _spy)
    folder = _export(tmp_path, days=1)
    assert _run(folder, "--no-sensitivity") == 0
    assert seen == {"url": "https://replay-offline.invalid", "llm": "false"}
    import os

    assert os.environ["SUPABASE_URL"] == "https://real-project.supabase.co"


def test_criteria_hash_and_labels(tmp_path):
    folder = _export(tmp_path, days=1)
    assert _run(folder, "--expect-criteria", "000000000000", "--no-sensitivity") == 4
    assert _run(folder, "--label", "confirmatory", "--expect-criteria", replay.criteria_version(),
                "--detour", "1.3", "--no-sensitivity") == 4
    assert _run(folder, "--detour", "1.3", "--no-sensitivity") == 0
    report = json.loads(_read(folder, "hongdae_replay_report.json"))
    assert report["run"]["run_label"] == "exploratory" and report["run"]["overrides"] == ["detour=1.3"]
    assert _run(folder, "--no-forecast", "--no-sensitivity") == 0
    report = json.loads(_read(folder, "hongdae_replay_report.json"))
    assert report["run"]["run_label"] == "exploratory"
    assert report["verdicts"]["V3"]["status"] == "insufficient"
    assert _run(folder, "--detour", "3.0", "--no-sensitivity") == 2  # 최대 이동 > 60분


def test_input_problems_exit_2_and_list_everything(tmp_path, capsys):
    folder = _export(tmp_path, days=1)
    counts = (folder / "counts.csv").read_text(encoding="utf-8").splitlines()
    (folder / "counts.csv").write_text("\n".join(counts[:-1]) + "\n", encoding="utf-8")  # 대상지 하나 빠짐
    obs = sorted(folder.glob("obs_*.csv"))[0]
    lines = obs.read_text(encoding="utf-8").splitlines()
    lines[2] = lines[2].replace("붐빔", "아주 붐빔").replace("여유", "아주 여유").replace("보통", "아주 보통")
    obs.write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert _run(folder, "--no-sensitivity") == 2
    err = capsys.readouterr().err
    assert "export_truncated_or_partial" in err and "invalid_congest_lvl" in err and f"{obs.name}:3" in err


def _mangle_short(line: str) -> str:
    return ",".join(line.split(",")[:-2])  # 끝 두 칸이 빠졌다


def _mangle_long(line: str) -> str:
    return line + ",EXTRA,MORE"


def _mangle_cut_last_line(text: str) -> str:
    # 내려받기가 마지막 줄 가운데서 끊겼다 — 끝에서 두 번째 칸이 앞 두 글자만 남고 마지막 칸이 없다.
    body = text.rstrip("\n").split("\n")
    cells = body[-1].split(",")
    body[-1] = ",".join(cells[:-2] + [cells[-2][:2]])
    return "\n".join(body)


@pytest.mark.parametrize(
    "kind", ["short_obs_row", "long_obs_row", "cut_last_obs_line", "short_fcst_row", "short_counts_row"],
)
def test_rows_with_the_wrong_number_of_cells_exit_2(tmp_path, capsys, kind):
    """칸 수가 머리줄과 다른 행을 빈 칸(NULL)으로 메우거나 남는 칸을 버리지 않는다 — 실행이 2로 끝난다(S4 검토 2차)."""
    folder = _export(tmp_path, days=1)
    if kind == "short_counts_row":
        target = folder / "counts.csv"
    elif kind == "short_fcst_row":
        target = sorted(folder.glob("fcst_*.csv"))[0]
    else:
        target = sorted(folder.glob("obs_*.csv"))[0]
    text = target.read_text(encoding="utf-8")
    if kind == "cut_last_obs_line":
        text = _mangle_cut_last_line(text)
        line_no = len(text.split("\n"))
    else:
        lines = text.splitlines()
        lines[2] = _mangle_long(lines[2]) if kind == "long_obs_row" else _mangle_short(lines[2])
        text = "\n".join(lines) + "\n"
        line_no = 3
    target.write_text(text, encoding="utf-8")

    assert _run(folder, "--no-sensitivity") == 2
    err = capsys.readouterr().err
    assert "row_width_mismatch" in err and f"{target.name}:{line_no}" in err, err


def test_unreadable_csv_exits_2_with_file_and_line(tmp_path, capsys):
    """닫히지 않은 따옴표 — csv 모듈이 칸 한도 오류를 낸다. 추적(종료 1)이 아니라 입력 오류(종료 2)로 파일·줄을 말한다."""
    folder = _export(tmp_path, days=1)
    obs = sorted(folder.glob("obs_*.csv"))[0]
    lines = obs.read_text(encoding="utf-8").splitlines()
    cells = lines[4].split(",")
    lines[4] = ",".join([cells[0], '"' + cells[1]] + cells[2:])
    filler = ["x" * 200] * 800  # 닫히지 않은 칸이 파일 끝까지 이어져 칸 한도(131072자)를 넘게
    obs.write_text("\n".join(lines + filler) + "\n", encoding="utf-8")
    assert _run(folder, "--no-sensitivity") == 2
    err = capsys.readouterr().err
    assert "csv_parse_error" in err and f"{obs.name}:5" in err, err
    assert "Traceback" not in err


def test_code_version_marks_a_dirty_tree(monkeypatch):
    calls = []

    def fake_git(*args):
        calls.append(args)
        if args[0] == "rev-parse":
            return "abc1234\n"
        return " M apps/api/app/main.py\n" if dirty else ""

    monkeypatch.setattr(cli, "_git", fake_git)
    dirty = True
    assert cli.default_code_version() == "abc1234-dirty"
    dirty = False
    assert cli.default_code_version() == "abc1234"
    assert ("status", "--porcelain", "--", "apps/api") in calls


@pytest.mark.parametrize("dirty,expected", [([], None), (["apps/api/app/services/kst_calendar.py"], 4), (None, 4)])
def test_confirmatory_refuses_uncommitted_replay_sources(tmp_path, monkeypatch, capsys, dirty, expected):
    """확인 실행은 커밋된 재생 소스로만 — 고친 소스·추적 안 된 소스·git 으로 확인할 수 없는 트리는 종료 4."""
    monkeypatch.setattr(cli, "dirty_replay_sources", lambda: dirty)
    folder = _export(tmp_path, "jongno", days=1, cadence_minutes=30)
    code = _run(folder, "--label", "confirmatory", "--expect-criteria", replay.criteria_version())
    if expected is None:
        assert code == 0
        report = json.loads(_read(folder, "jongno_replay_report.json"))
        assert report["run"]["source_version"] == replay.source_version() and len(report["run"]["source_version"]) == 12
    else:
        assert code == expected
        assert "확인 실행(confirmatory)" in capsys.readouterr().err
    assert _run(folder, "--no-sensitivity") == 0, "예비 실행은 작업 트리 상태와 무관하다"


def test_confirmatory_refuses_no_sensitivity_and_names_git_failures(tmp_path, monkeypatch, capsys):
    folder = _export(tmp_path, "jongno", days=1, cadence_minutes=30)
    version = replay.criteria_version()
    monkeypatch.setattr(cli, "dirty_replay_sources", lambda: [])
    assert _run(folder, "--label", "confirmatory", "--expect-criteria", version, "--no-sensitivity") == 4
    assert "--no-sensitivity" in capsys.readouterr().err

    class Failed:
        returncode, stdout, stderr = 128, "", "fatal: not a git repository"

    monkeypatch.setattr(cli.subprocess, "run", lambda *a, **k: Failed())
    assert cli._git("status") is None and "fatal: not a git repository" in cli.LAST_GIT_ERROR[0]
    monkeypatch.undo()
    monkeypatch.setattr(cli.subprocess, "run", lambda *a, **k: Failed())
    assert _run(folder, "--label", "confirmatory", "--expect-criteria", version) == 4
    assert "fatal: not a git repository" in capsys.readouterr().err


def test_dirty_replay_sources_parses_porcelain(monkeypatch):
    seen = {}

    def fake_git(*args):
        seen["args"] = args
        return "?? apps/api/app/services/kst_calendar.py\n M apps/api/scripts/crowd_dispersion_replay.py\n"

    monkeypatch.setattr(cli, "_git", fake_git)
    assert cli.dirty_replay_sources() == [
        "apps/api/app/services/kst_calendar.py", "apps/api/scripts/crowd_dispersion_replay.py",
    ]
    assert "--untracked-files=all" in seen["args"]
    assert "apps/api/app" in seen["args"], "엔진 경로까지 — 재생 모듈만 깨끗해도 확인 실행은 안 된다"
    monkeypatch.setattr(cli, "_git", lambda *a: None)
    assert cli.dirty_replay_sources() is None


def test_read_csv_records_row_widths(tmp_path):
    path = tmp_path / "obs_x.csv"
    path.write_text("a,b,c\n1,2,3\n1,2\n1,2,3,4\n\n", encoding="utf-8")
    parsed = cli.read_csv(path)
    assert parsed.width_mismatches == ((3, 2), (4, 4))
    assert len(parsed.rows) == 3


def test_byte_identical_outputs_from_two_locations(tmp_path):
    first = _export(tmp_path / "a", days=2)
    second = tmp_path / "somewhere" / "else" / "hongdae"
    shutil.copytree(first, second)
    assert _run(first) == 0
    assert _run(second) == 0
    for name in ("hongdae_replay_report.json", "hongdae_replay_summary.md", "decision_quality/hongdae.json"):
        assert _read(first, name) == _read(second, name), name
    text = _read(first, "hongdae_replay_report.json")
    assert str(tmp_path) not in text and str(tmp_path).replace("\\", "\\\\") not in text
    report = json.loads(text)
    assert all("/" not in f["name"] and "\\" not in f["name"] for f in report["inputs"]["observation_files"])
    assert report["sensitivity"]["detour_1_18"] is not None


# ── 경로 가드 ─────────────────────────────────────────────────────────────────


def test_path_guard_refuses_repo_paths_outside_replay_data(tmp_path):
    inside = REPO / "apps" / "api" / "tests" / "fixtures" / "crowd_replay"
    assert cli.main(["run", "--cluster", "hongdae", "--data-dir", str(inside), "--out-dir", str(tmp_path / "o")]) == 3
    folder = _export(tmp_path, days=1)
    target = REPO / "apps" / "api" / "app" / "_replay_out_should_not_exist"
    assert cli.main(["run", "--cluster", "hongdae", "--data-dir", str(folder), "--out-dir", str(target)]) == 3
    assert not target.exists()


def test_path_guard_is_case_insensitive_on_windows_and_allows_replay_data(tmp_path):
    root = tmp_path / "Repo"
    (root / ".git").mkdir(parents=True)
    allowed = root / "apps" / "api" / ".replay-data" / "hongdae"
    assert cli.path_problem([allowed], allowed / "out", root=root) is None
    assert cli.path_problem([root / "docs"], tmp_path / "out", root=root) is not None
    assert cli.path_problem([tmp_path / "x"], root / "apps" / "api" / "app" / "o", root=root) is not None
    if cli.os.name == "nt":
        upper = Path(str(root / "APPS" / "API" / "APP" / "o").upper())
        assert cli.path_problem([tmp_path / "x"], upper, root=root) is not None
    assert cli.repo_root(Path(cli.__file__)) is not None


# ── 종로: 코드 변경 없이 재실행 ─────────────────────────────────────────────────


def test_jongno_rerun_needs_no_code_change(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "dirty_replay_sources", lambda: [])  # 커밋된 트리라고 본다(작업 트리 상태와 무관하게)
    folder = _export(tmp_path, "jongno", days=2, cadence_minutes=30)
    version = replay.criteria_version()
    assert _run(folder, "--label", "confirmatory", "--expect-criteria", version) == 0
    report = json.loads(_read(folder, "jongno_replay_report.json"))
    assert report["cluster"] == "jongno" and report["run"]["run_label"] == "confirmatory"
    assert set(report["decisions"]["by_phase"]) == {"0", "10", "20"}  # 0 = 출발지 행을 받은 시각, +30 은 없다
    assert report["decisions"]["skipped"].get("origin_not_current", 0) == 0, "주기 끝 시각의 구조적 탈락이 없다"
    assert report["sensitivity"]["detour_1_18"] is not None
    assert report["thin_cluster"]["flag"] is False and report["thin_cluster"]["alternatives_per_origin"] == 3
    assert all(z["truth_tolerance_minutes"] == 15.0 for z in report["zones"])
    assert report["v2"]["kendall_tau"] is None or isinstance(report["v2"]["kendall_tau"], dict)
    assert json.loads(_read(folder, "decision_quality/jongno.json"))["cluster"] == "jongno"
    assert _run(folder, "--label", "confirmatory", "--expect-criteria", "ffffffffffff") == 4
    assert _run(folder, "--label", "confirmatory", "--expect-criteria", version, "--no-sensitivity") == 4


def test_unreadable_csv_line_counts_blank_lines(tmp_path):
    """빈 줄을 건너뛴 뒤의 닫히지 않은 따옴표 — 줄 번호는 실제 파일 줄이다(빈 줄도 센다)."""
    path = tmp_path / "obs_x.csv"
    body = "a,b,c\n1,2,3\n\n\n\n" + '4,"5,6\n' + ("y" * 200 + "\n") * 800
    path.write_text(body, encoding="utf-8")
    with pytest.raises(data_mod.ReplayInputError) as info:
        cli.read_csv(path)
    problem = info.value.problems[0]
    assert (problem.file, problem.line, problem.code) == ("obs_x.csv", 6, "csv_parse_error")
