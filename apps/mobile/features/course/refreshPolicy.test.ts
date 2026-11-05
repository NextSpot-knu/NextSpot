// features/course/refreshPolicy.ts — 실행: tsx features/course/refreshPolicy.test.ts
import assert from 'node:assert/strict';

import { COURSE_REFRESH_AFTER_MS, decideCourseFocusRefresh, shouldRecoverOnAuthEvent } from './refreshPolicy';

const base = { contextKey: 'a', requestedContextKey: 'a', lastOkAt: 1000, now: 2000, inFlight: false, needsAuth: false };

assert.equal(decideCourseFocusRefresh(base), 'skip', '같은 조건 · 최근 성공이면 그대로');
assert.equal(decideCourseFocusRefresh({ ...base, requestedContextKey: null }), 'skip', '첫 요청은 마운트 몫');
assert.equal(decideCourseFocusRefresh({ ...base, contextKey: 'b' }), 'replan', '여행 조건이 바뀌었다');
assert.equal(decideCourseFocusRefresh({ ...base, contextKey: 'b', inFlight: true }), 'replan', '새 조건이 진행 중 요청을 이긴다');
assert.equal(decideCourseFocusRefresh({ ...base, now: 1000 + COURSE_REFRESH_AFTER_MS + 1 }), 'replan', '오래된 계획');
assert.equal(decideCourseFocusRefresh({ ...base, now: 1000 + COURSE_REFRESH_AFTER_MS }), 'skip', '경계는 아직');
assert.equal(decideCourseFocusRefresh({ ...base, now: 1000 + COURSE_REFRESH_AFTER_MS + 1, inFlight: true }), 'skip');
assert.equal(decideCourseFocusRefresh({ ...base, now: 1000 + COURSE_REFRESH_AFTER_MS + 1, needsAuth: true }), 'skip');
assert.equal(decideCourseFocusRefresh({ ...base, lastOkAt: 0, now: 10 ** 12 }), 'skip', '성공한 적이 없으면 시간으로 다시 묻지 않는다');

assert.equal(shouldRecoverOnAuthEvent('SIGNED_IN', true, true), true);
assert.equal(shouldRecoverOnAuthEvent('TOKEN_REFRESHED', true, true), true);
assert.equal(shouldRecoverOnAuthEvent('SIGNED_IN', true, false), false, '멈춘 상태가 아니면 건드리지 않는다');
assert.equal(shouldRecoverOnAuthEvent('SIGNED_IN', false, true), false);
assert.equal(shouldRecoverOnAuthEvent('SIGNED_OUT', true, true), false);
assert.equal(shouldRecoverOnAuthEvent('INITIAL_SESSION', true, true), false);

console.log('refreshPolicy.test.ts ok');
