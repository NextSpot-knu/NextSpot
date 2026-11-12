// 없는 경로(잘못된 딥링크 등) — 웹 app/not-found.tsx 와 같은 모양·문구.
//
// 웹 원본: apps/web/app/not-found.tsx:23-63 (기준 커밋 0d145a1), 값은 docs/parity/findings-G1.md G1-31 + 검토 R1.
//   바탕 노을·금빛 광원 둘(520 · blur 120 — Glow 프리셋 waiting 과 같은 자리·값), 위 64 · 좌우 24, 가운데 열 최대 448.
//   마스코트 아바타 96 · 큰 '404'(64/64 black · gold-deep 85% · tabular-nums) · 제목 22 black · 본문 14 ·
//   주 알약 '지도로 돌아가기'(48 · 15px · px 28 · MapPin 18) · 보조 알약 '분산 코스 보기'(44 · 13px · Compass 16) · 브랜드 줄 11px.
// 주 알약 바탕은 금→주칠 대신 cta(금 진→주칠) — 흰 글자 대비(결정 D2 (b)②, 웹도 W1 에서 cta-primary 로).
import { router, Stack, type Href } from 'expo-router';
import { Compass, MapPin } from 'lucide-react-native';
import { View } from 'react-native';

import { NextSpotMascot } from '~/components/NextSpotMascot';
import { Button, Icon, Pressable, Screen, Text } from '~/components/ui';
import { GlowPair } from '~/components/ui/Glow';
import { useT } from '~/lib/i18n/I18nProvider';

export default function NotFoundScreen() {
  const t = useT();
  return (
    <View className="flex-1 overflow-hidden bg-hanji">
      <Stack.Screen options={{ headerShown: false }} />
      <GlowPair preset="waiting" />
      <Screen scroll className="bg-transparent" contentClassName="items-center px-[24px] pb-[64px] pt-[64px]">
        <View className="w-full max-w-[448px] items-center">
          <View className="mb-[24px]">
            <NextSpotMascot variant="avatar" size={96} />
          </View>

          {/* 큰 404 — 장식이지만 무슨 화면인지 바로 말해 주는 기호(웹과 같이 읽힌다). */}
          <Text
            className="text-[64px] leading-[64px]"
            weight="black"
            style={{ color: 'rgba(112, 88, 25, 0.85)', letterSpacing: -1.6, fontVariant: ['tabular-nums'] }}
          >
            404
          </Text>

          <Text
            className="mt-[16px] text-center text-[22px] leading-[30.25px] text-muk"
            weight="black"
            accessibilityRole="header"
            style={{ letterSpacing: -0.55 }}
          >
            {t('notFound.title')}
          </Text>
          <Text className="mt-[8px] text-center text-[14px] leading-[22.75px] text-muk-soft">{t('notFound.body')}</Text>

          <Button
            className="mt-[32px]"
            label={t('notFound.backToMap')}
            icon={MapPin}
            iconSize={18}
            size={48}
            labelSize={15}
            shape="full"
            paddingX={28}
            shadow="cta"
            onPress={() => router.replace('/' as Href)}
          />

          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace('/course' as Href)}
            className="mt-[12px] min-h-[44px] flex-row items-center justify-center gap-[6px] rounded-full border border-line px-[20px]"
            style={{ backgroundColor: 'rgba(255, 255, 255, 0.9)', boxShadow: '0px 2px 10px rgba(43, 35, 32, 0.06)' }}
          >
            <Icon icon={Compass} size={16} color="gold-deep" />
            <Text className="text-[13px] leading-[19.5px] text-muk" weight="bold">
              {t('notFound.exploreCourse')}
            </Text>
          </Pressable>

          <Text className="mt-[40px] text-center text-[11px] leading-[17.9px]" style={{ color: 'rgba(107, 93, 79, 0.8)' }}>
            {t('notFound.brandLine')}
          </Text>
        </View>
      </Screen>
    </View>
  );
}
