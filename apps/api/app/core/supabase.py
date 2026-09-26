import threading
import time
from typing import Optional

from collections.abc import Callable
# pyrefly: ignore [missing-import]
import httpcore
import httpx
import jwt
# pyrefly: ignore [missing-import]
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientConnectionError
import structlog
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
# pyrefly: ignore [missing-import]
from supabase import Client, ClientOptions, create_client
from app.core import postgrest_json
from app.core.config import settings

_logger = structlog.get_logger()

# 모든 PostgREST 응답을 json.loads 로 읽는다(pydantic 재귀 유니언 검증은 페이지당 네이티브 메모리를
# ~5배 쓴다 — app/core/postgrest_json.py). 이 모듈을 거치는 앱·배치 스크립트 모두에 적용된다.
postgrest_json.install()

# Supabase 는 신규 프로젝트에서 GoTrue JWT 를 비대칭키(ES256/RS256, JWKS)로 서명한다.
# (익명 로그인 토큰도 동일.) HS256 legacy 시크릿으로는 검증 불가하므로 JWKS 공개키로 검증한다.
# JWKS 엔드포인트: {SUPABASE_URL}/auth/v1/.well-known/jwks.json — 공개키라 캐시 재사용(lazy 싱글턴).
_jwks_client: Optional[PyJWKClient] = None
_jwks_lock = threading.RLock()
# 실측(2026-07-15): 콜드 최초 fetch 772ms, 이후 웜 80~100ms. DNS+TLS 를 새로 맺는 최초 1회가
# 압도적으로 느리므로 timeout 은 그 위로 잡는다 — 여기를 조이면 정작 목표인 콜드 스타트에서
# 첫 시도가 타임아웃난다. 상한은 프런트 요청 타임아웃 10초(api-client REQUEST_TIMEOUT_MS)를
# 넘지 않게: 최악 2.0 + 0.2 + 2.0 ≈ 4.2초.
_JWKS_TIMEOUT_SECONDS = 2.0
_JWKS_RETRY_BACKOFF_SECONDS = 0.2

# 쉬는 Supabase 연결을 이 시간 넘게 들고 있지 않는다. 저트래픽 운영 환경에서 upstream 이 먼저 끊은
# idle 연결을 집으면 첫 요청만 RemoteProtocolError 로 실패한다. httpcore 연결 풀과
# _ExclusiveConnectionTransport 의 쉬는 전송 목록이 같은 값을 쓴다.
_SUPABASE_KEEPALIVE_EXPIRY_SECONDS = 15.0


def _is_stale_connection_error(exc: BaseException) -> bool:
    """죽은 풀 연결에서 발생하는 프로토콜 오류인지 예외 체인을 따라 판별한다."""
    seen: set[int] = set()
    current: BaseException | None = exc
    retryable_types = (
        httpx.RemoteProtocolError,
        httpcore.RemoteProtocolError,
        httpcore.ConnectionNotAvailable,
        # Broken pipe([Errno 32])도 같은 병이다 — upstream 이 먼저 닫은 풀 연결을 집어
        # 읽기/쓰기 중 터지면 ReadError/WriteError 로 나타난다(2026-09-21 프로덕션 로그:
        # httpcore.ReadError: [Errno 32] Broken pipe → recommend_by_type 503). 새 연결로
        # 재시도하면 통과한다. 진짜 타임아웃(ReadTimeout 등)은 별도 타입이라 여기 안 걸린다.
        httpx.ReadError,
        httpcore.ReadError,
        httpx.WriteError,
        httpcore.WriteError,
    )
    while current is not None and id(current) not in seen:
        if isinstance(current, retryable_types):
            return True
        if _is_closed_connection_send_headers(current):
            return True
        seen.add(id(current))
        current = current.__cause__ or current.__context__
    return False


def _is_closed_connection_send_headers(exc: BaseException) -> bool:
    """h2 가 **이미 닫힌** 연결에 요청 헤더 보내기를 거부한 오류인가(요청이 한 바이트도 나가지 않은 경우).

    풀에 남은 HTTP/2 연결이 GOAWAY 기록 없이 닫혀 있으면 httpcore 는 h2 의 ProtocolError 를
    LocalProtocolError 로 감싸 올린다(httpcore/_sync/http2.py — `raise LocalProtocolError(exc)`).
    메시지: "Invalid input ConnectionInputs.SEND_HEADERS in state ConnectionState.CLOSED".
    RemoteProtocolError 와 같은 병(죽은 풀 연결)인데 타입이 달라 재시도에서 빠져 있었다 —
    2026-09-21 이후 운영 로그에 recommend_by_type·account_me_pending·admin_model_trust·
    availability_evidence 등의 실패로 50회 넘게 찍혔다.

    SEND_HEADERS 단계로 한정한다: 헤더조차 못 보냈으니 서버는 요청을 모른다 → POST·PATCH 도 중복 없이
    안전하게 다시 보낼 수 있다. 다른 이유의 LocalProtocolError(잘못된 헤더 값 등)는 재시도하지 않는다.
    """
    if not isinstance(exc, (httpx.LocalProtocolError, httpcore.LocalProtocolError)):
        return False
    message = str(exc)
    return "ConnectionState.CLOSED" in message and "SEND_HEADERS" in message


# 재시도 간격(초). 즉시 한 번, 그다음은 아주 짧게 쉬었다가.
# 길게 잡지 않는다 — 이 경로는 요청 처리 중이고, 실패가 계속되면 빨리 드러나는 편이 낫다.
_STALE_RETRY_BACKOFF = (0.0, 0.1, 0.25)


class _StaleConnectionRetryTransport(httpx.BaseTransport):
    """stale 연결 오류만 새 연결로 재시도한다.

    Supabase 는 쉬던 연결을 먼저 닫는다(HTTP/2 시절엔 GOAWAY, HTTP/1.1 에선 소켓 종료). 풀에 남아
    있던 그 연결을 다시 쓰면 RemoteProtocolError 가 난다.

    2026-09-26 부터 이 전송은 요청 하나가 혼자 빌린 연결 하나만 감싼다(_ExclusiveConnectionTransport).
    그래서 아래의 풀 닫기도 그 연결에만 닿는다.

    예전에는 **정확히 한 번만** 재시도했는데, 풀에 죽은 연결이 여럿 남아 있으면 재시도도
    같은 상태의 연결을 집어 그대로 실패했다. 그러면 예외가 호출부까지 올라가고 —
    분산코스처럼 그 위에 예외 처리가 없던 엔드포인트는 통째로 500 이 됐다.
    (2026-08-28 프로덕션에서 재현: 같은 요청이 한 번은 실패, 다시 하면 성공.)

    재시도 대상은 여전히 stale 연결 오류로 한정한다 — 진짜 서버 오류나 타임아웃까지
    되풀이하면 장애를 늘릴 뿐이다.
    """

    def __init__(self, transport: httpx.BaseTransport) -> None:
        self._transport = transport

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        last: Exception | None = None
        for delay in _STALE_RETRY_BACKOFF:
            if delay:
                time.sleep(delay)
            try:
                response = self._transport.handle_request(request)
                # ⚠️ 본문을 **여기서** 끝까지 읽는다.
                #
                # httpx 전송 계층은 헤더만 받은 응답을 돌려주고 본문은 나중에 스트리밍된다.
                # Supabase 가 GOAWAY 로 연결을 닫으면 그 오류는 handle_request 가 이미 반환한
                # 뒤, 호출부가 body 를 읽을 때 터진다 — 즉 **이 재시도 밖에서** 난다.
                # 실제로 그래서 재시도를 3회로 늘리고 풀까지 닫아도 성공률이 40~69% 에
                # 머물렀다(2026-08-28 프로덕션·로컬 실측).
                #
                # 미리 읽어 두면 스트리밍 오류가 이 try 안에서 발생해 재시도가 닿는다.
                # PostgREST 응답은 전부 한 번에 쓰는 JSON 이라 버퍼링해도 잃는 게 없다.
                response.read()
                return response
            except Exception as exc:
                if not _is_stale_connection_error(exc):
                    raise
                last = exc
                _logger.warning(
                    "supabase_stale_connection_retry",
                    url=str(request.url).split("?")[0],
                    error=type(exc).__name__,
                )
                # 그냥 다시 보내면 **같은 풀에서 같은 죽은 연결을 다시 집는다.**
                # 프로덕션에서 실측한 실패 패턴이 2~3회씩 뭉쳐 나온 이유가 이것이다 —
                # 재시도를 3회로 늘려도 셋 다 같은 연결이면 셋 다 실패한다.
                # 풀을 닫아 다음 시도가 반드시 새 연결을 맺게 한다.
                # (이 풀은 이 요청이 혼자 빌린 것이다. 모든 스레드가 풀 하나를 나눠 쓰던 2026-09-26 전에는
                #  여기서 다른 요청의 소켓까지 닫혔다 — EBADF 는 운영 로그에서, 중복 POST 는 하니스에서 확인.)
                try:
                    self._transport.close()
                except Exception:  # 풀 정리 실패가 원래 오류를 가리지 않게
                    pass
        raise last  # type: ignore[misc]

    def close(self) -> None:
        self._transport.close()


def _close_quietly(transport: httpx.BaseTransport) -> None:
    try:
        transport.close()
    except Exception:  # 정리 실패가 요청 처리를 막지 않게
        pass


# _ExclusiveConnectionTransport 가 쉬는 전송을 몇 개까지 들고 있을지. 이 앱이 Supabase 를 동시에 부를 수
# 있는 스레드 수(기본 executor 16 + anyio 스레드풀 40 + 관리자 풀 4 + 무거운 풀 2 = 62)보다 크게 잡아,
# 버스트가 끝날 때 연결을 버렸다가 다음 버스트에 다시 맺는 일이 없게 한다. 오래 쉰 전송은 개수와 무관하게
# keepalive 만료 시각이 지나면 걷어 낸다(_checkout).
_SUPABASE_MAX_IDLE_CONNECTIONS = 64


class _ExclusiveConnectionTransport(httpx.BaseTransport):
    """요청 하나가 연결 하나를 **혼자** 쓰게 한다 — 요청마다 전송을 빌려주고, 끝나면 돌려받는다.

    왜(2026-09-26 운영 로그 + WSL 카오스 하니스 실측, 수치는 _create_client 주석):
    예전에는 모든 스레드(asyncio.to_thread 16 · anyio 40 · 관리자 풀 4+2)가 HTTP/2 연결 하나를 나눠 썼다.
    httpcore 의 동기 HTTP/2 는 스트림 번호 할당·HPACK 인코딩·프레임 쓰기를 스레드 사이에서 원자적으로
    하지 않아, 동시에 요청을 시작하면 스트림 번호가 뒤바뀌거나 헤더 압축 표가 어긋나고 Supabase
    (Cloudflare)가 연결째로 끊는다 — 운영 로그의 `ConnectionTerminated error_code:1`(PROTOCOL_ERROR)·
    `error_code:9`(COMPRESSION_ERROR)가 이것이다. hpack 의 'deque mutated during iteration'(표를 검색하는
    도중 다른 스레드가 표에 추가 — hpack 코드로 확인)과 Cloudflare 의 HTML 400(어긋난 헤더로 추정)도 같은
    경합에서 나온다. 그 연결에 실려 있던 다른 요청까지 함께 죽어 by-type 추천이 503 이 됐다.

    이제 요청은 쉬고 있는 전송(가장 최근에 돌려받은 것)을 빌리거나 새로 만들어 **끝날 때까지 혼자** 쓰고
    돌려준다. 한 연결에는 언제나 요청이 하나뿐이라 위 경합이 원리적으로 없고, 재시도 전송이 stale 오류에
    풀을 닫아도 닫히는 것은 이 요청의 연결뿐이다(공유 풀에서는 다른 스레드가 쓰던 연결까지 닫혀 EBADF·
    중복 쓰기·타임아웃까지 멈춤이 났다). httpcore 비공개 내부는 건드리지 않는다. 스레드마다 연결을 붙이는
    방식과 달리 스레드가 생기고 사라져도(anyio 워커는 10초 쉬면 끝난다) 따뜻한 연결을 이어 쓰고 연결이
    새지 않는다. 연결 수는 그 순간의 동시 요청 수를 넘지 않는다.

    factory 가 만드는 전송은 응답 본문을 끝까지 읽어서 돌려줘야 한다(_StaleConnectionRetryTransport 가
    그렇게 한다) — 돌려받는 시점에 연결이 비어 있어야 다음 요청에 내줄 수 있다.
    """

    def __init__(
        self,
        factory: Callable[[], httpx.BaseTransport],
        *,
        keepalive_expiry: float,
        max_idle: int,
    ) -> None:
        self._factory = factory
        self._keepalive_expiry = keepalive_expiry
        self._max_idle = max_idle
        self._idle: list[tuple[float, httpx.BaseTransport]] = []  # (돌려받은 시각, 전송) — 뒤가 최신
        self._lock = threading.Lock()
        self._closed = False

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        transport = self._checkout()
        try:
            return transport.handle_request(request)
        finally:
            self._checkin(transport)

    def _checkout(self) -> httpx.BaseTransport:
        now = time.monotonic()
        expired: list[httpx.BaseTransport] = []
        transport: httpx.BaseTransport | None = None
        with self._lock:
            # keepalive 가 지난 전송은 연결이 이미 만료됐다 — 오래된 것(앞)부터 걷어 낸다.
            while self._idle and now - self._idle[0][0] > self._keepalive_expiry:
                expired.append(self._idle.pop(0)[1])
            if self._idle:
                transport = self._idle.pop()[1]
        for stale in expired:
            _close_quietly(stale)
        return transport if transport is not None else self._factory()

    def _checkin(self, transport: httpx.BaseTransport) -> None:
        with self._lock:
            if not self._closed and len(self._idle) < self._max_idle:
                self._idle.append((time.monotonic(), transport))
                return
        _close_quietly(transport)

    def close(self) -> None:
        with self._lock:
            self._closed = True
            idle, self._idle = self._idle, []
        for _, transport in idle:
            _close_quietly(transport)


def _get_jwks_client() -> PyJWKClient:
    global _jwks_client
    with _jwks_lock:
        if _jwks_client is None:
            base = (settings.SUPABASE_URL or "").rstrip("/")
            _jwks_client = PyJWKClient(
                f"{base}/auth/v1/.well-known/jwks.json",
                timeout=_JWKS_TIMEOUT_SECONDS,
            )
    return _jwks_client


def _get_signing_key(token: str):
    """JWKS fetch를 single-flight로 합치고 일시적 연결 실패만 한 번 재시도한다.

    콜드 캐시일 때 /waiting 의 4개 병렬 요청이 각자 JWKS 를 조회하던 stampede 를 락으로 합친다.
    대기 요청은 락 획득 후 PyJWKClient 캐시를 다시 확인하므로 성공한 조회를 중복 실행하지 않는다.
    최초 조회의 명목상 최대 대기는 약 4.2초(위 상수 참조) — 프런트 10초 타임아웃 안에 든다.
    """
    with _jwks_lock:
        client = _get_jwks_client()
        try:
            return client.get_signing_key_from_jwt(token).key
        except PyJWKClientConnectionError:
            time.sleep(_JWKS_RETRY_BACKOFF_SECONDS)
            return client.get_signing_key_from_jwt(token).key


def _create_client(url: str, key: str, *, role: str) -> Client:
    """Supabase 클라이언트 생성. 시크릿 부재/URL 형식오류 등으로 실패하면 원인을 구조화 로깅 후 재발생.
    (정상 시크릿 환경에선 동작 동일 — 진단 가능한 부팅 실패를 위한 래퍼.)"""
    try:
        # 인증서 묶음(certifi)은 한 번만 읽어 모든 연결이 나눠 쓴다. verify 를 주지 않으면 HTTPTransport 가
        # 만들어질 때마다 SSLContext 를 새로 만들고(전송 하나당 약 0.7MB — 하니스 실측), 아래 전송은 동시
        # 요청 수만큼 만들어진다.
        ssl_context = httpx.create_ssl_context()

        def new_connection() -> httpx.BaseTransport:
            return _StaleConnectionRetryTransport(
                httpx.HTTPTransport(
                    # ⚠️ HTTP/1.1 이다 — 2026-08-28 에 되돌렸던 http2=False 를 2026-09-26 에 근거를 갖고 다시 켰다.
                    #
                    # 무엇이 문제였나(2026-09-26 운영 로그, KST 09:33·15:41·16:40 세 구간): by-type 추천 503 41건과
                    # 관리자·impact·문의·랩 조회 500. 전부 Supabase 가 연결째로 끊은 ConnectionTerminated 였다
                    # (error_code:1 PROTOCOL_ERROR 가 대부분, error_code:9 COMPRESSION_ERROR 일부, 정상 종료 0 은 0건).
                    # HTTP/2 자체가 아니라 여러 스레드가 동기 HTTP/2 연결 하나를 나눠 쓴 것이 원인이다
                    # (_ExclusiveConnectionTransport 독스트링). 이제 연결을 요청 하나가 혼자 쓰므로 HTTP/2 다중화로
                    # 얻을 것이 없고, HTTP/1.1 이 두 가지를 더 막는다:
                    #  · httpcore 는 쉬던 HTTP/1.1 연결을 내주기 전에 서버가 이미 닫았는지(소켓 readable) 보고 버린다.
                    #    HTTP/2 에는 이 검사가 없어 서버가 먼저 닫은 연결을 집으면 한 번 실패 → 0.1초 쉬고 재시도했다
                    #    (유휴 뒤 버스트 p50: 요청당 전용 HTTP/2 0.079초 → HTTP/1.1 0.047초).
                    #  · 요청 도중 GOAWAY 가 오면 httpcore(HTTP/2)는 서버가 이미 처리한 요청까지 실패시켜 재시도가 같은
                    #    POST 를 두 번 보낸다(요청당 전용 HTTP/2 로도 3,306건 중 2건). HTTP/1.1 에는 이 경로가 없다.
                    #
                    # 실측(WSL 루프백 카오스 서버 — 잦은 GOAWAY·유휴 끊김·TLS·운영 모양 부하, 변형끼리 같은 시드):
                    # 이 구성은 모든 프로파일에서 실패 0 · 중복 POST 0 · 10초 넘는 요청 0(이 코드 그대로 8,870건).
                    # 예전 구성(공유 HTTP/2 + 풀 통째 닫기)은 운영 증상을 모두 재현했다 — 서버 측 프로토콜·HPACK 위반
                    # 67건, EBADF, 중복 POST, 30초 멈춤, 'deque mutated during iteration'. 운영 모양 부하(TLS)에서
                    # RSS 52.6MB 대 52.4MB, 요청 p50 0.048초 대 0.071초.
                    #
                    # 2026-08-28 의 http2=False(/courses/recommend 성공률 40% → 0%, 8분 만에 되돌림)는 HTTP/1.1 탓보다
                    # 그때 함께 있던 두 결함 탓으로 본다(확신도 중간 — 하니스는 실패 메커니즘을 재현했을 뿐 0% 라는
                    # 크기까지 재현하지는 못했다): ① stale 오류마다 **공유 풀을 통째로 닫던 것** — HTTP/1.1 은 요청마다
                    # 소켓이 따로라 동시에 돌던 모든 요청의 소켓이 닫힌다(EBADF·중복 POST·타임아웃까지 멈춤),
                    # ② 응답 본문을 **재시도 밖에서** 읽던 것(같은 날 8348249 에서 고침 — 닫힌 소켓을 읽던 요청은 재시도
                    # 없이 실패). 지금은 본문을 재시도 안에서 읽고, 풀 닫기는 이 요청이 빌린 연결에만 닿는다.
                    # HTTP/1.1 자체는(그때의 연결 수 제한 40/20 포함) 소켓을 닫는 쪽이 없으면 0/5,760 실패였다.
                    #
                    # 운영에서 아직 재지 못한 것: Supabase·Cloudflare 의 HTTP/1.1 유휴 끊김 시각, 연결당 요청 수·동시
                    # 연결 수 제한. 배포 뒤 Render 로그의 supabase_stale_connection_retry·recommend_by_type_failed·p95 를
                    # 본다. HTTP/2 로 되돌리더라도 연결을 스레드끼리 나눠 쓰는 구조로는 돌아가지 말 것.
                    http2=False,
                    verify=ssl_context,
                    limits=httpx.Limits(keepalive_expiry=_SUPABASE_KEEPALIVE_EXPIRY_SECONDS),
                )
            )

        transport = _ExclusiveConnectionTransport(
            new_connection,
            keepalive_expiry=_SUPABASE_KEEPALIVE_EXPIRY_SECONDS,
            max_idle=_SUPABASE_MAX_IDLE_CONNECTIONS,
        )
        http_client = httpx.Client(
            transport=transport,
            timeout=120,
            follow_redirects=True,
        )
        return create_client(url, key, ClientOptions(httpx_client=http_client))
    except Exception as e:
        _logger.error("supabase_client_init_failed", role=role, error=str(e))
        raise

# 1. Supabase Python Client 초기화 (BFF 및 백엔드 직접 DB 조회/CUD용)
supabase_client: Client = _create_client(settings.SUPABASE_URL, settings.SUPABASE_ANON_KEY, role="anon")

# 1-1. 서버→서버 신뢰 경로용 클라이언트(관리자 시뮬레이트 등).
#      service_role 키가 있으면 RLS 를 우회해 congestion_logs 에 insert 할 수 있다.
#      (없으면 anon 으로 폴백 — 이 경우 추천 이력 INSERT/관리자 쓰기가 RLS 로 조용히 실패하므로
#       부팅 시점에 명확히 경고를 남긴다. 감사 항목 WS-A-4.)
if not settings.SUPABASE_SERVICE_ROLE_KEY:
    _logger.warning(
        "supabase_service_role_key_missing",
        detail="SUPABASE_SERVICE_ROLE_KEY 미설정 — supabase_admin 이 anon 으로 폴백합니다. "
               "추천 이력 저장·관리자 쓰기(simulate-peak, admin CRUD)가 RLS 로 거부됩니다.",
    )
supabase_admin: Client = _create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY, role="service_role")


def fetch_all_rows(
    client: Client,
    table: str,
    select: str = "*",
    page_size: int = 1000,
    apply_filters: Callable | None = None,
) -> list[dict]:
    """테이블 행 전량을 page_size 단위 .range() 페이지네이션으로 누적 조회한다.

    PostgREST 는 단일 응답 행수를 캡(기본 1000)하므로, 전량 조회가 필요한 곳
    (추천 후보·시설 목록·학습 데이터 적재)은 이 헬퍼로 페이지를 순회한다.
    마지막 페이지(행수 < page_size)에서 종료. apply_filters 가 주어지면 각 페이지의
    select 쿼리에 동일 필터(eq/gte/lte 등)를 적용한 뒤 range 를 건다.
    예외는 흡수하지 않고 그대로 전파한다(호출측의 기존 오류 처리 관례 유지).

    동기(블로킹) 함수 — async 경로에서는 asyncio.to_thread 로 오프로드해 호출한다.
    """
    rows: list[dict] = []
    start = 0
    while True:
        query = client.table(table).select(select)
        if apply_filters is not None:
            query = apply_filters(query)
        res = query.range(start, start + page_size - 1).execute()
        if not res.data:
            break
        rows.extend(res.data)
        if len(res.data) < page_size:
            break
        start += page_size
    return rows

# 2. HTTP Bearer 인증 체계 정의 (프록시 상황에서 누락 에러 방지를 위해 auto_error=False 설정)
security = HTTPBearer(auto_error=False)

# exp/iat/nbf 검사에 허용할 시계 오차(초).
#
# 토큰은 Supabase 가 서명하고 검증은 Render 워커가 한다 — 서로 다른 기계의 시계다. 둘 다
# NTP 를 쓰지만 수백 ms~수 초의 차이는 정상 범위이고, 그만큼 어긋나면 **방금 발급받은**
# 토큰이 ImmatureSignatureError(iat/nbf 가 미래)로 401 이 된다. 로그인 직후 첫 요청이
# "유효하지 않은 JWT" 로 거부되는 모양이라 원인을 짚기도 어렵다.
# 30초는 만료 쪽으로도 30초를 더 받아 준다는 뜻이지만, 액세스 토큰 수명이 1시간이라
# 실질적인 보안 차이는 없다(회수는 토큰 만료가 아니라 role 재조회로 한다 — authz.py 참조).
_JWT_LEEWAY_SECONDS = 30


def verify_supabase_token(token: str) -> dict:
    """get_current_user와 같은 키 선택/오류 계약으로 access token을 독립 검증한다."""
    try:
        alg = str(jwt.get_unverified_header(token).get("alg", "")).upper()
        if alg.startswith(("ES", "RS", "PS", "ED")):
            payload = jwt.decode(
                token, _get_signing_key(token), algorithms=[alg], audience="authenticated",
                leeway=_JWT_LEEWAY_SECONDS,
            )
        else:
            payload = jwt.decode(
                token, settings.JWT_SECRET, algorithms=["HS256"], audience="authenticated",
                leeway=_JWT_LEEWAY_SECONDS,
            )
        if not payload.get("sub"):
            raise HTTPException(status_code=401, detail="JWT 토큰에 sub(user_id) 필드가 존재하지 않습니다.")
        return payload
    except HTTPException:
        raise
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="만료된 JWT 토큰입니다.")
    except PyJWKClientConnectionError as e:
        _logger.warning("jwks_connection_failed", error=str(e))
        raise HTTPException(status_code=503, detail="인증 서버에 일시적으로 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.")
    except Exception as e:
        _logger.warning("jwt_verification_failed", error=str(e))
        raise HTTPException(status_code=401, detail="유효하지 않은 JWT 토큰입니다.")

def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(security)
) -> dict:
    """
    X-Forwarded-Authorization 헤더 또는 HTTP Authorization Header로부터 Supabase JWT를 획득하여 검증하고,
    디코딩된 사용자 세션 정보를 반환합니다.
    """
    token = None

    # 1. X-Forwarded-Authorization 헤더 우선 확인 (GCP 프록시를 통과한 요청)
    forwarded_auth = request.headers.get("x-forwarded-authorization") or request.headers.get("x-supabase-authorization")
    if forwarded_auth and forwarded_auth.startswith("Bearer "):
        token = forwarded_auth.split(" ")[1]

    # 2. Authorization 헤더 확인 (직접 API 요청)
    if not token and credentials:
        token = credentials.credentials

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="인증 헤더(Authorization 또는 X-Forwarded-Authorization)가 누락되었거나 Bearer 형식이 아닙니다.",
        )

    try:
        # 서명 알고리즘에 따라 검증 키를 고른다:
        #  · ES/RS/PS/EdDSA(비대칭) → Supabase JWKS 공개키(신규 프로젝트·익명 로그인 기본)
        #  · HS256(대칭, legacy) → JWT_SECRET (구 프로젝트/셀프호스트 호환)
        payload = verify_supabase_token(token)

        # payload에서 유저 UUID 추출 (Supabase JWT는 sub 필드가 user_id)
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="JWT 토큰에 sub(user_id) 필드가 존재하지 않습니다.",
            )

        return {
            "id": user_id,
            "email": payload.get("email"),
            "role": payload.get("role"),
            "payload": payload
        }

    except HTTPException:
        raise
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="만료된 JWT 토큰입니다.",
        )
    except PyJWKClientConnectionError as e:
        # 토큰 자체의 문제가 아니라 JWKS 의존성을 조회할 수 없는 일시적 서버 장애다.
        # 인증은 계속 fail-closed로 거부하되, 클라이언트가 401과 구분해 제한 재시도할 수 있게 한다.
        _logger.warning("jwks_connection_failed", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="인증 서버에 일시적으로 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.",
        )
    except Exception as e:
        # PyJWTError(서명·클레임 불일치) 등은 기존처럼 인증 실패로 닫는다(fail-closed).
        # 원문은 서버 로그로만 남기고 라이브러리 내부 메시지는 노출하지 않는다.
        _logger.warning("jwt_verification_failed", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="유효하지 않은 JWT 토큰입니다.",
        )


# require_admin(X-Admin-Authorization 공유 토큰 가드)은 제거됐다.
#
# 그 방식은 프런트 번들에 박힌 토큰 하나로 모든 관리자를 통과시켰다 — 토큰을 바꾸면 전원이
# 동시에 튕기고, 개인별 권한 회수도 불가능했다. 이제 관리자 판정은 Supabase JWT +
# public.users.role 로 한다: app/core/authz.py 의 require_role("admin") 를 쓸 것.
# (developer 는 admin 의 상위집합이라 자동 통과한다.)
