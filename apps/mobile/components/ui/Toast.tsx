import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Platform,
  Pressable as RNPressable,
  Text as RNText,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { Toaster, toast as sonnerToast, type ToastAction } from 'sonner-native';

import { useNavInsets } from '~/components/navigation/navMetrics';
import { colors, fontFamilies } from '~/lib/theme/tokens';

import { DEFAULT_MAX_FONT_SCALE } from './Text';
import {
  REPORT_TOAST,
  REPORT_TOASTER_ID,
  TOAST_BOX,
  TOAST_BUTTON,
  TOAST_ICON,
  TOAST_STACK,
  TOAST_TEXT,
  announcementText,
  isActionButton,
  reportToastBottom,
  toastSideMargin,
} from './toastSpec';

export { REPORT_TOASTER_ID };

// ── 모양(웹 sonner 값 — toastSpec.ts) ──────────────────────────────────────────────────────────────────
// 웹 ThemeToaster: 아래 가운데, 한지 바탕 + 1px line + 먹 글자(richColors 의 색 바탕은 인라인 style 이 덮는다), 상자는 sonner 기본.
// 글꼴은 D17(b) — 웹은 sonner 기본 시스템 글꼴(웹 쪽 버그로 W1 이 font-sans 로 고친다), 앱은 Freesentation.

const BOX_STYLE = {
  backgroundColor: colors.hanji,
  borderWidth: 1,
  borderColor: colors.line,
  borderRadius: TOAST_BOX.borderRadius,
  padding: TOAST_BOX.padding,
  boxShadow: TOAST_BOX.shadow,
  // sonner-native 의 기본 elevation 그림자를 끈다(boxShadow 와 겹치지 않게).
  elevation: 0,
  shadowOpacity: 0,
} as const;

const TITLE_STYLE = {
  color: colors.muk,
  fontFamily: fontFamilies.medium,
  fontWeight: 'normal',
  fontSize: TOAST_TEXT.titleSize,
  lineHeight: TOAST_TEXT.titleLineHeight,
} as const;

const DESCRIPTION_STYLE = {
  // 웹 richColors 의 설명은 color: inherit → 먹.
  color: colors.muk,
  fontFamily: fontFamilies.regular,
  fontWeight: 'normal',
  fontSize: TOAST_TEXT.descriptionSize,
  lineHeight: TOAST_TEXT.descriptionLineHeight,
  marginTop: TOAST_TEXT.contentGap,
} as const;

// ── 아이콘(웹 sonner 의 채운 원 아이콘 경로 그대로, 색은 먹) ─────────────────────────────────────────────
type GlyphVariant = 'success' | 'info' | 'warning' | 'error';

const GLYPHS: Record<GlyphVariant, { viewBox: string; d: string }> = {
  success: {
    viewBox: '0 0 20 20',
    d: 'M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z',
  },
  warning: {
    viewBox: '0 0 24 24',
    d: 'M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zm0 8.25a.75.75 0 100-1.5.75.75 0 000 1.5z',
  },
  info: {
    viewBox: '0 0 20 20',
    d: 'M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z',
  },
  error: {
    viewBox: '0 0 20 20',
    d: 'M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z',
  },
};

/** sonner [data-icon]: 상자 16(왼쪽 −3 · 오른쪽 4) 안에 20 아이콘(왼쪽 −1), 세로 가운데. 장식이라 읽지 않는다. */
function ToastGlyph({ variant }: { variant: GlyphVariant }) {
  const glyph = GLYPHS[variant];
  return (
    <View
      style={{
        width: TOAST_ICON.box,
        height: TOAST_ICON.box,
        marginLeft: TOAST_ICON.marginStart,
        marginRight: TOAST_ICON.marginEnd,
        justifyContent: 'center',
        alignItems: 'flex-start',
        overflow: 'visible',
      }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width={TOAST_ICON.svg} height={TOAST_ICON.svg} viewBox={glyph.viewBox} style={{ marginLeft: TOAST_ICON.svgMarginStart }}>
        <Path d={glyph.d} fill={colors.muk} fillRule="evenodd" clipRule="evenodd" />
      </Svg>
    </View>
  );
}

/**
 * 기본 toast() 는 아이콘 없음(웹 sonner 와 같다). sonner-native 는 toast() 와 toast.info() 가 같은 'info' 변형이라
 * info 를 비우고, toast.info 는 아이콘을 직접 넘긴다(아래 toast 감싸개).
 */
const TOAST_ICONS = {
  success: <ToastGlyph variant="success" />,
  error: <ToastGlyph variant="error" />,
  warning: <ToastGlyph variant="warning" />,
  info: null,
};

// ── 행동·취소 버튼이 있는 토스트 — 웹 sonner 처럼 글자 오른쪽 같은 줄 ─────────────────────────────────────
// sonner-native 0.27 은 버튼을 글자 아래 줄에 그리고(toast-content.tsx: 버튼 칸이 글자 칸 안), 순서가 행동 → 취소이며,
// 행동을 눌러도 닫지 않는다. 웹은 [글자][취소][행동] 한 줄, 버튼마다 왼쪽 여백 auto, 행동을 누르면 닫힌다.
// 그래서 { label, onClick } 버튼이 있으면 같은 상자를 직접 그린다(toast.custom — 쌓임·밀어 닫기·시간은 그대로).

type CardVariant = 'default' | GlyphVariant;

function InlineButton({ kind, label, onPress }: { kind: 'action' | 'cancel'; label: string; onPress: () => void }) {
  const action = kind === 'action';
  const slop = (44 - TOAST_BUTTON.height) / 2;
  return (
    <RNPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      // 좌우는 늘리지 않는다 — 취소 가장자리를 누른 손가락이 옆의 되돌릴 수 없는 행동 버튼에 닿지 않게(위아래만 44pt 로).
      hitSlop={{ top: slop, bottom: slop, left: 0, right: 0 }}
      style={({ pressed }) => ({
        marginLeft: 'auto',
        flexShrink: 0,
        minHeight: TOAST_BUTTON.height,
        paddingHorizontal: TOAST_BUTTON.paddingX,
        borderRadius: TOAST_BUTTON.borderRadius,
        justifyContent: 'center',
        backgroundColor: action ? TOAST_BUTTON.ink : TOAST_BUTTON.cancelBg,
        opacity: pressed ? 0.88 : 1,
      })}
    >
      <RNText
        numberOfLines={1}
        maxFontSizeMultiplier={DEFAULT_MAX_FONT_SCALE}
        style={{
          color: action ? TOAST_BUTTON.paper : TOAST_BUTTON.ink,
          fontFamily: fontFamilies.medium,
          fontWeight: 'normal',
          fontSize: TOAST_BUTTON.fontSize,
          lineHeight: 16,
        }}
      >
        {label}
      </RNText>
    </RNPressable>
  );
}

/**
 * 읽기 화면에 알린다(TalkBack · VoiceOver). 안드로이드 16 은 announceForAccessibility 를 '권장하지 않음'으로 돌렸지만 아직
 * 동작한다 — 실시간 영역(accessibilityLiveRegion)과 함께 둔다. 기본 sonner-native 토스트에는 실시간 영역이 없어 이것이 유일한 알림이다.
 */
function announce(title: string, description?: string) {
  const text = announcementText(title, description);
  if (!text) return;
  try {
    if (typeof AccessibilityInfo.announceForAccessibility === 'function') AccessibilityInfo.announceForAccessibility(text);
  } catch {
    // 알림 실패는 토스트 표시를 막지 않는다.
  }
}

/** 행동·취소 토스트의 생애 알림(confirmDestructive 가 쓴다). */
export type InlineToastHooks = {
  /** 채널에 실제로 그려졌을 때(채널이 살아 있음 — 이제 sonner-native 의 시간 초과가 돈다). */
  onShown?: () => void;
  /** 그려졌던 토스트가 사라졌을 때(닫힘 · 시간 초과 · 채널 Toaster 해제로 콜백 없이 버려짐 모두). */
  onGone?: () => void;
  /** 그려지면 읽기 화면 초점을 글자 칸으로 옮긴다(화면 읽기 사용자 — 시간 안에 버튼에 닿게). */
  focusOnShow?: boolean;
};

/** 들어오는 애니메이션(sonner-native ENTERING_ANIMATION_DURATION 300) 뒤에 초점을 옮긴다. */
const FOCUS_DELAY_MS = 350;

function InlineToast({
  id,
  variant,
  title,
  description,
  action,
  cancel,
  hooks,
}: {
  id: string | number;
  variant: CardVariant;
  title: string;
  description?: string;
  action?: ToastAction | ReactNode;
  cancel?: ToastAction | ReactNode;
  hooks?: InlineToastHooks;
}) {
  const { width } = useWindowDimensions();
  const textRef = useRef<View>(null);
  // 같은 id 로 내용이 바뀌면(새 확인) 컴포넌트는 그대로이고 hooks 만 바뀐다 — 늘 마지막 hooks 를 부른다.
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    hooksRef.current?.onShown?.();
    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    if (hooksRef.current?.focusOnShow && Platform.OS !== 'web') {
      focusTimer = setTimeout(() => {
        // 새 아키텍처에서는 setAccessibilityFocus(findNodeHandle) 가 옛 경로라 듣지 않을 수 있다 — 참조로 초점 이벤트를 보낸다.
        if (textRef.current) AccessibilityInfo.sendAccessibilityEvent(textRef.current, 'focus');
      }, FOCUS_DELAY_MS);
    }
    return () => {
      if (focusTimer) clearTimeout(focusTimer);
      mountedRef.current = false;
      // 개발 StrictMode 는 효과를 '정리 → 다시 실행' 한다. 한 박자 뒤에도 다시 붙지 않았을 때만 사라진 것으로 본다.
      setTimeout(() => {
        if (!mountedRef.current) hooksRef.current?.onGone?.();
      }, 0);
    };
  }, []);
  // 같은 id 로 새 확인이 들어와 이미 그려진 토스트가 바뀌면, 새 hooks 에도 '그려졌음'을 알린다(다시 마운트되지 않으므로).
  useEffect(() => {
    if (mountedRef.current) hooks?.onShown?.();
  }, [hooks]);
  // 웹 sonner: 버튼을 누르면(행동도) 토스트가 닫힌다. 닫기는 늘 onClick 다음 — confirmDestructive 가 답을 먼저 정한다.
  const press = (button: ToastAction) => () => {
    button.onClick();
    sonnerToast.dismiss(id);
  };
  return (
    <View
      style={[
        BOX_STYLE,
        { marginHorizontal: toastSideMargin(width), flexDirection: 'row', alignItems: 'center', gap: TOAST_BOX.gap },
      ]}
    >
      {variant === 'default' ? null : <ToastGlyph variant={variant} />}
      {/* 제목·설명을 한 칸으로 읽는다 — 그다음 칸이 [취소][행동]. */}
      <View
        ref={textRef}
        style={{ flexShrink: 1 }}
        accessible
        accessibilityLabel={announcementText(title, description)}
      >
        <RNText maxFontSizeMultiplier={DEFAULT_MAX_FONT_SCALE} style={TITLE_STYLE}>
          {title}
        </RNText>
        {description ? (
          <RNText maxFontSizeMultiplier={DEFAULT_MAX_FONT_SCALE} style={DESCRIPTION_STYLE}>
            {description}
          </RNText>
        ) : null}
      </View>
      {isActionButton(cancel) ? <InlineButton kind="cancel" label={cancel.label} onPress={press(cancel)} /> : (cancel ?? null)}
      {isActionButton(action) ? <InlineButton kind="action" label={action.label} onPress={press(action)} /> : (action ?? null)}
    </View>
  );
}

// ── toast — 웹 sonner 와 같은 호출 모양 ────────────────────────────────────────────────────────────────

type SonnerToast = typeof sonnerToast;
export type ToastOptions = NonNullable<Parameters<SonnerToast>[1]>;

let inlineSeq = 0;

function show(
  variant: CardVariant,
  title: string,
  data: ToastOptions | undefined,
  plain: () => string | number,
  hooks?: InlineToastHooks,
) {
  // 한 번만 읽힌다: 알림(announce)이 유일한 낭독이고 카드에는 실시간 영역을 두지 않는다. 초점을 옮기는 확인은 초점이 읽는다.
  if (!hooks?.focusOnShow) announce(title, data?.description);
  if (!data || !(isActionButton(data.action) || isActionButton(data.cancel))) return plain();
  const { action, cancel, description, icon: _icon, ...rest } = data;
  const id = rest.id ?? `app-toast-${++inlineSeq}`;
  return sonnerToast.custom(
    <InlineToast id={id} variant={variant} title={title} description={description} action={action} cancel={cancel} hooks={hooks} />,
    { ...rest, id },
  );
}

/**
 * 행동·취소 버튼 토스트를 생애 알림과 함께 띄운다 — confirmDestructive 전용(화면은 toast() 를 쓴다).
 * data.action 이나 data.cancel 이 { label, onClick } 이어야 hooks 가 불린다.
 */
export function showInlineToast(title: string, data: ToastOptions, hooks: InlineToastHooks) {
  return show('default', title, data, () => sonnerToast(title, data), hooks);
}

/**
 * 알림 — 웹 sonner 와 같은 호출 모양: `toast('…')` · `toast.success('…')` · `toast.error('…', { description, duration, id })`
 * · `toast.info(…)` · `toast.dismiss(id)`. 다른 점: 제목은 문자열만(웹은 ReactNode 도 받는다), action·cancel 은 `{ label, onClick }`.
 *  - 기본 `toast()` 는 아이콘 없음, success·info·warning·error 는 먹색 채운 원 아이콘(웹 richColors + 먹 글자색).
 *  - action·cancel 이 있으면 웹처럼 글자 오른쪽 같은 줄에 [취소][행동](검정 24px), 어느 버튼이든 누르면 닫힌다.
 *  - 다른 채널(RN Modal 안 `<AppToaster id="profileEdit" />`)에 띄우려면 `{ toasterId: 'profileEdit' }`.
 * 되돌릴 수 없는 동작의 확인은 `confirmDestructive()`(components/ui/confirmToast.ts).
 */
export const toast: SonnerToast = Object.assign(
  (title: string, data?: ToastOptions) => show('default', title, data, () => sonnerToast(title, data)),
  {
    success: (title: string, data?: ToastOptions) => show('success', title, data, () => sonnerToast.success(title, data)),
    info: (title: string, data?: ToastOptions) =>
      show('info', title, data, () => sonnerToast.info(title, { icon: <ToastGlyph variant="info" />, ...data })),
    error: (title: string, data?: ToastOptions) => show('error', title, data, () => sonnerToast.error(title, data)),
    warning: (title: string, data?: ToastOptions) => show('warning', title, data, () => sonnerToast.warning(title, data)),
    custom: sonnerToast.custom,
    promise: sonnerToast.promise,
    loading: sonnerToast.loading,
    dismiss: sonnerToast.dismiss,
    wiggle: sonnerToast.wiggle,
  },
);

// ── 혼잡 제보 결과(G3-22) — 이름 붙은 채널 'report' ─────────────────────────────────────────────────────

function ReportToastBody({ message, kind }: { message: string; kind: 'success' | 'error' }) {
  return (
    <View
      pointerEvents="none"
      style={{
        alignSelf: 'center',
        width: '100%',
        maxWidth: REPORT_TOAST.maxWidth,
        paddingHorizontal: REPORT_TOAST.sideInset,
        alignItems: 'center',
      }}
    >
      <View
        style={{
          borderRadius: REPORT_TOAST.radius,
          paddingHorizontal: REPORT_TOAST.paddingX,
          paddingVertical: REPORT_TOAST.paddingY,
          backgroundColor: kind === 'success' ? colors.jade : colors.terracotta,
          boxShadow: REPORT_TOAST.shadow,
        }}
      >
        <RNText
          maxFontSizeMultiplier={DEFAULT_MAX_FONT_SCALE}
          style={{
            color: colors.white,
            fontFamily: fontFamilies.bold,
            fontWeight: 'normal',
            fontSize: REPORT_TOAST.fontSize,
            lineHeight: REPORT_TOAST.lineHeight,
            textAlign: 'center',
          }}
        >
          {message}
        </RNText>
      </View>
    </View>
  );
}

/**
 * 혼잡 제보 결과 토스트(웹 CongestionReportButton 의 자체 토스트) — 성공 청록 · 실패 주칠 알약, 화면 아래 96, 3.2초, 한 번에 하나.
 * AppToaster(채널 'report')가 그린다.
 */
export function reportToast(message: string, kind: 'success' | 'error') {
  announce(message);
  return sonnerToast.custom(<ReportToastBody message={message} kind={kind} />, {
    id: REPORT_TOAST.id,
    toasterId: REPORT_TOASTER_ID,
    duration: REPORT_TOAST.duration,
  });
}

// ── AppToaster ────────────────────────────────────────────────────────────────────────────────────

export type AppToasterProps = {
  /**
   * 채널 이름 — 주면 그 채널 하나만 그린다. RN Modal 은 따로 그려지는 창이라 루트 토스트가 Modal 뒤에 깔린다 —
   * Modal 안에 `<AppToaster id="profileEdit" />` 를 두고 그 Modal 의 토스트에 `{ toasterId: 'profileEdit' }` 를 준다(G5b-17).
   * 없으면 앱 기본 채널 + 혼잡 제보 채널('report')을 그린다(app/_layout.tsx 에 하나).
   */
  id?: string;
  /** 화면 아래에서 잰 자리(pt, 아래 안전 영역 포함). 기본은 navMetrics 의 toastBottom(탭 화면 = 막대 위 8, 그 밖 = 16 + 안전 영역). */
  offset?: number;
};

/**
 * 토스트 자리·모양을 정하는 한 곳(docs/MOBILE_WEB_PARITY.md §4.2 F9). SafeAreaProvider 와 라우터 안에 있어야 한다(경로로 자리를 정한다).
 * sonner-native 0.27 은 offset 을 주면 `{ bottom: offset }` 만 쓰고 안전 영역을 더하지 않는다(positioner-utils.getInsetValues) —
 * toastBottom 이 이미 안전 영역을 포함한다.
 */
export function AppToaster({ id, offset }: AppToasterProps) {
  const nav = useNavInsets();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const side = toastSideMargin(width);
  const toastOptions = useMemo(
    () => ({
      style: { ...BOX_STYLE, marginHorizontal: side },
      toastContentStyle: { gap: TOAST_BOX.gap, alignItems: 'center' as const },
      titleStyle: TITLE_STYLE,
      descriptionStyle: DESCRIPTION_STYLE,
    }),
    [side],
  );
  const channel = (
    <Toaster
      id={id}
      // iOS: RN Modal(따로 띄운 창) 안의 채널은 FullWindowOverlay 로 감싸지 않는다(sonner-native ToasterProps 주석).
      fullWindowOverlay={id ? false : undefined}
      position="bottom-center"
      theme="light"
      offset={offset ?? nav.toastBottom}
      duration={TOAST_STACK.duration}
      enableStacking
      gap={TOAST_STACK.gap}
      visibleToasts={TOAST_STACK.visible}
      icons={TOAST_ICONS}
      maxFontSizeMultiplier={DEFAULT_MAX_FONT_SCALE}
      toastOptions={toastOptions}
    />
  );
  if (id) return channel;
  return (
    <>
      {channel}
      <Toaster
        id={REPORT_TOASTER_ID}
        position="bottom-center"
        theme="light"
        offset={reportToastBottom(insets.bottom)}
        visibleToasts={1}
        toastOptions={{ unstyled: true }}
      />
    </>
  );
}
