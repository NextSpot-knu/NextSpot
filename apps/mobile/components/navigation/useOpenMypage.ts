// 다른 탭(홈·저장 등)에서 마이로 가기 — 마이 탭은 중첩 Stack(app/(tabs)/mypage/_layout)이라 그냥 router.push 하면 어긋난다(B6 검토 H2·M6).
//   · '/mypage'(첫 화면): router.push 는 탭에 NAVIGATE 를 보내고, 중첩 Stack 은 pop 없이 index 를 하나 더 쌓는다
//     (예전에 열어 둔 쿠폰이 있으면 [index, coupons, index]). → 탭 내비게이터에 { screen: 'index', pop: true }.
//   · '/mypage/<하위>': Stack 이 아직 안 열렸으면 initialRouteName 이 무시돼 [lab] 하나만 쌓인다(뒤로 = 홈).
//     → withAnchor 로 첫 화면을 아래에 깐다([index, lab] — 웹처럼 뒤로·머리 '뒤로' = 마이).
import { router, useNavigation, type Href } from 'expo-router';
import { useCallback } from 'react';

import { tabPressParams } from './tabBarModel';

export type MypageSubRoute = 'coupons' | 'impact' | 'inquiries' | 'lab' | 'privacy' | 'settings' | 'support';

/** 마이 하위 화면을 다른 탭에서 연다(아래에 마이 첫 화면을 깐다). 모달 시트 안처럼 탭 화면 밖에서도 쓸 수 있다. */
export function pushMypageSub(sub: MypageSubRoute): void {
  router.push(`/mypage/${sub}` as Href, { withAnchor: true });
}

/** 탭 화면(홈·저장 …) 안에서 마이 첫 화면으로 — 마이 Stack 에 하위 화면이 남아 있으면 index 까지 되돌린다. */
export function useOpenMypageHome(): () => void {
  const navigation = useNavigation();
  return useCallback(() => {
    const tabs = navigation as unknown as { navigate: (name: string, params?: object) => void };
    tabs.navigate('mypage', tabPressParams('mypage'));
  }, [navigation]);
}
