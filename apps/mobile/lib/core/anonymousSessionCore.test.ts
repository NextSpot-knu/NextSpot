import assert from 'node:assert/strict';
import type { Session } from '@supabase/supabase-js';

import { BACKOFF_MS, backoffDelayMs, createAnonymousSessionEnsurer, type AnonymousAuthClient } from './anonymousSessionCore';

async function main() {
  // 창: 5초·15초·45초·2분·5분, 이후 5분 유지.
  assert.deepEqual([...BACKOFF_MS], [5_000, 15_000, 45_000, 120_000, 300_000]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map(backoffDelayMs), [0, 5_000, 15_000, 45_000, 120_000, 300_000, 300_000, 300_000]);

  const origWarn = console.warn;
  console.warn = () => {};
  try {
    let clock = 1_000_000;
    let stored: Session | null = null;
    let signInCalls = 0;
    let succeed = false;
    const fakeSession = { user: { id: 'u1' } } as unknown as Session;
    const auth: AnonymousAuthClient = {
      getSession: async () => ({ data: { session: stored } }),
      signInAnonymously: async () => {
        signInCalls += 1;
        if (!succeed) return { data: { session: null }, error: { message: '429' } };
        stored = fakeSession;
        return { data: { session: fakeSession }, error: null };
      },
    };
    const ensure = createAnonymousSessionEnsurer(() => auth, () => clock);

    // 동시 호출은 하나의 시도를 나눈다.
    const [a, b] = await Promise.all([ensure(), ensure()]);
    assert.equal(a, null);
    assert.equal(b, null);
    assert.equal(signInCalls, 1);
    assert.equal(ensure.retryInMs(), 5_000);

    // 창 안에서는 네트워크 없이 null.
    clock += 4_999;
    assert.equal(await ensure(), null);
    assert.equal(signInCalls, 1);

    // 창이 지나면 다시 묻고, 실패하면 다음 창(15초).
    clock += 1;
    assert.equal(await ensure(), null);
    assert.equal(signInCalls, 2);
    assert.equal(ensure.retryInMs(), 15_000);

    // 사람이 누른 재시도는 창을 건너뛴다(실패 횟수는 남아 다음 창은 45초).
    ensure.resetBackoff();
    assert.equal(ensure.retryInMs(), 0);
    assert.equal(await ensure(), null);
    assert.equal(signInCalls, 3);
    assert.equal(ensure.retryInMs(), 45_000);

    // 성공하면 창이 지워진다.
    clock += 45_000;
    succeed = true;
    assert.equal(await ensure(), fakeSession);
    assert.equal(ensure.retryInMs(), 0);

    // 저장된 세션은 signIn 없이 바로 돌려준다.
    assert.equal(await ensure(), fakeSession);
    assert.equal(signInCalls, 4);

    // 예외도 실패로 센다.
    const throwing = createAnonymousSessionEnsurer(() => { throw new Error('boom'); }, () => clock);
    assert.equal(await throwing(), null);
    assert.equal(throwing.retryInMs(), 5_000);
  } finally {
    console.warn = origWarn;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
