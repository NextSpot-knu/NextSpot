// 숨은 탭 폴링 멈춤 — 관제 탭을 열어 둔 채 잊어도 서버를 두드리지 않는다.
// 단 안전 경보의 '알림 받기' 가 켜져 있으면 숨은 탭 폴링이 곧 기능이므로 계속 돈다.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startVisibilityPoller, type PollerEnv } from './visibilityPoller';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const S = 1000;
const INTERVAL = 30 * S;

function fakeEnv() {
  const state = {
    t: 0,
    hidden: false,
    tick: null as null | (() => void),
    tickMs: 0,
    cleared: false,
    listener: null as null | (() => void),
    removed: false,
  };
  const env: PollerEnv = {
    now: () => state.t,
    setInterval: (fn, ms) => {
      state.tick = fn;
      state.tickMs = ms;
      return 7;
    },
    clearInterval: (id) => {
      if (id === 7) state.cleared = true;
    },
    isHidden: () => state.hidden,
    onVisibilityChange: (fn) => {
      state.listener = fn;
      return () => {
        state.removed = true;
        state.listener = null;
      };
    },
  };
  const at = (t: number) => {
    state.t = t;
  };
  const tickAt = (t: number) => {
    state.t = t;
    state.tick?.();
  };
  const setHidden = (hidden: boolean, t: number) => {
    state.t = t;
    state.hidden = hidden;
    state.listener?.();
  };
  return { env, state, at, tickAt, setHidden };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  // 보이는 탭: 틱마다 1회
  {
    const f = fakeEnv();
    let runs = 0;
    startVisibilityPoller(() => { runs += 1; }, INTERVAL, {}, f.env);
    assert.equal(f.state.tickMs, INTERVAL);
    f.tickAt(30 * S); await flush();
    f.tickAt(60 * S); await flush();
    assert.equal(runs, 2);
  }

  // 숨은 탭: 틱을 건너뛴다
  {
    const f = fakeEnv();
    let runs = 0;
    startVisibilityPoller(() => { runs += 1; }, INTERVAL, {}, f.env);
    f.setHidden(true, 1 * S);
    f.tickAt(30 * S); f.tickAt(60 * S); f.tickAt(90 * S); await flush();
    assert.equal(runs, 0, '숨은 탭에서 폴링했다');
  }

  // keepWhileHidden 이 참이면 숨은 탭에서도 돈다, 거짓이 되면 멈춘다
  {
    const f = fakeEnv();
    let runs = 0;
    let keep = true;
    startVisibilityPoller(() => { runs += 1; }, INTERVAL, { keepWhileHidden: () => keep }, f.env);
    f.setHidden(true, 1 * S);
    f.tickAt(30 * S); await flush();
    f.tickAt(60 * S); await flush();
    assert.equal(runs, 2, "'알림 받기' 가 켜져 있는데 숨은 탭 폴링이 멈췄다");
    keep = false;
    f.tickAt(90 * S); await flush();
    assert.equal(runs, 2);
  }

  // 간격 이상 숨어 있다 돌아오면 즉시 1회
  {
    const f = fakeEnv();
    let runs = 0;
    startVisibilityPoller(() => { runs += 1; }, INTERVAL, {}, f.env);
    f.setHidden(true, 0);
    f.tickAt(30 * S); f.tickAt(60 * S); f.tickAt(90 * S);
    f.setHidden(false, 90 * S); await flush();
    assert.equal(runs, 1, '돌아왔을 때 낡은 화면을 한 번 새로 고쳐야 한다');
  }

  // 복귀 실행 직후의 틱은 건너뛴다: 89.5 초 복귀 실행 → 90 초 틱 없음 → 120 초 틱 실행
  {
    const f = fakeEnv();
    let runs = 0;
    startVisibilityPoller(() => { runs += 1; }, INTERVAL, {}, f.env);
    f.setHidden(true, 0);
    f.tickAt(30 * S); f.tickAt(60 * S);
    f.setHidden(false, 89.5 * S); await flush();
    assert.equal(runs, 1);
    f.tickAt(90 * S); await flush();
    assert.equal(runs, 1, '복귀 실행 0.5초 뒤 틱이 또 돌았다');
    f.tickAt(120 * S); await flush();
    assert.equal(runs, 2);
  }

  // 잠깐 숨었다 돌아오면 새로 고치지 않는다
  {
    const f = fakeEnv();
    let runs = 0;
    startVisibilityPoller(() => { runs += 1; }, INTERVAL, {}, f.env);
    f.setHidden(true, 10 * S);
    f.setHidden(false, 15 * S); await flush();
    assert.equal(runs, 0);
  }

  // 실행 중이면 틱을 건너뛰고, 끝난 뒤 다음 틱은 돈다
  {
    const f = fakeEnv();
    let runs = 0;
    let release: () => void = () => {};
    startVisibilityPoller(
      () => {
        runs += 1;
        return new Promise<void>((r) => { release = r; });
      },
      INTERVAL,
      {},
      f.env,
    );
    f.tickAt(30 * S); f.tickAt(60 * S); f.tickAt(90 * S); await flush();
    assert.equal(runs, 1, '이전 조회가 끝나기 전에 겹쳐 보냈다');
    release(); await flush(); await flush();
    f.tickAt(120 * S); await flush();
    assert.equal(runs, 2);
  }

  // stop: 타이머·구독 해제, 이후 틱은 무효
  {
    const f = fakeEnv();
    let runs = 0;
    const stop = startVisibilityPoller(() => { runs += 1; }, INTERVAL, {}, f.env);
    const tick = f.state.tick;
    stop();
    assert.equal(f.state.cleared, true);
    assert.equal(f.state.removed, true);
    f.at(60 * S);
    tick?.(); await flush();
    assert.equal(runs, 0);
  }

  // 실패한 실행이 폴링을 멈추지 않는다(동기 throw·reject 모두)
  {
    const f = fakeEnv();
    let runs = 0;
    startVisibilityPoller(
      () => {
        runs += 1;
        if (runs === 1) throw new Error('boom');
        return Promise.reject(new Error('down'));
      },
      INTERVAL,
      {},
      f.env,
    );
    f.tickAt(30 * S); await flush(); await flush();
    f.tickAt(60 * S); await flush(); await flush();
    f.tickAt(90 * S); await flush(); await flush();
    assert.equal(runs, 3);
  }

  // 화면 배선 가드
  const safetySrc = readFileSync(join(WEB, 'app', 'admin', 'safety', 'page.tsx'), 'utf8');
  assert.match(safetySrc, /usePolling\(/, '안전 경보가 숨은 탭 폴링 멈춤을 쓰지 않는다');
  assert.match(safetySrc, /keepWhileHidden: \(\) => notifEnabledRef\.current/, "'알림 받기' 가 켜져 있을 때 숨은 탭 폴링을 유지하지 않는다");
  assert.match(safetySrc, /lastQueryKeyRef/, '안전 경보 첫 진입 중복 조회 방지가 빠졌다');
  assert.doesNotMatch(safetySrc, /setInterval\(/, '안전 경보에 가시성을 무시하는 타이머가 남아 있다');
  const panelSrc = readFileSync(join(WEB, 'components', 'admin', 'AreaDemandReliabilityPanel.tsx'), 'utf8');
  assert.match(panelSrc, /usePolling\(/, '주차 수집 패널이 숨은 탭 폴링 멈춤을 쓰지 않는다');
  assert.doesNotMatch(panelSrc, /setInterval\(/, '주차 수집 패널에 가시성을 무시하는 타이머가 남아 있다');

  console.log('visibility poller tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
