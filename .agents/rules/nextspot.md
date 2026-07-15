# NextSpot 워크스페이스 규칙 (Antigravity)

이 저장소의 에이전트 지침 **정본은 루트 [`AGENTS.md`](../../AGENTS.md)** 입니다.
작업 시작 전 반드시 읽고 그대로 따르세요. 규칙을 추가·수정할 일이 생기면 이 파일이 아니라
`AGENTS.md`에 씁니다(정본 1개 원칙 — `docs/AI_OPS.md` §1).

함께 읽을 것:

- `apps/web/AGENTS.md` — 웹 프런트 작업 시 하위 정본
- `docs/HANDOVER.md` — 현재 상태·우선순위·백로그 정본(작업 전 필독)
- `docs/AI_OPS.md` — 멀티 AI 도구(Claude Code·Codex·Antigravity) 역할 분담과 게이트

## 이 IDE에 기대하는 역할

Antigravity는 이 프로젝트에서 **브라우저 검증**을 맡습니다(`docs/AI_OPS.md` §3 게이트 ③):
`docs/DEMO_SCENARIO.md`의 데모 전 체크리스트 플로우를 `localhost:3000` 또는 Vercel 프리뷰에서
실제로 클릭하고, 모바일 뷰포트(하단 safe-area·바텀내비)를 포함해 스크린샷 증거를 남깁니다.

구현·리팩터가 필요하면 `AGENTS.md`의 검증 게이트 4종(web lint/typecheck/test/build,
pytest, ruff, 스키마 파리티)을 통과한 것만 커밋하세요.
