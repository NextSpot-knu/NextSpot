import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetModalProvider,
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
import { X } from 'lucide-react-native';
import { GestureHandlerRootView, State } from 'react-native-gesture-handler';
import { ReduceMotion, runOnJS, scrollTo, useAnimatedReaction } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// 웹 lib/sheetSnap.ts 의 상태 이름을 그대로 쓴다(순수 모듈 — check:shared 통과).
import type { SheetState } from '@/lib/sheetSnap';
import { MIN_TAP, colors, springs } from '~/lib/theme/tokens';

import { Icon } from './Icon';
import { MODAL_SHEET_INITIAL, modalSheetReduce, type ModalSheetEvent, type ModalSheetState } from './modalSheetState';
import {
  MODAL_SHEET_CLOSE_BOX,
  MODAL_SHEET_CLOSE_ICON,
  closeHitSlop,
  resolveBackdrop,
  resolveContentPadding,
  sheetSideMargin,
  sheetSurface,
  type ModalSheetBackdrop,
  type ModalSheetBackground,
  type ModalSheetCloseVariant,
  type ModalSheetPadding,
} from './modalSheetSpec';
import { Pressable } from './Pressable';

export type { SheetState };
export { MODAL_SHEET_CLOSE_BOX, type ModalSheetBackdrop, type ModalSheetBackground, type ModalSheetCloseVariant, type ModalSheetPadding };
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

// 웹 bg-white/95 + border-line + rounded-3xl. 안드로이드는 불투명 흰(modalSheetSpec.sheetSurface 주석).
const background = sheetSurface('default', true, Platform.OS);

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
  /** 사용자가 바탕을 누르거나 끌어 내리거나 안드로이드 뒤로 가기·머리 X 로 닫았을 때(부모가 open 을 false 로). */
  onClose: () => void;
  /** 정한 높이. 없으면 내용 높이에 맞춘다. */
  snapPoints?: Array<number | string>;
  /** 손잡이 읽기 라벨(예: t('common.close')). */
  handleLabel: string;
  /** 흐린 바탕(과 머리 X)의 읽기 라벨 — 누르면 닫힌다. 웹과 같은 키 t('common.close') 를 넘긴다. */
  closeLabel: string;

  // ── 선택 모양(docs/MOBILE_WEB_PARITY.md §4.2 F8) — 주지 않으면 B3 전 모양 그대로. 웹 값은 modalSheetSpec.ts 머리 주석. ──
  /** 판 바탕. 기본 'default'(흰 95% · 안드로이드 불투명 흰). 웹 바닥 시트는 모두 'hanji'. */
  background?: ModalSheetBackground;
  /** 1px border-line 테두리. 기본 true. 웹 대화 시트(혼잡 제보 · 지금 한산)는 true, 판 시트(필터 · 축제 · 화장실)는 false. */
  bordered?: boolean;
  /** 판 그림자(boxShadow 문자열). 기본 없음. 웹 대화 시트 '0px -8px 40px rgba(43, 35, 32, 0.2)'. */
  shadow?: string;
  /** 손잡이(끌기 막대)를 그린다. 기본 true. 웹 바닥 시트는 손잡이가 없다 — 끄면 closeButton 을 함께 준다. */
  showHandle?: boolean;
  /**
   * 머리 오른쪽 X(웹 lucide X 18, 라벨은 closeLabel). 기본 없음. 내용 여백 안 오른쪽 위에 겹쳐 그리므로 머리 줄은 오른쪽을
   * MODAL_SHEET_CLOSE_BOX[변형] + 간격(웹 gap-3 = 12)만큼 비워 둔다. 변형은 modalSheetSpec.ModalSheetCloseVariant.
   */
  closeButton?: ModalSheetCloseVariant;
  /** 막 색·투명도. 기본 { color: 검정, opacity: 0.35 }. 웹: 제보 muk 0.4 · 필터 muk 0.35 · 축제·화장실 검정 0.3. */
  backdrop?: ModalSheetBackdrop;
  /** 판 폭 상한(pt) — 화면이 더 넓으면 가운데. 기본 없음(화면 폭). 웹 max-w-sm 384 · max-w-lg 512. */
  maxWidth?: number;
  /** 내용 높이에 맞출 때(snapPoints 없음) 판 높이 상한(pt). 기본은 gorhom 값. 웹 max-h-[78vh] 같은 값은 창 높이 × 비율로 넘긴다. */
  maxHeight?: number;
  /** 내용 여백. 기본 { x: 16, top: 0, bottom: 16 }. 아래에는 늘 아래 안전 영역을 더한다. 웹: 제보 24·24·24, 필터 16·12·20, 축제·화장실 20·20·20. */
  contentPadding?: ModalSheetPadding;
  /**
   * 다른 ModalSheet 가 열려 있을 때 이 시트를 여는 방식(gorhom). 기본 'switch'(앞 시트를 접고 연다).
   * 'push' = 앞 시트 위에 쌓기(필터·편의 안에서 연 축제·화장실 — G2-13), 'replace' = 앞 시트를 닫고 연다.
   */
  stackBehavior?: 'push' | 'switch' | 'replace';
  /**
   * 사용자가 닫을 수 있는가. 기본 true. false 면 바탕 누르기 · 끌어 내리기 · 뒤로 키 · 머리 X · 손잡이 · 읽기 화면 닫기를 받지
   * 않는다(웹 `!submitting && close` — 제보를 보내는 동안). 부모의 onClose 에서 닫기를 거절하지 말고 이것을 쓴다: onClose 를
   * 무시하면 시트는 이미 내려갔는데 부모의 open 이 true 로 남아 다시 열 수 없다.
   */
  dismissible?: boolean;
};

/**
 * 잠깐 띄우는 바닥 시트(필터·편의 · 혼잡 제보 · 지금 한산 · 설치 안내 — 웹의 바닥 시트들). 바탕이 흐려지며 나타나고,
 * 바탕을 누르거나 끌어 내리거나 안드로이드 뒤로 가기로 닫힌다. app/_layout.tsx 의 BottomSheetModalProvider 안에서만 쓸 수 있다
 * — RN Modal 안에서 열 때는 Modal 내용 루트를 ModalSheetHost 로 감싼다(아니면 시트가 Modal 창 뒤에 그려진다).
 * 읽기 화면: 열려 있는 동안 시트 밖(지도·탭)은 읽지 않는다(accessibilityViewIsModal). VoiceOver 의 '나가기' 제스처
 * (두 손가락 Z)와 바탕의 닫기 버튼으로 닫는다.
 */
export function ModalSheet({
  children,
  open,
  onClose,
  snapPoints,
  handleLabel,
  closeLabel,
  background: surface = 'default',
  bordered = true,
  shadow,
  showHandle = true,
  closeButton,
  backdrop: backdropOption,
  maxWidth,
  maxHeight,
  contentPadding,
  stackBehavior,
  dismissible = true,
}: ModalSheetProps) {
  const ref = useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  // 열림·닫힘 판단은 modalSheetState(순수 상태 기계)가 한다. dismiss() 는 시트가 보이기 시작했다고 알린 뒤에만 부른다 —
  // @gorhom/bottom-sheet 5.2.14 는 그 전에 dismiss() 를 받으면 DISMISSING 에 갇혀 다시 열리지 않는다(G2-G07: 닫힌 채
  // 처음 마운트 · 칩 두 번 누르기 · 열리자마자 뒤로 키). 자세한 까닭은 modalSheetState.ts 머리 주석.
  // 머리 X 를 포함한 모든 열기·닫기는 send() 로만 간다 — present()/dismiss() 를 직접 부르지 않는다.
  const stateRef = useRef<ModalSheetState>(MODAL_SHEET_INITIAL);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const send = useCallback((event: ModalSheetEvent) => {
    const { state, actions } = modalSheetReduce(stateRef.current, event);
    stateRef.current = state;
    for (const action of actions) {
      if (action === 'present') ref.current?.present();
      else if (action === 'dismiss') ref.current?.dismiss();
      else onCloseRef.current();
    }
  }, []);
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;
  /** 사용자 닫기(뒤로 키 · 손잡이 · 머리 X · 읽기 화면 닫기) — 아직 보이기 전이면 보이자마자 닫는다. 닫을 수 없는 동안은 무시. */
  const dismiss = useCallback(() => {
    if (dismissibleRef.current) send({ type: 'userClose' });
  }, [send]);
  const handleAnimate = useCallback((_from: number, to: number) => {
    if (to >= 0) send({ type: 'shown' });
  }, [send]);
  const handleChange = useCallback((index: number) => {
    if (index >= 0) send({ type: 'shown' });
  }, [send]);
  const handleDismissed = useCallback(() => send({ type: 'dismissed' }), [send]);

  useEffect(() => {
    send({ type: 'open', value: open });
  }, [open, send]);

  // 안드로이드 뒤로 가기 — 열려 있는 동안은 화면을 떠나지 않고 시트만 닫는다(닫을 수 없는 동안은 아무것도 하지 않는다).
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

  const scrim = resolveBackdrop(backdropOption);
  const backdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        style={[props.style, { backgroundColor: scrim.color }]}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={scrim.opacity}
        pressBehavior={dismissible ? 'close' : 'none'}
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
          accessibilityState={{ disabled: !dismissible }}
          accessibilityActions={[{ name: 'activate' }]}
          onAccessibilityAction={(e: AccessibilityActionEvent) => {
            if (e.nativeEvent.actionName === 'activate') dismiss();
          }}
        />
      </BottomSheetBackdrop>
    ),
    [closeLabel, dismiss, dismissible, scrim.color, scrim.opacity],
  );
  const handle = useCallback(
    (_: BottomSheetHandleProps) => <Handle label={handleLabel} onStep={(dir) => dir < 0 && dismiss()} />,
    [handleLabel, dismiss],
  );
  const backgroundStyle = useMemo(() => sheetSurface(surface, bordered, Platform.OS), [surface, bordered]);
  const sideMargin = sheetSideMargin(windowWidth, maxWidth);
  // 그림자·폭 상한이 없으면 style 을 주지 않는다(B3 전과 같은 그리기).
  const sheetStyle = useMemo(
    () => (shadow || sideMargin ? { boxShadow: shadow, borderRadius: 24, marginHorizontal: sideMargin } : undefined),
    [shadow, sideMargin],
  );
  const padding = resolveContentPadding(contentPadding, insets.bottom);
  return (
    <BottomSheetModal
      ref={ref}
      snapPoints={snapPoints}
      enableDynamicSizing={!snapPoints}
      maxDynamicContentSize={maxHeight}
      stackBehavior={stackBehavior}
      enablePanDownToClose={dismissible}
      animationConfigs={SHEET_ANIMATION}
      containerComponent={Container}
      backdropComponent={backdrop}
      handleComponent={showHandle ? handle : null}
      backgroundComponent={SheetBackground}
      backgroundStyle={backgroundStyle}
      style={sheetStyle}
      onAnimate={handleAnimate}
      onChange={handleChange}
      onDismiss={handleDismissed}
      {...CONTAINER_A11Y}
    >
      <BottomSheetView style={padding}>
        {/* 머리 X 는 트리 맨 앞 — 읽기 화면이 시트에 들어오자마자 닫기를 만난다(맨 뒤면 옵션을 다 지나야 닿는다).
            그림·터치 순서는 zIndex 로 내용 위에 둔다. */}
        {closeButton ? (
          <SheetCloseButton
            variant={closeButton}
            label={closeLabel}
            disabled={!dismissible}
            onPress={dismiss}
            top={padding.paddingTop}
            right={padding.paddingHorizontal}
          />
        ) : null}
        {children}
      </BottomSheetView>
    </BottomSheetModal>
  );
}

/**
 * 머리 X — 내용 여백 안 오른쪽 위에 겹친다. 보이는 상자는 웹 값(MODAL_SHEET_CLOSE_BOX), 탭 영역은 hitSlop 으로 44pt 까지 —
 * 단 내용 판 밖으로는 넘기지 않는다(closeHitSlop: 안드로이드는 부모 밖 hitSlop 을 받지 않는다).
 */
function SheetCloseButton({
  variant,
  label,
  disabled,
  onPress,
  top,
  right,
}: {
  variant: ModalSheetCloseVariant;
  label: string;
  disabled: boolean;
  onPress: () => void;
  top: number;
  right: number;
}) {
  const box = MODAL_SHEET_CLOSE_BOX[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={closeHitSlop(variant, top, right, MIN_TAP)}
      style={[
        {
          position: 'absolute',
          zIndex: 1,
          top,
          right,
          width: box,
          height: box,
          borderRadius: box / 2,
          alignItems: 'center',
          justifyContent: 'center',
        },
        variant === 'bordered' ? { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line } : null,
      ]}
    >
      <Icon icon={X} size={MODAL_SHEET_CLOSE_ICON} color={variant === 'muted' ? 'muk-soft' : 'muk'} />
    </Pressable>
  );
}

/**
 * RN `Modal` 안에서 ModalSheet 를 열 때 Modal 내용 루트를 이것으로 감싼다(서비스 소개 모달 G1-04·G1-08 등 — §4.2 F8).
 * RN Modal 은 따로 그려지는 창이라 루트 BottomSheetModalProvider 의 포털은 Modal **뒤**에 깔리고, 안드로이드는 Modal 안
 * 제스처에 GestureHandlerRootView 가 따로 필요하다. I18n·테마 같은 React 컨텍스트는 트리를 따라 그대로 물려받는다.
 */
export function ModalSheetHost({ children }: { children: ReactNode }) {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <BottomSheetModalProvider>{children}</BottomSheetModalProvider>
    </GestureHandlerRootView>
  );
}
