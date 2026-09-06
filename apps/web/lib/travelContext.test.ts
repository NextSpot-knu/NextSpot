import assert from 'node:assert/strict';
import { CUISINES, CUISINE_INTENT, EMPTY_TRAVEL_CONTEXT, isIndoorEligible, matchesTravelContext, type TravelContext } from './travelContext';

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

// --- 아무것도 고르지 않은 상태는 조건을 만들어내지 않는다 -----------------------
// 온보딩 '건너뛰기' 는 이 객체를 그대로 저장하고, 백엔드는 max_walk_minutes 가 오면
// '명시적 도보 제한 = 엄격한 자격 규칙' 으로 보고 후보 부족 시의 가까운 순 폴백을 끈다.
// 즉 여기에 값이 하나 들어 있으면, 아무것도 대지 않은 사용자가 대답한 것으로 취급된다.
{
  assert.equal(
    EMPTY_TRAVEL_CONTEXT.maxWalkMinutes,
    undefined,
    '고르지 않은 도보 제한이 사용자 선택으로 기록된다',
  );
  assert.equal(EMPTY_TRAVEL_CONTEXT.availableMinutes, undefined);
  assert.deepEqual(EMPTY_TRAVEL_CONTEXT.categories, []);
  assert.deepEqual(EMPTY_TRAVEL_CONTEXT.requiredAttributes, []);
  assert.equal(EMPTY_TRAVEL_CONTEXT.excludeVisited, false);

  // 비었다고 화면 필터가 느슨해지지는 않는다 — matchesTravelContext 는 20분을 기본으로 읽는다.
  // (latitude 를 거리로 쓰는 위 스텁 기준: 20분 = 1333m 이므로 500 은 통과, 1500 은 탈락)
  assert.equal(matchesTravelContext(base, EMPTY_TRAVEL_CONTEXT, origin, distance), true);
  assert.equal(
    matchesTravelContext({ ...base, latitude: 1500 }, EMPTY_TRAVEL_CONTEXT, origin, distance),
    false,
    '기본 반경이 사라지면 안 된다 — 비운 것은 저장되는 선호이지 화면 필터가 아니다',
  );
}

console.log('travelContext empty-context tests passed');
