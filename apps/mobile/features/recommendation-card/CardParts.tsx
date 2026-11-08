import type { LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Icon, Text, cn } from '~/components/ui';

import type { ChipTone } from './cardModel';

// 웹 components/main/BenefitChip.tsx — 얼굴의 혜택 칩(14px 굵게 · 32px 높이). 색은 혼잡 등급과 같은 체계.
const TONE: Record<ChipTone, string> = {
  jade: 'border-jade/35 bg-jade/10',
  relaxed: 'border-line bg-hanji-deep',
  quiet: 'border-line bg-hanji-deep',
  gold: 'border-gold/50 bg-gold/15',
  terracotta: 'border-terracotta/35 bg-terracotta/10',
  neutral: 'border-line bg-hanji-deep',
};
const TONE_TEXT: Record<ChipTone, string> = {
  jade: 'text-jade',
  relaxed: 'text-jade',
  quiet: 'text-gold-deep',
  gold: 'text-gold-deep',
  terracotta: 'text-terracotta',
  neutral: 'text-muk',
};

/**
 * 큰 글자에서 잘리지 않게 min-h(웹 h-8 = 32pt). 추정(실측 아님)은 점선 테두리.
 * small — 추천 시트 머리(가장 낮은 높이 안)의 경고 칩: 12px 한 줄, 글자 확대 상한 maxFontScale.
 */
export function BenefitChip({
  tone = 'neutral',
  dashed = false,
  small = false,
  maxFontScale,
  children,
}: {
  tone?: ChipTone;
  dashed?: boolean;
  small?: boolean;
  maxFontScale?: number;
  children: string;
}) {
  return (
    <View
      className={cn(
        small ? 'flex-row items-center rounded-full border px-[8px] py-[1px]' : 'min-h-[32px] flex-row items-center rounded-full border px-[12px] py-[4px]',
        TONE[tone],
        dashed ? 'border-dashed' : '',
      )}
    >
      <Text className={cn(small ? 'text-[12px] leading-[16px]' : 'text-[14px] leading-[18px]', TONE_TEXT[tone])} weight="bold" {...(maxFontScale ? { maxFontSizeMultiplier: maxFontScale } : null)}>
        {children}
      </Text>
    </View>
  );
}

/** 상세 정보 한 줄 — 왼쪽 아이콘 + 작은 이름표 + 값. */
export function DetailRow({ icon, label, children, flash }: { icon: LucideIcon; label: string; children: ReactNode; flash?: boolean }) {
  return (
    <View className={cn('flex-row items-start gap-[8px] rounded-lg', flash ? 'bg-gold/15' : '')}>
      <View className="pt-[2px]" accessibilityElementsHidden importantForAccessibility="no">
        <Icon icon={icon} size="sm" color="muk-soft" />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-[11px] leading-[14px] text-muk-soft" weight="bold">{label}</Text>
        {children}
      </View>
    </View>
  );
}
