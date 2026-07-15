# AI 운영 플레이북 — Claude Code · Codex CLI · Antigravity

멀티 AI CLI 운영의 정본. 지침 파일 규약, 도구별 역할, 게이트, 핸드오프 규칙을 정의한다.
프로젝트 자체의 규칙(검증 게이트·가드레일)은 루트 `AGENTS.md`가 정본이며, 이 문서는 "도구를
어떻게 조합해 쓰는가"만 다룬다.

## 1. 지침 파일 규약 — 정본 1개 원칙

| 파일 | 역할 | 읽는 도구 |
|---|---|---|
| `AGENTS.md` (루트) | **정본.** 컨벤션 변경은 항상 여기에만. | Codex(기본 규약), Claude·Gemini(임포트 경유), Antigravity(바이너리가 인식) |
| `apps/web/AGENTS.md` | 웹 하위 정본 (웹 전용 컨벤션) | 위와 동일 |
| `CLAUDE.md` | `@AGENTS.md` 임포트 포인터 | Claude Code |
| `GEMINI.md` | `@./AGENTS.md` 임포트 포인터 | Gemini CLI (import 처리기 내장 확인) |
| `.agents/rules/nextspot.md` | 워크스페이스 규칙 포인터 | Antigravity IDE (확장이 `**/.agents/rules/**/*.md`를 규칙 파일로 등록) |
| `docs/AI_OPS.md` | 이 문서 — 도구 조합·핸드오프 규칙 | 사람 + 필요 시 에이전트 |

포인터 3종(`CLAUDE.md`/`GEMINI.md`/`.agents/rules/nextspot.md`)에는 **내용을 직접 쓰지 않는다.**
도구가 자동 로드하는 경로가 서로 달라 포인터가 여러 개일 뿐, 실체는 `AGENTS.md` 하나다.
세 도구가 서로 다른 지침을 읽으면 컨벤션이 갈라진다 — 규칙이 생기면 `AGENTS.md`에만 쓴다.

## 2. 역할 분담

| 도구 | 형태 | 맡는 일 | 이유 |
|---|---|---|---|
| **Claude Code** | 헤드리스 CLI (`claude`) | 메인 드라이버: 설계, 복잡한 구현, 어려운 디버깅, 야간 자율 세션·멀티에이전트 오케스트레이션, `docs/HANDOVER.md` 갱신 | 장기 자율 작업·워크트리 병렬화가 가장 성숙, 이 프로젝트의 운영 이력·플레이북이 여기 축적됨 |
| **Codex CLI** | 헤드리스 CLI (`codex`) | 교차 리뷰(`codex review`), 작고 기계적인 수정 병렬 처리, 세컨드 오피니언(`codex exec "..."`) | 정밀 diff 작업에 강함. ChatGPT 구독 포함분이라 리뷰 게이트로 상시 사용해도 부담 없음 |
| **Antigravity** | **IDE** (에이전트 매니저 + 내장 브라우저) | 브라우저 검증 전담: 데모 플로우 실클릭, 스크린샷·녹화 증거, 모바일 뷰포트 확인 | 내장 브라우저 에이전트가 차별점. Gemini 무료 쿼터로 검증 비용 절감 |

**Antigravity는 헤드리스 CLI가 아니다.** 이 머신 기준 `Antigravity IDE/bin/antigravity-ide`는
워크스페이스를 여는 래퍼일 뿐이고, 실제 작업은 IDE의 Agent Manager에서 지시한다. 즉 §3의 게이트 ③은
파이프라인에 자동으로 끼우는 단계가 아니라 **사람이 IDE를 열고 돌리는 수동 검증**이다.

`gemini` CLI(0.50.0)도 설치돼 있다 — Antigravity IDE를 열기 부담스러운 상황에서 Google 계열
세컨드 오피니언이 필요할 때 쓴다. 단 브라우저 조작은 IDE 쪽 기능이다.

**핵심 원칙: 구현한 도구가 자기 코드를 리뷰하지 않는다.** 모델 계열(Anthropic/OpenAI/Google)이
달라 서로 다른 맹점을 잡는 것이 세 도구를 쓰는 가장 큰 이유다.

## 3. 표준 루프

1. **설계** — Claude Code. 계획은 대화에만 남기지 말고 `docs/HANDOVER.md` 또는 `docs/`에 내구 산출물로.
2. **구현** — `feature/jinseok`에서. 병렬 작업은 워크트리 격리 + 파일 소유권 분할
   (`docs/AUTONOMOUS_SESSION.md` 규칙). i18n(교차절단 문자열)은 병렬 금지 — 단일 소유.
3. **게이트 ① 결정적 검증** — `AGENTS.md` 검증 게이트 4종(web/pytest/ruff/스키마 파리티). 실패 시 커밋 금지.
4. **게이트 ② 교차 리뷰** — 구현 주체가 아닌 도구로: Claude가 구현했으면 `codex review`,
   Codex가 구현했으면 Claude `/code-review`. 발견은 적대적 재검증 후에만 수정(반증 전례: 127.0.0.1 CORS).
5. **게이트 ③ 브라우저 검증** (UI 변경 시, **IDE에서 수동**) — Antigravity IDE를 열어
   `docs/DEMO_SCENARIO.md`의 데모 전 체크리스트 플로우를 실클릭. 대상: `localhost:3000`
   (기동 방법은 `AGENTS.md` 로컬 환경 — 백엔드는 `run_local.ps1`이 아니라 `py -3.11` 직접 실행)
   또는 Vercel 프리뷰. 모바일 뷰포트(하단 safe-area·바텀내비) 포함.
   스크린샷을 증거로 남긴다. 공모전 데모 리허설이 이 게이트의 최종 형태다.
6. **머지** — `git push origin feature/jinseok:main` (fast-forward). main push가 곧 Vercel prod 배포다.

빠른 버그픽스는 ③을 생략할 수 있지만 ①·②는 생략하지 않는다.

## 4. 핸드오프 규칙

- **같은 워킹 트리를 두 도구가 동시에 편집하지 않는다.** 도구 간 인터페이스는 커밋/브랜치.
  동시 작업이 필요하면 git worktree로 분리.
- 하위 에이전트는 커밋만, **푸시는 통합자(메인 세션)가** 수행.
- 도구들은 서로의 대화 기록을 공유하지 않는다 — 세션 간 컨텍스트 전달 채널은
  `docs/HANDOVER.md`(상태 스냅샷 + 다음 단계 + 커밋 해시)가 유일하다. 어느 도구로 작업했든
  세션을 끝낼 때 HANDOVER를 갱신한다.
- 외부 계정이 필요한 작업(Supabase SQL Editor, Render/Vercel env, Kakao 콘솔, GitHub Secrets)은
  코드로 우회하지 말고 HANDOVER '사람 작업' 목록에 기록한다.

## 5. 자율(야간) 세션 — Claude Code 전용

무인 세션은 Claude Code로만 돌린다(다른 두 도구는 무인 장기 세션 운영 이력이 없음).

- 루프 규칙·RESUME 절차: `docs/AUTONOMOUS_SESSION.md`. 단 **무엇을 할지는 `docs/HANDOVER.md`가 정본** —
  AUTONOMOUS_SESSION의 "진행 상태"는 2026-07-10 로그라 그대로 이어받으면 완료된 일을 다시 잡는다.
- 결정적 게이트 우선 — 게이트 통과분만 커밋, 진행분 즉시 커밋·푸시로 유실 방지.
- 감사(audit)성 발견은 적대적 재검증을 통과한 것만 수정하고, 반려 항목도 HANDOVER에 기록.
- freeze 백로그(HANDOVER 명시) 항목은 자율 세션이 임의로 착수하지 않는다.

## 6. 쿼터·비용 라우팅

- 난이도 높은 추론(설계·아키텍처·어려운 디버깅) → **Claude Code**
- 기계적 대량 수정·상시 리뷰 게이트 → **Codex** (구독 포함분 소진)
- 브라우저 검증·대용량 컨텍스트 일괄 훑기 → **Antigravity** (Gemini 무료 쿼터)

Claude 쿼터가 부족한 주간에는 구현을 Codex로 내리고 Claude는 설계·리뷰·통합에만 쓰는 식으로
역방향 라우팅도 가능하다. 단, 어떤 라우팅이든 §3의 게이트는 동일하게 적용된다.
