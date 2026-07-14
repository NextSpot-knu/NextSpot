# 세션 인계 문서 (2026-07-15 갱신)

> 현재 상태 스냅샷 + 다음 단계. 브랜치 `feature/jinseok` (origin 동기화).
> 자율 개선 세션 로그·재개 규칙: [`AUTONOMOUS_SESSION.md`](./AUTONOMOUS_SESSION.md) · 전략: [`CONTEST_STRATEGY.md`](./CONTEST_STRATEGY.md)

## -3. 2026-07-15 — main 의미 병합 + Vercel 프로덕션 개통

- **델타 SQL 적용 완료(사람)** — supabase/APPLY_DELTA_20260714.sql 실행됨. E2 백업 영상은 pass 결정.
- **main 병합** (`b6598a0`) — 승용님 리팩터(69b620c, 죽은 코드·타이핑·헬퍼 통합)를 feature/jinseok 에
  의미 병합(충돌 20파일: 기능=ours, 리팩터 의도 중 유효분만 재적용). main 은 fast-forward 로 동기화
  (`git push origin feature/jinseok:main`) — **이후 main 이 프로덕션 정본, D1 cron 발화 조건 충족**.
- **Vercel 배포 원인 2건 해소**: ① 프로덕션 브랜치(main)가 70+커밋 뒤라 프로덕션 배포 0건 → main 동기화로 해소.
  ② env 부재 → `NEXT_PUBLIC_SUPABASE_URL`·`SUPABASE_ANON_KEY`·`KAKAO_MAPS_APP_KEY` 3종을 production+preview 에 등록(CLI).
  `NEXT_PUBLIC_FASTAPI_URL` 은 Render 미배포로 보류 — Render Blueprint 적용(§6-1) 후 추가할 것.
- **남은 사람 작업**: Kakao 개발자콘솔 Web 도메인에 Vercel 프로덕션 도메인 등록(미등록 시 지도 미렌더),
  Render Blueprint + FASTAPI_URL env, GitHub Actions Secrets(D1 cron 용).

## -2. 2026-07-14 사이클 — A2·D1·D5·A4 + 발표 산출물

- **A2 상세카드 확장** (`5d0e51f`) — detailCommon 상세 필드(개요·홈페이지·주소·전화) 마이그레이션
  (`20260713090000_add_detail_common_fields.sql`, **Supabase 미적용 — 사람 작업**) + 추천 카드 상세 표시 + i18n.
- **D1 TourAPI 일배치 인제스트** (`5d0e51f`) — `.github/workflows/ingest.yml`, 매일 KST 04:00 upsert.
  ⚠️ schedule 은 main 브랜치에서만 발화 — 머지 전엔 workflow_dispatch 수동 실행.
  **사람 작업**: GitHub Actions Secrets 4종(TOURAPI_KEY·SUPABASE_URL·SUPABASE_ANON_KEY·SERVICE_ROLE_KEY) 등록.
- **D5 데이터 신선도** (`5d0e51f`) — `GET /api/v1/freshness`(app_events `tourapi_sync` 마커 정본 →
  updated_at 추정 폴백) + 관리자 DataFreshnessBadge.
- **A4 행사 혼잡 보정** (`06fd55a`) — `services/event_boost.py`: 당일 진행 축제 거리감쇠 가중
  (MAX_BOOST 0.15 × (1−거리/1.5km), 성공 1h·실패 10분 캐시). score.py 도착시점 예측 + `/predict/batch`
  양쪽 반영, breakdown `event_boost`/`event_title`, 추천 카드 🎪 배지(4로케일).
  테스트 격리: tests/conftest.py autouse 픽스처가 TourAPI 조회 차단(로컬 실키 오염 방지).
- **발표 산출물** (`cb9cf07`) — [`DEMO_SCENARIO.md`](./DEMO_SCENARIO.md)(E1, 관광객/관리자 각 3분 대본+체크리스트+폴백),
  [`JUDGE_QA.md`](./JUDGE_QA.md)(E4, 예상 질문 10문+답변), [`TIMELINESS.md`](./TIMELINESS.md)(C2, 검증 보도 8건).
- **E3 지표 리얼리티** — 대시보드 '③ 분산 효과' 30일 차트를 실측 전환: 신규 `GET /api/v1/admin/metrics/trend`
  (congestion_logs 일평균 혼잡도 + recommendations 일별 수락률, KST 일 단위·결측일 null 센티넬·20k 캡 truncated 플래그).
  프런트는 혼잡 표본일 ≥3이면 '실측 집계(30일)' 모드(반사실 '도입 전' 계열 제거), 미만이면 기존 데모 폴백
  — 어느 쪽인지 차트 라벨로 구분(정직성 원칙). 로컬 실데이터 기준 표본 4일 → 실측 모드 동작 확인.
- **E1/E4 기술 리허설 반영** — 로컬 실서버·실DB로 데모 대본 전 구간 자동 검증(DEMO_SCENARIO §4 로그).
  ✅ 페이지 8종·익명 인증 ON·추천 5건·A4 축제 배지 실발동(진행 중 실축제, ~08-17)·모델 재학습
  (MAE 0.0802 vs 기준선 0.2159, R²=0.73 — model-info 배지 라이브)·분산 추이 실측 모드.
  ❌ **데모 블로커 2건 실증**: simulate-peak 500 + 쿠폰 무음 미발급 — 원인은 미적용 마이그레이션 5종.
  **사람 작업(최우선·1회 붙여넣기)**: [`supabase/APPLY_DELTA_20260714.sql`](../supabase/APPLY_DELTA_20260714.sql)
  을 SQL Editor에서 Run → simulate-peak·쿠폰 발급 재검증. JUDGE_QA Q2(실측 MAE)·Q9(E3 완료) 갱신됨.
- **freeze 전 최종 버그 스윕(2026-07-14 오후)** — 6차원 병렬 감사(백엔드/프런트 최근 커밋·에러 상태 B8·데모 대본 추적·PWA sw 스테일·관리자 전수) + 발견별 회의적 검증. 5차원 발견 0건, **확정 demo-blocker 1건 수정**(`42e47e0`): 축제 🎪 배지가 explore/recommend 에만 렌더되고 관광객 데모 화면(/main RecommendationCard)엔 부재 → recToSpot 이 breakdown.eventBoost/eventTitle 보존, 카드에 동일 배지 블록(기존 4로케일 키 재사용). i18n 패리티 스크립트 점검 4로케일 414키 일치. 랜딩 능선 실루엣 SVG 커밋(`747fdcd`).
- **검증 스냅샷**: pytest 118 passed · ruff clean · tsc/next build(정적 export) · RESET 패리티 일치 (스윕 후 재확인).
- **다음 큐**: **코드 freeze 발효(버그픽스만)**. 잔여는 전부 사람 작업 — ① supabase/APPLY_DELTA_20260714.sql 적용 후 블로커 2건(simulate-peak·쿠폰) 재검증 ② E2 백업 영상 녹화.

## -1. TourAPI 실연동 (2026-07-10 · 키 검증 완료)
- **TOURAPI_KEY 발급·검증 완료** — `apps/api/.env`(gitignore)에 Decoding 키 저장. dry-run(목록+`--details` 상세)으로
  실 경주 POI·영업시간·배리어프리 수신 확인. ⚠️ 백엔드 스크립트는 반드시 `py -3.11`(시스템 python3.14 는 httpx 비호환).
- **축제 기능 신설** — `GET /api/v1/events`(routers/events.py) + 메인 지도 축제 칩·바텀시트(components/FestivalBanner.tsx).
  키 미설정/장애 시 `source="unavailable"` 빈 목록 → 프런트 칩 자동 숨김(무해 폴백). 실데이터: 신라문화제 등 2건 확인.
- **⚠️ KorService2 함정(실측)**: `searchFestival2` 는 구 `areaCode` 를 **조용히 무시**(0건) — 법정동 코드
  `lDongRegnCd=47`(경북)+`lDongSignguCd=130`(경주) 를 써야 한다. `areaBasedList2` 는 legacy 도 동작(둘 다 유지).
- **Supabase 연결 + 실적재 완료(2026-07-10)** — 프로젝트 ref `epqdxkipwyy…` 아님 주의: `epqdxkydhptlivecwfwu`(ACTIVE).
  URL/anon/service_role 키는 `apps/api/.env` + `apps/web/.env.local` 에 기록됨(CLI 로 조회, 채팅 미노출).
  **실적재 결과: facilities 85행 = TourAPI 실데이터 69(음식점34·카페13+α·관광지·문화) + 시드 16.**
  운영시간 67건·이미지 63건(전부 https)·배리어프리 2건(천마총·김유신묘). contentid 부분 유니크 인덱스는
  PostgREST on_conflict 미지원 → 스크립트가 SELECT 후 INSERT/UPDATE 폴백으로 처리(정상 설계).
- **남은 사람 작업**: ① 최신 3개 마이그레이션 적용 — 대시보드 SQL Editor 에 리포 루트 `supabase_delta.sql`(임시,
  미커밋) 붙여넣기 실행(user_coupons·timestamp 인덱스·handle_new_user 트리거, 전부 멱등) 또는 `supabase link`+`db push`.
  ② 대시보드 JWT Secret → `apps/api/.env` `JWT_SECRET=`. ③ Authentication → "Allow anonymous sign-ins" ON.

## 0. 미완성 기능 완성 (실배포 관점 · tip `148bff0`)
- **관광객 인증 완성** — Supabase 익명 세션 무마찰 자동 로그인(로그인 UI 없이 per-device 세션) + 신규 유저 `public.users` 자동생성 트리거(`20260710160000_handle_new_user.sql`) + 세션 지속. 개인화(추천·코스·쿠폰·저장·제보) 401 블로커 해소.
- **마이페이지 스텁 실동작화** — 설정(`/mypage/settings`: 언어·알림·저장초기화·앱정보)·개인정보(`/mypage/privacy`)·프로필 수정(로컬 저장)·헤더 메뉴/벨.
- **메인 음성 검색(STT)** — 검색바 마이크 실동작(ko-KR, 미지원 폴백).
- **관리자 인프라 3종** — 수동 혼잡도 Override(신규 `POST /api/v1/admin/facilities/{id}/congestion`)·시설 검색·이상 알림 벨.

### ⚠️ 활성화에 필요한 사람 작업 (안 하면 무해하게 목업 폴백)
1. **인증:** Supabase Dashboard → Authentication → "Allow anonymous sign-ins" 켜기 + `supabase db push`(트리거 마이그레이션 적용).
2. **실데이터(TourAPI):** ① 국문 관광정보 서비스(data.go.kr `15101578`) → `apps/api/.env`의 `TOURAPI_KEY` → 기존 POI·축제 즉시 동작. ② 관광지별 혼잡도(방문자 집중률, `api.visitkorea.or.kr`) → 실혼잡 데이터(`congestion_logs.source='tour_api'`)로 SPOT/코스 격상(승인 후 client.py 연동 예정). 선택: 무장애(15101897)·연관 관광지(15128560).

## 1. 이번 사이클에 추가/개선된 것 (전부 커밋·푸시됨)

**성능/UX 최적화**
- 관리자 대시보드: 병렬 슬라이스 로딩 + 섹션 스켈레톤(전면 스피너 제거), 서버측 집계 `GET /api/v1/admin/dashboard/today`(12k행 클라 집계 제거)
- `congestion_logs(timestamp DESC)` 인덱스 — timestamp 범위조회 최적화
- 로그인 첫 페인트 개선(불필요 isMounted 게이트 제거)
- 메인 지도 초기 로딩: `/api/v1/infrastructures` 단일 호출(시설별 최신 혼잡 서버 조인) + supabase 폴백 병렬화
- 주 내비게이션 반응형: PC 왼쪽 세로 레일 / 모바일 하단 바
- 예측 시점 **슬라이더 바**(지금·+1~3h, 드래그 놓을 때 커밋)

**신규 관광객 기능**
- 최적 방문 시각: `GET /predict/day` + 추천 카드 24시간 미니 막대(최한산 시각 하이라이트)
- 분산 코스(멀티스톱 동선): `POST /api/v1/courses/recommend` + `/course` 페이지(타임라인) + 공유 버튼
- 혼잡 제보(크라우드소싱): `POST /api/v1/reports/congestion`(service_role 기록, 5분 쿨다운 레이트리밋) + 카드 제보 버튼(portal 모달)
- 내 쿠폰함(인센티브 지갑): `user_coupons` 테이블 + `GET /coupons/mine`·`POST /coupons/issue`·`POST /coupons/{id}/use`. **수락 시 서버측 자동 발급** → 지갑에서 사용까지 폐루프
- 배리어프리 필터(♿): 지도에서 무장애 시설만 표시(top-level 컬럼 + features 둘 다 인식)
- 인앱 한산 알림(옵트인): 저장한 곳이 한산해지면 로컬 Notification(visibility-aware 폴링)
- 공유(Share): Web Share API + 클립보드 폴백
- 다국어(i18n): 클라이언트 사전(ko/en/ja/zh), `useT()`, 랜딩·마이 언어 스위처 — 핵심 관광객 UI 전면 치환

## 2. 신규 엔드포인트 (전부 FastAPI, main.py 등록됨)
`/predict/day` · `POST /api/v1/courses/recommend` · `POST /api/v1/reports/congestion` ·
`GET /api/v1/coupons/mine` · `POST /api/v1/coupons/issue` · `POST /api/v1/coupons/{id}/use` ·
`GET /api/v1/admin/dashboard/today` (관리자)

## 3. 스키마
- 신규 마이그레이션 `20260710120000_add_congestion_timestamp_index.sql`, `20260710130000_add_user_coupons.sql`
- RESET_AND_SETUP.sql 은 자동 생성(직접 수정 금지 — 변경 시 `node scripts/build_reset.mjs` 후 파리티 확인)
- 사람이 할 일: `supabase db push`(신규 마이그레이션 적용) — user_coupons·index 반영 전까지 쿠폰/최적화 미적용

## 4. 검증 (CI 게이트)
```
cd apps/web && npx tsc --noEmit && npm run build            # 21 static routes
PYTHONUTF8=1 py -3.11 -m pytest apps/api -q                 # 118 passed
(cd apps/api && py -3.11 -m ruff check .)                   # clean
node scripts/build_reset.mjs && git diff --exit-code supabase/RESET_AND_SETUP.sql  # parity
```

## 5. 알려진 한계 / 다음 작업
- 코스 SPOT 점수 하위항이 단일 leg 시간 사용(누적 도착 미반영) — 응답 predicted_congestion 은 정직. score.py 시그니처 리팩터 필요(위험도 있어 검토 후).
- 로그아웃 방문자는 인증 필요 엔드포인트(추천/코스/제보/쿠폰) 401 → 폴백 상태로 강등(기존과 동일). 게스트 온보딩 개선 여지.
- 날씨·행사(TourAPI festival) 연동은 TOURAPI_KEY + 외부 날씨 API 필요로 보류.
- 프로덕션 품질 2차 감사 진행 중(전체 앱 a11y/모바일/엣지 상태) — 발견 사항 순차 수정 예정.

## 6. 배포 (FastAPI → Render, 웹 → Vercel)

코드/설정은 준비되어 있으나 아래는 **외부 계정 접근이 필요해 사람이 직접 해야 하는 작업**이다.

### 6-1. FastAPI 백엔드 — Render Blueprint 적용
1. https://dashboard.render.com 로그인 → **New → Blueprint** → GitHub 리포(`NextSpot-knu/NextSpot`) 연결
2. Render 가 루트 `render.yaml` 을 자동 인식(type web · runtime docker · `apps/api/Dockerfile`, 컨텍스트 `apps/api`) → 서비스 `nextspot-api` 생성 제안
3. `render.yaml` 은 아래 env 값을 전부 `sync: false` 로 선언해뒀다 — Render 가 값을 자동으로 채우지 않으므로 **Blueprint 적용 화면(또는 서비스 생성 후 Environment 탭)에서 직접 입력**해야 배포가 정상 기동한다. 값 자체는 아래 "출처" 열의 로컬 파일에서 그대로 복사(여기 문서에는 키 이름만 남기고 값은 적지 않는다):

| Render env var | 값 출처 |
|---|---|
| `SUPABASE_URL` | `apps/api/.env` 의 동일 키 |
| `SUPABASE_SERVICE_ROLE_KEY` | `apps/api/.env` 의 동일 키 |
| `SUPABASE_ANON_KEY` | `apps/api/.env` 의 동일 키 |
| `JWT_SECRET` | `apps/api/.env` 의 동일 키(Supabase Dashboard → Project Settings → API → JWT Secret) |
| `ADMIN_API_TOKEN` | 로컬 데모값(`nextspot-admin-local`) 재사용 금지 — `openssl rand -hex 32` 로 새 값 발급 후 `apps/web`(Vercel) `NEXT_PUBLIC_ADMIN_API_TOKEN` 과 동일하게 맞출 것 |
| `ALLOWED_ORIGINS` | Vercel 배포 도메인(6-3 참고) |
| `TOURAPI_KEY` | `apps/api/.env` 의 동일 키 |

4. Deploy 완료 후 `https://<서비스>.onrender.com/health` 가 200 을 반환하는지 확인(`render.yaml` 의 `healthCheckPath`, `apps/api/app/main.py` 의 `/health` 라우트 기준).
5. (선택) `.github/workflows/uptime.yml` 이 10분마다 `/health` 를 핑한다. GitHub repo → **Settings → Secrets and variables → Actions → Variables** 에 `BACKEND_HEALTH_URL`(예: `https://<서비스>.onrender.com/health`)을 등록하면 활성화되고, 미등록이면 워크플로가 무해하게 skip 된다.

### 6-2. 웹(Next.js) — Vercel 환경변수 추가
Vercel 프로젝트(Root Directory `apps/web`) → Settings → Environment Variables 에 아래 4개가 있어야 백엔드/지도가 붙는다:

| Vercel env var | 값 출처 |
|---|---|
| `NEXT_PUBLIC_FASTAPI_URL` | Render 서비스 URL(예: `https://nextspot-api.onrender.com`) |
| `NEXT_PUBLIC_SUPABASE_URL` | `apps/web/.env.local` 의 동일 키 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `apps/web/.env.local` 의 동일 키 |
| `NEXT_PUBLIC_KAKAO_MAPS_APP_KEY` | `apps/web/.env.local` 의 동일 키 |

Kakao Maps JS SDK 는 도메인 화이트리스트 방식이므로, **Kakao 개발자콘솔 → 내 애플리케이션 → 플랫폼 → Web 플랫폼 도메인**에 Vercel 배포 도메인(예: `https://nextspot-xxx.vercel.app`, 커스텀 도메인이 있으면 그것도 함께)을 등록해야 지도가 렌더링된다.

### 6-3. CORS — ALLOWED_ORIGINS 지정 시 엄격 모드 자동 전환
`apps/api/app/main.py` 는 `ALLOWED_ORIGINS` 에 `*` 가 포함되거나 미설정이면 모든 오리진을 허용하되 `allow_credentials=False`(느슨 모드)로 동작하고, 실제 도메인 목록이 들어오면 해당 오리진만 허용 + `allow_credentials=True`(엄격 모드)로 자동 전환한다. Render 의 `ALLOWED_ORIGINS` 를 Vercel 배포 도메인으로 지정(콤마 구분, 예: `https://nextspot-xxx.vercel.app,https://your-custom-domain.com`)하면 배포와 동시에 엄격 모드가 켜진다 — 운영 전 반드시 지정할 것(방치 시 와일드카드로 열려 있음).

### 6-4. 미적용 DB 마이그레이션 4개
아래 4개는 아직 Supabase 에 적용되지 않은 상태다(기존 DB 유지 경로 — `DEPLOY_AND_ENV.md` 1-1 절 "기존 DB를 유지" 참고):
- `supabase/migrations/20260710170000_add_coupon_expiry.sql`
- `supabase/migrations/20260710171000_add_user_report_count.sql`
- `supabase/migrations/20260710172000_congestion_source_honesty.sql`
- `supabase/migrations/20260710173000_add_app_events.sql`

적용 방법: Supabase 대시보드 → **SQL Editor** → 위 4개 파일을 **파일명 오름차순(타임스탬프 순)** 으로 하나씩 전체 복사 → 붙여넣기 → Run(전부 멱등이라 재실행해도 안전). 또는 `supabase link` 후 `supabase db push` 로 일괄 적용해도 된다.
