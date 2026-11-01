import assert from 'node:assert/strict';

import { buildCardModel, formatClock, type CardContext } from './cardModel';
import type { SheetCandidate } from './types';

const t: CardContext['t'] = (key, vars) => (vars ? `${key}${JSON.stringify(vars)}` : key);
const NOW = new Date(2026, 10, 2, 14, 0, 0);
const base: SheetCandidate = {
  recommendationId: '11111111-1111-4111-8111-111111111111',
  facility: {
    id: 'f1', name: '우직', type: 'restaurant', latitude: 35.83, longitude: 129.21,
    operatingHours: { open: '09:00 ~ 21:00' }, features: { firstMenu: '곱창' },
  },
  spotScore: 74.4,
  breakdown: { preference: 0.82, travelTime: 3.1, waitTime: 4.2, incentive: 0 },
  scoringMode: 'model',
  congestionSource: 'measured',
  congestionLevel: 0.2,
  congestionIsCurrent: true,
  openStatusAtArrival: 'open_expected',
};
const ctx = (extra: Partial<CardContext> = {}): CardContext => ({ t, now: NOW, listRank: 1, ...extra });

// 숫자 — 도보는 올림, 대기는 학습 모델일 때만, 점수는 반올림
const m = buildCardModel(base, ctx());
assert.equal(m.times.walkMin, 4);
assert.equal(m.times.waitMin, 5);
assert.equal(m.times.totalMin, 9);
assert.equal(m.spotScore, 74);
assert.equal(m.preferencePercent, 82);
assert.equal(formatClock(m.times.arrival), '14:04');
assert.equal(m.showArrivalLine, true);
assert.equal(m.rankIsListed, true);
assert.equal(m.rankText.key, 'card.rankBadgeTop');

// 모델이 아니면 대기를 말하지 않는다 → 칩에도 없다
const noModel = buildCardModel({ ...base, scoringMode: 'measured_rules' }, ctx());
assert.equal(noModel.times.waitMin, null);
assert.ok(!noModel.faceChips.some((c) => c.key === 'wait'));
assert.ok(m.faceChips.some((c) => c.key === 'wait'));

// 직접 고른 장소는 순위 배지가 아니다
const picked = buildCardModel({ ...base, userPicked: true }, ctx({ listRank: 1 }));
assert.equal(picked.rankIsListed, false);

// 방금 남긴 로컬 제보가 서버 값을 이긴다 + 방문객 제보 칩
const reported = buildCardModel(base, ctx({ localReport: { level: 0.8, timestamp: NOW.toISOString() } }));
assert.equal(reported.crowdChip?.grade, 'busy');
assert.equal(reported.displayCongestionLevel, 0.8);
assert.ok(reported.crowdChip?.text.startsWith('card.crowdByVisitor'));

// 혼잡 근거가 없으면 칩을 지어내지 않는다
const none = buildCardModel({ ...base, congestionLevel: undefined, congestionSource: 'none' }, ctx());
assert.equal(none.crowdChip, null);

// 영업시간을 모르는 음식점은 확인이 필요하고 카카오 검색 링크가 있다
const unsure = buildCardModel({ ...base, openStatusAtArrival: 'needs_confirmation', facility: { ...base.facility, operatingHours: null } }, ctx());
assert.equal(unsure.needsHoursConfirmation, true);
assert.ok(unsure.kakaoPlaceUrl?.startsWith('https://map.kakao.com/?q='));
// 이 기기에서 '영업 중' 이라 답하면 판정이 바뀐다
const answered = buildCardModel({ ...base, openStatusAtArrival: 'needs_confirmation', facility: { ...base.facility, operatingHours: null } }, ctx({ localHoursAnswer: 'open' }));
assert.equal(answered.needsHoursConfirmation, false);
assert.equal(answered.displayedOpenStatus, 'open_expected');

// 사진 — 숨긴 사진은 후보에서 빠지고 http 도 그대로 후보(https 변환은 화면)
const photos = buildCardModel({ ...base, facility: { ...base.facility, imageUrl: 'http://tong.visitkorea.or.kr/a.jpg', galleryImages: ['https://x/b.jpg'] } }, ctx({ hiddenPhotos: ['https://x/b.jpg'] }));
assert.deepEqual(photos.photoUrls, ['http://tong.visitkorea.or.kr/a.jpg']);
assert.equal(photos.photoIsTourApi(photos.photoUrls[0]), true);

// 새로고침 버튼은 TourAPI 식별자가 둘 다 있을 때만
assert.equal(m.canLiveRefresh, false);
assert.equal(buildCardModel({ ...base, facility: { ...base.facility, contentid: '123', contenttypeid: 39 } }, ctx()).canLiveRefresh, true);

// 전화 링크 · 홈페이지 URL 추출
const info = buildCardModel({ ...base, facility: { ...base.facility, phone: '054-772-3843~4', homepage: '<a href="https://blog.naver.com/x">x</a>' } }, ctx());
assert.equal(info.phoneHref, 'tel:0547723843');
assert.equal(info.homepageHost, 'blog.naver.com');
assert.equal(info.homepageIsExternalChannel, true);

// 주변 수요 상자는 수치가 있을 때만
assert.equal(m.area, null);
assert.ok(buildCardModel({ ...base, breakdown: { ...base.breakdown!, areaDemandLevel: 0.4 } }, ctx()).area);

// now 가 없으면(첫 렌더 전) 도착 줄을 그리지 않는다
assert.equal(buildCardModel(base, ctx({ now: null })).showArrivalLine, false);

// 요리 분류(한국어 태그)는 ko 가 아닐 때 영어 틀(compare.cuisineWalk)에 끼우지 않는다 — 혜택 줄(benefitWalk)로 내려간다
const cuisineCand: SheetCandidate = { ...base, facility: { ...base.facility, features: { cuisineTags: ['한식'] } } };
const cuisineKo = buildCardModel(cuisineCand, ctx({ locale: 'ko' }));
assert.ok(cuisineKo.peekValueText.includes('한식'), cuisineKo.peekValueText);
const cuisineEn = buildCardModel(cuisineCand, ctx({ locale: 'en' }));
assert.ok(!cuisineEn.peekValueText.includes('compare.cuisineWalk') && !cuisineEn.peekValueText.includes('한식'), cuisineEn.peekValueText);
assert.ok(cuisineEn.peekValueText.includes('compare.benefitWalk'), cuisineEn.peekValueText);
// 메뉴 이름은 데이터라 그대로
assert.ok(buildCardModel(base, ctx({ locale: 'en' })).peekValueText.includes('곱창'));

console.log('cardModel.test OK');
