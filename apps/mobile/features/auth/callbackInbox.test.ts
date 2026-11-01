import assert from 'node:assert/strict';

import { createCallbackInbox, waitForCallback } from './callbackInbox';

async function main() {
  let clock = 100;
  const inbox = createCallbackInbox(() => clock);
  const seen: string[] = [];
  const off = inbox.subscribe((e) => seen.push(e.params.code ?? e.params.error ?? '?'));

  assert.equal(inbox.deliver('nextspot://mypage'), false, '콜백이 아니면 받지 않는다');
  assert.equal(inbox.deliver('https://evil.example/auth/callback?code=z'), false);
  assert.equal(inbox.deliver('nextspot://auth/callback?code=c1'), true);
  // 안드로이드: 같은 딥링크가 WebBrowser 결과와 라우터 양쪽으로 온다 → 한 번만
  assert.equal(inbox.deliver('nextspot://auth/callback?code=c1'), false);
  assert.deepEqual(seen, ['c1']);
  assert.equal(inbox.peek()?.params.code, 'c1');
  assert.equal(inbox.peek()?.receivedAt, 100);
  // 비운 뒤 늦게 도착한 같은 code 도 다시 받지 않는다
  inbox.clear();
  assert.equal(inbox.deliver('nextspot://auth/callback?code=c1'), false);
  assert.equal(inbox.peek(), null);
  // 새 code 는 받는다
  clock = 200;
  assert.equal(inbox.deliver('nextspot://auth/callback?code=c2'), true);
  assert.equal(inbox.peek()?.receivedAt, 200);
  // 같은 오류 두 번 → 한 번
  inbox.clear();
  assert.equal(inbox.deliver('nextspot://auth/callback?error=access_denied'), true);
  assert.equal(inbox.deliver('nextspot://auth/callback?error=access_denied'), false);
  off();
  inbox.deliver('nextspot://auth/callback?code=c3');
  assert.deepEqual(seen, ['c1', 'c2', 'access_denied'], '해제 뒤에는 알리지 않는다');

  // waitForCallback: 이미 있으면 바로, 기준 시각보다 오래됐으면 기다림
  const fresh = createCallbackInbox(() => clock);
  clock = 500;
  fresh.deliver('nextspot://auth/callback?code=old');
  assert.equal(await waitForCallback(fresh, 400, 0), fresh.peek());
  assert.equal(await waitForCallback(fresh, 600, 0), null, '오래된 결과 + 기다리지 않음');
  const timers: Array<() => void> = [];
  const fakeSet = (fn: () => void) => {
    timers.push(fn);
    return timers.length;
  };
  // 기다리는 동안 들어오면 받는다
  const pending = waitForCallback(fresh, 600, 1000, fakeSet, () => undefined);
  clock = 700;
  fresh.deliver('nextspot://auth/callback?code=new');
  assert.equal((await pending)?.params.code, 'new');
  // 시간이 다 되면 null
  const timeout = waitForCallback(fresh, 10_000, 1000, fakeSet, () => undefined);
  timers[timers.length - 1]();
  assert.equal(await timeout, null);

  console.log('callbackInbox.test OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
