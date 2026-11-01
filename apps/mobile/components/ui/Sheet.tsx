import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
  type BottomSheetBackdropProps,
  type BottomSheetHandleProps,
} from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { View, type AccessibilityActionEvent } from 'react-native';
import { ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// 웹 lib/sheetSnap.ts 의 상태 이름을 그대로 쓴다(순수 모듈 — check:shared 통과).
import type { SheetState } from '@/lib/sheetSnap';
import { colors, springs } from '~/lib/theme/tokens';

export type { SheetState };
export { BottomSheetScrollView as SheetScrollView, BottomSheetView as SheetView } from '@gorhom/bottom-sheet';

const ORDER: readonly SheetState[] = ['minimized', 'normal', 'expanded'];
const DEFAULT_SNAPS = ['18%', '45%', '88%'] as const;

const SHEET_ANIMATION = { ...springs.sheet, reduceMotion: ReduceMotion.System };

const background = {
  backgroundColor: 'rgba(255, 255, 255, 0.95)', // 웹 bg-white/95
  borderColor: colors.line,
  borderWidth: 1,
  borderRadius: 24, // 웹 rounded-3xl
};

/** 웹 카드 머리의 손잡이(w-16 h-1.5 bg-muk/20)를 읽기 화면에서 '조절' 할 수 있는 요소로. */
function Handle({
  label,
  onStep,
}: {
  label: string;
  onStep: (dir: 1 | -1) => void;
}) {
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e: AccessibilityActionEvent) => onStep(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
      className="items-center pb-[6px] pt-[10px]"
    >
      <View className="h-[6px] w-[64px] rounded-full bg-muk/20" />
    </View>
  );
}

export type SheetProps = {
  children: ReactNode;
  /**
   * 세 높이 [미리보기, 기본, 펼침] — 웹 추천 카드(RecommendationCard)의 minimized · normal · expanded.
   * px 또는 '%' 문자열, 작은 것부터. 기본 ['18%', '45%', '88%'].
   */
  snapPoints?: readonly [number | string, number | string, number | string];
  /** 제어 — 지금 높이. 바꾸면 그 높이로 움직인다. */
  state?: SheetState;
  /** 처음 높이(제어하지 않을 때). 기본 normal. */
  initialState?: SheetState;
  /** 사용자가 끌어서 다른 높이에 걸렸을 때. */
  onStateChange?: (state: SheetState) => void;
  /** 손잡이 읽기 라벨(예: t('card.open')). 읽기 화면에서 위·아래로 쓸어 높이를 바꾼다. */
  handleLabel: string;
  /** 아래 탭 막대 높이만큼 띄운다(pt). */
  bottomInset?: number;
};

/**
 * 끌어서 높이를 바꾸는 바닥 시트(지도 화면의 추천 카드). @gorhom/bottom-sheet 의 얇은 껍데기.
 * - 높이는 셋, 한 번에 한 칸(웹 lib/sheetSnap.ts 의 '한 칸씩' 규칙은 gorhom 의 속도 판정이 대신한다 — 세게 튕기면 두 칸 갈 수 있다).
 * - 다른 높이에 걸릴 때만 가볍게 진동한다(DESIGN_PRINCIPLES "진동은 상태가 바뀔 때만").
 * - 스프링은 웹 sheetSpring, '동작 줄이기' 를 따른다.
 * 스크롤되는 내용은 SheetScrollView(안 그러면 끌기와 스크롤이 겨룬다), 아니면 SheetView 로 감싼다.
 */
export function Sheet({
  children,
  snapPoints = DEFAULT_SNAPS,
  state,
  initialState = 'normal',
  onStateChange,
  handleLabel,
  bottomInset = 0,
}: SheetProps) {
  const ref = useRef<BottomSheet>(null);
  const current = useRef<number>(ORDER.indexOf(state ?? initialState));
  const points = useMemo(() => [...snapPoints], [snapPoints]);

  useEffect(() => {
    if (!state) return;
    const i = ORDER.indexOf(state);
    if (i !== current.current) {
      current.current = i;
      ref.current?.snapToIndex(i);
    }
  }, [state]);

  const onChange = useCallback(
    (index: number) => {
      if (index < 0 || index === current.current) return;
      current.current = index;
      Haptics.selectionAsync().catch(() => undefined);
      onStateChange?.(ORDER[index]);
    },
    [onStateChange],
  );

  const step = useCallback((dir: 1 | -1) => {
    const next = Math.max(0, Math.min(ORDER.length - 1, current.current + dir));
    ref.current?.snapToIndex(next);
  }, []);

  const handle = useCallback(
    (_: BottomSheetHandleProps) => <Handle label={handleLabel} onStep={step} />,
    [handleLabel, step],
  );

  return (
    <BottomSheet
      ref={ref}
      index={current.current}
      snapPoints={points}
      enableDynamicSizing={false}
      bottomInset={bottomInset}
      animationConfigs={SHEET_ANIMATION}
      handleComponent={handle}
      backgroundStyle={background}
      style={{ boxShadow: '0px -4px 24px rgba(43, 35, 32, 0.10)', borderRadius: 24 }}
      onChange={onChange}
    >
      {children}
    </BottomSheet>
  );
}

export type ModalSheetProps = {
  children: ReactNode;
  /** 열림 — true 로 바뀌면 올라오고 false 면 내려간다. */
  open: boolean;
  /** 사용자가 바탕을 누르거나 끌어 내려 닫았을 때(부모가 open 을 false 로). */
  onClose: () => void;
  /** 정한 높이. 없으면 내용 높이에 맞춘다. */
  snapPoints?: Array<number | string>;
  /** 손잡이 읽기 라벨(예: t('common.close')). */
  handleLabel: string;
};

/**
 * 잠깐 띄우는 바닥 시트(필터·편의 · 혼잡 제보 · 지금 한산 · 설치 안내 — 웹의 바닥 시트들). 바탕이 흐려지며 나타나고,
 * 바탕을 누르거나 끌어 내리면 닫힌다. app/_layout.tsx 의 BottomSheetModalProvider 안에서만 쓸 수 있다.
 */
export function ModalSheet({ children, open, onClose, snapPoints, handleLabel }: ModalSheetProps) {
  const ref = useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (open) ref.current?.present();
    else ref.current?.dismiss();
  }, [open]);
  const backdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.35} pressBehavior="close" />
    ),
    [],
  );
  const handle = useCallback(
    (_: BottomSheetHandleProps) => <Handle label={handleLabel} onStep={(dir) => dir < 0 && onClose()} />,
    [handleLabel, onClose],
  );
  return (
    <BottomSheetModal
      ref={ref}
      snapPoints={snapPoints}
      enableDynamicSizing={!snapPoints}
      animationConfigs={SHEET_ANIMATION}
      backdropComponent={backdrop}
      handleComponent={handle}
      backgroundStyle={background}
      onDismiss={onClose}
    >
      <BottomSheetView style={{ paddingHorizontal: 16, paddingBottom: 16 + insets.bottom }}>{children}</BottomSheetView>
    </BottomSheetModal>
  );
}
