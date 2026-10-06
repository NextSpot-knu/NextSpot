// /waiting 카드 → /explore/recommend 연결(2026-10-06 감사 I25)과 한국어 조사.
import assert from 'node:assert/strict';
import {
  buildRecommendHref,
  candidateTypesFor,
  isStrictlyCalmer,
  topicJosa,
  withTopicJosa,
} from './recommendOrigin';
import { REGION } from './region';

// 같은 종류의 대안 — 관광지와 문화시설은 한 무리(눌러 들어온 곳이 첨성대면 근처 유적·박물관).
assert.deepEqual(candidateTypesFor('attraction'), ['attraction', 'culture']);
assert.deepEqual(candidateTypesFor('culture'), ['attraction', 'culture']);
assert.deepEqual(candidateTypesFor('restaurant'), ['restaurant']);
assert.deepEqual(candidateTypesFor('cafe'), ['cafe']);
assert.deepEqual(candidateTypesFor('bar'), []);
assert.deepEqual(candidateTypesFor(null), []);

// 누른 카드의 좌표·종류로 묻는다. 옛 캐시 행(좌표 없음)은 지역 중심으로.
const href = buildRecommendHref({ facilityId: 'a 1', type: 'attraction', latitude: 35.8347, longitude: 129.219 });
const url = new URL(href, 'https://x.test');
assert.equal(url.pathname, '/explore/recommend');
assert.equal(url.searchParams.get('facilityId'), 'a 1');
assert.equal(url.searchParams.get('lat'), '35.8347');
assert.equal(url.searchParams.get('lng'), '129.219');
assert.equal(url.searchParams.get('type'), 'attraction');
assert.equal(url.searchParams.get('from'), 'waiting');
const legacy = new URL(buildRecommendHref({ facilityId: 'old', type: 'cafe' }), 'https://x.test');
assert.equal(legacy.searchParams.get('lat'), String(REGION.center.lat));
assert.equal(legacy.searchParams.get('lng'), String(REGION.center.lng));
const nan = new URL(buildRecommendHref({ facilityId: 'n', type: 'cafe', latitude: Number.NaN, longitude: 1 }), 'https://x.test');
assert.equal(nan.searchParams.get('lat'), String(REGION.center.lat), '좌표 하나라도 이상하면 둘 다 지역 중심');

// 조사 — '은(는)' 대신 받침으로 고른다.
assert.equal(topicJosa('경주 첨성대'), '는');
assert.equal(topicJosa('국립경주박물관'), '은');
assert.equal(topicJosa('교촌마을'), '은');
assert.equal(topicJosa('카페(본점)'), '은', '괄호 뒤가 아니라 마지막 글자');
assert.equal(topicJosa('스타벅스 2'), '는', '2(이)');
assert.equal(topicJosa('게이트 3'), '은', '3(삼)');
assert.equal(topicJosa('Cafe Ann'), '은', '영문은 마지막 자음으로 짐작');
assert.equal(topicJosa('Cafe'), '는');
assert.equal(withTopicJosa('경주 계림'), '경주 계림은');
assert.equal(withTopicJosa('동궁과 월지'), '동궁과 월지는');

// 대안의 붐빔 칩은 눌러 들어온 곳보다 **확실히 덜 붐빌 때만**.
assert.equal(isStrictlyCalmer('relaxed', 'busy'), true);
assert.equal(isStrictlyCalmer('busy', 'busy'), false);
assert.equal(isStrictlyCalmer('moderate', 'relaxed'), false);
assert.equal(isStrictlyCalmer('quiet', null), false, '비교할 곳의 등급을 모르면 말하지 않는다');

console.log('recommendOrigin: ok');
