import assert from 'node:assert/strict';

import {
  decideLocationAccess,
  mayReadPosition,
  type PermissionLike,
} from './locationAccess';

const granted: PermissionLike = { granted: true, status: 'granted', canAskAgain: true };
const undetermined: PermissionLike = { granted: false, status: 'undetermined', canAskAgain: true };
const denied: PermissionLike = { granted: false, status: 'denied', canAskAgain: false };
const deniedAskable: PermissionLike = { granted: false, status: 'denied', canAskAgain: true };

// 동의가 없으면 OS 권한이 무엇이든 'no-consent' — 이미 허용된 권한이 있어도 읽지 않고, 사전 안내도 띄우지 않는다.
for (const p of [granted, undetermined, denied, null]) {
  assert.equal(decideLocationAccess(false, p), 'no-consent');
}
assert.equal(mayReadPosition(decideLocationAccess(false, granted)), false);

// 동의가 있으면 OS 권한대로.
assert.equal(decideLocationAccess(true, granted), 'granted');
assert.equal(decideLocationAccess(true, undetermined), 'needs-primer');
assert.equal(decideLocationAccess(true, denied), 'denied');
// 거부됐지만 다시 물을 수 있는 경우(안드로이드 첫 거부)도 사전 안내를 다시 띄우지 않는다.
assert.equal(decideLocationAccess(true, deniedAskable), 'denied');
// 권한을 못 읽으면 거부 쪽으로 닫는다.
assert.equal(decideLocationAccess(true, null), 'denied');

assert.equal(mayReadPosition('granted'), true);
for (const a of ['no-consent', 'needs-primer', 'denied'] as const) assert.equal(mayReadPosition(a), false);

console.log('locationAccess.test OK');
