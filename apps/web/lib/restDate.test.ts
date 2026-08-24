import assert from 'node:assert/strict';
import { getArrivalOpenDisplayStatus, getArrivalOpenStatus, isRecommendationOpen } from './restDate';

const twoAmKst = new Date('2026-08-20T17:00:00Z');
assert.equal(getArrivalOpenStatus({}, twoAmKst), 'needs_confirmation');
assert.equal(isRecommendationOpen('cafe', {}, twoAmKst), false);
assert.equal(isRecommendationOpen('restaurant', { open: '09:00~22:00' }, twoAmKst), false);
assert.equal(isRecommendationOpen('cafe', { open: '18:00~03:00' }, twoAmKst), true);

const fiveFortyKst = new Date('2026-07-20T08:40:00.000Z');
assert.equal(isRecommendationOpen('restaurant', { open: '09:00~18:00' }, fiveFortyKst), false);
assert.equal(getArrivalOpenDisplayStatus('needs_confirmation', 'cafe', twoAmKst), 'likely_closed_unknown');
assert.equal(
  getArrivalOpenDisplayStatus('needs_confirmation', 'restaurant', new Date('2026-08-20T12:59:00Z')),
  'needs_confirmation',
);
assert.equal(
  getArrivalOpenDisplayStatus('needs_confirmation', 'restaurant', new Date('2026-08-20T13:00:00Z')),
  'likely_closed_unknown',
);
assert.equal(getArrivalOpenDisplayStatus('needs_confirmation', 'attraction', twoAmKst), 'needs_confirmation');

console.log('restDate tests passed');
