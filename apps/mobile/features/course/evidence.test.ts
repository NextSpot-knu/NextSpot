// features/course/evidence.ts — 실행: tsx features/course/evidence.test.ts
import assert from 'node:assert/strict';

import { displayableEstimate, formatEstimateTime, uncreditedPhotoCandidates } from './evidence';

// 사진 — 출처 표기가 필요한 호스트는 빼고 중복·빈 값 제거
assert.deepEqual(
  uncreditedPhotoCandidates('http://tong.visitkorea.or.kr/a.jpg', [
    'https://upload.wikimedia.org/x.jpg',
    'https://www.gyeongju.go.kr/y.jpg',
    'http://tong.visitkorea.or.kr/a.jpg',
    '  ',
    'https://tong.visitkorea.or.kr/b.jpg',
    7,
  ]),
  ['http://tong.visitkorea.or.kr/a.jpg', 'https://tong.visitkorea.or.kr/b.jpg'],
);
assert.deepEqual(uncreditedPhotoCandidates(null, 'x'), []);

// 추정 — 예측 숫자가 있으면 숨김, 낡음·범위 밖·모양 오류도 숨김
const now = new Date('2026-11-02T03:00:00Z');
const fresh = { source: 'estimated', level: 0.6, observedAt: '2026-11-02T02:40:00Z' };
assert.deepEqual(displayableEstimate({ congestionLevel: null, congestionEstimate: fresh }, now), { level: 0.6, observedAt: fresh.observedAt });
assert.equal(displayableEstimate({ congestionLevel: 0.2, congestionEstimate: fresh }, now), null);
assert.equal(displayableEstimate({ congestionEstimate: { ...fresh, observedAt: '2026-11-02T01:00:00Z' } }, now), null);
assert.equal(displayableEstimate({ congestionEstimate: { ...fresh, level: 1.5 } }, now), null);
assert.equal(displayableEstimate({ congestionEstimate: { ...fresh, source: 'measured' } }, now), null);
assert.equal(displayableEstimate({}, now), null);

// KST 시계
assert.equal(formatEstimateTime('2026-11-02T02:40:00Z'), '11:40');
assert.equal(formatEstimateTime('nope'), null);
assert.equal(formatEstimateTime(null), null);

console.log('features/course/evidence.test.ts OK');
