# NextSpot — 관광 수요 재배치 플랫폼 · 규칙 정본

2026 관광데이터 활용 공모전(웹·앱 개발 부문) 출품작. 경주 황리단길의 오버투어리즘을
SPOT(Smart Place Optimization for Tourism) 점수로 분산·재배치하는 AI 대안 장소 추천 웹 서비스.
**이 파일이 사람·에이전트 공통 규칙의 정본이다.** `CLAUDE.md`·`.agents/rules/`는 여기로 오는 포인터일 뿐이며,
규칙이 생기면 여기에만 쓴다.

## 읽는 순서 (첫 5분)

1. 이 파일 — 규칙 · 게이트 · 구조
2. [`docs/HANDOVER.md`](docs/HANDOVER.md) — 배포 상태 · 사람 작업 대기 · 알려진 이슈 · 최근 세션. **현재 상태의 정본**
3. [`docs/SYSTEM_MAP.md`](docs/SYSTEM_MAP.md) — 화면↔API↔서비스↔DB 연결. 필요한 절만
4. 웹 작업이면 [`apps/web/AGENTS.md`](apps/web/AGENTS.md). 전체 문서 목록·상태는 [`docs/README.md`](docs/README.md)

## 무엇이 정본인가

| 무엇 | 정본 |
|---|---|
| 현재 상태 · 백로그 · 사람 작업 | `docs/HANDOVER.md` |
| 구조 · 데이터 흐름 | `docs/SYSTEM_MAP.md` |
| DB 스키마 | `supabase/migrations/` (`RESET_AND_SETUP.sql`은 자동 생성물) |
| SPOT 산식 · 가중치 | `apps/api/app/services/spot/score.py` ↔ `packages/shared-types/spot.ts` (CI 패리티 테스트) |
| 환경변수 이름 · 배포 절차 | `docs/DEPLOY_AND_ENV.md`, `render.yaml`, `apps/*/.env.example` |
| 발표 대본 · 심사 답변 | `docs/contest/DEMO_SCENARIO.md`, `docs/contest/JUDGE_QA.md` |
| 과거 결정 · 끝난 계획 | `docs/archive/` (읽기 전용) |

## 구조

- `apps/web` — Next.js 16 **정적 export**(`output:'export'` — 서버 액션·route handler 불가). 관광객 앱 +
  `admin/*` B2G 관제 + `merchant/*` 사장님 콘솔 + `dev` 개발자 콘솔. 하위 정본 `apps/web/AGENTS.md`.
- `apps/api` — FastAPI. 라우터 `app/routers/`, 서비스 `app/services/`(SPOT은 `spot/`, TourAPI는 `tourapi/`,
  적재 스크립트 전용은 `batch/`), 인증·권한 `app/core/authz.py`, 설정 `app/core/config.py`.
- `packages/shared-types` — SPOT 상수의 단일 정의점(web이 `transpilePackages`로 TS 소스를 직접 소비).
- `supabase/migrations/` — 스키마 정본. `scripts/build_reset.mjs`가 `RESET_AND_SETUP.sql`을 생성한다.
- `scripts/` — 저장소 도구(node). `apps/api/scripts/` — 적재·학습처럼 `app`을 import하는 파이썬 스크립트.
- `.github/workflows/` — `ci`(게이트) · `ingest`(매일 KST 04:00 TourAPI 적재) ·
  `train-recommendation-model`(매주 월 03:00 KST 후보 학습) · `collect-area-demand`·`uptime`(수동 복구용).
- 배포: web = Vercel(main push 자동, 루트 `vercel.json`이 워크스페이스 빌드 — 대시보드 Root Directory 설정 없음),
  api = Render Blueprint(`render.yaml`, `/health`), DB·Auth·Storage = Supabase, 10분 주차 실측 수집 = Supabase pg_cron.

## 검증 게이트 — 커밋 전 필수 (CI `.github/workflows/ci.yml`과 동일)

| 게이트 | 명령 (실행 위치) |
|---|---|
| web | `npm run lint && npm run typecheck && npm run test && npm run build` (`apps/web`) |
| api | `python -m ruff check . && python -m pytest -q` (`apps/api`, Python **3.11**, `PYTHONUTF8=1`) |
| 스키마 파리티 | `node scripts/build_reset.mjs && git diff --exit-code supabase/RESET_AND_SETUP.sql` (루트) |
| 문서 | `node scripts/check-docs.mjs` (루트) — 색인 · 링크 · HANDOVER 형식 |
| e2e (CI에서 자동) | `npm run test:e2e` (`apps/web`, Playwright Chromium 390px · 4로케일) |

- pytest는 네트워크·실DB 불필요 — `tests/conftest.py`가 placeholder env를 주입하고 외부 호출을 차단한다.
  `apps/api/conftest.py`(주석만 있는 sys.path 앵커)는 삭제 금지.
- `npm run test` = `scripts/check-i18n-keys.mjs`(코드가 부르는 키가 ko.json에 있는지) +
  `apps/web/lib/**/*.test.ts` 전부(`scripts/run-web-tests.mjs`가 glob으로 찾는다 — 새 테스트는 만들기만 하면 돈다).
- Python은 **3.11 고정**(CI·Dockerfile). 3.14에서는 고정된 `websockets` 12가 `websockets.asyncio`를 못 찾아
  import에서 깨진다. Windows는 `py -3.11` 또는 `apps/api/.venv`(`.\run_local.ps1`이 venv → `py -3.11` → `python` 순으로 찾는다).

## 로컬 실행

- `.\run_local.ps1`(Windows) — 백엔드 8000 + 프런트 3000 새 창. Docker·수동 실행·스모크 테스트는 `docs/LOCAL_RUN.md`.
- env 파일은 둘: `apps/api/.env`(`.env.example` 복사), `apps/web/.env.local`(`.env.example` 복사).
  백엔드 fail-fast 4종 `SUPABASE_URL` `SUPABASE_ANON_KEY` `JWT_SECRET` `ADMIN_API_TOKEN` — 하나라도 없으면 부팅 실패(의도).
- 머신별 메모(경로·설치된 파이썬 등)는 이 파일에 쓰지 않는다 — 공유 저장소 문서에 개인 환경을 섞지 않는다.

## 가드레일 (위반 시 CI 실패 또는 데모·심사 리스크)

- `supabase/RESET_AND_SETUP.sql` **직접 수정 금지**. 스키마 변경 = `supabase/migrations/`에 새 파일
  (타임스탬프는 **현재 마지막 파일보다 커야** 한다) → `node scripts/build_reset.mjs` → 함께 커밋.
  새 테이블·함수는 `build_reset.mjs`의 PRELUDE DROP 목록에도 추가.
- SPOT 가중치(0.40/0.40/0.20)는 `score.py` ↔ `shared-types` 패리티 테스트로 강제. `score.py`는 회귀면이 넓은 신중 구역.
- **권한**: 사람은 Supabase 로그인 + `users.role`(tourist/merchant/admin/developer)로 서버(`app/core/authz.py`)가
  매 요청 판정한다. 프런트의 `lib/account.tsx` 판정은 UI 게이팅일 뿐이다. 기계 호출(pg_cron·GitHub Actions)만
  `X-Service-Token`(`SERVICE_API_TOKEN`, 없으면 `ADMIN_API_TOKEN` 폴백)을 쓰고, 수집 트리거 한 경로에만 유효하다.
  구 공유 토큰 헤더(`X-Merchant-Token`·`X-Admin-Authorization`)는 폐지됐다 — 되살리지 말 것.
- 토큰·비밀을 `NEXT_PUBLIC_*`에 넣지 않는다(정적 번들에 그대로 박힌다). 문서·커밋에는 키 **이름만**.
- **실 DB에는 읽기만.** 쓰기 검증은 로컬 대역으로 — 스테이징이 없다.
- 프런트 라우트를 건드리면 커밋 전에 `npm run build` — `output:'export'`는 프리렌더 실패 하나로 빌드가 통째로 죽는다.
- i18n 문자열은 ko/en/ja/zh **4로케일 동시 반영**. UI 문구·용어 변경 전 `DEMO_SCENARIO`·`JUDGE_QA`와 대조.
- 합성/데모 데이터와 실측은 UI 라벨로 구분하고, 서버 근거 없는 지표는 표시하지 않는다.
- 원격 콘솔 작업(Supabase SQL Editor, Render/Vercel env, Kakao·Google 콘솔, GitHub Secrets)은 코드로 우회하지 말고
  `docs/HANDOVER.md` "사람 작업 대기"에 기록한다.
- GitHub Actions `schedule`은 main에서만 발화 — 다른 브랜치는 `workflow_dispatch`.

## 새 파일은 어디에 (기존 다수 관례에 맞춘다 — 대량 이름 변경 금지)

| 만드는 것 | 위치 · 이름 |
|---|---|
| 웹 로직 · 유틸 · 훅 | `apps/web/lib/<camelCase>.ts`, 훅은 `use*.ts`. 하위 폴더(`voice/` `map/` `merchant/` `i18n/`)가 맞으면 거기에. 테스트는 옆에 `<name>.test.ts` |
| 웹 컴포넌트 | `apps/web/components/<PascalCase>.tsx`. 한 화면 전용이면 `components/<화면>/` (현재 `main/` `shell/` `admin/`) |
| 웹 i18n 사이드 사전 | `apps/web/lib/i18n/<name>-messages.ts` + `scripts/check-i18n-keys.mjs`의 `SIDE_MODULES`에 등록 |
| API 서비스 | `apps/api/app/services/<domain>_service.py`. 같은 접두사가 3개 이상이면 `spot/` `tourapi/` `batch/`처럼 하위 패키지 |
| API 테스트 | `apps/api/tests/{routers,services,core,scripts,migrations}/test_<module>.py` |
| 데이터 · 학습 스크립트 | `apps/api/scripts/<snake_case>.py` (+ `tests/scripts/test_<name>.py`) |
| 저장소 도구 | `scripts/<kebab-case>.mjs` |
| 문서 | `docs/`(운영) · `docs/contest/`(심사) · `docs/archive/`(끝난 것). **루트에 마크다운 금지.** `docs/README.md` 색인 갱신 |

## 브랜치 · 커밋 · 배포

- `main` = 프로덕션(Vercel·Render 자동 배포 + cron 발화 조건). 각자 브랜치에서 작업 → 게이트 통과 →
  fast-forward `git push origin <내-브랜치>:main`.
- 커밋 메시지: `type(scope): 한 줄`(한국어). scope는 `web api db i18n docs ci scripts contest handover` 중 하나.
  본문에는 "무엇"보다 **"왜"**를 쓴다. 작성자는 사람 본인의 git identity, AI는 `Co-Authored-By` 트레일러.
- main에 올리기 전: 게이트 전부 green → HANDOVER 세션 항목 추가 → 푸시. 진행분은 즉시 커밋·푸시로 유실 방지.

## 세션 프로토콜 (사람 · 에이전트 공통)

- **시작**: `docs/HANDOVER.md` 상단(배포 상태 · 사람 작업 대기 · 알려진 이슈)만 읽고 시작한다. 과거 로그는 필요할 때만.
- **끝**: HANDOVER "최근 세션" 맨 위에 `## YYYY-MM-DD — 제목` 항목을 추가한다(템플릿은 HANDOVER 하단 "기록 규칙").
  항목이 10개를 넘으면 가장 오래된 것을 `docs/archive/HANDOVER_LOG.md` 맨 위로 옮긴다. `check-docs`가 형식·중복·길이를 잡는다.
- 계획은 HANDOVER 항목으로 시작하고, 150줄을 넘길 때만 `docs/<TOPIC>_PLAN.md`로 분리해 색인에 등록한다.
- 새 루트 마크다운, 새 지침 파일, 플러그인 산출물(`superpowers/`, `*.artifact.json`)은 커밋하지 않는다.

## AI 도구

- 이 저장소의 AI 작업은 **Claude Code**로 한다(2026-09 기준 실사용 도구는 이것 하나 — 근거·운영 규칙은 `docs/AI_OPS.md`).
- **지은 쪽이 자기 코드를 검토하지 않는다.** 큰 변경은 렌즈가 다른 하위 에이전트(레드팀)로 계획을 먼저 두드리고, 실행 후
  다시 검토하는 루프를 돈다. 작은 변경은 새 세션의 `/code-review`.
- 하위 에이전트는 커밋만, **푸시는 메인 세션이**. 병렬 에이전트에 i18n을 분할 배정하지 않는다.
- 브라우저 검증은 Playwright e2e(CI 자동) + 데모 리허설(사람). Codex CLI는 선택(교차 검토용), Gemini·Antigravity는 쓰지 않는다.
