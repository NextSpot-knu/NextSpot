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


def test_second_remote_protocol_error_is_propagated_without_more_retries():
    first = httpx.RemoteProtocolError("Server disconnected")
    second = httpx.RemoteProtocolError("Server disconnected again")
    inner = _SequenceTransport([first, second, _response()])
    transport = _StaleConnectionRetryTransport(inner)

    with pytest.raises(httpx.RemoteProtocolError) as raised:
        transport.handle_request(_request())

    assert raised.value is second
    assert inner.calls == 2


def test_wrapped_httpcore_remote_protocol_error_is_retried():
    core_error = httpcore.RemoteProtocolError("Server disconnected")
    wrapped = RuntimeError("postgrest wrapped transport error")
    wrapped.__cause__ = core_error
    inner = _SequenceTransport([wrapped, _response()])
    transport = _StaleConnectionRetryTransport(inner)

    assert transport.handle_request(_request()).status_code == 200
    assert inner.calls == 2
