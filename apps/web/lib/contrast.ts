// WCAG 2.x 대비 계산 — 주요 버튼(도보 길안내 · 시작하기 · 로그인 · 바로 시작)의 흰 글자가 금→주칠 그라데이션
// 위에서 4.5:1 이상인지 단위 테스트로 잠근다(계획 B3 · I86). 색은 app/globals.css 의 --nextspot-cta-from/to 가 정본.

/** '#rgb' · '#rrggbb' → [r, g, b](0~255). 모양이 어긋나면 throw — 토큰 오타가 조용히 통과하지 않게. */
export function parseHex(hex: string): [number, number, number] {
  const raw = hex.trim().replace(/^#/, '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** 상대 휘도(0~1). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 두 색의 대비(1~21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** 두 색을 t(0~1) 만큼 섞는다(sRGB 선형 보간 — 브라우저의 기본 그라데이션 보간과 같다). */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const k = Math.min(1, Math.max(0, t));
  return `#${ca.map((v, i) => Math.round(v + (cb[i] - v) * k).toString(16).padStart(2, '0')).join('')}`;
}

/** 그라데이션 전 구간(11점)에서 글자색과의 최소 대비. */
export function minGradientContrast(from: string, to: string, text: string = '#ffffff'): number {
  let min = Infinity;
  for (let i = 0; i <= 10; i += 1) min = Math.min(min, contrastRatio(mixHex(from, to, i / 10), text));
  return min;
}
