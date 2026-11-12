import assert from 'node:assert/strict';

import { decideCallbackAction } from './callbackDecision';
import { parseAuthCallback } from './redirect';

const pending = { provider: 'google' as const, retry: false, startedAt: 1000 };
const ok = parseAuthCallback('nextspot://auth/callback?code=c1');
const linked = parseAuthCallback('nextspot://auth/callback?error=server_error&error_code=identity_already_exists');
const denied = parseAuthCallback('nextspot://auth/callback?error=access_denied');
const empty = parseAuthCallback('nextspot://auth/callback');

// 정상: code 교환
assert.deepEqual(decideCallbackAction({ params: ok, receivedAt: 1500, pending, os: 'android' }), { kind: 'exchange', code: 'c1' });
// 앱이 시작한 흐름이 없으면 교환하지 않는다(다른 앱이 보낸 딥링크)
assert.deepEqual(decideCallbackAction({ params: ok, receivedAt: 1500, pending: null, os: 'android' }), {
  kind: 'fail',
  reason: 'no_pending',
});
// 흐름 시작 전에 고여 있던 결과는 쓰지 않는다
assert.deepEqual(decideCallbackAction({ params: ok, receivedAt: 999, pending, os: 'android' }), { kind: 'fail', reason: 'stale' });
// 결과가 아직 없음
assert.deepEqual(decideCallbackAction({ params: null, receivedAt: null, pending, os: 'android' }), {
  kind: 'fail',
  reason: 'no_code',
});
assert.deepEqual(decideCallbackAction({ params: empty, receivedAt: 1500, pending, os: 'android' }), {
  kind: 'fail',
  reason: 'no_code',
});

// v1(계정 연결 없음): identity_already_exists 는 주입된 링크다 — 브라우저를 다시 열지 않는다
assert.deepEqual(decideCallbackAction({ params: linked, receivedAt: 1500, pending, os: 'android' }), {
  kind: 'fail',
  reason: 'already_linked',
});
// 연결을 켠 버전: 같은 공급자로 한 번 재시도(안드로이드 구글)
assert.deepEqual(decideCallbackAction({ params: linked, receivedAt: 1500, pending, os: 'android', identityLinking: true }), {
  kind: 'retry_sign_in',
  provider: 'google',
});
// 이미 재시도 흐름이면 다시 하지 않는다(무한 루프 방지)
assert.deepEqual(
  decideCallbackAction({ params: linked, receivedAt: 1500, pending: { ...pending, retry: true }, os: 'android', identityLinking: true }),
  { kind: 'fail', reason: 'already_linked' },
);
// iOS 에서는 어떤 경우에도 OAuth 를 다시 열지 않는다
assert.deepEqual(decideCallbackAction({ params: linked, receivedAt: 1500, pending, os: 'ios', identityLinking: true }), {
  kind: 'fail',
  reason: 'already_linked',
});
// 막힌 공급자(카카오)도 재시도하지 않는다
assert.deepEqual(
  decideCallbackAction({ params: linked, receivedAt: 1500, pending: { ...pending, provider: 'kakao' }, os: 'android', identityLinking: true }),
  { kind: 'fail', reason: 'already_linked' },
);
// 그 밖의 공급자 오류
assert.deepEqual(decideCallbackAction({ params: denied, receivedAt: 1500, pending, os: 'android' }), {
  kind: 'fail',
  reason: 'provider_error',
});
// 오류와 code 가 함께 오면 오류가 이긴다(교환하지 않는다)
assert.equal(
  decideCallbackAction({
    params: parseAuthCallback('nextspot://auth/callback?code=c&error=x'),
    receivedAt: 1500,
    pending,
    os: 'android',
  }).kind,
  'fail',
);

console.log('callbackDecision.test OK');
