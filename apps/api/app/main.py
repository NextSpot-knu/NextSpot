from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.core.logging import setup_logging
from app.routers import recommendations, infrastructures, predict, preferences, admin


# 로깅 설정 초기화
setup_logging()

app = FastAPI(
    title=settings.PROJECT_NAME,
    description="NextSpot 관광 수요 분산·대안 장소 추천 AI 엔진 API",
    version="0.1.0"
)


# CORS 설정 //  app = FastAPI() 선언문 하단에 정확히 삽입하십시오.
# 안전 정책:
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
