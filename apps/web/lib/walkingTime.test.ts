import assert from 'node:assert/strict';
import { displayWalkingMinutes, estimateWalkingMinutes } from './recommender';

assert.ok(Math.abs(estimateWalkingMinutes(1_000) - (1_000 * 1.18 / 66.67)) < 0.001);
assert.equal(displayWalkingMinutes(undefined, 100), 2);
assert.equal(displayWalkingMinutes(3), 3);
assert.equal(displayWalkingMinutes(3.01), 4);
assert.equal(displayWalkingMinutes(Number.NaN, 0), 1);

console.log('walking time tests passed');
