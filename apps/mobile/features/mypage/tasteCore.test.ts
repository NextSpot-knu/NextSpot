import assert from 'node:assert/strict';

import {
  UNIFORM_VECTOR,
  radarNiceMax,
  categoriesFromStored,
  onboardingVector,
  polygonPoints,
  radarPoint,
  radarPolygon,
  radarValues,
  tasteBadge,
  topDimensions,
} from './tasteCore';

const norm = (v: readonly number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

assert.ok(Math.abs(norm(UNIFORM_VECTOR) - 1) < 1e-9);
assert.equal(onboardingVector([]), null);
assert.equal(onboardingVector(['bogus']), null);
const v = onboardingVector(['restaurant', 'cafe'])!;
assert.ok(Math.abs(norm(v) - 1) < 1e-9, 'L2 정규화');
assert.ok(v[0] > 0 && v[1] > 0 && v[2] === 0);

assert.deepEqual(categoriesFromStored(null), []);
assert.deepEqual(categoriesFromStored('{bad'), []);
assert.deepEqual(categoriesFromStored(JSON.stringify({ version: 2, categories: ['cafe', 3] })), ['cafe']);
assert.deepEqual(categoriesFromStored(JSON.stringify({ category: '카페' })), ['cafe'], 'v1');
assert.deepEqual(categoriesFromStored(JSON.stringify({ category: '??' })), []);

const base = { uniform: UNIFORM_VECTOR, onboarding: v };
assert.equal(tasteBadge('default', v, base, true), null);
assert.equal(tasteBadge('onboarding', v, base, false), 'onboarding');
assert.equal(tasteBadge('learned', [1, 0, 0, 0, 0, 0, 0, 0], base, false), 'onboarding', '피드백 없으면 학습이라 하지 않음');
assert.equal(tasteBadge('learned', [1, 0, 0, 0, 0, 0, 0, 0], { uniform: UNIFORM_VECTOR, onboarding: null }, false), null);
assert.equal(tasteBadge('learned', v, base, true), 'onboarding', '온보딩과 같으면 아직 배우지 않음');
assert.equal(tasteBadge('learned', [1, 0, 0, 0, 0, 0, 0, 0], base, true), 'learned');

assert.deepEqual(topDimensions([0.1, 0.9, 0.5, 0, 0, 0, 0, 0]), [1, 2]);
assert.deepEqual(radarValues([2, -1, 0.5]).slice(0, 4), [100, 0, 50, 0]);
assert.equal(radarValues([]).length, 8);

const top = radarPoint(0, 8, 1, 100, 100, 50);
assert.ok(Math.abs(top.x - 100) < 1e-9 && Math.abs(top.y - 50) < 1e-9, '첫 축은 12시');
const right = radarPoint(2, 8, 1, 100, 100, 50);
assert.ok(Math.abs(right.x - 150) < 1e-9 && Math.abs(right.y - 100) < 1e-9, '셋째 축은 3시');
assert.equal(radarPolygon(new Array(8).fill(100), 0, 0, 10).length, 8);
assert.equal(polygonPoints([{ x: 1, y: 2 }, { x: 3, y: 4.123 }]), '1.00,2.00 3.00,4.12');
console.log('tasteCore ok');

// 레이더 눈금(G5b-14) — recharts 암묵 축과 같은 값(R3 가 1~100 대조): 균등 35 → 36, 학습 최댓값 90 → 100.
{
  assert.equal(radarNiceMax(35), 36);
  assert.equal(radarNiceMax(90), 100);
  assert.equal(radarNiceMax(100), 100);
  assert.equal(radarNiceMax(0), 1);
  for (let v = 1; v <= 100; v++) {
    const m = radarNiceMax(v);
    assert.ok(m >= v && m % 4 === 0 || m === 1, `v=${v} → ${m}`);
  }
}
