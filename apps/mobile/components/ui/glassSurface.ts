// 유리 판 규칙 — 순수 값·함수(테스트: glassSurface.test.ts). Glass.tsx 가 플랫폼 값을 넣어 부른다.
// 웹 기준: apps/web/app/globals.css:408-466 `.liquid-glass`, :594-614 `.rail-glass`.
import { colors, shadows } from '~/lib/theme/tokens';

/**
 * D14(2026-11-11 '① 시험 후 ③'): 안드로이드 SDK 31 이상 + 흐릴 대상(GlassBlurTarget)이 있으면 흐림 + 35%(①).
 * **Z Fold7 시험 전이라 기본은 꺼 둔다(③ — 모든 안드로이드 70%).** 폰에서 흐림이 구글 지도(SurfaceView)를 잡고 FPS·대비가
 * 괜찮으면 true 로 바꾼다(웨이브 B 플랫폼 검토 M3).
 */
export const ANDROID_GLASS_BLUR = false;

/** D14 ③ 흐림 없는 안드로이드 유리 바탕(hanji 70%). */
export const GLASS_BG_NO_BLUR = colors['glass-bg-android'];

/** 웹 --glass-shadow(globals.css:411) — 위 1px 흰 빛선 · 아래 1px 옅은 빛선 · 바깥 그림자. */
export const GLASS_SHADOW_LIGHT = shadows.glassInset;
/** 웹 .rail-glass box-shadow(globals.css:605). */
export const GLASS_SHADOW_RAIL = shadows.railInset;

/** 웹 backdrop-filter 값 그대로(웹 빌드만). */
export const GLASS_BACKDROP_LIGHT = 'blur(8px) saturate(180%)';
export const GLASS_BACKDROP_RAIL = 'blur(16px) saturate(160%)';

/** 위쪽 광택(--glass-sheen: linear-gradient(180deg, white .22, white 0 45%)) — light 만. */
export const GLASS_SHEEN = {
  colors: ['rgba(255, 255, 255, 0.22)', 'rgba(255, 255, 255, 0)'] as const,
  locations: [0, 0.45] as const,
};

export type GlassVariant = 'light' | 'rail';

export type GlassEnv = {
  os: 'web' | 'ios' | 'android' | string;
  /** 안드로이드 API 수준(Platform.Version). 다른 OS 는 0. */
  androidApi: number;
  /** iOS '투명도 줄이기'. */
  reduceTransparency: boolean;
  /** 흐릴 대상(GlassBlurTarget)이 화면에 있는가 — 안드로이드 expo-blur 57 은 blurTarget 이 없으면 흐리지 않는다. */
  hasBlurTarget: boolean;
  /** 안드로이드 흐림 켜기(기본 ANDROID_GLASS_BLUR) — 테스트·폰 시험용. */
  androidBlur?: boolean;
};

export type GlassSurface = {
  /** 바탕색. */
  tint: string;
  /** 흐림 방법: css = 웹 backdrop-filter · native = expo-blur BlurView · none. */
  blur: 'css' | 'native' | 'none';
  /** 웹 빌드 backdrop-filter 값(blur === 'css' 일 때). */
  backdropFilter?: string;
  border: string;
  boxShadow: string;
  /** 위쪽 광택을 그리는가. */
  sheen: boolean;
};

/** 플랫폼·설정에 맞는 유리 판 모양. */
export function glassSurface(variant: GlassVariant, env: GlassEnv): GlassSurface {
  const light = variant === 'light';
  const shadow = light ? GLASS_SHADOW_LIGHT : GLASS_SHADOW_RAIL;
  if (env.reduceTransparency) {
    return {
      tint: light ? colors.hanji : colors['rail-bg-solid'],
      blur: 'none',
      border: colors['muk-soft'],
      boxShadow: shadow,
      sheen: false,
    };
  }
  const base = { border: light ? colors['glass-edge'] : colors['rail-edge'], boxShadow: shadow, sheen: light };
  if (env.os === 'web') {
    return {
      ...base,
      tint: light ? colors['glass-bg'] : colors['rail-bg'],
      blur: 'css',
      backdropFilter: light ? GLASS_BACKDROP_LIGHT : GLASS_BACKDROP_RAIL,
    };
  }
  const androidBlur = env.androidBlur ?? ANDROID_GLASS_BLUR;
  const nativeBlur =
    env.os === 'ios' || (env.os === 'android' && androidBlur && env.androidApi >= 31 && env.hasBlurTarget);
  if (nativeBlur) return { ...base, tint: light ? colors['glass-bg'] : colors['rail-bg'], blur: 'native' };
  return { ...base, tint: light ? GLASS_BG_NO_BLUR : colors['rail-bg-solid'], blur: 'none' };
}
