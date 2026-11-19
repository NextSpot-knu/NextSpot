// 화면이 렌더 중에 죽었을 때의 자리 — expo-router 기본 ErrorBoundary(영어 · 개발자용 문구) 대신 웹 app/error.tsx 모양.
//
// 웹 원본: apps/web/app/error.tsx:29-44 (기준 커밋 0d145a1) — 가운데 정렬 한지 바탕, 64 원(gold 15% · 테두리 gold) 안
// AlertTriangle 28 gold-deep · mb 24, 제목 20 bold '문제가 발생했어요' · mb 8, 'Something went wrong.' 14 muk-soft · mb 4,
// '잠시 후 다시 시도해 주세요.' 14 muk-soft · mb 32, 버튼 rounded-xl 금 + RotateCcw 16(굵기 2.5) '다시 시도'.
// 앱(G1-32 B): 웹은 한국어를 박아 두었다 — 앱은 지금 언어로 번역한다(common.error · app.error.retryHint · common.retry).
// 영어 둘째 줄은 ko 일 때만(다른 언어는 이미 그 언어로 읽힌다). 버튼 바탕은 button-gold(결정 D2 — 흰 글자 대비).
// 루트 레이아웃이 죽으면 제공자(I18n · SafeArea)가 없으므로 훅 없이 지금 언어(localeState)로 직접 번역하고,
// 안전 영역은 넉넉한 고정 여백으로 대신한다.
import type { ErrorBoundaryProps } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { AlertTriangle, RotateCcw } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Icon, Pressable, Text } from '~/components/ui';
import { ensureMessages } from '~/lib/i18n/catalog';
import { getCurrentLocale } from '~/lib/i18n/localeState';
import { createTranslator } from '~/lib/i18n/translate';
import { colors } from '~/lib/theme/tokens';

export function AppErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const [retrying, setRetrying] = useState(false);
  const locale = getCurrentLocale();
  const t = createTranslator(locale, ensureMessages(locale));

  useEffect(() => {
    console.warn('[app] 화면 오류:', error);
    // 글꼴을 싣기 전에 죽었으면 스플래시에 갇히지 않게 닫는다.
    SplashScreen.hide();
  }, [error]);

  return (
    <View
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, backgroundColor: colors.hanji }}
      accessibilityRole="alert"
    >
      <View
        className="mb-[24px] h-[64px] w-[64px] items-center justify-center rounded-full border border-gold"
        style={{ backgroundColor: 'rgba(193, 154, 62, 0.15)' }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Icon icon={AlertTriangle} size={28} color="gold-deep" />
      </View>
      <Text className="mb-[8px] text-center text-xl text-muk" weight="bold" accessibilityRole="header">
        {t('common.error')}
      </Text>
      {locale === 'ko' && <Text className="mb-[4px] text-center text-sm text-muk-soft">Something went wrong.</Text>}
      <Text className="mb-[32px] text-center text-sm text-muk-soft">{t('app.error.retryHint')}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy: retrying, disabled: retrying }}
        disabled={retrying}
        onPress={() => {
          setRetrying(true);
          retry().finally(() => setRetrying(false));
        }}
        className="min-h-[48px] flex-row items-center gap-[8px] rounded-xl bg-button-gold px-[24px] py-[12px]"
        style={retrying ? { opacity: 0.6 } : undefined}
      >
        <Icon icon={RotateCcw} size={16} strokeWidth={2.5} color="white" />
        <Text className="text-[16px] leading-[24px] text-white" weight="bold">
          {t('common.retry')}
        </Text>
      </Pressable>
    </View>
  );
}
