"""postgrest-py 응답 파싱을 pydantic 재귀 유니언 검증 대신 표준 json.loads 로 — 메모리 피크의 근원 차단.

배경(2026-09-25 18:15 KST OOM 조사, WSL glibc 실측): postgrest 2.31 은 **모든** 응답 본문을
`TypeAdapter(JSON).validate_json` 으로 읽는다(postgrest/base_request_builder.py `APIResponse.
from_http_request_response`, JSON = None|bool|str|int|float|Sequence[JSON]|Mapping[str, JSON] 재귀 유니언).
이 검증은 값마다 유니언 분기를 시도하느라 네이티브 메모리를 크게 쓴다 — 2.87MB 페이지(추천 스냅샷 1000행)
하나에 Linux RSS +69.9MB, 같은 본문을 json.loads 로 읽으면 +13.2MB. 그 메모리는 파싱한 워커 스레드의
glibc arena 에 남아(malloc_trim 전까지) 관광객·예열·관리자 요청 가리지 않고 RSS 를 계단식으로 올렸다.

결과는 같다: 두 파서 모두 JSON 을 dict/list/str/int/float/bool/None 으로만 만든다(Sequence→list,
Mapping→dict). 다른 점은 **잘못된 본문**(빈 본문 — Prefer: return=minimal 쓰기 응답 등)에서 원래 것은
pydantic ValidationError 를 내고, 라이브러리가 그것을 잡아 `data = text or []` 로 물러선다는 것뿐이다.
그 동작을 그대로 지키려고, json.loads 가 실패하면 원래 어댑터에 넘겨 **같은 예외**가 나게 한다
(잘못된 본문은 작고 드물어 비용이 없다).

설치는 멱등이고, postgrest 내부 구조가 바뀌어 찾을 수 없으면 아무것도 바꾸지 않는다(원래 동작 유지).
"""

from __future__ import annotations

import json
from typing import Any

import structlog

logger = structlog.get_logger(__name__)


class _JsonLoadsAdapter:
    """`TypeAdapter.validate_json` 자리에 들어가는 얇은 대역 — 성공 경로는 json.loads."""

    def __init__(self, original: Any) -> None:
        self._original = original

    def validate_json(self, data: Any, *args: Any, **kwargs: Any) -> Any:
        try:
            return json.loads(data)
        except (ValueError, TypeError):
            # 빈 본문·비 JSON: 원래 어댑터가 pydantic ValidationError 를 내야 라이브러리의 폴백이 탄다.
            return self._original.validate_json(data, *args, **kwargs)

    def __getattr__(self, name: str) -> Any:  # validate_python 등 다른 용도는 원래 어댑터로
        return getattr(self._original, name)


def install() -> bool:
    """postgrest 응답 파서를 교체한다. 교체했거나 이미 교체돼 있으면 True."""
    try:
        from postgrest import base_request_builder
    except Exception as exc:  # noqa: BLE001 — 라이브러리 구조 변화: 원래 동작 유지
        logger.warning("postgrest_json_install_skipped", reason=f"import: {exc}")
        return False
    current = getattr(base_request_builder, "JSONAdapter", None)
    if isinstance(current, _JsonLoadsAdapter):
        return True
    if current is None or not hasattr(current, "validate_json"):
        logger.warning("postgrest_json_install_skipped", reason="JSONAdapter not found")
        return False
    base_request_builder.JSONAdapter = _JsonLoadsAdapter(current)
    return True
