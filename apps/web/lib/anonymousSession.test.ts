import assert from 'node:assert/strict';
import type { Session } from '@supabase/supabase-js';
import { createAnonymousSessionEnsurer } from './anonymousSession';

const guest = { user: { id: 'guest' } } as Session;
const member = { user: { id: 'member' } } as Session;

let current: Session | null = null;
let signInCalls = 0;
const ensure = createAnonymousSessionEnsurer(() => ({
  async getSession() {
    return { data: { session: current } };
  },
  async signInAnonymously() {
    signInCalls += 1;
    await Promise.resolve();
    current = guest;
    return { data: { session: guest }, error: null };
  },
}));

async function sharedPromiseAndNoPermanentCache() {
  const [first, concurrent] = await Promise.all([ensure(), ensure()]);
  assert.equal(first?.user.id, 'guest');
  assert.equal(concurrent?.user.id, 'guest');
  assert.equal(signInCalls, 1, 'concurrent bootstrap must create only one anonymous user');

  current = member;
  const afterAccountSwitch = await ensure();
  assert.equal(afterAccountSwitch?.user.id, 'member', 'completed guest session must not remain cached');
  assert.equal(signInCalls, 1);
}

// 2026-10-06 감사 I22: 익명 로그인이 거절되면(Supabase IP 한도 429) 다음 호출이 곧바로 다시 가입을 보냈다 —
// /waiting 한 번에 14~17번. 거절 뒤에는 창(5초 → 15초 → 45초 → 2분 → 5분)마다 한 번만 묻는다.
async function backoffAfterRefusal() {
  let clock = 1_000_000;
  let session: Session | null = null;
  let calls = 0;
  let mode: 'refuse' | 'throw' | 'accept' = 'refuse';
  const limited = createAnonymousSessionEnsurer(() => ({
    async getSession() {
      return { data: { session } };
    },
    async signInAnonymously() {
      calls += 1;
      if (mode === 'throw') throw new Error('network down');
      if (mode === 'refuse') return { data: { session: null }, error: { message: 'over_request_rate_limit' } };
      session = guest;
      return { data: { session: guest }, error: null };
    },
  }), () => clock);

  for (let i = 0; i < 8; i++) assert.equal(await limited(), null);
  assert.equal(calls, 1, 'a refused sign-in must not be retried on every call');
  assert.equal(limited.retryInMs(), 5000);

  clock += 5001;
  assert.equal(await limited(), null);
  assert.equal(calls, 2, 'the next attempt happens once the window has passed');
  assert.equal(limited.retryInMs(), 15000, 'the second window is longer');

  // 이메일 로그인처럼 세션이 이미 있으면 창과 무관하게 그 세션을 돌려준다(가입 요청 없이).
  session = member;
  assert.equal((await limited())?.user.id, 'member');
  assert.equal(calls, 2);
  session = null;

  // 세션을 찾으면 실패 횟수가 초기화된다 — 다음 거절의 창은 다시 5초.
  clock += 1;
  assert.equal(await limited(), null);
  assert.equal(calls, 3);
  assert.equal(limited.retryInMs(), 5000);

  // '다시 시도'는 창을 건너뛰고 바로 묻는다.
  limited.resetBackoff();
  assert.equal(limited.retryInMs(), 0);
  mode = 'throw';
  assert.equal(await limited(), null);
  assert.equal(calls, 4, 'resetBackoff lets the next call try at once');
  assert.ok(limited.retryInMs() > 0, 'a thrown sign-in counts as a failure');

  // 창이 지나 가입이 성공하면 세션을 돌려주고, 다음 실패의 창은 다시 5초부터.
  clock += 300_000;
  mode = 'accept';
  assert.equal((await limited())?.user.id, 'guest');
  assert.equal(calls, 5);
  session = null;
  mode = 'refuse';
  assert.equal(await limited(), null);
  assert.equal(calls, 6);
  assert.equal(limited.retryInMs(), 5000);
}

async function run() {
  await sharedPromiseAndNoPermanentCache();
  await backoffAfterRefusal();
  console.log('anonymous session tests passed');
}

void run();
