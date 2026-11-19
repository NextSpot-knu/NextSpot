import assert from 'node:assert/strict';

import type { TravelContext } from '~/lib/core/travelContextTypes';

import {
  bandBottomInset,
  bestCategory,
  candidateCountsByType,
  cardConditionKeys,
  chipCandidates,
  clientWalkRelaxed,
  countPinsByType,
  FILTER_IDS,
  hasPinAttributes,
  isIndoorEligible,
  matchesTravelContext,
  nearCenter,
  onlyClosedTodayLeft,
  parseMapSession,
  pickFirstViewCategory,
  pinAttributesOf,
  removeCondition,
  stablePadding,
  suggestionModel,
  tabFromFilterId,
  withAttribute,
} from './chipModel';
import type { HomeFacility } from './homeModel';

const empty: TravelContext = { categories: [], requiredAttributes: [], excludeVisited: false, visitedFacilityIds: [] };
const origin = { lat: 35.838, lng: 129.21 };

function fac(id: string, type: string, over: Partial<HomeFacility> = {}): HomeFacility {
  return {
    id, name: id, type, latitude: origin.lat, longitude: origin.lng, capacity: null, features: null, address: null, phone: null,
    operatingHours: null, imageUrl: null, galleryImages: null, homepage: null, overview: null, barrierFree: null, contentid: null,
    contenttypeid: null, availabilityEvidence: null, congestionLevel: null, currentCount: null, lastUpdated: null, source: null,
    isStale: false, ...over,
  };
}
// 위도 0.01° ≈ 1.1km — 도보 20분(1333m) 안, 10분(667m) 밖.
const far = (id: string, type: string, over: Partial<HomeFacility> = {}) => fac(id, type, { latitude: origin.lat + 0.01, ...over });

// 실내 판정 — 서버 미러: 음식점·카페는 실내, 문화시설은 cat3 목록만, 명시 값이 이긴다
assert.equal(isIndoorEligible({ type: 'cafe' }), true);
assert.equal(isIndoorEligible({ type: 'attraction' }), false);
assert.equal(isIndoorEligible({ type: 'culture', features: { cat3: 'A02060100' } }), true);
assert.equal(isIndoorEligible({ type: 'culture', features: { cat3: 'A02060600' } }), false);
assert.equal(isIndoorEligible({ type: 'cafe', features: { indoor: false } }), false);

// 여행 조건 — 도보 상한 · 방문 제외 · 조건
assert.equal(matchesTravelContext(far('a', 'cafe'), empty, origin), true);
assert.equal(matchesTravelContext(far('a', 'cafe'), { ...empty, maxWalkMinutes: 10 }, origin), false);
assert.equal(matchesTravelContext(fac('v', 'cafe'), { ...empty, excludeVisited: true, visitedFacilityIds: ['v'] }, origin), false);
assert.equal(matchesTravelContext(fac('a', 'cafe'), { ...empty, requiredAttributes: ['accessible'] }, origin), false);
assert.equal(matchesTravelContext(fac('a', 'cafe', { barrierFree: true }), { ...empty, requiredAttributes: ['accessible'] }, origin), true);
assert.equal(matchesTravelContext(fac('a', 'cafe', { features: { stroller: true } }), { ...empty, requiredAttributes: ['stroller'] }, origin), true);

// 칩 후보 — 도보 제한으로 0곳이면 그것만 풀어 한 번 더
const strictZero = chipCandidates([far('a', 'cafe')], { ...empty, maxWalkMinutes: 10, categories: ['restaurant'] }, origin);
assert.equal(strictZero.items.length, 1);
assert.equal(strictZero.context.maxWalkMinutes, undefined);
assert.deepEqual(strictZero.context.categories, []);
assert.equal(clientWalkRelaxed([far('a', 'cafe')], 'cafe', { ...empty, maxWalkMinutes: 10 }, origin), true);
assert.equal(clientWalkRelaxed([fac('a', 'cafe'), far('b', 'cafe')], 'cafe', { ...empty, maxWalkMinutes: 10 }, origin), false);
assert.equal(clientWalkRelaxed([far('a', 'cafe')], 'cafe', empty, origin), false);

// 칩별 수 — 음식점은 술집 제외, 제외 id · 영업 확인
const pool = [
  fac('r1', 'restaurant'),
  fac('bar', 'restaurant', { features: { cuisine_tags: ['술집'] } }),
  fac('c1', 'cafe'), fac('c2', 'cafe'),
  fac('t1', 'attraction'),
];
const counts = candidateCountsByType(pool, empty, origin, { excluded: new Set(['c2']) });
assert.deepEqual(counts, { restaurant: 1, cafe: 1, attraction: 1, culture: 0 });
assert.deepEqual(bestCategory({ restaurant: 0, cafe: 2, attraction: 2, culture: 0 }), { type: 'cafe', count: 2 });
assert.equal(bestCategory({ restaurant: 0, cafe: 0, attraction: 0, culture: 0 }), null);
// 첫 화면 전환 — 지금 칩 제외, 같은 수면 앞 칩, 모두 0 이면 null
assert.equal(pickFirstViewCategory({ restaurant: 9, cafe: 2, attraction: 2 }, 'restaurant'), 'cafe');
assert.equal(pickFirstViewCategory({ restaurant: 0, cafe: 0 }, 'restaurant'), null);

// 조건 핀 — 둘 다 켜지면 둘 다 맞는 핀만
assert.deepEqual(pinAttributesOf(['indoor', 'stroller', 'accessible']), ['accessible', 'stroller']);
assert.equal(hasPinAttributes({ type: 'cafe', barrierFree: true }, ['accessible', 'stroller']), false);
assert.equal(hasPinAttributes({ type: 'cafe', barrierFree: true, features: { stroller: true } }, ['accessible', 'stroller']), true);
assert.deepEqual(countPinsByType([fac('a', 'cafe', { barrierFree: true })], []), { restaurant: 0, cafe: 0, attraction: 0, culture: 0 });
assert.deepEqual(countPinsByType([fac('a', 'cafe', { barrierFree: true }), fac('b', 'culture')], ['accessible']), { restaurant: 0, cafe: 1, attraction: 0, culture: 0 });

// 조건 켜고 끄기 · 칩 ✕
assert.deepEqual(withAttribute(empty, 'stroller', true).requiredAttributes, ['stroller']);
assert.equal(withAttribute(empty, 'stroller', false), empty);
const walk10 = { ...empty, maxWalkMinutes: 10 as const, requiredAttributes: ['indoor', 'accessible'] as TravelContext['requiredAttributes'] };
assert.equal('maxWalkMinutes' in removeCondition(walk10, 'walk'), false);
assert.deepEqual(removeCondition(walk10, 'barrierFree').requiredAttributes, ['indoor']);
assert.deepEqual(cardConditionKeys(walk10, { walkRelaxed: false, cardWalkMin: 8 }), ['walk', 'indoor', 'barrierFree']);
assert.deepEqual(cardConditionKeys(walk10, { walkRelaxed: false, cardWalkMin: 12 }), ['indoor', 'barrierFree']);
assert.deepEqual(cardConditionKeys(walk10, { walkRelaxed: true, cardWalkMin: null }), ['indoor', 'barrierFree']);

// 제안 상자 — 칩이 있으면 칩, 없으면 조건 핀, 그것도 없으면 유모차 끄기
const zero = { restaurant: 0, cafe: 0, attraction: 0, culture: 0 };
assert.equal(suggestionModel({ category: 'restaurant', candidateCounts: zero, attributePins: zero, pinAttributes: [], strollerOn: false, closedToday: false }), null);
assert.deepEqual(
  suggestionModel({ category: 'restaurant', candidateCounts: { ...zero, restaurant: 3, cafe: 2 }, attributePins: zero, pinAttributes: [], strollerOn: false, closedToday: false })?.chips,
  [{ type: 'cafe', count: 2 }],
);
const here = suggestionModel({ category: 'cafe', candidateCounts: zero, attributePins: { ...zero, cafe: 4 }, pinAttributes: ['accessible'], strollerOn: false, closedToday: false });
assert.equal(here?.pinsHere, 4);
assert.deepEqual(here?.pinChips, []);
const elsewhere = suggestionModel({ category: 'cafe', candidateCounts: zero, attributePins: { ...zero, culture: 2 }, pinAttributes: ['accessible'], strollerOn: false, closedToday: false });
assert.deepEqual(elsewhere?.pinChips, [{ type: 'culture', count: 2 }]);
assert.equal(suggestionModel({ category: 'cafe', candidateCounts: zero, attributePins: zero, pinAttributes: ['stroller'], strollerOn: true, closedToday: false })?.strollerNone, true);
assert.equal(suggestionModel({ category: 'cafe', candidateCounts: zero, attributePins: zero, pinAttributes: [], strollerOn: false, closedToday: true })?.closedToday, true);

// 오늘 휴무만 남음
const monday = new Date('2026-11-09T12:00:00+09:00');
const closedMon = (id: string) => fac(id, 'cafe', { features: { rest_date_raw: '매주 월요일' } });
assert.equal(onlyClosedTodayLeft([closedMon('a'), closedMon('b')], 'cafe', new Set(), monday), true);
assert.equal(onlyClosedTodayLeft([closedMon('a'), fac('b', 'cafe')], 'cafe', new Set(), monday), false);
assert.equal(onlyClosedTodayLeft([closedMon('a')], 'cafe', new Set(['a']), monday), false);

// 세션 기억 — 웹 칩 id · 중심
assert.equal(FILTER_IDS.parking, '주차장');
assert.equal(tabFromFilterId('카페'), 'cafe');
assert.equal(tabFromFilterId('주차장'), 'parking');
assert.equal(tabFromFilterId('pet'), null);
assert.deepEqual(parseMapSession('35.8', '129.2', '5'), { latitude: 35.8, longitude: 129.2, level: 5 });
assert.deepEqual(parseMapSession('35.8', '129.2', null), { latitude: 35.8, longitude: 129.2, level: null });
assert.equal(parseMapSession(null, '129.2', '5'), null);
assert.equal(nearCenter({ latitude: 35.8381, longitude: 129.2101 }, origin), true);
assert.equal(nearCenter({ latitude: 35.84, longitude: 129.21 }, origin), false);

// 카메라 띠 아래 — 스택 위끝 + 8, 비면 NAV_GAP + 8, 주차장 판은 판 위끝
assert.equal(bandBottomInset({ stackHeight: 0, navGap: 15 }), 23);
assert.equal(bandBottomInset({ stackHeight: 240, navGap: 15 }), 248);
assert.equal(bandBottomInset({ stackHeight: 15, navGap: 15, parkingPanelHeight: 180 }), 203);
assert.equal(stablePadding(241), 248);
assert.equal(stablePadding(248), 248);

console.log('chipModel.test ok');
