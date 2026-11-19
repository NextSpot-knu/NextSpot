import assert from 'node:assert/strict';

import { compareSpot, cuisineMatch, evidenceTier, orderPinsBySpot, scoreFacility } from './pinOrder';

const origin = { lat: 35.8386, lng: 129.2099 };
const base = { id: 'a', name: '가', type: 'cafe', latitude: 35.8386, longitude: 129.2099, congestionLevel: 0.2, features: null };

// 근거 등급 — 실측이 무근거를 이기고, 붐비면(0.9↑) 이점이 사라진다
assert.equal(evidenceTier('measured_rules'), 0);
assert.equal(evidenceTier('degraded_rules'), 2);
assert.equal(evidenceTier('measured_rules', 0.95), 2);
assert.equal(evidenceTier(undefined), 2);

// 점수는 0~100, 같은 자리의 한산한 곳이 붐비는 곳보다 높다
const calm = scoreFacility(base, { userLocation: origin, mockHour: 9 });
const busy = scoreFacility({ ...base, congestionLevel: 0.9 }, { userLocation: origin, mockHour: 9 });
assert.ok(calm.score > busy.score && calm.score <= 100);
assert.equal(calm.scoringMode, 'measured_rules');
assert.equal(scoreFacility({ ...base, congestionLevel: null }, { userLocation: origin, mockHour: 9 }).scoringMode, 'degraded_rules');

// 음식 의도 — 음식점에만, 술집은 0.12
assert.equal(cuisineMatch(base, '한식'), null);
const food = { type: 'restaurant', name: '국밥집', features: { cuisineTags: ['국밥'] } };
assert.equal(cuisineMatch(food, '분식 국밥 김밥'), 0.95);
assert.equal(cuisineMatch({ type: 'restaurant', name: 'x', features: { cuisineTags: ['술집'] } }, '한식'), 0.12);
assert.equal(cuisineMatch(food, '아무말'), null);

// compareSpot — 점수 높은 쪽 먼저, spot 없으면 이름순
const hi = { name: '가', spot: calm };
const lo = { name: '나', spot: busy };
assert.ok(compareSpot(hi, lo) < 0 && compareSpot(lo, hi) > 0);
assert.ok(compareSpot({ name: '가' }, { name: '나' }) < 0);

// 핀 순서 — 순위 먼저, 같은 순위 안에서는 SPOT 점수 순(거리가 아니라)
const near = { ...base, id: 'near', name: '가까움', congestionLevel: 0.9 };
const far = { ...base, id: 'far', name: '멂', latitude: 35.8416, longitude: 129.2139, congestionLevel: 0.1 };
const ranked = { ...base, id: 'ranked', name: '순위', latitude: 35.85, longitude: 129.22, congestionLevel: 0.9 };
const out = orderPinsBySpot([near, far, ranked], new Map([['ranked', 1]]), { userLocation: origin, mockHour: 9 });
assert.deepEqual(out.map((f) => f.id), ['ranked', 'far', 'near']);

console.log('pinOrder ok');
