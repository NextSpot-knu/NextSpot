"""Supabase HTTP 전송 계층 — stale 연결 재시도.

Supabase 는 HTTP/2 연결을 주기적으로 GOAWAY 로 닫는다. 풀에 남아 있던 그 연결을 다시 쓰면
RemoteProtocolError(ConnectionTerminated)가 난다. 서버 장애가 아니라 **연결 재사용 문제**라
새 연결로 다시 보내면 통한다.
"""
import httpx
import httpcore
import pytest

from app.core.supabase import _StaleConnectionRetryTransport


class _SequenceTransport(httpx.BaseTransport):
    def __init__(self, outcomes):
        self.outcomes = iter(outcomes)
        self.calls = 0

    def handle_request(self, request):
        self.calls += 1
        outcome = next(self.outcomes)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def _request():
    return httpx.Request("GET", "https://example.test/rest/v1/facilities")


def _response():
    return httpx.Response(200, json={"ok": True})


def test_remote_protocol_error_retries_once_then_succeeds():
    inner = _SequenceTransport([httpx.RemoteProtocolError("Server disconnected"), _response()])
    transport = _StaleConnectionRetryTransport(inner)

    response = transport.handle_request(_request())

    assert response.status_code == 200
    assert inner.calls == 2


def test_unrelated_error_is_not_retried():
    inner = _SequenceTransport([ValueError("bad query")])
    transport = _StaleConnectionRetryTransport(inner)

    with pytest.raises(ValueError, match="bad query"):
        transport.handle_request(_request())

    assert inner.calls == 1


def test_two_stale_connections_in_a_row_still_recover():
    """예전에는 여기서 포기했다 — 그게 프로덕션 장애의 원인이었다.

    재시도를 정확히 한 번만 하던 시절, 풀에 죽은 연결이 둘 이상 남아 있으면 재시도도 같은
    상태의 연결을 집어 그대로 실패했다. 그 예외가 호출부까지 올라가 분산코스가 통째로 500 이
    됐다(2026-08-28 프로덕션·로컬 모두 재현). 이제 짧은 백오프로 몇 번 더 시도한다.
    """
    first = httpx.RemoteProtocolError("Server disconnected")
    second = httpx.RemoteProtocolError("Server disconnected again")
    inner = _SequenceTransport([first, second, _response()])
    transport = _StaleConnectionRetryTransport(inner)

    assert transport.handle_request(_request()).status_code == 200
    assert inner.calls == 3


def test_gives_up_instead_of_retrying_forever():
    """계속 실패하면 호출부가 알아야 한다 — 무한정 되풀이하지 않는다."""
    errors = [httpx.RemoteProtocolError("disconnected %d" % i) for i in range(5)]
    inner = _SequenceTransport(errors)
    transport = _StaleConnectionRetryTransport(inner)

    with pytest.raises(httpx.RemoteProtocolError) as raised:
        transport.handle_request(_request())

    assert raised.value is errors[2], "마지막 시도의 예외를 올려야 원인이 보인다"
    assert inner.calls == 3


def test_timeouts_are_not_retried():
    """진짜 타임아웃까지 되풀이하면 느린 장애를 더 느리게 만들 뿐이다."""
    inner = _SequenceTransport([httpx.ConnectTimeout("timeout"), _response()])
    transport = _StaleConnectionRetryTransport(inner)

    with pytest.raises(httpx.ConnectTimeout):
        transport.handle_request(_request())

    assert inner.calls == 1


def test_wrapped_httpcore_remote_protocol_error_is_retried():
    core_error = httpcore.RemoteProtocolError("Server disconnected")
    wrapped = RuntimeError("postgrest wrapped transport error")
    wrapped.__cause__ = core_error
    inner = _SequenceTransport([wrapped, _response()])
    transport = _StaleConnectionRetryTransport(inner)

    assert transport.handle_request(_request()).status_code == 200
    assert inner.calls == 2


class _PoolAwareTransport(httpx.BaseTransport):
    """풀을 닫기 전까지는 계속 stale 오류를 내는 전송(죽은 연결을 계속 집는 상황 재현)."""

    def __init__(self):
        self.calls = 0
        self.closed = 0
        self._poisoned = True

    def handle_request(self, request):
        self.calls += 1
        if self._poisoned:
            raise httpx.RemoteProtocolError("ConnectionTerminated")
        return _response()

    def close(self):
        self.closed += 1
        self._poisoned = False   # 풀을 닫으면 다음 연결은 새로 맺힌다


def test_pool_is_closed_so_the_retry_gets_a_fresh_connection():
    """재시도만으로는 부족하다 — 같은 풀에서 같은 죽은 연결을 다시 집기 때문이다.

    프로덕션에서 실패가 2~3회씩 뭉쳐 나온 이유가 이것이었다(2026-08-28 실측).
    """
    inner = _PoolAwareTransport()
    transport = _StaleConnectionRetryTransport(inner)

    assert transport.handle_request(_request()).status_code == 200
    assert inner.closed >= 1, "풀을 닫지 않아 재시도가 같은 죽은 연결을 다시 집는다"
    assert inner.calls == 2


# --- 닫힌 HTTP/2 연결에 헤더 보내기 거부(LocalProtocolError) — 운영 로그에 50회+ 찍힌 형태 -----------------

_CLOSED_SEND_HEADERS = "Invalid input ConnectionInputs.SEND_HEADERS in state ConnectionState.CLOSED"


def _httpcore_closed_error():
    """httpcore/_sync/http2.py 와 같은 모양: h2 ProtocolError 를 LocalProtocolError 로 감싼다."""
    import h2.exceptions

    return httpcore.LocalProtocolError(h2.exceptions.ProtocolError(_CLOSED_SEND_HEADERS))


def test_closed_connection_send_headers_is_retried_at_the_httpcore_level():
    inner = _SequenceTransport([_httpcore_closed_error(), _response()])
    transport = _StaleConnectionRetryTransport(inner)

    assert transport.handle_request(_request()).status_code == 200
    assert inner.calls == 2


def test_closed_connection_send_headers_is_retried_as_httpx_wraps_it():
    wrapped = httpx.LocalProtocolError(_CLOSED_SEND_HEADERS)
    wrapped.__cause__ = _httpcore_closed_error()
    inner = _SequenceTransport([wrapped, _response()])
    transport = _StaleConnectionRetryTransport(inner)

    assert transport.handle_request(_request()).status_code == 200
    assert inner.calls == 2


def test_closed_connection_retry_is_safe_for_writes_because_nothing_was_sent():
    # 헤더조차 못 보낸 요청이라 서버는 모른다 — POST 도 한 번만 반영된다.
    inner = _SequenceTransport([_httpcore_closed_error(), _response()])
    transport = _StaleConnectionRetryTransport(inner)
    post = httpx.Request("POST", "https://example.test/rest/v1/recommendations", json={"a": 1})

    assert transport.handle_request(post).status_code == 200
    assert inner.calls == 2


def test_other_local_protocol_errors_are_not_retried():
    for message in (
        "Invalid input ConnectionInputs.SEND_DATA in state ConnectionState.CLOSED",  # 헤더는 이미 나감
        "Header value must be str or bytes",
    ):
        inner = _SequenceTransport([httpcore.LocalProtocolError(message)])
        transport = _StaleConnectionRetryTransport(inner)
        with pytest.raises(httpcore.LocalProtocolError):
            transport.handle_request(_request())
        assert inner.calls == 1
