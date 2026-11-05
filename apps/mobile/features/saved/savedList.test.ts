import assert from 'node:assert/strict';

import {
  candidateFromBookmark,
  categoryView,
  clockText,
  compareBookmarks,
  facilityTypeOf,
  isRealRecommendationId,
  savedCardInput,
  sortBookmarks,
  timelineOf,
  trafficLabelKey,
  type SavedBookmark,
} from './savedList';

const spot = (score: number, tts = 10, pref = 50, travel = 5) => ({ score, timeToService: tts, preferencePercent: pref, expectedTravel: travel });
const b = (id: string, over: Partial<SavedBookmark> = {}): SavedBookmark => ({
  id, name: id, category: '카페', trafficStatus: 'unknown', waitTime: null, ...over,
});

// 정렬: 점수↓ → 이용까지↑ → 선호↓ → 이동↑ → 이름. spot 이 없으면 이름만
const list = sortBookmarks([
  b('low', { spot: spot(50) }),
  b('fastTie', { spot: spot(80, 5) }),
  b('slowTie', { spot: spot(80, 9) }),
  b('top', { spot: spot(90) }),
]);
assert.deepEqual(list.map((x) => x.id), ['top', 'fastTie', 'slowTie', 'low']);
assert.ok(compareBookmarks(b('가'), b('나', { spot: spot(10) })) < 0); // 한쪽이 spot 없음 → 이름 순
const input = [b('b', { spot: spot(1) }), b('a', { spot: spot(1) })];
sortBookmarks(input);
assert.equal(input[0].id, 'b'); // 입력을 바꾸지 않는다

// 분류 필터: 저장 있는 분류만, 0 이 된 선택은 '전체'로 복귀
const mixed = [b('1', { category: '카페' }), b('2', { category: '카페' }), b('3', { category: '음식점' })];
const v = categoryView(mixed, '카페');
assert.deepEqual(v.available, ['음식점', '카페']);
assert.equal(v.counts['카페'], 2);
assert.equal(v.visible.length, 2);
assert.equal(categoryView(mixed, '관광지').effective, 'all');
assert.equal(categoryView(mixed, '관광지').visible.length, 3);
assert.equal(categoryView([], 'all').visible.length, 0);

// 타임라인: 이동만 / 검증 대기가 있을 때만 이용 시각
const now = new Date(2026, 10, 2, 12, 0, 0);
const plain = timelineOf(b('p', { spot: spot(1, 0, 0, 7), waitTime: '9' }), now);
assert.equal(plain.waitMins, null); // 검증 모델이 낸 대기가 아니면 쓰지 않는다
assert.equal(plain.service, null);
assert.equal(clockText(plain.arrival), '12:07');
const verified = timelineOf(b('v', { spot: spot(1, 0, 0, 7), waitTime: '9', waitEvidence: 'verified_model' }), now);
assert.equal(verified.waitMins, 9);
assert.equal(verified.timeToService, 16);
assert.equal(clockText(verified.service!), '12:16');
assert.equal(timelineOf(b('x', { waitTime: 'abc', waitEvidence: 'verified_model' }), now).waitMins, null);
assert.equal(timelineOf(b('n'), now).travelMins, 0);
assert.equal(clockText(new Date(2026, 0, 1, 3, 5)), '03:05');

// 혼잡 글자(색만으로 말하지 않는다) · 근거 없음은 안 그린다
assert.equal(trafficLabelKey('orange'), 'congestion.busy');
assert.equal(trafficLabelKey('blue'), 'congestion.quiet');
assert.equal(trafficLabelKey('unknown'), null);

// 피드백 대상: mock- 은 DB 행이 없다
assert.equal(isRealRecommendationId('3f2a'), true);
assert.equal(isRealRecommendationId('mock-rec-id'), false);
assert.equal(isRealRecommendationId(undefined), false);

// 상세 카드 입력: 웹이 RecommendationCard 에 넘기던 값
assert.equal(facilityTypeOf('관광지'), 'attraction');
assert.equal(facilityTypeOf('모름'), 'restaurant');
const card = savedCardInput(b('c', { category: '문화시설', spot: spot(77, 0, 40, 3.2), waitTime: '6', waitEvidence: 'verified_model', latitude: 35.8, longitude: 129.2, congestionLevel: 0.3 }));
assert.equal(card.facilityType, 'culture');
assert.equal(card.matchPercentage, 100);
assert.equal(card.walkMinutes, 4);
assert.equal(card.expectedWait, 6);
assert.equal(card.timeToService, 9.2);
assert.equal(card.facility.congestionLevel, 0.3);
const bare = savedCardInput(b('d'));
assert.equal(bare.expectedWait, undefined);
assert.equal(bare.expectedTravel, 0);
assert.equal(bare.facility.latitude, null);
assert.equal(bare.walkMinutes, 1);

console.log('savedList.test.ts ok');

// 시트 후보: spot·대기·추천 id 를 싣고, 없으면 장소만
const cand = candidateFromBookmark(b('c1', { latitude: 35.8, longitude: 129.2, waitTime: '7', waitEvidence: 'verified_model', recommendationId: 'rec-1', spot: spot(77, 12, 60, 5) }));
assert.equal(cand.recommendationId, 'rec-1');
assert.equal(cand.spotScore, 77);
assert.equal(cand.breakdown?.preference, 0.6);
assert.equal(cand.breakdown?.waitTime, 7);
assert.equal(cand.facility.type, 'cafe');
const noSpot = candidateFromBookmark(b('c2', { recommendationId: 'mock-1' }));
assert.equal(noSpot.recommendationId, undefined);
assert.equal(noSpot.spotScore, undefined);
assert.equal(noSpot.breakdown, undefined);
assert.ok(Number.isNaN(noSpot.facility.latitude));
