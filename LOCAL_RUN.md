# 로컬 구동 가이드 (LOCAL_RUN)

InduSpot 을 **추가 클라우드 없이 로컬에서** 구동하는 방법입니다. 데이터 저장소만 Supabase(비-GCP)를 사용합니다.

## 1. 전제조건

- Python **3.11+**, Node **18+** (PATH 등록)
- (선택) Docker Desktop — 백엔드를 컨테이너로 띄울 때
- Supabase 프로젝트 자격증명(URL / anon key / service_role key / JWT secret)

## 2. 환경변수

### 백엔드 `apps/api/.env`  (`apps/api/.env.example` 복사)
```
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
JWT_SECRET=...
ADMIN_API_TOKEN=induspot-admin-local   # 프론트 admin-auth.ts SESSION_TOKEN 과 동일
ALLOWED_ORIGINS=http://localhost:3000
```
> `JWT_SECRET` 은 비어 있으면 부팅이 실패합니다(의도된 fail-fast). Supabase 프로젝트의 JWT Secret 을 넣으세요.

### 프론트 `apps/web/.env.local`  (`apps/web/.env.example` 참고)
```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
NEXT_PUBLIC_KAKAO_MAPS_APP_KEY=...      # 지도 표시에 필요
NEXT_PUBLIC_FASTAPI_URL=http://localhost:8000
```

## 3. 구동

### 방법 A — 헬퍼 스크립트 (Windows, 권장)
```powershell
.\run_local.ps1            # 백엔드(8000) + 프론트(3000) 새 창으로 기동
.\run_local.ps1 -Train     # 로컬 예측 모델 학습 후 기동
.\run_local.ps1 -BackendOnly
.\run_local.ps1 -FrontendOnly
```

### 방법 B — 개별 실행
```bash
# 백엔드
cd apps/api
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# 프론트 (다른 터미널)
cd apps/web
npm install
npm run dev
```

### 방법 C — 백엔드 컨테이너
```bash
docker-compose up --build      # 루트 .env 의 SUPABASE_*/JWT_SECRET 을 자동 치환, 호스트 8000
```

## 4. 혼잡 예측 모델 (선택)

```bash
cd apps/api
python scripts/train.py        # Supabase 혼잡 로그 → sklearn Ridge → apps/api/model.pkl
```
- `model.pkl` 이 있으면 `/predict` 및 추천의 도착시점 혼잡 예측이 실제 모델을 사용합니다(`source=local`).
- 없으면 모든 예측이 **0.5(중간)** 로 폴백합니다(`source=default`). 서버는 정상 기동되며 추천 순위는 선호/거리/혼잡분산으로 변동합니다.

## 5. 선호 벡터 테이블 (Supabase 마이그레이션)

선호 학습 영속화를 위해 마이그레이션을 적용하세요:
`supabase/migrations/20260608120000_add_user_preference_vectors.sql`
(Supabase CLI `supabase db push` 또는 SQL 편집기로 실행). 미적용 시 선호 벡터는 프로세스 메모리로
폴백되어 재시작 시 초기화됩니다(앱은 정상 동작).

## 6. 스모크 테스트

```bash
curl http://localhost:8000/health
curl http://localhost:8000/api/v1/infrastructures

# 음성 1턴(무인증) — 키워드 분류 동작 확인
curl -X POST http://localhost:8000/api/v1/voice/turn \
  -H "Content-Type: application/json" \
  -d '{"utterance":"양식 먹고 싶어","facility_type":"cafeteria","candidates":[{"id":"a","name":"이탈리아노","cuisine":["양식"]},{"id":"b","name":"한밥","cuisine":["한식"]}]}'

# 관리자 데모 피크 생성
curl -X POST http://localhost:8000/api/v1/admin/simulate-peak \
  -H "Authorization: Bearer induspot-admin-local"
```

프론트(`http://localhost:3000`)에서 지도/추천/음성 비서(브라우저 TTS)와 관리자 시뮬레이트 버튼이 동작하면 성공입니다.

## 7. 참고

- 외부 LLM/GCP 호출은 없습니다. 추천 사유는 템플릿, 음성 의도/메뉴 검색은 키워드 매칭입니다.
- 정적 프론트 빌드(`cd apps/web && npm run build`)는 `apps/web/out/` 을 생성하며, 임의 정적 호스트
  (예: `npx serve apps/web/out`, 사내 Nginx)에 올릴 수 있습니다.
