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
from app.core.config import settings

_logger = structlog.get_logger()

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

# Supabase/PostgREST 의 기본 동기 클라이언트는 HTTP/2 풀을 오래 재사용한다. 저트래픽 운영 환경에서
# upstream 이 먼저 끊은 idle 연결을 집으면 첫 요청만 RemoteProtocolError 로 실패한다.
_SUPABASE_KEEPALIVE_EXPIRY_SECONDS = 15.0


def _is_stale_connection_error(exc: BaseException) -> bool:
    """죽은 풀 연결에서 발생하는 프로토콜 오류인지 예외 체인을 따라 판별한다."""
    seen: set[int] = set()
    current: BaseException | None = exc
    retryable_types = (
        httpx.RemoteProtocolError,
        httpcore.RemoteProtocolError,
        httpcore.ConnectionNotAvailable,
    )
    while current is not None and id(current) not in seen:
        if isinstance(current, retryable_types):
            return True
        seen.add(id(current))
        current = current.__cause__ or current.__context__
    return False


# 재시도 간격(초). 즉시 한 번, 그다음은 아주 짧게 쉬었다가.
# 길게 잡지 않는다 — 이 경로는 요청 처리 중이고, 실패가 계속되면 빨리 드러나는 편이 낫다.
_STALE_RETRY_BACKOFF = (0.0, 0.1, 0.25)


class _StaleConnectionRetryTransport(httpx.BaseTransport):
    """stale HTTP/2 연결 오류만 새 풀 연결로 재시도한다.

    Supabase 는 HTTP/2 연결을 주기적으로 GOAWAY 로 닫는다. 풀에 남아 있던 그 연결을
    다시 쓰면 RemoteProtocolError(ConnectionTerminated)가 난다.

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
                try:
                    self._transport.close()
                except Exception:  # 풀 정리 실패가 원래 오류를 가리지 않게
                    pass
        raise last  # type: ignore[misc]

    def close(self) -> None:
        self._transport.close()


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
        transport = _StaleConnectionRetryTransport(
            httpx.HTTPTransport(
                # ⚠️ http2=False 를 시도했다가 되돌렸다(2026-08-28).
                # 동시 요청이 H2 연결 하나에 다중화되는 게 원인이라고 보고 HTTP/1.1 로 바꿨는데,
                # 프로덕션에서 /courses/recommend 성공률이 40% → **0%** 로 떨어졌다.
                # 가설이 틀렸거나, HTTP/1.1 에서는 연결 수립 비용이 커져 다른 한계에 먼저
                # 부딪히는 것으로 보인다. 근거 없이 다시 바꾸지 말 것 — 바꾸려면 프로덕션에서
                # 성공률을 재고 나서.
                http2=True,
                limits=httpx.Limits(keepalive_expiry=_SUPABASE_KEEPALIVE_EXPIRY_SECONDS),
            )
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

def verify_supabase_token(token: str) -> dict:
    """get_current_user와 같은 키 선택/오류 계약으로 access token을 독립 검증한다."""
    try:
        alg = str(jwt.get_unverified_header(token).get("alg", "")).upper()
        if alg.startswith(("ES", "RS", "PS", "ED")):
            payload = jwt.decode(token, _get_signing_key(token), algorithms=[alg], audience="authenticated")
        else:
            payload = jwt.decode(token, settings.JWT_SECRET, algorithms=["HS256"], audience="authenticated")
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
