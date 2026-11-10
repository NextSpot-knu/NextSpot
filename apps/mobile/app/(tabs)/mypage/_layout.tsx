// 마이 탭 Stack — 첫 화면(index = 웹 app/mypage/page.tsx) 위에 하위 화면 7개가 쌓인다. 탭 안이라 하단 막대가 보이고
// 활성은 '마이'다(G5b-01 · G2-G02). URL 은 /mypage · /mypage/<하위> 그대로(그룹 폴더는 주소에 들어가지 않는다).
//
// · initialRouteName 'index': 딥링크(/mypage/coupons 등)로 바로 들어와도 아래에 마이 첫 화면이 깔린다 — 하드웨어 뒤로 = /mypage.
// · 머리: 첫 화면은 자기 머리를 그린다(Stack 머리 끔). 하위 다섯은 웹 모양 고정 머리 SubPageHeader(G5b-02).
//   내 문의·고객지원은 웹이 머리를 스크롤과 함께 올리므로 Stack 머리를 끄고 화면이 스크롤 내용 맨 앞에 그린다(G5b-R02).
import { Stack } from 'expo-router';

import { SubPageHeader } from '~/features/mypage/components/SubPageHeader';
import { useT } from '~/lib/i18n/I18nProvider';
import { colors } from '~/lib/theme/tokens';

export const unstable_settings = {
  initialRouteName: 'index',
};

/** 고정 머리 하위 화면 — 제목 키 · 뒤로 읽기 이름 키(웹 각 page.tsx 의 aria-label). */
const FIXED_HEADERS: Record<string, { title: string; back: string }> = {
  coupons: { title: 'coupons.title', back: 'coupons.backAria' },
  impact: { title: 'impact.pageTitle', back: 'impact.backAria' },
  lab: { title: 'lab.title', back: 'settings.backAria' },
  privacy: { title: 'privacy.title', back: 'privacy.backAria' },
  settings: { title: 'settings.title', back: 'settings.backAria' },
};

export default function MypageLayout() {
  const t = useT();

  return (
    <Stack
      screenOptions={({ route }) => {
        const spec = FIXED_HEADERS[route.name];
        return {
          contentStyle: { backgroundColor: colors.hanji },
          headerShown: Boolean(spec),
          header: spec
            ? () => <SubPageHeader title={t(spec.title)} backLabel={t(spec.back)} insetTop />
            : undefined,
        };
      }}
    >
      <Stack.Screen name="index" />
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
