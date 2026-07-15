# NextSpot — 관광 수요 재배치 플랫폼

2026 관광데이터 활용 공모전(① 웹·앱 개발 부문) 출품작. 경주 황리단길의 오버투어리즘을
SPOT(Smart Place Optimization for Tourism) 알고리즘으로 분산·재배치하는 AI 대안 장소 추천 웹 서비스.

- **베이스:** InduSpot(산업단지 공용 인프라 혼잡 분산)의 로컬 전용 모노레포를 시드로 재사용.
  아키텍처(Next.js 웹 + FastAPI + Supabase + 로컬 sklearn)와 SPOT 엔진은 동일, 도메인만 관광으로 피벗.
- **필수 데이터:** 한국관광공사 OpenAPI(TourAPI). 적응 명세·개조 백로그는 `docs/NEXTSPOT_PIVOT.md`.

## 세션 시작

- 현재 상태·우선순위·백로그의 **정본은 `docs/HANDOVER.md`**(최신 세션이 맨 위) — 작업 전 먼저 읽는다.
- `docs/AUTONOMOUS_SESSION.md`는 무인 세션의 **규칙·재개(RESUME) 절차만** 참조한다.
  그 안의 "진행 상태"는 2026-07-10 세션 로그로 이미 낡았다 — 무엇을 할지는 항상 HANDOVER가 이긴다
  (RESUME 규칙 2의 "미완 항목"을 그대로 따르면 완료된 과거 작업을 다시 잡는다).
- AI 도구(Claude Code·Codex·Antigravity) 역할 분담·핸드오프 규칙은 `docs/AI_OPS.md`.

## 구조

- `apps/web` — Next.js **정적 export** 프런트: 관광객 앱 + `admin/*` B2G 관제 + `merchant/*` 사장님 콘솔.
  웹 하위 정본: [`apps/web/AGENTS.md`](apps/web/AGENTS.md)
- `apps/api` — FastAPI 백엔드. SPOT 산식은 `app/services/spot/score.py`(W1 선호 0.40 / W2 시간비용 0.40 / W3 인센티브 0.20)
- `packages/shared-types` — SPOT 상수의 단일 정의점(web이 `transpilePackages`로 TS 소스 직접 소비)
- `supabase/` — `migrations/`가 스키마 정본, `RESET_AND_SETUP.sql`은 자동 생성물, `APPLY_DELTA_*.sql`은 사람용 1회성 원격 델타
- 배포: web=Vercel(main push 자동배포, `vercel.json`), api=Render Blueprint(`render.yaml`, `/health`), DB=Supabase

## 검증 게이트 — 커밋 전 필수 (CI `.github/workflows/ci.yml`과 동일)

| 게이트 | 명령 (실행 위치) |
|---|---|
| web | `npm run lint && npm run typecheck && npm run test && npm run build` (`apps/web`) |
| api 테스트 | `py -3.11 -m pytest -q` (`apps/api`, `PYTHONUTF8=1`) |
| api 린트 | `py -3.11 -m ruff check .` (`apps/api`) |
| 스키마 파리티 | `node scripts/build_reset.mjs && git diff --exit-code supabase/RESET_AND_SETUP.sql` (루트) |

- pytest는 네트워크/실DB 불필요 — `tests/conftest.py`가 placeholder env를 주입하고 TourAPI 실호출을 차단한다.
- `apps/api/conftest.py`(주석만 있는 sys.path 앵커)는 삭제 금지 — 없으면 CI처럼 `pytest`를 직접 실행할 때
  `ModuleNotFoundError: No module named 'app'`. pytest는 `apps/api`에서 실행.

## 로컬 환경 (이 머신)

- 저장소는 중첩 폴더 `C:/Users/hennr/Desktop/nextspot/NextSpot`. Windows 11 + PowerShell.
- Python은 반드시 `py -3.11` + `PYTHONUTF8=1` — PATH의 `python`은 3.14이고 httpx 비호환으로 **조용히** 실패한다.
- ⚠️ `.\run_local.ps1`은 `apps/api/.venv`가 있으면 그걸, 없으면 **PATH의 `python`(=3.14)**을 쓴다.
  이 머신엔 venv가 없으므로 백엔드는 아래처럼 직접 띄우거나, 먼저 `py -3.11 -m venv apps/api/.venv`로
  venv를 만들어야 한다(그러면 스크립트가 자동으로 그걸 집는다):
  ```powershell
  cd apps/api; $env:PYTHONUTF8=1; py -3.11 -m uvicorn app.main:app --reload --port 8000
  ```
  프런트만이면 `.\run_local.ps1 -FrontendOnly`는 안전. 상세·스모크 테스트는 `LOCAL_RUN.md`.
- 백엔드 `.env`는 `apps/api/.env` — CWD가 `apps/api`여야 로드된다. fail-fast env 4종:
  `SUPABASE_URL` `SUPABASE_ANON_KEY` `JWT_SECRET` `ADMIN_API_TOKEN` (하나라도 없으면 부팅 실패, 의도된 동작).

## 가드레일 (위반 시 CI 실패 또는 데모/심사 리스크)

- `supabase/RESET_AND_SETUP.sql` **직접 수정 금지**(자동 생성물). 스키마 변경 = `supabase/migrations/`에 새
  타임스탬프 마이그레이션 추가 → `node scripts/build_reset.mjs` 재생성 → 함께 커밋. 새 테이블/함수를 만들면
  `scripts/build_reset.mjs`의 PRELUDE DROP 목록에도 추가(멱등성).
- SPOT 가중치는 `apps/api/app/services/spot/score.py` ↔ `packages/shared-types` 패리티 테스트로 강제
  (`apps/api/tests/services/test_spot.py`) — 한쪽만 바꾸면 CI 실패. `score.py`는 회귀면이 넓은 **신중 구역** —
  산식·시그니처 변경은 사전 검토 후에만.
- i18n 문자열은 ko/en/ja/zh **4로케일 동시 반영**(패리티 0 missing 유지). 병렬 에이전트에 i18n을 분할 배정 금지.
- UI 문구·용어 변경 전 `docs/DEMO_SCENARIO.md`·`docs/JUDGE_QA.md`와 대조 — 발표 대본과 충돌해 반려된 전례 있음.
- 합성/데모 데이터와 실측 데이터는 UI 라벨로 구분하고, 서버 근거 없는 지표는 표시하지 않는다(심사 감점 리스크).
- 관리자 API 인증은 `X-Admin-Authorization: Bearer <ADMIN_API_TOKEN>` 헤더 **전용** — 일반 `Authorization`은 401.
- 시크릿은 문서·커밋에 키 이름만 기록(값 노출 금지). 원격 콘솔 작업(Supabase SQL Editor, Render/Vercel env,
  Kakao 도메인, GitHub Secrets)은 코드로 우회하지 말고 `docs/HANDOVER.md` '사람 작업' 목록에 기록.
- GitHub Actions schedule(ingest/uptime cron)은 **main에서만** 발화 — feature 브랜치는 workflow_dispatch 수동 실행.

## 브랜치·배포

- 작업 브랜치 `feature/jinseok`, 프로덕션 정본 `main`(Vercel prod + cron 발화 조건).
- main 반영은 fast-forward: `git push origin feature/jinseok:main`.
- 진행분은 즉시 커밋·푸시로 유실 방지. 기능 단위 커밋 해시를 `docs/HANDOVER.md`에 기록(세션 간 추적성).
