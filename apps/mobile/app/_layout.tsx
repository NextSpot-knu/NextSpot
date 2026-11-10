import '../global.css';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useFonts } from 'expo-font';
import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppToaster } from '~/components/ui';
import { FirstRunGate, useFirstRunGate } from '~/features/onboarding';
import { shouldTrackPageView } from '~/features/onboarding/firstRun';
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
        <I18nProvider>
          <ProvidersWithLabels>
            <ThemeProvider value={navTheme}>
              {/* 모달 시트 포털은 이 Provider 의 자식 뒤에 그려진다 — 시트 안에서도 useI18n()·세션·테마가 닿도록 그 안쪽에 둔다(G2-G07). */}
              <BottomSheetModalProvider>
                <Stack screenOptions={{ contentStyle: { backgroundColor: colors.hanji } }}>
                  <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                  {/* 첫 실행 단계(소개·동의 / 첫 설정)는 자기 화면 안에 뒤로 버튼을 그린다. 스와이프로 앞 단계로 되돌아가지 않게 막는다. */}
                  <Stack.Screen name="intro" options={{ headerShown: false, gestureEnabled: false }} />
                  <Stack.Screen name="setup" options={{ headerShown: false, gestureEnabled: false }} />
                  {/* 로그인·재설정 메일은 화면 안 헤더를 쓴다. 뒤로 스와이프는 허용. */}
                  <Stack.Screen name="login" options={{ headerShown: false }} />
                  <Stack.Screen name="forgot-password" options={{ headerShown: false }} />
                  {/* OAuth 복귀는 처리 중에 빠져나가면 교환 결과를 잃는다 — 스와이프로 닫지 않는다. */}
                  <Stack.Screen name="auth/callback" options={{ headerShown: false, gestureEnabled: false }} />
                  {/* 대안 화면은 루트 헤더(뒤로)를 쓰고 제목·왼쪽 버튼은 화면이 정한다. */}
                  <Stack.Screen name="explore/recommend" options={{ headerBackButtonDisplayMode: 'minimal' }} />
                  {/* 마이페이지 하위 화면은 자기 Stack(app/mypage/_layout)이 헤더를 그린다 — 헤더가 둘이 되지 않게. */}
                  <Stack.Screen name="mypage" options={{ headerShown: false }} />
                </Stack>
                {/* 첫 실행 게이트 — 라우터 훅을 쓰므로 Stack 과 같은 트리 안, Stack 바로 뒤(features/onboarding/FirstRunGate). */}
                <FirstRunGate />
                <TrackedShellBridge />
              </BottomSheetModalProvider>
            </ThemeProvider>
          </ProvidersWithLabels>
        </I18nProvider>
        <AppToaster />
        {/* 앱은 라이트(한지)만 — 상태 표시줄 글자를 어둡게 고정한다. */}
        <StatusBar style="dark" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// 이용 기록 연결(page_view) — 첫 실행 화면으로 보낼 참인 경로(콜드 스타트의 '/' 등)에서는 그리지 않는다.
// 그래서 소개로 바뀌기 전의 홈('/main')이 기록되지 않고, 소개 화면에 닿은 뒤 그 경로로 한 번 기록된다.
function TrackedShellBridge() {
  const { redirectTo } = useFirstRunGate();
  return shouldTrackPageView(redirectTo) ? <ShellBridge /> : null;
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
