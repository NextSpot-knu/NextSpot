// 현재 시각 칩 — "현재 14:32 기준"(웹 components/NowChip.tsx). 시계 11 + 맥동하는 6px 비취 점 + 10px 글자. 30초마다 갱신.
// 맥동 = Tailwind animate-ping 2s: 1.5초 동안 scale 1→2 · opacity .6→0 (cubic-bezier(0,0,.2,1)), 0.5초 쉼. 동작 줄이기에서는 고리를 그리지 않는다.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Clock } from 'lucide-react-native';

import { useT } from '~/lib/i18n/I18nProvider';

import { cn } from './cn';
import { Icon } from './Icon';
import { Text } from './Text';
import { useReduceMotion } from './useReduceMotion';

export function formatClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function PingRing() {
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withRepeat(
      withSequence(
        withTiming(0, { duration: 0 }),
        withTiming(1, { duration: 1500, easing: Easing.bezier(0, 0, 0.2, 1) }),
        withTiming(1, { duration: 500 }),
      ),
      -1,
    );
    return () => cancelAnimation(p);
  }, [p]);
  const style = useAnimatedStyle(() => ({ opacity: 0.6 * (1 - p.value), transform: [{ scale: 1 + p.value }] }));
  return <Animated.View className="absolute h-[6px] w-[6px] rounded-full bg-jade" style={style} />;
}

export function NowChip({ className }: { className?: string }) {
  const t = useT();
  const reduceMotion = useReduceMotion();
  const [now, setNow] = useState(() => formatClock(new Date()));
  useEffect(() => {
    const id = setInterval(() => setNow(formatClock(new Date())), 30_000);
    return () => clearInterval(id);
  }, []);
  return (
    <View
      className={cn(
        'flex-row items-center gap-[4px] self-start rounded-full border border-line bg-hanji-deep/70 px-[8px] py-[2px]',
        className,
      )}
    >
      <Icon icon={Clock} size={11} color="muk-soft" />
      <View className="h-[6px] w-[6px] items-center justify-center" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {reduceMotion ? null : <PingRing />}
        <View className="h-[6px] w-[6px] rounded-full bg-jade" />
      </View>
      <Text className="text-[10px] leading-[15px] text-muk-soft" weight="medium">
        {t('common.nowTime', { time: now })}
      </Text>
    </View>
  );
}
