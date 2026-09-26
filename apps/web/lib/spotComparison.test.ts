import assert from 'node:assert/strict';

import { buildSpotComparisons, formatSpotComparison } from './spotComparison';
import { rankFacilitiesDegraded } from './recommender';

const t = (key: string, vars?: Record<string, string | number>) =>
  `${key}:${Object.entries(vars ?? {}).map(([name, value]) => `${name}=${value}`).join(',')}`;

const comparisons = buildSpotComparisons([
  { id: 'a', rank: 1, preference: 0.8, travelMinutes: 7.2, rankingWaitMinutes: 6, areaDemandPenaltyMinutes: 0 },
  { id: 'b', rank: 2, preference: 0.68, travelMinutes: 4.1, rankingWaitMinutes: 2, areaDemandPenaltyMinutes: 1 },
  { id: 'c', rank: 3, preference: 0.86, travelMinutes: 12, rankingWaitMinutes: 6.5, areaDemandPenaltyMinutes: 0, couponRate: 0.1 },
]);

assert.deepEqual(comparisons.map((item) => item.id), ['a', 'b', 'c']);
// 도보 분은 카드의 '도보 N분' 과 같은 규칙(1분 이상 올림)이어야 한다 — 7.2분 → 8분.
assert.equal(comparisons[0].walkMinutes, 8);
assert.equal(comparisons[1].walkMinutes, 5);
assert.equal(comparisons[1].walkDeltaMinutes, -3);
assert.equal(comparisons[1].preferenceDeltaPoints, -12);
assert.equal(comparisons[1].crowdCostDeltaMinutes, -3);
assert.equal(comparisons[2].crowdCostDeltaMinutes, 0.5);

// 1위: 취향 일치 · 도보 분만. 쿠폰이 없으면 쿠폰을 말하지 않는다.
const firstLine = formatSpotComparison(t, comparisons[0]);
assert.match(firstLine, /spotComparison.taste:n=80/);
assert.match(firstLine, /spotComparison.walk:n=8/);
assert.doesNotMatch(firstLine, /coupon/);

// 2위: 1위 대비 체감 차이 — 장점(가까움·덜 붐빔) 먼저, 단점(취향 일치 낮음)은 그대로.
const second = formatSpotComparison(t, comparisons[1]);
assert.match(second, /^recommend.spotComparison.vsTop:details=/);
assert.ok(second.indexOf('walkShorter:n=3') < second.indexOf('calmer'), second);
assert.ok(second.indexOf('calmer') < second.indexOf('preferenceLower:n=12'), second);

// 3위: 줄·붐빔 차이 0.5분은 체감 차이로 말하지 않는다. 실제 쿠폰은 말한다.
const third = formatSpotComparison(t, comparisons[2]);
assert.doesNotMatch(third, /calmer|busier/);
assert.match(third, /walkLonger:n=4/);
assert.match(third, /preferenceHigher:n=6/);
assert.match(third, /coupon:n=10/);

// 차이가 하나도 없으면 비슷하다고만 말한다(점수 동률 같은 산식 용어 없이).
const same = buildSpotComparisons([
  { id: 'x', rank: 1, preference: 0.7, travelMinutes: 5 },
  { id: 'y', rank: 2, preference: 0.7, travelMinutes: 5 },
]);
assert.equal(formatSpotComparison(t, same[1]), 'recommend.spotComparison.similar:');

// 내부 산식 용어가 한 줄에도 새지 않는다 — 어떤 키도 점수·가중·시간비용을 부르지 않는다.
for (const line of [firstLine, second, third]) {
  assert.doesNotMatch(line, /score|incentive|rankingTime|timeShorter|timeLonger|scoreTied|scoreLower/);
}

// 주변 수요 가중(분 환산)은 도보 분에 섞이지 않는다 — 실제로 걷는 시간이 아니다.
const withAreaPenalty = buildSpotComparisons([
  { id: 'a', rank: 1, preference: 0.7, travelMinutes: 5, rankingWaitMinutes: 4, areaDemandPenaltyMinutes: 2 },
]);
assert.equal(withAreaPenalty[0].walkMinutes, 5);
assert.equal(withAreaPenalty[0].crowdCostMinutes, 6);

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
