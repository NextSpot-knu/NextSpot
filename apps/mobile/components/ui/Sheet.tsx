import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
  type BottomSheetBackdropProps,
  type BottomSheetBackgroundProps,
  type BottomSheetHandleProps,
  type ScrollEventsHandlersHookType,
  SCROLLABLE_STATUS,
  useBottomSheetInternal,
  useScrollEventsHandlersDefault,
} from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BackHandler, Platform, StyleSheet, useWindowDimensions, View, type AccessibilityActionEvent, type NativeScrollEvent } from 'react-native';
import { State } from 'react-native-gesture-handler';
import { ReduceMotion, runOnJS, scrollTo, useAnimatedReaction } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// 웹 lib/sheetSnap.ts 의 상태 이름을 그대로 쓴다(순수 모듈 — check:shared 통과).
import type { SheetState } from '@/lib/sheetSnap';
import { colors, springs } from '~/lib/theme/tokens';

export type { SheetState };
export { BottomSheetScrollView as SheetScrollView, BottomSheetView as SheetView } from '@gorhom/bottom-sheet';

type LockContext = { shouldLockInitialPosition?: boolean; initialContentOffsetY?: number };
/** 가장 높은 높이에서 이만큼(높이 사이 거리의 비율) 내려가야 '펼침 아래' 로 본다 — 스프링 출렁임은 무시. */
const BELOW_TOP_INDEX = 0.1;

/**
 * SheetScrollView 의 scrollEventsHandlersHook — 시트가 가장 높은 높이 아래로 내려가면 내용을 늘 맨 위로 되돌린다.
 * gorhom 기본(useScrollEventsHandlersDefault)은 펼침에서 스크롤해 둔 위치 그대로 잠가서, 손잡이로 끌어 내리면 낮은 높이에
 * 사진·상세의 한 조각만 보이고 머리(이름·행동 버튼)가 사라진다. 높이와 상관없이 한 판을 위쪽부터 보여 주는 시트(추천 카드)용.
 *  - 펼침 아래로 눈에 띄게(가장 높은 높이에서 다음 높이까지의 10% 넘게) 내려가는 순간 맨 위로 옮긴다(끄는 동안에도 위쪽부터
 *    이어서 드러나게). 펼침에서 위로 더 당겼다 놓을 때 스프링이 펼침 선 아래로 살짝 출렁이는 것으로는 움직이지 않는다.
 *  - 잠긴 동안의 스크롤 이벤트는 처음 위치가 아니라 0 에 잠근다.
 */
export const useSheetScrollTopLock: ScrollEventsHandlersHookType = (scrollableRef, scrollableContentOffsetY) => {
  const base = useScrollEventsHandlersDefault(scrollableRef, scrollableContentOffsetY);
  const { animatedIndex, animatedDetentsState, animatedScrollableStatus, animatedScrollableState } = useBottomSheetInternal();
  const { handleOnScroll: baseScroll, handleOnBeginDrag: baseBegin, handleOnEndDrag: baseEnd, handleOnMomentumEnd: baseMomentumEnd } = base;
  const toTop = useCallback(() => {
    'worklet';
    // @ts-expect-error gorhom 기본 훅과 같은 호출(Scrollable 의 animated ref)
    scrollTo(scrollableRef, 0, 0, false);
    scrollableContentOffsetY.value = 0;
    // gorhom 의 제스처 계산이 보는 스크롤 위치도 맞춘다.
    animatedScrollableState.set((state) => (state.contentOffsetY === 0 ? state : { ...state, contentOffsetY: 0 }));
  }, [scrollableRef, scrollableContentOffsetY, animatedScrollableState]);
  useAnimatedReaction(
    () => {
      const count = animatedDetentsState.get().detents?.length ?? 0;
      return count > 0 && animatedIndex.value < count - 1 - BELOW_TOP_INDEX;
    },
    (below, prev) => {
      if (below && prev === false) toTop();
    },
  );
  return useMemo(() => {
    const unlockInitial = (handler: ((e: NativeScrollEvent, c: never) => void) | undefined) => (e: NativeScrollEvent, c: never) => {
      'worklet';
      (c as LockContext).shouldLockInitialPosition = false;
      handler?.(e, c);
    };
    return {
      handleOnScroll: (e: NativeScrollEvent, c: never) => {
        'worklet';
        if (animatedScrollableStatus.value === SCROLLABLE_STATUS.LOCKED) {
          toTop();
          return;
        }
        baseScroll?.(e, c);
      },
      handleOnBeginDrag: (e: NativeScrollEvent, c: never) => {
        'worklet';
        baseBegin?.(e, c);
        (c as LockContext).shouldLockInitialPosition = false;
      },
      handleOnEndDrag: unlockInitial(baseEnd),
      handleOnMomentumEnd: unlockInitial(baseMomentumEnd),
    };
  }, [animatedScrollableStatus, toTop, baseScroll, baseBegin, baseEnd, baseMomentumEnd]);
};

const ORDER: readonly SheetState[] = ['minimized', 'normal', 'expanded'];
/** 손잡이 높이(pt) — 위 10 + 막대 6 + 아래 6. 내용 높이로 스냅을 정하는 쪽(추천 시트의 가장 낮은 높이)이 더한다. */
export const SHEET_HANDLE_HEIGHT = 22;

/**
 * 시트 안에서 알아야 하는 것을 밖으로 알린다.
 *  - 손잡이·내용 끌기가 진행 중인지 — 그동안 스냅 값을 바꾸면 손가락 밑에서 시트가 튄다.
 *  - 시트 컨테이너 높이(pt) — '%' 스냅이 기준으로 삼는 높이. px 스냅을 정하는 쪽이 넘지 말아야 할 선을 계산한다.
 */
function SheetWatch({ onDragging, onContainerHeight }: { onDragging: (dragging: boolean) => void; onContainerHeight?: (h: number) => void }) {
  const { animatedHandleGestureState, animatedContentGestureState, animatedLayoutState } = useBottomSheetInternal();
  useAnimatedReaction(
    () => animatedHandleGestureState.value === State.ACTIVE || animatedContentGestureState.value === State.ACTIVE,
    (active, prev) => {
      if (active !== prev) runOnJS(onDragging)(active);
    },
  );
  useAnimatedReaction(
    () => Math.round(animatedLayoutState.get().containerHeight ?? 0),
    (h, prev) => {
      if (onContainerHeight && h > 0 && h !== prev) runOnJS(onContainerHeight)(h);
    },
    [onContainerHeight],
  );
  return null;
}
const DEFAULT_SNAPS = ['18%', '45%', '88%'] as const;

const SHEET_ANIMATION = { ...springs.sheet, reduceMotion: ReduceMotion.System };

const background = {
  // 웹 bg-white/95. 안드로이드는 흐림이 없어 반투명이면 뒤 지도·목록이 비쳐 글자가 겹친다(규칙 7) — 불투명.
  backgroundColor: Platform.select({ android: colors.white, default: 'rgba(255, 255, 255, 0.95)' }),
  borderColor: colors.line,
  borderWidth: 1,
  borderRadius: 24, // 웹 rounded-3xl
};

/**
 * gorhom 의 기본 바탕은 accessible · role adjustable · 라벨 'Bottom Sheet'(영어)라 읽기 화면이 빈 판을 한 칸으로 읽는다.
 * 모양(backgroundStyle)만 그리는 읽히지 않는 판으로 바꾼다.
 */
function SheetBackground({ style, pointerEvents }: BottomSheetBackgroundProps) {
  return (
    <View
      pointerEvents={pointerEvents}
      style={style}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    />
  );
}

/**
 * gorhom 의 내용 판 기본값(accessible=true · adjustable · 'Bottom Sheet')은 자식을 한 덩어리로 합쳐 버린다(VoiceOver).
 * 끄고, 높이 조절은 손잡이(Handle) 하나가 맡는다.
 */
const CONTAINER_A11Y = { accessible: false, accessibilityRole: null, accessibilityLabel: null } as const;

/** 웹 카드 머리의 손잡이(w-16 h-1.5 bg-muk/20)를 읽기 화면에서 '조절' 할 수 있는 요소로. */
function Handle({
  label,
  value,
  onStep,
}: {
  label: string;
  /** 지금 높이를 말로(예: '펼침'). 읽기 화면이 라벨 뒤에 값으로 읽는다. */
  value?: string;
  onStep: (dir: 1 | -1) => void;
}) {
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={value ? { text: value } : undefined}
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
   * px 또는 '%' 문자열, 작은 것부터. 기본 ['18%', '45%', '88%']. 바뀌면 그 높이로 옮기되, 사용자가 끄는 중이면 손을 뗀 뒤에 바꾼다.
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
  /**
   * 높이별 읽기 값(문구 키로 — 컴포넌트는 문구를 갖지 않는다). 손잡이의 accessibilityValue 로 지금 높이를 알린다.
   * 없으면 값 없이 라벨만 읽는다.
   */
  stateLabels?: Partial<Record<SheetState, string>>;
  /** 아래 탭 막대 높이만큼 띄운다(pt). */
  bottomInset?: number;
  /** 넓은 화면(폴더블 펼침·태블릿)에서 시트 폭 상한(pt) — 넘으면 가운데에 놓는다. 없으면 화면 폭 그대로. */
  maxWidth?: number;
  /** 시트 컨테이너 높이(pt)가 정해지거나 바뀔 때('%' 스냅의 기준 — 분할 화면·회전 포함). */
  onContainerHeight?: (height: number) => void;
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
  stateLabels,
  bottomInset = 0,
  maxWidth,
  onContainerHeight,
}: SheetProps) {
  const ref = useRef<BottomSheet>(null);
  const { width: windowWidth } = useWindowDimensions();
  const sideMargin = maxWidth !== undefined && windowWidth > maxWidth ? Math.round((windowWidth - maxWidth) / 2) : 0;
  const current = useRef<number>(ORDER.indexOf(state ?? initialState));
  const [shown, setShown] = useState<number>(current.current);
  // 끄는 동안 들어온 스냅 변경은 손을 뗀 뒤에 적용한다.
  const [dragging, setDragging] = useState(false);
  const [applied, setApplied] = useState(snapPoints);
  useEffect(() => {
    if (!dragging) setApplied(snapPoints);
  }, [snapPoints, dragging]);
  const points = useMemo(() => [...applied], [applied]);

  useEffect(() => {
    if (!state) return;
    const i = ORDER.indexOf(state);
    if (i !== current.current) {
      current.current = i;
      setShown(i);
      ref.current?.snapToIndex(i);
    }
  }, [state]);

  const onChange = useCallback(
    (index: number) => {
      if (index < 0 || index === current.current) return;
      current.current = index;
      setShown(index);
      Haptics.selectionAsync().catch(() => undefined);
      onStateChange?.(ORDER[index]);
    },
    [onStateChange],
  );

  const step = useCallback((dir: 1 | -1) => {
    const next = Math.max(0, Math.min(ORDER.length - 1, current.current + dir));
    ref.current?.snapToIndex(next);
  }, []);

  const value = stateLabels?.[ORDER[shown]];
  const handle = useCallback(
    (_: BottomSheetHandleProps) => <Handle label={handleLabel} value={value} onStep={step} />,
    [handleLabel, value, step],
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
      backgroundComponent={SheetBackground}
      backgroundStyle={background}
      style={{ boxShadow: '0px -4px 24px rgba(43, 35, 32, 0.10)', borderRadius: 24, marginHorizontal: sideMargin }}
      onChange={onChange}
      {...CONTAINER_A11Y}
    >
      <SheetWatch onDragging={setDragging} onContainerHeight={onContainerHeight} />
      {children}
    </BottomSheet>
  );
}

export type ModalSheetProps = {
  children: ReactNode;
  /** 열림 — true 로 바뀌면 올라오고 false 면 내려간다. */
  open: boolean;
  /** 사용자가 바탕을 누르거나 끌어 내리거나 안드로이드 뒤로 가기로 닫았을 때(부모가 open 을 false 로). */
  onClose: () => void;
  /** 정한 높이. 없으면 내용 높이에 맞춘다. */
  snapPoints?: Array<number | string>;
  /** 손잡이 읽기 라벨(예: t('common.close')). */
  handleLabel: string;
  /** 흐린 바탕의 읽기 라벨 — 누르면 닫힌다. 웹과 같은 키 t('common.close') 를 넘긴다. */
  closeLabel: string;
};

/**
 * 잠깐 띄우는 바닥 시트(필터·편의 · 혼잡 제보 · 지금 한산 · 설치 안내 — 웹의 바닥 시트들). 바탕이 흐려지며 나타나고,
 * 바탕을 누르거나 끌어 내리거나 안드로이드 뒤로 가기로 닫힌다. app/_layout.tsx 의 BottomSheetModalProvider 안에서만 쓸 수 있다.
 * 읽기 화면: 열려 있는 동안 시트 밖(지도·탭)은 읽지 않는다(accessibilityViewIsModal). VoiceOver 의 '나가기' 제스처
 * (두 손가락 Z)와 바탕의 닫기 버튼으로 닫는다.
 */
export function ModalSheet({ children, open, onClose, snapPoints, handleLabel, closeLabel }: ModalSheetProps) {
  const ref = useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  const dismiss = useCallback(() => ref.current?.dismiss(), []);

  useEffect(() => {
    if (open) ref.current?.present();
    else ref.current?.dismiss();
  }, [open]);

  // 안드로이드 뒤로 가기 — 열려 있는 동안은 화면을 떠나지 않고 시트만 닫는다.
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      dismiss();
      return true;
    });
    return () => sub.remove();
  }, [open, dismiss]);

  // 바탕 + 시트를 함께 감싸 모달로 알린다. 컴포넌트 종류가 바뀌면 시트가 다시 붙으므로 한 번만 만든다.
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  const Container = useMemo(
    () =>
      function ModalContainer({ children: inner }: { children?: ReactNode }) {
        return (
          <View
            style={StyleSheet.absoluteFill}
            pointerEvents="box-none"
            accessibilityViewIsModal
            onAccessibilityEscape={() => dismissRef.current()}
          >
            {inner}
          </View>
        );
      },
    [],
  );

  const backdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.35}
        pressBehavior="close"
        accessible={false}
        accessibilityRole={null}
        accessibilityLabel={null}
      >
        {/* 읽기 화면용 닫기 버튼 — 손가락 탭은 그대로 바탕의 제스처가 받는다(이 View 는 터치를 잡지 않는다). */}
        <View
          style={StyleSheet.absoluteFill}
          accessible
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
          accessibilityActions={[{ name: 'activate' }]}
          onAccessibilityAction={(e: AccessibilityActionEvent) => {
            if (e.nativeEvent.actionName === 'activate') dismiss();
          }}
        />
      </BottomSheetBackdrop>
    ),
    [closeLabel, dismiss],
  );
  const handle = useCallback(
    (_: BottomSheetHandleProps) => <Handle label={handleLabel} onStep={(dir) => dir < 0 && dismiss()} />,
    [handleLabel, dismiss],
  );
  return (
    <BottomSheetModal
      ref={ref}
      snapPoints={snapPoints}
      enableDynamicSizing={!snapPoints}
      animationConfigs={SHEET_ANIMATION}
      containerComponent={Container}
      backdropComponent={backdrop}
      handleComponent={handle}
      backgroundComponent={SheetBackground}
      backgroundStyle={background}
      onDismiss={onClose}
      {...CONTAINER_A11Y}
    >
      <BottomSheetView style={{ paddingHorizontal: 16, paddingBottom: 16 + insets.bottom }}>{children}</BottomSheetView>
    </BottomSheetModal>
  );
}
