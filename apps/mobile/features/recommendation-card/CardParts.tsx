import type { LucideIcon } from 'lucide-react-native';
import { useEffect, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Icon, Text, cn, useReduceMotion } from '~/components/ui';

import type { ChipTone, Grade } from './cardModel';

// 웹 components/main/BenefitChip.tsx — 얼굴의 혜택 칩(14px 굵게 · 32px 높이). 색은 혼잡 등급과 같은 체계 —
// 여유 = 초록 · 한산 = 파랑(웹 globals.css .benefit-relaxed · .benefit-quiet, 지도 핀·범례와 같은 색, G3-11).
const TONE: Record<ChipTone, string> = {
  jade: 'border-jade/35 bg-jade/10',
  relaxed: 'border-benefit-relaxed/35 bg-benefit-relaxed/10',
  quiet: 'border-benefit-quiet/35 bg-benefit-quiet/10',
  gold: 'border-gold/50 bg-gold/15',
  terracotta: 'border-terracotta/35 bg-terracotta/10',
  neutral: 'border-line bg-hanji-deep',
};
const TONE_TEXT: Record<ChipTone, string> = {
  jade: 'text-jade',
  relaxed: 'text-benefit-relaxed-ink',
  quiet: 'text-benefit-quiet-ink',
  gold: 'text-gold-deep',
  terracotta: 'text-terracotta',
  neutral: 'text-muk',
};

/** 큰 글자에서 잘리지 않게 min-h(웹 h-8 = 32pt). 추정(실측 아님)은 점선 테두리. */
export function BenefitChip({
  tone = 'neutral',
  dashed = false,
  children,
}: {
  tone?: ChipTone;
  dashed?: boolean;
  children: string;
}) {
  return (
    <View className={cn('min-h-[32px] flex-row items-center rounded-full border px-[12px]', TONE[tone], dashed ? 'border-dashed' : '')}>
      <Text className={cn('text-[14px] leading-[18px]', TONE_TEXT[tone])} weight="bold" numberOfLines={1}>
        {children}
      </Text>
    </View>
  );
}

// 작은 혼잡 칩(웹 crowdChip(true) — 미리보기 칩 줄 · '추천 근거 자세히' 근거 칩): rounded-md px-2 py-0.5 11px/15 굵게, 등급색.
const SMALL_TONE: Record<Grade, { box: string; text: string }> = {
  busy: { box: 'border-terracotta/30 bg-terracotta/10', text: 'text-terracotta' },
  moderate: { box: 'border-gold/30 bg-gold/10', text: 'text-gold-deep' },
  relaxed: { box: 'border-benefit-relaxed/35 bg-benefit-relaxed/10', text: 'text-benefit-relaxed-ink' },
  quiet: { box: 'border-benefit-quiet/35 bg-benefit-quiet/10', text: 'text-benefit-quiet-ink' },
};

export function SmallCrowdChip({ grade, dashed, children }: { grade: Grade; dashed?: boolean; children: string }) {
  const tone = SMALL_TONE[grade];
  return (
    <View className={cn('self-start rounded-md border px-[8px] py-[2px]', tone.box, dashed ? 'border-dashed' : '')}>
      <Text className={cn('text-[11px] leading-[15px]', tone.text)} weight="bold">
        {children}
      </Text>
    </View>
  );
}

/**
 * 실시간 새로고침으로 바뀐 줄 반짝임(웹 .live-flash — 1.5초 ease-out, 금 26% 바탕 + 옥 60% 2px 테두리 빛이 사라진다).
 * flash 가 true 로 바뀔 때마다 한 번. '동작 줄이기'면 반짝이지 않는다.
 */
export function LiveFlash({ flash, children, style }: { flash: boolean; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const reduce = useReduceMotion();
  const p = useSharedValue(0);
  useEffect(() => {
    if (!flash || reduce) {
      p.value = 0;
      return;
    }
    p.value = 1;
    p.value = withTiming(0, { duration: 1500, easing: Easing.out(Easing.quad) });
  }, [flash, reduce, p]);
  const animated = useAnimatedStyle(() => ({
    backgroundColor: `rgba(193, 154, 62, ${0.26 * p.value})`,
    boxShadow: `0px 0px 0px 2px rgba(62, 124, 106, ${0.6 * p.value})`,
  }));
  return <Animated.View style={[{ borderRadius: 12 }, animated, style]}>{children}</Animated.View>;
}

/** 상세 정보 한 칸 — 왼쪽 아이콘 14 + 10px 이름표 + 12px 값(웹 상세 패널의 한 칸). */
export function DetailRow({
  icon,
  label,
  children,
  flash = false,
  className,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
  flash?: boolean;
  className?: string;
}) {
  return (
    <LiveFlash flash={flash}>
      <View className={cn('min-w-0 flex-row items-start gap-[8px]', className ?? '')}>
        <View className="pt-[2px]" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Icon icon={icon} size={14} color="muk-soft" />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-[10px] leading-[15px] text-muk-soft" weight="bold">{label}</Text>
          {children}
        </View>
      </View>
    </LiveFlash>
  );
}
