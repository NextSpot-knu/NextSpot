// Button 의 모양 표(순수 함수) — 화면별 값은 docs/parity/review-R1.md 3절 표, 결정은 docs/MOBILE_WEB_PARITY.md F4.
// 클래스는 바꿔 끼운다(덧붙이지 않는다): NativeWind 는 같은 속성 클래스 둘이면 CSS 순서로 고르므로 한 종류에 하나만 둔다.
// 높이·좌우 여백은 클래스가 아니라 style 로 준다(화면이 min-h-[…]·px-[…] 클래스를 덧붙여도 지지 않게 — splitLegacyLayout 참고).
import { shadows, type ColorToken } from '~/lib/theme/tokens';

export type ButtonVariant = 'primary' | 'gold' | 'secondary' | 'hanji' | 'dangerSoft' | 'dangerOutline' | 'ghost';
export type ButtonSize = 30 | 36 | 44 | 46 | 48 | 52 | 56;
export type ButtonLabelSize = 12 | 13 | 14 | 15 | 16 | 17;
export type ButtonShape = 'lg' | 'xl' | '2xl' | 'full';
export type ButtonShadow = 'auto' | 'none' | 'cta' | 'ctaLg' | 'ctaHero';

/** 바탕·테두리 클래스(variant 마다 통째로 하나). gold 는 토큰 `button-gold` 하나만 읽는다(결정 D2). */
export const VARIANT_SURFACE: Record<ButtonVariant, string> = {
  primary: '',
  gold: 'bg-button-gold',
  secondary: 'border border-line bg-white',
  hanji: 'border border-line bg-hanji',
  dangerSoft: 'border border-terracotta/30 bg-terracotta/10',
  dangerOutline: 'border border-terracotta/30',
  ghost: '',
};

export const VARIANT_TEXT_CLASS: Record<ButtonVariant, string> = {
  primary: 'text-white',
  gold: 'text-white',
  secondary: 'text-muk',
  hanji: 'text-muk',
  dangerSoft: 'text-terracotta',
  dangerOutline: 'text-terracotta',
  ghost: 'text-muk-soft',
};

/** 글자·아이콘·돌림표 색 토큰(VARIANT_TEXT_CLASS 와 같은 색). */
export const VARIANT_COLOR: Record<ButtonVariant, ColorToken> = {
  primary: 'white',
  gold: 'white',
  secondary: 'muk',
  hanji: 'muk',
  dangerSoft: 'terracotta',
  dangerOutline: 'terracotta',
  ghost: 'muk-soft',
};

/** 글자 크기/줄 높이 짝(R1 표): 12/16 · 13/19.5 · 14/18 · 15/22.5 · 16/24 · 17/25.5. */
export const LABEL_CLASS: Record<ButtonLabelSize, string> = {
  12: 'text-[12px] leading-[16px]',
  13: 'text-[13px] leading-[19.5px]',
  14: 'text-[14px] leading-[18px]',
  15: 'text-[15px] leading-[22.5px]',
  16: 'text-[16px] leading-[24px]',
  17: 'text-[17px] leading-[25.5px]',
};

export const SHAPE_CLASS: Record<ButtonShape, string> = {
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  '2xl': 'rounded-2xl',
  full: 'rounded-full',
};

export const BUTTON_DEFAULTS = { size: 44, labelSize: 14, shape: '2xl', iconSize: 14, disabledOpacity: 0.5 } as const;

/** 세로 안쪽 여백 — size 30 만 6, 나머지 8(R1 표). */
export function paddingYFor(size: number): number {
  return size === 30 ? 6 : 8;
}

/** 가로 안쪽 여백 기본 — size 30 은 12, 나머지 16. */
export function defaultPaddingX(size: number): number {
  return size === 30 ? 12 : 16;
}

/**
 * 그림자 style 값. auto 는 지금까지의 동작(primary 이고 누를 수 있을 때만 cta).
 * auto 가 아니면 비활성이어도 그린다(웹: 저장 중에도 그림자가 남는다).
 */
export function shadowFor(shadow: ButtonShadow, variant: ButtonVariant, inactive: boolean): string | undefined {
  if (shadow === 'none') return undefined;
  if (shadow === 'auto') return variant === 'primary' && !inactive ? shadows.cta : undefined;
  return shadows[shadow];
}

/**
 * 지금 화면들이 className 으로 넣던 `min-h-[Npx]`·`px-[Npx]` 를 읽어 style 값으로 옮기고 클래스에서는 뺀다.
 * (기본 클래스와 겹쳐 CSS 순서로 졌던 것을 이기게 하는 호환 처리 — 화면 묶음이 size·paddingX prop 으로 바꾸면 쓰이지 않는다.)
 */
export function splitLegacyLayout(className: string | undefined): {
  className: string | undefined;
  minHeight?: number;
  paddingX?: number;
} {
  if (!className) return { className };
  let minHeight: number | undefined;
  let paddingX: number | undefined;
  const rest: string[] = [];
  for (const c of className.split(/\s+/).filter(Boolean)) {
    const m = /^min-h-\[(\d+(?:\.\d+)?)px\]$/.exec(c);
    if (m) {
      minHeight = Number(m[1]);
      continue;
    }
    const p = /^px-\[(\d+(?:\.\d+)?)px\]$/.exec(c);
    if (p) {
      paddingX = Number(p[1]);
      continue;
    }
    rest.push(c);
  }
  return { className: rest.length ? rest.join(' ') : undefined, minHeight, paddingX };
}

/** 44pt 에 못 미치는 높이(30·36)의 위아래 탭 영역 넓힘 = (44 − minHeight)/2. 44 이상이면 0. */
export function defaultHitSlopY(minHeight: number): number {
  return minHeight >= 44 ? 0 : (44 - minHeight) / 2;
}
