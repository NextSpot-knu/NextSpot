# HANDOVER — 현재 상태 (정본)

> "지금 어디까지 왔고 무엇이 남았나"만 담는다. 2026-08-28까지의 세션 기록(§-45 → §6, 음수 번호가 최신)은
> [`archive/HANDOVER_LOG.md`](./archive/HANDOVER_LOG.md)에 그대로 있다. 이 문서는 400줄을 넘기지 않는다 —
> 넘치면 "최근 세션"의 가장 오래된 항목을 로그 파일 맨 위로 옮긴다(`scripts/check-docs.mjs`가 강제).

## 배포 상태

- **main = 프로덕션.** main push가 Vercel(web)·Render(api)를 자동 배포한다. 마지막 반영은 2026-09-21 —
  `9ec3894`+(심사용 계정 안내, 아래 `2026-09-21b`; 그전 `374254c`·소개 개편 `a3b8a6b` 포함). `/guide`는 줄·혼잡으로 잃는 여행 시간과 주변 대안·이동 코스라는
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

## 2026-09-21b — 심사용 계정 안내: 로그인 화면과 두 콘솔 관문

- 도구·브랜치: claude.ai 세션(패치 초안) → Claude Code(워크트리 적용 · 7렌즈 리뷰 워크플로 + Codex 교차 리뷰 · 검증 · 푸시) /
  `feature/judge-account-hint` → main.
- 커밋: `9ec3894` (기능 1건) + 이 기록.
- 한 것: 제출 양식은 테스트 계정 도메인을 **하나만** 받는데 콘솔 계정은 둘이라(사장님 `openapi@naver.com`, 관제
  `openapi@gmail.com`), 폼에 못 적은 쪽 콘솔은 심사위원이 들어올 방법이 없었다. `JudgeAccountHint`를 `/login`
  (`?next=`가 콘솔이면 그 계정만 + 이메일 자동 입력, 없으면 두 계정을 역할과 함께), `/admin/login` 두 상태, `/merchant` 관문에 붙였다.
  `/merchant`는 게스트(익명)·관리자 계정에 버튼이 하나도 없던 막다른 길이라 로그인 버튼도 넣었다(이미 로그인된 계정에는 '다른 계정으로 로그인').
  서비스 소개(`/guide`)에는 넣지 않았다 — 소개는 관광객 문구만 두기로 한 09-20 결정을 따랐고, 소개의 콘솔 버튼이 곧장 관문으로 보내
  거기서 안내가 보인다(넣으려면 `GuideContent.tsx`에 `<JudgeAccountHint />` 한 줄, 문구 키는 이미 있다).
  계정↔역할 정본은 `seed_judge_accounts.py`이고 `lib/judgeAccounts.test.ts`가 어긋남을 잡는다. 비밀번호는 화면·번들에 두지 않는다.
  리뷰 반영: 라벨 위·주소 아래 2줄 배치(ja 라벨이 고정폭을 넘쳤다) · '입력' 버튼을 `dd` 안으로(HTML 내용 모델) ·
  가입 탭으로 바꾸면 미리 넣은 심사 이메일을 비움 · `auth-flows.spec.ts`에 심사 계정 안내·자동 입력 케이스 추가.
- 검증: web lint 0 errors · typecheck · test 52파일(i18n 4로케일 패리티) · Turbopack `next build` 정적 프리렌더 · check-docs ·
  Playwright e2e 전체 43개 중 42 통과 + `voice-controls.spec.ts:99` 1회 실패 후 단독 재실행 통과(`/main` 음성 테스트, 이 변경과 무관) ·
  리뷰 반영 뒤 `auth-flows.spec.ts` 재실행 · 390px 스크린샷 10장(ko·en × `/login` 3상태·`/merchant`·`/admin/login`)으로
  계정·자동 입력·가로 스크롤 없음 확인.
- 다음·미결: 공용 `/login`(`?next=` 없음)에 두 계정을 보이는 것은 심사 기간의 의도적 선택 — 심사 뒤 관광객 화면에서 빼려면
  `app/login/page.tsx`의 힌트 렌더를 `judgeConsole &&`로 묶는다. 심사 계정의 시설 삭제·설정 변경 차단(관리자 API)은 하지 않았다.
- 사람 작업: 배포 후 시크릿 창에서 두 계정 로그인 → `/merchant`·`/admin/dashboard` 열림 확인. 운영사무국에 추가 계정 통보.

## 2026-09-21 — 제출일 전면 스윕: 출처표기·관제 라이트 테마·상용 UI·심사 대비

- 도구·브랜치: Claude Code(메인 + 병렬 서브에이전트 다수 + 워크플로 2회) + Codex 병행 / `feature/judge-guide` → main (`706353a`…`6a7d653`+).
- 한 것: ① 관제 콘솔 라이트 종이 테마 전환(hanok 토큰 재정의 + 전 화면 잔존 다크 텍스트 색·차트 hex 일소) 및
  NextSpot 워드마크 적용, 대시보드 F-패턴 재배치·로딩 실루엣(시머·블러 고스트·비선형 동기화 스트립).
  ② 공모전 출처표기 보강: 추천 카드 기본 상태 ⓒ배지, /waiting·/course·/explore 푸터, /main 동기화 칩 상시 표기,
  랜딩 출처 줄 승격. 관제 로그인 부제의 공공기관 운영 주체 표기 제거(출처 각주만 허용 — 재발 금지).
  ③ 고백형 문구 정리: 신뢰도 패널(관측 0 카드 게이팅·0.0% 타일 억제·안내/점검 분리), 가드레일·엔진 검증 문구
  상태+행동형 재작성, 관광객 4로케일 문구 12종 교체, 죽은 demoData 키 삭제.
  ④ 상용 UI: 랜딩 히어로(경주 배지·가치 칩 4종), /waiting·/explore·/saved 골드 랭크·히어로 스탯,
  사장님 콘솔 개편, /main 초기 지도 중심 가시영역 보정 + 언어 전환 노출, 대기보드 스테일-우선 캐시.
- 검증: web lint(0 errors)/typecheck/test 50파일/build 전 페이지 프리렌더, api ruff/pytest 1,606건. 배포 후 랜딩·/waiting·/main·관제 로그인 브라우저 확인.
- 다음·미결: 컴플라이언스 감사 결과와 제출 붙여넣기 블록은 팀 로컬 제출 문서에 정리(심사계정 로그인 실증·기능설명서 지정 양식·폼 지역특화 체크가 사람 필수 항목).
- 사람 작업: 심사계정 2종 브라우저 로그인 확인, 콘텐츠랩 제출(16:00 전), data.go.kr 보조 API 2종 승인 확인 후 폼 기재 여부 결정.

## 2026-09-20c — 대기 문제와 해결만 남긴 서비스 소개

- 도구·브랜치: Codex / `feature/judge-guide` → main (`a3b8a6b`).
- 한 것: `/guide`의 추상적인 취향 서사와 점수·데이터·사업·전체 기능 등 6개 설명 장을 제거했다. 첫 화면은
  “줄 서는 대신, 경주를 한 곳 더”를 중심으로 긴 줄·밀리는 일정·포기하는 장소라는 관광객 문제와,
  도착 시점 혼잡 비교→비슷한 경험의 가까운 대안→바로 가는 코스라는 해결만 보여 준다. ko/en/ja/zh를 함께 반영했다.
- 검증: web typecheck · i18n 키/4로케일 파리티 · 정적 build 39페이지 · guide Playwright 7건
  (4로케일, 320/390/1440px, 키보드·테마) 통과. Vercel `/guide` 응답에서 새 문제·해결 문구와 이전 문구 부재를 확인했다.
  최신 main CI에서 guide 포함 e2e는 통과했고, 전체 결과는 별도 변경의 web `congestionEstimate` 테스트와 API pytest 실패로 빨간불이다.
- 다음·미결: 소개 화면 코드 작업은 없음.
- 사람 작업: 최종 제출 전 실제 심사 기기에서 `/guide` 첫 화면을 한 번 눈으로 확인.

## 2026-09-20b — 심사 체험을 연결하는 서비스 소개

- 도구·브랜치: Codex / `feature/judge-guide` — `bf954d0` 원격 main을 새 클론으로 받아 작업.
- 한 것: 왼쪽 아래 도움말 → 상태를 보존하는 소개 대화상자 + 공유 가능한 `/guide`. 경주 문제·같은 경험의 대안·SPOT 근거·데이터 활용·실행 흐름·지역 운영의 여섯 장면. ko/en/ja/zh, 모바일·야간 테마·키보드 접근 지원.
- 보강: 취향→지도→코스 체험 순서, 코스 고정/재계획, 관측·추정·수집 중 구분, 권한이 필요한 콘솔 안내. 창업 신청서의 검증 가능한 계획을 바탕으로 여행 시간 문제·주민 기대효과·12주 실증·단계별 사업 모델·지역 대학 팀 역량을 간결하게 추가했다. 제휴·과금·도착·대기 절감·혼잡 완화는 계획과 실측 조건을 명시한다. 마무리 교차 검토로 목적지 선택 모형 근거·상인 타임세일 수요 유도·B2B 쿠폰 폐루프 근거·타 지역 확장 계획을 보강하고, 팀 표기를 '대구'로 바로잡고 죽은 키(futureTitle)·orphan .future CSS를 정리했다. 전체 기능 챕터 상단에 시그니처 6종 그리드(도착시점 예측·결합 산식·음성 비서·B2G 관제·학습 취향·배리어프리)를 추가해 구현된 독창성을 전면 배치했다.
- 검증: Astra6 전략 검토 + Sol 코드 검토(포커스 복원·모바일 하단 여백 보완). web lint(기존 145 warnings, 0 errors)/typecheck/test(50파일)/build(39페이지), e2e 30건, API ruff/pytest 1,534건, 스키마 파리티·문서 검사 통과.
- 다음·미결: `feature/judge-guide` 검토 후 main 반영. 기존 작업 폴더와 프로덕션은 변경하지 않음. 모바일 하단 여백은 `--tourist-nav-clearance`로 통일해 소개 진입 줄이 기존 버튼을 가리지 않게 함.
- 사람 작업: 기존 심사 계정 로그인 확인 및 제출 양식에 소개 진입 방법 안내.

## 2026-09-20 — 혼잡 엔진: 경주 추정 모드(관리자·관광객 화면) + 서울 검증 수집기·검증 화면

- 도구·브랜치: Claude Code(메인 + 서브에이전트 4 병렬) / `yunseong` — 커밋 전(사용자 지시 대기)
- 결정: [`CONGESTION_ENGINE_PLAN.md`](./CONGESTION_ENGINE_PLAN.md) D1~D6 전부 권장안, 서울 대상지 **홍대 관광특구 1곳**(§4 반영 블록).
- 한 것:
  - **추정기** `congestion_estimator_service.py` — 0.7·격자 반경 2km 공영주차 점유율 + 0.3·관광 집중률 기준선. `congestion_logs` 에
    적재하지 않고 `area_demand_snapshots`(08-20~ 30일치)에서 **읽을 때 계산**(§5.2 반영 블록 — 하루 12만 행 적재·실측 혼합을 피함).
    실측 확인: 1,669곳 중 846곳 추정, 9/19(토) 대표 관광지 10곳 평균 0.66·피크 0.92.
  - **관리자 대시보드** — `/admin/dashboard/today` 에 `estimated` 키(추가만). 순서: 오늘 실측 → 오늘 추정 → 과거 폴백.
    추정 값은 점선 테두리 + "추정" 배지 + 근거 문장. 성과 리포트 '오늘 현황'도 추정 표시. D6: "24시간 모의 발생"·주차 추정 적재 버튼 제거(엔드포인트 잔존).
  - **관광객 화면** — 지도(점선 핀 + 범례, 새 `GET /api/v1/congestion/estimates`)·시설 상세·추천 카드·코스에 "추정" 근거 배지.
    D2는 `estimated_rules` 를 **만들지 않았다**: `area_stats_rules` 가 이미 같은 산식(주차 0.7 + 관광 0.3)으로 순위에 반영 중이라
    새 모드는 이중 계산이다. 대신 추정 ≥0.9 이면 실측 ≥0.9 처럼 계층 이점을 잃는 **강등 전용** 관문만 추가(`score.py` 4-2, 레드팀 발견).
    추정은 `congestion_source` 를 바꾸지 않는 별도 필드(`congestion_estimate`)라 옛 웹·학습·실측 배지에 닿지 않는다.
  - **서울 수집기** — `seoul_citydata_service.py` + `POST /api/v1/engine-validation/seoul/collect`(기계·관리자) + 테이블·pg_cron 마이그레이션
    (`20260920120000`·`20260920121000`, **미적용**). 샘플 키는 어떤 이름을 요청해도 광화문을 돌려줘 이름 불일치를 거절(`seoul_area_mismatch`).
  - **검증 화면** `/admin/engine-validation` + 사이드바 "엔진 검증" — 등급 일치율·인접 일치율·Spearman·위험 오분류·30분 전망 MAE(지속 모델 대비)·
    커버리지. 1곳이라 구분 가능률은 계산 불가로 명시. 표본 부족·수집 전 상태를 그대로 보여 준다.
- 검증: api ruff · pytest 1,427 · web lint(경고 145 = 기준선) · typecheck · test 48파일 · build · e2e 23 · check-docs · check-i18n.
  관리자 화면은 로그인이 필요해 브라우저 육안 확인은 못 했다(에이전트가 실데이터 읽기 전용으로 값 확인).
- 다음·미결: 사람 작업 "서울 실시간 도시데이터 수집 개시". 통계 리포트(`/admin/reports`)·성과 리포트 30일 차트는 여전히 실측만 읽어 비어 있다
  (하루 계산 1~3초라 일괄 경로가 따로 필요). 단일 제보·오래된 실측이 신선한 추정보다 우선하는 규칙 재검토(§5.2는 신뢰 실측 30분만 덮어쓰기).
- 사람 작업: 위 "사람 작업 대기" 첫 항목.

## 2026-09-09 — 혼잡 엔진 계획 초안: 서울 검증 지역 + 경주 추정 모드

- 도구·브랜치: Claude Code / `yunseong` — **문서만**(코드 변경 없음)
- 커밋: 09-20 구현 커밋에 함께 포함
- 한 것: 회의 결론(통신사 실시간 유동인구는 가격 때문에 배제, 서울 실시간 도시데이터를 엔진 검증용으로 도입, 경주는
  실시간 없음을 인정하고 주차·집중률로 구역 혼잡을 추정)을 [`CONGESTION_ENGINE_PLAN.md`](./CONGESTION_ENGINE_PLAN.md)로 정리.
  §2에 원안과 코드 사실이 어긋난 7곳(집중률은 총량이 아닌 상대지수 · ITS 실시간 주차장 4곳 · `simulated` 이름 충돌 등),
  §10에 결정 D1~D6. 서울 API 사양(121곳 · 5분 · 대상지당 1회 호출 · 이력 미제공 · 공공누리 1유형)은 09-09 웹 확인.
- 검증: `node scripts/check-docs.mjs`
- 다음·미결: 사용자가 §2·§10을 검토·수정 → 확정되면 계획 §8의 사람 작업을 이 문서 "사람 작업 대기"로 옮기고 Phase 1(서울 수집기)부터.
  수집 일수가 병목이라 인증키 발급이 가장 급하다.
- 사람 작업: 계획 §8 참조(서울 열린데이터광장 인증키 · 일 호출 한도 · 대상지 20~30곳 확정) — 확정 전이라 아직 옮기지 않았다.

## 2026-09-08 — 검토 결정 반영 · 관리자 대시보드 · 주차 실측 기반 혼잡 추정 · e2e 결정성

- 도구·브랜치: Claude Code(메인 + 서브에이전트 병렬) / `yunseong` → `main` 승격
- 한 것(요지만 — 이유는 각 커밋 메시지에 있다):
  - **e2e 가 프로덕션 Supabase 를 실제로 호출하고 있었다.** CI 는 이 묶음을 "결정적(외부 네트워크 없이)"
    이라고 적어 두었지만 앱이 부팅하며 `POST /auth/v1/signup` 을 보냈고, 늦으면 `AuthError` 가 나
    화면이 '조건에 맞는 곳 0건' 을 **'장애'** 로 바꿔 말했다. `e2e/support/stubs.ts` 로 인증까지 스텁했고
    **이틀간 빨간불이던 CI e2e 잡이 초록이 됐다.** 소스 배선 가드로 잠갔다.
  - **SPOT 근거 등급 정렬**(다른 시간비용 공식의 점수를 한 줄에 세우지 않는다) + 업종 기준선.
    '이미 붐비는 것이 확인된' 후보는 등급 이점을 받지 않는다(컷오프 0.9 = 대시보드 이상 혼잡 선 재사용).
    코스 화면에도 혼잡 근거를 배선했다 — 그전에는 좌석 방송이 코스에서 `measured_rules` 로 들어갈 수 없었다.
  - **관리자 대시보드**: 오늘이 비면 '같은 최소 표본 기준을 통과하는 최근 날' 로 폴백하되 기준일을 반드시
    함께 그린다. 주차 실측을 출처를 갈라 별도 카드로. 장소 표 상태 칸 줄바꿈. 사실이 아니던 히트맵 문구 제거.
  - **주차 실측 기반 시설 혼잡 추정**(신규): `source='parking_derived'` · `evidence_tier='synthetic'` 로
    **추천 순위·모델 학습에서 구조적으로 제외**되고 화면이 추정임을 말한다. 관리자 수동 트리거만 만들었다.
  - **성과 리포트 그래프가 안 보이던 원인은 색이 아니라 레이아웃**이었다 — `.report-paper` 가 높이 고정된
    플렉스 아이템이라 `bg-white` 가 872px 만 칠하고, 차트는 관제 셸의 다크 배경 위에 그려지고 있었다
    (축 눈금 대비 1.10:1). 인쇄는 `print:h-auto` 덕에 멀쩡해서 PDF 만 보면 안 보이는 버그였다.
  - 결측 구간을 직선으로 잇던 것을 두 차트에서 모두 걷어냈다(`lib/adminSeriesGaps.ts` 공용).
  - `/course` 브라우저 회귀 테스트 6개 추가(e2e 17 → 23).
- 마이그레이션 3건이 **적용 대기**: `20260908090000`(혼잡 경계 75) · `20260908091000`(기본 공지 문구 비우기) ·
  `20260908120000`(parking_derived source + `current_count` NULL 허용 + 버킷 유니크 인덱스).
- 사람 판단이 남은 것은 저장소 밖 검토 문서에 정리했다.

## 2026-09-07 — 문서 사실성 감사: 화면↔API 매핑 4행 · 삭제된 화면 · 배포 상태 · 데모 대본

- 도구·브랜치: Claude Code(문서 전담) / `yunseong` — **문서만 수정**(코드는 읽기 전용, 같은 시각 다른 작업자가 `apps/api`·`apps/web` 작업 중)
- 커밋: 없음 — 작업 트리 상태로 남겼다(커밋·푸시는 사용자 확인 후)
- 한 것: `SYSTEM_MAP` §5.1(관광객)·§5.3(관제) 표를 `apps/web/app` 코드와 1행씩 대조해 재작성 —
  삭제된 `/explore/map`(리다이렉트 스텁), `/setup`의 없는 API 호출, `/waiting`의 실제 호출(`/recommendations/by-type`),
  대시보드에 있는 패널을 `/admin/simulator`·`/admin/report`·`/admin/reports`로 적던 4행 · §5.4(개발자 콘솔) ·
  §6.1(코스 재계획: `alternatives`·`slot_outcomes`·`plan_id`·`pins`) · §7.1(`admin_override`) · §11(`area-demand-alert`) 추가 ·
  `HANDOVER` 배포 상태·예약 워크플로 3개·마이그레이션 15번 · `contest/DEMO_SCENARIO.md` 체크리스트 12
  (비활성 시드는 지도에서도 빠진다 — 배포 API로 실측).
- 검증: `node scripts/check-docs.mjs` 통과 · 배포 API GET 실측(당시 1,645곳 — 2026-09-20 재측정 활성 1,669곳/전체 1,688곳)
- 다음·미결: `/search/keyword`·`/search/ingest-request`가 프런트에서 끊긴 것은 **문서에 사실로 적어 두기만 했다** — 되살릴지 지울지는 코드 결정.
- 사람 작업: 마이그레이션 15번 원격 적용 여부 확인 · `area-demand-alert` 시크릿/변수 등록 확인(위 두 절에 추가).

## 2026-09-06 — 분산 코스 재계획 · 관리자 개입 정직화 · 주차 수집 중단 감시 (커밋 로그에서 복원)

- 도구·브랜치: 팀원 / `yunseong` → main (`b6bdcd8`..`d303d80`, 17건 — 머지 커밋 1 포함)
- 한 것: **역할 신청** 본인 철회·수정(`facility_id`는 수정 불가) + 가게가 없는 신청의 승인 경로(기존 연결 / 새 POI 생성) ·
  **분산 코스** `POST /courses/plan` — 자리마다 현재 위치 기준 재선정, 자리별 대안·고정(`pins`)·`slot_outcomes`·`plan_id`,
  보행경로 슬롯당 1회 배치, 코스가 비어도 이유를 돌려주기(심야 규칙 포함) · **관리자 수동 혼잡 개입**을
  `admin_override`/`single_report`로 내려 모델 학습 정답에서 배제 · **주차 실측 수집 중단 경보**(`area-demand-alert.yml` 매시 +
  `GET /admin/area-demand-reliability`의 `alert.state` + 대시보드 패널) · 코스 공유 링크·온보딩 도보시간 등 web 버그.
- 마이그레이션 추가 1건: `20260906120000_admin_override_source`(**코드보다 먼저 원격 적용돼야 한다** — 위 점검 쿼리 15번).
- 검증: 확인 불가 — 이 항목은 커밋 로그에서 복원한 것이고, 이 17건의 커밋 본문에는 게이트 결과가 적혀 있지 않다.
- 다음·미결: 마이그레이션 원격 적용 여부 미기록. 09-07 감사 라운드 1·2(6건)가 `yunseong`에 남아 main 미반영.

## 2026-09-04 — 저장소 정리: 죽은 파일 제거 · 문서 트리 재편 · 규칙 정본 재작성

- 도구·브랜치: Claude Code(레드팀 하위 에이전트 6렌즈 → 실행 → 재검토 루프) / `chore/repo-cleanup` → main
- 커밋: 이 브랜치 10건(`git log --oneline d267e6b..b6bdcd8`) — 죽은 파일 제거 → 문서 트리 → 규칙·상태 문서 →
  문서 사실 정정 → 설정·워크플로 → web 구조 → api 구조 → 레드팀 2라운드 반영(보안 진단·i18n 삭제) → 3라운드 반영(심사 문서 정정)
- 한 것: InduSpot 잔재(seed.js·bg.png·landmarks.ts 등)와 Gemini 파일 제거 · `docs/`를 운영/contest/archive로 나누고
  색인(`docs/README.md`)과 CI 문서 검사(`scripts/check-docs.mjs`) 추가 · `AGENTS.md`를 현재 사실(RBAC 권한, 브랜치, 게이트,
  새 파일 위치)로 재작성 · HANDOVER를 상태 문서 + 아카이브 로그로 분리 · 낡은 문서 사실 약 40건 정정 ·
  web 컴포넌트/lib 일부 묶기 + 테스트 러너 glob화 · api 테스트 폴더 정리.
- 검증: 커밋마다 해당 게이트(web lint/typecheck/test/build, ruff/pytest, 스키마 파리티, check-docs) 통과 후 커밋.
- 다음·미결: "우선순위" 4번 정리 후속. 원격 브랜치 6개(feature/*, yunseong 등)는 전부 main에 합쳐져 있으나(`ui-editorial-pass`는
  머지 후 되돌려져 작업물이 브랜치에만 남아 있다 — SYSTEM_MAP §14) 팀원 소유라 삭제하지 않았다.
- 사람 작업: 위 "사람 작업 대기"에 정리(토큰 회전·Kakao·Google·Site URL·CORS·시크릿 점검·심사 계정 확인).

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
