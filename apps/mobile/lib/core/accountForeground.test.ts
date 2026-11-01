import assert from 'node:assert/strict';

import { ACCOUNT_RECHECK_MIN_AGE_MS } from '@/lib/accountRoles';

import { cameToForeground, shouldRefreshAccountOnForeground } from './accountForeground';

assert.equal(cameToForeground('background', 'active'), true);
assert.equal(cameToForeground('inactive', 'active'), true);
assert.equal(cameToForeground('active', 'active'), false, '이미 앞이면 아니다');
assert.equal(cameToForeground('active', 'background'), false);
assert.equal(cameToForeground(null, 'active'), true);

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
