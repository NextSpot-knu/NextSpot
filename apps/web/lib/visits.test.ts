import assert from 'node:assert/strict';
import { DUE_AFTER_MS, dismissVisitCheck, getDueVisit, isVisitCheckDue } from './visits';

// '다녀오셨나요?' 노출 판정. 실제로 났던 버그는 '닫아도 탭을 다시 열면 또 뜬다' 였다:
// 닫기가 로컬 state 만 끄고 저장소는 그대로 뒀으니, 다음 마운트의 getDueVisit() 이 같은
// pending 을 그대로 다시 읽었다. 판정 자체는 localStorage 와 Date.now() 에 묶여 있어
// 경계값을 재현할 수 없었다 — 그래서 isVisitCheckDue 로 떼어내 여기서 직접 잠근다.

const T0 = 1_700_000_000_000; // 고정 기준 시각(테스트가 실제 시계에 흔들리지 않게)

// ── 30분 대기 ─────────────────────────────────────────────────────────────
// 수락 직후에는 묻지 않는다 — 아직 도착도 못 했다.
assert.equal(isVisitCheckDue(T0, 'navigating', T0), false);
assert.equal(isVisitCheckDue(T0, 'navigating', T0 + 60_000), false);

// 1ms 모자라면 아직, 정확히 30분이면 노출. 이 두 줄이 경계를 고정한다.
assert.equal(isVisitCheckDue(T0, 'navigating', T0 + DUE_AFTER_MS - 1), false);
assert.equal(isVisitCheckDue(T0, 'navigating', T0 + DUE_AFTER_MS), true);
assert.equal(isVisitCheckDue(T0, 'navigating', T0 + DUE_AFTER_MS * 10), true);

// ── 도착은 대기를 건너뛴다 ────────────────────────────────────────────────
// 사용자가 '도착' 을 눌렀으면 이미 현장에 있다고 말한 것 — 30분을 더 기다릴 이유가 없다.
assert.equal(isVisitCheckDue(T0, 'arrived', T0), true);
assert.equal(isVisitCheckDue(T0, 'arrived', T0 - 60_000), true);

// ── 여정 기록이 없을 때 ───────────────────────────────────────────────────
// active trip 이 없어도(legacy pending 만 남은 경우) 시간 규칙은 그대로 적용된다.
assert.equal(isVisitCheckDue(T0, null, T0 + 60_000), false);
assert.equal(isVisitCheckDue(T0, undefined, T0 + DUE_AFTER_MS), true);

// 기기 시계가 뒤로 갔거나 acceptedAt 이 미래인 값 — 묻지 않는 쪽이 안전하다
// (음수 경과를 '오래됐다' 로 읽어 엉뚱하게 배너를 띄우지 않는다).
assert.equal(isVisitCheckDue(T0 + DUE_AFTER_MS, 'navigating', T0), false);

// ── 브라우저가 아닌 환경 ──────────────────────────────────────────────────
// 정적 export 앱이라 이 모듈은 서버/빌드 시점에도 로드된다. window 가 없으면
// 던지지 말고 안전한 기본값으로 수렴해야 한다(저장 차단 환경과 같은 계약).
assert.equal(getDueVisit(), null);
assert.doesNotThrow(() => dismissVisitCheck());

console.log('visits tests passed');
