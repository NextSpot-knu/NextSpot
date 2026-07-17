import asyncio
import time
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.core.logging import setup_logging
from app.routers import recommendations, infrastructures, predict, preferences, admin, reports, coupons, courses, events, tracking, freshness, impact, merchant, safety, search, lab, account


# 로깅 설정 초기화
setup_logging()

_logger = structlog.get_logger()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """부팅 시 무거운 lazy 초기화를 미리 끝낸다(첫 사용자 요청이 그 비용을 물지 않게).

    배경(2026-07-16 실측): 첫 `/recommendations/by-type` 이 프로덕션에서 **18.8초** 걸려
    프런트 10초 타임아웃(api-client REQUEST_TIMEOUT_MS)을 넘겨 "추천 서버에 연결하지 못했어요" 가
    떴다. 콜드 스타트가 아니라(직전 /health 0.4s, /impact 0.8s 로 컨테이너는 웜) **첫 by-type 이
    model.pkl 을 처음 언피클**하는 비용이었다. 웜 상태에서는 같은 호출이 ~2초다.
    로컬 실측으로 model.pkl 최초 로드 866ms / 이후 예측 1ms — Render 무료 티어(0.1 CPU)에서
    이 언피클이 10배 이상으로 늘어난다.

    Render 는 `healthCheckPath: /health`(render.yaml)로 준비 완료를 판정하므로, 여기서 워밍업을
    마치면 트래픽이 오기 전에 캐시가 채워진다. 워밍업 실패가 서비스 부팅을 막으면 본말전도이므로
    전부 best-effort(예외를 삼키고 경고만) — 실패해도 기존 lazy 경로가 그대로 동작한다.
    """
    t0 = time.perf_counter()
    try:
        # 1) model.pkl 언피클 — 가장 큰 비용. 예측 1회로 lazy 로더를 강제 기동한다.
        from app.services.predict_service import predict_congestion
        await asyncio.to_thread(predict_congestion, "restaurant", 12, 2)
        _logger.info("warmup_model_ready", elapsed_ms=round((time.perf_counter() - t0) * 1000))
    except Exception as e:
        _logger.warning("warmup_model_failed", error=str(e))

    try:
        # 2) JWKS 공개키 프리페치 — 첫 인증 요청이 DNS+TLS 신규 왕복(실측 772ms)을 물지 않게 한다.
        #    is_anonymous 검증 등 모든 인증 경로가 이 캐시를 공유한다(core/supabase.py).
        from app.core.supabase import _get_jwks_client
        await asyncio.to_thread(_get_jwks_client().get_jwk_set)
        _logger.info("warmup_jwks_ready")
    except Exception as e:
        _logger.warning("warmup_jwks_failed", error=str(e))

    try:
        # 3) 시설 캐시 프리필 — 재배포 직후 첫 by-type 이 캐시 미스 비용(facilities+집중률 왕복,
        #    0.1 CPU 실측 최악 13초)을 물지 않게 부팅 때 채워둔다. 단일 키('all') 캐시라
        #    이후 모든 사용자·모든 위치가 이 한 번의 프리필을 공유한다(TTL 후엔 요청이 갱신).
        from app.routers.recommendations import fetch_all_facilities
        prefilled = await fetch_all_facilities()
        _logger.info("warmup_facilities_ready", count=len(prefilled))
    except Exception as e:
        _logger.warning("warmup_facilities_failed", error=str(e))

    _logger.info("warmup_done", total_ms=round((time.perf_counter() - t0) * 1000))
    yield


app = FastAPI(
    title=settings.PROJECT_NAME,
    description="NextSpot 관광 수요 분산·대안 장소 추천 AI 엔진 API",
    version="0.1.0",
    lifespan=lifespan,
)


# CORS 안전 정책:
#  - ALLOWED_ORIGINS 가 명시적 오리진 목록이면 그 오리진만 허용하고 credentials 를 켠다(엄격 모드).
#  - "*" 가 포함되거나 미설정이면 모든 오리진을 허용하되 credentials 를 끈다.
#    (와일드카드 + allow_credentials=True 는 CORS 표준 위반. 이 API 인증은 Authorization Bearer
#     헤더라 쿠키가 필요 없으므로 credentials 를 꺼도 프런트 동작은 불변이다.)
# → 운영에서 ALLOWED_ORIGINS 를 실제 도메인으로 설정하면 자동으로 엄격 모드로 잠긴다.
_allowed_origins = settings.ALLOWED_ORIGINS or ["*"]
if "*" in _allowed_origins:
    _cors_origin_policy = {"allow_origins": ["*"], "allow_credentials": False}
else:
    _cors_origin_policy = {"allow_origins": _allowed_origins, "allow_credentials": True}

app.add_middleware(
    CORSMiddleware,
    allow_methods=["*"],
    allow_headers=["*"],
    **_cors_origin_policy,
)

# 라우터 연결
app.include_router(recommendations.router)
app.include_router(infrastructures.router)
app.include_router(predict.router, prefix="/predict")
app.include_router(preferences.router)  # 자연어 선호 → 키워드 파싱 → 추천 반영
app.include_router(admin.router)  # 관리자 전용(require_admin) — 시설 CRUD·설정·문의·지표 (WS-A-6)
app.include_router(reports.router)  # 혼잡 제보(크라우드소싱) — 인증 사용자가 실시간 혼잡을 service_role 로 기록
app.include_router(coupons.router)  # 내 쿠폰함(인센티브 지갑) — SPOT w3(coupon_rate)를 고객에게 노출
app.include_router(courses.router)  # 분산 코스(멀티스톱 동선) 추천 — 도착시점 예측 혼잡 회피
app.include_router(events.router)  # 경주 축제/행사(TourAPI searchFestival2) — 키 없으면 무해 폴백
app.include_router(tracking.router)  # 경량 제품 분석 이벤트 트래킹(무인증, IP 쿨다운) — app_events 적재
app.include_router(freshness.router)  # 데이터 신선도(D5) — 마지막 TourAPI 동기화 시각(마커→updated_at 추정 폴백)
app.include_router(impact.router)  # 여행 임팩트 카드 — 수락·혼잡회피·쿠폰 성과 요약(개인)
app.include_router(merchant.router)  # 머천트 콘솔 — 내 가게 성적표·셀프 타임세일·좌석 방송(데모 게이트)
app.include_router(safety.router)  # 인파 안전 경보(B2G) — 임계값 초과 존/시설 조기경보(require_admin)
app.include_router(search.router)  # TourAPI 키워드 폴백 → 관리자 승인형 다음 배치 적재 요청
app.include_router(lab.router)  # 거절 실험실 — 보류된 거절 사유를 되묻고 답한 만큼만 취향 학습(1회)
app.include_router(account.router)  # 기존 계정 로그인 시 소유 증명된 게스트 데이터 승계

# 1. Health Check Endpoint
@app.get("/")
@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "project": settings.PROJECT_NAME,
        "environment": settings.ENV
    }

# 실제 추천 단일 진입점은 recommendations 라우터(POST /api/v1/recommendations)다.
# (과거 /api/v1 네임스페이스에 있던 하드코딩 데모 목업 응답 및 JWT 데모용 auth-test 엔드포인트는
#  실데이터 오인을 유발해 제거했다.)
