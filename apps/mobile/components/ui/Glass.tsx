import { BlurView } from 'expo-blur';
import { useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View, type ViewProps } from 'react-native';

import { colors, shadows } from '~/lib/theme/tokens';

/** iOS '투명도 줄이기' 설정. 안드로이드에는 없는 설정이라 늘 false. */
export function useReduceTransparency(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let alive = true;
    AccessibilityInfo.isReduceTransparencyEnabled().then((v) => alive && setReduce(v));
    const sub = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

export type GlassProps = ViewProps & {
  className?: string;
  children?: ReactNode;
  /**
   * light — 지도 위 탐색 층(검색·카테고리·언어·시계)의 밝은 유리(웹 .liquid-glass). 글자는 먹, 보조 글자는 glass-muk-soft·glass-gold-deep.
   * rail — 매우 어두운 갈색 유리(웹 .rail-glass). 안의 글자는 rail-muk·rail-muk-soft·rail-gold-deep.
   */
  variant?: 'light' | 'rail';
  /** pill — 알약(rounded-full) · panel — 판(16pt 둥글기). */
  shape?: 'pill' | 'panel';
};

/**
 * 유리 판. 탐색 층에만 쓰고 내용 층(추천 카드)·유리 위에는 쓰지 않는다(DESIGN_PRINCIPLES "재질").
 * - iOS: expo-blur 흐림 위에 한지 35%(light) 또는 갈색 72%(rail)를 덮는다.
 * - 안드로이드: 흐림 없이 거의 불투명한 같은 색 판 — 흐림 없이 35% 면 지도 위 글자 대비가 무너지고, 안드로이드 흐림은 느리다.
 * - iOS '투명도 줄이기' 에서는 불투명한 판.
 * 크기·여백은 className 으로(예: `px-[16px] min-h-[44px] flex-row items-center`).
 */
export function Glass({ className, children, variant = 'light', shape = 'pill', style, ...rest }: GlassProps) {
  const reduceTransparency = useReduceTransparency();
  const blur = Platform.OS === 'ios' && !reduceTransparency;
  const radius = shape === 'pill' ? 9999 : 16;
  const light = variant === 'light';
  const tint = blur
    ? light
      ? colors['glass-bg']
      : colors['rail-bg']
    : reduceTransparency
      ? light
        ? colors.hanji
        : colors['rail-bg-solid']
      : light
        ? colors['glass-bg-solid']
        : colors['rail-bg-solid'];
  return (
    <View
      className={className}
      style={[
        {
          borderRadius: radius,
          borderWidth: 1,
          borderColor: reduceTransparency ? colors['muk-soft'] : light ? colors['glass-edge'] : colors['rail-edge'],
          boxShadow: light ? shadows.glass : shadows.rail,
        },
        style,
      ]}
      {...rest}
    >
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]}>
        {blur ? <BlurView tint={light ? 'light' : 'dark'} intensity={light ? 30 : 45} style={StyleSheet.absoluteFill} /> : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />
      </View>
      {children}
    </View>
  );
}
