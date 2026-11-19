import assert from 'node:assert/strict';

import { countJsonArray, pickDisplayName, runAccountDeletion, visibleProviders, wageValueKrw } from './accountCore';

assert.deepEqual(visibleProviders('ios'), [], 'iOS 는 소셜 버튼 없음');
assert.deepEqual(visibleProviders('android'), ['google'], '안드로이드는 구글만');
assert.deepEqual(visibleProviders('web'), []);

assert.equal(pickDisplayName({ remoteNickname: ' 별 ', email: 'a@b.c', storedName: 'x' }), '별');
assert.equal(pickDisplayName({ storedName: ' 내이름 ', email: 'a@b.c' }), '내이름');
assert.equal(pickDisplayName({ email: 'kim@x.com' }), 'kim');
assert.equal(pickDisplayName({ email: '' }), null);
assert.equal(pickDisplayName({}), null);

assert.equal(countJsonArray(null), 0);
assert.equal(countJsonArray('[1,2,3]'), 3);
assert.equal(countJsonArray('{"a":1}'), 0);
assert.equal(countJsonArray('[bad'), 0);

assert.equal(wageValueKrw(60), 10320);
assert.equal(wageValueKrw(0), 0);

async function main() {
  const calls: string[] = [];
  const deps = (failServer: boolean) => ({
    deleteOnServer: async () => { calls.push('server'); if (failServer) throw new Error('x'); },
    signOutLocal: async () => { calls.push('signOut'); },
    clearLocalData: () => { calls.push('clear'); },
    startGuestSession: async () => { calls.push('guest'); },
  });
  assert.equal(await runAccountDeletion(deps(false)), 'ok');
  assert.deepEqual(calls, ['server', 'signOut', 'clear', 'guest'], '순서');
  calls.length = 0;
  assert.equal(await runAccountDeletion(deps(true)), 'failed');
  assert.deepEqual(calls, ['server'], '서버 실패면 로컬을 지우지 않는다');
  // 이후 단계가 던져도 ok
  const r = await runAccountDeletion({
    deleteOnServer: async () => {},
    signOutLocal: async () => { throw new Error('a'); },
    clearLocalData: () => { throw new Error('b'); },
    startGuestSession: async () => { throw new Error('c'); },
  });
  assert.equal(r, 'ok');
  console.log('accountCore ok');
}
void main();
