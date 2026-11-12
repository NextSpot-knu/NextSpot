import assert from 'node:assert/strict';

import { createGuideOpenQueue, type GuideFocus } from './guideOpenQueue';

type Timer = ReturnType<typeof setTimeout>;

function harness() {
  const fallbacks: (GuideFocus | null)[] = [];
  const timers = new Map<number, () => void>();
  let seq = 0;
  const queue = createGuideOpenQueue({
    fallback: (focus) => fallbacks.push(focus),
    waitMs: 1000,
    schedule: (fn) => {
      seq += 1;
      timers.set(seq, fn);
      return seq as unknown as Timer;
    },
    cancel: (t) => void timers.delete(t as unknown as number),
  });
  const fire = () => {
    const due = [...timers.values()];
    timers.clear();
    due.forEach((fn) => fn());
  };
  return { queue, fallbacks, timers, fire };
}

// 등록 뒤에 열면 바로 부른다.
{
  const { queue, fallbacks, timers } = harness();
  const opened: (GuideFocus | null)[] = [];
  queue.register((f) => opened.push(f));
  queue.open(null);
  queue.open('data');
  assert.deepEqual(opened, [null, 'data']);
  assert.equal(timers.size, 0);
  assert.deepEqual(fallbacks, []);
}

// G1-08: 등록 전에 열면 잡아 두었다가 등록되는 즉시 연다 — /guide 로 보내지 않는다.
{
  const { queue, fallbacks, timers, fire } = harness();
  queue.open(null);
  assert.equal(timers.size, 1);
  const opened: (GuideFocus | null)[] = [];
  queue.register((f) => opened.push(f));
  assert.deepEqual(opened, [null]);
  assert.equal(timers.size, 0);
  fire();
  assert.deepEqual(fallbacks, []);
}

// 기다리는 동안 여러 번 열면 마지막 요청 하나만(절 포커스 포함).
{
  const { queue, timers } = harness();
  queue.open(null);
  queue.open('data');
  assert.equal(timers.size, 1);
  const opened: (GuideFocus | null)[] = [];
  queue.register((f) => opened.push(f));
  assert.deepEqual(opened, ['data']);
}

// 기다려도 등록이 오지 않으면 fallback 한 번, 그 뒤 등록은 옛 요청을 열지 않는다.
{
  const { queue, fallbacks, fire } = harness();
  queue.open('data');
  fire();
  assert.deepEqual(fallbacks, ['data']);
  const opened: (GuideFocus | null)[] = [];
  queue.register((f) => opened.push(f));
  assert.deepEqual(opened, []);
}

// 해제는 같은 함수가 아직 등록돼 있을 때만 — 해제 뒤 열기는 다시 기다린다.
{
  const { queue, timers } = harness();
  const a: (GuideFocus | null)[] = [];
  const b: (GuideFocus | null)[] = [];
  const offA = queue.register((f) => a.push(f));
  const offB = queue.register((f) => b.push(f));
  offA();
  queue.open(null);
  assert.deepEqual(b, [null]);
  offB();
  queue.open(null);
  assert.equal(timers.size, 1);
  assert.deepEqual(a, []);
}

console.log('guideOpenQueue.test OK');
