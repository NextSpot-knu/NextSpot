# 시스템 아키텍처 개요 — 상속 베이스 (로컬 전용 · 비-GCP)

> ⚠️ **이 문서는 NextSpot이 상속한 InduSpot 로컬 베이스의 아키텍처입니다.** 스택(Next.js 웹 + FastAPI +
> Supabase + 로컬 sklearn)과 SPOT 엔진은 그대로 재사용합니다. 도메인(산업단지→관광객)·좌표(구미→경주)·
> 라우트(worker→explore)·브랜딩의 코드 반영은 완료됐습니다(2026-07-07 검증). 데이터 소스
> (TourAPI·경주 교통데이터) 연동과 SPOT 가중치 정렬은 진행 예정입니다.
> 관광 적응 계획은 [`docs/NEXTSPOT_PIVOT.md`](./docs/NEXTSPOT_PIVOT.md), 남은 작업 로드맵은
> `docs/IMPROVEMENT_PLAN.md`를 참조하세요.

> Google Cloud AI Agent Challenge 종료 후, 모든 GCP/Firebase 의존성을 제거하고 추가 클라우드 없이
> 로컬에서 구동되도록 재구성한 정본 문서입니다. 데이터 저장소만 Supabase(비-GCP, PostgreSQL)를 유지합니다.

## 1. 전체 구성

```
┌──────────────────────────┐        ┌───────────────────────────┐        ┌──────────────────┐
│  Next.js 16 (apps/web)   │  HTTP  │   FastAPI (apps/api)       │  REST  │  Supabase        │
│  관광객/관리자 앱         │ ─────▶ │   추천·혼잡예측·음성 백엔드 │ ─────▶ │  (PostgreSQL)    │
│  정적 export, 브라우저    │        │   uvicorn / docker-compose │        │  주 데이터 저장소 │
│  Web Speech(TTS/STT)·지도 │        │   로컬 sklearn model.pkl   │        │                  │
└──────────────────────────┘        └───────────────────────────┘        └──────────────────┘
        │  Kakao Maps SDK (지도)
        ▼
   사용자 위치/시설 마커
```

- **프론트엔드**: Next.js 16 정적 export. 관광객 앱(main / explore(map·recommend) / saved / mypage /
  setup — InduSpot 시절: 근로자 앱 `app/worker/`)과 관리자 앱(admin/*). 지도는
  Kakao Maps SDK. 음성 비서는 브라우저 Web Speech API(TTS/STT). 백엔드 주소는
  `NEXT_PUBLIC_FASTAPI_URL`(기본 `http://localhost:8000`).
- **백엔드**: FastAPI. 추천(SPOT), 혼잡 예측(로컬 sklearn), 추천 사유(템플릿), 음성 의도(키워드),
  선호 벡터(Supabase) 를 제공. 외부 클라우드 호출 없음.
- **데이터**: Supabase PostgreSQL. 시설/혼잡로그/추천/피드백/선호벡터. RLS + service_role 백엔드 경로.

## 2. 추천 엔진 (SPOT)

```
SPOT = 0.45 · 선호도 − 0.25 · 시간비용 + 0.30 · 혼잡분산
```
도착 예상 시점(이동시간 반영)의 혼잡도 예측을 입력으로 사용한다. 가중치(0.45/0.25/0.30)는 고정.

- `services/spot/score.py` — SPOT 산식(가중치 불변), `predict_congestion` 을 워커 스레드로 오프로드.
- `services/spot/preference.py` — 카테고리 8차원 벡터 + 사용자 선호 벡터 코사인.
- `services/spot/travel.py` — Kakao 길찾기(키 있으면) 또는 Haversine 직선거리 도보 환산.
- `services/spot/wait_time.py` — 혼잡도 기반 예상 대기시간.

## 3. 혼잡 예측 (로컬 ML)

`services/predict_service.py`: `predict_congestion(facility_type, hour, day_of_week) -> float`.
폴백 체인 `로컬 model.pkl → 0.5`. 모델은 sklearn `OneHotEncoder → Ridge`,
피처 `[facility_type, hour_str, dow_str]`. 학습: `scripts/train.py`(Supabase 혼잡 로그 → `model.pkl`).
모델 부재 시 0.5(중간) 폴백 — 서버는 항상 기동된다.

## 4. AI 기능 (외부 LLM 없이 내장 폴백)

대회 때 Vertex AI Gemini/임베딩이 담당하던 기능을, 외부 의존성 0의 로컬 규칙으로 대체했다.

- **추천 사유** `reason_service.generate_reason` — 입력 수치만 쓰는 결정적 한국어 템플릿.
- **음성 의도** `voice_intent_service.interpret_turn` — 키워드 분류기
  (accept/next/reject/details/select/filter/stop/unknown). `POST /api/v1/voice/turn`.
- **메뉴/종류 필터** `embedding_service.filter_candidates` — 후보 이름·종류(cuisine)에 대한 부분문자열
  매칭(임베딩/벡터검색 대체). intent_category 가 후보 분류와 일치하면 그 분류로 게이트.
- **자연어 선호 파싱** `preference_nlp_service.parse_preference` — 한국어 키워드 규칙 → 카테고리/속성/8차원 벡터.

## 5. 선호 벡터 저장 (Supabase)

`services/preference_vector_service.py` — 사용자 8차원 선호 벡터를 Supabase
`user_preference_vectors` 테이블에 KV로 저장/조회/피드백 보정(수락 +10% / 거절 −5%).
테이블 미생성/오류 시 프로세스 메모리로 graceful 폴백. (이전 Firestore 백엔드 대체.)

## 6. 인증

- **관광객(사용자)**: Supabase JWT(HS256, `JWT_SECRET`) — `core/supabase.py:get_current_user`.
- **관리자(데모)**: 프론트 로컬 세션 토큰(`apps/web/lib/admin-auth.ts`)을
  `X-Admin-Authorization: Bearer <token>` 헤더 **전용**으로 전송(일반 `Authorization` 폴백 없음) →
  백엔드 `require_admin` 이 `ADMIN_API_TOKEN` 과 상수시간 비교(`hmac.compare_digest`).
  `ADMIN_API_TOKEN` 은 기본값 없는 필수 env — 미설정 시 부팅이 실패한다.
  (이전 Firebase Authentication 가드 대체. 데모 게이트일 뿐 강한 보안 경계는 아님.)

## 7. 구동 / 배포

- 로컬: `run_local.ps1` 또는 개별 `uvicorn` + `npm run dev`. 상세 [`LOCAL_RUN.md`](./LOCAL_RUN.md).
- 컨테이너: `docker-compose up`(백엔드, 호스트 8000 → 컨테이너 8080). 프론트는 정적 export(`apps/web/out`)라
  임의 정적 호스트(예: 사내 Nginx, `npx serve`)에 올릴 수 있다.

## 8. 제거된 GCP/Firebase 계층 (참고)

Vertex AI Endpoint·Gemini·텍스트 임베딩, BigQuery/BQML 예보, Cloud Pub/Sub 수집, Dataflow 스트리밍,
Firestore 선호벡터, Secret Manager, Cloud Run, API Gateway, Firebase Hosting, Firebase Authentication,
Google Cloud TTS, 그리고 관련 프로비저닝/배포 스크립트(`deploy.ps1`, `scripts/provision_*`, `dataflow/`,
`openapi-gateway.yaml`, `firebase.json`/`.firebaserc`, GitHub Firebase 워크플로)는 모두 삭제되었다.
