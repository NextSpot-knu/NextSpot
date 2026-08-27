import assert from 'node:assert/strict';
import {
  getGyeongjuHour,
  isGyeongjuNight,
  parseThemeMode,
  resolveTheme,
  supportsTouristTheme,
} from './theme';
import { THEME_MESSAGES } from './i18n/theme-messages';

const utc = (iso: string) => new Date(iso);

assert.equal(getGyeongjuHour(utc('2026-08-25T08:59:00Z')), 17);
assert.equal(getGyeongjuHour(utc('2026-08-25T09:00:00Z')), 18);
assert.equal(isGyeongjuNight(utc('2026-08-25T09:00:00Z')), true);
assert.equal(isGyeongjuNight(utc('2026-08-25T20:59:00Z')), true);
assert.equal(isGyeongjuNight(utc('2026-08-25T21:00:00Z')), false);
assert.equal(resolveTheme('auto', utc('2026-08-25T12:00:00Z')), 'dark');
assert.equal(resolveTheme('auto', utc('2026-08-25T03:00:00Z')), 'light');
assert.equal(resolveTheme('light', utc('2026-08-25T12:00:00Z')), 'light');
assert.equal(resolveTheme('dark', utc('2026-08-25T03:00:00Z')), 'dark');
assert.equal(parseThemeMode('unexpected'), 'auto');
assert.equal(parseThemeMode('dark'), 'dark');
assert.equal(supportsTouristTheme('/main'), true);
assert.equal(supportsTouristTheme('/mypage/settings'), true);
assert.equal(supportsTouristTheme('/admin/dashboard'), false);
assert.equal(supportsTouristTheme('/merchant'), false);

const koThemeKeys = Object.keys(THEME_MESSAGES.ko).sort();
for (const locale of ['en', 'ja', 'zh'] as const) {
  assert.deepEqual(Object.keys(THEME_MESSAGES[locale]).sort(), koThemeKeys);
}

console.log('theme tests passed');
