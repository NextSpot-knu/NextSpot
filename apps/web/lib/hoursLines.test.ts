import assert from 'node:assert/strict';

import { hoursLines } from './hoursLines';

// 실제 TourAPI usetime 원문(도심 관광지·음식점, 2026-10-06).

// 경주 첨성대 — 철마다 한 줄.
assert.deepEqual(
  hoursLines('- 하절기 09:00~22:00- 동절기 09:00~21:00'),
  ['하절기 09:00~22:00', '동절기 09:00~21:00'],
);

// 천마총(대릉원) — '<br>' 이 글자로 보이지 않는다.
const daereungwon = hoursLines('- 정문 09:00~22:00 (입장 마감 21:30)<br>\n- 후문·천마총 09:00~21:30');
assert.deepEqual(daereungwon, ['정문 09:00~22:00 (입장 마감 21:30)', '후문·천마총 09:00~21:30']);
assert.ok(daereungwon.every((line) => !/<br/i.test(line)), '<br> 이 남았다');
assert.deepEqual(hoursLines('09:00~18:00<br/>(입장 마감 17:30)'), ['09:00~18:00', '(입장 마감 17:30)']);
assert.deepEqual(hoursLines('<b>09:00~18:00</b>'), ['09:00~18:00'], '다른 태그도 글자로 남지 않는다');

// '[머리]' 는 다음 시각과 한 줄 — 머리만 덩그러니 남지 않는다.
assert.deepEqual(
  hoursLines('[평일]- 09:00~18:00[주말 및 공휴일]- 4월~10월 09:00~19:00- 11월~3월 09:00~18:00'),
  ['[평일] 09:00~18:00', '[주말 및 공휴일] 4월~10월 09:00~19:00', '11월~3월 09:00~18:00'],
);

// 카카오식 요일 목록 — 요일과 시각이 짝으로 읽힌다. 범위의 '-' 는 나누지 않는다.
assert.deepEqual(
  hoursLines('수\n09:30 - 17:30\n목\n09:30 - 17:30'),
  ['수 09:30 - 17:30', '목 09:30 - 17:30'],
);
assert.deepEqual(hoursLines('매일 09:00 -18:00'), ['매일 09:00 -18:00']);
assert.deepEqual(hoursLines('09:00-18:00'), ['09:00-18:00']);
assert.deepEqual(hoursLines('상시 개방'), ['상시 개방']);
// 숫자 없는 긴 문장은 다음 줄과 붙이지 않는다.
assert.deepEqual(hoursLines('연중무휴\n10:00~21:00'), ['연중무휴', '10:00~21:00']);

// 빈 값.
assert.deepEqual(hoursLines(''), []);
assert.deepEqual(hoursLines('   '), []);
assert.deepEqual(hoursLines(null), []);
assert.deepEqual(hoursLines(undefined), []);

// 아주 긴 원문은 8줄에서 자른다.
assert.equal(hoursLines(Array.from({ length: 12 }, (_, i) => `- ${i + 1}관 09:00~18:00`).join('')).length, 8);

console.log('hoursLines tests passed');
