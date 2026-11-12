import assert from 'node:assert/strict';

import {
  CUISINE_LABEL_KEY,
  CUISINES,
  EMPTY_TRAVEL_CONTEXT,
  ONBOARDING_DONE_KEY,
  TRAVEL_CONTEXT_KEY,
  contextAppliedProps,
  saveTravelContextTo,
  toggleIn,
} from './setupPrefs';

// 웹과 같은 키·형식
assert.equal(TRAVEL_CONTEXT_KEY, 'nextspot_setup_prefs');
assert.equal(ONBOARDING_DONE_KEY, 'nextspot_onboarding_done');
assert.deepEqual(EMPTY_TRAVEL_CONTEXT, { categories: [], requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [] });
assert.ok(!('maxWalkMinutes' in EMPTY_TRAVEL_CONTEXT), '건너뛰기가 도보 제한을 지어내지 않는다');
assert.deepEqual(Object.keys(CUISINE_LABEL_KEY).sort(), [...CUISINES].sort());

const m = new Map<string, string>();
const store = { setItem: (k: string, v: string) => void m.set(k, v) };
saveTravelContextTo(store, {
  categories: ['cafe'],
  cuisine: '한식',
  maxWalkMinutes: 10,
  requiredAttributes: ['stroller'],
  excludeVisited: true,
  visitedFacilityIds: ['should-not-be-saved'],
});
assert.deepEqual(JSON.parse(m.get(TRAVEL_CONTEXT_KEY) as string), {
  categories: ['cafe'],
  cuisine: '한식',
  maxWalkMinutes: 10,
  requiredAttributes: ['stroller'],
  excludeVisited: true,
  visitedFacilityIds: [],
  version: 2,
});
assert.equal(m.get(ONBOARDING_DONE_KEY), '1');
// 저장소 없음·던짐에도 조용히
saveTravelContextTo(null, EMPTY_TRAVEL_CONTEXT);
saveTravelContextTo(
  {
    setItem: () => {
      throw new Error('full');
    },
  },
  EMPTY_TRAVEL_CONTEXT,
);

assert.deepEqual(toggleIn(['a', 'b'], 'a'), ['b']);
assert.deepEqual(toggleIn(['a'], 'b'), ['a', 'b']);
assert.deepEqual(contextAppliedProps(EMPTY_TRAVEL_CONTEXT), {
  categories: [],
  max_walk_minutes: null,
  available_minutes: null,
  required_attributes: [],
  exclude_visited: false,
});

console.log('setupPrefs.test OK');
