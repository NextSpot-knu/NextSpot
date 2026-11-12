// 처음 그릴 때 한 번 떠오르기 — 웹 animate-fade-in(fade-in-up 1s: 투명도 0→1 + translateY 10→0, apps/web/app/globals.css:667-680)
// 과 랜딩 .landingFade(300ms 투명도만). Reanimated entering 은 웹 빌드에서 실패해(검토 R2) shared value 로 그린다.
// '동작 줄이기'면 처음부터 다 보인 상태다.
import { useEffect } from 'react';
import { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { useReduceMotion } from '~/components/ui/useReduceMotion';

export function useFadeInUp({ duration = 1000, distance = 10 }: { duration?: number; distance?: number } = {}) {
  const reduce = useReduceMotion();
  const progress = useSharedValue(reduce ? 1 : 0);
  useEffect(() => {
    if (reduce) {
      progress.value = 1;
      return;
    }
    progress.value = withTiming(1, { duration, easing: Easing.out(Easing.ease) });
  }, [duration, progress, reduce]);
  return useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * distance }],
  }));
}
