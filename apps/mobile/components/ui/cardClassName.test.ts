import assert from 'node:assert/strict';

import { CARD_BORDER_COLOR, cardClassName } from './cardClassName';

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
const has = (s: string, c: string) => set(s).has(c);

// 아무것도 안 주면 지금 모양 그대로.
assert.deepEqual(set(cardClassName(undefined, true)), set('rounded-2xl border border-line bg-white p-[16px]'));
assert.deepEqual(set(cardClassName('', false)), set('rounded-2xl border border-line bg-white'));

// 바탕·테두리 색을 주면 기본 색이 빠진다(G5b-03 — 덧붙이면 bg-white·border-line 이 CSS 순서로 이긴다).
{
  const c = cardClassName('bg-gold/10 border-gold/35', true);
  assert.ok(!has(c, 'bg-white') && !has(c, 'border-line'), c);
  assert.ok(has(c, 'border') && has(c, 'rounded-2xl') && has(c, 'p-[16px]'), c);
}
assert.ok(!has(cardClassName('bg-hanji-deep', true), 'bg-white'));
assert.ok(has(cardClassName('bg-hanji-deep', true), 'border-line'));
assert.ok(!has(cardClassName('border-[#c19a3e]', true), 'border-line'));
assert.ok(!has(cardClassName('border-transparent', true), 'border-line'));
// 상태 변형(active:·web:)은 기본값을 빼지 않는다.
assert.ok(has(cardClassName('active:bg-gold/10', true), 'bg-white'));

// R3 ③: 선 모양·두께·방향은 색이 아니다 — 기본 border-line 이 남아야 RN 기본 검정 테두리가 안 된다.
for (const notColor of [
  'border',
  'border-dashed',
  'border-solid',
  'border-dotted',
  'border-double',
  'border-hidden',
  'border-none',
  'border-0',
  'border-2',
  'border-[1.5px]',
  'border-t',
  'border-t-2',
  'border-x',
  'border-b-[2px]',
  'border-s',
  'border-e-4',
  'border-y-0',
]) {
  assert.ok(!CARD_BORDER_COLOR.test(notColor), notColor);
  assert.ok(has(cardClassName(notColor, true), 'border-line'), notColor);
}
for (const color of ['border-line', 'border-gold', 'border-gold/35', 'border-jade/35', 'border-terracotta/35', 'border-white', 'border-muk', 'border-sky-500-web', 'border-[#abc]', 'border-transparent']) {
  assert.ok(CARD_BORDER_COLOR.test(color), color);
}

// 네 변 두께를 주면 기본 1px(border)이 빠지고, 방향 두께는 기본 위에 덮인다.
assert.ok(!has(cardClassName('border-2', true), 'border'));
assert.ok(!has(cardClassName('border-0', true), 'border'));
assert.ok(!has(cardClassName('border-[1.5px] border-dashed', true), 'border'));
assert.ok(has(cardClassName('border-t-2', true), 'border'));

// 둥글기: 네 모서리를 주면 기본이 빠지고, 한쪽 모서리는 기본이 남는다.
for (const r of ['rounded', 'rounded-3xl', 'rounded-xl', 'rounded-none', 'rounded-full', 'rounded-[20px]']) {
  assert.ok(!has(cardClassName(r, true), 'rounded-2xl'), r);
}
assert.ok(has(cardClassName('rounded-t-3xl', true), 'rounded-2xl'));

// 여백은 padded 만 본다 — 다른 여백은 padded={false} 와 함께(R3 ④).
assert.ok(has(cardClassName('p-[20px]', true), 'p-[16px]'));
assert.ok(!has(cardClassName('p-[20px]', false), 'p-[16px]'));
assert.ok(has(cardClassName('p-[20px]', false), 'p-[20px]'));

// 화면 클래스는 하나도 잃지 않는다.
{
  const given = 'mt-[12px] overflow-hidden bg-gold/5 border-gold/40 rounded-3xl gap-[8px]';
  const c = set(cardClassName(given, false));
  for (const k of given.split(' ')) assert.ok(c.has(k), k);
}

console.log('cardClassName ok');
