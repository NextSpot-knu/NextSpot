// 탭 막대 치수 — 웹 BottomNav 의 경로 규칙과 F1 계산(docs/MOBILE_WEB_PARITY.md §4.2)을 잠근다.
import assert from 'node:assert/strict';

import { NAV_BAR_HEIGHT, NAV_CLEARANCE } from '../../lib/theme/tokens';
import { NAV_GAP, isTabRoute, navInsetsFor } from './navMetricsCore';

assert.equal(NAV_BAR_HEIGHT, 101);
assert.equal(NAV_CLEARANCE, 116);
assert.equal(NAV_GAP, 15);

for (const p of ['/', '/saved', '/waiting', '/course', '/mypage', '/mypage/settings', '/explore/recommend', '/explore/map']) {
  assert.equal(isTabRoute(p), true, p);
}
for (const p of ['/intro', '/login', '/setup', '/auth/callback', '/forgot-password', '/savedx', '', null, undefined]) {
  assert.equal(isTabRoute(p), false, String(p));
}

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
