import assert from 'node:assert/strict';

import { MIN_HEAL_DELAY_MS, createHealScheduler } from './sessionHeal';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function main() {
  let active = true;
  let retryIn = 5_000;
  let ensureCalls = 0;
  let nextResult: unknown = null;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  const healer = createHealScheduler({
    ensure: async () => { ensureCalls += 1; return nextResult; },
    retryInMs: () => retryIn,
    isActive: () => active,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (h) => { timers.delete(h as number); },
  });
  const fire = () => {
    const [[id, t]] = [...timers.entries()];
    timers.delete(id);
    t.fn();
  };

  // arm 은 다음 창에 한 번만 건다(중복 무시).
  healer.arm();
  healer.arm();
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].ms, 5_000);

  // 앞에 있으면 타이머가 묻고, 또 실패하면 다시 건다.
  fire();
  await flush();
  assert.equal(ensureCalls, 1);
  assert.equal(timers.size, 1, '실패하면 다시 건다');

  // 배경에서 타이머가 울리면 묻지 않고 앞으로 오기를 기다린다.
  active = false;
  fire();
  await flush();
  assert.equal(ensureCalls, 1);
  assert.equal(healer.pending(), true);
  healer.arm();
  assert.equal(timers.size, 0, '기다리는 동안은 타이머를 걸지 않는다');

  // 앞으로 오면 바로 묻는다 — 이번엔 성공.
  active = true;
  nextResult = { user: { id: 'u' } };
  healer.onActive();
  await flush();
  assert.equal(ensureCalls, 2);
  assert.equal(healer.pending(), false);

  // 타이머가 걸린 채 배경에 있다가 창이 지난 뒤 앞으로 오면 기다리지 않고 묻는다.
  nextResult = null;
  retryIn = 0;
  healer.arm();
  assert.equal([...timers.values()][0].ms, MIN_HEAL_DELAY_MS, '최소 1초');
  healer.onActive();
  await flush();
  assert.equal(ensureCalls, 3);
  assert.equal(timers.size, 1, '실패라 다음 창을 다시 건다');

  // 창이 남아 있으면 앞으로 와도 타이머를 그대로 둔다.
  retryIn = 10_000;
  healer.onActive();
  await flush();
  assert.equal(ensureCalls, 3);

  // dispose 뒤에는 아무것도 하지 않는다.
  healer.dispose();
  assert.equal(timers.size, 0);
  healer.arm();
  healer.onActive();
  await flush();
  assert.equal(timers.size, 0);
  assert.equal(ensureCalls, 3);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
