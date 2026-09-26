"""Supabase 전송 계층 — 요청마다 전용 연결(2026-09-26 운영 장애 회귀 테스트).

운영에서는 모든 스레드가 동기 HTTP/2 연결 하나를 나눠 썼다. 동시에 요청을 시작하면 스트림 번호·헤더 압축
표가 어긋나 Supabase 가 연결째로 끊었고(ConnectionTerminated error_code:1·9), 재시도 전송이 stale 오류마다
**공유 풀을 통째로 닫아** 다른 스레드가 쓰던 소켓까지 끊겼다(EBADF — 끊긴 쓰기는 재시도로 한 번 더 나간다).
by-type 추천이 503 이 된 원인이다.

여기서는 운영과 같은 조립(_create_client)을 그대로 쓰고 httpx.HTTPTransport(= 연결 풀 하나)만 가짜로 바꿔,
실제 스레드로 요청을 동시에 넣어 계약을 본다. 네트워크는 쓰지 않는다.
  · 동시에 도는 두 요청은 절대 같은 연결을 쓰지 않는다.
  · 한 요청의 stale 오류가 다른 요청의 연결을 닫지 않는다(쓰기가 두 번 나가지 않는다).
  · 운영 클라이언트는 HTTP/1.1 이고 인증서 묶음(SSLContext)을 한 번만 읽는다.
  · 기존 재시도 규칙(무엇을 재시도하나 · SEND_HEADERS 한정 · 본문 선읽기)은 그대로다.
"""
import ssl
import threading
import time
from collections import Counter

import httpcore
import httpx
import pytest

from app.core import supabase as sb

_BASE = "https://example.supabase.co"
_READ = f"{_BASE}/rest/v1/facilities"
_WRITE = f"{_BASE}/rest/v1/recommendations"
_JOIN_TIMEOUT = 10.0
_CLOSED_SEND_HEADERS = "Invalid input ConnectionInputs.SEND_HEADERS in state ConnectionState.CLOSED"


class _FakeServer:
    """모든 가짜 연결이 함께 쓰는 '서버' — 받은 요청 수를 세고, 경로별 처리 함수로 응답을 정한다."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.received: Counter = Counter()  # (method, path) → 서버에 도착한 횟수
        self.handlers: dict = {}  # path → handler(conn, request) → httpx.Response (없으면 200 [])

    def handle(self, conn: "_FakeConnection", request: httpx.Request) -> httpx.Response:
        with self.lock:
            self.received[(request.method, request.url.path)] += 1
        handler = self.handlers.get(request.url.path)
        if handler is None:
            return httpx.Response(200, json=[])
        return handler(conn, request)


class _Body(httpx.SyncByteStream):
    """연결에 묶인 응답 본문. 끝까지 읽히거나 닫히기 전까지 그 연결은 '본문이 남은' 상태다."""

    def __init__(self, conn: "_FakeConnection", chunks: list[bytes], fail: Exception | None) -> None:
        self._conn = conn
        self._chunks = chunks
        self._fail = fail
        self._closed = False
        with conn.lock:
            conn.open_bodies += 1

    def __iter__(self):
        try:
            yield from self._chunks
            if self._fail is not None:
                raise self._fail
        except BaseException:
            self.close()  # httpcore 도 본문 도중 오류면 스스로 닫고 올린다
            raise

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            with self._conn.lock:
                self._conn.open_bodies -= 1


class _FakeConnection(httpx.BaseTransport):
    """httpx.HTTPTransport 대역. 요청이 몇 개나 동시에 올라타는지, 쓰는 중에 닫히는지 기록한다."""

    def __init__(self, server: _FakeServer, **kwargs) -> None:
        self.server = server
        self.kwargs = kwargs
        self.lock = threading.Lock()
        self.in_flight = 0
        self.max_in_flight = 0
        self.open_bodies = 0
        self.closes = 0
        self.closed_while_busy = 0  # 다른 요청이 쓰는 중에 닫힌 횟수(= 그 요청의 소켓이 끊긴다)

    def body(self, chunks: list[bytes], fail: Exception | None = None) -> httpx.Response:
        return httpx.Response(200, stream=_Body(self, chunks, fail))

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        with self.lock:
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)
            closes_at_start = self.closes
        try:
            response = self.server.handle(self, request)
            with self.lock:
                cut = self.closes != closes_at_start
            if cut:
                # 요청 도중 누가 이 풀을 닫았다 — 실제로는 소켓이 사라져 EBADF 로 터진다(운영 09-26 15:41 KST).
                raise httpx.WriteError("[Errno 9] Bad file descriptor")
            return response
        finally:
            with self.lock:
                self.in_flight -= 1

    def close(self) -> None:
        with self.lock:
            self.closes += 1
            if self.in_flight:
                self.closed_while_busy += 1


class _Rig:
    def __init__(
        self,
        client: httpx.Client,
        server: _FakeServer,
        connections: list[_FakeConnection],
        ssl_contexts: list[ssl.SSLContext],
    ) -> None:
        self.client = client
        self.server = server
        self.connections = connections
        self.ssl_contexts = ssl_contexts


@pytest.fixture
def rig(monkeypatch):
    """운영과 같은 _create_client 조립에서 연결 풀(HTTPTransport)만 가짜로 바꾼 httpx.Client."""
    server = _FakeServer()
    connections: list[_FakeConnection] = []
    ssl_contexts: list[ssl.SSLContext] = []
    made = threading.Lock()

    def fake_http_transport(**kwargs):
        conn = _FakeConnection(server, **kwargs)
        with made:
            connections.append(conn)
        return conn

    def counting_ssl_context(*args, **kwargs):
        # 진짜는 certifi 를 읽느라 Windows 에서 0.7초 걸린다 — 몇 번 불렸는지만 세고 빈 컨텍스트를 준다.
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ssl_contexts.append(context)
        return context

    monkeypatch.setattr(sb.httpx, "HTTPTransport", fake_http_transport)
    monkeypatch.setattr(sb.httpx, "create_ssl_context", counting_ssl_context)
    # supabase Client 는 빼고 _create_client 가 넘기는 ClientOptions(httpx_client 포함)를 그대로 돌려받는다.
    monkeypatch.setattr(sb, "create_client", lambda url, key, options: options)
    client = sb._create_client(_BASE, "anon-key", role="anon").httpx_client
    yield _Rig(client, server, connections, ssl_contexts)
    client.close()


def _run_together(target, n: int) -> None:
    threads = [threading.Thread(target=target) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(_JOIN_TIMEOUT)
    assert not any(t.is_alive() for t in threads), "스레드가 제한 시간 안에 끝나지 않았다"


def _hold_until_all_arrive(n: int):
    """n 개 요청이 **모두 연결 안에 들어올 때까지** 붙잡는 처리 함수 — 동시 사용을 확정적으로 만든다."""
    barrier = threading.Barrier(n, timeout=5)

    def handler(conn, request):
        barrier.wait()
        return httpx.Response(200, json=[])

    return handler


# --- 격리: 수정 전 코드(공유 연결 + 풀 통째 닫기)에서 실패하고 지금 통과해야 한다 -----------------------------


def test_concurrent_requests_never_share_a_connection(rig):
    """장애의 뿌리: 동시에 도는 요청이 한 연결에 올라타면 스트림 번호·HPACK 표가 어긋난다.

    8개 요청을 동시에 연결 안에 머물게 한 뒤 연결마다 최대 동시 요청 수를 본다. 두 번째 파도는 새 스레드로
    보낸다(anyio 워커는 쉬면 사라진다) — 첫 파도가 맺은 연결을 그대로 이어 써야 한다.
    """
    n = 8
    rig.server.handlers["/rest/v1/facilities"] = _hold_until_all_arrive(n)
    statuses: list[int] = []

    for _ in range(2):
        _run_together(lambda: statuses.append(rig.client.get(_READ).status_code), n)

    assert statuses == [200] * (2 * n)
    assert max(c.max_in_flight for c in rig.connections) == 1, "한 연결에 요청이 동시에 올라탔다"
    assert len(rig.connections) <= n, "연결 수가 동시 요청 수를 넘었다(앞 파도의 연결을 버리고 새로 맺었다)"


def test_stale_error_on_one_request_does_not_cut_another_requests_connection(rig):
    """운영 15:41 KST 의 EBADF: 한 요청의 stale 오류가 공유 풀을 닫아, 다른 스레드가 보내던 요청의 소켓이 끊겼다.

    끊긴 요청은 재시도로 다시 나간다 — 쓰기(POST)면 서버에 두 번 반영된다.
    """
    writer_inside = threading.Event()
    release_writer = threading.Event()
    stale_once = [True]

    def slow_insert(conn, request):
        writer_inside.set()
        assert release_writer.wait(5)
        return httpx.Response(201, json=[{"id": 1}])

    def read_on_dead_connection_once(conn, request):
        if stale_once[0]:
            stale_once[0] = False
            raise httpx.RemoteProtocolError("<ConnectionTerminated error_code:1, last_stream_id:5, additional_data:None>")
        return httpx.Response(200, json=[])

    rig.server.handlers["/rest/v1/recommendations"] = slow_insert
    rig.server.handlers["/rest/v1/facilities"] = read_on_dead_connection_once
    insert_statuses: list[int] = []
    writer = threading.Thread(
        target=lambda: insert_statuses.append(rig.client.post(_WRITE, json={"spot": 1}).status_code)
    )
    writer.start()
    try:
        assert writer_inside.wait(5)
        assert rig.client.get(_READ).status_code == 200  # 읽기는 새 연결로 재시도해 회복한다
    finally:
        release_writer.set()
        writer.join(_JOIN_TIMEOUT)

    assert not writer.is_alive()
    assert insert_statuses == [201]
    assert sum(c.closed_while_busy for c in rig.connections) == 0, "다른 요청이 쓰던 연결이 닫혔다(EBADF)"
    assert rig.server.received[("POST", "/rest/v1/recommendations")] == 1, "끊긴 쓰기가 재시도로 두 번 나갔다"
    assert rig.server.received[("GET", "/rest/v1/facilities")] == 2  # stale 1회 + 재시도 1회


def test_production_client_speaks_http11_and_reads_the_certificate_bundle_once(rig):
    """HTTP/1.1 인 이유는 _create_client 주석. SSLContext 를 연결마다 만들면 하나에 약 0.7MB 다."""
    n = 3
    rig.server.handlers["/rest/v1/facilities"] = _hold_until_all_arrive(n)

    _run_together(lambda: rig.client.get(_READ), n)

    assert rig.connections
    for conn in rig.connections:
        assert conn.kwargs.get("http2") is False
        assert conn.kwargs["limits"].keepalive_expiry == sb._SUPABASE_KEEPALIVE_EXPIRY_SECONDS
    assert len(rig.connections) == n
    assert len(rig.ssl_contexts) == 1, "인증서 묶음을 연결마다 다시 읽었다"
    assert all(conn.kwargs.get("verify") is rig.ssl_contexts[0] for conn in rig.connections)


# --- 유지: 수정 전후 모두 통과해야 하는 계약(연결 재사용 · 재시도 규칙 · 본문 선읽기) ----------------------------


def test_sequential_requests_reuse_one_warm_connection(rig):
    for _ in range(20):
        assert rig.client.get(_READ).status_code == 200
    assert len(rig.connections) == 1


def test_body_is_fully_read_before_the_connection_is_handed_back(rig):
    """전용 연결의 전제: 연결이 돌아갈 때 본문이 남아 있으면 안 된다(재시도 전송의 본문 선읽기가 보장한다).

    stream=True 로 받아도 전송 계층이 이미 본문을 다 읽고 연결을 돌려준 상태여야 한다.
    """
    rig.server.handlers["/rest/v1/facilities"] = lambda conn, request: conn.body([b'[{"id":', b" 1}]"])

    response = rig.client.send(rig.client.build_request("GET", _READ), stream=True)
    try:
        assert all(c.open_bodies == 0 for c in rig.connections), "본문이 남은 연결이 돌아갔다"
        assert response.read() == b'[{"id": 1}]'
    finally:
        response.close()


def test_error_while_reading_the_body_is_retried(rig):
    """GOAWAY·끊김이 본문을 읽는 도중에 나도 재시도가 닿는다(2026-08-28 에 이것이 재시도 밖이었다)."""
    calls = [0]

    def handler(conn, request):
        calls[0] += 1
        if calls[0] == 1:
            return conn.body([b'[{"id":'], fail=httpx.RemoteProtocolError("<ConnectionTerminated error_code:9>"))
        return conn.body([b'[{"id": 1}]'])

    rig.server.handlers["/rest/v1/facilities"] = handler

    assert rig.client.get(_READ).json() == [{"id": 1}]
    assert rig.server.received[("GET", "/rest/v1/facilities")] == 2
    assert all(c.open_bodies == 0 for c in rig.connections)


@pytest.mark.parametrize(
    ("error", "retried"),
    [
        (httpx.RemoteProtocolError("<ConnectionTerminated error_code:1>"), True),
        (httpx.ReadError("[Errno 32] Broken pipe"), True),
        (httpx.WriteError("[Errno 9] Bad file descriptor"), True),
        # 닫힌 연결에 헤더조차 못 보냈다 — 서버는 요청을 모르므로 쓰기도 안전하게 다시 보낸다.
        (httpcore.LocalProtocolError(_CLOSED_SEND_HEADERS), True),
        # 헤더는 이미 나갔다 — 다시 보내면 쓰기가 두 번 반영될 수 있어 재시도하지 않는다.
        (httpcore.LocalProtocolError("Invalid input ConnectionInputs.SEND_DATA in state ConnectionState.CLOSED"), False),
        (httpx.ReadTimeout("timed out"), False),
        (httpx.ConnectTimeout("timed out"), False),
    ],
    ids=["remote-protocol", "read-epipe", "write-ebadf", "send-headers-closed", "send-data-closed",
         "read-timeout", "connect-timeout"],
)
def test_retry_rules_are_unchanged_through_the_production_client(rig, error, retried):
    first = [True]

    def handler(conn, request):
        if first[0]:
            first[0] = False
            raise error
        return httpx.Response(201, json=[])

    rig.server.handlers["/rest/v1/recommendations"] = handler

    if retried:
        assert rig.client.post(_WRITE, json={"spot": 1}).status_code == 201
        assert rig.server.received[("POST", "/rest/v1/recommendations")] == 2
    else:
        with pytest.raises(type(error)):
            rig.client.post(_WRITE, json={"spot": 1})
        assert rig.server.received[("POST", "/rest/v1/recommendations")] == 1


# --- _ExclusiveConnectionTransport 단위: 연결이 새지 않는다 ---------------------------------------------------


def _exclusive(server: _FakeServer, made: list[_FakeConnection], **kwargs):
    def factory():
        conn = _FakeConnection(server)
        made.append(conn)
        return conn

    return sb._ExclusiveConnectionTransport(factory, **kwargs)


def _get() -> httpx.Request:
    return httpx.Request("GET", _READ)


def test_connection_idle_past_keepalive_is_closed_and_replaced():
    made: list[_FakeConnection] = []
    transport = _exclusive(_FakeServer(), made, keepalive_expiry=0.05, max_idle=64)

    transport.handle_request(_get())
    time.sleep(0.2)
    transport.handle_request(_get())

    assert len(made) == 2
    assert made[0].closes == 1 and made[1].closes == 0


def test_idle_connections_above_the_cap_are_closed():
    made: list[_FakeConnection] = []
    server = _FakeServer()
    server.handlers["/rest/v1/facilities"] = _hold_until_all_arrive(4)
    transport = _exclusive(server, made, keepalive_expiry=15.0, max_idle=2)

    _run_together(lambda: transport.handle_request(_get()), 4)  # 4개가 동시에 빌려 간다

    assert len(made) == 4
    assert sum(c.closes for c in made) == 2  # 돌아온 4개 중 상한(2)을 넘는 2개는 닫는다


def test_failed_request_still_returns_its_connection_for_reuse():
    made: list[_FakeConnection] = []
    server = _FakeServer()
    calls = [0]

    def fail_first(conn, request):
        calls[0] += 1
        if calls[0] == 1:
            raise RuntimeError("boom")
        return httpx.Response(200, json=[])

    server.handlers["/rest/v1/facilities"] = fail_first
    transport = _exclusive(server, made, keepalive_expiry=15.0, max_idle=64)

    with pytest.raises(RuntimeError):
        transport.handle_request(_get())
    assert transport.handle_request(_get()).status_code == 200
    assert len(made) == 1


def test_close_closes_idle_and_in_flight_connections_once_they_return():
    made: list[_FakeConnection] = []
    server = _FakeServer()
    inside = threading.Event()
    release = threading.Event()

    def slow(conn, request):
        inside.set()
        assert release.wait(5)
        return httpx.Response(200, json=[])

    transport = _exclusive(server, made, keepalive_expiry=15.0, max_idle=64)
    server.handlers["/rest/v1/facilities"] = _hold_until_all_arrive(2)
    _run_together(lambda: transport.handle_request(_get()), 2)  # 연결 2개가 쉬는 상태로 돌아온다
    server.handlers["/rest/v1/facilities"] = slow
    worker = threading.Thread(target=lambda: transport.handle_request(_get()))
    worker.start()
    try:
        assert inside.wait(5)  # 둘 중 하나를 빌려 요청 중
        transport.close()
        busy = [c for c in made if c.in_flight]
        idle = [c for c in made if not c.in_flight]
        assert len(busy) == 1 and len(idle) == 1
        assert idle[0].closes == 1  # 쉬던 연결은 바로 닫는다
        assert busy[0].closes == 0, "쓰는 중인 연결을 닫았다"
    finally:
        release.set()
        worker.join(_JOIN_TIMEOUT)

    assert not worker.is_alive()
    assert busy[0].closes == 1  # 닫힌 뒤 돌아온 연결은 풀에 넣지 않고 닫는다
    assert all(c.closed_while_busy == 0 for c in made)
