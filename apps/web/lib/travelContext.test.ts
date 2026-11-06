import assert from 'node:assert/strict';
import { CUISINES, CUISINE_INTENT, EMPTY_TRAVEL_CONTEXT, chipCandidates, chipRankingContext, isIndoorEligible, isStrollerFriendly, matchesTravelContext, relaxWalkLimit, widenTimeBudget, type TravelContext } from './travelContext';

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

// 비 오는 날 '실내만' — 실내 분류(cat3)의 문화시설은 실내다(서버 INDOOR_CULTURE_CAT3 와 같은 목록). 야외일 수 있는 분류는 아니다.
assert.equal(isIndoorEligible({ type: 'culture', features: { cat3: 'A02060100' } }), true, '박물관');
assert.equal(isIndoorEligible({ type: 'culture', features: { cat3: 'A02060300' } }), true, '전시관');
assert.equal(isIndoorEligible({ type: 'culture', features: { cat3: 'A02061200' } }), true, '영화관');
assert.equal(isIndoorEligible({ type: 'culture', features: { cat3: 'A02060600' } }), false, '공연장은 야외일 수 있다');
assert.equal(isIndoorEligible({ type: 'culture', features: { cat3: 'A02061100' } }), false, '문화전수시설은 마당이 딸린 곳이 많다');
assert.equal(isIndoorEligible({ type: 'culture', features: { cat3: 'A02060100', indoor: false } }), false, '명시적 실외가 이긴다');
assert.equal(isIndoorEligible({ type: 'attraction', features: { cat3: 'A02060100' } }), false, '분류 코드는 문화시설에만 쓴다');
assert.equal(matchesTravelContext({ ...base, features: { cat3: 'A02060100' } }, context({ requiredAttributes: ['indoor'] }), origin, distance), true);

// 유모차는 휠체어와 따로 본다(P1-6) — '유모차 대여' 원문이 분명히 '가능' 일 때만. 휠체어 확인만으로는 아니다.
const stroller = context({ requiredAttributes: ['stroller'] });
assert.equal(isStrollerFriendly({ features: { chk_babycarriage: '가능' } }), true);
assert.equal(isStrollerFriendly({ features: { chkBabycarriage: '대여 가능(무료)' } }), true, 'apiClient 를 거친 camelCase 키');
assert.equal(isStrollerFriendly({ features: { chk_babycarriage: '불가' } }), false);
assert.equal(isStrollerFriendly({ features: { chk_babycarriage: '없음' } }), false);
assert.equal(isStrollerFriendly({ features: { chk_babycarriage: '' } }), false, '빈 값은 모른다');
assert.equal(isStrollerFriendly({ features: {} }), false);
assert.equal(isStrollerFriendly({ features: { stroller: true } }), true, '밤 적재·사람이 적은 칸이 먼저');
assert.equal(isStrollerFriendly({ features: { stroller: false, chk_babycarriage: '가능' } }), false, '사람이 고친 값이 원문을 이긴다');
assert.equal(matchesTravelContext({ ...base, features: { chk_babycarriage: '가능' } }, stroller, origin, distance), true);
assert.equal(matchesTravelContext({ ...base, barrierFree: true }, stroller, origin, distance), false, '휠체어 확인이 유모차를 대신하지 않는다');
assert.equal(matchesTravelContext({ ...base, features: { chk_babycarriage: '가능' } }, context({ requiredAttributes: ['accessible'] }), origin, distance), false, '유모차 대여가 휠체어를 대신하지 않는다');

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

// --- 칩 안에서는 온보딩 카테고리가 다른 칩을 막지 않는다 · 도보 제한은 한 번만 넓힌다 ----------------
// 온보딩에서 음식점+카페를 고른 사람이 관광지 칩을 누르면, 칩이 이미 유형을 정했다. 그때 저장된
// categories 를 그대로 걸면 관광지는 늘 0곳이 되고 '추천할 곳이 없어요' 가 지도 위 관광지 핀 옆에 뜬다.
{
  const onboarding = context({ categories: ['restaurant', 'cafe'] });
  const attraction = { ...base, type: 'attraction' };
  assert.equal(matchesTravelContext(attraction, onboarding, origin, distance), false, '전제: 저장된 조건 그대로면 막힌다');
  assert.deepEqual(chipRankingContext(onboarding).categories, []);
  assert.equal(matchesTravelContext(attraction, chipRankingContext(onboarding), origin, distance), true);
  // 다른 조건은 그대로 남는다 — 칩은 유형만 정한다.
  const withAttrs = context({ categories: ['cafe'], requiredAttributes: ['accessible'], maxWalkMinutes: 10 });
  assert.deepEqual(chipRankingContext(withAttrs).requiredAttributes, ['accessible']);
  assert.equal(chipRankingContext(withAttrs).maxWalkMinutes, 10);

  // 도보 제한을 고르지 않았으면 넓힐 것이 없다(서버·클라 모두 이미 기본 20분).
  assert.equal(relaxWalkLimit(context({})), null);
  const relaxed = relaxWalkLimit(context({ maxWalkMinutes: 10 }));
  assert.ok(relaxed);
  assert.equal(relaxed.maxWalkMinutes, undefined);
  assert.equal('maxWalkMinutes' in relaxed, false, '키가 남으면 서버에 max_walk_minutes:null 로 실려 간다');

  const matcher = (ctx: TravelContext) => (item: typeof base) => matchesTravelContext(item, ctx, origin, distance);
  // 10분(667m) 안에 아무것도 없고 700m 에 하나 — 엄격하면 0곳, 한 번 넓히면 그 한 곳.
  const far = [{ ...base, id: 'far', latitude: 700 }];
  const widened = chipCandidates(far, context({ categories: ['cafe'], maxWalkMinutes: 10 }), matcher);
  assert.deepEqual(widened.items.map((item) => item.id), ['far']);
  assert.equal(widened.context.maxWalkMinutes, undefined);
  assert.deepEqual(widened.context.categories, []);
  // 엄격한 조건으로 하나라도 있으면 넓히지 않는다.
  const near = [{ ...base, id: 'near', latitude: 500 }, ...far];
  const strict = chipCandidates(near, context({ maxWalkMinutes: 10 }), matcher);
  assert.deepEqual(strict.items.map((item) => item.id), ['near']);
  assert.equal(strict.context.maxWalkMinutes, 10);
  // 도보 제한이 없는데 비었으면 그대로 0곳 — 더 넓힐 조건이 없다.
  const none = chipCandidates([{ ...base, latitude: 5000 }], context({}), matcher);
  assert.deepEqual(none.items, []);
}

// 코스 '여행 시간 늘리기' — 30 → 60 → 120 → 제한 없음(키 자체를 뺀다), 고르지 않았으면 넓힐 것이 없다.
assert.equal(widenTimeBudget(context({ availableMinutes: 30 }))?.availableMinutes, 60);
assert.equal(widenTimeBudget(context({ availableMinutes: 60 }))?.availableMinutes, 120);
{
  const unlimited = widenTimeBudget(context({ availableMinutes: 120, maxWalkMinutes: 10 }));
  assert.ok(unlimited);
  assert.equal('availableMinutes' in unlimited, false);
  assert.equal(unlimited.maxWalkMinutes, 10);
}
assert.equal(widenTimeBudget(context({})), null);

console.log('travelContext chip ranking tests passed');
