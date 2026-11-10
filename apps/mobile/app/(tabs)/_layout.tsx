// 하단 탭 5개 + 탭 안 화면 — 웹 BottomNav(components/shell/BottomNav.tsx)가 보이는 경로 전부(B6, docs/MOBILE_WEB_PARITY.md §4.2 F11).
//   · 막대는 components/navigation/TouristTabBar(안내 줄 + 다섯 칸). 보통 흐름(겹치지 않음).
//   · 마이 하위 7개는 mypage/ 안 Stack(mypage/_layout), 대안 화면·/explore/map 은 탭 버튼 없는 숨은 경로(href: null) —
//     URL 은 그대로이고 막대가 보인다(활성: 마이 하위 → 마이, explore → 홈).
//   · backBehavior="history": 하드웨어 뒤로 = 이전 화면(D13(c) — 대기 → 대안 → 뒤로 = 대기).
//
// 첫 실행 판정을 여기서 동기로 한다 — 단계(소개·동의·설정)가 남았으면 <Tabs> 를 그리지 않고 바로 그 단계로 보낸다.
// 그래서 탭 화면(홈 지도·위치 읽기·추천 요청)이 첫 실행 결정 전에 마운트되지 않는다. 다른 입구 경로(딥링크 등)는
// 루트의 FirstRunGate 가 맡는다. 소셜 로그인 왕복 중에는 보내지 않는다(콜백이 code 를 처리해야 한다).
import { Redirect, type Href } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import { useEffect, useState } from 'react';

import { TouristTabBar } from '~/components/navigation/TouristTabBar';
import {
  decideTabsFirstRunRedirect,
  getFirstRunStep,
  isOAuthFlowPending,
  noteFirstRunNavigation,
  subscribeFirstRun,
  type FirstRunStep,
} from '~/features/onboarding/firstRun';
import { useT } from '~/lib/i18n/I18nProvider';
import { colors } from '~/lib/theme/tokens';

export default function TabLayout() {
  const t = useT();
  const [step, setStep] = useState<FirstRunStep | null>(getFirstRunStep);
  useEffect(() => {
    setStep(getFirstRunStep()); // 첫 렌더와 구독 사이에 바뀐 것을 놓치지 않게
    return subscribeFirstRun(setStep);
  }, []);
  const redirectTo = decideTabsFirstRunRedirect(step, isOAuthFlowPending());
  if (redirectTo) {
    // 루트 게이트가 같은 곳으로 한 번 더 replace 하지 않게 알린다(navigatedRecentlyTo).
    noteFirstRunNavigation(redirectTo);
    return <Redirect href={redirectTo as Href} />;
  }
  // 막대 모양·누름·활성 판정은 TouristTabBar 가 전부 맡는다(햅틱도 거기서 — 활성 탭 다시 누름은 햅틱 없이 무시).
  return (
    <Tabs
      backBehavior="history"
      tabBar={(props) => <TouristTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.hanji },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t('nav.home') }} />
      <Tabs.Screen name="saved" options={{ title: t('nav.saved') }} />
      <Tabs.Screen name="waiting" options={{ title: t('nav.waiting') }} />
      <Tabs.Screen name="course" options={{ title: t('nav.course') }} />
      <Tabs.Screen name="mypage" options={{ title: t('nav.mypage') }} />
      {/* 숨은 경로 — 탭 버튼 없음(TouristTabBar 는 다섯 탭만 그린다), 활성 탭은 '홈'. */}
      <Tabs.Screen name="explore/recommend" options={{ href: null }} />
      <Tabs.Screen name="explore/map" options={{ href: null }} />
    </Tabs>
  );
}
