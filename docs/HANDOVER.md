# HANDOVER — 현재 상태 (정본)

> "지금 어디까지 왔고 무엇이 남았나"만 담는다. 2026-08-28까지의 세션 기록(§-45 → §6, 음수 번호가 최신)은
> [`archive/HANDOVER_LOG.md`](./archive/HANDOVER_LOG.md)에 그대로 있다. 이 문서는 400줄을 넘기지 않는다 —
> 넘치면 "최근 세션"의 가장 오래된 항목을 로그 파일 맨 위로 옮긴다(`scripts/check-docs.mjs`가 강제).

## 배포 상태

- **main = 프로덕션.** main push가 Vercel(web)·Render(api)를 자동 배포한다. 마지막 반영은 2026-09-08 —
  09-04 정리(`a02be96`) 이후 커밋 범위는 `git log --oneline a02be96..origin/main` 으로 확인한다.
  사람이 마지막으로 배포 결과를 눈으로 확인한 시점은 2026-09-08(관리자 대시보드·통계/성과 리포트 화면).
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
- 검증: `node scripts/check-docs.mjs` 통과 · 배포 API GET 실측(`/api/v1/infrastructures` 1,645곳)
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

## 2026-09-03 — 따라잡기: 08-28 ~ 09-03 73커밋 (기록 없이 main에 올라간 분)

- 도구·브랜치: 팀원(GitHub `ynso-a8`, 커밋 트레일러상 Claude Opus 5 동반) / `yunseong` → main (`e1a058f`..`a02be96`)
- 한 것(08-28): RBAC 배포 전 디버깅(로그 §-45) · 분산코스 간헐 실패 — stale 연결 재시도 3회 + 풀 리셋, 후보 하나의 실패 격리,
  Supabase 요청 15→5건, 업스트림 장애를 503으로 구분(HTTP/1.1 전환 시도는 되돌림) · 개발자 콘솔 "최근 실패" 탭 ·
  관리자 로그인 시 대시보드로 + 시설 응답 타임아웃 2.5→4초 · `account/me`는 camelCase가 맞음(오진 되돌림).
- 한 것(09-02): 역할 변경 신청 동선 + 개발자 콘솔 사용자 관리 개편, 인증 심사 하위 메뉴 · 닉네임 출처 추적(프로바이더 이름
  변경 반영) · 딥링크 진입 시 뒤로가기 5곳 · 마이페이지 관제 진입 카드 · i18n 패리티 검사를 사이드 사전 3개로 확장.
- 한 것(09-03): 사업자등록증 증빙 업로드(버킷·서명 URL·경로 검증 + UI, 심사 화면 증빙 보기, 증빙 삭제 누락 수정) ·
  타임세일이 메인 추천 랭킹에 반영 · 주차 수요 집계를 Postgres RPC(`area_demand_points_near`)로 · `congestion_logs` 신원
  컬럼을 anon에서 차단(컬럼 GRANT) · 계정 삭제 FK + inquiries INSERT 소유권 · `/predict` 미학습 조합 500 · 음성 퍼널 계측
  복구 + XFF 쿨다운 키 · 온보딩 음식 취향 복원 · 파비콘 교체(Gemini 로고였음) · `/mypage/support` i18n · 북마크 되살아남·
  422 표시·저장소 차단 브라우저 첫 화면 등 UI 버그 다수 · 주석·심사 문서 사실 정정 다수.
- 마이그레이션 추가 7건: `20260902130000` role_change_requests · `20260903120000` nickname_source ·
  `20260904090000` account_deletion_fk_fix · `20260904091000` inquiries_insert_ownership · `20260904120000`
  area_demand_points_rpc · `20260904200000` business_documents_bucket · `20260905090000` congestion_logs_column_grants.
  **원격 적용 여부는 문서에 기록되지 않았다** — 위 점검 쿼리 8~14번으로 실측할 것.
- 검증: 각 커밋 메시지에 게이트 결과 기록(pytest·ruff·web 4종). 세션 인계 항목은 남기지 않았다(이 항목은 09-04에 git log로 복원).

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
