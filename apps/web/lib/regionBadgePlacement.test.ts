// 떠 있는 내부 지역 배지(components/shell/RegionBadge)를 그리는 화면 — 위쪽 줄에 지역 스위처가 있는 화면(/main)은
// 배지가 스위처를 덮으므로(390px: 배지 x128~262 · 스위처 x133~250, 같은 줄) 그리지 않고 스위처 자체가 내부 지역을 표시한다.
// node:assert 독립 스크립트(scripts/run-web-tests.mjs 가 돌린다).

import assert from 'node:assert/strict';
import { showsFloatingRegionBadge } from './regionBadgePlacement';

for (const path of ['/main', '/main/', '/main/index.html']) {
  assert.equal(showsFloatingRegionBadge(path), false, `${path}: 배지가 지역 스위처를 덮는다`);
}
for (const path of ['/mypage', '/mypage/', '/waiting', '/explore/recommend', '/course', '/saved', '/', '/mainstreet']) {
  assert.equal(showsFloatingRegionBadge(path), true, `${path}: 내부 지역 표시가 사라졌다`);
}
// 경로를 아직 모르면(첫 렌더) 배지를 그린다 — 내부 지역 표시가 빠지는 쪽보다 겹치는 쪽이 덜 위험하다.
assert.equal(showsFloatingRegionBadge(null), true);
assert.equal(showsFloatingRegionBadge(undefined), true);

console.log('regionBadgePlacement tests passed');
