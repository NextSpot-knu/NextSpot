from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.core.logging import setup_logging
from app.routers import recommendations, infrastructures, predict, preferences, admin, reports, coupons, courses, events, tracking, freshness, impact, merchant, safety, search


# 로깅 설정 초기화
setup_logging()

app = FastAPI(
    title=settings.PROJECT_NAME,
    description="NextSpot 관광 수요 분산·대안 장소 추천 AI 엔진 API",
    version="0.1.0"
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
