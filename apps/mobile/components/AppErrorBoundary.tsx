// 화면이 렌더 중에 죽었을 때의 자리 — expo-router 기본 ErrorBoundary(영어 · 개발자용 문구) 대신 웹과 같은 문구 키
// common.error · common.retry 로 보여 준다. 루트 레이아웃이 죽으면 제공자(I18n · SafeArea)가 없으므로
// 훅 없이 지금 언어(localeState)로 직접 번역하고, 안전 영역은 넉넉한 고정 여백으로 대신한다.
import type { ErrorBoundaryProps } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { ErrorState } from '~/components/ui';
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
    <View style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: colors.hanji }}>
      <ErrorState
        message={t('common.error')}
        retryLabel={t('common.retry')}
        retrying={retrying}
        onRetry={() => {
          setRetrying(true);
          retry().finally(() => setRetrying(false));
        }}
      />
    </View>
  );
}
