import assert from 'node:assert/strict';

import { shadows } from '~/lib/theme/tokens';

import {
  BUTTON_DEFAULTS,
  LABEL_CLASS,
  VARIANT_SURFACE,
  defaultPaddingX,
  paddingYFor,
  shadowFor,
  splitLegacyLayout,
} from './buttonSpec';

// 기본값은 지금 모양(44 · 14/18 · 2xl · 16/8).
assert.equal(BUTTON_DEFAULTS.size, 44);
assert.equal(LABEL_CLASS[BUTTON_DEFAULTS.labelSize], 'text-[14px] leading-[18px]');
assert.equal(paddingYFor(44), 8);
assert.equal(paddingYFor(30), 6);
assert.equal(defaultPaddingX(44), 16);
assert.equal(defaultPaddingX(30), 12);

// gold 는 토큰 button-gold 하나만 읽는다 — bg-gold 가 아니다.
assert.equal(VARIANT_SURFACE.gold, 'bg-button-gold');
// 한 종류 클래스는 variant 마다 하나만(배경 클래스가 둘이면 CSS 순서로 진다).
for (const [name, cls] of Object.entries(VARIANT_SURFACE)) {
  assert.ok(cls.split(/\s+/).filter((c) => c.startsWith('bg-')).length <= 1, name);
}

// 그림자: auto 는 primary 활성일 때만 cta, 명시값은 비활성이어도 그린다.
assert.equal(shadowFor('auto', 'primary', false), shadows.cta);
assert.equal(shadowFor('auto', 'primary', true), undefined);
assert.equal(shadowFor('auto', 'gold', false), undefined);
assert.equal(shadowFor('none', 'primary', false), undefined);
assert.equal(shadowFor('ctaLg', 'primary', true), shadows.ctaLg);
assert.equal(shadowFor('ctaHero', 'gold', true), shadows.ctaHero);

// 지금 화면의 min-h·px 클래스는 style 값으로 옮기고 클래스에서는 뺀다.
assert.deepEqual(splitLegacyLayout('min-h-[52px]'), { className: undefined, minHeight: 52, paddingX: undefined });
assert.deepEqual(splitLegacyLayout('mt-[8px] min-h-[44px] px-[16px] flex-1'), {
  className: 'mt-[8px] flex-1',
  minHeight: 44,
  paddingX: 16,
});
assert.deepEqual(splitLegacyLayout(undefined), { className: undefined });
assert.equal(splitLegacyLayout('flex-1').minHeight, undefined);
// px-[…] 만 읽는다 — py-[…]·pl-[…] 은 그대로.
assert.equal(splitLegacyLayout('py-[8px] pl-[4px]').className, 'py-[8px] pl-[4px]');

console.log('buttonSpec ok');
