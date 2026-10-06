import assert from 'node:assert/strict';

import { candidateAreaCrowdLevel, chooseCompareHeadline, resolveCandidateCrowd } from './compareHeader';

const parking = (level: number) => ({ level, mode: 'live' as const, observedAt: '2026-09-27T03:20:00+00:00', radiusM: 500 });
const tourism = (relativeIndex: number) => ({ referenceName: '대릉원', distanceM: 180, forecastDate: '2026-09-27', relativeIndex });

// 공영주차 근거만: 서버 종합값(주차 + 근처 축제·날씨 보정)을 그대로 쓴다.
assert.equal(candidateAreaCrowdLevel({ areaDemandLevel: 0.58, parking: parking(0.52) }), 0.58);

// 관광 상대지수가 섞이면 종합값(0.81)이 아니라 주차 값(0.55)만 — 관광 지수는 붐빔 등급이 아니다.
assert.equal(candidateAreaCrowdLevel({ areaDemandLevel: 0.81, parking: parking(0.55), tourism: tourism(100) }), 0.55);

// 주차 근거가 없으면(관광 지수뿐 · 축제뿐) 등급을 만들지 않는다 → 호출부는 등급 단어를 쓰지 않는다.
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

// ── 카드 첫 줄: 화살표("지금 A 혼잡 → 대신 B")는 B 가 정말 덜 붐비는 다른 곳일 때만 ─────────────
// 심사 시뮬레이션(2026-10-06)에서 실제로 뜬 문장들 — 전부 혜택 문장이어야 한다.
const benefit = (candidateIsAnchor: boolean) => ({ kind: 'benefit', candidateIsAnchor });

// (a) 자기 자신과 비교: "지금 경주 첨성대 혼잡 → 대신 경주 첨성대" (관광 근거가 그 장소 자신, 거리 0).
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '경주 첨성대', anchorDistanceM: 0, candidateName: '경주 첨성대', anchorGrade: 'busy', candidateGrade: 'busy' }),
  benefit(true),
);
// (b) 이름 표기만 다른 같은 곳 — 공백과 맨 앞 '경주'는 같은 이름으로 본다(거리를 몰라도).
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '첨성대', anchorDistanceM: null, candidateName: '경주 첨성대', anchorGrade: 'busy', candidateGrade: 'quiet' }),
  benefit(true),
);
// (c) 한쪽 이름이 다른 쪽을 품는다('대릉원' ⊂ '천마총(대릉원)').
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '천마총(대릉원)', anchorDistanceM: 350, candidateName: '대릉원', anchorGrade: 'busy', candidateGrade: 'quiet' }),
  benefit(true),
);
// (d) 혼잡 → 혼잡: 같은 지역 추정이라 등급이 같다 — 덜 붐비는 곳이 아니다.
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '대릉원', anchorDistanceM: 600, candidateName: '우직', anchorGrade: 'busy', candidateGrade: 'busy' }),
  benefit(false),
);
// (e) 보통 → 보통(천마총 → 우직).
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '천마총(대릉원)', anchorDistanceM: 420, candidateName: '우직', anchorGrade: 'moderate', candidateGrade: 'moderate' }),
  benefit(false),
);
// 더 붐비는 곳은 말할 것도 없다.
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '대릉원', anchorDistanceM: 420, candidateName: '우직', anchorGrade: 'relaxed', candidateGrade: 'busy' }),
  benefit(false),
);
// (f) 지구·일원 같은 넓은 구역 기록은 '대신 피할 한 곳'이 아니다.
for (const district of ['경주 동부 사적지대', '보문관광단지', '경주역사유적지구', '쪽샘지구', '대릉원 일원', '황리단길 일대', '불국사 권역']) {
  assert.deepEqual(
    chooseCompareHeadline({ anchorName: district, anchorDistanceM: 800, candidateName: '우직', anchorGrade: 'busy', candidateGrade: 'quiet' }),
    benefit(false),
    district,
  );
}
// (g) 기준 명소가 없으면('인기 명소 인기' 의 원인) 혜택 문장이다.
assert.deepEqual(
  chooseCompareHeadline({ anchorName: null, candidateName: '향화정', anchorGrade: null, candidateGrade: 'moderate' }),
  benefit(false),
);
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '  ', candidateName: '향화정', anchorGrade: 'busy', candidateGrade: 'quiet' }),
  benefit(false),
);
// 등급을 하나라도 모르면 '덜 붐빈다'고 말할 수 없다.
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '대릉원', anchorDistanceM: 400, candidateName: '우직', anchorGrade: 'busy', candidateGrade: null }),
  benefit(false),
);
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '대릉원', anchorDistanceM: 400, candidateName: '우직', anchorGrade: null, candidateGrade: 'quiet' }),
  benefit(false),
);
// 100m 안쪽은 같은 자리다.
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '대릉원', anchorDistanceM: 99, candidateName: '우직', anchorGrade: 'busy', candidateGrade: 'quiet' }),
  benefit(false),
);

// 화살표가 참인 경우: 다른 곳 · 400m · 혼잡 → 여유.
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '대릉원', anchorDistanceM: 400, candidateName: '우직', anchorGrade: 'busy', candidateGrade: 'relaxed' }),
  { kind: 'compare' },
);
// 거리를 모르면(테마 랜드마크 좌표 없음) 거리 조건은 통과로 본다. 경계 100m 도 통과.
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '대릉원', candidateName: '우직', anchorGrade: 'moderate', candidateGrade: 'quiet' }),
  { kind: 'compare' },
);
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '대릉원', anchorDistanceM: 100, candidateName: '우직', anchorGrade: 'busy', candidateGrade: 'moderate' }),
  { kind: 'compare' },
);

console.log('compare header tests passed');
