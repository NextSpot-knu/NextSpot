import assert from 'node:assert/strict';
import { uniqueSyntheticRecommendationIds } from './recommendationIds';

const rec = (recommendationId: string, facilityId?: string) => ({
  recommendationId,
  facility: facilityId === undefined ? undefined : { id: facilityId },
});

// 저장 실패로 모두 "mock-rec-id" 인 응답 → 카드마다 다른 id, 접두사 'mock-' 유지.
const out = uniqueSyntheticRecommendationIds([rec('mock-rec-id', 'f1'), rec('mock-rec-id', 'f2'), rec('mock-rec-id', 'f3')]);
assert.deepEqual(out.map((r) => r.recommendationId), ['mock-rec-id:f1', 'mock-rec-id:f2', 'mock-rec-id:f3']);
assert.equal(new Set(out.map((r) => r.recommendationId)).size, 3);
assert.ok(out.every((r) => r.recommendationId.startsWith('mock-')));

// 실제 UUID 는 그대로(같은 객체), 섞여 있어도 합성 id 만 바뀐다.
const real = rec('0b7c7f0e-2f4d-4a57-9d59-0c7a7b1f0d11', 'f9');
const mixed = uniqueSyntheticRecommendationIds([real, rec('mock-rec-id', 'f1')]);
assert.equal(mixed[0], real);
assert.equal(mixed[1].recommendationId, 'mock-rec-id:f1');

// 시설 id 가 없거나 같은 시설이 두 번 와도 겹치지 않는다.
const edge = uniqueSyntheticRecommendationIds([rec('mock-rec-id'), rec('mock-rec-id'), rec('mock-rec-id', 'f1'), rec('mock-rec-id', 'f1')]);
assert.equal(new Set(edge.map((r) => r.recommendationId)).size, 4);

// 입력은 바꾸지 않는다(서버 응답 객체를 그대로 두고 새 객체를 돌려준다).
const input = [rec('mock-rec-id', 'f1')];
uniqueSyntheticRecommendationIds(input);
assert.equal(input[0].recommendationId, 'mock-rec-id');

// 빈 배열.
assert.deepEqual(uniqueSyntheticRecommendationIds([]), []);

console.log('recommendationIds tests passed');
