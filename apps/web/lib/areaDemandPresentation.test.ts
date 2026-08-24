import { strict as assert } from 'node:assert';
import { areaDemandDisclosure } from './areaDemandPresentation';

const parking = { level: 0.7, mode: 'live' as const, radiusM: 2_000 };
const tourism = {
  referenceName: '대릉원',
  distanceM: 450,
  forecastDate: '2026-08-24',
  relativeIndex: 62,
};

assert.deepEqual(areaDemandDisclosure(parking, tourism), {
  evidenceCount: 2,
  showQualitativeLevel: false,
});
assert.deepEqual(areaDemandDisclosure(null, tourism), {
  evidenceCount: 1,
  showQualitativeLevel: false,
});
assert.deepEqual(areaDemandDisclosure(parking, null), {
  evidenceCount: 1,
  showQualitativeLevel: true,
});

console.log('area-demand presentation tests passed');
