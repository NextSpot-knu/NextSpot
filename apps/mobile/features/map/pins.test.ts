import assert from 'node:assert/strict';

import { pinDisplay } from '@/lib/map/markerSvg';

import { markerAnchor, numberMarkerSize, pinContentKey, pinXml, svgXmlFromDataUri } from './pins';

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

console.log('pins.test OK');
