import '../global.css';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useFonts } from 'expo-font';
import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppToaster } from '~/components/ui';
import { ShellBridge } from '~/lib/appShell';
import { AppProviders } from '~/lib/core/AppProviders';
import { I18nProvider, useT } from '~/lib/i18n/I18nProvider';
import { colors, fontFamilies } from '~/lib/theme/tokens';

// 렌더 오류 화면 — expo-router 기본(영어) 대신 웹과 같은 문구 키(common.error · common.retry).
export { AppErrorBoundary as ErrorBoundary } from '~/components/AppErrorBoundary';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

// 글꼴이 실릴 때까지 스플래시를 둔다 — 모듈 범위에서 불러야 늦지 않는다(Expo SDK 57 splash-screen 문서).
SplashScreen.preventAutoHideAsync();

// Freesentation(OFL, 공식 배포본 2.001 TTF — assets/fonts/OFL.txt). 굵기마다 family 이름이 하나다(안드로이드).
// 키 = tokens.fontFamilies 의 값 = 파일 이름. 이름을 바꾸면 tokens.test.ts 가 파일이 없다고 깨진다.
const FONT_FILES = {
  [fontFamilies.regular]: require('../assets/fonts/Freesentation-4Regular.ttf'),
  [fontFamilies.medium]: require('../assets/fonts/Freesentation-5Medium.ttf'),
  [fontFamilies.semibold]: require('../assets/fonts/Freesentation-6SemiBold.ttf'),
  [fontFamilies.bold]: require('../assets/fonts/Freesentation-7Bold.ttf'),
  [fontFamilies.extrabold]: require('../assets/fonts/Freesentation-8ExtraBold.ttf'),
  [fontFamilies.black]: require('../assets/fonts/Freesentation-9Black.ttf'),
};

// 내비게이션 바탕·헤더도 한지 톤으로(라이트만). 헤더·탭 글자도 Freesentation — 굵기는 글꼴 파일이 맡으므로
// fontWeight 는 normal(안드로이드가 이미 굵은 파일을 한 번 더 굵히지 않게).
const navTheme = {
  ...DefaultTheme,
  fonts: {
    regular: { fontFamily: fontFamilies.regular, fontWeight: 'normal' as const },
    medium: { fontFamily: fontFamilies.medium, fontWeight: 'normal' as const },
    bold: { fontFamily: fontFamilies.semibold, fontWeight: 'normal' as const },
    heavy: { fontFamily: fontFamilies.bold, fontWeight: 'normal' as const },
  },
  colors: {
    ...DefaultTheme.colors,
    primary: colors['gold-deep'],
    background: colors.hanji,
    card: colors.hanji,
    text: colors.muk,
    border: colors.line,
  },
};

export default function RootLayout() {
  const [loaded, error] = useFonts(FONT_FILES);

  // 글꼴을 못 실어도 앱은 연다(기기 글꼴로 대신 그린다) — 스플래시에 갇히지 않게.
  useEffect(() => {
    if (error) console.warn('font load failed', error);
    if (loaded || error) SplashScreen.hide();
  }, [loaded, error]);

  if (!loaded && !error) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.hanji }}>
      <SafeAreaProvider>
        <BottomSheetModalProvider>
          <I18nProvider>
            <ProvidersWithLabels>
              <ThemeProvider value={navTheme}>
                <Stack>
                  <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                </Stack>
              </ThemeProvider>
              <ShellBridge />
            </ProvidersWithLabels>
          </I18nProvider>
          <AppToaster />
        </BottomSheetModalProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// 세션·계정·공개 설정 제공자 — 점검·공지 문구는 웹과 같은 systemNotice.* 키(4로케일)를 쓴다.
function ProvidersWithLabels({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <AppProviders
      publicSettingsLabels={{
        maintenanceTitle: t('systemNotice.maintenanceTitle'),
        maintenanceBody: t('systemNotice.maintenanceBody'),
        dismiss: t('systemNotice.dismiss'),
      }}
    >
      {children}
    </AppProviders>
  );
}
