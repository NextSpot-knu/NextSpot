// 펼침 쉐브론 — 열리면 180도 돈다(웹 ChevronDown 의 `transition-transform` + `rotate-180`, G4b-13).
// 동작 줄이기에서는 바로 바꾼다.
import { ChevronDown } from 'lucide-react-native';
import { useEffect } from 'react';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Icon } from '~/components/ui';
import { useReduceMotion } from '~/components/ui/useReduceMotion';
import type { ColorToken } from '~/lib/theme/tokens';

export function RotatingChevron({ open, size, color }: { open: boolean; size: number; color: ColorToken }) {
  const reduceMotion = useReduceMotion();
  const turn = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    turn.value = reduceMotion ? (open ? 1 : 0) : withTiming(open ? 1 : 0, { duration: 150 });
  }, [open, reduceMotion, turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 180}deg` }] }));
  return (
    <Animated.View style={style} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Icon icon={ChevronDown} size={size} color={color} />
    </Animated.View>
  );
}
