import assert from 'node:assert/strict';

import { pinDisplay } from '@/lib/map/markerSvg';

import {
  DEFAULT_PIN,
  DEFAULT_PIN_XML,
  MAP_UNAVAILABLE_GRADIENT,
  markerAnchor,
  numberMarkerSize,
  pinContentKey,
  pinXml,
  searchLabelAnchor,
  svgXmlFromDataUri,
  USER_DOT,
  userHaloStops,
} from './pins';

const now = new Date('2026-11-02T03:00:00Z');
const fresh = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

// 등급 채움 핀
{
  const d = pinDisplay({ type: 'cafe', level: 0.9, observedAt: fresh, now, phone: true });
  const xml = pinXml(d, 'cafe');
  assert.ok(xml.startsWith('<svg'));
  assert.ok(xml.includes('fill="#b91c1c"'), '혼잡 = red 700');
  assert.ok(!xml.includes('%3C'), 'URI 인코딩이 풀렸다');
  assert.ok(pinXml(d, 'cafe', { selected: true }).includes('#dc2626'), '선택 = 한 단계 밝게');
}
// 빈 핀(근거 없음)
{
  const d = pinDisplay({ type: 'restaurant', level: null, now });
  assert.equal(d.style, 'hollow');
  assert.ok(pinXml(d, 'restaurant').includes('#fffaf0'));
  assert.ok(pinXml(d, 'restaurant', { dark: true }).includes('#3a3027'));
}
// 금색 순위 고리 + 번호
{
  const d = pinDisplay({ type: 'attraction', level: null, rank: 2, now });
  const xml = pinXml(d, 'attraction');
  assert.ok(xml.includes('#c19a3e'));
  assert.ok(xml.includes('>2</text>'));
}
// 예측 점선
{
  const d = pinDisplay({ type: 'culture', level: null, rank: 1, forecastMode: true, forecastLevel: 0.1, now });
  assert.ok(pinXml(d, 'culture').includes('stroke-dasharray="4 3"'));
}
// 키는 그림이 바뀔 때만 바뀐다
{
  const d = pinDisplay({ type: 'cafe', level: null, now });
  assert.equal(pinContentKey(d, 'cafe'), pinContentKey({ ...d }, 'cafe'));
  assert.notEqual(pinContentKey(d, 'cafe'), pinContentKey(d, 'cafe', { selected: true }));
}
assert.equal(svgXmlFromDataUri('data:image/svg+xml,%3Csvg%2F%3E'), '<svg/>');
assert.deepEqual(numberMarkerSize(true), { size: 34, fontSize: 14 });
assert.deepEqual(numberMarkerSize(false), { size: 28, fontSize: 12 });
assert.deepEqual(markerAnchor('bottom', 50), { anchor: { x: 0.5, y: 1 }, centerOffset: { x: 0, y: -25 } });
assert.deepEqual(markerAnchor('center', 20).anchor, { x: 0.5, y: 0.5 });
// 검색 이름표 — 웹 yAnchor 3.2. 애플 centerOffset 은 그림 가운데를 (3.2 − 0.5)×높이 위로.
{
  const a = markerAnchor('search', 26.5);
  assert.deepEqual(a.anchor, { x: 0.5, y: 3.2 });
  assert.ok(Math.abs(a.centerOffset.y - -26.5 * 2.7) < 1e-9);
  const zero = searchLabelAnchor(0);
  assert.ok(Math.abs(zero.anchor.y - 3.2) < 1e-9 && Math.abs(zero.centerOffset.y - a.centerOffset.y) < 1e-9, '여백 0 = markerAnchor');
  // 여백 12 를 둘러도 좌표는 이름표 위끝 + 3.2×26.5 자리.
  const padded = searchLabelAnchor(12);
  assert.ok(Math.abs(padded.anchor.y * (26.5 + 24) - (12 + 3.2 * 26.5)) < 1e-9);
}
// 카카오 기본 마커 — 그림 29×42 의 (14, 39)가 좌표(웹 실측 margin -39px 0 0 -14px).
{
  assert.deepEqual(DEFAULT_PIN, { width: 29, height: 42, anchorX: 14, anchorY: 39 });
  const a = markerAnchor('defaultPin', 0);
  assert.deepEqual(a.anchor, { x: 14 / 29, y: 39 / 42 });
  assert.deepEqual(a.centerOffset, { x: 0.5, y: -18 });
  assert.ok(DEFAULT_PIN_XML.startsWith('<svg') && DEFAULT_PIN_XML.includes('width="29" height="42"'));
  assert.ok(DEFAULT_PIN_XML.includes('#238cfa'), '카카오 기본 마커 파랑');
}
// 내 위치 점 — 웹 halo 100 · 코스 plain 먹 8 + 흰 테 3(= 14) + 번짐 4(= 22).
{
  assert.equal(USER_DOT.halo.outer, 100);
  assert.equal(USER_DOT.plain.core + USER_DOT.plain.border * 2, 14);
  assert.equal(USER_DOT.plain.outer, 22);
  // CSS radial-gradient(circle) 는 farthest-corner(√2·r) — 원 반지름 기준 정지점 0 · 0.707 · 1(투명도 ≈ 0.062).
  const stops = userHaloStops();
  assert.equal(stops.length, 3);
  assert.deepEqual(stops[0], { offset: 0, opacity: 0.6 });
  assert.ok(Math.abs(stops[1].offset - Math.SQRT1_2) < 1e-9 && stops[1].opacity === 0.2);
  assert.equal(stops[2].offset, 1);
  assert.ok(Math.abs(stops[2].opacity - 0.2 * (1 - (1 - Math.SQRT1_2) / (0.8 * Math.SQRT2 - Math.SQRT1_2))) < 1e-9);
  assert.ok(stops[2].opacity > 0.05 && stops[2].opacity < 0.07);
}
assert.equal(MAP_UNAVAILABLE_GRADIENT.length, 3);

console.log('pins.test OK');
