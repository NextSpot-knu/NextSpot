import { forwardRef, useState } from 'react';
import {
  Pressable as RNPressable,
  type GestureResponderEvent,
  type PressableProps as RNPressableProps,
  type StyleProp,
  type View,
  type ViewStyle,
} from 'react-native';

import { useReduceMotion } from './useReduceMotion';

export type PressableProps = Omit<RNPressableProps, 'style'> & {
  className?: string;
  style?: StyleProp<ViewStyle>;
  /** 누름 피드백을 끈다(목록 행처럼 배경색으로 피드백을 주는 곳). */
  noFeedback?: boolean;
};

/**
 * 누를 수 있는 것의 한 가지 문법 — 웹 `.toss-pressable`(DESIGN_PRINCIPLES "모션"): 눌리면 0.96 으로 줄고 살짝 어두워진다.
 * '동작 줄이기' 에서는 줄어듦만 빼고 어두워짐은 남긴다. 탭 영역 44pt 는 부르는 쪽이 min-h-[44px] 나 hitSlop 으로 지킨다.
 * (RN Pressable 의 style 함수는 NativeWind className 과 섞기 어려워 눌림 상태를 직접 들고 있다.)
 */
export const Pressable = forwardRef<View, PressableProps>(function Pressable(
  { style, noFeedback, onPressIn, onPressOut, disabled, ...rest },
  ref,
) {
  const [pressed, setPressed] = useState(false);
  const reduceMotion = useReduceMotion();
  const active = pressed && !disabled && !noFeedback;
  return (
    <RNPressable
      ref={ref}
      disabled={disabled}
      onPressIn={(e: GestureResponderEvent) => {
        setPressed(true);
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        setPressed(false);
        onPressOut?.(e);
      }}
      style={[style, active && { opacity: 0.88, transform: reduceMotion ? undefined : [{ scale: 0.96 }] }]}
      {...rest}
    />
  );
});
