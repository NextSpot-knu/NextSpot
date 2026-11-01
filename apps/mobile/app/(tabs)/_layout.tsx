// 하단 탭 5개 — 웹 BottomNav(components/shell/BottomNav.tsx)와 같은 순서·문구 키·아이콘.
// 사장님·관제 콘솔 링크는 앱에 두지 않는다(마이페이지의 '웹에서 열기', 계획 §3.3).
import { Tabs } from 'expo-router';
import { Bookmark, Home, Route, Timer, User } from 'lucide-react-native';

import { Icon } from '~/components/ui';
import { haptic } from '~/lib/platform/haptics';
import { useT } from '~/lib/i18n/I18nProvider';
import { colors, fontFamilies } from '~/lib/theme/tokens';

export default function TabLayout() {
  const t = useT();
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
        tabBarLabelStyle: { fontFamily: fontFamilies.medium, fontWeight: 'normal', fontSize: 11 },
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
