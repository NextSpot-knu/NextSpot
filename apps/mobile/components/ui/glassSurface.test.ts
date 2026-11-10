import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { colors } from '~/lib/theme/tokens';

import { GLASS_BACKDROP_LIGHT, GLASS_BG_NO_BLUR, GLASS_SHADOW_LIGHT, glassSurface } from './glassSurface';

const env = { os: 'web', androidApi: 0, reduceTransparency: false, hasBlurTarget: false };

// 웹 빌드 = 웹 .liquid-glass 그대로
const web = glassSurface('light', env);
assert.equal(web.tint, colors['glass-bg']);
assert.equal(web.blur, 'css');
assert.equal(web.backdropFilter, 'blur(8px) saturate(180%)');
assert.equal(web.border, colors['glass-edge']);
assert.equal(web.sheen, true);
assert.ok(web.boxShadow.startsWith('inset 0px 1px 0px rgba(255, 255, 255, 0.95)'));

// iOS: 흐림 + 35%
assert.deepEqual(glassSurface('light', { ...env, os: 'ios' }).blur, 'native');
// 안드로이드 D14: SDK 31+ 이고 흐릴 대상이 있을 때만 흐림 + 35%(①), 아니면 70%(③)
const a31 = glassSurface('light', { ...env, os: 'android', androidApi: 34, hasBlurTarget: true });
assert.equal(a31.blur, 'native');
assert.equal(a31.tint, colors['glass-bg']);
const aNoTarget = glassSurface('light', { ...env, os: 'android', androidApi: 34 });
assert.equal(aNoTarget.blur, 'none');
assert.equal(aNoTarget.tint, GLASS_BG_NO_BLUR);
assert.equal(glassSurface('light', { ...env, os: 'android', androidApi: 30, hasBlurTarget: true }).blur, 'none');
// 투명도 줄이기: 불투명 한지 + 진한 테두리, 광택 없음
const reduced = glassSurface('light', { ...env, os: 'ios', reduceTransparency: true });
assert.equal(reduced.tint, colors.hanji);
assert.equal(reduced.sheen, false);
assert.equal(reduced.border, colors['muk-soft']);
// rail
const rail = glassSurface('rail', env);
assert.equal(rail.tint, colors['rail-bg']);
assert.equal(rail.backdropFilter, 'blur(16px) saturate(160%)');
assert.equal(rail.sheen, false);

// 웹 globals.css 값과 대조 — 웹이 바뀌면 여기서 걸린다.
const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(HERE, '../../../web/app/globals.css'), 'utf8').replace(/\s+/g, ' ');
assert.ok(css.includes(`backdrop-filter: ${GLASS_BACKDROP_LIGHT};`));
assert.ok(
  css.includes(
    '--glass-shadow: inset 0 1px 0 rgb(255 255 255 / 0.95), inset 0 -1px 0 rgb(255 255 255 / 0.35), 0 6px 22px rgb(43 35 32 / 0.16);',
  ),
);
assert.ok(GLASS_SHADOW_LIGHT.includes('inset 0px -1px 0px rgba(255, 255, 255, 0.35)'));
assert.ok(css.includes('--glass-sheen: linear-gradient(180deg, rgb(255 255 255 / 0.22), rgb(255 255 255 / 0) 45%);'));

console.log('ok glassSurface');
