import assert from 'node:assert/strict';

import { ACCOUNT_RECHECK_MIN_AGE_MS } from '@/lib/accountRoles';

import { cameToForeground, shouldRefreshAccountOnForeground, trackAppState } from './accountForeground';

assert.equal(cameToForeground('background', 'active'), true);
assert.equal(cameToForeground('inactive', 'active'), false, 'inactive 는 앱을 떠난 것이 아니다');
assert.equal(cameToForeground('active', 'active'), false, '이미 앞이면 아니다');
assert.equal(cameToForeground('active', 'background'), false);
assert.equal(cameToForeground(null, 'active'), false, '처음 상태는 마운트 조회가 맡는다');

// 상태 열을 trackAppState 로 기록하며 흘려 보낸다 — 앞으로 돌아온 횟수만 센다.
function foregroundCount(states: string[], start = 'active'): number {
  let prev: string | null | undefined = start;
  let n = 0;
  for (const next of states) {
    if (cameToForeground(prev, next)) n += 1;
    prev = trackAppState(prev, next);
  }
  return n;
}
assert.equal(foregroundCount(['inactive', 'active']), 0, 'iOS 알림 센터·제어 센터');
assert.equal(foregroundCount(['inactive', 'background', 'inactive', 'active']), 1, 'iOS 홈으로 나갔다 돌아옴');
assert.equal(foregroundCount(['inactive', 'background', 'active']), 1, 'iOS 백그라운드 → active');
assert.equal(foregroundCount(['background', 'active']), 1, '안드로이드');
assert.equal(foregroundCount(['background', 'active', 'inactive', 'active']), 1, '돌아온 뒤 알림 센터는 다시 세지 않는다');

const now = 10_000_000;
const fresh = { userId: 'u1', isAnonymous: false, pendingVerification: false, at: now - 60_000 };

assert.equal(shouldRefreshAccountOnForeground({ id: 'u1', is_anonymous: false }, fresh, now), false, '같은 사용자 · 5분 안 — 건너뛴다');
assert.equal(
  shouldRefreshAccountOnForeground({ id: 'u1', is_anonymous: false }, { ...fresh, at: now - ACCOUNT_RECHECK_MIN_AGE_MS - 1 }, now),
  true,
  '5분이 지났으면 다시 묻는다',
);
assert.equal(shouldRefreshAccountOnForeground({ id: 'u2' }, fresh, now), true, '다른 사용자');
assert.equal(shouldRefreshAccountOnForeground({ id: 'u1', is_anonymous: true }, fresh, now), true, '익명 여부가 바뀜');
assert.equal(shouldRefreshAccountOnForeground({ id: 'u1' }, { ...fresh, pendingVerification: true }, now), true, '인증 심사 중');
assert.equal(shouldRefreshAccountOnForeground({ id: 'u1' }, null, now), true, '직전 성공 없음(실패 뒤)');
assert.equal(shouldRefreshAccountOnForeground(null, fresh, now), true, '세션 없음');

console.log('ok accountForeground');
