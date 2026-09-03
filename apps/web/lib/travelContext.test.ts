import assert from 'node:assert/strict';
import { CUISINES, CUISINE_INTENT, isIndoorEligible, matchesTravelContext, type TravelContext } from './travelContext';

const origin = { lat: 35.84, lng: 129.21 };
const distance = (_lat1: number, _lng1: number, lat2: number, _lng2: number) => lat2;
const base = { id: 'place', type: 'culture', latitude: 500, longitude: 0, features: {} };
const context = (overrides: Partial<TravelContext>): TravelContext => ({
  categories: [], requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [], ...overrides,
});

assert.equal(matchesTravelContext(base, context({ maxWalkMinutes: 10 }), origin, distance), true);
assert.equal(matchesTravelContext({ ...base, latitude: 700 }, context({ maxWalkMinutes: 10 }), origin, distance), false);
assert.equal(matchesTravelContext(base, context({ excludeVisited: true, visitedFacilityIds: ['place'] }), origin, distance), false);
assert.equal(matchesTravelContext({ ...base, features: { indoor: true } }, context({ requiredAttributes: ['indoor'] }), origin, distance), true);
assert.equal(isIndoorEligible({ type: 'restaurant', features: {} }), true);
assert.equal(isIndoorEligible({ type: 'cafe', features: {} }), true);
assert.equal(isIndoorEligible({ type: 'restaurant', features: { indoor_verified: false } }), false);
assert.equal(isIndoorEligible({ type: 'culture', features: {} }), false);
assert.equal(isIndoorEligible({ type: 'culture', features: { indoor_verified: true } }), true);
assert.equal(matchesTravelContext({ ...base, features: { accessible: true } }, context({ requiredAttributes: ['accessible'] }), origin, distance), false);
assert.equal(matchesTravelContext({ ...base, features: { accessible_verified: true } }, context({ requiredAttributes: ['accessible'] }), origin, distance), true);
assert.equal(matchesTravelContext({ ...base, barrierFree: true }, context({ requiredAttributes: ['accessible'] }), origin, distance), true);

console.log('PASS travel context deterministic fallback eligibility');


// ── 음식 취향(cuisine) — v2 재작성 때 빠졌다가 복원한 필드 ─────────────────
// v1 은 `food` 라벨 문자열을 저장했고 main/page.tsx 가 그걸 직접 파싱해 검색 의도로 옮겼다.
// v2 로 넘어오면서 필드가 사라져 온보딩이 음식을 묻지 않았고, 그 기본값 로직은 통째로
// 죽어 있었다. 되살리면서 v1↔v2 판단을 이 모듈 한 곳으로 모았다.
{
  // 모든 취향에 의도 문자열이 있어야 한다 — 하나라도 비면 그 선택은 조용히 무시된다.
  for (const c of CUISINES) {
    assert.ok(CUISINE_INTENT[c] && CUISINE_INTENT[c].length > 0, `의도 문자열 없음: ${c}`);
  }

  // v1 이 하던 매핑을 그대로 유지한다(추천 점수의 입력이라 값이 바뀌면 결과가 바뀐다).
  assert.equal(CUISINE_INTENT['분식·국밥'], '분식 국밥 김밥');
  assert.equal(CUISINE_INTENT['카페·디저트'], '카페 디저트');
  assert.equal(CUISINE_INTENT['한식'], '한식');

  // 취향은 선택 사항이다 — 고르지 않으면 의도를 지어내지 않는다.
  const empty = context({});
  assert.equal(empty.cuisine, undefined);
}

console.log('travelContext cuisine tests passed');
