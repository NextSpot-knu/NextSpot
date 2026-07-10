import hmac
from collections.abc import Callable
# pyrefly: ignore [missing-import]
import jwt
import structlog
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
# pyrefly: ignore [missing-import]
from supabase import create_client, Client
from app.core.config import settings

_logger = structlog.get_logger()


def _create_client(url: str, key: str, *, role: str) -> Client:
    """Supabase 클라이언트 생성. 시크릿 부재/URL 형식오류 등으로 실패하면 원인을 구조화 로깅 후 재발생.
    (정상 시크릿 환경에선 동작 동일 — 진단 가능한 부팅 실패를 위한 래퍼.)"""
    try:
        return create_client(url, key)
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
        # Supabase JWT 디코딩 검증 (Gotrue JWT secret 사용)
        # Supabase는 기본적으로 HS256 알고리즘 사용
        payload = jwt.decode(
            token,
            settings.JWT_SECRET,
            algorithms=["HS256"],
            audience="authenticated"
        )
        
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
        
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="만료된 JWT 토큰입니다.",
        )
    except jwt.PyJWTError as e:
        # InvalidTokenError 뿐 아니라 InvalidKeyError(빈 JWT_SECRET 시 'HMAC key must not be empty')도 포섭.
        # (좁게 InvalidTokenError 만 잡으면 빈 시크릿이 미처리 예외→500 으로 새어나간다.)
        # 검증 실패 원문은 서버 로그로만 — 클라이언트에 라이브러리 내부 메시지를 노출하지 않는다.
        _logger.warning("jwt_verification_failed", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="유효하지 않은 JWT 토큰입니다.",
        )


def require_admin(request: Request) -> dict:
    """관리자 전용 가드 — 공유 토큰 검증(비-GCP).

    워커 경로(Supabase JWT, get_current_user)와 분리된다. 관리자 프런트(admin/*)는 세션 토큰을
    X-Admin-Authorization 헤더(Bearer)로만 보낸다.
    - 일반 Authorization 헤더 폴백은 제거 — 워커용 JWT 헤더가 관리자 가드에 흘러들지 않게 경로를 분리한다.
    - 토큰 비교는 hmac.compare_digest(상수시간) — 타이밍 공격으로 토큰을 유추할 수 없게 한다.
    """
    auth = request.headers.get("x-admin-authorization") or ""
    if not auth.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="관리자 인증 토큰이 없습니다.",
        )
    token = auth.split(" ", 1)[1].strip()
    if not token or not hmac.compare_digest(token, settings.ADMIN_API_TOKEN):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="유효하지 않은 관리자 토큰입니다.",
        )
    return {"role": "admin"}
