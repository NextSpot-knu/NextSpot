import assert from 'node:assert/strict';

import {
  candidateTypesFor,
  currentOriginLevel,
  handoffOrigin,
  hasOrigin,
  isNamedOrigin,
  isStrictlyCalmer,
  parseRecommendParams,
  readRecommendEntry,
  showsOtherKinds,
  topicJosa,
  withTopicJosa,
} from './origin';

// 종류 → 대안 종류
assert.deepEqual(candidateTypesFor('cafe'), ['cafe']);
assert.deepEqual(candidateTypesFor('attraction'), ['attraction', 'culture']);
assert.deepEqual(candidateTypesFor('culture'), ['attraction', 'culture']);
assert.deepEqual(candidateTypesFor('parking'), []);
assert.deepEqual(candidateTypesFor(null), []);

// 들어온 길
const q = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
assert.deepEqual(readRecommendEntry(q({ from: 'waiting' })), { from: 'waiting', walkFromPlace: true });
assert.deepEqual(readRecommendEntry(q({ from: 'pick' })), { from: 'pick', walkFromPlace: false });
assert.deepEqual(readRecommendEntry(q({ from: 'pick', walk: 'place' })), { from: 'pick', walkFromPlace: true });
assert.deepEqual(readRecommendEntry(q({ from: 'x' })), { from: null, walkFromPlace: false });

// 다른 종류 섞임
assert.equal(showsOtherKinds(['cafe'], [{ facility: { type: 'restaurant' } }]), true);
assert.equal(showsOtherKinds(['cafe'], [{ facility: { type: 'cafe' } }]), false);
assert.equal(showsOtherKinds([], [{ facility: { type: 'restaurant' } }]), false);

// 조사
assert.equal(topicJosa('경주 첨성대'), '는');
assert.equal(topicJosa('국립경주박물관'), '은');
assert.equal(withTopicJosa('카페 3'), '카페 3은');
assert.equal(topicJosa('Cafe Moon'), '은');
assert.equal(topicJosa('Cafe (본점)'), '은');

// 등급 비교
assert.equal(isStrictlyCalmer('quiet', 'busy'), true);
assert.equal(isStrictlyCalmer('busy', 'busy'), false);
assert.equal(isStrictlyCalmer('quiet', null), false);

// 원래 장소의 지금 실측
const now = new Date('2026-11-02T03:00:00Z');
assert.equal(currentOriginLevel([], now), null);
assert.equal(currentOriginLevel(null, now), null);
assert.equal(
  currentOriginLevel([{ congestion_level: 0.9, source: 'seed', evidence_tier: 'verified', timestamp: now.toISOString() }], now),
  null,
);
assert.equal(
  currentOriginLevel(
    [{ congestion_level: 0.4, source: 'sensor', evidence_tier: 'verified', timestamp: new Date(now.getTime() - 5 * 60_000).toISOString() }],
    now,
  ),
  0.4,
);
assert.equal(
  currentOriginLevel(
    [{ congestion_level: 0.4, source: 'sensor', evidence_tier: 'verified', timestamp: new Date(now.getTime() - 3 * 3600_000).toISOString() }],
    now,
  ),
  null,
);

// 주소 읽기
const p1 = parseRecommendParams({ facilityId: 'f1', lat: '35.8', lng: '129.2', from: 'waiting', ref: 'share', type: 'cafe' });
assert.equal(p1.facilityId, 'f1');
assert.equal(p1.lat, 35.8);
assert.equal(p1.walkFromPlace, true);
assert.equal(p1.fromShare, true);
assert.equal(hasOrigin(p1), true);
const p2 = parseRecommendParams({ name: ' 새 카페 ', type: 'cafe', lat: ['35.8'], lng: 'abc' });
assert.equal(p2.name, '새 카페');
assert.equal(p2.lat, null, '좌표는 둘 다 숫자일 때만');
assert.equal(isNamedOrigin(p2), true);
const p3 = parseRecommendParams({ name: '모르는 곳', type: 'parking' });
assert.equal(hasOrigin(p3), false, '종류를 모르면 물을 수 없다');
assert.equal(hasOrigin(parseRecommendParams({})), false);

// 길찾기 출발지 — 실제 내 위치일 때만
assert.deepEqual(handoffOrigin({ lat: 35.8, lng: 129.2 }, true), { latitude: 35.8, longitude: 129.2 });
assert.equal(handoffOrigin({ lat: 35.8, lng: 129.2 }, false), null, '주소 좌표·지역 중심은 출발지가 아니다');
assert.equal(handoffOrigin({ lat: Number.NaN, lng: 129.2 }, true), null);

console.log('origin.test.ts ok');
