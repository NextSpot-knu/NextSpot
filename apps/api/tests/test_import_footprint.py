"""API 기동 경로의 import 발자국 — 배치 전용 무거운 라이브러리가 서버 메모리에 올라오지 않게.

2026-09-26 Linux 실측: dev 콘솔이 한 줄짜리 헬퍼(capacity_for)를 batch/localdata 에서 가져오면서
pyproj(+PROJ 공유 라이브러리)가 기동마다 올라와 import RSS 가 89.2MB → pyproj 지연 적재 시 74.1MB(-15MB).
batch/__init__.py 도 '런타임 API 는 batch 에서 아무것도 import 하지 않는다' 고 말한다.
"""

import os
import subprocess
import sys
from pathlib import Path

API_ROOT = Path(__file__).resolve().parents[1]


def test_importing_the_app_does_not_load_pyproj():
    # 다른 테스트가 이미 pyproj 를 올렸을 수 있으므로 새 인터프리터에서 확인한다(환경변수는 conftest 가 주입한 그대로).
    code = "import sys, app.main; print('pyproj' in sys.modules)"
    out = subprocess.run(
        [sys.executable, "-c", code], cwd=API_ROOT, env={**os.environ, "PYTHONUTF8": "1"},
        capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, out.stderr[-2000:]
    assert out.stdout.strip().splitlines()[-1] == "False", "API 기동 경로가 pyproj 를 적재한다 — 배치 전용으로 되돌릴 것"
