// 하단 탭 5개 — 웹 BottomNav(components/shell/BottomNav.tsx)와 같은 순서·문구 키·아이콘.
// 사장님·관제 콘솔 링크는 앱에 두지 않는다(마이페이지의 '웹에서 열기', 계획 §3.3).
//
// 첫 실행 판정을 여기서 동기로 한다 — 단계(소개·동의·설정)가 남았으면 <Tabs> 를 그리지 않고 바로 그 단계로 보낸다.
// 그래서 탭 화면(홈 지도·위치 읽기·추천 요청)이 첫 실행 결정 전에 마운트되지 않는다. 다른 입구 경로(딥링크 등)는
// 루트의 FirstRunGate 가 맡는다. 소셜 로그인 왕복 중에는 보내지 않는다(콜백이 code 를 처리해야 한다).
import { Redirect, Tabs, type Href } from 'expo-router';
import { Bookmark, Home, Route, Timer, User } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Text as RNText } from 'react-native';

import { Icon } from '~/components/ui';
import {
  decideTabsFirstRunRedirect,
  getFirstRunStep,
  isOAuthFlowPending,
  noteFirstRunNavigation,
  subscribeFirstRun,
  type FirstRunStep,
} from '~/features/onboarding/firstRun';
import { haptic } from '~/lib/platform/haptics';
import { useT } from '~/lib/i18n/I18nProvider';
import { colors, fontFamilies } from '~/lib/theme/tokens';

// 큰 글자 설정에서 탭 글자(11px)가 잘리지 않게 배율을 낮게 막는다(아이콘이 뜻을 함께 전한다).
const TAB_LABEL_MAX_FONT_SCALE = 1.2;

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
  // 아이콘 크기는 탭 막대가 주는 size 를 따른다(웹 하단 탭은 22px — 막대 기본값과 거의 같다).
  const tab = (icon: typeof Home) => ({ focused, size }: { focused: boolean; size: number }) => (
    <Icon icon={icon} size={size} color={focused ? colors['gold-deep'] : colors['muk-soft']} />
  );
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors['gold-deep'],
        tabBarInactiveTintColor: colors['muk-soft'],
        tabBarStyle: { backgroundColor: colors.hanji, borderTopColor: colors.line },
        // 웹 하단 탭 글자: text-[11px] font-medium. 굵기는 글꼴 파일로, fontWeight 는 normal.
        // 막대 기본 글자는 배율 상한을 받지 않는다 — 글자를 직접 그려 maxFontSizeMultiplier 를 준다.
        tabBarLabel: ({ color, children, position }) => (
          <RNText
            numberOfLines={1}
            maxFontSizeMultiplier={TAB_LABEL_MAX_FONT_SCALE}
            style={{
              color,
              fontFamily: fontFamilies.medium,
              fontWeight: 'normal',
              fontSize: 11,
              textAlign: 'center',
              ...(position === 'beside-icon' ? { marginLeft: 20, marginTop: 3 } : null),
            }}
          >
            {children}
          </RNText>
        ),
      }}
      screenListeners={{ tabPress: () => haptic('selection') }}
    >
      <Tabs.Screen name="index" options={{ title: t('nav.home'), tabBarIcon: tab(Home) }} />
      <Tabs.Screen name="saved" options={{ title: t('nav.saved'), tabBarIcon: tab(Bookmark) }} />
      <Tabs.Screen name="waiting" options={{ title: t('nav.waiting'), tabBarIcon: tab(Timer) }} />
      <Tabs.Screen name="course" options={{ title: t('nav.course'), tabBarIcon: tab(Route) }} />
      <Tabs.Screen name="mypage" options={{ title: t('nav.mypage'), tabBarIcon: tab(User) }} />
    </Tabs>
  );
}
