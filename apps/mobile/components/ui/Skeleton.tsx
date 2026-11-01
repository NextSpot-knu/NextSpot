import { useEffect } from 'react';
import type { DimensionValue, StyleProp, ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { colors } from '~/lib/theme/tokens';

export type SkeletonProps = {
  width?: DimensionValue;
  height?: DimensionValue;
  /** 둥글기(pt). 글줄은 6, 카드는 16, 원은 9999. */
  radius?: number;
  style?: StyleProp<ViewStyle>;
};

/**
 * 자리표시 — 첫 페인트에 빈 화면 대신 모양을 먼저 둔다(DESIGN_PRINCIPLES 6 "기다리게 하지 않는다").
 * 한지 진 판이 천천히 숨 쉰다. '동작 줄이기' 에서는 멈춘 판. 읽기 화면에서는 숨긴다 —
 * 불러오는 중임은 감싼 쪽이 accessibilityLabel 또는 accessibilityState={{ busy: true }} 로 알린다.
 */
export function Skeleton({ width = '100%', height = 14, radius = 6, style }: SkeletonProps) {
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (reduceMotion) {
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(withTiming(0.55, { duration: 900 }), -1, true);
    return () => cancelAnimation(opacity);
  }, [reduceMotion, opacity]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height, borderRadius: radius, backgroundColor: colors['hanji-deep'] }, animated, style]}
    />
  );
}
