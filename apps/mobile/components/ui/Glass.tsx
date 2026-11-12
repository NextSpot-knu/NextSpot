import { BlurTargetView, BlurView } from 'expo-blur';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View, type ViewProps, type ViewStyle } from 'react-native';

import { GlassToneContext } from './glassContext';
import { GLASS_SHEEN, glassSurface } from './glassSurface';
import { Gradient } from './Gradient';

/** iOS '투명도 줄이기' 설정. 안드로이드에는 없는 설정이라 늘 false. */
export function useReduceTransparency(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let alive = true;
    AccessibilityInfo.isReduceTransparencyEnabled().then((v) => alive && setReduce(v));
    const sub = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

type BlurTargetState = { ref: RefObject<View | null>; mounted: boolean; setMounted: (v: boolean) => void };
const BlurTargetContext = createContext<BlurTargetState | null>(null);

/**
 * 안드로이드 흐림 범위(D14 ①). expo-blur 57 안드로이드는 흐릴 내용을 BlurTargetView 로 감싸야 흐린다.
 * 화면 루트에서 지도(흐릴 내용)와 유리 층(Glass)을 함께 감싼다:
 *   <GlassBlurProvider>
 *     <GlassBlurTarget style={StyleSheet.absoluteFill}>{지도}</GlassBlurTarget>
 *     {유리 층}
 *   </GlassBlurProvider>
 * 대상이 없거나 SDK 31 미만이면 유리는 흐림 없는 70% 판(D14 ③). iOS·웹 빌드는 대상 없이도 흐린다.
 */
export function GlassBlurProvider({ children }: { children: ReactNode }) {
  const ref = useRef<View | null>(null);
  const [mounted, setMounted] = useState(false);
  const value = useMemo(() => ({ ref, mounted, setMounted }), [mounted]);
  return <BlurTargetContext.Provider value={value}>{children}</BlurTargetContext.Provider>;
}

/** 유리가 흐릴 내용(지도). GlassBlurProvider 안에서, 유리 층의 형제로 둔다(유리를 이 안에 넣지 않는다). */
export function GlassBlurTarget({ children, ...rest }: ViewProps & { children?: ReactNode }) {
  const target = useContext(BlurTargetContext);
  const setMounted = target?.setMounted;
  useEffect(() => {
    if (!setMounted) return;
    setMounted(true);
    return () => setMounted(false);
  }, [setMounted]);
  return (
    <BlurTargetView ref={target?.ref} {...rest}>
      {children}
    </BlurTargetView>
  );
}

export type GlassProps = ViewProps & {
  className?: string;
  children?: ReactNode;
  /**
   * light — 지도 위 탐색 층(검색·카테고리·언어·시계)의 밝은 유리(웹 .liquid-glass). 안의 보조 글자(muk-soft·gold-deep)는
   * Text·Icon 이 glass-muk-soft·glass-gold-deep 로 바꿔 그린다.
   * rail — 매우 어두운 갈색 유리(웹 .rail-glass). 안의 먹·보조·금·금 진·선은 rail-* 로 뒤집힌다.
   */
  variant?: 'light' | 'rail';
  /** pill — 알약(rounded-full) · panel — 판(16pt 둥글기). */
  shape?: 'pill' | 'panel';
};

/**
 * 유리 판(웹 .liquid-glass — 바탕 한지 35% · 위쪽 광택 · 흰 가장자리 · 안쪽 빛선 둘 + 바깥 그림자 · 흐림 8px 채도 180%).
 * 탐색 층에만 쓰고 내용 층(추천 카드)·유리 위에는 쓰지 않는다(DESIGN_PRINCIPLES "재질"). 탭 막대에도 쓰지 않는다(R1).
 * - 웹 빌드: CSS backdrop-filter(웹과 같은 값).
 * - iOS: expo-blur 흐림 위에 35%.
 * - 안드로이드: SDK 31+ 이고 GlassBlurTarget 이 있으면 expo-blur 흐림 + 35%(D14 ①), 아니면 흐림 없는 70%(D14 ③).
 * - iOS '투명도 줄이기': 불투명한 판.
 * 크기·여백은 className 으로(예: `px-[16px] min-h-[44px] flex-row items-center`).
 * 유리 안에서 포털로 여는 내용(시트 등)은 컨텍스트를 물려받으니 유리 밖에 두거나 `<GlassToneContext.Provider value={null}>` 로 감싼다.
 */
export function Glass({ className, children, variant = 'light', shape = 'pill', style, ...rest }: GlassProps) {
  const reduceTransparency = useReduceTransparency();
  const target = useContext(BlurTargetContext);
  const surface = glassSurface(variant, {
    os: Platform.OS,
    androidApi: Platform.OS === 'android' ? Number(Platform.Version) : 0,
    reduceTransparency,
    hasBlurTarget: Boolean(target?.mounted),
  });
  const radius = shape === 'pill' ? 9999 : 16;
  const nativeBlur = surface.blur === 'native';
  // 웹 빌드의 backdrop-filter 는 RN 타입에 없다 — 웹 분기에서만 붙인다(react-native-web 0.21 이 CSS 로 넘긴다).
  const webBlur =
    surface.blur === 'css'
      ? ({ backdropFilter: surface.backdropFilter, WebkitBackdropFilter: surface.backdropFilter } as unknown as ViewStyle)
      : null;
  return (
    <View
      className={className}
      style={[
        {
          borderRadius: radius,
          borderWidth: 1,
          borderColor: surface.border,
          boxShadow: surface.boxShadow,
          // 흐림을 BlurView 로 그릴 때는 바탕을 그 위 층에 칠한다(흐림이 바탕까지 흐리지 않게).
          backgroundColor: nativeBlur ? 'transparent' : surface.tint,
        },
        webBlur,
        style,
      ]}
      {...rest}
    >
      {nativeBlur || surface.sheen ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]}>
          {nativeBlur ? (
            <>
              <BlurView
                tint={variant === 'light' ? 'light' : 'dark'}
                intensity={variant === 'light' ? 32 : 45}
                blurMethod="dimezisBlurViewSdk31Plus"
                blurTarget={target?.ref}
                style={StyleSheet.absoluteFill}
              />
              <View style={[StyleSheet.absoluteFill, { backgroundColor: surface.tint }]} />
            </>
          ) : null}
          {surface.sheen ? (
            <Gradient
              colors={GLASS_SHEEN.colors}
              locations={GLASS_SHEEN.locations}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
          ) : null}
        </View>
      ) : null}
      <GlassToneContext.Provider value={variant}>{children}</GlassToneContext.Provider>
    </View>
  );
}
