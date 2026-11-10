// 프리미엄 로딩 연출(웹 components/LoadingReveal.tsx) — 대기·코스·공유 코스가 응답을 기다리는 동안 '일부러 준비 중'으로 읽히게 한다.
//   1) 내레이션 머리: 맥동 핀 + NextSpot + 제목 + 1.2초마다 넘어가 마지막에서 멈추는 문장 + 28초 비선형 진행 바
//   2) 스켈레톤: 실제 결과 레이아웃을 닮은 자리표시(글자 없음 — 가짜 정보 0)
// 로딩 전용이다: 가짜 결과·가짜 혼잡 수치를 만들지 않는다.
//
// 앱과 다른 곳(계획 R3 G5a-09): 고스트의 블러는 안드로이드에서 못 쓰므로(저장소 규칙 7) opacity .75 만 — 웹 빌드는 blur(8px) 도 건다.
// 시머 쓸기 대신 판이 숨 쉰다(Skeleton 과 같은 0.55↔1, 900ms). 문장 페이드는 entering 대신 shared value(웹 빌드에서 entering 이 실패한다).
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { MapPin } from 'lucide-react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { useT } from '~/lib/i18n/I18nProvider';

import { Icon } from './Icon';
import { Text } from './Text';
import { useReduceMotion } from './useReduceMotion';
import {
  PROGRESS_SEGMENTS,
  STEP_INTERVAL_MS,
  narrationKey,
  nextStep,
  type LoadingRevealVariant,
} from './loadingRevealModel';

export type { LoadingRevealVariant } from './loadingRevealModel';

// ── 시머(판 숨쉬기) — 한 값을 모든 판이 나눠 쓴다 ─────────────────────────────────────────────────────────
const BreathContext = createContext<SharedValue<number> | null>(null);

function BreathProvider({ children }: { children: ReactNode }) {
  const reduceMotion = useReduceMotion();
  const v = useSharedValue(1);
  useEffect(() => {
    if (reduceMotion) {
      v.value = 1;
      return;
    }
    v.value = withRepeat(withTiming(0.55, { duration: 900 }), -1, true);
    return () => cancelAnimation(v);
  }, [reduceMotion, v]);
  return <BreathContext.Provider value={v}>{children}</BreathContext.Provider>;
}

/** 웹 .ns-skel 한 판 — className 으로 크기·색·모서리. 숨쉬는 판. */
function Skel({ className, style }: { className: string; style?: ViewStyle }) {
  const v = useContext(BreathContext);
  const animated = useAnimatedStyle(() => ({ opacity: v ? v.value : 1 }));
  return <Animated.View className={className} style={[style, animated]} />;
}

/** 웹 .ns-ghost — 실제 카드의 색·구조 실루엣. */
function ghostStyle(): ViewStyle {
  return Platform.OS === 'web' ? ({ opacity: 0.75, filter: 'blur(8px)' } as ViewStyle) : { opacity: 0.75 };
}

const CARD_SHADOW = '0px 2px 14px rgba(43, 35, 32, 0.06)';

// ── 머리 ────────────────────────────────────────────────────────────────────────────────────────────────
function useNarrationStep() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (step >= 2) return; // 마지막 문장에서 정지
    const timer = setTimeout(() => setStep(nextStep), STEP_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [step]);
  return step;
}

/** 핀 뒤로 번지는 맥동 링 — 2100ms 중 0~70%(1470ms)만 움직이고 나머지 630ms 는 멈춘다(웹 ns-pin-pulse). */
function PinRing() {
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withRepeat(
      withSequence(
        withTiming(0, { duration: 0 }),
        withTiming(1, { duration: 1470, easing: Easing.bezier(0.2, 0, 0, 1) }),
        withTiming(1, { duration: 630 }),
      ),
      -1,
    );
    return () => cancelAnimation(p);
  }, [p]);
  const style = useAnimatedStyle(() => ({ opacity: 0.6 * (1 - p.value), transform: [{ scale: 0.9 + 1.1 * p.value }] }));
  return <Animated.View className="absolute inset-0 rounded-full border-2 border-gold/45" style={style} />;
}

/** 28초 비선형 진행 바 — 초반 급가속 후 94% 까지 천천히. 동작 줄이기에서는 94% 로 고정. */
function ProgressBar() {
  const reduceMotion = useReduceMotion();
  const w = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) {
      w.value = 94;
      return;
    }
    w.value = 0;
    w.value = withSequence(
      ...PROGRESS_SEGMENTS.map((s) =>
        withTiming(s.toPercent, { duration: s.durationMs, easing: Easing.bezier(0.25, 0.6, 0.35, 1) }),
      ),
    );
    return () => cancelAnimation(w);
  }, [reduceMotion, w]);
  const style = useAnimatedStyle(() => ({ width: `${w.value}%` }));
  return (
    <View className="mt-[16px] h-[6px] w-full overflow-hidden rounded-full bg-line" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View className="h-full rounded-full bg-gold" style={style} />
    </View>
  );
}

function NarrationLine({ step, text }: { step: number; text: string }) {
  const reduceMotion = useReduceMotion();
  const p = useSharedValue(reduceMotion ? 1 : 0);
  useEffect(() => {
    if (reduceMotion) {
      p.value = 1;
      return;
    }
    p.value = 0;
    p.value = withTiming(1, { duration: 400, easing: Easing.out(Easing.ease) });
  }, [step, reduceMotion, p]);
  const style = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ translateY: 4 * (1 - p.value) }] }));
  return (
    <Animated.View className="mt-[2px]" style={style}>
      <Text className="text-xs leading-[16.5px] text-muk-soft">{text}</Text>
    </Animated.View>
  );
}

function NarrationHeader({ variant, regionName }: { variant: LoadingRevealVariant; regionName?: string }) {
  const t = useT();
  const reduceMotion = useReduceMotion();
  const step = useNarrationStep();
  const key = narrationKey(variant, step, regionName);
  const line = key === 'region.loadingStep1' ? t(key, { region: regionName ?? '' }) : t(key);
  const title = t(`loadingReveal.${variant}.title`);
  return (
    <View
      role="status"
      aria-live="polite"
      accessibilityLiveRegion="polite"
      accessible
      accessibilityLabel={`${title}. ${line}`}
      className="overflow-hidden rounded-2xl border border-gold/25 bg-white/90 px-[20px] py-[20px]"
      style={{ boxShadow: '0px 8px 30px rgba(43, 35, 32, 0.08)' }}
    >
      {/* 오른쪽 위 금빛 번짐 — 웹 128px bg-gold/15 blur-2xl 을 방사 그라데이션으로(안드로이드는 흐림이 없다) */}
      <View pointerEvents="none" style={{ position: 'absolute', right: -40, top: -48, width: 128, height: 128 }}>
        <Svg width={128} height={128}>
          <Defs>
            <RadialGradient id="gold-glow" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor="#c19a3e" stopOpacity={0.15} />
              <Stop offset="1" stopColor="#c19a3e" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect x={0} y={0} width={128} height={128} fill="url(#gold-glow)" />
        </Svg>
      </View>
      <View className="flex-row items-center gap-[14px]">
        <View className="h-[48px] w-[48px] items-center justify-center" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {reduceMotion ? null : <PinRing />}
          <View
            className="h-[44px] w-[44px] items-center justify-center rounded-full bg-gold/10"
            style={{ boxShadow: '0px 2px 10px rgba(193, 154, 62, 0.25)' }}
          >
            <Icon icon={MapPin} size={22} strokeWidth={2.3} color="gold-deep" />
          </View>
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-[11px] uppercase leading-[16.5px] text-gold-deep" weight="bold" style={{ letterSpacing: 0.275 }}>
            NextSpot
          </Text>
          <Text className="text-sm leading-[19.25px] text-muk" weight="bold">
            {title}
          </Text>
          <NarrationLine step={step} text={line} />
        </View>
      </View>
      <ProgressBar />
    </View>
  );
}

// ── 스켈레톤 ─────────────────────────────────────────────────────────────────────────────────────────────
const PHOTO_GRADIENT = ['#f1e7d3', 'rgba(193, 154, 62, 0.25)', 'rgba(62, 124, 106, 0.2)'] as const;

function GhostCard() {
  return (
    <View
      className="h-[288px] flex-1 overflow-hidden rounded-2xl border border-line bg-white/80"
      style={{ boxShadow: CARD_SHADOW }}
    >
      <View className="flex-1" style={ghostStyle()}>
        <View className="absolute left-[6px] top-[6px] z-10 h-[28px] w-[28px] rounded-full border-2 border-white bg-gold/70" />
        <Skel className="h-[112px] w-full overflow-hidden" />
        <LinearGradient colors={PHOTO_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 112 }} />
        <View className="flex-1 gap-[6px] p-[8px]">
          <View className="h-[12px] w-[91.6%] rounded bg-muk/45" />
          <View className="h-[10px] w-[60%] rounded bg-muk/25" />
          <View className="flex-row gap-[4px]">
            <View className="h-[14px] w-[40px] rounded-md bg-jade/35" />
            <View className="h-[14px] w-[48px] rounded-md bg-gold/40" />
          </View>
          <View className="mt-auto gap-[6px]">
            <View className="h-[14px] w-3/4 rounded bg-muk/30" />
            <View className="h-[24px] w-full rounded-lg border border-gold/40 bg-gold/25" />
          </View>
        </View>
      </View>
    </View>
  );
}

function GhostRow() {
  return (
    <View
      className="rounded-2xl border border-line bg-white/80 px-[14px] py-[12px]"
      style={{ boxShadow: CARD_SHADOW }}
    >
      <View className="flex-row items-center gap-[12px]" style={ghostStyle()}>
        <View className="h-[36px] w-[36px] rounded-full bg-gold/30" />
        <View className="flex-1 gap-[8px]">
          <View className="h-[14px] w-1/2 rounded bg-muk/40" />
          <View className="flex-row gap-[6px]">
            <View className="h-[14px] w-[64px] rounded-md bg-gold/35" />
            <View className="h-[14px] w-[48px] rounded-md bg-jade/30" />
          </View>
        </View>
        <View className="h-[16px] w-[8px] rounded bg-muk/20" />
      </View>
    </View>
  );
}

/** 섹터 패널 한 판의 미러 — 헤더 칩 + 포트레이트 카드 3장 + 컴팩트 행 2개. */
function SectorPanelSkeleton() {
  return (
    <View
      className="gap-[10px] rounded-3xl border border-line/70 bg-white/55 p-[12px]"
      style={{ boxShadow: CARD_SHADOW }}
    >
      <View className="flex-row items-center gap-[8px]">
        <Skel className="h-[32px] w-[32px] rounded-xl bg-gold/20" />
        <Skel className="h-[16px] w-[96px] rounded bg-hanji-deep" />
        <Skel className="ml-auto h-[20px] w-[44px] rounded-full bg-hanji-deep" />
      </View>
      <View className="flex-row gap-[8px]">
        {[0, 1, 2].map((card) => (
          <GhostCard key={card} />
        ))}
      </View>
      <View className="gap-[8px]">
        {[0, 1].map((row) => (
          <GhostRow key={row} />
        ))}
      </View>
    </View>
  );
}

/**
 * 대기 보드에서 먼저 도착한 섹션 아래, 아직 오는 섹션 자리 한 판(진행 바·내레이션 없이 패널만).
 * 글자 없음 — 읽기 화면에는 보드의 busy 상태가 말한다.
 */
export function WaitingSectorSkeleton() {
  return (
    <BreathProvider>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <SectorPanelSkeleton />
      </View>
    </BreathProvider>
  );
}

function WaitingSkeleton() {
  return (
    <View className="gap-[24px]" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {[0, 1].map((sector) => (
        <SectorPanelSkeleton key={sector} />
      ))}
    </View>
  );
}

/** 코스 결과 미러 — 가로 스텝퍼 + 정류지 행. 행은 화면 가로 여백(16)을 뚫고 가장자리까지(웹 -mx-4) 간다. */
function CourseBodySkeleton() {
  return (
    <View className="gap-[24px]" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View className="flex-row items-start gap-[12px]" style={ghostStyle()}>
        {[0, 1, 2].map((step) => (
          <View key={step} className="flex-1 items-center gap-[6px]">
            <View className="h-[32px] w-[32px] rounded-full border-2 border-gold/50 bg-gold/25" />
            <View className="h-[8px] w-[40px] rounded bg-muk/30" />
          </View>
        ))}
      </View>
      <View className="-mx-[16px]">
        {[0, 1, 2].map((row) => (
          <View key={row} className={row === 0 ? 'px-[16px] py-[16px]' : 'border-t border-line px-[16px] py-[16px]'}>
            <View className="flex-row items-start gap-[12px]" style={ghostStyle()}>
              <View className="h-[36px] w-[36px] rounded-full bg-gold/30" />
              <View className="min-w-0 flex-1 gap-[8px]">
                <View className="flex-row items-center justify-between gap-[8px]">
                  <View className="h-[16px] w-1/2 rounded bg-muk/40" />
                  <View className="h-[16px] w-[56px] rounded-lg border border-gold/40 bg-gold/20" />
                </View>
                <View className="flex-row gap-[6px]">
                  <View className="h-[12px] w-[80px] rounded bg-muk/25" />
                  <View className="h-[12px] w-[56px] rounded-md bg-jade/30" />
                </View>
              </View>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

export type LoadingRevealProps = {
  variant: LoadingRevealVariant;
  /** 내부 검증 지역(서울)에서만 — waiting 첫 문장이 'region.loadingStep1'(지역 이름 문장)이 된다. 경주는 비운다. */
  regionName?: string;
};

export function LoadingReveal({ variant, regionName }: LoadingRevealProps) {
  return (
    <BreathProvider>
      <View className="gap-[24px]">
        <NarrationHeader variant={variant} regionName={regionName} />
        {variant === 'waiting' ? <WaitingSkeleton /> : <CourseBodySkeleton />}
      </View>
    </BreathProvider>
  );
}
