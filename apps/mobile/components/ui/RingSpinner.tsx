import { useEffect } from 'react';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { colors, type ColorToken } from '~/lib/theme/tokens';

import { useReduceMotion } from './useReduceMotion';

export type RingSpinnerProps = {
  /** 지름. 웹 w-10 h-10 → 40(기본). */
  size?: number;
  /** 테두리 굵기. 웹 `border-[3px]` → 3(기본), 지도 불러오는 중은 2. */
  borderWidth?: number;
  /** 한 바퀴 바탕 링 색(웹 `border-gold/25`). 기본 금 25%. */
  trackColor?: ColorToken | (string & {});
  /** 도는 위쪽 호 색(웹 `border-t-gold`). 기본 gold. */
  headColor?: ColorToken | (string & {});
  /** 뜻이 있는 스피너(홀로 선 로딩 표시)만 라벨을 준다. 없으면 읽기 화면에서 숨긴다. */
  accessibilityLabel?: string;
};

const resolve = (c: string) => (c in colors ? colors[c as ColorToken] : c);

/** 웹 `rounded-full border-… border-t-gold animate-spin` 하나 — 1초 linear 반복, '동작 줄이기'면 멈춘다. */
export function RingSpinner({
  size = 40,
  borderWidth = 3,
  trackColor = 'rgba(193,154,62,0.25)',
  headColor = 'gold',
  accessibilityLabel,
}: RingSpinnerProps) {
  const reduce = useReduceMotion();
  const turn = useSharedValue(0);
  useEffect(() => {
    if (reduce) {
      cancelAnimation(turn);
      turn.value = 0;
      return;
    }
    turn.value = 0;
    turn.value = withRepeat(withTiming(360, { duration: 1000, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(turn);
  }, [reduce, turn]);
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value}deg` }] }));
  return (
    <Animated.View
      accessible={Boolean(accessibilityLabel)}
      accessibilityRole={accessibilityLabel ? 'progressbar' : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityElementsHidden={!accessibilityLabel}
      importantForAccessibility={accessibilityLabel ? 'yes' : 'no-hide-descendants'}
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth,
          borderColor: resolve(trackColor),
          borderTopColor: resolve(headColor),
        },
        spin,
      ]}
    />
  );
}
