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

    # ── 기계(machine-to-machine) 호출용 공유 토큰 ────────────────────────────────
    # 사람이 쓰는 관리자 인증이 **아니다**. 사람은 Supabase 로그인 + users.role 로 판정한다
    # (app/core/authz.py). 이 토큰은 세션을 가질 수 없는 호출자 — GitHub Actions 스케줄러와
    # Supabase pg_cron — 가 수집 엔드포인트를 두드릴 때만 쓴다.
    #
    # ⚠️ 절대 프런트엔드에 노출하지 말 것. 예전 NEXT_PUBLIC_ADMIN_API_TOKEN 은 정적 번들에
    #    그대로 박혀 누구나 읽을 수 있었다. 그 방식은 폐지됐고, 그때 쓰던 값은 이미 공개된
    #    것으로 취급해 반드시 새 값으로 교체해야 한다.
    #
    # SERVICE_API_TOKEN 이 설정돼 있으면 그것을 쓰고, 없으면 기존 ADMIN_API_TOKEN 으로
    # 폴백한다. 배포된 Render/Actions/Vault 를 한꺼번에 바꾸지 않고도 회전할 수 있게 하기
    # 위해서다(새 값을 SERVICE_API_TOKEN 에 넣으면 그 순간부터 그것만 유효해진다).
    ADMIN_API_TOKEN: str
    SERVICE_API_TOKEN: str = ""

    @property
    def MACHINE_API_TOKEN(self) -> str:
        """기계 호출자가 제시해야 하는 유효 토큰(SERVICE_API_TOKEN 우선)."""
        return self.SERVICE_API_TOKEN.strip() or self.ADMIN_API_TOKEN

    # 사장님 콘솔(머천트) 공유 토큰 — 프런트 apps/web NEXT_PUBLIC_MERCHANT_API_TOKEN 과 같아야 한다.
    # ADMIN_API_TOKEN 과 달리 기본값이 있다(데모 우선 — 미설정 배포에서도 부팅이 막히지 않는다).
    # ⚠️ 반드시 여기(Settings)에 있어야 한다. 과거 merchant.py 가 os.environ.get 으로 직접 읽었는데,
    #    pydantic-settings 는 .env 를 os.environ 에 주입하지 않고 자체적으로만 읽는다. 그래서
    #    .env 에 MERCHANT_API_TOKEN 을 적어도 조용히 무시되고 기본값이 그대로 살아 있었다
    #    (운영자는 토큰을 바꿨다고 믿지만 실제로는 데모 토큰이 유효한 상태).
    MERCHANT_API_TOKEN: str = "nextspot-merchant-local"

    # 구 콘솔 공유 토큰(X-Merchant-Token) 한시 수용 스위치 — **2026-08-28 부로 기본 False**.
    #
    # 프런트(merchant-api.ts)가 Supabase JWT 로 전환 완료됐으므로 더 이상 필요 없다. 끔으로써
    # 가게 소유권 검사가 **모든 경로에서** 강제된다 — 공유 토큰만 알면 아무 가게의 좌석 상태를
    # 방송할 수 있던 구멍이 닫힌다(그 방송은 evidence_tier='verified' 로 학습에 들어간다).
    #
    # 다시 켜야 할 유일한 상황: 구 프런트가 배포된 채로 백엔드만 먼저 올라간 경우의 임시 완충.
    # 그때도 소유권 검사를 우회하므로 최대한 짧게 쓰고 즉시 되돌릴 것.
    LEGACY_CONSOLE_TOKENS: bool = False

    # Kakao Local/지도 장소 검색 키. 경로 API 키가 아니다.
    # 도보 거리는 번들된 OpenStreetMap 보행 그래프로 계산한다.
    KAKAO_REST_API_KEY: str = ""

    # 한국관광공사 TourAPI(공공데이터포털 B551011) 인증키 — 공모전 필수 데이터 소스.
    # POI 적재(scripts/ingest_tourapi.py)·행사 조회(searchFestival2)에 사용.
    # 선택값: 비어 있으면 부팅은 정상이며, TourAPI 호출 시점에 한국어 오류로 명확히 실패한다
    # (app/services/tourapi/client.py 참고 — API 서버 기동에 키를 강제하지 않기 위함).
    TOURAPI_KEY: str = ""

    # 기상청 단기예보 조회서비스(공공데이터포털 1360000) 인증키.
    # TourAPI와 별도 활용신청 상품이다. 비어 있으면 날씨 API는 unavailable로 무해 폴백한다.
    KMA_API_KEY: str = ""

    # 한국교통안전공단 주차정보 제공 API(B553881). 공공데이터포털의 같은 프로젝트 키를
    # 재사용할 수 있으므로 비어 있으면 TOURAPI_KEY로 폴백한다. 별도 활용승인이 없거나
    # 경주 실시간 행이 없으면 지역 수요는 관광 통계만 사용한다.
    PARKING_API_KEY: str = ""
    PARKING_API_BASE_URL: str = "https://apis.data.go.kr/B553881/Parking"
    # 경주시 교통정보센터 공개 주차정보. 별도 키 없이 경주 공영주차장 잔여면을 제공하며
    # 전국 주차 API보다 지역 커버리지가 정확해 1순위로 사용한다.
    GYEONGJU_ITS_BASE_URL: str = "https://its.gyeongju.go.kr"

    # 아래 관광 데이터랩 상품은 KorService2와 별도 활용신청이 필요하지만 승인 후에는 같은
    # 공공데이터포털 인증키를 사용한다. 별도 키를 만들지 않아 운영 시크릿 수를 늘리지 않는다.

    # --- LLM 어댑터(app/services/llm_client.py) — 국산 Upstage Solar, OpenAI 호환 ---
    # 선택값: 비어 있으면 LLM 기능이 전부 조용히 비활성(기존 결정적 경로 그대로 — 무해 폴백).
    # 제공자 교체는 BASE_URL/MODEL 만 바꾸면 된다(OpenAI 호환 chat completions 라면 무엇이든).
    UPSTAGE_API_KEY: str = ""
    LLM_BASE_URL: str = "https://api.upstage.ai/v1"
    LLM_MODEL: str = "solar-pro3"  # 2026-07-17 실측: 0.8~1.1초, JSON 신뢰성 solar-mini 대비 우위
    LLM_TIMEOUT_SECONDS: float = 3.0  # 음성 UX 상한 — 초과 시 None 반환, 호출자는 키워드 경로 유지

    # P1-3 검색 0건 질의 재작성(search_rewrite_service) — 전역 일일 LLM 호출 예산 캡.
    # 무인증 검색 경로의 유료 호출 비용 소진 공격에 대한 최종 안전판(IP 분당 리밋과 별도).
    # KST 일 단위 리셋, 0 이하면 재작성 전면 비활성. 캡 도달 시 LLM 미호출 → 현행 빈 결과(무해 폴백).
    SEARCH_REWRITE_DAILY_BUDGET: int = 200

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

    @field_validator("ADMIN_API_TOKEN")
    @classmethod
    def _nonempty_admin_token(cls, v: str) -> str:
        # 빈 토큰이면 `Bearer ` 만으로 관리자 가드가 뚫린다 — 부팅 시점에 실패시킨다.
        if not v or not v.strip():
            raise ValueError("ADMIN_API_TOKEN must be a non-empty secret (set it in .env)")
        return v.strip()

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )


# .env 또는 환경변수에서 설정을 로드한다(로컬 전용 — GCP Secret Manager 미사용).
settings = Settings(_env_file=".env")
