"""공개 API 계약 고정 — 구조 개편(라우터 → 서비스 분리 등) 중에도 경로·파라미터·응답 스키마가 한 글자도
바뀌지 않았음을 보장한다. 의도한 API 변경이면 스냅샷을 다시 만든다(conftest 의 테스트 env 가 필요해 pytest 로):

    UPDATE_OPENAPI_SNAPSHOT=1 PYTHONUTF8=1 python -m pytest tests/contracts -q
"""

import json
import os
import pathlib

import pytest

SNAPSHOT = pathlib.Path(__file__).with_name("openapi.snapshot.json")


def _current() -> dict:
    from app.main import app

    return json.loads(json.dumps(app.openapi(), sort_keys=True, ensure_ascii=False))


def test_openapi_contract_is_unchanged():
    current = _current()
    if os.environ.get("UPDATE_OPENAPI_SNAPSHOT") == "1":
        SNAPSHOT.write_text(json.dumps(current, sort_keys=True, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        pytest.skip(f"snapshot updated: {SNAPSHOT.name}")
    expected = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    missing = sorted(set(expected["paths"]) - set(current["paths"]))
    added = sorted(set(current["paths"]) - set(expected["paths"]))
    assert not missing and not added, f"경로 변경 — 사라짐 {missing}, 새로 생김 {added}"
    assert current == expected, "경로는 같지만 파라미터·응답 스키마가 바뀌었다 — 의도한 변경이면 스냅샷 갱신"
