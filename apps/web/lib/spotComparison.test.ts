import assert from 'node:assert/strict';

import { buildSpotComparisons, formatSpotComparison } from './spotComparison';
import { rankFacilitiesDegraded } from './recommender';

const t = (key: string, vars?: Record<string, string | number>) =>
  `${key}:${Object.entries(vars ?? {}).map(([name, value]) => `${name}=${value}`).join(',')}`;

const comparisons = buildSpotComparisons([
  { id: 'a', rank: 1, spotScore: 0.82, preference: 0.8, travelMinutes: 8, incentive: 0.2 },
  { id: 'b', rank: 2, spotScore: 0.78, preference: 0.68, travelMinutes: 5, incentive: 0.2 },
  { id: 'c', rank: 3, spotScore: 0.75, preference: 0.86, travelMinutes: 12, incentive: 0.1 },
]);

assert.deepEqual(comparisons.map((item) => item.id), ['a', 'b', 'c']);
assert.equal(comparisons[0].scorePoints, 82);
assert.equal(comparisons[1].preferenceDeltaPoints, -12);
assert.equal(comparisons[1].rankingTimeDeltaMinutes, -3);
assert.equal(comparisons[1].scoreGapPoints, 4);
assert.match(formatSpotComparison(t, comparisons[1]), /preferenceLower/);
assert.match(formatSpotComparison(t, comparisons[1]), /timeShorter/);
assert.match(formatSpotComparison(t, comparisons[1]), /scoreLower/);
assert.match(formatSpotComparison(t, comparisons[2]), /preferenceHigher/);

const withHiddenRankingCosts = buildSpotComparisons([
  { id: 'a', rank: 1, spotScore: 80, preference: 0.7, travelMinutes: 5, rankingWaitMinutes: 4, areaDemandPenaltyMinutes: 2 },
]);
assert.equal(withHiddenRankingCosts[0].rankingTimeMinutes, 11);

// degraded_rules의 쿠폰 항은 전체 인센티브가 아니라 내부 쿠폰 몫 50%다.
// 20% 쿠폰(쿠폰강도 1)은 최종 SPOT에 0.2 * 0.5 = 10점만 더해야 서버와 같다.
const degraded = rankFacilitiesDegraded([
  { name: '쿠폰 있음', type: 'cafe', latitude: 35.8361, longitude: 129.2105, couponRate: 0.2 },
  { name: '쿠폰 없음', type: 'cafe', latitude: 35.8361, longitude: 129.2105, couponRate: 0 },
], {
  userLocation: { lat: 35.8361, lng: 129.2105 },
  preferredCategories: ['cafe'],
});
assert.equal(degraded[0].spot.score - degraded[1].spot.score, 10);

console.log('SPOT comparison tests passed');
