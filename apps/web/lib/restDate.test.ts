import assert from 'node:assert/strict';
import { getArrivalOpenDisplayStatus, getArrivalOpenStatus, isRecommendationOpen } from './restDate';

const twoAmKst = new Date('2026-08-20T17:00:00Z');
assert.equal(getArrivalOpenStatus({}, twoAmKst), 'needs_confirmation');
assert.equal(isRecommendationOpen('cafe', {}, twoAmKst), false);
assert.equal(isRecommendationOpen('restaurant', { open: '09:00~22:00' }, twoAmKst), false);
assert.equal(isRecommendationOpen('cafe', { open: '18:00~03:00' }, twoAmKst), true);

const fiveFortyKst = new Date('2026-07-20T08:40:00.000Z');
assert.equal(isRecommendationOpen('restaurant', { open: '09:00~18:00' }, fiveFortyKst), false);
assert.equal(getArrivalOpenDisplayStatus('needs_confirmation', 'cafe', twoAmKst), 'likely_closed_unknown');
assert.equal(
  getArrivalOpenDisplayStatus('needs_confirmation', 'restaurant', new Date('2026-08-20T12:59:00Z')),
  'needs_confirmation',
);
assert.equal(
  getArrivalOpenDisplayStatus('needs_confirmation', 'restaurant', new Date('2026-08-20T13:00:00Z')),
  'likely_closed_unknown',
);
assert.equal(getArrivalOpenDisplayStatus('needs_confirmation', 'attraction', twoAmKst), 'needs_confirmation');

// ── 실제 TourAPI 운영시간 문구(도심 관광지·음식점, 2026-10-06) ──────────────────────────
// 야외 유적의 '상시 개방' 은 하루 종일 열려 있다 — '영업시간 미확인' 이 아니다.
const threeAmKst = new Date('2026-10-05T18:00:00Z'); // 화 03:00 KST
const twoPmKst = new Date('2026-10-06T05:00:00Z'); // 화 14:00 KST
for (const open of ['상시 개방', '상시개방', '상시 운영', '24시간', '24시간 개방', '연중 개방', '연중 무휴 개방', '상시 개방<br>']) {
  assert.equal(getArrivalOpenStatus({ open }, threeAmKst), 'open_expected', `${open} @03:00`);
  assert.equal(getArrivalOpenStatus({ open }, twoPmKst), 'open_expected', `${open} @14:00`);
}
// 상시 개방이어도 정기 휴무일은 휴무다(월요일 휴관 유적).
const mondayTwoPmKst = new Date('2026-10-05T05:00:00Z'); // 월 14:00 KST
assert.equal(getArrivalOpenStatus({ open: '상시 개방', closed: '매주 월요일' }, mondayTwoPmKst), 'closed_confirmed');
assert.equal(getArrivalOpenStatus({ open: '상시 개방', closed: '매주 월요일' }, twoPmKst), 'open_expected');
// 문장 전체가 그 말일 때만 — 다른 문장에 섞인 말은 여전히 미확인이다.
for (const open of ['점포 별로 상이함', '시설별로 상이함', '상시 개방(일부 구역 제외)', '24시간 운영 시설 있음']) {
  assert.equal(getArrivalOpenStatus({ open }, twoPmKst), 'needs_confirmation', open);
}
// 자정(24:00) 마감: 23:00 은 영업, 23:45 는 곧 마감.
assert.equal(getArrivalOpenStatus({ open: '10:00~24:00' }, new Date('2026-10-06T14:00:00Z')), 'open_expected');
assert.equal(getArrivalOpenStatus({ open: '10:00~24:00' }, new Date('2026-10-06T14:45:00Z')), 'closing_soon');
assert.equal(getArrivalOpenStatus({ open: '10:00~24:00' }, new Date('2026-10-06T00:30:00Z')), 'closed_confirmed'); // 09:30
// 여러 철·여러 문이 붙은 문구도 시각 범위로 읽는다(첨성대 · 천마총).
assert.equal(getArrivalOpenStatus({ open: '- 하절기 09:00~22:00- 동절기 09:00~21:00' }, twoPmKst), 'open_expected');
assert.equal(
  getArrivalOpenStatus({ open: '- 정문 09:00~22:00 (입장 마감 21:30)<br>\n- 후문·천마총 09:00~21:30' }, twoPmKst),
  'open_expected',
);
// 영업시간이 없는 음식점은 여전히 확인이 필요하다(카드는 칩을 그리지 않고 카카오맵 확인으로 보낸다).
assert.equal(getArrivalOpenStatus({}, twoPmKst), 'needs_confirmation');

console.log('restDate tests passed');
