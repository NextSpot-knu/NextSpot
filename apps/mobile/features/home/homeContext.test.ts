import assert from 'node:assert/strict';

import {
  buildExcludeIds,
  cuisineIntentOf,
  homeFilterSeed,
  homeRequestContext,
  parseRejectedIds,
  relaxWalkLimit,
  serializeRejectedIds,
} from './homeContext';
import type { TravelContext } from '~/lib/core/travelContextTypes';

const empty: TravelContext = { categories: [], requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [] };

// 첫 칩 — 첫 설정의 첫 장소 유형, 없으면 음식점
assert.deepEqual(homeFilterSeed(empty), { category: 'restaurant', accessible: false, stroller: false, indoor: false });
assert.deepEqual(
  homeFilterSeed({ ...empty, categories: ['attraction', 'cafe'], requiredAttributes: ['indoor', 'stroller'] }),
  { category: 'attraction', accessible: false, stroller: true, indoor: true },
);

// 요청 조건 — 저장값(도보·여행 시간·음식·방문 제외)은 그대로, 조건은 칩 상태로, categories 는 비운다
const stored: TravelContext = {
  categories: ['cafe'],
  cuisine: '양식',
  maxWalkMinutes: 10,
  availableMinutes: 60,
  requiredAttributes: ['accessible'],
  excludeVisited: true,
  visitedFacilityIds: [],
};
const ctx = homeRequestContext(stored, { accessible: false, stroller: true, indoor: true });
assert.deepEqual(ctx.categories, []);
assert.deepEqual(ctx.requiredAttributes, ['stroller', 'indoor'], '칩에서 끈 조건은 보내지 않는다');
assert.equal(ctx.maxWalkMinutes, 10);
assert.equal(ctx.availableMinutes, 60);
assert.equal(ctx.cuisine, '양식');
assert.equal(ctx.excludeVisited, true);

// 도보 제한 넓히기 — 키를 뺀다(서버에 null 로 가지 않게), 고르지 않았으면 null
const relaxed = relaxWalkLimit(ctx);
assert.ok(relaxed);
assert.equal('maxWalkMinutes' in relaxed, false);
assert.equal(relaxed.availableMinutes, 60);
assert.equal(relaxWalkLimit(empty), null);

// 음식 의도
assert.equal(cuisineIntentOf(stored), '양식');
assert.equal(cuisineIntentOf({ ...empty, cuisine: '분식·국밥' }), '분식 국밥 김밥');
assert.equal(cuisineIntentOf(empty), null);

// 제외 id — 거절 + 저장, 중복은 한 번
assert.deepEqual(buildExcludeIds(new Set(['a', 'b']), ['b', 'c']), ['a', 'b', 'c']);
assert.deepEqual(buildExcludeIds([], []), []);

// 거절 id 세션 보관
assert.deepEqual([...parseRejectedIds(serializeRejectedIds(new Set(['x', 'y'])))], ['x', 'y']);
assert.equal(parseRejectedIds(null).size, 0);
assert.equal(parseRejectedIds('{bad').size, 0);
assert.deepEqual([...parseRejectedIds('["a", 3, null, "b"]')], ['a', 'b']);

console.log('homeContext.test OK');
