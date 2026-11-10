// 탭 막대 치수 — 막대가 보이는 경로 규칙과 F1 계산(docs/MOBILE_WEB_PARITY.md §4.2)을 잠근다.
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NAV_BAR_HEIGHT, NAV_CLEARANCE } from '../../lib/theme/tokens';
import { HIDDEN_TAB_ROUTES, MYPAGE_SUB_ROUTES, NAV_GAP, isTabRoute, navInsetsFor } from './navMetricsCore';

assert.equal(NAV_BAR_HEIGHT, 101);
assert.equal(NAV_CLEARANCE, 116);
assert.equal(NAV_GAP, 15);

for (const p of ['/', '/saved', '/waiting', '/course', '/mypage', '/mypage/settings', '/mypage/support/', '/explore/recommend', '/explore/map']) {
  assert.equal(isTabRoute(p), true, p);
}
// 탭 밖 화면 · 없는 하위 주소(+not-found 는 탭 밖에 그린다)
for (const p of ['/intro', '/login', '/setup', '/auth/callback', '/forgot-password', '/savedx', '/saved/x', '/explore', '/explore/x', '/mypage/x', '', null, undefined]) {
  assert.equal(isTabRoute(p), false, String(p));
}

// app/(tabs) 의 화면 파일이 모두 막대 경로이고, 목록에 있는 경로는 모두 파일이 있다(경로를 옮기거나 더하면 여기서 깨진다).
const TABS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../app/(tabs)');
function screenPaths(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...screenPaths(full, `${prefix}/${name}`));
      continue;
    }
    if (!name.endsWith('.tsx') || name.startsWith('_') || name.startsWith('+')) continue;
    const base = name.slice(0, -'.tsx'.length);
    out.push(base === 'index' ? prefix || '/' : `${prefix}/${base}`);
  }
  return out;
}
const files = screenPaths(TABS_DIR, '').sort();
for (const p of files) assert.equal(isTabRoute(p), true, `app/(tabs) 화면 ${p} 가 isTabRoute 목록에 없다`);
const listed = ['/', '/saved', '/waiting', '/course', '/mypage', ...MYPAGE_SUB_ROUTES.map((r) => `/mypage/${r}`), ...HIDDEN_TAB_ROUTES].sort();
assert.deepEqual(files, listed, 'isTabRoute 목록과 app/(tabs) 파일이 다르다');

const tab = navInsetsFor('/saved', 24);
assert.deepEqual({ gap: tab.gap, onTab: tab.onTab, barHeight: tab.barHeight, toastBottom: tab.toastBottom }, {
  gap: 15, onTab: true, barHeight: 125, toastBottom: 133,
});
assert.equal(tab.fromScreenBottom(350), 249); // 홈 알약 토스트(F10)

const off = navInsetsFor('/login', 24);
assert.deepEqual({ gap: off.gap, onTab: off.onTab, barHeight: off.barHeight, toastBottom: off.toastBottom }, {
  gap: 0, onTab: false, barHeight: 0, toastBottom: 40,
});
assert.equal(off.fromScreenBottom(350), 350);

console.log('ok navMetrics');
