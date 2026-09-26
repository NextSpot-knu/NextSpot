import assert from 'node:assert/strict';

import { candidateAreaCrowdLevel, resolveCandidateCrowd } from './compareHeader';

const parking = (level: number) => ({ level, mode: 'live' as const, observedAt: '2026-09-27T03:20:00+00:00', radiusM: 500 });
const tourism = (relativeIndex: number) => ({ referenceName: '대릉원', distanceM: 180, forecastDate: '2026-09-27', relativeIndex });

// 공영주차 근거만: 서버 종합값(주차 + 근처 축제·날씨 보정)을 그대로 쓴다.
assert.equal(candidateAreaCrowdLevel({ areaDemandLevel: 0.58, parking: parking(0.52) }), 0.58);

// 관광 상대지수가 섞이면 종합값(0.81)이 아니라 주차 값(0.55)만 — 관광 지수는 붐빔 등급이 아니다.
assert.equal(candidateAreaCrowdLevel({ areaDemandLevel: 0.81, parking: parking(0.55), tourism: tourism(100) }), 0.55);

// 주차 근거가 없으면(관광 지수뿐 · 축제뿐) 등급을 만들지 않는다 → 호출부의 '수집 중'.
assert.equal(candidateAreaCrowdLevel({ areaDemandLevel: 0.9, tourism: tourism(90) }), null);
assert.equal(candidateAreaCrowdLevel({ areaDemandLevel: 0.2 }), null);

// 주변 수요 자체가 없으면 null.
assert.equal(candidateAreaCrowdLevel({ areaDemandLevel: null, parking: parking(0.4) }), null);
assert.equal(candidateAreaCrowdLevel({ parking: parking(0.4), tourism: tourism(40) }), null);

// 검증 2026-09-27 minor: 주차 0.55 + 관광 근거인 곳에서 휴대폰 미리보기는 '주변 붐빔: 보통' 이었고 펼친 카드의
// 비교 헤더는 '수집 중' 이었다. 이제 둘 다 같은 값(위 함수)으로 같은 등급을 말한다.
const mixedGrade = resolveCandidateCrowd({
  congestionLevel: null,
  estimateLevel: undefined,
  areaDemandLevel: candidateAreaCrowdLevel({ areaDemandLevel: 0.81, parking: parking(0.55), tourism: tourism(100) }),
});
assert.equal(mixedGrade, 'moderate');

// 실측·추정이 있으면 그 값이 먼저다(주변 수요는 그 다음).
assert.equal(resolveCandidateCrowd({ congestionLevel: 0.2, areaDemandLevel: 0.9 }), 'quiet');
assert.equal(resolveCandidateCrowd({ estimateLevel: 0.8, areaDemandLevel: 0.1 }), 'busy');
assert.equal(resolveCandidateCrowd({ areaDemandLevel: null }), null);

console.log('compare header tests passed');
