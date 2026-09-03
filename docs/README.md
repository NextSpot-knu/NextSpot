# docs/ 색인

이 저장소의 문서 목록과 상태(`docs/` 밖의 몇 개는 아래 표). **새 문서를 만들거나 옮기면 이 표를 같이 고친다** —
`node scripts/check-docs.mjs`(CI)가 색인에 없는 문서와 깨진 링크를 잡는다.

상태 뜻: **living** = 코드와 함께 계속 갱신 · **frozen** = 완성본, 사실이 바뀌면 고치되 확장하지 않음 ·
**archived** = 역할이 끝난 기록, 읽기 전용(고치지 않는다).

## 처음 읽는 순서

1. [`../AGENTS.md`](../AGENTS.md) — 규칙·게이트·구조 (5분)
2. [`HANDOVER.md`](./HANDOVER.md) — 지금 상태, 사람 작업 대기, 최근 세션 (5분)
3. [`SYSTEM_MAP.md`](./SYSTEM_MAP.md) — 화면↔API↔서비스↔DB 연결 (필요한 절만)
4. 웹 작업이면 [`../apps/web/AGENTS.md`](../apps/web/AGENTS.md), API 작업이면 [`../apps/api/README.md`](../apps/api/README.md)

### `docs/` 밖에 있는 문서

| 문서 | 용도 |
| --- | --- |
| [`../README.md`](../README.md) | 프로젝트 소개 · 공모전 서사 · 기술 스택 (외부 독자용) |
| [`../AGENTS.md`](../AGENTS.md) | 사람·에이전트 규칙 정본 (게이트 · 가드레일 · 파일 위치 · 세션 프로토콜) |
| [`../apps/web/AGENTS.md`](../apps/web/AGENTS.md) | 웹 하위 규칙 (빌드 · i18n · 스타일 · 폴더) |
| [`../apps/api/README.md`](../apps/api/README.md) | API 실행 · 계층 · 주요 엔드포인트 · 수집 활성화 절차 |
| [`../apps/web/e2e/README.md`](../apps/web/e2e/README.md) | Playwright e2e 범위 |

## 운영 문서 (`docs/`)

| 문서 | 용도 | 상태 | 마지막 검토 |
| --- | --- | --- | --- |
| [`HANDOVER.md`](./HANDOVER.md) | 배포 상태 · 우선순위 · 사람 작업 대기 · 최근 세션 기록. **현재 상태의 정본** | living | 2026-09-04 |
| [`SYSTEM_MAP.md`](./SYSTEM_MAP.md) | 화면↔API↔서비스↔DB 전체 연결 관계, 구현된 것만 기술 | living | 2026-09-04 |
| [`DEPLOY_AND_ENV.md`](./DEPLOY_AND_ENV.md) | Vercel · Render · Supabase · GitHub Actions 배포와 환경변수 이름 | living | 2026-09-04 |
| [`LOCAL_RUN.md`](./LOCAL_RUN.md) | 로컬 구동 · Docker · 스모크 테스트 | living | 2026-09-04 |
| [`AI_OPS.md`](./AI_OPS.md) | Claude Code 운영 규칙 — 교차 검토(레드팀·/code-review), 세션 핸드오프, 무인 세션, 다른 도구는 선택 | living | 2026-09-04 |
| [`MODEL_CARD.md`](./MODEL_CARD.md) | 혼잡 예측 모델의 운영 계약 · 품질 게이트 · 승격 절차 | living | 2026-08-20 |
| [`CONGESTION_DATA.md`](./CONGESTION_DATA.md) | 혼잡 데이터 원칙 · 외부 데이터 라이선스 · 공공 협업 우선순위 정본 | living | 2026-08-24 |

## 심사 자료 (`docs/contest/`)

| 문서 | 용도 | 상태 | 마지막 검토 |
| --- | --- | --- | --- |
| [`contest/CONTEST_NARRATIVE.md`](./contest/CONTEST_NARRATIVE.md) | 서면·PT 공통 서사, 독창성·수익모델 | frozen | 2026-07-09 |
| [`contest/DATA_UTILIZATION.md`](./contest/DATA_UTILIZATION.md) | TourAPI 필드 → SPOT 변수 매핑(코드 근거) | living | 2026-09-03 |
| [`contest/DEMO_SCENARIO.md`](./contest/DEMO_SCENARIO.md) | PT 데모 대본 + 데모 전 체크리스트. UI 문구 변경 전 대조 대상 | living | 2026-09-04 |
| [`contest/JUDGE_QA.md`](./contest/JUDGE_QA.md) | 심사위원 예상 질문 10문 + 답변. UI 문구 변경 전 대조 대상 | living | 2026-09-03 |
| [`contest/CONTEST_STRATEGY.md`](./contest/CONTEST_STRATEGY.md) | 심사 배점 대응 전략 (2026-07-07) | frozen | 2026-07-07 |
| [`contest/TIMELINESS.md`](./contest/TIMELINESS.md) | 시의성 소재 — 실존 보도 인용집 (2026-07-14 검증) | frozen | 2026-07-14 |
| [`contest/announcements/README.md`](./contest/announcements/README.md) | 공모전 공고문 · 제출 매뉴얼 · 양식 · 제안서 원본 PDF 목록 | frozen | 2026-09-04 |

## 기록 보관 (`docs/archive/`) — 읽기 전용

역할이 끝난 계획서·감사·세션 로그. 당시 파일 경로와 상태를 그대로 담고 있어 **현재 트리와 다를 수 있다.**
현재 사실은 위 운영 문서에서 확인한다.

| 문서 | 무엇이었나 | 종료 사유 |
| --- | --- | --- |
| [`archive/HANDOVER_LOG.md`](./archive/HANDOVER_LOG.md) | 2026-06-30 ~ 08-28 세션 인계 로그 전문(구 HANDOVER.md, §-45 → §6) | 2026-09-04 상태 문서와 로그를 분리. 넘치는 세션 항목이 여기로 옮겨진다 |
| [`archive/ARCHITECTURE_OVERVIEW.md`](./archive/ARCHITECTURE_OVERVIEW.md) | InduSpot에서 상속한 베이스 아키텍처 설명 | `SYSTEM_MAP.md`가 대체 (2026-08-20) |
| [`archive/NEXTSPOT_PIVOT.md`](./archive/NEXTSPOT_PIVOT.md) | InduSpot → 관광 도메인 적응 명세·개조 백로그 | 결정 2026-07-07, 코드 반영 완료 |
| [`archive/GYEONGJU_MIGRATION_PLAN.md`](./archive/GYEONGJU_MIGRATION_PLAN.md) | 구미 → 경주 데이터 이관·InduSpot 잔재 제거 체크리스트 | 전부 실행 완료 (2026-07-07) |
| [`archive/IMPROVEMENT_PLAN.md`](./archive/IMPROVEMENT_PLAN.md) | 7월 전방위 감사 워크스트림(WS-A~F) + 8/21 실측 우선순위 | 남은 항목은 `HANDOVER.md` 우선순위로 이관 |
| [`archive/TEAM_MEETING.md`](./archive/TEAM_MEETING.md) | 7월 팀원 회의 안건 | 회의 종료 (2026-07) |
| [`archive/AUTONOMOUS_SESSION.md`](./archive/AUTONOMOUS_SESSION.md) | 2026-07-10 무인 자율 세션 로그와 RESUME 규칙 | 규칙은 `AI_OPS.md`로 흡수, 진행 상태는 낡음 |
| [`archive/AUTH_MEMBERSHIP_PLAN.md`](./archive/AUTH_MEMBERSHIP_PLAN.md) | 이메일/비밀번호 회원 체계 계획 | 구현 완료 (2026-08-25) |
| [`archive/OAUTH_PLAN.md`](./archive/OAUTH_PLAN.md) | 게스트 → 카카오·구글 OAuth 연동 계획 | 구현 완료 (2026-08-27) |
| [`archive/COMMERCIAL_PRODUCT_IDEAS.md`](./archive/COMMERCIAL_PRODUCT_IDEAS.md) | 상용화 제품 아이디어 정리 (2026-07-16) | 방향 확정, `나의 실험실` 등 반영 완료 |
| [`archive/REJECTION_LAB_AUDIT.md`](./archive/REJECTION_LAB_AUDIT.md) | `나의 실험실` 구현 전 거절 피드백 감사 | 구현 완료 (2026-07-16) |
| [`archive/CONGESTION_TRUST_SPEC.md`](./archive/CONGESTION_TRUST_SPEC.md) | 혼잡 3단계 표시 신뢰성 명세 | Phase 1 구현 완료 (2026-07-18) |
| [`archive/KAKAO_LOCAL_EXPANSION.md`](./archive/KAKAO_LOCAL_EXPANSION.md) | Kakao Local 장소 밀도 확충 기획 | 약관 리스크로 영속 적재 대신 실시간 검색으로 대체 |
| [`archive/TOURAPI_EXPANSION.md`](./archive/TOURAPI_EXPANSION.md) | TourAPI 추가 연동 Tier 기획 (2026-07-15) | Tier 0~1 적재 완료, 나머지는 승인 대기 상품 |
| [`archive/SOLAR_LLM_EXPANSION.md`](./archive/SOLAR_LLM_EXPANSION.md) | Upstage Solar 신규 적용 5종 기획 | 구현 완료 (2026-07) |
| [`archive/SOLAR_AUTONOMY_PLAN.md`](./archive/SOLAR_AUTONOMY_PLAN.md) | Solar 자율권 범위 원칙·5안 | 원칙은 `SYSTEM_MAP.md` §8에 반영 |
| [`archive/SOLAR_AUTONOMY_35_PLAN.md`](./archive/SOLAR_AUTONOMY_35_PLAN.md) | Solar 자율권 #3·#5 + 편의점 레이어 설계 | 구현 완료 (2026-08) |
| [`archive/SOLAR_AUTONOMY_35_IMPL_PLAN.md`](./archive/SOLAR_AUTONOMY_35_IMPL_PLAN.md) | 위 설계의 태스크별 구현 플랜(에이전트 산출물) | 구현 완료 |
| [`archive/RBAC_DEBUG_REVIEW.md`](./archive/RBAC_DEBUG_REVIEW.md) | 2026-08-28 RBAC 배포 전 디버깅 검토 요청 | 수정 완료, 미결 6건은 `HANDOVER.md`로 이관 |
| `archive/reports/` | 2026-08-21 B2G 지원 가능성 평가 리포트 HTML 산출물 | 1회성 산출물 |

## 규칙

- **새 마크다운은 루트에 두지 않는다.** 운영 문서는 `docs/`, 심사 자료는 `docs/contest/`, 끝난 것은 `docs/archive/`.
- **계획은 문서가 아니라 `HANDOVER.md` 세션 항목으로 시작한다.** 150줄을 넘길 만큼 커질 때만
  `docs/<TOPIC>_PLAN.md`로 분리하고 이 색인에 등록한다.
- **아카이브 시점** = 계획의 마지막 체크박스가 닫히거나 기능이 배포된 커밋. 옮기는 사람이 이 표의 행을 옮기고
  종료 사유를 적는다. 아카이브 문서는 이후 고치지 않는다(링크만 유지).
- **파일명**은 `SCREAMING_SNAKE.md`(기존 관례). 에이전트 플러그인 산출물(`superpowers/`, `*.artifact.json` 등)은
  커밋 전에 `archive/`로 옮기거나 지운다.
- 문서 안의 `file:line` 인용은 작성 시점 스냅샷이다 — 코드가 이겼으면 코드가 맞다.
