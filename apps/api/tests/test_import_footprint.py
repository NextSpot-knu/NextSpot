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


def test_health_endpoint_answers_on_the_event_loop_not_the_thread_pool():
    """Render 는 /health 가 5초 안에 답하지 않으면 재시작한다. 동기 def 는 anyio 스레드풀(40)에서 돌아
    get_current_user 같은 동기 의존성이 풀을 채우면 그 뒤에 줄을 섰다(실측: 풀 포화 시 509회 중 483회 5초 초과).
    async def 는 풀과 무관하게 루프에서 바로 답한다."""
    import inspect

    from app import main

    assert inspect.iscoroutinefunction(main.health_check)


def test_gil_switch_interval_is_short_so_the_event_loop_is_not_starved():
    import sys

    from app import main

    assert sys.getswitchinterval() == main._GIL_SWITCH_INTERVAL_SECONDS <= 0.001
