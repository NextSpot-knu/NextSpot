// /waiting 카드 → /explore/recommend 연결(2026-10-06 감사 I25)과 한국어 조사.
import assert from 'node:assert/strict';
import {
  buildRecommendHref,
  candidateTypesFor,
  currentOriginLevel,
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
// 지역 중심에서 잰 걷는 시간이라 '{장소}에서 걸어서' 라고 말하지 않는다 — from=waiting 을 붙이지 않는다.
assert.equal(legacy.searchParams.get('from'), null, '좌표 없는 옛 캐시 행은 그 장소에서 걷는다고 말하지 않는다');
assert.equal(legacy.searchParams.get('type'), 'cafe', '종류는 그대로 넘긴다(같은 종류 대안)');
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

// 원래 장소의 '지금' 실측 — 신뢰 등급 · 30분 이내만. 낡은 관측은 '지금' 이 아니다(추정 피드가 대신 말한다).
const NOW = new Date('2026-10-07T03:30:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
assert.equal(currentOriginLevel([{ congestion_level: 0.2, timestamp: ago(10), source: 'merchant', evidence_tier: 'verified' }], NOW), 0.2);
assert.equal(
  currentOriginLevel([{ congestion_level: 0.2, timestamp: ago(30 * 24 * 60), source: 'parking', evidence_tier: 'verified' }], NOW),
  null,
  '30일 된 관측으로 지금을 말하지 않는다',
);
assert.equal(currentOriginLevel([{ congestion_level: 0.2, timestamp: ago(31), source: 'merchant', evidence_tier: 'verified' }], NOW), null, '30분이 지나면 지금이 아니다');
assert.equal(currentOriginLevel([{ congestion_level: 0.2, timestamp: ago(5), source: 'user_report', evidence_tier: 'single_report' }], NOW), null, '단건 제보는 지금 자격이 없다');
assert.equal(currentOriginLevel([{ congestion_level: 0.9, timestamp: ago(5), source: 'seed', evidence_tier: 'verified' }], NOW), null, '시드는 관측이 아니다');
assert.equal(currentOriginLevel([{ congestion_level: 0.9, timestamp: ago(5), source: 'x', evidence_tier: 'synthetic' }], NOW), null);
assert.equal(
  currentOriginLevel([
    { congestion_level: 0.9, timestamp: ago(3), source: 'seed', evidence_tier: 'verified' },
    { congestion_level: 0.4, timestamp: ago(8), source: 'merchant', evidence_tier: 'corroborated' },
  ], NOW),
  0.4,
  '시드를 건너뛰고 다음 지금 관측',
);
assert.equal(currentOriginLevel([], NOW), null);
assert.equal(currentOriginLevel(undefined, NOW), null);

console.log('recommendOrigin: ok');
