import { useId } from 'react';
import { Coffee, Landmark, MapPin, Mountain, Utensils, type LucideIcon } from 'lucide-react-native';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

import { Icon } from '~/components/ui/Icon';
import { EMBLEM, emblemShift } from '~/lib/placeEmblem';
import { colors } from '~/lib/theme/tokens';
import type { PlaceGlyph, PlaceTone, PlaceVisual } from '@/lib/placeVisual';

// 사진이 없는 장소의 표지 — 웹 components/PlacePhotoFallback.tsx(f4dc88b)의 이식. 사진 자리를 같은 크기로 채우는
// 경주 문양 판 + 가운데 유형 그림. 무엇을 고를지는 @/lib/placeVisual(placeVisual·placeVisualsForRow), 여기서는 그리기만 한다.
// 장식이라 읽기 화면에서 숨긴다. 사진은 이 판 **위에** 겹쳐 그리고 다 받으면 드러낸다(부르는 쪽).
// 선은 vectorEffect="non-scaling-stroke" + 1.4 — slice 로 확대돼도 화면 굵기가 같다(안드로이드·iOS 실기기 확인 필요).

const GLYPH_ICON: Record<PlaceGlyph, LucideIcon> = {
  restaurant: Utensils,
  cafe: Coffee,
  attraction: Mountain,
  culture: Landmark,
  default: MapPin,
};

/** 판 바탕 = color-mix(tile 13%, hanji-deep) — 웹 .place-tile. 토큰 tile-*-bg 와 같은 값. */
const TONE_BG: Record<PlaceTone, string> = {
  slate: colors['tile-slate-bg'],
  indigo: colors['tile-indigo-bg'],
  stone: colors['tile-stone-bg'],
};

const hexToRgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

export type PlacePhotoFallbackProps = {
  visual: PlaceVisual;
  /** 자리·크기. 기본은 부모를 가득 채운다(absoluteFill) — 사진 아래에 깔 때. 흐름 안에 둘 때는 width·height 를 준다. */
  style?: StyleProp<ViewStyle>;
};

export function PlacePhotoFallback({ visual, style }: PlacePhotoFallbackProps) {
  const tile = colors[`tile-${visual.tone}` as const];
  const GlyphIcon = GLYPH_ICON[visual.glyph];
  const uid = `tile${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { overflow: 'hidden', backgroundColor: TONE_BG[visual.tone] }, style]}
    >
      {/* 판 명암 — 가운데 밝은 방사형(circle farthest-corner: 반지름 = 반대각선 = 정규화 대각선의 70.71%) + 160deg 선형. */}
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <RadialGradient id={`${uid}R`} gradientUnits="userSpaceOnUse" cx="50%" cy="50%" r="70.71%">
            <Stop offset={0} stopColor={colors.hanji} stopOpacity={0.45} />
            <Stop offset={0.58} stopColor={colors.hanji} stopOpacity={0} />
          </RadialGradient>
          {/* 160deg: 정사각 기준 선 길이 1.282 → 시작 (.281,-.103) 끝 (.719,1.103) */}
          <LinearGradient id={`${uid}L`} x1="0.281" y1="-0.103" x2="0.719" y2="1.103">
            <Stop offset={0} stopColor={tile} stopOpacity={0.12} />
            <Stop offset={0.72} stopColor={tile} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${uid}R)`} />
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${uid}L)`} />
      </Svg>
      {/* ① 문장 — 문양 한 점을 오른쪽 아래로 잘라 넣는다. */}
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" viewBox="0 0 100 112" preserveAspectRatio="xMidYMid slice">
        <Path
          transform={`translate(${emblemShift(visual.phase)} 0)`}
          d={EMBLEM[visual.motif]}
          fill="none"
          stroke={tile}
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.5}
          vectorEffect="non-scaling-stroke"
        />
      </Svg>
      {/* ② 유형 그림 — 세로 54% 의 44px 받침(bg-hanji/90 + ring 1 tile/40 + 그림자). */}
      <View
        style={{
          position: 'absolute',
          left: '50%',
          top: '54%',
          width: 44,
          height: 44,
          marginLeft: -22,
          marginTop: -22,
          borderRadius: 22,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: hexToRgba(colors.hanji, 0.9),
          boxShadow: `0px 0px 0px 1px ${hexToRgba(tile, 0.4)}, 0px 2px 10px rgba(43, 35, 32, 0.12)`,
        }}
      >
        <Icon icon={GlyphIcon} size={20} strokeWidth={1.8} color={tile} />
      </View>
    </View>
  );
}

export default PlacePhotoFallback;
