// 대기 보드 줄 세우기 — 대기가 짧은 순. 사진은 카드가 같은 대기를 보여 줄 때만 앞선다(PM 결정 2026-09-28).
import assert from 'node:assert/strict';
import {
  orderByWaitThenPhoto,
  waitHeadlineKey,
  waitHeadlineOf,
  type BoardOrderKey,
  type WaitHeadlineEvidence,
} from './boardOrder';
import type { WaitEstimate } from './waitEstimate';

type Basis = WaitEstimate['basis'];
const est = (minutes: number | null, basis: Basis = minutes === null ? 'default' : 'baseline'): WaitEstimate =>
  ({
    minutes,
    grade: null,
    estimated: minutes !== null,
    calmHour: null,
    arrivalHour: 12,
    basis,
  }) as unknown as WaitEstimate;

interface Row {
  id: string;
  wait: WaitEstimate;
  ev: WaitHeadlineEvidence;
  hasPhoto: boolean;
}
const row = (id: string, wait: WaitEstimate, hasPhoto: boolean, ev: WaitHeadlineEvidence = {}): Row => ({
  id,
  wait,
  ev,
  hasPhoto,
});
const keyOf = (r: Row): BoardOrderKey => ({
  wait: r.wait,
  headlineKey: waitHeadlineKey(waitHeadlineOf(r.wait, r.ev)),
  hasPhoto: r.hasPhoto,
});
const order = (rows: Row[]) => orderByWaitThenPhoto(rows, keyOf).map((r) => r.id);

// --- 카드 한 줄이 말하는 것 -----------------------------------------------------------------
assert.deepEqual(waitHeadlineOf(est(12), {}), { kind: 'minutes', n: 12 });
assert.deepEqual(waitHeadlineOf(est(0, 'server'), {}), { kind: 'noWait' });
assert.deepEqual(waitHeadlineOf(est(0, 'baseline'), {}), { kind: 'relaxed' });
assert.deepEqual(waitHeadlineOf(est(null, 'estimate'), { estimateLevel: 0.1 }), { kind: 'estimate', level: 'quiet' });
assert.deepEqual(waitHeadlineOf(est(null, 'estimate'), { estimateLevel: 0.9 }), { kind: 'estimate', level: 'busy' });
assert.deepEqual(waitHeadlineOf(est(null, 'estimate'), {}), { kind: 'unavailable' }, '추정 근거인데 값이 없으면 수집 중');
assert.deepEqual(waitHeadlineOf(est(null, 'area'), { areaDemandLevel: 0.6 }), { kind: 'area', level: 'moderate' });
assert.deepEqual(waitHeadlineOf(est(null, 'tourism'), { tourismRelativeIndex: 41.6 }), { kind: 'tourism', n: 42 });
assert.deepEqual(waitHeadlineOf(est(null, 'default'), {}), { kind: 'unavailable' });
assert.notEqual(
  waitHeadlineKey({ kind: 'estimate', level: 'quiet' }),
  waitHeadlineKey({ kind: 'area', level: 'quiet' }),
  '같은 등급이라도 근거가 다르면 화면 문구가 다르다',
);

// --- 사진이 더 짧은 대기를 앞지르지 않는다 ------------------------------------------------------
assert.deepEqual(order([row('a', est(5), false), row('b', est(10), true)]), ['a', 'b']);
assert.deepEqual(order([row('b', est(10), true), row('a', est(5), false)]), ['a', 'b']);
assert.deepEqual(order([row('a', est(6), false), row('b', est(7), true)]), ['a', 'b'], '1분 차이도 대기가 먼저');
// 분이 있는 곳은 사진이 없어도 분이 없는 곳(사진 있음)보다 앞.
assert.deepEqual(order([row('b', est(null), true), row('a', est(40), false)]), ['a', 'b']);

// --- 같은 분일 때만 사진 있는 곳이 앞 ----------------------------------------------------------
assert.deepEqual(order([row('a', est(5), false), row('b', est(5), true)]), ['b', 'a']);
assert.deepEqual(order([row('a', est(0), false), row('b', est(0), true)]), ['b', 'a']);
// 같은 0분이라도 '대기 없음'(검증) 과 '여유'(추정) 는 다른 말 — 사진이 가르지 않는다.
assert.deepEqual(order([row('a', est(0, 'server'), false), row('b', est(0, 'baseline'), true)]), ['a', 'b']);

// --- 분이 없는 곳: 같은 말일 때만 사진 우선 (리뷰 지적 2026-09-29) --------------------------------
const quiet = { estimateLevel: 0.1 };
const busy = { estimateLevel: 0.9 };
// 사진 없는 '여유' 가 사진 있는 '혼잡' 보다 먼저 왔다 — 그대로 둔다.
assert.deepEqual(order([row('A', est(null, 'estimate'), false, quiet), row('B', est(null, 'estimate'), true, busy)]), [
  'A',
  'B',
]);
// 프로덕션 모양(모든 카드 분 없음): 여유·여유·혼잡(사진)·수집 중(사진) — 원래 순서 그대로.
assert.deepEqual(
  order([
    row('A', est(null, 'estimate'), false, quiet),
    row('B', est(null, 'estimate'), false, quiet),
    row('C', est(null, 'estimate'), true, busy),
    row('D', est(null, 'default'), true),
  ]),
  ['A', 'B', 'C', 'D'],
);
// 같은 '여유' 끼리는 사진이 앞.
assert.deepEqual(order([row('A', est(null, 'estimate'), false, quiet), row('B', est(null, 'estimate'), true, quiet)]), [
  'B',
  'A',
]);
// 둘 다 '수집 중' 이면 같은 말 — 사진이 앞.
assert.deepEqual(order([row('A', est(null), false), row('B', est(null), true)]), ['B', 'A']);
// 같은 말이라도 사이에 다른 말 카드가 있으면 건너뛰지 않는다(여유·혼잡·여유(사진) → 그대로).
assert.deepEqual(
  order([
    row('A', est(null, 'estimate'), false, quiet),
    row('B', est(null, 'estimate'), false, busy),
    row('C', est(null, 'estimate'), true, quiet),
  ]),
  ['A', 'B', 'C'],
);
// 관광 상대지수: 같은 반올림 값만 동점.
assert.deepEqual(
  order([row('A', est(null, 'tourism'), false, { tourismRelativeIndex: 40.2 }), row('B', est(null, 'tourism'), true, { tourismRelativeIndex: 39.8 })]),
  ['B', 'A'],
);
assert.deepEqual(
  order([row('A', est(null, 'tourism'), false, { tourismRelativeIndex: 30 }), row('B', est(null, 'tourism'), true, { tourismRelativeIndex: 70 })]),
  ['A', 'B'],
);

// --- 대기도 사진 여부도 같으면 원래 순서 ----------------------------------------------------------
assert.deepEqual(order([row('a', est(5), true), row('b', est(5), true)]), ['a', 'b']);
assert.deepEqual(order([row('a', est(null), false), row('b', est(null), false)]), ['a', 'b']);
// 입력 배열은 건드리지 않는다.
const input = [row('b', est(9), false), row('a', est(1), false)];
orderByWaitThenPhoto(input, keyOf);
assert.deepEqual(input.map((r) => r.id), ['b', 'a']);

// --- 무작위 목록: 정렬 뒤 성질 ------------------------------------------------------------
let seed = 42;
const rand = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 2 ** 32;
};
const rank = (m: number | null) => (m === null ? Infinity : m);
const BASES: Basis[] = ['estimate', 'area', 'tourism', 'default'];
for (let trial = 0; trial < 800; trial++) {
  const n = 1 + Math.floor(rand() * 8);
  const rows = Array.from({ length: n }, (_, i) => {
    const hasMinutes = rand() < 0.4;
    const w = hasMinutes ? est(Math.floor(rand() * 3) * 5, rand() < 0.3 ? 'server' : 'baseline') : est(null, BASES[Math.floor(rand() * 4)]);
    const lvl = [0.1, 0.9][Math.floor(rand() * 2)];
    return row(String(i), w, rand() < 0.4, { estimateLevel: lvl, areaDemandLevel: lvl, tourismRelativeIndex: lvl * 100 });
  });
  const sorted = orderByWaitThenPhoto(rows, keyOf);
  const waitOnly = rows.slice().sort((a, b) => rank(a.wait.minutes) - rank(b.wait.minutes));
  // 1) 분의 줄은 대기만으로 세운 것과 같다 — 사진 때문에 더 긴 대기가 앞서지 않는다. 보드에 오르는 곳도 그대로.
  assert.deepEqual(sorted.map((r) => rank(r.wait.minutes)), waitOnly.map((r) => rank(r.wait.minutes)), `trial ${trial}`);
  assert.deepEqual(sorted.map((r) => r.id).sort(), rows.map((r) => r.id).sort());
  // 2) 대기만으로 세운 줄에서 X 가 Y 보다 앞이었는데 결과에서 Y 가 앞이면: 둘은 같은 말을 하고, Y 는 사진이 있고
  //    X 는 없으며, 그 사이의 카드도 전부 같은 말이다(다른 말을 하는 카드를 건너뛰지 않는다).
  const pos = new Map(sorted.map((r, i) => [r.id, i]));
  for (let x = 0; x < waitOnly.length; x++) {
    for (let y = x + 1; y < waitOnly.length; y++) {
      const X = waitOnly[x];
      const Y = waitOnly[y];
      if (pos.get(Y.id)! < pos.get(X.id)!) {
        const hk = keyOf(X).headlineKey;
        assert.equal(keyOf(Y).headlineKey, hk, `trial ${trial}: 다른 말을 하는 카드를 앞질렀다`);
        assert.ok(Y.hasPhoto && !X.hasPhoto, `trial ${trial}: 사진 때문이 아닌 역전`);
        for (let z = x; z <= y; z++) assert.equal(keyOf(waitOnly[z]).headlineKey, hk, `trial ${trial}: 다른 말을 건너뛰었다`);
      }
    }
  }
}

console.log('boardOrder: ok');
