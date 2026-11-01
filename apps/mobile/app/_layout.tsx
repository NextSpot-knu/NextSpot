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
import { colors, fontFamilies } from '~/lib/theme/tokens';

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  // Ensure that reloading on `/modal` keeps a back button present.
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
  // Expo 템플릿 화면(components/StyledText · EditScreenInfo)이 쓴다 — 없으면 iOS 개발 빌드가 'Unrecognized font family' 로 멈춘다.
  // 템플릿 화면을 지울 때 이 줄과 assets/fonts/SpaceMono-Regular.ttf 도 지운다.
  SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
};

// 내비게이션 바탕·헤더도 한지 톤으로(라이트만).
const navTheme = {
  ...DefaultTheme,
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
          <ThemeProvider value={navTheme}>
            <Stack>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="modal" options={{ presentation: 'modal' }} />
            </Stack>
          </ThemeProvider>
          <AppToaster />
        </BottomSheetModalProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
