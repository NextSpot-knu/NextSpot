"""PostgREST 응답 파서 교체(app/core/postgrest_json.py) — 결과는 원래 pydantic 경로와 같고, 빈 본문 폴백도 같다."""

import json

import httpx
import pytest
from postgrest import base_request_builder
from postgrest.types import JSONAdapter as ORIGINAL

from app.core import postgrest_json

PAYLOADS = [
    [],
    {},
    [{"id": "a", "n": 1, "f": 0.25, "b": True, "z": None, "s": "황리단길 ☕", "nested": {"l": [1, 2.5, "x", None]}}],
    [{"big": 12345678901234567890, "neg": -3, "exp": 1e-7, "empty": "", "deep": [[[{"k": [{}]}]]]}],
    "plain string",
    42,
    3.5,
    None,
    True,
]


def test_install_replaces_the_parser_and_is_idempotent():
    assert postgrest_json.install() is True  # app.core.supabase 가 import 때 이미 설치했다
    assert postgrest_json.install() is True
    assert isinstance(base_request_builder.JSONAdapter, postgrest_json._JsonLoadsAdapter)


@pytest.mark.parametrize("payload", PAYLOADS)
def test_same_python_values_as_the_pydantic_path(payload):
    raw = json.dumps(payload, ensure_ascii=False).encode()
    assert base_request_builder.JSONAdapter.validate_json(raw) == ORIGINAL.validate_json(raw)


def _response(body: bytes, status: int = 200) -> httpx.Response:
    return httpx.Response(status, content=body, request=httpx.Request("GET", "https://x.test/rest/v1/t"))


def test_library_fallbacks_for_empty_and_non_json_bodies_are_unchanged():
    APIResponse = base_request_builder.APIResponse
    # Prefer: return=minimal 쓰기 응답(빈 본문) → 원래처럼 [].
    assert APIResponse.from_http_request_response(_response(b"", 201)).data == []
    # 비 JSON 본문 → 원래처럼 텍스트 그대로.
    assert APIResponse.from_http_request_response(_response(b"not json")).data == "not json"
    rows = [{"id": 1, "v": "x"}]
    assert APIResponse.from_http_request_response(_response(json.dumps(rows).encode())).data == rows


def test_library_still_routes_responses_through_the_installed_parser(monkeypatch):
    """postgrest 가 새 버전에서 from_http_request_response 가 JSONAdapter 를 더는 부르지 않으면, 교체가 조용히
    꺼지고 페이지당 +70MB 가 돌아온다(requirements 는 supabase>=2.3.0 비고정). 그때 이 테스트가 깨진다."""
    calls = []
    installed = base_request_builder.JSONAdapter
    original = installed.validate_json

    def spy(data, *a, **k):
        calls.append(len(data))
        return original(data, *a, **k)

    monkeypatch.setattr(installed, "validate_json", spy)
    assert base_request_builder.APIResponse.from_http_request_response(_response(b'[{"a": 1}]')).data == [{"a": 1}]
    assert calls, "postgrest 가 응답을 교체된 파서로 읽지 않는다 — postgrest_json.install() 경로를 다시 확인할 것"


def test_pathologically_deep_body_falls_back_like_the_original():
    deep = ("[" * 3000 + "]" * 3000).encode()
    data = base_request_builder.APIResponse.from_http_request_response(_response(deep)).data
    assert data == deep.decode()  # 원래처럼 텍스트로 물러선다(RecursionError 로 요청이 깨지지 않는다)
