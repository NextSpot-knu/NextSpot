import assert from 'node:assert/strict';

import { clearPendingFlow, PENDING_FLOW_KEY, PENDING_FLOW_TTL_MS, readPendingFlow, writePendingFlow } from './pendingFlow';

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

const s = memoryStore();
const flow = { provider: 'google' as const, retry: false, next: '/', flowId: 'f-1', startedAt: 1_000_000 };
writePendingFlow(s, flow);
assert.deepEqual(readPendingFlow(s, 1_000_500), flow);
// 만료되면 null + 지운다
assert.equal(readPendingFlow(s, 1_000_000 + PENDING_FLOW_TTL_MS + 1), null);
assert.equal(s.map.has(PENDING_FLOW_KEY), false);
// 미래 시각(시계 조작)도 믿지 않는다
writePendingFlow(s, { ...flow, startedAt: 9_000_000 });
assert.equal(readPendingFlow(s, 1_000_000), null);
// 모양이 틀리면 null
s.setItem(PENDING_FLOW_KEY, JSON.stringify({ provider: 'facebook', retry: false, next: null, startedAt: 1 }));
assert.equal(readPendingFlow(s, 2), null);
s.setItem(PENDING_FLOW_KEY, '{not json');
assert.equal(readPendingFlow(s, 2), null);
// flowId 없던 기록도 읽는다(null)
s.setItem(PENDING_FLOW_KEY, JSON.stringify({ provider: 'google', retry: true, next: null, startedAt: 10 }));
assert.deepEqual(readPendingFlow(s, 20), { provider: 'google', retry: true, next: null, flowId: null, startedAt: 10 });
clearPendingFlow(s);
assert.equal(readPendingFlow(s, 20), null);
// 저장소 없음·던지는 저장소
assert.equal(readPendingFlow(null, 1), null);
const throwing = {
  getItem: (): string | null => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};
writePendingFlow(throwing, flow);
assert.equal(readPendingFlow(throwing, 1), null);

console.log('pendingFlow.test OK');
