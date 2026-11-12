// features/course/refreshPolicy.ts — 실행: tsx features/course/refreshPolicy.test.ts
import assert from 'node:assert/strict';

import { decideCourseFocusRefresh, shouldRecoverOnAuthEvent } from './refreshPolicy';

const base = { contextKey: 'a', requestedContextKey: 'a', inFlight: false };

assert.equal(decideCourseFocusRefresh(base), 'replan', '방문마다 조용히 다시 받는다(D16 b)');
assert.equal(decideCourseFocusRefresh({ ...base, requestedContextKey: null }), 'skip', '첫 요청은 마운트 몫');
assert.equal(decideCourseFocusRefresh({ ...base, inFlight: true }), 'skip', '진행 중이면 겹쳐 보내지 않는다');
assert.equal(decideCourseFocusRefresh({ ...base, contextKey: 'b' }), 'replan', '여행 조건이 바뀌었다');
assert.equal(decideCourseFocusRefresh({ ...base, contextKey: 'b', inFlight: true }), 'replan', '새 조건이 진행 중 요청을 이긴다');

assert.equal(shouldRecoverOnAuthEvent('SIGNED_IN', true, true), true);
assert.equal(shouldRecoverOnAuthEvent('TOKEN_REFRESHED', true, true), true);
assert.equal(shouldRecoverOnAuthEvent('SIGNED_IN', true, false), false, '멈춘 상태가 아니면 건드리지 않는다');
assert.equal(shouldRecoverOnAuthEvent('SIGNED_IN', false, true), false);
assert.equal(shouldRecoverOnAuthEvent('SIGNED_OUT', true, true), false);
assert.equal(shouldRecoverOnAuthEvent('INITIAL_SESSION', true, true), false);

console.log('refreshPolicy.test.ts ok');
