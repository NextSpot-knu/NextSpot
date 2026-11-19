import assert from 'node:assert/strict';

import { declutterPins, groupSameBuilding, markerLimit, normalizeAddress, PIN_GAP_PX } from './declutter';
import { regionForKakaoLevel } from './geometry';

const base = { latitude: 35.8362, longitude: 129.2095 };
const size = { width: 400, height: 800 };
const mPerDegLng = 111_320 * Math.cos((base.latitude * Math.PI) / 180);
/** base 에서 동쪽 dx m, 북쪽 dy m. */
const at = (dx: number, dy = 0) => ({ latitude: base.latitude + dy / 111_320, longitude: base.longitude + dx / mPerDegLng });
const place = (id: string, dx: number, dy = 0, address: string | null = null) => ({ id, address, ...at(dx, dy) });

// ── 상한 ──
assert.equal(markerLimit(2), 12);
assert.equal(markerLimit(3), 12);
assert.equal(markerLimit(4), 7);
assert.equal(markerLimit(5), 5);
assert.equal(markerLimit(9), 5);
assert.equal(markerLimit(9, true), 12);
assert.equal(normalizeAddress(' 경북 경주시  포석로 1080 '), '경북경주시포석로1080');

// ── 같은 건물 묶기 ──
{
  const addr = '경북 경주시 포석로 1080';
  const clusters = groupSameBuilding([
    place('b', 0, 0, addr),
    place('a', 10, 0, '경북 경주시 포석로1080'), // 공백만 다름 · 10m → 묶임
    place('c', 40, 0, addr), // 같은 주소지만 40m → 따로
    place('d', 5, 0, '경주시 황남동'), // 짧은 주소(8자 미만)는 같아도 안 묶는다
    place('e', 6, 0, '경주시 황남동'),
    place('f', 3, 0, null),
  ]);
  assert.deepEqual(clusters.map((c) => c.key), ['building:a,b', 'c', 'd', 'e', 'f']);
  assert.equal(clusters[0].anchor.id, 'b'); // 대표는 첫 구성원(실제 좌표)
  assert.equal(clusters[0].members.length, 2);
}

// ── 지도 없음(영역 모름) → 앞에서 자른다 ──
{
  const many = Array.from({ length: 20 }, (_, i) => place(String(i), i * 500));
  assert.equal(declutterPins(many, null).length, 7);
  assert.equal(declutterPins(many, null, { searching: true }).length, 12);
}

// ── 영역 밖은 빠진다 · 간격 · 상한 ──
{
  const region = regionForKakaoLevel(base, 4, size); // 2m/px → 52dp = 104m, 40dp = 80m
  const items = [
    place('first', 0),
    place('tooClose', 90), // 45dp — 평소엔 빠지고 검색 중(40dp)엔 남는다
    place('far', 0, 300),
    place('outside', 5_000), // 영역 밖
  ];
  assert.deepEqual(declutterPins(items, { region, size }).map((c) => c.key), ['first', 'far']);
  assert.deepEqual(declutterPins(items, { region, size }, { searching: true }).map((c) => c.key), ['first', 'tooClose', 'far']);
  assert.equal(PIN_GAP_PX.normal, 52);

  // 120m 격자 40개 — 서로 60dp 라 간격은 통과, level 4 상한 7 에서 멈춘다.
  const grid = Array.from({ length: 40 }, (_, i) => place(`g${i}`, ((i % 3) - 1) * 120, (Math.floor(i / 3) - 6) * 120));
  assert.equal(declutterPins(grid, { region, size }).length, 7);
  const region3 = regionForKakaoLevel(base, 3, size); // 1m/px
  assert.equal(declutterPins(grid, { region: region3, size }).length, 12);
  const region5 = regionForKakaoLevel(base, 5, size);
  assert.equal(declutterPins(grid, { region: region5, size }).length, 5);
}

// ── 순서가 우선순위다 — 먼저 온 것이 자리를 차지한다 ──
{
  const region = regionForKakaoLevel(base, 4, size);
  const out = declutterPins([place('rank1', 30), place('other', 0)], { region, size });
  assert.deepEqual(out.map((c) => c.key), ['rank1']);
}

// ── 묶음은 핀 하나로 간격을 잰다 ──
{
  const region = regionForKakaoLevel(base, 4, size);
  const addr = '경북 경주시 포석로 1080';
  const out = declutterPins([place('x', 0, 0, addr), place('y', 8, 0, addr), place('z', 0, 400)], { region, size });
  assert.deepEqual(out.map((c) => c.key), ['building:x,y', 'z']);
}

console.log('declutter.test OK');
