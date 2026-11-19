import { useId } from 'react';
import { StyleSheet, View, type DimensionValue } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

import { colors, type ColorToken } from '~/lib/theme/tokens';

import { GLOW_PRESETS, glowCanvas, glowStops, type GlowPresetName } from './glowMath';

export type GlowPosition = {
  top?: DimensionValue;
  left?: DimensionValue;
  right?: DimensionValue;
  bottom?: DimensionValue;
};

export type GlowProps = {
  /** 색 토큰 이름(sunset-1 · gold …) 또는 색 문자열. */
  color: ColorToken | (string & {});
  /** 웹 `bg-x/10` 의 0.10 — 번지기 전 원의 불투명도. */
  opacity?: number;
  /** 웹 원 지름(w-[300px] → 300). */
  size: number;
  /** 웹 `blur-[100px]` 의 100. */
  blur: number;
  /** 웹 원 상자의 자리(top-1/4 → '25%', bottom-[-10%] → '-10%'). 부모 기준 absolute. */
  position: GlowPosition;
  /** 웹 `left-1/2 -translate-x-1/2` — 가로 가운데(position.left 는 '50%' 로 준다). */
  centeredX?: boolean;
};

/**
 * 웹 페이지 바탕의 흐린 원(`rounded-full bg-… blur-[…px]`) 하나. CSS blur 는 RN 에 없어 SVG 반경 그라데이션으로 근사한다(glowMath.ts).
 * 부모 안 absolute · pointerEvents none. 스크롤과 함께 움직일지(대기) 고정할지(쿠폰·설정)는 놓는 부모가 정한다 —
 * 스크롤 내용 안에 두면 따라 움직이고, Screen 바깥 루트에 두면 고정이다. 바탕은 `Screen className="bg-transparent"` 로 비운다.
 * 웹 main 의 overflow-hidden 처럼 잘라야 하면 부모에 `overflow-hidden` 을 준다.
 */
export function Glow({ color, opacity = 0.1, size, blur, position, centeredX }: GlowProps) {
  const id = `glow${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const canvas = glowCanvas(size, blur);
  const resolved = color in colors ? colors[color as ColorToken] : color;
  const stops = glowStops(opacity, size, blur);
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        { position: 'absolute', width: size, height: size },
        position,
        centeredX ? { marginLeft: -size / 2 } : null,
      ]}
    >
      <Svg
        width={canvas}
        height={canvas}
        viewBox={`0 0 ${canvas} ${canvas}`}
        style={{ position: 'absolute', left: -2 * blur, top: -2 * blur }}
      >
        <Defs>
          <RadialGradient id={id} cx="50%" cy="50%" r="50%">
            {stops.map((s) => (
              <Stop key={s.offset} offset={s.offset} stopColor={resolved} stopOpacity={s.opacity} />
            ))}
          </RadialGradient>
        </Defs>
        <Circle cx={canvas / 2} cy={canvas / 2} r={canvas / 2} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

/** 프리셋 한 벌(노을 + 금, saved · alternative · waiting). 부모가 `relative`·필요하면 `overflow-hidden` 이어야 한다. */
export function GlowPair({ preset }: { preset: GlowPresetName }) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {GLOW_PRESETS[preset].map((g, i) => (
        <Glow key={i} {...g} />
      ))}
    </View>
  );
}
