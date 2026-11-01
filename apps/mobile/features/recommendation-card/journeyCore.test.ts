import assert from 'node:assert/strict';

import { classifyReplanOutcome, replanNotice } from '@/lib/replanOutcome';

import {
  EMPTY_TRAVEL_CONTEXT,
  buildReplanContext,
  eligibilityTierRank,
  hasCondition,
  loadTravelContext,
  replanFacilityTypes,
  sortReplanCandidates,
  toggled,
} from './journeyCore';
import { completeVisit, type KeyValueStore } from './tripLoop';

function memory(): KeyValueStore {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

// 저장된 조건
const s = memory();
assert.deepEqual(loadTravelContext(s), EMPTY_TRAVEL_CONTEXT);
s.setItem('nextspot_setup_prefs', '{oops');
assert.deepEqual(loadTravelContext(s), EMPTY_TRAVEL_CONTEXT);
completeVisit({ facilityId: 'seen', name: 'n', type: 'cafe' }, 1, s);
s.setItem('nextspot_setup_prefs', JSON.stringify({ version: 2, categories: ['cafe'], requiredAttributes: [], excludeVisited: true, maxWalkMinutes: 10 }));
const ctx = loadTravelContext(s);
assert.deepEqual(ctx.categories, ['cafe']);
assert.deepEqual(ctx.visitedFacilityIds, ['seen']);
assert.equal(ctx.maxWalkMinutes, 10);

// 조건 판정
assert.equal(hasCondition(null), false);
assert.equal(hasCondition({}), false);
assert.equal(hasCondition({ categories: ['cafe'] }), true);
assert.equal(hasCondition({ excludeVisited: true }), true);

// 칩 토글
assert.deepEqual(toggled(['a'], 'b'), ['a', 'b']);
assert.deepEqual(toggled(['a', 'b'], 'a'), ['b']);
assert.deepEqual(toggled(undefined, 'a'), ['a']);

// 재계획 조건 — 확정이 덮고, 방문 제외는 이력으로
const base = { ...EMPTY_TRAVEL_CONTEXT, categories: ['restaurant' as const], excludeVisited: false };
assert.deepEqual(buildReplanContext(base, { categories: ['cafe'], maxWalkMinutes: 5 }, ['x']).categories, ['cafe']);
assert.deepEqual(buildReplanContext(base, undefined, ['x']).visitedFacilityIds, []);
assert.deepEqual(buildReplanContext(base, { excludeVisited: true }, ['x', 'x', 'y']).visitedFacilityIds, ['x', 'y']);
assert.deepEqual(replanFacilityTypes(base, 'cafe'), ['restaurant']);
assert.deepEqual(replanFacilityTypes(EMPTY_TRAVEL_CONTEXT, 'cafe'), ['cafe']);

// 후보 정렬 — 영업 근거 등급 > 점수 > 거리 > id
assert.equal(eligibilityTierRank({}), 0);
assert.equal(eligibilityTierRank({ informationConfidence: 'unknown' }), 2);
assert.equal(eligibilityTierRank({ eligibilityTier: 'hours_and_route_confirmation_required' }), 3);
const sorted = sortReplanCandidates([
  { facility: { id: 'a' }, spotScore: 90, eligibilityTier: 'hours_confirmation_required_route' },
  { facility: { id: 'b' }, spotScore: 60, eligibilityTier: 'verified_open_route' },
  { facility: { id: 'c' }, spotScore: 60, eligibilityTier: 'verified_open_route', distanceM: 10 },
  { facility: { id: 'd' }, spotScore: 80, eligibilityTier: 'verified_open_route' },
]);
assert.deepEqual(sorted.map((x) => x.facility.id), ['d', 'b', 'c', 'a']);

// 재계획 결말 — 시간 초과·0건·장애는 서로 다른 말(웹 replanOutcome)
assert.equal(classifyReplanOutcome({ timedOut: true, candidateCount: 3 }), 'timeout');
assert.equal(classifyReplanOutcome({ timedOut: false, candidateCount: 0 }), 'empty');
assert.equal(replanNotice('empty')?.retryable, false);
assert.equal(replanNotice('failed')?.retryable, true);
assert.equal(replanNotice('replaced'), null);

console.log('journeyCore.test OK');
