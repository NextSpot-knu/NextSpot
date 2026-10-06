import assert from 'node:assert/strict';

import {
  anchorNowLevel,
  candidateAreaCrowdLevel,
  chooseCompareHeadline,
  resolveAnchorCrowd,
  resolveCandidateCrowd,
  showFaceCrowdChip,
  tasteBenefitPercent,
  faceTastePercent,
} from './compareHeader';

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

// ── 같은 곳 판정: 이름을 품는 다른 가게 · 빈 이름 (검토 2026-10-06) ──────────────────────────────
// 300m 떨어진 '첨성대 한정식' 은 첨성대가 아니다 — 정말 덜 붐비면 화살표가 참이다.
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '첨성대', anchorDistanceM: 300, candidateName: '첨성대 한정식', anchorGrade: 'busy', candidateGrade: 'quiet' }),
  { kind: 'compare' },
);
// 거리를 모르거나 100m 안쪽이면 이름을 품는 것도 같은 자리로 본다.
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '첨성대', anchorDistanceM: null, candidateName: '첨성대 한정식', anchorGrade: 'busy', candidateGrade: 'quiet' }),
  benefit(true),
);
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '첨성대', anchorDistanceM: 60, candidateName: '첨성대 한정식', anchorGrade: 'busy', candidateGrade: 'quiet' }),
  benefit(true),
);
// 괄호 속 별칭은 거리와 상관없이 같은 곳이다('천마총(대릉원)' ↔ '대릉원', 위 (c)).
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '대릉원', anchorDistanceM: 350, candidateName: '천마총(대릉원)', anchorGrade: 'busy', candidateGrade: 'quiet' }),
  benefit(true),
);
// '경주' 는 정규화하면 빈 이름 — 모든 후보를 '자기 자신' 으로 만들지 않고, 기준 명소가 없는 것으로 본다.
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '경주', anchorDistanceM: 400, candidateName: '우직', anchorGrade: 'busy', candidateGrade: 'quiet' }),
  benefit(false),
);

// ── 기준 명소 등급의 근거: 관광 상대지수로는 비교하지 않는다 ──────────────────────────────────────
// 관광 지수 86 은 '혼잡' 으로 읽히지만, 명소 자신의 최고 시기 대비 날짜별 값이라 '지금' 도, 다른 곳과 견줄 값도 아니다.
const tourismAnchor = resolveAnchorCrowd({ estimateLevel: null, parkingLevel: null, tourismRelativeIndex: 86 });
assert.deepEqual(tourismAnchor, { grade: 'busy', basis: 'tourism' });
assert.deepEqual(
  chooseCompareHeadline({ anchorName: '대릉원', anchorDistanceM: 400, candidateName: '우직', anchorGrade: tourismAnchor.grade, anchorBasis: tourismAnchor.basis, candidateGrade: 'relaxed' }),
  benefit(false),
);
// 주차 실측·추정 근거면 그대로 비교한다.
for (const basis of ['parking', 'estimate'] as const) {
  assert.deepEqual(
    chooseCompareHeadline({ anchorName: '대릉원', anchorDistanceM: 400, candidateName: '우직', anchorGrade: 'busy', anchorBasis: basis, candidateGrade: 'relaxed' }),
    { kind: 'compare' },
    basis,
  );
}

// ── 기준 명소 시설의 '지금' 혼잡 — 카드와 같은 규칙(congestionDisplay) ───────────────────────────────
const NOW = new Date('2026-10-06T03:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();
const freshEstimate = (level: number, ageMin = 5) => ({
  level, source: 'estimated', observedAt: minutesAgo(ageMin), parkingLevel: level, tourismLevel: null,
  lotCount: 1, nearestLotM: 300, radiusM: 2000,
});
// 46일 전 관측(서버: 지금 아님)은 등급이 되지 않는다 — '지금 대릉원 혼잡' 의 원인이었다.
assert.equal(
  anchorNowLevel({ congestionLevel: 0.92, congestionIsCurrent: false, congestionTimestamp: minutesAgo(46 * 24 * 60) }, NOW),
  null,
);
// 시각을 모르는 '지금 아님' 관측도 같다.
assert.equal(anchorNowLevel({ congestionLevel: 0.92, congestionIsCurrent: false, congestionTimestamp: null }, NOW), null);
// 낡은 관측 대신 신선한 추정이 있으면 그 추정.
assert.equal(
  anchorNowLevel({
    congestionLevel: 0.92, congestionIsCurrent: false, congestionTimestamp: minutesAgo(46 * 24 * 60),
    congestionEstimate: freshEstimate(0.4),
  }, NOW),
  0.4,
);
// 60분이 넘은 추정은 쓰지 않는다.
assert.equal(anchorNowLevel({ congestionLevel: null, congestionEstimate: freshEstimate(0.9, 90) }, NOW), null);
assert.equal(anchorNowLevel({ congestionLevel: null, congestionEstimate: freshEstimate(0.9) }, NOW), 0.9);
// 서버가 '지금' 이라고 한 실측은 그대로(추정보다 먼저).
assert.equal(
  anchorNowLevel({ congestionLevel: 0.8, congestionIsCurrent: true, congestionTimestamp: minutesAgo(10), congestionEstimate: freshEstimate(0.3) }, NOW),
  0.8,
);
// 근거가 하나도 없으면 null — 카드가 주차 실측 → 관광 지수 순으로 내려간다.
assert.equal(anchorNowLevel({}, NOW), null);

// ── 혜택 문장의 취향 조각은 문턱(50%) 이상일 때만 ───────────────────────────────────────────────
assert.equal(tasteBenefitPercent(80), 80);
assert.equal(tasteBenefitPercent(50), 50);
assert.equal(tasteBenefitPercent(49), null);
assert.equal(tasteBenefitPercent(12), null);
assert.equal(tasteBenefitPercent(72.5), null);
assert.equal(tasteBenefitPercent(undefined), null);

// ── 앞면의 취향 조각은 장소를 가를 때만(리뷰 10-07) ─────────────────────────────────────────────
// 처음 고른 취향만 있는 게스트는 모든 카드가 '취향 51% 일치' — 같은 숫자는 개인화를 꾸민 숫자처럼 보인다.
assert.equal(faceTastePercent(51), null, '60% 아래는 앞면에서 말하지 않는다');
assert.equal(faceTastePercent(51, [51, 51, 51, 51, 51]), null);
assert.equal(faceTastePercent(80), 80);
assert.equal(faceTastePercent(80, [80, 64, 72]), 80, '후보마다 다르면 말한다');
assert.equal(faceTastePercent(85, [85, 85, 85]), null, '모든 후보가 같은 숫자면 장소를 가르지 못한다');
assert.equal(faceTastePercent(85, [85]), 85, '비교할 후보가 하나뿐이면 문턱만 본다');
assert.equal(faceTastePercent(60, [60, null, undefined, 70]), 60);
assert.equal(faceTastePercent(72.5, [70, 80]), null, '정수가 아니면 말하지 않는다(문턱 함수와 같다)');

// ── 접힌 카드 얼굴의 혼잡 칩(계획 B2 5번) ─────────────────────────────────────────────────────────
// 화살표 문장이 이미 붐빔을 말하면 칩은 반복이라 없다.
assert.equal(showFaceCrowdChip({ valueLineSaysCrowd: true, measuredNow: true, anchorGrade: 'busy', candidateGrade: 'quiet' }), false);
// 지금 잰 값은 보인다.
assert.equal(showFaceCrowdChip({ valueLineSaysCrowd: false, measuredNow: true, anchorGrade: null, candidateGrade: 'quiet' }), true);
// 지역 추정이 기준 명소와 같은 등급이면 얼굴에 없다(자기 자리 추천 · 같은 지역).
assert.equal(showFaceCrowdChip({ valueLineSaysCrowd: false, measuredNow: false, anchorGrade: 'busy', candidateGrade: 'busy' }), false);
assert.equal(showFaceCrowdChip({ valueLineSaysCrowd: false, measuredNow: false, anchorGrade: null, candidateGrade: 'busy' }), false);
// 정말 덜 붐비면 보인다(예: 기준 명소가 지구 기록이라 화살표는 못 쓰지만 등급은 낮다).
assert.equal(showFaceCrowdChip({ valueLineSaysCrowd: false, measuredNow: false, anchorGrade: 'busy', anchorBasis: 'parking', candidateGrade: 'relaxed' }), true);
// 기준 명소 등급이 관광 상대지수에서 왔으면 '덜 붐빈다' 를 말하지 않는다.
assert.equal(showFaceCrowdChip({ valueLineSaysCrowd: false, measuredNow: false, anchorGrade: 'busy', anchorBasis: 'tourism', candidateGrade: 'quiet' }), false);

console.log('compare header tests passed');
