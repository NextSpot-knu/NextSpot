"""구 공유 토큰 스위치를 켠 채 기본 토큰을 두면 부팅 로그에 남는지.

이 조합은 조용해서 위험하다 — 스위치는 잘 켜지고 요청도 잘 통과하며, 가게 소유권 검사만
소리 없이 우회된다. 경고가 사라지면 아무도 모르게 된다는 뜻이라, 경고 자체를 잠근다.
"""
from unittest.mock import patch

from app.core.config import settings
from app.main import _check_legacy_console_token

DEFAULT_TOKEN = type(settings).model_fields["MERCHANT_API_TOKEN"].default


def _run(legacy: bool, token: str) -> list:
    calls = []
    with patch.object(settings, "LEGACY_CONSOLE_TOKENS", legacy), \
         patch.object(settings, "MERCHANT_API_TOKEN", token), \
         patch("app.main._logger") as logger:
        logger.error.side_effect = lambda *a, **kw: calls.append((a, kw))
        _check_legacy_console_token()
    return calls


def test_default_token_with_the_legacy_switch_on_is_reported():
    calls = _run(True, DEFAULT_TOKEN)
    assert calls, "소유권 검사를 우회하는 조합인데 아무 로그도 남지 않았다"
    assert calls[0][0][0] == "legacy_console_token_is_default"


def test_switch_off_is_silent():
    """평소 상태다. 기본 토큰이어도 그 경로로는 아무것도 못 하므로 경고할 일이 아니다."""
    assert _run(False, DEFAULT_TOKEN) == []


def test_rotated_token_is_silent():
    assert _run(True, "rotated-secret-value") == []


def test_the_default_is_read_from_the_model_not_retyped():
    """기본값을 테스트에 복사해 두면 코드가 바뀌어도 테스트는 옛 값을 계속 검사한다."""
    assert DEFAULT_TOKEN and isinstance(DEFAULT_TOKEN, str)
