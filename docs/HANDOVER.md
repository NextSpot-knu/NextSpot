# HANDOVER — 현재 상태 (정본)

> "지금 어디까지 왔고 무엇이 남았나"만 담는다. 2026-08-28까지의 세션 기록(§-45 → §6)은
> [`archive/HANDOVER_LOG.md`](./archive/HANDOVER_LOG.md)에 그대로 있다. 이 문서는 400줄을 넘기지 않는다 —
> 넘치면 "최근 세션"의 가장 오래된 항목을 로그 파일 맨 위로 옮긴다(`scripts/check-docs.mjs`가 강제).

## 배포 상태

- **main = 프로덕션.** main push가 Vercel(web)·Render(api)를 자동 배포한다. 2026-09-04 기준 `origin/main` = `a02be96`(09-03).
  사람이 마지막으로 배포 결과를 눈으로 확인한 시점은 `e1a058f`(08-28, 로그 §-45).
- Web: https://nextspot-nu.vercel.app — 루트 `vercel.json`이 `npm run build --workspace=apps/web` → `apps/web/out`.
  Vercel 대시보드에 Root Directory를 **설정하지 않는다**(설정하면 워크스페이스 빌드가 깨진다).
- API: https://nextspot-api.onrender.com (`/health`, `/docs`) — `render.yaml` Blueprint, docker, free plan.
- DB · Auth · Storage: Supabase 팀 프로젝트. 원격 마이그레이션 적용 상태는 아래 "마이그레이션 확인" 쿼리로만 믿는다.
- 스케줄: **Supabase pg_cron**이 10분 주기(`nextspot-area-demand-primary`/`-retry`)로
  `POST /api/v1/area-demand/snapshots/collect`를 `X-Service-Token`으로 호출. GitHub Actions는 `ingest`(매일 KST 04:00),
  `train-recommendation-model`(매주 월 03:00 KST) 두 개만 예약 실행이고 `collect-area-demand`·`uptime`은 수동.
- 환경변수 이름·위치·시크릿 목록: [`DEPLOY_AND_ENV.md`](./DEPLOY_AND_ENV.md).
- 심사 계정: `openapi@naver.com`(merchant, 이풍녀 구로쌈밥·맥심가옥 소유) · `openapi@gmail.com`(admin).
  비밀번호는 저장소에 없고 `scripts/seed_judge_accounts.py`가 `JUDGE_ACCOUNT_PASSWORD` env로 시드한다.
  개발자 부트스트랩 계정은 구글 OAuth 1개, `/dev`는 마지막 developer 강등을 거부한다.

## 우선순위

1. **1차 심사자료 제출** — 절차는 `contest/announcements/2026-contest-round1-submission-manual.pdf`,
   데모 전 체크리스트는 [`contest/DEMO_SCENARIO.md`](./contest/DEMO_SCENARIO.md) §0.
2. **사람 작업 대기** 처리 — 특히 토큰 회전과 Kakao 비즈 앱 전환(아래).
3. **결정 필요 3건** — "알려진 이슈" ①~③.
4. 정리 후속(코드에 영향 없는 것부터): 죽은 i18n 키 후보 53개 정리 · `ingest.yml` 리포트를 artifact로 보존 ·
   `apps/web/lib`·`apps/api/app/services`의 점진 이동(규칙은 `AGENTS.md` "새 파일은 어디에").
5. [`archive/IMPROVEMENT_PLAN.md`](./archive/IMPROVEMENT_PLAN.md) "2026-08-21 갱신" 절의 미완 항목 재확인(09-04 기준 미실측).

## 사람 작업 대기

외부 콘솔 접근이 필요해 코드로 못 하는 일. 끝나면 줄을 지우고 "최근 세션"에 한 줄 남긴다.

- [ ] **`ADMIN_API_TOKEN` 회전** — 구 값은 한때 `NEXT_PUBLIC_`으로 번들에 실렸던 값이라 공개된 것으로 취급.
      순서(수집 중단 없이): 새 값 생성 → Render에 `SERVICE_API_TOKEN` 추가(기존 `ADMIN_API_TOKEN`은 둔다) →
      Supabase Vault `nextspot_area_demand_admin_token` 갱신 → GitHub Actions Secret `SERVICE_API_TOKEN` 추가 →
      다음 10분 수집 정상 확인 → `ADMIN_API_TOKEN`을 새 값으로 교체.
- [ ] **Kakao 개발자 콘솔** — 개인 개발자 → 비즈 앱 전환(`account_email` 스코프가 GoTrue에 고정돼 있어 이것 없이는
      KOE205가 안 풀린다). 앱 이름이 아직 "Induspot" — 동의 화면에 그대로 나온다 → "NextSpot".
- [ ] **Google OAuth 동의 화면 게시**(테스트 모드 해제) — 로그 §-43.
- [ ] **Supabase Auth Site URL**이 `localhost:3000`이면 Vercel 도메인으로(대시보드에서만 확인 가능).
- [ ] **Render `ALLOWED_ORIGINS`** — Vercel 도메인으로 지정해야 엄격 모드(해당 오리진만 + credentials). 미지정 시 와일드카드.
- [ ] **심사 계정 2개 브라우저 로그인 확인** — `openapi@naver.com` → `/merchant`, `openapi@gmail.com` → `/admin/dashboard`.
- [ ] **GitHub Actions Secrets 점검** — `train-recommendation-model.yml`은 `JWT_SECRET`·`ADMIN_API_TOKEN` 시크릿이 없으면
      부팅 검증에서 실패한다(플레이스홀더 폴백 없음). `SUPABASE_URL`·`SUPABASE_ANON_KEY`·`SUPABASE_SERVICE_ROLE_KEY`·
      `TOURAPI_KEY`·`KAKAO_REST_API_KEY`·`LOCALDATA_AUTH_KEY`(선택)와 함께 등록돼 있는지 확인.
- [ ] `docs/MERCHANT_CONSOLE_RBAC_PLAN.md`(로컬 전용, 심사 자격증명 포함이라 미커밋)가 새 클론에는 없다 — 원본 보유자가
      필요하면 보관. 없어도 운영에는 지장 없음(내용은 로그 §-44에 요약).

## 알려진 이슈

결정이 필요한 것(①~③)과 알고 있지만 지금은 두는 것.

- ① **집중률 상대지수를 절대 점유율처럼 섞는다** — `app/services/area_demand_service.py`의 0.7/0.3 블렌딩.
  관광공사 집중률은 지점별 기준선 대비 상대값이라 "100 = 만석"이 아니다. 사용자에게 보이는 숫자가 바뀌는 문제라 데이터를 놓고 결정.
- ② **developer의 좌석 방송이 `verified`로 학습에 들어간다** — 소유자가 아닌 사람의 방송은 `single_report`로 낮추는 안.
- ③ **인증 없는 쓰기 4경로에 유량 제한이 없다** — 특히 `POST /voice/turn`(LLM 비용). `events/track`, `travel-context/parse`,
  `search/ingest-request`도 포함. 공개 후에는 `/voice/turn`부터.
- 스테이징이 없다 — **실 DB는 읽기만**, 쓰기 검증은 로컬 대역으로(08-28에 실 DB에 가짜 verified 3행을 쓴 전례).
- 프로필 캐시가 프로세스 내부(30초) — 워커 1개라 지금은 무해, `--workers N`을 붙이면 공유 무효화 필요.
- 메인 지도 `/infrastructures` 응답이 2.5초 경계에 걸려 폴백 경로로 돌던 문제는 타임아웃을 4초로 올려 완화(08-28).
  근본 해결은 지도용 경량 응답 분리(`overview_i18n` 64KB 제외).
- `20260905090000_congestion_logs_column_grants.sql`은 09-03에 만든 미래 날짜 파일이다. **새 마이그레이션은 이보다 큰
  타임스탬프**를 써야 적용 순서가 유지된다(`supabase db push`는 원격 head보다 오래된 파일을 건너뛴다).
- 원격 DB에 마이그레이션이 파일명 순서와 다르게 적용된 이력이 있다 — 순서를 가정하지 말고 아래 쿼리로 실측.
- 죽은 i18n 키 후보 53개(×4로케일) — `setup.step0/1/3`, `auth.signInKakao/…`, `weather.source/…`, `mypage.vectorTitle/…` 등.
  동적 키(`t(\`ns.${x}\`)`) 오탐 가능성이 있어 지우기 전에 네임스페이스별로 확인.

## 마이그레이션 확인

읽기 전용 점검 쿼리(Supabase SQL Editor). 적용 후에는 **`NOTIFY pgrst, 'reload schema';`** — PostgREST가 스키마를
캐시해서 이걸 빼먹으면 새 컬럼·테이블을 한동안 못 보고 백엔드가 폴백 경로로 돈다.

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
  (9, '20260904120000_area_demand_points_rpc', to_regprocedure('public.area_demand_points_near(double precision,double precision,double precision,timestamptz)') is not null
      or exists (select 1 from pg_proc where proname='area_demand_points_near')),
  (10, '20260904200000_business_documents_bucket', exists (select 1 from storage.buckets where id='business-documents')),
  (11, '20260905090000_congestion_logs_column_grants',
      not has_table_privilege('anon','public.congestion_logs','SELECT')
      and has_column_privilege('anon','public.congestion_logs','facility_id','SELECT'))
)
select seq, migration, case when applied then '적용됨' else '미적용' end as status
from checks order by seq;
```

## 최근 세션

최신이 위. 10개를 넘으면 가장 오래된 항목을 `archive/HANDOVER_LOG.md` 맨 위로 옮긴다.

## 2026-09-04 — 저장소 정리: 죽은 파일 제거 · 문서 트리 재편 · 규칙 정본 재작성

- 도구·브랜치: Claude Code(레드팀 하위 에이전트 6렌즈 → 실행 → 재검토 루프) / `chore/repo-cleanup` → main
- 커밋: 이 브랜치의 커밋 7개 — 죽은 파일 제거 → 문서 트리 → 규칙·상태 문서 → 문서 사실 정정 → web 구조 → api 구조 → 마무리
- 한 것: InduSpot 잔재(seed.js·bg.png·landmarks.ts 등)와 Gemini 파일 제거 · `docs/`를 운영/contest/archive로 나누고
  색인(`docs/README.md`)과 CI 문서 검사(`scripts/check-docs.mjs`) 추가 · `AGENTS.md`를 현재 사실(RBAC 권한, 브랜치, 게이트,
  새 파일 위치)로 재작성 · HANDOVER를 상태 문서 + 아카이브 로그로 분리 · 낡은 문서 사실 약 40건 정정 ·
  web 컴포넌트/lib 일부 묶기 + 테스트 러너 glob화 · api 테스트 폴더 정리.
- 검증: 커밋마다 해당 게이트(web lint/typecheck/test/build, ruff/pytest, 스키마 파리티, check-docs) 통과 후 커밋.
- 다음·미결: "우선순위" 4번 정리 후속. 원격 브랜치 6개(feature/*, yunseong 등)는 전부 main에 합쳐져 있으나 팀원 소유라 삭제하지 않았다.
- 사람 작업: 위 "사람 작업 대기"에 정리(토큰 회전·Kakao·Google·Site URL·CORS·시크릿 점검·심사 계정 확인).

## 2026-09-03 — 따라잡기: 08-28 ~ 09-03 73커밋 (기록 없이 main에 올라간 분)

- 도구·브랜치: ynso-a8 / `yunseong` → main (`e1a058f`..`a02be96`)
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
  **원격 적용 여부는 문서에 기록되지 않았다** — 위 점검 쿼리 7~11번으로 실측할 것.
- 검증: 각 커밋 메시지에 게이트 결과 기록(pytest·ruff·web 4종). 세션 인계 항목은 남기지 않았다(이 항목은 09-04에 git log로 복원).

## 기록 규칙

세션이 끝나면 "최근 세션" 맨 위에 아래 템플릿으로 추가한다. 제목 형식은 `## YYYY-MM-DD — 제목`(같은 날 두 번째는
`YYYY-MM-DDb`, 세 번째는 `c`). 번호를 매기지 않는다 — 번호는 충돌한다(로그 파일의 -20·-27·-28·-29가 그 흔적).

```markdown
## 2026-09-10 — 제목 한 줄
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
