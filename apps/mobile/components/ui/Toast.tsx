import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Toaster, toast } from 'sonner-native';

import { colors, fontFamilies, shadows } from '~/lib/theme/tokens';

/**
 * 알림 — 웹 sonner 와 같은 호출 모양: `toast('…')` · `toast.success('…')` · `toast.error('…', { description, duration, id })`
 * · `toast.info(…)` · `toast.dismiss(id)`. 다른 점: 제목은 문자열만(웹은 ReactNode 도 받는다), action 은 `{ label, onClick }`.
 */
export { toast };

/**
 * 앱에 하나만 둔다(app/_layout.tsx). 웹 components/shell/ThemeToaster.tsx 와 같은 모양 —
 * 아래 가운데, 한지 바탕 + 선 + 먹 글자.
 *
 * 탭 막대를 덮지 않도록 기본 offset 은 탭 막대 높이 + 아래 안전 영역 + 여유다. sonner-native 0.27 은 offset 을 주면
 * `{ bottom: offset }` 만 쓰고 안전 영역을 더하지 않으므로(positioner-utils.getInsetValues) 여기서 직접 더한다
 * (탭 막대 본체는 iOS 49 · 안드로이드 56 — expo-router 기본). 탭이 없는 화면에서 낮추려면 offset(막대 높이 자리)을 넘긴다.
 * SafeAreaProvider 안에 있어야 한다(app/_layout.tsx).
 */
export const TAB_BAR_TOAST_OFFSET = Platform.select({ ios: 49, default: 56 }) + 8;

export function AppToaster({ offset = TAB_BAR_TOAST_OFFSET }: { offset?: number }) {
  const insets = useSafeAreaInsets();
  const bottomOffset = offset + insets.bottom;
  return (
    <Toaster
      position="bottom-center"
      theme="light"
      richColors
      offset={bottomOffset}
      toastOptions={{
        style: {
          backgroundColor: colors.hanji,
          borderWidth: 1,
          borderColor: colors.line,
          boxShadow: shadows.surface,
        },
        titleStyle: { color: colors.muk, fontFamily: fontFamilies.semibold, fontWeight: 'normal', fontSize: 14 },
        descriptionStyle: { color: colors['muk-soft'], fontFamily: fontFamilies.regular, fontWeight: 'normal', fontSize: 13 },
        actionButtonStyle: { minHeight: 44, justifyContent: 'center', backgroundColor: colors['gold-deep'] },
        actionButtonTextStyle: { color: colors.white, fontFamily: fontFamilies.bold, fontWeight: 'normal' },
        cancelButtonTextStyle: { color: colors['muk-soft'], fontFamily: fontFamilies.semibold, fontWeight: 'normal' },
      }}
    />
  );
}
