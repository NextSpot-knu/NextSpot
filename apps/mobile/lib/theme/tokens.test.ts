// 웹 globals.css 와 앱 토큰이 어긋나지 않게 잠근다 — 웹에서 색을 바꾸고 앱을 잊으면 여기서 깨진다.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NAV_BAR_HEIGHT, NAV_CLEARANCE, colors, fontFamilies, ratios, springs, weightClassToName } from './tokens';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, '../..');
const css = readFileSync(resolve(MOBILE, '../web/app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function block(selectorRe: RegExp): string {
  const m = selectorRe.exec(css);
  assert.ok(m, `globals.css 에서 ${selectorRe} 를 찾지 못했다`);
  const start = m.index + m[0].length;
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

function vars(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

const C = colors as Record<string, string>;

// 1) :root(라이트) 의 모든 변수 — 색은 같은 hex, 퍼센트는 ratios, 웹 배치 전용 값만 이유를 달고 뺀다.
const LAYOUT_ONLY = new Set([
  '--tourist-nav-clearance', // 웹 하단 탭 여백(넓은 화면 80) — 모바일 폭 116 은 아래 3d 에서 NAV_CLEARANCE 와 대조
  '--rail-gutter', // 웹 데스크톱 왼쪽 캡슐 여백 — 앱에는 데스크톱 배치가 없다
]);
const PERCENT_TO_RATIO: Record<string, keyof typeof ratios> = {
  '--nextspot-glass-tint': 'glassTint',
  '--nextspot-tile-mix': 'tileMix',
};
const root = vars(block(/:root\s*\{/));
assert.ok(root.size >= 25, `:root 변수가 너무 적다(${root.size}) — 파서가 엉뚱한 블록을 읽었다`);
let checked = 0;
for (const [name, value] of root) {
  if (LAYOUT_ONLY.has(name)) continue;
  if (name in PERCENT_TO_RATIO) {
    const pct = /^([\d.]+)%$/.exec(value);
    assert.ok(pct, `${name} 는 퍼센트여야 한다: ${value}`);
    assert.equal(ratios[PERCENT_TO_RATIO[name]], Number(pct[1]) / 100, `${name} ↔ ratios.${PERCENT_TO_RATIO[name]}`);
    checked++;
    continue;
  }
  const key = name.replace(/^--nextspot-/, '').replace(/^--/, '');
  assert.ok(key in C, `웹 :root ${name} 에 맞는 앱 토큰 colors['${key}'] 가 없다`);
  assert.equal(C[key].toLowerCase(), value.toLowerCase(), `${name} 값이 다르다 — 웹 ${value}, 앱 ${C[key]}`);
  checked++;
}

// 2) @theme inline — --color-x: var(--nextspot-y) 는 같은 값, 직접 쓴 hex 는 그 값.
const theme = vars(block(/@theme\s+inline\s*\{/));
for (const [name, value] of theme) {
  if (!name.startsWith('--color-')) continue;
  const key = name.slice('--color-'.length);
  assert.ok(key in C, `웹 @theme ${name} 에 맞는 앱 토큰 colors['${key}'] 가 없다(같은 클래스 이름을 써야 한다)`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  const expected = ref ? root.get(ref[1]) : value;
  assert.ok(expected, `${name} 가 가리키는 ${value} 가 :root 에 없다`);
  assert.equal(C[key].toLowerCase(), expected.toLowerCase(), `${name} 값이 다르다`);
  checked++;
}
const fontSans = theme.get('--font-sans') ?? '';
assert.ok(fontSans.startsWith("'Freesentation'"), '웹 본문 글꼴이 Freesentation 이 아니게 됐다 — 앱 글꼴도 다시 정한다');

// 3) 웹이 color-mix 로 만드는 색 — 미리 계산한 값이 지금 웹 토큰으로 다시 계산한 값과 같아야 한다.
function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}
function mix(a: string, p: number, b: string): string {
  const A = rgb(a);
  const B = rgb(b);
  return `#${A.map((v, i) => Math.round(v * p + B[i] * (1 - p)).toString(16).padStart(2, '0')).join('')}`;
}
function rgba(hex: string, alpha: number): string {
  return `rgba(${rgb(hex).join(', ')}, ${alpha})`;
}
assert.equal(colors['jade-chip'], mix(colors.jade, 0.18, colors.hanji), 'jade-chip = color-mix(jade 18%, hanji)');
for (const tile of ['slate', 'indigo', 'stone'] as const) {
  assert.equal(
    C[`tile-${tile}-bg`],
    mix(C[`tile-${tile}`], ratios.tileMix, colors['hanji-deep']),
    `tile-${tile}-bg = color-mix(tile ${ratios.tileMix * 100}%, hanji-deep)`,
  );
}
assert.equal(colors['glass-bg'], rgba(colors.hanji, ratios.glassTint), 'glass-bg = hanji × glass-tint');
assert.ok(colors['glass-bg-solid'].startsWith(rgba(colors.hanji, 0).slice(0, -2)), 'glass-bg-solid 는 한지색이어야 한다');
assert.equal(colors['landing-sunset-end'], mix(colors['sunset-1'], 0.25, colors.hanji), 'landing-sunset-end = color-mix(sunset-1 25%, hanji)');
assert.equal(colors['auth-sunset-end'], mix(colors['sunset-1'], 0.2, colors.hanji), 'auth-sunset-end = color-mix(sunset-1 20%, hanji)');

// 3a) 금 버튼 — 흰 글자 4.5:1 이상(D2: 웹 #c19a3e 는 2.64:1 이라 금 진으로).
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrastOnWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05);
assert.ok(contrastOnWhite(colors['button-gold']) >= 4.5, `button-gold 위 흰 글자 ${contrastOnWhite(colors['button-gold']).toFixed(2)}:1`);
assert.ok(contrastOnWhite(colors.gold) < 4.5, 'gold 가 흰 글자 4.5:1 을 넘게 바뀌었다 — D2 결정을 다시 본다');

// 3c) 혼잡 혜택 띠 — 웹 .benefit-relaxed·.benefit-quiet 의 rgb(r g b / a) 바탕·테두리와 글자색.
function hexOfRgb(body: string): string {
  const m = /rgb\((\d+)\s+(\d+)\s+(\d+)/.exec(body);
  assert.ok(m, `rgb() 를 찾지 못했다: ${body}`);
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
}
for (const name of ['relaxed', 'quiet'] as const) {
  const body = block(new RegExp(`\\n\\.benefit-${name}\\s*\\{`));
  assert.equal(C[`benefit-${name}`], hexOfRgb(/background-color:\s*([^;]+);/.exec(body)?.[1] ?? ''), `.benefit-${name} 바탕`);
  assert.equal(C[`benefit-${name}`], hexOfRgb(/border-color:\s*([^;]+);/.exec(body)?.[1] ?? ''), `.benefit-${name} 테두리`);
  assert.equal(C[`benefit-${name}-ink`], /(?:^|[\s;])color:\s*(#[0-9a-f]{6})/i.exec(body)?.[1]?.toLowerCase(), `.benefit-${name} 글자`);
}

// 3d) 탭 막대 여백 — 웹 모바일 폭 --tourist-nav-clearance 와 앱 NAV_CLEARANCE.
const navMedia = /@media\s*\(max-width:\s*767px\)\s*\{\s*:root\s*\{\s*--tourist-nav-clearance:\s*(\d+)px/.exec(css);
assert.ok(navMedia, '웹 모바일 폭 --tourist-nav-clearance 를 찾지 못했다');
assert.equal(NAV_CLEARANCE, Number(navMedia[1]), 'NAV_CLEARANCE ↔ 웹 모바일 --tourist-nav-clearance');
assert.ok(NAV_BAR_HEIGHT < NAV_CLEARANCE, 'NAV_BAR_HEIGHT 는 NAV_CLEARANCE 보다 작아야 한다(NAV_GAP > 0)');

// 3b) 스프링 — 웹 lib/motion.ts 와 같은 값.
const motion = readFileSync(resolve(MOBILE, '../web/lib/motion.ts'), 'utf8');
for (const [webName, key] of [
  ['interactionSpring', 'interaction'],
  ['sheetSpring', 'sheet'],
] as const) {
  const body = new RegExp(`export const ${webName}[^{]*\\{([^}]*)\\}`).exec(motion)?.[1];
  assert.ok(body, `웹 lib/motion.ts 에 ${webName} 가 없다`);
  for (const prop of ['stiffness', 'damping', 'mass'] as const) {
    const v: string | undefined = new RegExp(`${prop}:\\s*([\\d.]+)`).exec(body)?.[1];
    assert.equal(springs[key][prop], Number(v), `${webName}.${prop}`);
  }
}

// 4) tailwind.config.js 가 토큰을 그대로 쓰는지(손으로 다른 값을 적지 않았는지).
const req = createRequire(import.meta.url);
const tw = req(join(MOBILE, 'tailwind.config.js')) as {
  theme: { extend: { colors: Record<string, string>; fontFamily: Record<string, string[]> } };
};
assert.deepEqual(tw.theme.extend.colors, colors, 'tailwind colors 는 tokens.colors 와 같아야 한다');
assert.deepEqual(tw.theme.extend.fontFamily.sans, [fontFamilies.regular]);

// 5) 글꼴 파일 — family 이름 하나 = assets/fonts 의 파일 하나.
for (const family of Object.values(fontFamilies)) {
  assert.ok(existsSync(join(MOBILE, 'assets/fonts', `${family}.ttf`)), `assets/fonts/${family}.ttf 가 없다`);
}
assert.ok(existsSync(join(MOBILE, 'assets/fonts/OFL.txt')), 'Freesentation 라이선스(OFL.txt)를 글꼴 옆에 둔다');

// 6) 웹 굵기 클래스 → 앱 글꼴(없는 굵기는 가까운 쪽으로).
assert.equal(weightClassToName['font-[650]'], 'bold');
assert.equal(weightClassToName['font-[750]'], 'extrabold');
for (const c of ['font-thin', 'font-extralight', 'font-light', 'font-normal']) assert.equal(weightClassToName[c], 'regular', c);
for (const name of Object.values(weightClassToName)) assert.ok(name in fontFamilies, name);

console.log(`ok tokens — 웹 토큰 ${checked}개 일치`);
