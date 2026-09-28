# HANDOVER — 현재 상태 (정본)

> "지금 어디까지 왔고 무엇이 남았나"만 담는다. 2026-08-28까지의 세션 기록(§-45 → §6, 음수 번호가 최신)은
> [`archive/HANDOVER_LOG.md`](./archive/HANDOVER_LOG.md)에 그대로 있다. 이 문서는 400줄을 넘기지 않는다 —
> 넘치면 "최근 세션"의 가장 오래된 항목을 로그 파일 맨 위로 옮긴다(`scripts/check-docs.mjs`가 강제).

## 배포 상태

- **main = 프로덕션.** main push가 Vercel(web)·Render(api)를 자동 배포한다. 마지막 반영은 2026-09-29 새벽 야간 배치 — API 재설계 P2a(주차 이력 행렬 · 스위치 `AREA_DEMAND_SOURCE` 기본 `rpc` = 손님 쪽 동작 불변, 아래 2026-09-28d) · Wikimedia 사진 출처 줄·ⓒ 표시 자리 · P0b 웹 7건(아래 2026-09-28c). 그 전 2026-09-28 P0c 일배치·수집 경보(`367514c`, 아래 2026-09-28b). 그 전 같은 날 API 참조 스냅샷 P0a·P1(`fd5af2d`..`4d56afa`, 아래 2026-09-28 — 사용자가 직접 푸시, Render 가동 확인: `/health.reference_snapshot` ready·1,682곳, 지도 TTFB 0.24~0.54초·304 동작). 그 전 2026-09-27 TourAPI 일배치 재시도(`58c8bfc`). 그 전 같은 날 Supabase 키 공백 정리(아래 2026-09-26c 끝). 그 전 2026-09-26 Supabase 연결 격리(`bd44110`, 아래 2026-09-26c). 그 전 같은 날 관제 대시보드 추정·예측·시나리오 모드(`990b315`..`c2f97ad`, 아래 2026-09-26b). 그 전 같은 날 운영 긴급 수정·메모리·관광객 CPU(`0ae42b8`..`6b80f50`, 아래 2026-09-26). 그 전 2026-09-25 API OOM 대응(`0408bd7`..`0ce394d`). 그 전 2026-09-22 `ec127ee`, 09-21 —
  `fafdd06`+(심사용 계정 안내 + yunseong 데모 콘솔·비교 헤더·데이터 절 통합, 아래 `2026-09-21b`·`c`; 그전 `374254c`·소개 개편
  `a3b8a6b` 포함). `/guide`는 줄·혼잡으로 잃는 여행 시간과 주변 대안·이동 코스라는
  문제·해결 한 화면만 남겼다. Vercel 응답에서 새 제목·문제 카드·해결 카드가 있고 이전 취향 서사와 기술 설명은 없는 것을 확인했다.
  사람이 마지막으로 배포 결과를 눈으로 확인한 시점은 2026-09-08(관리자 대시보드·통계/성과 리포트 화면) — **09-20 시각 확인 대기**.
  규칙: main에 푸시한 쪽(에이전트 포함)이 위 줄의 날짜를 갱신하고, Vercel·Render 배포를 눈으로 본 사람이 확인 날짜를 적는다.
- **CI 는 이제 `yunseong` 푸시에서도 돈다**(`ci.yml` 트리거에 추가, 09-08). 그전에는 `main` 과 PR 뿐이라
  PR 없이 fast-forward 하는 이 저장소에서는 **CI 를 처음 보는 시점이 곧 배포 시점**이었다 —
  실제로 09-06 승격 뒤 e2e 잡이 이틀간 빨간불인 채 main 이 계속 배포됐다. 승격 전에 CI 초록을 확인할 것.
- Web: https://nextspot-nu.vercel.app — 루트 `vercel.json`이 `npm run build --workspace=apps/web` → `apps/web/out`.
  Vercel 대시보드에 Root Directory를 **설정하지 않는다**(설정하면 워크스페이스 빌드가 깨진다).
- API: https://nextspot-api.onrender.com (`/health`, `/docs`) — `render.yaml` Blueprint, docker, free plan.
- DB · Auth · Storage: Supabase 팀 프로젝트. 원격 마이그레이션 적용 상태는 아래 "마이그레이션 확인" 쿼리로만 믿는다.
- 스케줄: **Supabase pg_cron**이 10분 주기(`nextspot-area-demand-primary`/`-retry`)로
  `POST /api/v1/area-demand/snapshots/collect`를 서비스 토큰으로 호출(헤더 이름은 `X-Admin-Authorization: Bearer` —
  pg_cron 함수가 아직 이 이름을 쓴다. 정식 `X-Service-Token`도 함께 수용, `authz.py`). GitHub Actions 예약은 **세 개** —
  `ingest`(매일 KST 04:00) · `train-recommendation-model`(매주 월 03:00 KST) ·
  `area-demand-alert`(매시 정각, 2026-09-06 추가 — 새 스냅샷이 쌓였는지만 보고 `alert.state=down`이면 워크플로를 실패시킨다).
  `collect-area-demand`·`uptime`은 수동이다. `area-demand-alert`는 `BACKEND_HEALTH_URL`·`SERVICE_API_TOKEN`이
  없으면 조용히 skip 하므로, **설정이 없으면 감시도 없다**(GitHub Actions Variables/Secrets 확인 필요 — 아래 "사람 작업 대기").
- 환경변수 이름·위치·시크릿 목록: [`DEPLOY_AND_ENV.md`](./DEPLOY_AND_ENV.md).
- 심사 계정: `openapi@naver.com`(merchant, 이풍녀 구로쌈밥·맥심가옥 소유) · `openapi@gmail.com`(admin).
  비밀번호는 저장소에 없고 `apps/api/scripts/seed_judge_accounts.py`가 `JUDGE_ACCOUNT_PASSWORD` env로 시드한다.
  개발자 부트스트랩 계정은 구글 OAuth 1개, `/dev`는 마지막 developer 강등을 거부한다.

## 우선순위

1. **1차 심사자료 제출** — 절차는 저장소 루트 `announcements/` 의
   `2026 관광데이터 활용 공모전 웹·앱 개발 부문 1차 심사자료 제출 절차 안내 매뉴얼.pdf`,
   데모 전 체크리스트는 [`contest/DEMO_SCENARIO.md`](./contest/DEMO_SCENARIO.md) §0.
2. **사람 작업 대기** 처리 — 특히 토큰 회전과 Kakao 비즈 앱 전환(아래).
3. **결정 필요 3건** — "알려진 이슈" ①~③.
4. 정리 후속: 보안 진단의 상·중 항목 구현(아래 "알려진 이슈") · `ingest.yml` 리포트를 artifact로 보존 ·
   `apps/web/lib`·`apps/api/app/services`의 점진 이동(규칙은 `AGENTS.md` "새 파일은 어디에").
5. [`archive/IMPROVEMENT_PLAN.md`](./archive/IMPROVEMENT_PLAN.md) "2026-08-21 갱신" 절의 미완 항목 재확인(09-04 기준 미실측).

## 사람 작업 대기

외부 콘솔 접근이 필요해 코드로 못 하는 일. 끝나면 줄을 지우고 "최근 세션"에 한 줄 남긴다.

- [ ] **(P2a 가 main 에 들어간 뒤) Render `AREA_DEMAND_SOURCE=shadow`** → 24시간·재시작 1회 뒤 게이트와 go/no-go 측정 → `matrix`.
      순서·게이트·되돌림(`rpc`, 재시작 1~2분)·볼 것은 [`API_ARCHITECTURE_PLAN.md`](./API_ARCHITECTURE_PLAN.md) "P2a 전환 절차". 반영 전에는 할 일 없음.
- [ ] **(P3 배치 A 가 main 에 들어간 뒤) `/api/v1/warmup` 한 번** — memo 는 부팅 사전 스냅이 없어 첫 예열 전까지는 오늘과 같은 속도다. Render 로그 `walking_graph_presnap` 확인. 되돌림 env `WALKING_ROUTE_KERNEL=legacy`(재시작) — 아래 2026-09-28e. 반영 전 PM 확인 둘: 영업 근거 한 번 조회의 실패 범위가 `/infrastructures` 실시간 지도에도 적용됨 · 기존 테스트 두 곳 변경(같은 항목).
- [ ] **공공 API 키 회전** — `TOURAPI_KEY`·`KMA_API_KEY`·`PARKING_API_KEY`·`GYEONGJU_FOOD_API_KEY`. httpx INFO 로그가 쿼리스트링째 전체 URL을 남겨 Render 로그 이력에 키가 있을 수 있다(09-28 `d9639c2` 로 차단). 새 키 발급 → Render·GitHub Secrets 갱신.
- [ ] Render `nextspot-api` 환경변수 `SUPABASE_SERVICE_ROLE_KEY` 끝의 줄바꿈 지우기(09-27 발견 — 코드가 이미 걷으므로 급하지 않다. 저장하면 재배포된다).
- [ ] **서울 수집이 0건이다 — 원인 확인**(2026-09-20 20:38 KST 기준 `seoul_citydata_snapshots` 0행).
      표는 생겼고 Render 배포·인증키도 들어갔으며 API 엔드포인트도 살아 있다(401 = 인증 필요, 404 아님).
      남은 후보는 **수집 URL 시크릿 미설정**이 가장 유력하다. SQL Editor 에서 순서대로:
      ```sql
      -- 1) 잡이 걸려 있나
      select jobname, schedule, active from cron.job where jobname like 'nextspot-seoul%';
      -- 2) URL 시크릿이 있나(없으면 3번을 실행한다)
      select name from vault.decrypted_secrets where name like 'nextspot_seoul%';
      -- 3) 수집 URL 연결(한 번만)
      select public.configure_seoul_citydata_collection(
        'https://nextspot-api.onrender.com/api/v1/engine-validation/seoul/collect');
      -- 4) 지금 한 번 호출
      select public.request_seoul_citydata_collection(false);
      -- 5) 결과 확인(10초쯤 뒤)
      select status_code, left(content, 300) from net._http_response order by created desc limit 3;
      select area_nm, bucket_at, congest_lvl, live_lot_count, level_est
        from public.seoul_citydata_snapshots order by bucket_at desc limit 10;
      ```
      5번이 200 이고 표에 행이 생기면 이후는 10분마다 자동이다. 401 이면 Vault 의 서비스 토큰이
      Render 의 값과 다른 것이고, 503 `seoul_key_missing` 이면 Render 환경변수가 아직 반영되지 않은 것이다.
- [ ] **`20260920140000_seoul_citydata_retry_budget.sql` 적용** — 인증키 일 한도가 **1,000회**로 확인됐다(사용자).
      대상지 5곳 · 주 호출 10분 주기 = 하루 720회라 정상일 때는 맞지만, 주 호출이 계속 실패하는 날에는
      보충 호출(현재 10분 주기)이 720회를 더 써 한도를 넘긴다. 이 마이그레이션이 보충만 시간당 2회로 줄여
      최악의 날도 960회로 묶는다. 주 호출 주기는 그대로 둔다(검증 지표가 10분 버킷 위에 있다).

- [ ] **`ADMIN_API_TOKEN` 회전** — 구 값은 한때 `NEXT_PUBLIC_`으로 번들에 실렸던 값이라 공개된 것으로 취급.
      순서(서버는 단일 값만 비교하므로 Render 변경과 Vault 갱신 사이엔 수집이 실패한다 — 둘을 같은 10분 슬롯 안에 처리):
      새 값 생성 → Render에 `SERVICE_API_TOKEN` 추가(그 순간부터 이것만 유효, 기존 `ADMIN_API_TOKEN`은 둔다) →
      Supabase Vault `nextspot_area_demand_admin_token` 갱신 → GitHub Actions Secret `SERVICE_API_TOKEN` 추가 →
      다음 10분 수집 정상 확인 → `ADMIN_API_TOKEN`을 새 값으로 교체.
- [ ] **Kakao 개발자 콘솔** — 개인 개발자 → 비즈 앱 전환(`account_email` 스코프가 GoTrue에 고정돼 있어 이것 없이는
      KOE205가 안 풀린다). 앱 이름이 아직 "Induspot" — 동의 화면에 그대로 나온다 → "NextSpot".
- [ ] **Google 로그인 화면이 "<프로젝트ref>.supabase.co(으)로 계속" 이라고 뜨는 것 → "NextSpot"으로.** Google은 OAuth 콜백 주소의
      루트 도메인을 보여주는데 Supabase Auth 콜백이 `<ref>.supabase.co`라 그렇다(Supabase 공식 문서도 같은 설명).
      무료 경로: Google Cloud 콘솔 → Google Auth Platform → **Branding**에서 앱 이름 `NextSpot`, 로고(정사각 120px 이상),
      개인정보처리방침·약관 링크, **Authorized domains**에 `nextspot-nu.vercel.app`(Search Console로 소유 확인 선행) →
      **Publishing status = Publish**(email·profile·openid 같은 비민감 스코프만이라 즉시) → **브랜드 인증 신청**(며칠 소요).
      인증 전까지는 도메인 줄이 그대로이고 "확인되지 않은 앱" 경고가 뜰 수 있다. 유료 경로: Supabase **Custom Domain**
      애드온으로 `auth.<우리도메인>`을 콜백으로 쓰면 우리 도메인이 뜬다(도메인 보유 필요). 로그 §-43.
- [ ] **Supabase Auth Site URL**이 `localhost:3000`이면 Vercel 도메인으로(대시보드에서만 확인 가능).
- [ ] **Render `ALLOWED_ORIGINS`** — Vercel 도메인으로 지정해야 엄격 모드(해당 오리진만 + credentials). 미지정 시 와일드카드.
- [ ] **Render 로그에서 `X-Forwarded-For` 원 헤더 모양 1회 확인** — 리미터의 IP 추출 방향(첫 항목/마지막 항목/`CF-Connecting-IP`)을
      정하기 위한 관측(보안 진단 중 항목). 결과를 이 문서 "알려진 이슈"에 적는다.
- [ ] **심사 계정 2개 브라우저 로그인 확인** — `openapi@naver.com` → `/merchant`, `openapi@gmail.com` → `/admin/dashboard`.
- [ ] **GitHub Actions Secrets 점검** — `train-recommendation-model.yml`은 `JWT_SECRET`·`ADMIN_API_TOKEN` 시크릿이 없으면
      부팅 검증에서 실패한다(플레이스홀더 폴백 없음). `SUPABASE_URL`·`SUPABASE_ANON_KEY`·`SUPABASE_SERVICE_ROLE_KEY`·
      `TOURAPI_KEY`·`KAKAO_REST_API_KEY`·`LOCALDATA_AUTH_KEY`(선택)와 함께 등록돼 있는지 확인.
      함께: **Variable `BACKEND_HEALTH_URL` + Secret `SERVICE_API_TOKEN`(없으면 `ADMIN_API_TOKEN`)** — 없으면
      `area-demand-alert.yml`이 매시 조용히 skip 해서 수집이 멈춰도 알림이 오지 않는다. Actions 탭에서
      한 번 수동 실행(`Run workflow`)해 skip 이 아니라 실제 판정이 나오는지 확인할 것.
- [ ] `docs/MERCHANT_CONSOLE_RBAC_PLAN.md`(로컬 전용, 심사 자격증명 포함이라 미커밋)가 새 클론에는 없다 — 원본 보유자가
      필요하면 보관. 없어도 운영에는 지장 없음(내용은 로그 §-44에 요약).

## 알려진 이슈

결정이 필요한 것(①~③)과 알고 있지만 지금은 두는 것.

- ① **집중률 상대지수를 절대 점유율처럼 섞는다** — `app/services/area_demand_service.py`의 0.7/0.3 블렌딩.
  관광공사 집중률은 지점별 기준선 대비 상대값이라 "100 = 만석"이 아니다. 사용자에게 보이는 숫자가 바뀌는 문제라 데이터를 놓고 결정.
- ② **developer의 좌석 방송이 `verified`로 학습에 들어간다** — 소유자가 아닌 사람의 방송은 `single_report`로 낮추는 안.
- ③ **인증 없는·게스트 LLM/쓰기 경로에 유량 제한이 없다** — 순서는 아래 "보안 진단"대로: `travel-context/parse`·
  `preferences/parse`(상) → `/reports/*`(중) → `/voice/turn`·`events/track`·`search/ingest-request`.
- 스테이징이 없다 — **실 DB는 읽기만**, 쓰기 검증은 로컬 대역으로(08-28에 실 DB에 가짜 verified 3행을 쓴 전례).
- 프로필 캐시가 프로세스 내부(30초) — 워커 1개라 지금은 무해, `--workers N`을 붙이면 공유 무효화 필요.
- 메인 지도 `/infrastructures` 응답이 2.5초 경계에 걸려 폴백 경로로 돌던 문제는 타임아웃을 4초로 올려 완화(08-28).
  근본 해결은 지도용 경량 응답 분리(`overview_i18n` 64KB 제외).
- `20260905090000_congestion_logs_column_grants.sql`은 09-03에 만든 미래 날짜 파일이다. **새 마이그레이션은 이보다 큰
  타임스탬프**를 써야 `RESET_AND_SETUP.sql` 안의 적용 순서가 유지된다(원격 적용은 SQL Editor 수동 — CLI 링크는 없다).
- 원격 DB에 마이그레이션이 파일명 순서와 다르게 적용된 이력이 있다 — 순서를 가정하지 말고 아래 쿼리로 실측.
- 죽은 i18n 키 53개는 AST 분석(동적 `t(\`ns.${x}\`)` 패턴 전수 대조) 후 2026-09-04에 4로케일에서 삭제했다(823 → 770 leaf).
  `parity.test.ts`·`check-i18n-keys.mjs`는 죽은 키를 잡지 못한다 — 문자열을 없앨 때는 4 JSON에서 같이 지운다.

### 보안 진단 (2026-09-04, 읽기 전용 코드 감사 — Critical 없음)

결정·구현이 필요한 순서. 각 항목은 코드 근거가 있고, 고치기 전 재검증할 것.

- **상 — 비인증·게스트 LLM 호출이 무제한.** `POST /travel-context/parse`(인증·제한 없음, `routers/travel_context.py`)와
  `POST /preferences/parse`(익명 JWT 허용, 제한 없음)는 요청마다 Upstage 호출을 낼 수 있다. 일일 예산은 검색 재작성에만 있다
  (`config.py` `SEARCH_REWRITE_DAILY_BUDGET`). 조치: `routers/search.py`의 `_check_rate_limit`를 두 경로에 재사용 +
  `services/llm_client.py`에 전역 일일 예산 + `preferences/parse`는 `is_anonymous` 거부.
- **중 — 게스트가 혼잡 근거를 오염시킬 수 있다.** `/reports/congestion`·`/reports/availability`가 `is_anonymous`를 검사하지
  않고 쿨다운 키가 (user, facility)라 새 익명 세션마다 우회된다. 두 게스트가 맞장구치면 `corroborated`가 된다.
  조치: `routers/account.py`처럼 비익명 요구 + IP 키 쿨다운.
- **중 — X-Forwarded-For 해석 방향 미검증.** 세 리미터(`search.py`·`tracking.py`의 `_client_ip`, `recommendations.py`의 `_voice_client_ip`)가
  마지막 항목을 쓴다. Render가 hop을 덧붙이면 전원이 한 키(자기 DoS), 아니면 첫 항목이 위조 가능. 조치: Render에서 원 헤더를
  1회 로깅해 모양을 확인한 뒤 `CF-Connecting-IP`/`True-Client-IP` 우선으로 통일.
- **중 — 토큰 회전·CORS**: 위 "사람 작업 대기"의 `ADMIN_API_TOKEN` 회전과 `ALLOWED_ORIGINS`(현재 와일드카드 — 제3자 페이지가
  방문자 브라우저로 비인증 쓰기·LLM 경로를 두드릴 수 있어 IP 제한이 무력화된다).
- **하** — `bvr_insert_own` RLS에 `document_path` 접두 검사가 없다(API만 검사) → 마이그레이션에
  `document_path IS NULL OR document_path LIKE auth.uid()::text || '/%'` 추가 · `LEGACY_CONSOLE_TOKENS=true`인데 토큰이 코드
  기본값이면 부팅 거부 · Dockerfile 비루트 `USER` · 운영에서 `/docs` 노출 유지 여부 결정 · JWT `issuer` 검증 추가와
  `compare_digest`에 bytes(비ASCII 헤더 500 방지) · 파이썬 의존성 잠금 파일 + `pip-audit` CI · Actions 액션 SHA 고정.
- **양호 — 건드리지 말 것**: 추적 파일·이력에 시크릿 없음 · 전 테이블 RLS + `users.role` 상승 이중 차단(정책+트리거) ·
  SECURITY DEFINER RPC 전부 PUBLIC/anon/authenticated에서 REVOKE · 버킷 비공개·서명 URL 300초·심사 후 증빙 삭제 ·
  IDOR 가드는 토큰 주체만 사용 · 기계 토큰 상수시간 비교 · `sw.js`는 API 미캐시 · open redirect 차단(`safeNext`) ·
  원격 데이터 `dangerouslySetInnerHTML` 없음 · 모델 `pickle.load` 전 sha256 검증 · `npm audit --omit=dev` 0건.

## 마이그레이션 확인

읽기 전용 점검 쿼리(Supabase SQL Editor). 적용 후에는 **`NOTIFY pgrst, 'reload schema';`** — PostgREST가 스키마를
캐시해서 이걸 빼먹으면 새 컬럼·테이블을 한동안 못 보고 백엔드가 폴백 경로로 돈다.

⚠️ **15번(`20260906120000_admin_override_source`)은 코드가 이미 main에 있다**(`3fa2980`, 09-06 배포분).
CHECK 제약이 원격에 없으면 관리자 수동 혼잡 입력(`POST /admin/facilities/{id}/congestion`)이 **통째로 500**이다 —
데모 전에 15번부터 확인할 것.

```sql
with checks(seq, migration, applied) as (values
  (1, '20260710172000_congestion_source_honesty', (select count(*)>0 from pg_constraint
      where conname='congestion_logs_source_check' and pg_get_constraintdef(oid) like '%seed%')),
  (2, '20260719120000_recommendation_snapshot', (select count(*)>0 from information_schema.columns
      where table_schema='public' and table_name='recommendations' and column_name='recommendation_snapshot')),
  (3, '20260721120000_localdata_sources', to_regclass('public.facility_source_refs') is not null),
  (4, '20260819120000_recommendation_trust_loop', to_regclass('public.model_registry') is not null),
  (5, '20260820123000_connect_congestion_collection', (select count(*)>0 from information_schema.columns
      where table_schema='public' and table_name='congestion_logs' and column_name='origin_outcome_id')),
  (6, '20260825190000_add_facility_availability_reports', to_regclass('public.facility_availability_reports') is not null),
  (7, '20260827140000_rbac_roles_and_ownership', to_regclass('public.facility_owners') is not null),
  (8, '20260902130000_role_change_requests', (select count(*)>0 from information_schema.columns
      where table_schema='public' and table_name='business_verification_requests' and column_name='requested_role')),
  (9, '20260904120000_area_demand_points_rpc', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'area_demand_points_near')),
  (10, '20260904200000_business_documents_bucket', exists (select 1 from storage.buckets where id='business-documents')),
  (11, '20260905090000_congestion_logs_column_grants',
      not has_table_privilege('anon','public.congestion_logs','SELECT')
      and has_column_privilege('anon','public.congestion_logs','facility_id','SELECT')),
  (12, '20260903120000_nickname_source', (select count(*)>0 from information_schema.columns
      where table_schema='public' and table_name='users' and column_name='nickname_source')),
  (13, '20260904090000_account_deletion_fk_fix', exists (select 1 from pg_constraint
      where conname='business_verification_requests_user_id_fkey' and pg_get_constraintdef(oid) like '%ON DELETE CASCADE%')),
  (14, '20260904091000_inquiries_insert_ownership', exists (select 1 from pg_policies
      where schemaname='public' and tablename='inquiries' and policyname='inquiries_insert_own_or_anonymous')),
  (15, '20260906120000_admin_override_source', (select count(*)>0 from pg_constraint
      where conname='congestion_logs_source_check' and pg_get_constraintdef(oid) like '%admin_override%'))
)
select seq, migration, case when applied then '적용됨' else '미적용' end as status
from checks order by seq;
```

## 최근 세션

최신이 위. 10개를 넘으면 가장 오래된 항목을 `archive/HANDOVER_LOG.md` 맨 위로 옮긴다.

## 2026-09-28e — API 재설계 P3 배치 A: 보행 목적지 스냅 기억 · 시설 조회 왕복·복사 줄이기 (main 미반영)

- 도구·브랜치: Claude Code(검증된 P3 명세 → 커밋별 구현 · 10ea2d4 원문과 동등성 대조) / `perf/p3a-0929`(10ea2d4 = release/0928 위, 미푸시)
- 커밋: 4ab6eb7..(이 기록) (6건 + 리뷰 수리 3건 — 경계 테스트 둘·이 공개 보강). 순서는 스냅 기억 → 사각형 먼저 복사 → prior 스레드 → 타임세일 한 번 → 영업 근거 한 번. 기존 테스트 계약을 바꾼 마지막 두 건은 끝에 두어 따로 뺄 수 있다(각각 `git revert` 가능).
- 한 것: 보행 목적지 스냅을 그래프 객체에 기억 + 예열(`/warmup`) 때 시설 전체 사전 스냅(스위치 `WALKING_ROUTE_KERNEL` 기본 `memo`, `legacy` = 되돌림) ·
  `fetch_all_facilities` 가 사각형으로 먼저 좁히고 남은 행만 깊은 복사 · 관광 prior 붙이기를 스레드로 · 타임세일(조각 둘 이상) 한 번 조회 · 영업 근거(조각 둘 이상) 한 번 조회.
  손님이 받는 답은 같다. 공개된 차이는 영업 근거 둘(같은 마이크로초 동률은 id 순, 실패하면 그 호출의 근거가 통째로 빈다 — PM 수락).
  한 번 조회를 타는 곳(id 150개 초과): 메인 추천·by-type·부팅 예열 **그리고 `/infrastructures` 실시간 지도 경로**(참조 스냅샷 준비 전·낡음·`REFERENCE_SNAPSHOT_SERVE=legacy` 때,
  활성 시설 전체 ~1,682곳) — 명세 §4.3·611eb13 메시지에는 지도가 빠져 있었다. 실패 범위 차이는 지도에도 같다(그 요청의 근거가 통째로 빈다).
- 검증: api ruff + pytest 2077 passed(리뷰 수리 뒤) · OpenAPI 스냅샷·score.py 10ea2d4 와 동일 · check-docs · 10ea2d4 원문 대조 불일치 0(경로 실제 시설 1,682곳 × 출발 50곳 = 84,100쌍 ·
  시설 사각형 50개(실제 1,682행) · 타임세일 45가지 · 영업 근거 35가지 · prior 실제 1,682행). 기존 테스트 변경: 타임세일 조각 테스트는 단언 그대로 캡 폴백 경로를 타게 픽스처만,
  영업 근거 조각 테스트 둘은 새 계약으로(조각 크기 → 'URL 에 id 없음', 한 조각 실패 → 통째로 빈다).
  **이 두 곳은 '기존 테스트 단언 불변' 규칙의 예외라 PM 확인 필요**(611eb13 `test_availability_service.py` 단언 교체 · 7ee6821 `test_merchant_boost.py` 픽스처만).
  리뷰 수리로 새 테스트만 더했다: 타임세일 정확히 1000행(PostgREST 캡) 응답 → 조각 폴백 · 시설 사각형 경계 위 포함/한 칸 바깥 제외(변이 `>=`→`>`·`<=`→`<` 잡힘).
- 다음·미결: 배치 B(csr 커널 + 커밋된 바이너리, 부팅 사전 스냅 — `main.py` 훅은 이미 있고 csr 전까지 꺼져 있다)는 09-30 18:00 KST 까지 증명될 때만. 서명 전 Render 모양(0.5 CPU/512MB) 컨테이너에서 by-type·추천 콜드/웜 재측정(명세 §8).
- 사람 작업: main 반영 뒤 `/api/v1/warmup` 한 번 → Render 로그 `walking_graph_presnap`·`warmup_run_done` 확인, `merchant_boost_timesale_fetch_failed`·`availability_evidence_unavailable`(추천·by-type·**지도 요청 포함**)이 늘지 않는지. 되돌림은 env `WALKING_ROUTE_KERNEL=legacy`(재시작) 또는 커밋별 `git revert`.

## 2026-09-28d — API 재설계 P2a: 권역 수요 전망을 메모리 주차 이력 행렬로 (스위치 꺼진 채 — rpc)

- 도구·브랜치: Claude Code(명세 → 레드팀 3렌즈 → 수정 → 단계별 구현 워크플로, 단계마다 시험·변이 검사) / `perf/parking-history`(367514c 위로 rebase — 앱 코드는 rebase 전과 바이트 동일, 미푸시)
- 커밋: 17c12e1..(이 기록) (24건 = 처음 10건(첫 기록 b72b812 포함) + 리뷰 수리 11건 + 수리 기록 + 2차 리뷰 수리 1건 + 이 갱신). 계획·전환 절차는 [`API_ARCHITECTURE_PLAN.md`](./API_ARCHITECTURE_PLAN.md) "P2a 전환 절차"
- 한 것: `services/parking_history.py`(56일 로트×시간 행렬 · 전용 스레드 부팅 적재·5분 꼬리·수집 직후 다시 읽기·30분 대조 · `/health.parking_history`) + 전망 서비스의 행렬 커널(`%.15g` — 운영 RPC 와 비트 동일)·정확 좌표 메모·백테스트 계획 공유 +
  `AREA_DEMAND_SOURCE` 분기: `rpc`(기본 — 도입 전 경로 그대로, 스레드·DB 호출 없음) · `shadow`(답은 rpc, 요청 비교·자기 탐침으로 차이만 셈) · `matrix`(행렬로 답하고 못 하면 그 호출만 rpc, 폴백 뒤 격자 캐시 비움, `/waiting` 전용 차선). PM 결정(09-28): 꺼진 채 반영.
- 검증: api ruff + pytest 2027 passed(rebase 뒤 HEAD, 2차 수리 포함) · OpenAPI 스냅샷·score.py 367514c 와 동일 · RPC 경로 원본 해시 고정(3cf5bf9 와 같음 — 367514c 의 전망 서비스는 3cf5bf9 와 같다, 부르는 도우미 9개 포함) · check-docs. score.py·SPOT 가중치·마이그레이션·웹 무변경.
- 리뷰 수리(기록 뒤 커밋 11건): 부팅 파싱 메모리 9.4→3.4MB(열·칸 객체 공유) · 차선에서 기다린 행렬 호출은 새 세대로 · 실패한 꼬리 도중 kick 은 백오프 존중 ·
  shadow 게이트 표본은 비교를 끝낸 탐침만 + `failed == 0` · 탐침 하루 ≤288회 실제로 · 종료 때 final 요약 · 시험 보강(ulp/value 경계·KST 날짜 경계·최근 좌표 고리).
  2차 리뷰 수리: 종료 때 아직 도는 shadow 비교(탐침·요청 비교)를 최대 3초 기다려 final 요약에 넣는다(shadow 모드만, 못 끝나면 `parking_history_shadow_drain_timeout`).
- 다음·미결: go/no-go 측정(Render 모양 0.5 CPU/512MB, 운영 시설 좌표 읽기 1회 승인됨)은 아직 — `matrix` 전 필수. P2b(격자 캐시·RPC 경로 삭제, 수집 실시간 공급)는 `matrix` 24시간 무폴백 뒤. `_points_locks` 누수(기존)는 P2b 에서.
- 사람 작업: main 반영 뒤 Render `AREA_DEMAND_SOURCE=shadow`(위 "사람 작업 대기").

## 2026-09-28c — P0b: 웹만 — 관제 장소 표 전량 · 지도 비상 경로 활성만 · /waiting 곡선 6점 · 숨은 탭 폴링 멈춤 (09-29 야간 배치로 main 반영)

- 도구·브랜치: Claude Code(하위 에이전트) / `web/batch-0928`(main `367514c` + 사진 출처 `40db900..bd2663b` 위)
- 커밋: 880b2e1..96e31ae (6건) + 이 기록. 스펙은 3렌즈 레드팀 뒤 PM 승인(2026-09-28, C1~C7 트레이드오프 포함). 단계 표는 [`API_ARCHITECTURE_PLAN.md`](./API_ARCHITECTURE_PLAN.md) P0b
- 한 것: 관제 장소 표가 이름순 1,000곳에서 잘리던 것 → (name,id) 전량·비활성 배지·이름 검색 · 지도 비상 경로(API 재시작 중)가 폐업 16곳을 그리던 것 → 활성만·id 페이지·최신 혼잡 RPC·갤러리 사진 · `/waiting` 곡선이 분 30 이후 통째로 안 쓰이던 것 → 서버 창 안으로 당긴 정시 6점·선행 1회 후 동시 3·noRetry·기준 시각별 곡선 · 숨은 관제 탭 폴링 멈춤('알림 받기' 켜짐이면 유지)·안전 화면 첫 진입 1회 · 탭 복귀 `/account/me` 5분 생략(실패 뒤·심사 대기 제외) · 추천 타임아웃 뒤 같은 POST 재전송 대신 by-type 대안(45초). 재시도 추가 없음(B4), 프리페치·Supabase 폴백 유지, API 계약·i18n 키 변화 없음.
- 검증: web lint 0 errors(경고 154 — 바뀐 파일마다 기준과 같은 수) · typecheck · test 62파일 · build 39페이지 · e2e 51 passed(새 2건) · check-docs. 새·확장 단위 테스트 7파일은 bd2663b 소스에서 전부 실패, 새 e2e 2건도 실패(C2 최신 혼잡 RPC 미호출 · C3 13:00 을 15분 앞에 물음 — 서버 창 밖).
- 리뷰 수정 c7b2f47..1c4d6a0 (4건): 추천 대안이 원래 장소 유형을 호출 시점에 읽음(카페 화면 대안이 음식점으로 차던 것 — C6 이 이 경로를 흔하게 만들었다, 새 e2e 로 수정 전 실패 확인) · 관제 이름 검색 대소문자·공백 무시, 지금 탭에 0곳이면 "카페 탭에 N곳" 한 번에 이동 · `/waiting` 곡선은 선행이 전망을 줬을 때만 동시 3(아니면 하나씩), 저장된 프리셋을 읽은 뒤 조회(먼 프리셋에서 'now' 선행 요청 제거), 병합 순수 함수 · 가드 보강(갤러리 매핑·안전 화면 비교·탭 복귀 겹침, 각각 변이로 실패 확인). 검증: lint 0 errors(경고 153) · typecheck · test 62파일 · build 39페이지 · e2e 52 passed · check-docs.
- 최종 리뷰 수정 a0d6c82..866b79d (5건, 사진 출처 작업 포함): 대기 보드 조회도 저장된 프리셋을 읽은 뒤 시작·조회 중 프리셋이 바뀌면 옛 조회는 남은 유형을 묻지 않고 결과·캐시를 버림(곡선만 막던 2e9c202 의 나머지 — 프로덕션부터 있던 'now' 한 벌 중복) · `/waiting`·추천 하단 ⓒ한국관광공사 TourAPI 줄에 '(출처를 따로 적은 사진 제외)' 4로케일(기존 키 값만) · 영어·일본어 대기 카드 2·3번이 이름 없이 뜨던 것 → 이름 한 줄 최소 높이 · 가드 보강(출처가 사진보다 늦게 붙는 프레임 탐침·소스 확인 복원, 두 줄 출처 누르는 폭을 글자로, 카카오 리뷰 줄 아래 ⓒ 자리, 관제 표 is_active 읽기 1곳). 새 테스트는 모두 고치기 전 코드·변이에서 실패 확인. 검증: lint 0 errors(경고 153) · typecheck · test 63파일 · build 39페이지 · e2e 61 passed · check-docs.
- 다음·미결: main 반영은 C1~C7 한 번에, 심사 시간 밖(웹만 바뀌어도 Render 가 재배포·캐시 초기화) → 폰 스모크(스펙 §9.4). 관제 대시보드는 390px 에서 사이드바 256px + `grid-cols-3` 라 장소 표 카드가 약 39px 로 눌린다 — 이번 이전부터의 문제로 범위 밖, 폰으로 관제를 여는 심사 대비는 별도 결정. 위 2026-09-28 항목의 "웹 경계 파라미터 이름 불일치"는 틀렸다(경계 필터는 적용된다 — 계획 문서에서 정정).
- 사람 작업: 없음

## 2026-09-28b — P0c: TourAPI 일배치가 좋은 값을 덮지 않게 · 수집 경보를 스냅샷 표에서 (main 반영 367514c)

- 도구·브랜치: Claude Code(하위 에이전트) / `fix/ingest-keyset-upsert`
- 커밋: 8a8f54f..d0bacd1 (3건) + 이 기록 + 독립 리뷰 수정 ca91cbe..af24be4 (6건, 각각 되돌릴 수 있게) + 2차 리뷰 수정 ed76621..1f70c50 (4건) + 이 갱신. 단계 표는 [`API_ARCHITECTURE_PLAN.md`](./API_ARCHITECTURE_PLAN.md) P0c
- 한 것: 일배치 bulk 쓰기를 키 집합이 같은 행끼리만(합집합 columns 의 NULL 채움 차단) · capacity 는 기존 행에도 매일 밤 기본값(PM 결정, 아래) · None 열(image_url·address)은 보내지 않음 · 사진 상세가 실패한 날 Wikimedia 대체 사진 금지. area-demand-alert 는 Supabase `area_demand_snapshots` 최신 행을 직접 읽는다(stale·api_unreachable 구분, Supabase 시크릿이 없으면 옛 API 판정 그대로), 매시 28분.
- 실측: 운영 일배치의 1차 bulk upsert 는 매일 42P10(부분 유니크 인덱스는 ON CONFLICT 대상이 못 된다)으로 실패하고 폴백(신규 INSERT·기존 행마다 UPDATE)이 실제 경로다 — '상세 NULL 덮기'는 운영에선 잠재였고, capacity·image_url·address 되돌리기는 실제였다.
- capacity — PM 결정(2026-09-28) "Keep nightly reset": 10월 심사가 끝날 때까지 수용 인원은 main 3cf5bf9 처럼 매일 밤 `CAPACITY_DEFAULTS`(타입별)로 다시 쓴다. 공유 관리자 계정에서 심사위원이 잘못 고친 값이 데모에 남지 않게 하기 위해서다(8f9813b 의 '새 contentid 에만'은 1f70c50 에서 걷어 냄, None 은 여전히 미전송 — NOT NULL). 심사 후 과제: 관리자가 고친 값에 표시(예: 관리자 PATCH 가 `features.capacity_source='admin'`)를 남기고 그 행만 건너뛴다.
- 리뷰 수정(스크립트·워크플로만, `app/**` 는 손대지 않음):
  - 대표 사진: detailCommon2 가 상세 항목을 돌려줬고 목록·상세 firstimage 가 모두 비면 그날만 `image_url=NULL`(거둔 사진이 남거나 Wikimedia 출처 아래 옛 사진이 뜨지 않게). 호출 실패·미호출이면 기존 값 유지. address 는 '확인된 부재' 신호가 없어 계속 None 미전송.
  - 좌표: 저장된 `features.coordinate_source='kakao'` 인 행은 그날 Kakao 매칭이 실패·동점이면 위경도를 보내지 않는다(검증 좌표 유지).
  - 폴백 INSERT 조각이 실패하면 행마다 다시 넣고 실패 contentid 를 로그에 — 나쁜 행 하나가 새 장소 100곳을 막지 않게. `GITHUB_STEP_SUMMARY` 에 "written X/Y" 한 줄. 종료 코드 규칙(75 재시도 사슬)은 그대로.
  - area-demand-alert: 끊긴 응답(IncompleteRead 등)도 재시도 후 `api_unreachable` 안내로(트레이스백 X) · Supabase 모드의 빈 결과는 `no_snapshot` 실패(새 환경만 Variable `AREA_DEMAND_ALERT_ALLOW_EMPTY=true`) · 오류 발췌에서 키·URL 가림 · 주석은 '매시 감지'를 약속하지 않음(스케줄러 best-effort, 실측 3~6시간 간격).
  - 2차: 항목 0개인 detailCommon2 응답은 '사진 없음' 확인이 아니다(image_url 을 지우지도, Wikimedia 로 바꾸지도 않음 — ca91cbe 회귀) · TourAPI 사진(대표 또는 갤러리)이 다시 생기면 저장된 갤러리에서 Wikimedia 사진만 빼고 출처를 `features.image_source=null` 로 걷어 낸다 — 기존 행 SELECT 가 `image_url, gallery_images` 도 읽어 저장된 TourAPI 갤러리는 남기고(`[]` 를 보내지 않는다), Wikimedia 사진이 남지 않은 옛 출처(main 이 남긴 'TourAPI 갤러리 + 옛 출처' 행)는 사진을 건드리지 않고 지운다. detailImage2 항목 0개 응답으로 저장된 TourAPI 갤러리를 Wikimedia 로 덮지 않는다(3차 리뷰). 웹 추천 카드(/main·/saved)가 Wikimedia 사진에 출처 줄을 붙이지 않는 기존 문제는 웹 게이트·화면 확인을 위해 별도 브랜치 `fix/card-photo-credit` 로 분리했다(main 미반영) · 경보 시크릿에 U+200B 같은 글자가 있으면 요청 전 `api_unreachable`(`invalid_key_chars`·`invalid_url_chars`, 위치·코드포인트만 출력).
- 검증: api ruff + pytest 1850(새 9건, 수정 전 코드에서 전부 실패 확인) · actionlint + shellcheck · 스텁 PostgREST 13경우 · 운영 Supabase 읽기 1회(state=ok) · check-docs. 리뷰 수정: pytest 새 6건(수정 전 스크립트에서 전부 실패) · 가짜 HTTP 서버로 경보 스크립트 원문 10경우(ok·stale·빈 결과·허용 변수·IncompleteRead·401·503×3, 로그·Summary 에 키·URL 없음 — 수정 전 원문은 5경우 실패) · actionlint 1.7.12. 2차: pytest 1862(새 6건 — R1·R2 는 수정 전 코드에서 실패, capacity 단언 2건은 PM 결정에 맞춰 뒤집음) · 경보 하네스 12/12(U+200B 키·주소 2경우 추가, 수정 전 원문은 둘 다 실패) · actionlint
- 다음·미결: main 반영 때 위 "배포 상태"의 area-demand-alert 설명(매시 정각·skip 조건)과 "사람 작업 대기"의 `BACKEND_HEALTH_URL` 항목 갱신 · 충돌 대상 정리는 RPC 단계에서 · main 반영 뒤 하루 동안 경보 실행 간격 확인.
  - 관리자 승인 경로 `app/routers/search.py` `_upsert_facility` 는 이미 있는 contentid 에도 capacity 를 기본값으로, image_url·address 를 None 으로 되돌리고 features 를 통째로 바꾼다(`overview_i18n` 번역·Wikimedia 출처·Kakao 좌표 표시가 지워진다). 일배치와 같은 `_write_payload` + features 병합을 쓰거나 "이미 있음" 가드를 둘 것.
  - 새 장소가 들어온 첫날 밤 사진 호출이 실패하면 Wikimedia 대체 사진을 건너뛴다 — 다음 날 밤 스스로 채워지므로 수용.
- 사람 작업: 없음(Supabase 시크릿은 ingest 가 이미 쓰는 값)

## 2026-09-28 — API 재설계 1단계: 참조 스냅샷으로 지도 4초 → 수 ms (P0a·P1)

- 도구·브랜치: Claude Code(데스크톱 — 노트북 작업 392커밋 동기화 후) · 감사 워크플로(6영역 감사 → 설계 → 레드팀 2렌즈) + 구현 워크플로(구현 → 독립 리뷰 2렌즈 → 수정) / `perf/reference-snapshot`
- 커밋: fd5af2d..9ae0657 (13건) + 이 기록. 계획·실측·단계 상태는 [`API_ARCHITECTURE_PLAN.md`](./API_ARCHITECTURE_PLAN.md)
- 한 것: 지도 `/infrastructures` 가 요청마다 시설 2MB를 서울에서 다시 읽던 구조를 `services/reference_snapshot.py`(불변 스냅샷 + 미리 직렬화한 바이트 · ETag/304 · 시각 경계마다 재조립 · 마지막 정상본 · 건전성 검사 · 쓰기마다 mark_dirty)로 바꿨다. 스냅샷이 없으면 옛 경로(새 503 없음). P0a: RPC 실패 시 1,682 스레드 팬아웃 제거 · 시설 페이지네이션 id 정렬 · httpx URL 로그 차단.
- 검증: api ruff + pytest 1841 · OpenAPI 스냅샷 동일 · check-docs · **실 DB 읽기 대조**(데스크톱): 3개 필터 모두 옛 경로와 JSON 동일(1,682곳·순서 동일), 스냅샷 3~13ms vs 옛 경로 1.2~1.5초, 304 동작, 요청당 힙 12~13MB → 3MB · 리뷰 13건 반영(11 수정, 2 부분 — 사유는 커밋 본문).
- 다음·미결: main 반영 후 Render 로그 `served="snapshot"` 비율·`/health` 의 `reference_snapshot`·RSS 확인 → P2(주차 이력 행렬, −44~109MB) · P3(소비자 이전·보행 CSR·예측 표). 롤백은 Render env `REFERENCE_SNAPSHOT_SERVE=legacy`(재시작). 웹 경계 파라미터 이름 불일치(필터가 한 번도 안 걸림)는 화면 결정 대기.
- 사람 작업: 공공 API 키 회전(아래 "사람 작업 대기").

## 2026-09-27 — TourAPI 일배치: 목록 재시도 · 일시 오류일 때만 새 러너 재실행 · 공개 이슈 알림 없음

- 도구·브랜치: Claude Code / `fix/ingest-reliability-v3`(09-24 `fix/ingest-reliability-v2` 를 main 위로 옮기고 리뷰 반영, 한 커밋) → main
- 커밋: 58c8bfc (1건) + 이 기록
- 한 것: 09-15·19·20·22 일배치 실패는 일부 러너에서 apis.data.go.kr 첫 호출이 10초 안에 안 닿은 것. 목록 호출 4회 재시도, 그래도 일시 오류면
  exit 75 → 그때만 새 러너 재실행(최대 2회, 상세 조회·DB 쓰기 전에만 75). 다른 실패는 재실행 없이 exit 1(쿼터 3배 방지). 실패 이슈는 열지 않는다(공개 저장소 — PM 결정).
- 검증: api ruff+pytest · yaml.safe_load · actionlint+shellcheck · 독립 리뷰(종료 코드 전달·스텁 서버로 75/1 재현).
- 다음·미결: 04:00 실패 메일이 와도 옆에 auto_retry 실행이 초록이면 데이터는 갱신된 것 — **Re-run 금지**(재시도 사슬을 다시 건다), 필요하면 Run workflow(auto_retry 비움).
  상세 조회가 실패한 행은 bulk upsert 가 상세 컬럼을 NULL 로 덮는 기존 문제(main 에도 있음) — 후속.
- 사람 작업: 없음

## 2026-09-26c — Supabase 연결을 요청마다 혼자 쓰게 (by-type 추천 503 세 구간의 근원)

- 도구·브랜치: Claude Code / `fix/supabase-connection-isolation` → main
- 커밋: bd44110 (1건) + 이 기록
- 한 것: 09-26 KST 09:33·15:41·16:40 세 구간에 by-type 추천 503 41건과 관리자·impact·문의·랩 500. 전부 Supabase 가 연결째 끊은
  `ConnectionTerminated error_code:1/9`(정상 종료 0 은 0건) + EBADF 1건 — 여러 스레드가 동기 HTTP/2 연결 하나를 나눠 써 스트림 번호·HPACK 이
  어긋난 것(hpack `deque mutated during iteration` 도 같은 경합). `core/supabase.py` 가 요청마다 연결을 혼자 빌려 쓰게(`_ExclusiveConnectionTransport`),
  HTTP/1.1 로 바꿨다. 재시도 규칙은 그대로, 풀 닫기는 그 요청의 연결에만 닿는다. 08-28 의 http2=False 실패는 당시 풀 통째 닫기 + 재시도 밖 본문 읽기 탓으로 본다.
- 검증: api ruff+pytest 1713 · 새 회귀 테스트 17건(수정 전 코드에서 7건 실패 확인) · WSL 카오스 하니스 45,471요청 — 예전 구성 실패 584·중복 POST 1,381·
  EBADF 2,486, 새 구성 전부 0 · 소크 게이트 회귀 없음 · 독립 리뷰 2렌즈(동시성·실행) 통과. RSS 운영 모양 부하 동일(62연결 동시 +6.5MB).
- 다음·미결: 배포 뒤 Render 로그의 `supabase_stale_connection_retry`·`recommend_by_type_failed`·p95·메모리 확인 · 쓰기 요청이 서버 처리 뒤 끊기면
  재시도가 한 번 더 보내는 기존 경로(심사 뒤 멱등 키/재시도 범위 축소) · `availability_service` 가 예외를 문자열만 남김(traceback 없음) ·
  area-demand-alert 가 API 503 한 번에 JSON 파싱 오류로 거짓 경보(09-26 16:21).
- 배포 직후 회귀·즉시 수정: 운영 `SUPABASE_SERVICE_ROLE_KEY` 끝의 줄바꿈을 HTTP/1.1(h11)이 헤더로 거부해 service_role 호출이 전부 실패
  (20:23~ KST, predict 갱신·서울 적재·영업 근거 조회) → `config.py` 가 Supabase URL·키 앞뒤 공백을 걷는다(회귀 테스트 14건, 수정 전 코드에서 14건 실패).
- 사람 작업: 없음

## 2026-09-26b — 관제 대시보드 추정·예측·시나리오 모드 main 반영

- 도구·브랜치: Claude Code / `feature/admin-predicted-mode-v2`(633487c 를 8033719 위로 충돌 없이 옮김 + 검증 수정 3건) → main
- 커밋: 990b315..c2f97ad (4건) + 이 기록
- 한 것: 실측이 5건 미만인 관제 패널이 빈 칸 대신 라벨 붙은 값(추정·예측·시나리오)을 보인다(09-22 PM 결정). 검증에서 고친 것 — 예측 앵커가
  상한에 붙어 100%로 보이던 문제, 추천 고리 4패널(수락률·DAU·재배치·깔때기)을 **함께** 전환(시나리오 재배치와 실측 수락률 0% 모순 제거 — PM 09-26 승인),
  비활성 시드 제외(`is_active`), 예측 전용 문구의 관광공사 근거 오기, 툴팁의 내부 파일명, 신선도 배지의 추가 무거운 관리자 호출(8→7) 제거.
- 검증: web lint(0 에러)/typecheck/test 56/build 39 · e2e 44 · check-docs · 오프라인 렌더 하네스 14상태(스크린샷) · 독립 리뷰 3렌즈 재검증 통과
- 다음·미결: 자료가 얇을 때 브리핑이 늦게 오면 추천 고리 4패널이 몇 초간 시나리오였다가 실측으로 바뀜(운영은 실측 5건 이상이라 해당 없음) ·
  관제 콘솔 390px 사용 불가(기존과 동일) · 쿠폰 패널이 비활성 시드를 보임(기존과 동일).
- 사람 작업: 없음

## 2026-09-26 — 관제 콘솔 튕김·서버 멈춤·닫힌 HTTP/2 연결 재시도 (운영 긴급 수정 3건)

- 도구·브랜치: Claude Code / `fix/supabase-h2-closed-retry`(`0ae42b8`) + `fix/admin-gate-no-bounce`(`d257f98`→`5f8e4b9`) +
  `fix/walking-routes-off-event-loop`(`4d21383`) → main. Render `4d21383` Live · Vercel 번들에 새 게이트 확인(09-26 02:0x KST).
- 한 것: ① 01:21 KST 관제 콘솔 '튕김→재접속' — 코스 계산 23초 동안 /account/me 가 프런트 10초 타임아웃, `admin/layout.tsx` 가
  그 실패를 권한 없음으로 읽어 로그인으로 보냈다 → `lib/adminGate.ts`(부정 판정일 때만 이동, 닿지 못함은 콘솔 유지/다시 시도).
  ② 멈춤의 근원: `spot/travel.py` 가 28,832노드 Dijkstra 를 **이벤트 루프 위에서** 돌렸다 → `asyncio.to_thread`(결과 동일).
  ③ 09-21 이후 50회+ `SEND_HEADERS in state ConnectionState.CLOSED` 실패(추천·계정·관제) → 해당 LocalProtocolError 만 stale 재시도.
- 검증: api ruff+pytest 1649 · web lint(0 에러)/typecheck/test 55/build 39 · CI(5f8e4b9) 4잡 green · 새 회귀 테스트 3종은 수정 전 코드에서 실패 확인.
- 추가 배포 `b3eefef`(02:52 KST 가동): PostgREST 응답 json.loads 파싱(`core/postgrest_json.py`) · 관리자 무거운 조회 RSS 사전점검(5초 1회 반환,
  400MB 이상이면 그 조회만 503) · 관리자 집계 동시 중복 합류(저장 없음) · OpenAPI 계약 스냅샷 테스트. Linux 실측 기동 132→113MB, 관리자 버스트 CPU 절반.
  배포 확인: Render Live · 파서 설치 경고 0 · 공개 GET 4종 200 · 오류 0.
- 추가 배포(모두 CI green·Render Live·배포 후 오류 0): `0bfc485` pyproj 지연 적재(기동 -15MB) · `353f831` /health async +
  GIL 전환 1ms(스레드풀 포화 시 헬스체크 재시작 방지) · `6b80f50` 권역 수요 백테스트 정확·색인 재작성 + 캐시 잠금·single-flight
  (관광객 CPU 87~96% 원인, Linux 0.5 CPU: 대기 보드 61→5.7초·코스 44→1.7초·흐름 86→9초, 골든 응답 486/486 바이트 동일,
  동시 제거 경쟁 503 수정) + glibc mmap/trim 문턱 128KB(-5MB). 운영 실트래픽에서의 속도는 아직 미관측.
- 다음·미결: 재시도 전송의 풀 전체 닫기(중복 POST·Linux 최대 120초 멈춤) — V4 패치는 독립 리뷰 차단(쓰기 실패 증가·httpcore 내부 의존),
  httpx/httpcore 고정·업그레이드와 함께 심사 뒤 재검토 · 모르는 kid JWKS 재조회 제한 보류(키 교체와 겹치면 401) ·
  구조 개편 G0~G3(라우터 계층 위반 9건 제거, 시제품 1684 통과) 심사 영향 작업 뒤 · 보행망 CSR(-23.5MB)·권역 수요 GridSeries(-74MB) ·
  /account/me 401 시 세션 갱신 1회 재시도(운영 401 0건).
- 사람 작업: 심사 계정 두 개로 로그인 → 관제 대시보드·상인 콘솔 진입 확인(비밀번호 입력은 사람만).

## 2026-09-25 — API OOM 대응 승격: 관제 대시보드 동시 조회 상한·메모리 반환 + 09-24 OOM 수정

- 도구·브랜치: Claude Code(원인 조사 워크플로 5렌즈 + 수정 검증 워크플로 4렌즈) / `fix/api-oom-admin-gate` = `ec127ee` +
  `0408bd7`·`c3e700d`(09-24 OOM 수정, 미배포였음) + `09edacb`·`0ce394d`(관제 대시보드 게이트) → main.
- 한 것: Render `nextspot-api`(512MB 단일 인스턴스)가 09-21 이후 8회 OOM 재시작 — 운영은 OOM 수정이 없는 `6a7d653` API 였다.
  09-25 18:15 KST 는 관제 대시보드가 무거운 관리자 GET 7개를 한꺼번에 쏜 순간(예열이 계단식으로 남긴 ~335MB 위, 09-22 09:40 도
  같은 패턴), 나머지는 예열 직후·예열 타임아웃 직후. `09edacb`: 무거운 관리자 GET 을 동시 2개로 묶는 ASGI 게이트 + 끝날 때마다
  gc·`malloc_trim(0)`(예열 끝에도) · model-trust 는 스냅샷 통째 대신 읽는 칸만 JSON 경로로(거부 시 통째 조회로 물러섬).
- 검증: api `ruff` + `pytest` 1644 통과 · 리뷰 3렌즈(ship, 비차단 지적 1건 `0ce394d` 로 반영) · Linux 전후 RSS(합성 운영 규모,
  관리자 GET 7개 동시): 피크 main 369~375MB → 165~172MB, 예열 뒤 208MB 고정 → 139MB 로 반환, JSON 경로 거부 폴백 시 256MB.
- 다음·미결: 배포 후 Render Metrics 에서 관제 대시보드를 한 번 열어 RSS 가 되돌아오는지, 로그에 `admin_trust_slim_select_failed`
  가 없는지 확인. 예열(GitHub Actions `warmup.yml`)이 남기는 캐시 상한은 `0408bd7` 이 맡는다.
- 사람 작업: Render 대시보드에서 배포 커밋이 `09edacb`+ 인지, `MALLOC_ARENA_MAX=2` 가 이미지 env 로 들어갔는지(Dockerfile) 확인.

## 기록 규칙

세션이 끝나면 "최근 세션" 맨 위에 아래 템플릿으로 추가한다. 제목 형식은 `## YYYY-MM-DD — 제목`(같은 날 두 번째는
`YYYY-MM-DDb`, 세 번째는 `c`). 번호를 매기지 않는다 — 번호는 충돌한다(로그 파일의 -20·-27·-28·-29가 그 흔적).

```markdown
## YYYY-MM-DD — 제목 한 줄
- 도구·브랜치: Claude Code / yunseong
- 커밋: abc1234..def5678 (n건)
- 한 것: (3줄 이내 — 상세는 커밋 본문에)
- 검증: pytest N passed · ruff · web lint/typecheck/test/build · check-docs
- 다음·미결: (다음 세션이 이어받을 것)
- 사람 작업: (외부 콘솔 작업이 생겼으면 "사람 작업 대기"에도 추가)
```

- "배포 상태"의 main 해시와 확인 날짜는 배포를 눈으로 확인한 사람이 갱신한다.
- "사람 작업 대기"·"알려진 이슈"는 끝나면 줄을 **지운다**(완료 표시로 남기지 않는다). 이력은 커밋과 로그 파일에 있다.
- 항목이 10개를 넘으면 가장 오래된 항목을 통째로 `archive/HANDOVER_LOG.md`의 안내문 아래에 붙인다. 이 문서는 400줄 이하.
