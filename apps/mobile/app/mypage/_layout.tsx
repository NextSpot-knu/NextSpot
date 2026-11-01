// 마이페이지 하위 화면 7개 — 탭 위에 쌓이는 Stack(헤더는 여기서). 웹 app/mypage/*/page.tsx 의 '← 제목' 헤더에 해당한다.
// 하단 탭 화면은 app/(tabs)/mypage.tsx 다(이 폴더에 index 를 두지 않는다 — 같은 /mypage 주소가 겹친다).
import { Stack, useNavigation } from 'expo-router';
import { useLayoutEffect } from 'react';

import { useT } from '~/lib/i18n/I18nProvider';
import { colors, fontFamilies } from '~/lib/theme/tokens';

export default function MypageLayout() {
  const t = useT();
  const navigation = useNavigation();
  // 루트 Stack 이 이 폴더를 'mypage' 화면으로 그려 자기 헤더를 얹는다 — 헤더가 둘이 되지 않게 끈다.
  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: false });
  }, [navigation]);

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
