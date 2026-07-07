# 라우터 통합 테스트용 환경 부트스트랩.
# app 임포트 시점에 Settings(app/core/config.py)가 필수 시크릿을 요구하므로,
# 어떤 테스트 모듈이 app 을 임포트하기 전에 placeholder 를 채운다.
# setdefault 라서 CI/셸이 이미 설정한 실제 값이 있으면 그 값이 우선한다.
import os

os.environ.setdefault("SUPABASE_URL", "https://placeholder.supabase.co")
os.environ.setdefault("SUPABASE_ANON_KEY", "placeholder-anon")
os.environ.setdefault("JWT_SECRET", "placeholder-jwt-secret")
os.environ.setdefault("ADMIN_API_TOKEN", "placeholder-admin")
