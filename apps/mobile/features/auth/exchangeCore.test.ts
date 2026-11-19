import assert from 'node:assert/strict';

import { createCodeExchanger, MAX_REMEMBERED_CODES } from './exchangeCore';

async function main() {
  // 같은 code 를 동시에 두 번 → 서버 교환은 한 번, 결과는 같다
  const calls: Array<[string, string | null]> = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ex = createCodeExchanger(async (code, flowId) => {
    calls.push([code, flowId]);
    await gate;
    return { error: null };
  });
  const a = ex.exchangeOnce('c1', 'flow-1');
  const b = ex.exchangeOnce('c1', 'flow-other');
  assert.equal(a, b, '진행 중이면 같은 Promise');
  release();
  assert.deepEqual(await a, { ok: true, error: null });
  assert.deepEqual(await b, { ok: true, error: null });
  // 끝난 뒤 또 불러도 다시 보내지 않는다
  assert.deepEqual(await ex.exchangeOnce('c1'), { ok: true, error: null });
  assert.deepEqual(calls, [['c1', 'flow-1']], 'flowId 는 처음 값만 쓴다');
  assert.equal(ex.has('c1'), true);
  assert.equal(ex.has('c2'), false);

  // 실패도 기억한다 — 같은 code 로 다시 보내지 않는다(verifier 는 이미 지워졌다)
  let failCalls = 0;
  const failing = createCodeExchanger(async () => {
    failCalls += 1;
    return { error: { message: 'invalid grant' } };
  });
  assert.deepEqual(await failing.exchangeOnce('x'), { ok: false, error: 'invalid grant' });
  assert.deepEqual(await failing.exchangeOnce('x'), { ok: false, error: 'invalid grant' });
  assert.equal(failCalls, 1);

  // 예외도 결과로 바꾼다(던지지 않는다)
  const throwing = createCodeExchanger(async () => {
    throw new Error('network down');
  });
  assert.deepEqual(await throwing.exchangeOnce('y'), { ok: false, error: 'network down' });

  // 다른 code 는 따로 교환한다 + 기억 상한
  let n = 0;
  const many = createCodeExchanger(async () => {
    n += 1;
    return { error: null };
  });
  for (let i = 0; i < MAX_REMEMBERED_CODES + 5; i += 1) await many.exchangeOnce(`k${i}`);
  assert.equal(n, MAX_REMEMBERED_CODES + 5);
  assert.equal(many.has('k0'), false, '가장 오래된 것부터 잊는다');
  assert.equal(many.has(`k${MAX_REMEMBERED_CODES + 4}`), true);

  console.log('exchangeCore.test OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
