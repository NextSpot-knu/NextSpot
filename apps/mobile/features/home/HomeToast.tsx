// 홈 알약 토스트(F10, 명세 G3-33 · 호출 G2-G09) — 화면 아래 350px, 가운데, 최대 384, 먹 90% 알약, 한 칸, 3초.
// 웹 원본: apps/web/app/main/page.tsx 5150-5156 · showToast 659-670. 전역 sonner(Toast.tsx)와 다르다 — 홈 안내만 이것으로 보낸다.
//
// 연결(H3a·H3b): 홈 화면에서 `const home = useHomeToast();` → 기존 `toast(...)` 호출(HomeScreen :283·286·352·414·623·625,
// actions.ts 의 인사·쿠폰·킵·거절·방문 완료)을 `home.show(t(...))` 로 바꾸고, 홈 루트(지도 위 맨 위 층)에 `<HomeToast toast={home.current} />`.
// 바닥 자리는 탭 화면 안 좌표로 환산한다 — useNavInsets().fromScreenBottom(350).
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { useNavInsets } from '~/components/navigation/navMetrics';
import { Text } from '~/components/ui';
import { useReduceMotion } from '~/components/ui/useReduceMotion';

import { HOME_TOAST, nextToast } from './homeToastSpec';

export type HomeToastState = { id: number; message: string } | null;

/** 한 칸 토스트 상태 + 3초 타이머. show() 가 앞 메시지를 덮는다. */
export function useHomeToast(): { current: HomeToastState; show: (message: string) => void } {
  const [current, setCurrent] = useState<HomeToastState>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = useRef<string | null>(null);
  const show = useCallback((message: string) => {
    // 웹 showToast(같은 글)은 상태가 그대로라 3초 타이머를 다시 시작하지 않는다 — 같게 둔다.
    if (shown.current === message) return;
    shown.current = message;
    if (timer.current) clearTimeout(timer.current);
    setCurrent((prev) => nextToast(prev, message));
    // 알림 낭독은 이 한 곳만(iOS 는 live region 을 무시하고, 없다가 생기는 live region 은 안드로이드도 자주 못 읽는다).
    AccessibilityInfo.announceForAccessibility(message);
    timer.current = setTimeout(() => {
      shown.current = null;
      setCurrent(null);
    }, HOME_TOAST.durationMs);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return { current, show };
}

export function HomeToast({ toast }: { toast: HomeToastState }) {
  const { fromScreenBottom } = useNavInsets();
  const reduceMotion = useReduceMotion();
  // 숨긴 채로 시작한다 — 1 에서 시작하면 첫 그림에서 한 프레임 번쩍인다.
  const progress = useSharedValue(0);
  const id = toast?.id ?? 0;
  useEffect(() => {
    if (!id) return;
    if (reduceMotion) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    progress.value = withTiming(1, { duration: HOME_TOAST.enterMs, easing: Easing.bezier(0.21, 1.02, 0.73, 1) });
  }, [id, reduceMotion, progress]);
  const enter = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * HOME_TOAST.enterOffset }],
  }));
  if (!toast) return null;
  return (
    // 알림은 눌림을 가로채지 않는다(웹 pointer-events 는 없지만 지도 위 안내라 아래 칩을 막으면 안 된다).
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: fromScreenBottom(HOME_TOAST.fromScreenBottom),
        alignItems: 'center',
        zIndex: 50,
      }}
    >
      <Animated.View
        style={[{ width: '100%', maxWidth: HOME_TOAST.maxWidth, paddingHorizontal: HOME_TOAST.sidePadding, alignItems: 'center' }, enter]}
      >
        <View
          style={{
            maxWidth: '100%',
            borderRadius: 9999,
            backgroundColor: HOME_TOAST.background,
            paddingHorizontal: HOME_TOAST.paddingX,
            paddingVertical: HOME_TOAST.paddingY,
            boxShadow: HOME_TOAST.shadow,
          }}
        >
          <Text className="text-center text-[12px] text-hanji" weight="medium">
            {toast.message}
          </Text>
        </View>
      </Animated.View>
    </View>
  );
}
