from typing import List, Union
# pyrefly: ignore [missing-import]
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator


class Settings(BaseSettings):
    ENV: str = "development"
    PROJECT_NAME: str = "NextSpot API"

    # Supabase Settings (주 데이터 저장소 — GCP 아님)
    SUPABASE_URL: str
    SUPABASE_ANON_KEY: str
    SUPABASE_SERVICE_ROLE_KEY: str = ""
    JWT_SECRET: str  # Supabase JWT 검증용 비밀키

    @property
    def SUPABASE_KEY(self) -> str:
        return self.SUPABASE_SERVICE_ROLE_KEY or self.SUPABASE_ANON_KEY

    # 관리자 데모 가드용 공유 토큰. 프런트(apps/web/lib/admin-auth.ts)의 SESSION_TOKEN 과 동일해야 한다.
    # (대회용 Firebase Authentication 가드를 제거하고 비-GCP 단순 토큰 검증으로 대체.)
    ADMIN_API_TOKEN: str = "nextspot-admin-local"

    # Kakao Mobility Directions API (도보/차량 실거리·실시간 이동시간).
    # 비어 있으면 Haversine 직선거리 도보 환산으로 폴백(기본). 키가 있으면 실경로 호출.
    KAKAO_REST_API_KEY: str = ""

    # CORS Settings
    # 기본값은 와일드카드(미설정 환경에서 프런트가 막히지 않도록). 운영에서는 실제 도메인을
    # 콤마로 지정하면 main.py 가 자동으로 엄격 모드(해당 오리진만 + credentials)로 전환한다.
    ALLOWED_ORIGINS: Union[str, List[str]] = ["*"]

    @field_validator("ALLOWED_ORIGINS")
    @classmethod
    def assemble_cors_origins(cls, v: Union[str, List[str]]) -> List[str]:
        if isinstance(v, str) and not v.startswith("["):
            # 빈 토큰 제거 후, 결과가 비면 와일드카드로 폴백.
            # (ALLOWED_ORIGINS="" 같은 빈 환경변수가 [''] 가 되어 모든 오리진이 조용히 차단되는 footgun 방지)
            parts = [i.strip() for i in v.split(",") if i.strip()]
            return parts or ["*"]
        elif isinstance(v, (list, str)):
            return v
        raise ValueError(v)

    @field_validator("JWT_SECRET")
    @classmethod
    def _nonempty_jwt_secret(cls, v: str) -> str:
        # 빈 JWT_SECRET 은 모든 워커 인증을 깨뜨린다(빈 HMAC 키 → 정상 토큰도 검증 실패).
        # 런타임 401/500 으로 미루지 말고 부팅 시점에 명확히 실패시켜 설정 누락을 조기 발견한다.
        if not v or not v.strip():
            raise ValueError("JWT_SECRET must be a non-empty secret")
        return v

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )


# .env 또는 환경변수에서 설정을 로드한다(로컬 전용 — GCP Secret Manager 미사용).
settings = Settings(_env_file=".env")
