// 마이페이지 하위 화면 7개 — 탭 위에 쌓이는 Stack(헤더는 여기서). 웹 app/mypage/*/page.tsx 의 '← 제목' 헤더에 해당한다.
// 하단 탭 화면은 app/(tabs)/mypage.tsx 다(이 폴더에 index 를 두지 않는다 — 같은 /mypage 주소가 겹친다).
// 루트 Stack 의 'mypage' 화면 헤더는 app/_layout.tsx 의 Stack.Screen 옵션(headerShown: false)이 끈다.
import { Stack } from 'expo-router';

import { useT } from '~/lib/i18n/I18nProvider';
import { colors, fontFamilies } from '~/lib/theme/tokens';

export default function MypageLayout() {
  const t = useT();

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.hanji },
        headerShadowVisible: false,
        headerTintColor: colors.muk,
        headerTitleStyle: { fontFamily: fontFamilies.bold, fontSize: 18 },
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: colors.hanji },
      }}
    >
      <Stack.Screen name="coupons" options={{ title: t('coupons.title') }} />
      <Stack.Screen name="impact" options={{ title: t('impact.pageTitle') }} />
      <Stack.Screen name="inquiries" options={{ title: t('inquiries.title') }} />
      <Stack.Screen name="lab" options={{ title: t('lab.title') }} />
      <Stack.Screen name="privacy" options={{ title: t('privacy.title') }} />
      <Stack.Screen name="settings" options={{ title: t('settings.title') }} />
      <Stack.Screen name="support" options={{ title: t('support.title') }} />
    </Stack>
  );
}
