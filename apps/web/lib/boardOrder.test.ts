// 대기 보드 줄 세우기 — 대기가 짧은 순. 사진은 대기가 같을 때만 앞선다(PM 결정 2026-09-28).
import assert from 'node:assert/strict';
import { compareWaitThenPhoto, type BoardOrderKey } from './boardOrder';
import type { WaitEstimate } from './waitEstimate';

const est = (minutes: number | null): WaitEstimate =>
  ({
    minutes,
    grade: null,
    estimated: minutes !== null,
    calmHour: null,
    arrivalHour: 12,
    basis: 'default',
  }) as unknown as WaitEstimate;
const key = (minutes: number | null, hasPhoto: boolean): BoardOrderKey => ({ wait: est(minutes), hasPhoto });

// --- 사진이 더 짧은 대기를 앞지르지 않는다 ------------------------------------------------------
assert.ok(compareWaitThenPhoto(key(5, false), key(10, true)) < 0);
assert.ok(compareWaitThenPhoto(key(10, true), key(5, false)) > 0);
assert.ok(compareWaitThenPhoto(key(6, false), key(7, true)) < 0, '1분 차이도 대기가 먼저');
// 분이 있는 곳은 사진이 없어도 분이 없는 곳(사진 있음)보다 앞.
assert.ok(compareWaitThenPhoto(key(40, false), key(null, true)) < 0);
assert.ok(compareWaitThenPhoto(key(null, true), key(40, false)) > 0);

// --- 대기가 같을 때만 사진 있는 곳이 앞 -------------------------------------------------------
assert.ok(compareWaitThenPhoto(key(5, true), key(5, false)) < 0);
assert.ok(compareWaitThenPhoto(key(5, false), key(5, true)) > 0);
assert.ok(compareWaitThenPhoto(key(0, true), key(0, false)) < 0);
assert.ok(compareWaitThenPhoto(key(null, true), key(null, false)) < 0, '둘 다 분이 없으면 같은 대기');

// --- 대기도 사진 여부도 같으면 0 — 원래 순서 유지 --------------------------------------------------
assert.equal(compareWaitThenPhoto(key(5, true), key(5, true)), 0);
assert.equal(compareWaitThenPhoto(key(5, false), key(5, false)), 0);
assert.equal(compareWaitThenPhoto(key(null, false), key(null, false)), 0);

// --- 무작위 목록: 정렬 뒤 성질 ------------------------------------------------------------
let seed = 42;
const rand = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 2 ** 32;
};
const rank = (m: number | null) => (m === null ? Infinity : m);
for (let trial = 0; trial < 500; trial++) {
  const n = 1 + Math.floor(rand() * 8);
  const rows = Array.from({ length: n }, (_, i) => ({
    i,
    ...key(rand() < 0.2 ? null : Math.floor(rand() * 4) * 5, rand() < 0.4),
  }));
  const sorted = rows.slice().sort(compareWaitThenPhoto);
  for (let k = 1; k < sorted.length; k++) {
    const p = sorted[k - 1];
    const q = sorted[k];
    // 1) 대기는 줄어들지 않는다(분 없음은 맨 뒤) — 사진 때문에 더 긴 대기가 앞서지 않는다.
    assert.ok(rank(p.wait.minutes) <= rank(q.wait.minutes), `trial ${trial}: 대기 역전`);
    if (rank(p.wait.minutes) === rank(q.wait.minutes)) {
      // 2) 같은 대기 안에서는 사진 있는 곳이 먼저.
      assert.ok(p.hasPhoto || !q.hasPhoto, `trial ${trial}: 같은 대기에서 사진 없는 곳이 앞`);
      // 3) 대기·사진이 같으면 입력 순서 그대로(안정).
      if (p.hasPhoto === q.hasPhoto) assert.ok(p.i < q.i, `trial ${trial}: 동점 순서가 바뀌었다`);
    }
  }
  // 대기의 줄은 대기만으로 세운 것과 같다 — 사진은 같은 대기 안에서만 자리를 바꾼다(보드에 오르는 곳도 그대로).
  const waitOnly = rows.slice().sort((a, b) => rank(a.wait.minutes) - rank(b.wait.minutes) || 0);
  assert.deepEqual(sorted.map((r) => rank(r.wait.minutes)), waitOnly.map((r) => rank(r.wait.minutes)));
  assert.deepEqual(sorted.map((r) => r.i).sort((a, b) => a - b), rows.map((r) => r.i));
}

console.log('boardOrder: ok');
