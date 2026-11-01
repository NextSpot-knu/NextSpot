import { Toaster, toast } from 'sonner-native';

import { colors, fontFamilies, shadows } from '~/lib/theme/tokens';

/**
 * 알림 — 웹 sonner 와 같은 호출 모양: `toast('…')` · `toast.success('…')` · `toast.error('…', { description, duration, id })`
 * · `toast.info(…)` · `toast.dismiss(id)`. 다른 점: 제목은 문자열만(웹은 ReactNode 도 받는다), action 은 `{ label, onClick }`.
 */
export { toast };

/**
 * 앱에 하나만 둔다(app/_layout.tsx). 웹 components/shell/ThemeToaster.tsx 와 같은 모양 —
 * 아래 가운데, 한지 바탕 + 선 + 먹 글자. 탭 막대 위로 띄우는 높이는 offset.
 */
export function AppToaster({ offset }: { offset?: number }) {
  return (
    <Toaster
      position="bottom-center"
      theme="light"
      richColors
      offset={offset}
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
