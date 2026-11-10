// 글자 모양 규칙 — 순수 함수(테스트: textStyle.test.ts). Text·Icon·탭 막대·RN TextInput 이 같은 규칙을 쓴다.
// React Native 를 import 하지 않는다(node 테스트에서 돈다) — 플랫폼은 인자로 받는다.
//
// 1) fontStyleFor — 글꼴 이름과 굵기(G2-G04 · G2-R03)
// 2) defaultLineHeight — 웹 preflight 의 line-height 1.5 를 물려받는 기본 줄 높이(G2-G05)
// 3) glassColor — 유리 판 안에서 보조 글자색을 진하게(G2-G03, 웹 .liquid-glass 의 --nextspot-* 재정의)
import type { Locale } from '@/lib/i18n/config';
import { colors, fontFamilies, fontStacks, type ColorToken, type FontWeightName } from '~/lib/theme/tokens';

import { isTextColorClass } from './cn';

export type TextPlatform = 'web' | 'native';

/** 굵기 이름 → CSS 숫자 굵기. */
export const FONT_WEIGHT_NUMBER: Record<FontWeightName, '400' | '500' | '600' | '700' | '800' | '900'> = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
  black: '900',
};

/** 웹 빌드에서 Freesentation 을 못 받았을 때(늦음·실패) 명조 대신 고딕으로 그리게 붙이는 목록. */
export const WEB_FALLBACK_FONTS = fontStacks.webFallback;

// 웹 apps/web/app/globals.css `html:lang(ja|zh)` 의 font-family 앞부분(tokens.fontStacks).
// 웹 목록의 'Freesentation'(굵기 묶음 하나) 자리에는 앱의 굵기별 family 이름이 들어간다 — 한글 장소명은 그 글꼴이 받는다.
/** 일본어·중국어 시스템 글꼴 목록(내려받지 않는다 — 각 OS 에 있다). */
export const CJK_FONT_LISTS: Record<'ja' | 'zh', string> = { ja: fontStacks.ja, zh: fontStacks.zh };

export type FontStyle = {
  fontFamily?: string;
  fontWeight: 'normal' | '400' | '500' | '600' | '700' | '800' | '900';
};

/**
 * 굵기·언어·플랫폼에 맞는 글꼴 style. RN Text·TextInput 을 직접 쓰는 곳(탭 막대·검색 입력칸)도 이것을 쓴다.
 * - ko·en 네이티브: Freesentation 굵기별 family + fontWeight normal(안드로이드는 굵기마다 family 가 따로라 굵게를 또 걸면
 *   가짜로 한 번 더 굵힌다).
 * - ko·en 웹 빌드: 같은 family 뒤에 대체 목록(G2-R03), 굵기는 숫자 — 대체 글꼴도 굵게 그려지게. 가짜 굵게는
 *   lib/webSetup.web.ts 의 `font-synthesis-weight: none` 이 막는다(Freesentation 굵기별 face 는 400 으로 등록된다).
 * - ja·zh 웹 빌드: 웹과 같은 시스템 글꼴 목록 → Freesentation(한글) → system-ui, 숫자 굵기(G2-G04).
 * - ja·zh 네이티브: family 를 비워 시스템 글꼴(Noto CJK)로, 굵기는 숫자. 안드로이드 CJK 글꼴은 400·700 위주라
 *   600·800 은 가까운 굵기로 그려진다.
 */
export function fontStyleFor(weight: FontWeightName, locale: Locale, platform: TextPlatform): FontStyle {
  const family = fontFamilies[weight];
  const numeric = FONT_WEIGHT_NUMBER[weight];
  if (locale === 'ja' || locale === 'zh') {
    if (platform === 'native') return { fontWeight: numeric }; // fontFamily 키 자체를 두지 않는다(undefined 로 덮지 않게)
    return { fontFamily: `${CJK_FONT_LISTS[locale]}, ${family}, system-ui, sans-serif`, fontWeight: numeric };
  }
  if (platform === 'web') return { fontFamily: `${family}, ${WEB_FALLBACK_FONTS}`, fontWeight: numeric };
  return { fontFamily: family, fontWeight: 'normal' };
}

/** 웹 preflight 가 물려주는 줄 높이 배율. */
export const DEFAULT_LINE_HEIGHT_RATIO = 1.5;
/** Text 의 기본 크기(text-[16px]) — cn 의 기본값과 같다. */
export const DEFAULT_FONT_SIZE = 16;

/** 변형 접두사(md:·active: 등)를 뗀 클래스. */
function baseClass(c: string): string {
  const i = c.lastIndexOf(':');
  return i >= 0 ? c.slice(i + 1) : c;
}

/** NativeWind(Tailwind 3)가 크기와 줄 높이를 함께 주는 이름 크기 — text-xs 16 · sm 20 · base 24 · lg 28 · xl 28 · 2xl 32 …. */
const NAMED_SIZE_CLASS = /^text-(xs|sm|base|lg|xl|[2-9]xl)$/;
const ARBITRARY_SIZE_CLASS = /^text-\[(\d+(?:\.\d+)?)(px|rem)?\]$/;

/**
 * 기본 줄 높이(px) — 줄 높이를 아무도 정하지 않았을 때만 크기×1.5(G2-G05, 웹 preflight `line-height: 1.5`).
 * 정한 것으로 보는 경우(undefined 를 돌려준다):
 *  - style 에 lineHeight 가 있다
 *  - className 에 leading-* 가 있다(변형 접두사가 붙어도) — 명시한 `leading-[…]` 를 덮지 않는다(R3)
 *  - className 에 이름 크기(text-xs~9xl)가 있다 — NativeWind 가 이미 줄 높이를 준다(R1)
 * 크기는 style 의 fontSize → className 의 text-[Npx|Nrem] → 16 순서(R1).
 */
export function defaultLineHeight(
  className: string | undefined,
  style: { fontSize?: unknown; lineHeight?: unknown } | null | undefined,
): number | undefined {
  if (style && style.lineHeight != null) return undefined;
  const classes = (className ?? '').split(/\s+/).filter(Boolean);
  let arbitrary: number | undefined;
  for (const c of classes) {
    const base = baseClass(c);
    if (base.startsWith('leading-')) return undefined;
    if (base !== c) continue; // 변형 크기(md:text-sm)는 기본 상태의 크기가 아니다
    if (NAMED_SIZE_CLASS.test(base)) return undefined;
    const m = ARBITRARY_SIZE_CLASS.exec(base);
    if (m) arbitrary = m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
  }
  const size = typeof style?.fontSize === 'number' ? style.fontSize : (arbitrary ?? DEFAULT_FONT_SIZE);
  return size * DEFAULT_LINE_HEIGHT_RATIO;
}

/** 유리 판 종류 — Glass 가 컨텍스트로 내린다. null = 유리 밖. */
export type GlassTone = 'light' | 'rail' | null;

/**
 * 유리 안에서 바뀌는 색 토큰. 웹 .liquid-glass 는 보조 글자 둘만(globals.css:82-83·423-424),
 * .rail-glass 는 먹·보조·금·금 진·선을 뒤집는다(globals.css:594-600).
 */
const GLASS_TOKEN_MAP: Record<'light' | 'rail', Partial<Record<ColorToken, ColorToken>>> = {
  light: { 'muk-soft': 'glass-muk-soft', 'gold-deep': 'glass-gold-deep' },
  rail: {
    muk: 'rail-muk',
    'muk-soft': 'rail-muk-soft',
    gold: 'rail-gold',
    'gold-deep': 'rail-gold-deep',
    line: 'rail-line',
  },
};

/** 색 토큰 이름이나 색 문자열을 실제 색으로. 유리 안이면 유리용 토큰으로 바꾼다(Icon 의 color·fill). */
export function resolveColor(color: string, tone: GlassTone = null): string {
  const mapped = tone ? (GLASS_TOKEN_MAP[tone][color as ColorToken] ?? color) : color;
  return mapped in colors ? colors[mapped as ColorToken] : mapped;
}

/** #rrggbb + 투명도 → rgba(). 이미 rgba 등이면 그대로(투명도를 곱하지 않는다). */
function withAlpha(color: string, alpha: number | undefined): string {
  if (alpha == null) return color;
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return color;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 유리 안에서 Text 에 덮어 줄 글자색 — className 의 마지막 글자색 클래스가 유리에서 바뀌는 토큰이면 그 색(투명도 `/70` 포함),
 * 아니면 undefined(className 그대로). 클래스를 새로 만들지 않고 style 색으로 준다 — NativeWind 는 소스에 글자 그대로
 * 적힌 클래스만 만들기 때문이다.
 */
export function glassTextColor(className: string | undefined, tone: GlassTone): string | undefined {
  if (!tone) return undefined;
  let last: string | undefined;
  for (const c of (className ?? '').split(/\s+/)) {
    if (!c.includes(':') && isTextColorClass(c)) last = c; // 변형 접두사가 붙은 색은 건드리지 않는다
  }
  if (!last) return undefined;
  const m = /^text-([a-z0-9-]+?)(?:\/(\d{1,3}))?$/.exec(last);
  if (!m) return undefined;
  const mapped = GLASS_TOKEN_MAP[tone][m[1] as ColorToken];
  if (!mapped) return undefined;
  return withAlpha(colors[mapped], m[2] != null ? Number(m[2]) / 100 : undefined);
}
