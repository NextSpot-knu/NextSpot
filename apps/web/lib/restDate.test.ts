import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closedDayStatus,
  getArrivalOpenDisplayStatus,
  getArrivalOpenStatus,
  isClosedToday,
  isRecommendationOpen,
  parseAvailability,
} from './restDate';

// ── 서버와 같은 사례 파일 — apps/api/tests/services/test_opening_hours_parity.py 도 이 파일을 읽는다 ──────────
// 한쪽 판정만 바뀌면 이 테스트나 서버 테스트가 깨진다(카드가 '영업' 이라 하는 곳을 추천이 '휴무' 로 빼지 않게).
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const parity = JSON.parse(readFileSync(join(WEB, '../api/tests/fixtures/opening_hours_parity.json'), 'utf8')) as {
  closed_day: { text: string; at: string; expected: 'closed' | 'uncertain' | 'open' | null }[];
  arrival: { hours: Record<string, unknown>; at: string; expected: string }[];
  availability: { text: string; expected: boolean | null }[];
};
assert.ok(parity.closed_day.length > 40 && parity.arrival.length > 20, '공유 사례 파일이 비었다');
for (const { text, at, expected } of parity.closed_day) {
  assert.equal(closedDayStatus(text, new Date(at)), expected, `closedDayStatus(${text}) @ ${at}`);
  // 오늘 휴무 배지: 휴무만 true, 규칙을 읽었고 해당 없음이면 false, 모르면 null.
  const badge = expected === 'closed' ? true : expected === 'open' ? false : null;
  assert.equal(isClosedToday(text, new Date(at)), badge, `isClosedToday(${text}) @ ${at}`);
}
for (const { hours, at, expected } of parity.arrival) {
  assert.equal(getArrivalOpenStatus(hours, new Date(at)), expected, `getArrivalOpenStatus(${JSON.stringify(hours)}) @ ${at}`);
}
for (const { text, expected } of parity.availability) {
  assert.equal(parseAvailability(text), expected, `parseAvailability(${text})`);
}

// 정규식 '뒤쪽 보기' 금지 — iOS 16.4 미만 Safari 는 그 문법이 든 정규식이 있으면 JS 묶음 전체를 읽지 못해 빈 화면이
// 된다. 이 파일은 travelContext.ts 를 거쳐 여러 화면에 실린다(리터럴이든 new RegExp 문자열이든 같은 문법을 막는다).
const restDateSource = readFileSync(join(WEB, 'lib', 'restDate.ts'), 'utf8');
assert.doesNotMatch(restDateSource, /\(\?<[!=]/, 'restDate.ts 에 정규식 뒤쪽 보기가 있다 — 구형 Safari 가 번들을 못 읽는다');

// 되돌아보기 폭주 방지(2026-10-31 검증) — 예전 서수 이음 꼴은 '1st 1st … x' 14개에 1초가 넘었다.
// 결과를 단언하고 시간은 넉넉한 상한만 둔다(지수적으로 되돌아가면 이 크기에서 수십 초가 걸린다).
const mondayNoon = new Date('2026-11-02T12:00:00+09:00');
const pathologicalStarted = performance.now();
for (const raw of [
  '1 '.repeat(14) + 'x', '1st '.repeat(14) + 'x', '첫째 '.repeat(14) + 'x', '1st and '.repeat(14) + 'x',
  '토 '.repeat(140) + 'x', '월화'.repeat(140), '월' + ' 은'.repeat(140) + 'x', '공휴일 경우 '.repeat(30) + 'x',
]) {
  assert.equal(closedDayStatus(raw, mondayNoon), null, `closedDayStatus(${raw.slice(0, 12)}…)`);
}
assert.equal(closedDayStatus('월 , '.repeat(70) + 'x', mondayNoon), 'closed'); // 구분 기호로 이은 월요일 목록
assert.equal(closedDayStatus('mon '.repeat(70) + 'x', mondayNoon), null); // 휴무 말 없는 영어 요일 이름
// 600자를 넘겨 잘린 원문은 뒤쪽을 못 읽었으니 무엇도 단정하지 않는다(그날 모름). 주소·태그 찾기도 길이에 비례한다.
for (const raw of ['1 '.repeat(400) + 'x', 'x'.repeat(3990) + 'www.', 'a.'.repeat(2000), '<'.repeat(4000), 'z'.repeat(9000)]) {
  assert.equal(closedDayStatus(raw, mondayNoon), 'uncertain', `closedDayStatus(${raw.slice(0, 12)}…)`);
}
for (const raw of [
  '입장마감' + ' '.repeat(200) + 'x', '브레이크' + ' '.repeat(200) + 'x', '휴게' + ' '.repeat(400) + 'x', '1-'.repeat(240) + '시',
  'a.'.repeat(2000),
]) {
  assert.equal(getArrivalOpenStatus({ open: raw }, mondayNoon), 'needs_confirmation');
}
assert.ok(performance.now() - pathologicalStarted < 2000, '휴무·영업시간 해석이 병적인 입력에서 오래 걸린다');

// 괄호로 붙은 조건부 영업 안내('(공휴일 영업)')가 매주 휴무를 지우지 않는다(6차 검증).
for (const [closed, at] of [
  ['매주 화요일(공휴일 영업)', '2026-11-03'], ['휴무일: 매주 월요일 (공휴일 정상영업)', '2026-11-02'],
  ['정기휴무 매주 일요일 (공휴일 정상 영업)', '2026-11-01'], ['매주 일요일(단체 예약 시 영업)', '2026-11-01'],
  ['매주 월요일 (명절 당일 영업)', '2026-11-02'], ['매주 월요일 휴관(공휴일 개관)', '2026-11-02'],
]) {
  assert.equal(getArrivalOpenStatus({ open: '09:00~18:00', closed }, new Date(`${at}T12:00:00+09:00`)), 'closed_confirmed', closed);
}
assert.equal(closedDayStatus('영업: 월~금, 휴무: 토, 일', new Date('2026-11-02T12:00:00+09:00')), 'open');
assert.equal(closedDayStatus('토·일 운영, 월요일 휴무', new Date('2026-11-01T12:00:00+09:00')), 'open');

// 일요일 휴무 오판(2026-10-31) — '매주 월요일' 가게가 일요일 카드에서 '휴무' 로 빠지지 않는다.
const sundayNoon = new Date('2026-11-01T12:00:00+09:00');
assert.equal(isRecommendationOpen('restaurant', { open: '09:00~21:00', closed: '매주 월요일 휴무' }, sundayNoon), true);
assert.equal(isClosedToday('매주 화요일', sundayNoon), false);
assert.equal(isClosedToday('일요일 휴무', sundayNoon), true);

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
