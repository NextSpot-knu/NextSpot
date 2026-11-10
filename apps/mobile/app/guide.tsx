// 서비스 소개 페이지 — 주소로 여는 소개(공유 링크 등). 앱 안의 진입점은 소개 모달(openGuide)이다.
//
// 웹 원본: apps/web/app/guide/page.tsx (기준 커밋 0d145a1) — 머리(border-b line · px 20 · py 16: 'NextSpot' 600 ·
// 오른쪽 '여행 시작하기' ArrowLeft 16 → /main) + 모달과 같은 본문(GuideContent). 폰 폭에서 웹은 '서비스 소개' 글자를 숨긴다(sm:inline).
// 앱: '여행 시작하기' → 홈(replace). 첫 실행 게이트는 그대로 지난다(첫 실행 중이면 소개 화면으로 보낸다).
import { router, Stack, type Href } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, Pressable, Text } from '~/components/ui';
import { GuideContent } from '~/features/onboarding/GuideContent';
import { useT } from '~/lib/i18n/I18nProvider';

export default function GuidePage() {
  const t = useT();
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-hanji" style={{ paddingTop: insets.top }}>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-row items-center justify-between border-b border-line px-[20px] py-[16px]">
        <Text className="shrink-0 text-[16px] leading-[24px] text-muk" weight="semibold">
          NextSpot
        </Text>
        <Pressable
          accessibilityRole="link"
          onPress={() => router.replace('/' as Href)}
          className="min-h-[44px] shrink-0 flex-row items-center gap-[8px] rounded-full px-[12px]"
        >
          <Icon icon={ArrowLeft} size={16} color="muk" />
          <Text className="text-[12px] leading-[16px] text-muk" numberOfLines={1}>
            {t('guide.back')}
          </Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom }}>
        <GuideContent />
      </ScrollView>
    </View>
  );
}
