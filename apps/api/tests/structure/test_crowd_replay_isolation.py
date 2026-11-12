"""구조 검사 — S4 재생 모듈(app/services/batch/crowd_*)은 런타임이 import 하지 않는다.

batch/ 는 스크립트 전용 패키지다(batch/__init__ 독스트링). 재생은 원본 반출 CSV 를 다루므로, ``app.main`` 이 그 모듈을
끌어오면 배포 이미지의 요청 경로에 오프라인 평가 코드가 섞인다. 새 프로세스에서 ``import app.main`` 뒤
``sys.modules`` 를 보고, app/ 소스에서 그 모듈을 import 하는 줄이 batch/ 밖에 없는지도 본다.
그리고 원본 반출이 저장소·이미지에 들어가지 않게 하는 무시 규칙이 있는지 본다.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

API_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = API_ROOT.parents[1]
REPLAY_MODULES = ("crowd_replay_data", "crowd_replay_engine", "crowd_dispersion_replay")


def test_app_main_does_not_load_replay_modules():
    code = (
        "import sys, app.main\n"
        "loaded = sorted(m for m in sys.modules if m.startswith('app.services.batch.crowd_'))\n"
        "print('LOADED=' + ','.join(loaded))\n"
    )
    env = {
        **os.environ,
        "SUPABASE_URL": os.environ.get("SUPABASE_URL", "https://placeholder.supabase.co"),
        "SUPABASE_ANON_KEY": os.environ.get("SUPABASE_ANON_KEY", "placeholder-anon"),
        "JWT_SECRET": os.environ.get("JWT_SECRET", "placeholder-jwt-secret-at-least-32-bytes"),
        "ADMIN_API_TOKEN": os.environ.get("ADMIN_API_TOKEN", "placeholder-admin"),
        "PYTHONUTF8": "1",
    }
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=API_ROOT, env=env, capture_output=True, text=True, timeout=180,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    line = next(row for row in result.stdout.splitlines() if row.startswith("LOADED="))
    assert line == "LOADED=", line


def test_no_runtime_source_imports_replay_modules():
    pattern = re.compile(r"(crowd_replay_data|crowd_replay_engine|crowd_dispersion_replay)")
    offenders = []
    for path in (API_ROOT / "app").rglob("*.py"):
        if path.parent.name == "batch":
            continue
        text = path.read_text(encoding="utf-8")
        for number, line in enumerate(text.splitlines(), 1):
            if ("import" in line) and pattern.search(line):
                offenders.append(f"{path.relative_to(API_ROOT)}:{number}")
    assert offenders == []


def test_raw_exports_are_ignored_by_git_and_docker():
    gitignore = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    dockerignore = (API_ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()
    assert "apps/api/.replay-data/" in [row.strip() for row in gitignore]
    assert ".replay-data/" in [row.strip() for row in dockerignore]
