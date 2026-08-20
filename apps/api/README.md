# NextSpot API (FastAPI) — 로컬 백엔드

경주 관광 수요 분산·대안 장소 추천 엔진. 로컬 uvicorn(또는 컨테이너)으로 구동되며, 예측·추천·음성
계층이 모두 로컬에서 동작한다. 데이터 저장소는 Supabase.

> 대회용 GCP 네이티브 계층(Vertex AI Endpoint·BigQuery/BQML·Pub/Sub·Firestore·Secret Manager·
> Cloud Run·API Gateway)은 모두 제거되었다. 기존에 폴백으로 존재하던 로컬 경로를 주 경로로 사용한다.

## 실행

```bash
cd apps/api
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

필수 환경변수(`apps/api/.env`, `.env.example` 복사):
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `JWT_SECRET`, `ADMIN_API_TOKEN`(미설정 시 부팅 실패)
(권장: `SUPABASE_SERVICE_ROLE_KEY` — 관리자 쓰기 경로에 필요 / 선택: `KAKAO_REST_API_KEY`, `ALLOWED_ORIGINS`).

## 계층 구성

| 계층 | 구현 |
|------|------|
| 서비스 | FastAPI + uvicorn (로컬/컨테이너) |
| 저장 | Supabase(PostgreSQL) — 시설·혼잡로그·추천·피드백·선호벡터 |
| 예측 | 검증된 Storage 모델 또는 공개 지역 수요 규칙(임의 0.5 없음) |
| 추천 사유 | 결정적 한국어 템플릿 |
| 음성 의도 | 키워드 분류기 |

모든 보조 경로는 입력이 없거나 모델이 없어도 안전하게 폴백한다(데모 무중단).

## 혼잡 예측 — 검증 모델과 공개 지역 수요

`predict_service.predict_congestion(facility_type, hour, day_of_week) -> float | None`:

```
(a) Registry의 검증된 active 모델  →  (b) None(degraded_rules)
```

- 합성 `model.pkl`과 임의의 0.5는 운영 추론에 사용하지 않는다.
- 모델은 검증된 `verified/corroborated` 관측만 학습한 `OneHotEncoder → Ridge`이며 피처는
  `[facility_type, hour_str, dow_str]`이다.
- 모델이 없을 때는 경주시 ITS 실시간 주차 잔여면과 관광공사 통계가 있는 경우에만
  `area_stats_rules`로 주변 수요 비용을 계산한다. 이는 특정 매장 내부 혼잡도가 아니다.

**모델 학습:**
```bash
cd apps/api
python scripts/train.py    # 검증 관측 → 후보 모델 평가 → Registry/Storage 등록
```
품질 기준을 통과한 active 모델이 없으면 혼잡도·예상 대기시간 숫자를 만들지 않는다.

## 추천 사유 — 템플릿

`reason_service.generate_reason(context)` 가 입력 수치(혼잡도·도보·예상 대기)만으로 한국어 1~2문장
사유를 결정적으로 생성한다(외부 LLM 없음, 환각 0).

## 음성 비서 — 키워드 의도

`POST /api/v1/voice/turn` (무인증) — 발화를 키워드로 분류한다:
`accept / next / reject / details / select(서수 지정) / filter(메뉴·종류) / stop / unknown`.
filter 의 후보 매칭은 `embedding_service.filter_candidates` 가 후보 이름·종류(cuisine)에 대한
부분문자열 매칭으로 결정한다(임베딩/벡터검색 없음).

## 선호 벡터 — Supabase

`preference_vector_service` 가 사용자 8차원 선호 벡터를 Supabase `user_preference_vectors`
테이블에 저장/조회한다(KV). 테이블 미생성/오류 시 프로세스 메모리로 graceful 폴백.
마이그레이션: `supabase/migrations/20260608120000_add_user_preference_vectors.sql`.

## 주요 엔드포인트

- `GET /health` — 헬스 체크
- `GET /api/v1/infrastructures` — 관광 POI 목록 + 최신 혼잡도
- `GET /api/v1/area-demand/status` — 경주시 ITS 실시간 주차 데이터 커버리지
- `POST /api/v1/recommendations` — 혼잡한 원본 장소의 대안 추천(반경 150m)
- `POST /api/v1/recommendations/by-type` — 타입별 랭킹(메인 지도 브라우즈)
- `POST /api/v1/feedback` — 수락/거절 피드백 → 선호 벡터 보정
- `POST /api/v1/preferences/parse` — 자연어 선호 → 구조화(키워드)
- `POST /api/v1/voice/turn` — 음성 1턴 의도 해석(무인증)
- `GET /api/v1/users/me/vector` — 본인 선호 벡터 조회
- `POST /api/v1/admin/simulate-peak` — 데모 피크 혼잡 생성(관리자 토큰)
