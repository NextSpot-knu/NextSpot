import assert from 'node:assert/strict';

import { startVisibilityPoller, type PollerEnv } from './poller';

function fakeEnv() {
  let now = 0;
  let hidden = false;
  let tick: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const env: PollerEnv = {
    now: () => now,
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
    isHidden: () => hidden,
    onVisibilityChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return {
    env,
    advance(ms: number) {
      now += ms;
      tick?.();
    },
    setHidden(h: boolean) {
      hidden = h;
      for (const fn of listeners) fn();
    },
    get listening() {
      return listeners.size;
    },
    get ticking() {
      return tick !== null;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  // 보일 때는 간격마다 돈다.
  {
    const f = fakeEnv();
    let runs = 0;
    const stop = startVisibilityPoller(() => { runs += 1; }, 1000, {}, f.env);
    f.advance(1000);
    await flush();
    f.advance(1000);
    await flush();
    assert.equal(runs, 2);
    stop();
    assert.equal(f.ticking, false);
    assert.equal(f.listening, 0);
  }
  // 숨으면 건너뛰고, 다시 보이면 간격이 지났을 때 즉시 한 번.
  {
    const f = fakeEnv();
    let runs = 0;
    startVisibilityPoller(() => { runs += 1; }, 1000, {}, f.env);
    f.setHidden(true);
    f.advance(1000);
    f.advance(1000);
    assert.equal(runs, 0);
    f.setHidden(false);
    assert.equal(runs, 1);
    await flush();
    f.advance(400); // 방금 돌았으니 절반 안쪽 틱은 건너뛴다
    assert.equal(runs, 1);
  }
  // keepWhileHidden 이면 숨어도 돈다.
  {
    const f = fakeEnv();
    let runs = 0;
    f.setHidden(true);
    startVisibilityPoller(() => { runs += 1; }, 1000, { keepWhileHidden: () => true }, f.env);
    f.advance(1000);
    assert.equal(runs, 1);
  }
  // 실행 중이면 겹쳐 돌지 않고, 실패는 삼킨다.
  {
    const f = fakeEnv();
    let runs = 0;
    let release: () => void = () => {};
    startVisibilityPoller(() => {
      runs += 1;
      return new Promise<void>((_, reject) => { release = () => reject(new Error('boom')); });
    }, 1000, {}, f.env);
    f.advance(1000);
    f.advance(1000);
    assert.equal(runs, 1);
    release();
    await flush();
    await flush();
    f.advance(1000);
    assert.equal(runs, 2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
