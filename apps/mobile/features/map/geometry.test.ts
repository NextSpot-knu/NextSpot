import assert from 'node:assert/strict';

import { REGION } from '@/lib/region';

import {
  circleRing,
  fitPaddingForInsets,
  fitRegion,
  googleZoomForKakaoLevel,
  isInRegion,
  kakaoLevelOf,
  kakaoLevelRounded,
  kakaoMetersPerPixel,
  metersPerPixel,
  projectToView,
  regionBounds,
  regionCenteredInBand,
  regionForKakaoLevel,
  regionFromCorners,
  unprojectFromView,
} from './geometry';
import { haversineMeters } from '@/lib/map/geo';

const center = { latitude: REGION.center.lat, longitude: REGION.center.lng };
const size = { width: 400, height: 800 };
const near = (a: number, b: number, eps: number, msg?: string) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} ≈ ${b} (±${eps})`);

// ── 카카오 level ↔ 영역 ──
assert.equal(kakaoMetersPerPixel(3), 1);
assert.equal(kakaoMetersPerPixel(5), 4);
for (const level of [1, 3, 4, 5, 7, 10]) {
  const r = regionForKakaoLevel(center, level, size);
  near(kakaoLevelOf(r, size), level, 1e-9, `level ${level} 왕복`);
  assert.equal(kakaoLevelRounded(r, size), level);
  near(metersPerPixel(r, size), 2 ** (level - 3), 1e-9);
}
// level 3(≈1m/px) 영역의 폭 400dp ≈ 400m, 높이 800dp ≈ 800m(메르카토르 지역 축척은 등방).
{
  const r = regionForKakaoLevel(center, 3, size);
  const b = regionBounds(r);
  near(haversineMeters(center.latitude, b.west, center.latitude, b.east), 400, 2, '가로 m');
  near(haversineMeters(b.south, center.longitude, b.north, center.longitude), 800, 6, '세로 m');
}
// 구글 확대 단계 — 경주에서 대략 z ≈ 20 − level.
near(googleZoomForKakaoLevel(3, center.latitude), 16.95, 0.05);
near(googleZoomForKakaoLevel(5, center.latitude), 14.95, 0.05);
// 에뮬레이터 실측(411×833dp, 홈 첫 화면 level 4): 구글 카메라 zoom 15.953 · 경도 폭 0.0091178° — 같은 식이 같은 값을 낸다.
{
  const phone = { width: 411.4285583496094, height: 833.1428833007812 };
  const at = { latitude: 35.83569639564571, longitude: 129.20944785699248 };
  near(googleZoomForKakaoLevel(4, at.latitude), 15.9535, 0.001, '실측 zoom');
  const r = regionForKakaoLevel(at, 4, phone);
  near(r.longitudeDelta, 0.009117834270000458, 1e-6, '실측 경도 폭');
  near(kakaoLevelOf({ ...at, longitudeDelta: 0.009117834270000458, latitudeDelta: 0.014968199898248713 }, phone), 4, 0.01, '실측 영역 → level');
  // 같은 level 은 같은 축척 — 웹 390px 폰은 ≈780m, 앱 411dp 폰은 ≈823m 를 가로로 보인다.
  const web = regionBounds(regionForKakaoLevel(at, 4, { width: 390, height: 844 }));
  near(haversineMeters(at.latitude, web.west, at.latitude, web.east), 780, 3, '웹 폭 m');
  const app = regionBounds(r);
  near(haversineMeters(at.latitude, app.west, at.latitude, app.east), 823, 3, '앱 폭 m');
}

// ── 투영 ──
{
  const r = regionForKakaoLevel(center, 4, size);
  const mid = projectToView(center, r, size);
  near(mid.x, 200, 1e-6);
  near(mid.y, 400, 0.05); // 가운데 ± 폭/2 경계라 메르카토르 가운데와 아주 조금 어긋난다
  const b = regionBounds(r);
  const nw = projectToView({ latitude: b.north, longitude: b.west }, r, size);
  near(nw.x, 0, 1e-6);
  near(nw.y, 0, 1e-6);
  const back = unprojectFromView({ x: 123, y: 456 }, r, size);
  const again = projectToView(back, r, size);
  near(again.x, 123, 1e-6);
  near(again.y, 456, 1e-6);
  // 동쪽으로 100m = level 4(2m/px) 에서 50dp.
  const east = { latitude: center.latitude, longitude: center.longitude + 100 / (111_320 * Math.cos((center.latitude * Math.PI) / 180)) };
  near(projectToView(east, r, size).x - mid.x, 50, 1e-6);
  assert.ok(isInRegion(center, r));
  assert.ok(!isInRegion({ latitude: b.north + 1e-6, longitude: center.longitude }, r));
}
{
  const r = regionFromCorners({ latitude: 35.85, longitude: 129.24 }, { latitude: 35.82, longitude: 129.19 });
  near(r.latitude, 35.835, 1e-9);
  near(r.longitudeDelta, 0.05, 1e-9);
}

// ── 영역 맞춤 ──
assert.equal(fitRegion([], size), null);
{
  const pts = REGION.presets.map((p) => ({ latitude: p.lat, longitude: p.lng }));
  const pad = { top: 80, right: 40, bottom: 40, left: 40 };
  const r = fitRegion(pts, size, pad, { minLevel: 1 })!;
  for (const p of pts) {
    const pt = projectToView(p, r, size);
    assert.ok(pt.x >= pad.left - 0.5 && pt.x <= size.width - pad.right + 0.5, `x ${pt.x}`);
    assert.ok(pt.y >= pad.top - 0.5 && pt.y <= size.height - pad.bottom + 0.5, `y ${pt.y}`);
  }
  // 가로가 꽉 맞는다(경주 프리셋은 가로로 넓다) — 가장 왼쪽·오른쪽 점이 패딩 경계에 닿는다.
  const xs = pts.map((p) => projectToView(p, r, size).x);
  near(Math.min(...xs), pad.left, 0.5);
  near(Math.max(...xs), size.width - pad.right, 0.5);
}
{
  // 점 하나 — 확대 하한(level 4)에서 멈추고, 패딩 띠의 가운데에 선다.
  const r = fitRegion([center], size, { top: 200, bottom: 0, left: 0, right: 0 }, { minLevel: 4 })!;
  near(kakaoLevelOf(r, size), 4, 1e-3); // 가운데가 띠만큼 북쪽으로 옮겨 cos(위도)가 아주 조금 다르다
  const pt = projectToView(center, r, size);
  near(pt.x, 200, 1e-6);
  near(pt.y, 200 + 600 / 2, 0.1);
}
{
  // 패딩이 상자를 넘쳐도 영역이 나온다(안쪽 1/4 은 남긴다).
  const r = fitRegion([center, { latitude: center.latitude + 0.01, longitude: center.longitude + 0.01 }], size, { top: 900, bottom: 900 });
  assert.ok(r && Number.isFinite(r.latitudeDelta) && r.latitudeDelta > 0);
}

// ── 보이는 띠 가운데 맞춤(웹 centerOnFreeArea) ──
{
  const r0 = regionForKakaoLevel(center, 4, size);
  const insets = { top: 100, bottom: 300 };
  const r = regionCenteredInBand(center, size, insets, { region: r0 });
  const pt = projectToView(center, r, size);
  near(pt.x, 200, 1e-6);
  near(pt.y, 100 + (800 - 100 - 300) / 2, 0.1); // 띠 100..500 의 가운데 = 300
  near(kakaoLevelOf(r, size), 4, 1e-3); // 가운데가 띠만큼 북쪽으로 옮겨 cos(위도)가 아주 조금 다르다
  const r5 = regionCenteredInBand(center, size, {}, { level: 5 });
  near(kakaoLevelOf(r5, size), 5, 1e-9);
  near(projectToView(center, r5, size).y, 400, 0.1);
}

// ── 패딩 규칙(웹 fitAttributePins) ──
assert.deepEqual(fitPaddingForInsets({ top: 120, bottom: 200 }, size), { top: 136, right: 24, bottom: 216, left: 24 });
assert.deepEqual(fitPaddingForInsets({ top: 900, bottom: 900, right: 50 }, size), { top: 416, right: 66, bottom: 336, left: 24 });

// ── 원 고리 ──
{
  const ring = circleRing(center, 600, 36);
  assert.equal(ring.length, 37);
  assert.deepEqual(ring[0], ring[36]);
  for (const p of ring) near(haversineMeters(center.latitude, center.longitude, p.latitude, p.longitude), 600, 3);
}

console.log('geometry.test OK');
