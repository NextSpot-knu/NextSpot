// 콜백 처리 순서 — 교환은 한 번, 화면이 두 번 붙어도 같은 결과, 실패하면 흔적을 지운다.
import assert from 'node:assert/strict';

import { createCallbackInbox, waitForCallback } from './callbackInbox';
import { createCallbackProcessor, type CallbackDeps } from './callbackFlowCore';
import { createCodeExchanger } from './exchangeCore';
import type { PendingFlow } from './pendingFlow';

function harness(opts: { exchangeError?: string; retryDelivers?: string | null; os?: string; linking?: boolean } = {}) {
  let clock = 10_000;
  const inbox = createCallbackInbox(() => clock);
  let pending: PendingFlow | null = null;
  const log: string[] = [];
  let exchangeCalls = 0;
  const exchanger = createCodeExchanger(async (code, flowId) => {
    exchangeCalls += 1;
    log.push(`exchange:${code}:${flowId}`);
    await new Promise((r) => setTimeout(r, 5));
    return { error: opts.exchangeError ? { message: opts.exchangeError } : null };
  });
  const deps: CallbackDeps = {
    os: opts.os ?? 'android',
    identityLinking: opts.linking ?? true,
    now: () => clock,
    inbox,
    waitForEntry: (since, timeout) => waitForCallback(inbox, since, Math.min(timeout, 10)),
    readPending: () => pending,
    clearPending: () => {
      log.push('clearPending');
      pending = null;
    },
    exchangeOnce: (code, flowId) => exchanger.exchangeOnce(code, flowId),
    retrySignIn: async (provider, next) => {
      log.push(`retry:${provider}:${next}`);
      if (!opts.retryDelivers) return false;
      clock += 1;
      pending = { provider, retry: true, next, flowId: 'f-retry', startedAt: clock };
      clock += 1;
      inbox.deliver(opts.retryDelivers);
      return true;
    },
    mergeGuest: async () => void log.push('merge'),
    discardGuest: () => void log.push('discard'),
    syncProfile: async () => void log.push('sync'),
    warn: () => undefined,
  };
  return {
    processor: createCallbackProcessor(deps),
    inbox,
    log,
    exchangeCalls: () => exchangeCalls,
    start(flow: Partial<PendingFlow> = {}) {
      pending = { provider: 'google', retry: false, next: '/', flowId: 'f-1', startedAt: clock, ...flow };
      clock += 1;
    },
    tick(ms: number) {
      clock += ms;
    },
    pending: () => pending,
  };
}

async function main() {
  // 1. 정상 — 교환 → 합치기 → 프로필 → 목적지. 화면 두 개가 동시에 불러도 교환 한 번, 결과 같음.
  {
    const h = harness();
    h.start({ next: '/saved' });
    h.inbox.deliver('nextspot://auth/callback?code=c1');
    const [a, b] = await Promise.all([h.processor.process(), h.processor.process()]);
    assert.deepEqual(a, { kind: 'done', dest: '/saved' });
    assert.deepEqual(b, a);
    assert.equal(h.exchangeCalls(), 1);
    assert.deepEqual(h.log, ['exchange:c1:f-1', 'clearPending', 'merge', 'sync']);
    assert.equal(h.pending(), null);
    assert.equal(h.inbox.peek(), null);
    // 끝난 뒤 늦게 붙은 화면도 같은 성공을 받는다(흐름 기록이 지워졌어도 '실패'로 덮지 않는다)
    h.tick(1000);
    assert.deepEqual(await h.processor.process(), a);
    assert.equal(h.exchangeCalls(), 1);
    // 같은 code 가 늦게 다시 들어와도 받지 않는다
    assert.equal(h.inbox.deliver('nextspot://auth/callback?code=c1'), false);
  }

  // 2. 목적지 검증 — 흐름 기록의 next 도 허용 목록을 통과해야 한다
  {
    const h = harness();
    h.start({ next: '//evil.example' });
    h.inbox.deliver('nextspot://auth/callback?code=c2');
    assert.deepEqual(await h.processor.process(), { kind: 'done', dest: '/mypage' });
  }

  // 3. 앱이 시작하지 않은 딥링크 — 교환하지 않는다
  {
    const h = harness();
    h.inbox.deliver('nextspot://auth/callback?code=attacker');
    assert.deepEqual(await h.processor.process(), { kind: 'failed', reason: 'generic' });
    assert.equal(h.exchangeCalls(), 0);
    assert.ok(!h.log.includes('discard'), '요청하지 않은 링크는 게스트 합치기 토큰을 지우지 않는다');
    assert.equal(h.inbox.peek(), null);
  }

  // 4. 흐름 시작 전에 고여 있던 결과 — 교환하지 않는다
  {
    const h = harness();
    h.inbox.deliver('nextspot://auth/callback?code=stale');
    h.tick(5);
    h.start();
    assert.deepEqual(await h.processor.process(), { kind: 'failed', reason: 'generic' });
    assert.equal(h.exchangeCalls(), 0, '흐름 시작 전 결과는 교환하지 않는다');
  }

  // 5. 교환 실패 — 게스트 토큰을 버리고 실패, 기록 정리
  {
    const h = harness({ exchangeError: 'invalid flow state' });
    h.start();
    h.inbox.deliver('nextspot://auth/callback?code=bad');
    assert.deepEqual(await h.processor.process(), { kind: 'failed', reason: 'generic' });
    assert.deepEqual(h.log, ['exchange:bad:f-1', 'clearPending', 'discard']);
    assert.equal(h.pending(), null);
  }

  // 6. identity_already_exists → 한 번 재시도 → 그 결과를 교환
  {
    const h = harness({ retryDelivers: 'nextspot://auth/callback?code=after-retry' });
    h.start({ next: '/mypage' });
    h.inbox.deliver('nextspot://auth/callback?error=server_error&error_code=identity_already_exists');
    assert.deepEqual(await h.processor.process(), { kind: 'done', dest: '/mypage' });
    assert.ok(h.log.includes('retry:google:/mypage'));
    assert.ok(h.log.includes('exchange:after-retry:f-retry'));
    assert.equal(h.exchangeCalls(), 1);
  }

  // 7. 재시도가 다시 identity_already_exists → 더 돌지 않고 already_linked
  {
    const h = harness({ retryDelivers: 'nextspot://auth/callback?error=e&error_code=identity_already_exists' });
    h.start();
    h.inbox.deliver('nextspot://auth/callback?error=e&error_code=identity_already_exists');
    assert.deepEqual(await h.processor.process(), { kind: 'failed', reason: 'already_linked' });
    assert.equal(h.log.filter((l) => l.startsWith('retry:')).length, 1);
  }

  // 8. iOS 는 재시도하지 않는다
  {
    const h = harness({ os: 'ios', retryDelivers: 'nextspot://auth/callback?code=x' });
    h.start();
    h.inbox.deliver('nextspot://auth/callback?error=e&error_code=identity_already_exists');
    assert.deepEqual(await h.processor.process(), { kind: 'failed', reason: 'already_linked' });
    assert.equal(h.log.filter((l) => l.startsWith('retry:')).length, 0);
  }

  // 9. 재시도를 사용자가 닫음 → 일반 실패
  {
    const h = harness({ retryDelivers: null });
    h.start();
    h.inbox.deliver('nextspot://auth/callback?error=e&error_code=identity_already_exists');
    assert.deepEqual(await h.processor.process(), { kind: 'failed', reason: 'generic' });
  }

  // 9-1. v1 기본값(연결 없음): identity_already_exists 로 브라우저를 다시 열지 않는다
  {
    const h = harness({ linking: false, retryDelivers: 'nextspot://auth/callback?code=x' });
    h.start();
    h.inbox.deliver('nextspot://auth/callback?error=e&error_code=identity_already_exists');
    assert.deepEqual(await h.processor.process(), { kind: 'failed', reason: 'already_linked' });
    assert.equal(h.log.filter((l) => l.startsWith('retry:')).length, 0);
  }

  // 10. reset 뒤에는 새로 처리한다(새 흐름)
  {
    const h = harness();
    h.start();
    h.inbox.deliver('nextspot://auth/callback?code=r1');
    assert.equal((await h.processor.process()).kind, 'done');
    h.processor.reset();
    h.start();
    h.inbox.deliver('nextspot://auth/callback?code=r2');
    assert.equal((await h.processor.process()).kind, 'done');
    assert.equal(h.exchangeCalls(), 2);
  }

  console.log('callbackFlow.test OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
