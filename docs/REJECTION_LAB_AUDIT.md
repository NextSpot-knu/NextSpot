# `나의 실험실` 구현 전 거절 피드백 감사

> 2026-07-16 Codex 읽기 전용 감사 결과. 제품 방향은 `docs/COMMERCIAL_PRODUCT_IDEAS.md` §2를
> 따른다. Claude Code 또는 다른 구현 에이전트는 이 문서를 읽고 아래 계약을 지킨 뒤 구현한다.

## 결론

현재 구조에 실험실 UI만 추가하면 안 된다. 화면마다 `거절`의 의미와 저장 방식이 다르고,
`POST /api/v1/feedback`은 멱등성이 없어 같은 추천에 반복 호출하면 선호 벡터가 매번 다시 감점된다.
또한 메인 지도의 가장 일반적인 `관심 없음`은 서버에 저장되지 않아 DB만으로 실험실 목록을 만들면
거절 기록 일부가 누락된다.

## P0 발견

### 1. 동일 추천 반복 감점

- `apps/api/app/routers/recommendations.py:585-592`는 호출마다 `user_feedback` 행을 INSERT한다.
- 같은 라우터 `:618-623`은 호출마다 선호 벡터 조정을 수행한다.
- `apps/api/app/services/preference_vector_service.py:89-100`은 accepted 이외 액션을 매번 5% 감점한다.
- `supabase/migrations/20250523120000_init.sql:53-60`에는 recommendation 기준 UNIQUE 제약이 없다.

버튼 연타, 네트워크 재시도, 만족도 👎 후 목록 새로고침, 실험실 상세 이유 저장이 겹치면 동일 추천이
중복 학습될 수 있다. 추천 하나당 기본 결정을 멱등하게 저장하고, 이미 적용한 학습은 재실행하지 않아야 한다.

### 2. 메인 지도 거절이 서버에 없음

- `apps/web/app/main/page.tsx:1013-1071`의 `handleReject`는 `rejectedIds`와 sessionStorage만 갱신한다.
- `submitFeedback`을 호출하지 않으므로 브라우저 세션이 끝나면 기록이 사라진다.

실험실의 서버 정본을 만들려면 메인 추천 결과가 실제 `recommendation_id`를 보존하고 거절 시 pending
결정을 서버에 저장해야 한다. 합성 `bytype-*` 추천은 현재 DB 추천 이력이 없어 별도 해결이 필요하다.

## P1 발견

### 1. 같은 UI 어휘가 서로 다른 의미를 가짐

| 경로 | 현재 처리 | 장기 학습 적합성 |
|---|---|---|
| 메인 지도 `관심 없음` | 로컬 제외, 서버 저장 없음 | 명시 거절일 수 있으나 ID 경로 보강 필요 |
| 추천 상세 만족도 👎 | `rejected`, 즉시 -5% | 추천 품질 평가와 취향 거절이 혼용됨 |
| `다른 대안 보기` | 보이는 추천 전부 `rejected`, 각각 -5% | 단순 새 후보 요청이므로 장기 감점 부적합 |
| 음성 `다음` | 순위만 이동, 폐기/저장 없음 | skip으로 분리 필요 |
| 저장 장소 카드 거절 | localStorage 북마크 삭제 | unsave이며 취향 거절 아님 |

근거: `apps/web/app/explore/recommend/page.tsx:693-726`,
`apps/web/app/saved/page.tsx:460-472`, `apps/web/app/main/page.tsx:1073-1087`.

권장 행동 타입은 `accepted_visit_intent`, `rejected`, `skipped`, `dismissed_batch`, `unsaved`,
`helpful`, `not_helpful`처럼 의미를 분리한다. DB CHECK와 API Literal도 함께 갱신해야 한다.

### 2. `accepted`도 만족도와 실제 이동 의향을 혼용

- 만족도 👍가 `accepted`로 전송된다(`explore/recommend/page.tsx:693-708`).
- 실제 길안내 수락도 동일 액션을 사용한다(`:623`).
- 서버는 accepted이면 recommendation 수락 처리, 쿠폰 발급, 벡터 +10%를 모두 수행한다
  (`recommendations.py:594-623`).

만족도와 방문 의향을 분리하지 않으면 단순 👍에도 쿠폰·성과 지표가 오염될 수 있다.

### 3. `ignored`도 거절과 동일한 -5%

`FeedbackRequest`는 ignored를 허용하지만 벡터 서비스는 accepted 이외 모든 액션을 감점한다.
나중에 답하기/건너뛰기는 장기 취향을 바꾸지 않아야 한다.

### 4. 상세 이유 스키마 부재

현재 `user_feedback`은 `id`, `user_id`, `recommendation_id`, `action`, `timestamp`만 가진다.
최소 다음 상태가 추가로 필요하다.

- `reason_code`, `reason_note`
- `reason_status`: pending / answered / skipped / expired
- `reason_answered_at`, `hidden_at`
- `learning_scope`: none / session / long_term / data_quality
- `learning_applied_at`, `learning_version`
- 추천 하나당 결정 행의 UNIQUE 또는 동등한 멱등성 장치

### 5. 이유 없는 즉시 -5%는 정확히 되돌리기 어려움

휴업, 이미 방문, 당시 상황 불일치는 취향 거절이 아니다. 현재는 학습 전 벡터나 적용 delta를 저장하지
않아 나중에 이유를 받고 정확히 감점을 취소하기 어렵다. MVP에서는 이유 없는 거절은 pending 이력과
현재 세션 후보 제외에만 반영하고, 장기 벡터는 상세 이유가 확정된 뒤 한 번만 갱신하는 것이 안전하다.

## RLS와 개인정보

현재 기반은 적절하다.

- 본인 추천만 SELECT: `20250523120001_rls.sql:83-95`.
- 본인 피드백만 SELECT/INSERT: 같은 파일 `:99-115`.
- anon 전체 조회 제거: `20260707120000_security_hardening.sql:29-31`.
- service-role BFF 사용 후 JWT 사용자와 recommendation 소유권 대조:
  `recommendations.py:566-578`.

실험실 API도 다음을 지킨다.

- body의 `user_id`를 신뢰하지 않고 `current_user.id`만 사용.
- 조회/수정/숨김 전에 recommendation 소유권 검사.
- 기타 메모 길이 제한, 서버 로그에 원문 미기록.
- 위치 스냅샷이 필요하면 원좌표 대신 구역 또는 저정밀 좌표로 최소 수집.
- 데이터 이용과 삭제 방법을 개인정보 화면에 반영.

## 테스트 공백

현재 `apps/api/tests/routers/test_routers.py:221-247`은 소유권 403, 합성 ID 404, 잘못된 액션 422만
검증한다. 다음 테스트가 필요하다.

- 동일 recommendation/action 재요청의 멱등성.
- accepted ↔ rejected 등 액션 변경 정책.
- pending → 상세 이유에서 중복 학습 방지.
- ignored/skipped/batch refresh가 장기 벡터를 바꾸지 않음.
- 타인의 pending 목록 조회·수정 차단.
- 최근 10건 정렬과 정확한 30일 만료 경계.
- 휴업/이미 방문/상황 불일치가 취향을 감점하지 않음.
- 피드백 저장 후 벡터 저장 실패 시 안전한 재처리.
- 만족도와 실제 방문 수락이 쿠폰·성과 지표에서 분리됨.

## 구현 계약

1. 추천별 기본 결정은 멱등하게 한 번 저장한다.
2. 거절 순간에는 `reason_status=pending`만 저장하고 다음 추천을 즉시 표시한다.
3. 이유 미입력 거절은 현재 세션의 후보 제외에만 사용한다.
4. 장기 선호 벡터는 상세 이유가 확정된 뒤 의미가 맞는 경우 한 번만 갱신한다.
5. `다른 대안 보기`, 음성 `다음`, 저장 해제는 장기 거절과 분리한다.
6. 만족도 👍/👎와 실제 방문 수락을 분리한다.
7. 실험실 목록은 본인의 최근 pending만 최신순 최대 10건 반환한다.
8. 30일 지난 pending은 조회에서 제외하거나 expired로 처리한다.
9. 휴업은 data_quality, 이미 방문은 재추천 억제, 상황 불일치는 session 범위로 처리한다.
10. `learning_applied_at/version` 또는 동등한 장치로 재시도 시 중복 학습을 막는다.
11. 실데이터를 조회하지 못하면 마이탭에 가짜 pending 건수를 표시하지 않는다.
12. ko/en/ja/zh 네 로케일과 모바일/빈 상태/접근성을 함께 완성한다.

## 권장 구현 분할

1. 피드백 의미 모델과 DB 마이그레이션, 멱등 서비스.
2. pending 목록/답변/숨김 API와 보안 테스트.
3. 기존 화면 행동 타입 정리 및 회귀 테스트.
4. 마이탭 진입 카드와 실험실 UI, 4로케일.
5. 브라우저에서 연속 거절→즉시 다음→실험실 답변→목록 제거 흐름 검증.

