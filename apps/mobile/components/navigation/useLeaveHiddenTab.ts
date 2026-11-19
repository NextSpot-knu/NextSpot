// 숨은 탭 경로에서 다른 탭으로 바꿔치기(웹 router.replace) — 떠나는 경로를 탭 기록에서 뺀다(이유는 hiddenTabCore.ts).
import { useNavigation, useRoute } from 'expo-router';
import { CommonActions } from 'expo-router/react-navigation';
import { useCallback } from 'react';

import { tabStateLeaving, type TabStateLike } from './hiddenTabCore';

/** 숨은 탭 화면 안에서 부른다. 돌려준 함수에 목적 탭 이름('index' 등)을 넘긴다. */
export function useLeaveHiddenTab(): (toTab: string) => void {
  const navigation = useNavigation();
  const route = useRoute();
  return useCallback(
    (toTab: string) => {
      navigation.dispatch((state) => {
        const next = tabStateLeaving(state as unknown as TabStateLike, route.key, toTab);
        return next
          ? CommonActions.reset(next as unknown as Parameters<typeof CommonActions.reset>[0])
          : CommonActions.navigate(toTab);
      });
    },
    [navigation, route.key],
  );
}
