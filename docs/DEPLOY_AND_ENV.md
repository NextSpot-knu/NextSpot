# 배포 & 환경변수

배포 대상 3곳(Supabase · Render · Vercel)과 GitHub Actions에 **어떤 이름의 값이 어디에 있어야 하는지**의 정본.
값은 여기 적지 않는다 — 이름만. 지금 무엇이 배포돼 있는지는 [`HANDOVER.md`](./HANDOVER.md).

## 0. 한눈에

| 구성 | 무엇 | 트리거 |
|---|---|---|
| Web | Vercel. 루트 `vercel.json`이 `npm run build --workspace=apps/web` → `apps/web/out` | `main` push 자동 |
| API | Render Blueprint `render.yaml` (docker, `apps/api/Dockerfile`, healthCheck `/health`) | `main` push 자동 |
| DB · Auth · Storage | Supabase 팀 프로젝트 | 마이그레이션은 사람이 적용 |
| 10분 주차 실측 수집 | Supabase pg_cron → `POST /api/v1/area-demand/snapshots/collect` | 자동 |
| 10분 서울 검증 수집 | Supabase pg_cron → `POST /api/v1/engine-validation/seoul/collect` (마이그레이션 `20260920121000`) | 자동 — 사람이 예약 SQL 적용 후 |
| 수집 중단 감시 | GitHub Actions `area-demand-alert.yml` → Supabase PostgREST `area_demand_snapshots` 최신 행(Supabase 시크릿이 없으면 예전처럼 `GET /api/v1/admin/area-demand-reliability`) | 매시 28분 예약 (`main`에서만, GitHub 스케줄러 best-effort — 실측 3~6시간 간격) |
| TourAPI 적재 | GitHub Actions `ingest.yml` | 매일 KST 04:00 (`main`에서만). 목록 호출이 일시 오류로 끝나면(exit 75, 상세 조회 전) 새 러너로 최대 2회 자동 재실행. 실패는 실패한 실행(스케줄 실패 메일·실행 Summary)으로 확인 — 다시 돌릴 때는 Re-run 대신 Run workflow(`auto_retry` 비움) |
| 모델 학습 후보 | GitHub Actions `train-recommendation-model.yml` | 매주 월 03:00 KST (`main`에서만) |

## 1. Supabase

### 1-1. 스키마

- **새 프로젝트**: `supabase/RESET_AND_SETUP.sql` 전체를 SQL Editor에 붙여넣고 1회 Run. 되돌릴 수 없다(전부 DROP 후 재생성).
  시드 POI는 대부분 비활성(`unverified_demo_seed`)이라 실제 장소는 `ingest_tourapi.py` 적재로 채운다.
- **기존 프로젝트**: `supabase/migrations/` 미적용분만 적용 → `HANDOVER.md` "마이그레이션 확인" 쿼리로 실측 →
  `NOTIFY pgrst, 'reload schema';`(PostgREST 스키마 캐시 갱신 — 빼먹으면 새 컬럼을 한동안 못 본다).
- `RESET_AND_SETUP.sql`은 자동 생성물 — 직접 수정 금지.

### 1-2. Auth

- Authentication → URL Configuration: **Site URL** = `https://nextspot-nu.vercel.app`,
  **Redirect URLs** = `https://nextspot-nu.vercel.app/auth/callback`, `http://localhost:3000/auth/callback`
  (OAuth와 비밀번호 재설정 메일이 같은 콜백을 쓴다. `/auth/reset-password`는 내부 이동이라 등록 불필요).
- **Allow anonymous sign-ins = ON** — 게스트 세션이 이걸 쓴다. 꺼지면 수락·쿠폰·코스·제보가 401 폴백 상태가 된다.
- **Rate Limits → anonymous users = 300/h per IP**(기본 30, 2026-10-06 사용자 상향). 첫 방문·시크릿 창마다 익명 로그인 1회를 쓰므로,
  같은 사무실 IP 의 심사위원 몇 명이 30을 넘기면 그 IP 의 `/waiting` 이 한 시간 가까이 빈 화면이 된다(10-02 실측 — 6분에 약 18회로 429).
- Providers: Google(동의 화면 게시 필요), Kakao(비즈 앱 전환 전까지 `account_email` 스코프 오류 — `HANDOVER.md` 사람 작업).

### 1-3. Storage (비공개 버킷 2개)

- `recommendation-models` — 모델 아티팩트(`train.py`가 올리고 `model_registry`가 active 한 건을 가리킨다).
- `business-documents` — 사업자등록증 증빙(마이그레이션 `20260904200000`이 생성, 서명 URL로만 접근).

### 1-4. Vault + pg_cron — 10분 주차 실측 수집

- Vault 비밀 2개: `nextspot_area_demand_api_url`(수집 API 전체 주소), `nextspot_area_demand_admin_token`
  (Render의 `SERVICE_API_TOKEN`과 같은 값 — 없으면 `ADMIN_API_TOKEN`).
- pg_cron은 이 토큰을 `X-Admin-Authorization: Bearer <토큰>` 헤더로 보낸다(마이그레이션 `20260824130000`). API는 정식 헤더
  `X-Service-Token`(GitHub Actions가 사용)과 둘 다 받는다(`app/core/authz.py`).
- 최초 설정·회전은 service-role 전용 RPC `configure_area_demand_collection`으로 한다. 값을 마이그레이션에 적지 않는다.
- `cron.job`: `nextspot-area-demand-primary`(매시 3·13·…·53분), `nextspot-area-demand-retry`(6·16·…·56분, 버킷이 비었을 때만).
- 서울 검증 수집(마이그레이션 `20260920121000`, 사람이 적용): Vault 비밀 `nextspot_seoul_citydata_api_url` 하나만 추가하고
  토큰은 위 `nextspot_area_demand_admin_token`을 같이 쓴다. 설정 `select public.configure_seoul_citydata_collection('<수집 URL>');`.
  `cron.job`: `nextspot-seoul-citydata-primary`(4·14·…·54분), `nextspot-seoul-citydata-retry`(9·19·…·59분, 버킷이 비었을 때만).
- ⚠️ **pg_cron 은 `net.http_post` 로 발사 후 잊는다.** API 가 401·500 을 줘도
  `cron.job_run_details` 에는 `succeeded` 로 남으므로 **'cron 이 돌았다' 는 수집이 살아 있다는
  증거가 아니다.** 실제 응답은 `net._http_response` 에 있고, 수집이 멈췄는지는
  `area-demand-alert.yml` 이 확인한다(매시 예약이지만 실제 간격은 몇 시간. 새 스냅샷이 실제로 쌓였는가 하나만 본다 —
  토큰 불일치·Render 다운·cron 해제·Supabase 정지를 원인과 무관하게 잡는다).
  멈춘 것을 확인했다면:
  ```sql
  select id, status_code, left(coalesce(error_msg, content), 200), created
    from net._http_response order by created desc limit 10;   -- 401 이면 토큰 불일치
  select jobname, active from cron.job where jobname like 'nextspot-area-demand%';
  select public.configure_area_demand_collection('<수집 URL>', '<현재 토큰>');  -- 토큰 재설정
  ```
  확인: `cron.job.active`, `cron.job_run_details`, `area_demand_snapshots` 증가.

## 2. Render — API

1. Render → New → **Blueprint** → `NextSpot-knu/NextSpot` 연결 → `render.yaml` 인식 → 서비스 `nextspot-api`.
2. env는 전부 `sync: false`라 **대시보드에서 직접 입력**한다.

| 구분 | 키 |
|---|---|
| 부팅 필수 | `SUPABASE_URL` `SUPABASE_ANON_KEY` `JWT_SECRET` `ADMIN_API_TOKEN` |
| 운영 필수(없으면 기능 결손) | `SUPABASE_SERVICE_ROLE_KEY`(쓰기 경로 전부) `ALLOWED_ORIGINS`(미지정 시 와일드카드) |
| 선택 | `SERVICE_API_TOKEN`(토큰 회전용 — `render.yaml`에 없으니 대시보드에서 추가) `TOURAPI_KEY` `KMA_API_KEY` `PARKING_API_KEY` `GYEONGJU_FOOD_API_BASE_URL` `GYEONGJU_FOOD_API_KEY`(경주 메뉴별음식점 15114465 — 둘 다 없으면 보강 배치 no-op) `SEOUL_OPENDATA_KEY`(서울 검증 수집 — 없으면 그 수집만 503) `SEOUL_CITYDATA_TARGETS`(기본 `홍대 관광특구`, 콤마 구분) `KAKAO_REST_API_KEY` `UPSTAGE_API_KEY` `LLM_BASE_URL` `LLM_MODEL` `SEARCH_REWRITE_DAILY_BUDGET` |
| 선택 — 전환 스위치 | `AREA_DEMAND_SOURCE`(권역 수요 전망 원본. 기본·미설정·모르는 값 = `rpc`(도입 전 경로 그대로 — 주차 이력 적재 스레드도 없음), `shadow` = 응답은 rpc·메모리 행렬 비교만 기록, `matrix` = 메모리 행렬로 답하고 준비 전·오래됨이면 rpc. 바꾸면 서비스 재시작 1~2분 — 되돌림도 `rpc` 로 다시 설정. 순서·게이트·볼 것: [`API_ARCHITECTURE_PLAN.md`](./API_ARCHITECTURE_PLAN.md) "P2a 전환 절차") |
| 선택 — 되돌림 스위치 | `WALKING_ROUTE_KERNEL`(보행 경로 계산. 기본·미설정·모르는 값 = `memo`(목적지 스냅을 그래프에 기억하고 예열 때 시설 전체를 미리 스냅 — 경로·분·거리는 `legacy` 와 비트 동일), `legacy` = 도입 전 코드 그대로, `csr` = 압축 그래프(커밋된 `app/data/gyeongju_walking_graph.csr.bin`, 살아 있는 1.7MB·적재 피크 3.3MB — dict 그래프 16.7MB·27MB 대신, 부팅 때 시설 사전 스냅, 경로는 `legacy` 와 비트 동일 — 원본 .json.gz 를 바꾸면 `scripts/build_walking_graph.py --emit-csr` 로 함께 다시 만든다). 바꾸면 서비스 재시작 1~2분. memo 는 부팅 때 사전 스냅을 하지 않으므로 배포 직후 `/api/v1/warmup` 한 번이면 첫 by-type·추천부터 빠르다) |

- `ALLOWED_ORIGINS`에 Vercel 도메인(콤마 구분)을 넣으면 **엄격 모드**(해당 오리진만 + credentials)로 전환된다. 미지정이면 와일드카드.
- `ADMIN_API_TOKEN`은 `openssl rand -hex 32` 같은 강한 값. 절대 `NEXT_PUBLIC_*`로 프런트에 미러하지 않는다.
- 배포 후 `https://nextspot-api.onrender.com/health` 200 확인. 무료 티어라 콜드스타트가 있고 `main.py`가 워밍업 4단계를 돈다.

## 3. Vercel — Web

1. Vercel → Add New → Project → `NextSpot-knu/NextSpot` import.
2. **Root Directory는 비워 둔다.** 루트 `vercel.json`이 워크스페이스 빌드를 정의한다 — `apps/web`으로 잡으면 공유 패키지가 안 보여 빌드가 깨진다.
3. Environment Variables:

| 키 | 값 출처 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 프로젝트 API 설정 |
| `NEXT_PUBLIC_KAKAO_MAPS_APP_KEY` | Kakao 개발자 콘솔 JavaScript 키 |
| `NEXT_PUBLIC_FASTAPI_URL` | `https://nextspot-api.onrender.com` |
| `NEXT_PUBLIC_SITE_URL` | `https://nextspot-nu.vercel.app` (OG 이미지 절대 URL) |
| `NEXT_PUBLIC_DEMO_CONTROLS` | 운영은 미설정. `1`이면 메인 지도에 시연용 내부 컨트롤 표시 — 데모 프리뷰 배포에서만 |

- 관리자·사장님 콘솔용 env는 없다(앱 계정 로그인 + `users.role`). 토큰·비밀번호를 `NEXT_PUBLIC_*`에 넣지 않는다.
- Kakao 개발자 콘솔 → 플랫폼 → Web 도메인에 Vercel 도메인(커스텀 도메인 포함)을 등록해야 지도가 렌더링된다.
- `main` push마다 프로덕션 배포, 다른 브랜치는 프리뷰 배포. 로컬로 값 가져오기: `npx vercel env pull apps/web/.env.local`.

## 4. GitHub Actions

| 종류 | 이름 | 쓰는 워크플로 |
|---|---|---|
| Secret | `SUPABASE_URL` `SUPABASE_ANON_KEY` `SUPABASE_SERVICE_ROLE_KEY` | ingest · train · area-demand-alert(`SUPABASE_URL`·`SUPABASE_SERVICE_ROLE_KEY` — 스냅샷 표 직접 확인) |
| Secret | `JWT_SECRET` `ADMIN_API_TOKEN` | train(부팅 검증 — 없으면 실패. ingest는 플레이스홀더로 대체) |
| Secret | `TOURAPI_KEY` | ingest(없으면 TourAPI 단계 skip) |
| Secret | `KAKAO_REST_API_KEY` | ingest(Kakao 장소 보완 · 좌표 대조) |
| Secret | `LOCALDATA_AUTH_KEY` (선택) | ingest(공공 인허가 변경분 동기화) |
| Secret | `SERVICE_API_TOKEN` (선택) | collect-area-demand · area-demand-alert(Supabase 시크릿이 없을 때만. 없으면 `ADMIN_API_TOKEN`) |
| Variable | `BACKEND_HEALTH_URL` | uptime · collect-area-demand · area-demand-alert(Supabase 시크릿이 없을 때만) |
| Variable | `AREA_DEMAND_COLLECTION_ENABLED=true` | collect-area-demand |
| Variable | `AREA_DEMAND_ALERT_ALLOW_EMPTY=true` (새 환경만) | area-demand-alert(스냅샷 표가 비어도 통과 — 운영에는 두지 않는다) |
| Secret | `GYEONGJU_FOOD_API_KEY` (선택) | ingest(경주 메뉴별음식점 보강 — `GYEONGJU_FOOD_ENABLED=true` 일 때만) |
| Variable | `KAKAO_PLACE_DISCOVERY_ENABLED` `TOURAPI_INSIGHTS_ENABLED` `TOURAPI_RELATED_ENABLED` `GYEONGJU_FOOD_ENABLED` `GYEONGJU_FOOD_API_BASE_URL` (선택) | ingest의 게이트된 단계 |
| Variable | `GYEONGJU_CITY_PHOTO_ENABLED=true` (선택) | ingest(경주 음식점 보강이 사진 없는 음식점에 경주시 사진을 넣는다 — 웹의 '사진: 경주시' 출처가 배포된 뒤에만 켠다. 꺼져 있어도 걷기는 한다) |

`schedule`은 `main`에서만 발화한다. 다른 브랜치에서는 Actions 탭 → Run workflow.

## 5. 브랜치 전략

- `main` = 프로덕션(위 자동 배포 + cron 발화). 각자 브랜치에서 작업하고 게이트 통과 후 `git push origin <내-브랜치>:main`(fast-forward).
- 로컬 개발은 [`LOCAL_RUN.md`](./LOCAL_RUN.md).
