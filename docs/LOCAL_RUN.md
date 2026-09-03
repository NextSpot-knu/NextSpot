# 로컬 구동 가이드

NextSpot을 로컬에서 띄우는 방법. 데이터 저장소는 팀 Supabase 프로젝트(원격)를 그대로 쓴다 — 로컬 DB는 없다.
그래서 **실 DB에는 읽기만 한다**는 규칙(`../AGENTS.md` 가드레일)이 로컬 개발에도 그대로 적용된다.

## 1. 전제조건

- Python **3.11** (CI·`apps/api/Dockerfile` 고정). 3.14에서는 고정된 `websockets` 12에 `websockets.asyncio`가 없어
  앱 import가 깨진다. Windows는 `py -3.11`, 또는 venv를 만든다: `py -3.11 -m venv apps/api/.venv`.
- Node **20+** (CI는 22).
- Supabase 프로젝트 자격증명(URL / anon key / service_role key / JWT secret) — 팀 공유 채널에서 받는다.
- (선택) Docker Desktop — 백엔드를 컨테이너로 띄울 때.

## 2. 환경변수 (파일 둘)

### 백엔드 `apps/api/.env` — `apps/api/.env.example` 복사 후 채운다

| 구분 | 키 |
|---|---|
| 필수(없으면 부팅 실패) | `SUPABASE_URL` `SUPABASE_ANON_KEY` `JWT_SECRET` `ADMIN_API_TOKEN` |
| 권장 | `SUPABASE_SERVICE_ROLE_KEY` — 관리자 쓰기·수집·증빙 서명 URL 등 service_role 경로 |
| 선택 | `KAKAO_REST_API_KEY`(장소 검색·화장실) `TOURAPI_KEY` `KMA_API_KEY` `PARKING_API_KEY` `UPSTAGE_API_KEY`(LLM 보조 — 없으면 조용히 비활성) `ALLOWED_ORIGINS`(기본 localhost 3000·3001) |

- `ADMIN_API_TOKEN`은 사람 로그인용이 아니다. pg_cron·GitHub Actions 같은 기계 호출이 `X-Service-Token`으로 보내는
  서비스 토큰이며(`SERVICE_API_TOKEN`이 있으면 그것만 유효), 로컬은 `nextspot-admin-local`로 충분하다.
- CWD가 `apps/api`여야 `.env`가 로드된다.

### 프런트 `apps/web/.env.local` — `apps/web/.env.example` 복사

```text
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
NEXT_PUBLIC_KAKAO_MAPS_APP_KEY=...      # 지도 표시
NEXT_PUBLIC_FASTAPI_URL=http://localhost:8000
```

- `NEXT_PUBLIC_*`는 브라우저 번들에 그대로 들어간다. 서버용 키(Kakao REST 등)나 토큰을 넣지 말 것.
- 관리자·사장님 콘솔용 env는 없다 — 앱 계정으로 로그인하면 서버가 `users.role`로 판정한다.

## 3. 구동

### 방법 A — 헬퍼 스크립트 (Windows, 권장)

```powershell
.\run_local.ps1                # 백엔드(8000) + 프런트(3000) 새 창으로 기동
.\run_local.ps1 -Train         # 먼저 scripts/train.py 로 후보 모델을 만들고(Storage 등록) 기동
.\run_local.ps1 -BackendOnly
.\run_local.ps1 -FrontendOnly
```

스크립트가 인터프리터를 `apps/api/.venv` → `py -3.11` → PATH `python` 순으로 찾고 `PYTHONUTF8=1`을 설정한다.
3.14+가 잡히면 새 창에서 조용히 죽는 대신 즉시 안내와 함께 중단한다.

### 방법 B — 개별 실행

```powershell
# 백엔드 (PowerShell)
cd apps/api; $env:PYTHONUTF8 = "1"
py -3.11 -m pip install -r requirements.txt -r requirements-dev.txt
py -3.11 -m uvicorn app.main:app --reload --port 8000
```

```bash
# 프런트 (다른 터미널) — 루트에서 npm run web:dev 로도 된다
cd apps/web && npm install && npm run dev
```

macOS/Linux는 `py -3.11` 대신 `python3.11`.

### 방법 C — 백엔드 컨테이너

```bash
npm run api:dev      # = docker compose up -d   (호스트 8000 → 컨테이너 8080)
npm run api:stop     # = docker compose down
```

컨테이너는 `apps/api/.env`를 `env_file`로 읽는다 — 루트 `.env`는 필요 없다. 코드는 라이브 마운트라 수정이 바로 반영된다.

## 4. 혼잡 예측 모델

- 운영 추론은 Supabase Storage `recommendation-models`의 **검증된 active 모델**만 쓴다(`MODEL_CARD.md`). 저장소나 로컬에 pkl 파일은 없다.
- 활성 모델이 없으면 `degraded_rules` — 혼잡·대기 항을 산식에서 빼고 취향·이동시간·혜택만 쓴다. 임의의 0.5 예측은 만들지 않는다.
- 학습·후보 등록: `apps/api`에서 `py -3.11 scripts/train.py`. 후보를 만들 뿐이고 승격은 `--promote-version`으로 따로 한다.

## 5. DB 스키마

- **새 프로젝트/초기화** = `supabase/RESET_AND_SETUP.sql` 1회 실행(SQL Editor). 시드 POI는 대부분 비활성(`unverified_demo_seed`)이라
  실제 장소는 `apps/api/scripts/ingest_tourapi.py`(`TOURAPI_KEY` 필요)로 채운다.
- **기존 프로젝트** = `supabase/migrations/` 미적용분만 적용. 무엇이 적용됐는지는 [`HANDOVER.md`](./HANDOVER.md) "마이그레이션 확인" 쿼리로
  실측한다(원격에 파일 순서와 다르게 적용된 이력이 있다). 적용 후 `NOTIFY pgrst, 'reload schema';`.
- `RESET_AND_SETUP.sql`은 자동 생성물 — 직접 수정 금지(`node scripts/build_reset.mjs`).

## 6. 스모크 테스트

```bash
curl http://localhost:8000/health
curl http://localhost:8000/api/v1/infrastructures
curl http://localhost:8000/api/v1/area-demand/status        # 경주 ITS 실측 커버리지

# 음성 1턴(무인증) — 키워드 분류 동작 확인
curl -X POST http://localhost:8000/api/v1/voice/turn -H "Content-Type: application/json" \
  -d '{"utterance":"양식 먹고 싶어","facility_type":"restaurant","candidates":[{"id":"a","name":"이탈리아노","cuisine":["양식"]},{"id":"b","name":"한밥","cuisine":["한식"]}]}'
```

관리자 전용 엔드포인트(`/api/v1/admin/*`, 데모 피크 생성 등)는 admin 역할 계정의 Supabase JWT가 필요하다 —
브라우저에서 `/admin/login`으로 로그인해 시험한다. 프런트(`http://localhost:3000`)에서 지도·추천·음성 비서가 동작하면 성공.

## 7. 참고

- 정적 export 빌드(`apps/web`에서 `npm run build`)는 `apps/web/out/`을 만든다. `next start`는 export 모드에서 쓰지 않는다.
- LLM(Upstage Solar)은 `UPSTAGE_API_KEY`가 있을 때만 보조로 붙고, 없거나 타임아웃·오류면 결정적 경로(템플릿 사유·키워드 의도)로 돌아간다.
- 검증 게이트 전체 목록은 `../AGENTS.md`.
