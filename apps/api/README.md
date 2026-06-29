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
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`
(선택: `ADMIN_API_TOKEN`, `KAKAO_REST_API_KEY`, `ALLOWED_ORIGINS`).

## 계층 구성

| 계층 | 구현 |
|------|------|
| 서비스 | FastAPI + uvicorn (로컬/컨테이너) |
| 저장 | Supabase(PostgreSQL) — 시설·혼잡로그·추천·피드백·선호벡터 |
| 예측 | 로컬 scikit-learn 모델 `model.pkl` (없으면 0.5 폴백) |
| 추천 사유 | 결정적 한국어 템플릿 |
| 음성 의도 | 키워드 분류기 |

모든 보조 경로는 입력이 없거나 모델이 없어도 안전하게 폴백한다(데모 무중단).

## 혼잡 예측 — 로컬 모델

`predict_service.predict_congestion(facility_type, hour, day_of_week) -> float` 폴백:

```
(a) 로컬 model.pkl  →  (b) 0.5(default)
```

- 사용 경로는 로그에 `source=local|default` 로 남는다.
- 모델은 sklearn `OneHotEncoder → Ridge` 이며 피처는 `[facility_type, hour_str, dow_str]`.

**모델 학습:**
```bash
cd apps/api
python scripts/train.py    # Supabase facilities + congestion_logs → model.pkl
```
`model.pkl` 이 없으면 모든 예측이 0.5(중간)로 폴백한다. 추천 순위는 선호/거리/혼잡분산으로 변동.

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
- `POST /api/v1/recommendations` — 혼잡한 원본 장소의 대안 추천(반경 150m)
- `POST /api/v1/recommendations/by-type` — 타입별 랭킹(메인 지도 브라우즈)
- `POST /api/v1/feedback` — 수락/거절 피드백 → 선호 벡터 보정
- `POST /api/v1/preferences/parse` — 자연어 선호 → 구조화(키워드)
- `POST /api/v1/voice/turn` — 음성 1턴 의도 해석(무인증)
- `GET /api/v1/users/me/vector` — 본인 선호 벡터 조회
- `POST /api/v1/admin/simulate-peak` — 데모 피크 혼잡 생성(관리자 토큰)
