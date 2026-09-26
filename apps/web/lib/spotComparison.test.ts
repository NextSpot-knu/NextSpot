import assert from 'node:assert/strict';

import { buildSpotComparisons, formatSpotComparison } from './spotComparison';
import { rankFacilitiesDegraded, recToSpot } from './recommender';
import { AREA_DEMAND_MESSAGES } from './i18n/area-demand-messages';
import type { RecommendationResponse } from './api-client';

const t = (key: string, vars?: Record<string, string | number>) =>
  `${key}:${Object.entries(vars ?? {}).map(([name, value]) => `${name}=${value}`).join(',')}`;

const comparisons = buildSpotComparisons([
  { id: 'a', rank: 1, preference: 0.8, travelMinutes: 7.2, scoringMode: 'model', rankingWaitMinutes: 6, areaDemandPenaltyMinutes: 0 },
  { id: 'b', rank: 2, preference: 0.68, travelMinutes: 4.1, scoringMode: 'model', rankingWaitMinutes: 3, areaDemandPenaltyMinutes: 1 },
  { id: 'c', rank: 3, preference: 0.86, travelMinutes: 12, scoringMode: 'measured_rules', rankingWaitMinutes: 6.5, areaDemandPenaltyMinutes: 0, couponRate: 0.1 },
]);

assert.deepEqual(comparisons.map((item) => item.id), ['a', 'b', 'c']);
// 도보 분은 카드의 '도보 N분' 과 같은 규칙(1분 이상 올림)이어야 한다 — 7.2분 → 8분.
assert.equal(comparisons[0].walkMinutes, 8);
assert.equal(comparisons[1].walkMinutes, 5);
assert.equal(comparisons[1].walkDeltaMinutes, -3);
assert.equal(comparisons[1].preferenceDeltaPoints, -12);
// 그 장소의 줄·붐빔 전망(대기)끼리만 비교한다 — model 의 주차 가중(1분)은 섞지 않는다.
assert.equal(comparisons[1].crowdEvidence, 'venue');
assert.equal(comparisons[1].crowdCostDeltaMinutes, -3);
// 실측(measured_rules)과 예측(model)은 둘 다 그 장소 자체의 도착시점 혼잡이라 같은 종류로 비교한다.
assert.equal(comparisons[2].crowdCostDeltaMinutes, 0.5);

// 1위: 취향 일치 · 도보 분만. 쿠폰이 없으면 쿠폰을 말하지 않는다.
const firstLine = formatSpotComparison(t, comparisons[0]);
assert.match(firstLine, /spotComparison.taste:n=80/);
assert.match(firstLine, /spotComparison.walk:n=8/);
assert.doesNotMatch(firstLine, /coupon/);

// 2위: 1위 대비 체감 차이 — 장점(가까움·덜 붐빔) 먼저, 단점(취향 일치 낮음)은 그대로.
const second = formatSpotComparison(t, comparisons[1]);
assert.match(second, /^recommend.spotComparison.vsTop:details=/);
assert.match(second, /spotComparison.calmer:/);
assert.doesNotMatch(second, /calmerNearby/);
assert.ok(second.indexOf('walkShorter:n=3') < second.indexOf('calmer'), second);
assert.ok(second.indexOf('calmer') < second.indexOf('preferenceLower:n=12'), second);

// 3위: 줄·붐빔 차이 0.5분은 체감 차이로 말하지 않는다. 1위에 없는 실제 쿠폰은 1위 대비 장점이다.
const third = formatSpotComparison(t, comparisons[2]);
assert.doesNotMatch(third, /calmer|busier/);
assert.match(third, /walkLonger:n=4/);
assert.match(third, /preferenceHigher:n=6/);
assert.match(third, /^recommend.spotComparison.vsTop:details=.*coupon:n=10/);

// 차이가 하나도 없으면 비슷하다고만 말한다(점수 동률 같은 산식 용어 없이).
const same = buildSpotComparisons([
  { id: 'x', rank: 1, preference: 0.7, travelMinutes: 5 },
  { id: 'y', rank: 2, preference: 0.7, travelMinutes: 5 },
]);
assert.equal(formatSpotComparison(t, same[1]), 'recommend.spotComparison.similar:');

// ── 혼잡 근거가 없는 곳(degraded_rules)을 '덜 붐빈다' 고 하지 않는다(검증 2026-09-26 blocking) ──
// 서버는 근거 없는 후보에 ranking_wait_time=null · 주변 가중 0 을 보내고, recToSpot 은 null 을 0 으로
// 바꾼다. 숫자만 보면 늘 '대기 0분' 이라 1위(대기 6분 예측)보다 한산해 보이지만 사실이 아니다.
const rec = (spotScore: number, scoringMode: RecommendationResponse['scoringMode'], rankingWaitTime: number | null) =>
  ({
    spotScore,
    scoringMode,
    distanceM: 400,
    breakdown: { preference: 0.7, travelTime: 6, waitTime: rankingWaitTime, rankingWaitTime, areaDemandPenaltyMinutes: 0, incentive: 0 },
  }) as unknown as RecommendationResponse;
const measuredSpot = recToSpot(rec(0.7, 'model', 6));
const noEvidenceSpot = recToSpot(rec(0.75, 'degraded_rules', null));
assert.equal(noEvidenceSpot.rankingWaitTime, 0, 'recToSpot turns a missing wait into 0 — the reason for this guard');
const mixed = buildSpotComparisons([
  { id: 'm', rank: 1, preference: 0.7, travelMinutes: measuredSpot.expectedTravel, scoringMode: measuredSpot.scoringMode, rankingWaitMinutes: measuredSpot.rankingWaitTime, areaDemandPenaltyMinutes: measuredSpot.areaDemandPenaltyMinutes },
  { id: 'd', rank: 2, preference: 0.7, travelMinutes: noEvidenceSpot.expectedTravel, scoringMode: noEvidenceSpot.scoringMode, rankingWaitMinutes: noEvidenceSpot.rankingWaitTime, areaDemandPenaltyMinutes: noEvidenceSpot.areaDemandPenaltyMinutes },
]);
assert.equal(mixed[1].crowdEvidence, null);
assert.equal(mixed[1].crowdCostDeltaMinutes, null);
assert.doesNotMatch(formatSpotComparison(t, mixed[1]), /calmer|busier/);
assert.equal(formatSpotComparison(t, mixed[1]), 'recommend.spotComparison.similar:');

// 같은 종류(그 장소의 전망)끼리 1위보다 대기가 길면 단점으로 그대로 말한다.
const venueBusier = buildSpotComparisons([
  { id: 'vb1', rank: 1, preference: 0.7, travelMinutes: 5, scoringMode: 'measured_rules', rankingWaitMinutes: 2 },
  { id: 'vb2', rank: 2, preference: 0.9, travelMinutes: 5, scoringMode: 'model', rankingWaitMinutes: 7 },
]);
assert.equal(
  formatSpotComparison(t, venueBusier[1]),
  'recommend.spotComparison.vsTop:details=recommend.spotComparison.preferenceHigher:n=20 · recommend.spotComparison.busier:',
);

// 모드를 모르면(구 서버 응답) 비교하지 않는다 — 모르면 말하지 않는다.
const unknownMode = buildSpotComparisons([
  { id: 'u1', rank: 1, preference: 0.7, travelMinutes: 5, rankingWaitMinutes: 9 },
  { id: 'u2', rank: 2, preference: 0.7, travelMinutes: 5, rankingWaitMinutes: 0 },
]);
assert.equal(unknownMode[1].crowdCostDeltaMinutes, null);

// 그 장소 자체의 전망(venue)과 주변 수요(area)는 서로 다른 것을 잰다 — 섞어 비교하지 않는다.
const venueVsArea = buildSpotComparisons([
  { id: 'v', rank: 1, preference: 0.7, travelMinutes: 5, scoringMode: 'measured_rules', rankingWaitMinutes: 8 },
  { id: 'r', rank: 2, preference: 0.7, travelMinutes: 5, scoringMode: 'area_stats_rules', rankingWaitMinutes: null, areaDemandPenaltyMinutes: 1 },
]);
assert.equal(venueVsArea[1].crowdEvidence, 'area');
assert.equal(venueVsArea[1].crowdCostDeltaMinutes, null);
assert.doesNotMatch(formatSpotComparison(t, venueVsArea[1]), /calmer|busier/);

// 둘 다 주변 수요뿐이면 '주변' 이라고 말한다 — 주변 수요는 매장 앞 줄을 잰 값이 아니다.
const areaPair = buildSpotComparisons([
  { id: 'a1', rank: 1, preference: 0.7, travelMinutes: 5, scoringMode: 'area_stats_rules', areaDemandPenaltyMinutes: 6 },
  { id: 'a2', rank: 2, preference: 0.7, travelMinutes: 5, scoringMode: 'area_stats_rules', areaDemandPenaltyMinutes: 2.5 },
  { id: 'a3', rank: 3, preference: 0.7, travelMinutes: 5, scoringMode: 'area_stats_rules', areaDemandPenaltyMinutes: 9 },
]);
assert.equal(areaPair[1].crowdCostDeltaMinutes, -3.5);
assert.equal(formatSpotComparison(t, areaPair[1]), 'recommend.spotComparison.vsTop:details=recommend.spotComparison.calmerNearby:');
assert.equal(formatSpotComparison(t, areaPair[2]), 'recommend.spotComparison.vsTop:details=recommend.spotComparison.busierNearby:');

// ── 쿠폰: 1위보다 클 때만 '베스트 추천 대비' 장점이다(검증 2026-09-26 minor) ──
const coupons = buildSpotComparisons([
  { id: 'k1', rank: 1, preference: 0.7, travelMinutes: 5, couponRate: 0.1 },
  { id: 'k2', rank: 2, preference: 0.7, travelMinutes: 3, couponRate: 0.1 },
  { id: 'k3', rank: 3, preference: 0.7, travelMinutes: 5, couponRate: 0.05 },
]);
// 같은 쿠폰: 이 장소의 사실로 **앞에** 적고, '베스트 추천 대비' 목록에는 넣지 않는다.
const sameCoupon = formatSpotComparison(t, coupons[1]);
assert.equal(
  sameCoupon,
  'recommend.spotComparison.coupon:n=10 · recommend.spotComparison.vsTop:details=recommend.spotComparison.walkShorter:n=2',
);
// 1위보다 작은 쿠폰: 사실로 앞에 적고, '베스트 추천 대비' 에는 단점(할인 혜택 적음)으로 적는다.
const smallerCoupon = formatSpotComparison(t, coupons[2]);
assert.equal(
  smallerCoupon,
  'recommend.spotComparison.coupon:n=5 · recommend.spotComparison.vsTop:details=recommend.spotComparison.couponLower:',
);
// 쿠폰이 없는데 1위에는 있으면 '비슷해요' 라고 하지 않는다.
const noCoupon = buildSpotComparisons([
  { id: 'n1', rank: 1, preference: 0.7, travelMinutes: 5, couponRate: 0.2 },
  { id: 'n2', rank: 2, preference: 0.7, travelMinutes: 5, couponRate: 0 },
]);
assert.equal(
  formatSpotComparison(t, noCoupon[1]),
  'recommend.spotComparison.vsTop:details=recommend.spotComparison.couponLower:',
);

// 내부 산식 용어가 한 줄에도 새지 않는다 — 어떤 키도 점수·가중·시간비용을 부르지 않는다.
const allLines = [firstLine, second, third, sameCoupon, smallerCoupon,
  ...areaPair.map((c) => formatSpotComparison(t, c)), ...mixed.map((c) => formatSpotComparison(t, c))];
for (const line of allLines) {
  assert.doesNotMatch(line, /score|incentive|rankingTime|timeShorter|timeLonger|scoreTied|scoreLower/);
}

// 이 모듈이 부르는 키는 4로케일 사전에 모두 있어야 한다(삼항으로 고르는 키는 check-i18n-keys 가 못 본다).
const usedKeys = new Set<string>();
const recordingT = (key: string) => { usedKeys.add(key); return key; };
for (const set of [comparisons, mixed, venueBusier, venueVsArea, areaPair, coupons, noCoupon, same]) {
  for (const comparison of set) formatSpotComparison(recordingT, comparison);
}
for (const key of ['calmer', 'busier', 'calmerNearby', 'busierNearby', 'couponLower', 'coupon', 'similar', 'vsTop']) {
  assert.ok(usedKeys.has(`recommend.spotComparison.${key}`), `test should exercise ${key}`);
}
for (const locale of ['ko', 'en', 'ja', 'zh'] as const) {
  for (const key of usedKeys) {
    assert.ok(AREA_DEMAND_MESSAGES[locale][key], `${locale} is missing ${key}`);
  }
}

// 주변 수요 가중(분 환산)은 도보 분에 섞이지 않는다 — 실제로 걷는 시간이 아니다.
const withAreaPenalty = buildSpotComparisons([
  { id: 'a', rank: 1, preference: 0.7, travelMinutes: 5, scoringMode: 'area_stats_rules', rankingWaitMinutes: null, areaDemandPenaltyMinutes: 2 },
]);
assert.equal(withAreaPenalty[0].walkMinutes, 5);
assert.equal(withAreaPenalty[0].crowdCostMinutes, 2);

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
