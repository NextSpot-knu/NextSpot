import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

// 야간 팔레트는 흰 서페이스 유틸을 하나하나 바꿔 낀다(globals.css) — 빠진 불투명도가 있으면 그 요소만 밤에
// 흰 알약으로 남는다(10-06: 음식 세부 칩 bg-white/85 가 어두운 지도 위에서 흐린 회색 알약 + 흐린 금색 글자).
{
  const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
  const used = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.tsx')) {
        for (const m of readFileSync(path, 'utf8').matchAll(/\bbg-white\/(\[[0-9.]+\]|\d+)/g)) used.add(m[1]);
      }
    }
  };
  walk(join(process.cwd(), 'app'));
  walk(join(process.cwd(), 'components'));
  assert.ok(used.size > 0, 'bg-white/N 유틸을 하나도 찾지 못했다');
  for (const opacity of used) {
    // CSS 선택자에서는 '/'·'['·']'·'.' 를 백슬래시로 escape 한다(globals.css 의 표기 그대로).
    const escaped = opacity.replace(/[[\].]/g, (c) => '\\' + c);
    const selector = 'html.nextspot-dark .bg-white\\/' + escaped + ' {';
    assert.ok(css.includes(selector), `야간 팔레트에 bg-white/${opacity} 치환이 없다 — ${selector}`);
  }
}

console.log('theme tests passed');
