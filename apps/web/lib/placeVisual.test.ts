// 사진 없는 장소의 표지 — 장소마다 결정적으로, 한 줄 안에서는 서로 다르게, 대기 등급 색과는 겹치지 않게.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLACE_MOTIFS,
  PLACE_TONES,
  PLACE_TONE_VAR,
  hashPlaceId,
  placeGlyph,
  placeVisual,
  placeVisualsForRow,
  type PlaceMotif,
  type PlaceTone,
} from './placeVisual';

const ids = Array.from({ length: 300 }, (_, i) => `kakao-${i * 7919 + 13}`);

// --- 결정적: 같은 id·유형은 언제나 같은 표지 ------------------------------------------------
for (const id of ids.slice(0, 50)) {
  assert.deepEqual(placeVisual(id, 'cafe'), placeVisual(id, 'cafe'));
  assert.equal(hashPlaceId(id), hashPlaceId(id));
}
// 고정 기대값(FNV-1a 32bit) — 해시가 바뀌면(구현 변경) 여기서 잡힌다. 바뀌면 모든 장소의 표지가 바뀐다.
assert.equal(hashPlaceId(''), 0x811c9dc5);
assert.equal(hashPlaceId('a'), 0xe40c292c);
// 유형은 그림만 바꾼다 — 같은 장소의 문양·색은 유형과 무관.
{
  const a = placeVisual('f-1', 'restaurant');
  const b = placeVisual('f-1', 'culture');
  assert.equal(a.motif, b.motif);
  assert.equal(a.tone, b.tone);
  assert.notEqual(a.glyph, b.glyph);
}
// 빈 id 도 터지지 않는다.
assert.ok(PLACE_MOTIFS.includes(placeVisual('', undefined).motif));

// --- 여러 장소에 고르게 퍼진다(한두 가지로 몰리면 '같은 자리표시' 로 보인다) -----------------------
{
  const motifs = new Map<PlaceMotif, number>();
  const tones = new Map<PlaceTone, number>();
  const combos = new Set<string>();
  for (const id of ids) {
    const v = placeVisual(id, 'restaurant');
    motifs.set(v.motif, (motifs.get(v.motif) ?? 0) + 1);
    tones.set(v.tone, (tones.get(v.tone) ?? 0) + 1);
    combos.add(`${v.motif}/${v.tone}`);
    assert.ok(v.phase >= 0 && v.phase <= 1, 'phase 0~1');
  }
  for (const m of PLACE_MOTIFS) assert.ok((motifs.get(m) ?? 0) >= ids.length * 0.1, `문양 ${m} 이 너무 드물다`);
  for (const t of PLACE_TONES) assert.ok((tones.get(t) ?? 0) >= ids.length * 0.15, `색 ${t} 이 너무 드물다`);
  assert.equal(combos.size, PLACE_MOTIFS.length * PLACE_TONES.length, '문양×색 조합이 전부 나온다');
}

// --- 한 줄(대표 카드 3장)은 문양이 서로 다르다 — 사진 없는 세 장이 같은 무늬로 반복되지 않는다 ----------
for (let i = 0; i + 3 <= ids.length; i++) {
  const row = placeVisualsForRow(ids.slice(i, i + 3).map((id) => ({ id, type: 'cafe' })));
  assert.equal(new Set(row.map((v) => v.motif)).size, 3, `줄 ${i}: 문양이 겹친다`);
  // 첫 카드는 자기 표지 그대로, 색은 누구도 바뀌지 않는다.
  assert.deepEqual(row[0], placeVisual(ids[i], 'cafe'));
  row.forEach((v, k) => assert.equal(v.tone, placeVisual(ids[i + k], 'cafe').tone));
}
// 문양 수만큼은 전부 달라진다.
{
  const five = placeVisualsForRow(ids.slice(0, 5).map((id) => ({ id, type: 'restaurant' })));
  assert.equal(new Set(five.map((v) => v.motif)).size, 5);
}
// 같은 id 가 두 번 와도(비정상 입력) 결정적이고 터지지 않는다.
assert.deepEqual(
  placeVisualsForRow([{ id: 'dup', type: 'cafe' }, { id: 'dup', type: 'cafe' }]),
  placeVisualsForRow([{ id: 'dup', type: 'cafe' }, { id: 'dup', type: 'cafe' }]),
);

// --- 유형 그림: 유형마다 다르고, 모르는 유형은 default ------------------------------------------
{
  const glyphs = ['restaurant', 'cafe', 'attraction', 'culture'].map(placeGlyph);
  assert.equal(new Set(glyphs).size, 4);
  assert.equal(placeGlyph('lodging'), 'default');
  assert.equal(placeGlyph(''), 'default');
  assert.equal(placeGlyph(undefined), 'default');
  assert.equal(placeGlyph(null), 'default');
}

// --- 표지 색은 대기 등급 색(terracotta 혼잡 · gold 보통 · jade 여유)을 피한다 --------------------------
// 1) 변수 이름이 등급 토큰을 가리키지 않는다.
for (const v of Object.values(PLACE_TONE_VAR)) {
  assert.match(v, /^--nextspot-tile-/);
  assert.doesNotMatch(v, /terracotta|gold|jade|dan-red|sunset/);
}
// 2) 실제 색(라이트·야간 둘 다)이 등급 색과 색상(hue)이 30° 이상 멀거나, 거의 무채색이다.
const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} 블록이 없다`);
  return css.slice(start, css.indexOf('}', start));
}
function hex(src: string, name: string): string {
  const m = src.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(m, `${name} 값이 없다`);
  return m[1];
}
function hsl(h: string): { hue: number; sat: number } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d !== 0) {
    if (max === r) hue = 60 * (((g - b) / d) % 6);
    else if (max === g) hue = 60 * ((b - r) / d + 2);
    else hue = 60 * ((r - g) / d + 4);
  }
  return { hue: (hue + 360) % 360, sat };
}
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
for (const selector of [':root', 'html.nextspot-dark']) {
  const src = block(selector);
  const grades = ['--nextspot-terracotta', '--nextspot-gold', '--nextspot-gold-deep', '--nextspot-jade'].map((n) => hsl(hex(src, n)));
  for (const tone of PLACE_TONES) {
    const c = hex(src, PLACE_TONE_VAR[tone]);
    const t = hsl(c);
    for (const g of grades) {
      const neutral = t.sat < 0.15;
      assert.ok(
        neutral || hueGap(t.hue, g.hue) >= 30,
        `${selector} ${tone} ${c}: 등급 색과 색상이 가깝다(색상 차 ${hueGap(t.hue, g.hue).toFixed(0)}°, 채도 ${t.sat.toFixed(2)})`,
      );
    }
  }
  // 섞음 비율이 있어야 판이 카드 바탕과 갈린다.
  assert.match(src, /--nextspot-tile-mix:\s*\d+%/);
}

console.log('placeVisual: ok');
