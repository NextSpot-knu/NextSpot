// 대안 카드의 작은 알약·칩 — 웹 page.tsx 의 인라인 span 들(border-jade/30 bg-jade/10 text-jade …)을 한 곳에 모았다.
// 클래스는 덧붙이지 않고 종류마다 하나만 고른다(NativeWind 는 같은 속성 클래스가 둘이면 CSS 순서로 이긴다 — 점선 칩의 바탕이 겹치던 문제, G4a-20·R03).
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '~/components/ui';
import { cn } from '~/components/ui/cn';

export type TagTone = 'jade' | 'gold' | 'terracotta' | 'soft';
/** 바탕: tone = 색마다 정한 옅은 바탕(soft 는 한지 진), none = 바탕 없음, muk5 = 먹 5%, hanjiDeep = 한지 진, white70 = 흰 70%. */
export type TagSurface = 'tone' | 'none' | 'muk5' | 'hanjiDeep' | 'white70';

// 실선 테두리(30%) · 점선 테두리(60%). soft 는 두 경우 모두 선 색.
const BORDER: Record<TagTone, string> = {
  jade: 'border-jade/30',
  gold: 'border-gold/30',
  terracotta: 'border-terracotta/30',
  soft: 'border-line',
};
const BORDER_DASHED: Record<TagTone, string> = {
  jade: 'border-dashed border-jade/60',
  gold: 'border-dashed border-gold/60',
  terracotta: 'border-dashed border-terracotta/60',
  soft: 'border-dashed border-line',
};
const SURFACE_TONE: Record<TagTone, string> = {
  jade: 'bg-jade/10',
  gold: 'bg-gold/10',
  terracotta: 'bg-terracotta/10',
  soft: 'bg-hanji-deep',
};
const SURFACE: Record<Exclude<TagSurface, 'tone'>, string> = {
  none: '',
  muk5: 'bg-muk/5',
  hanjiDeep: 'bg-hanji-deep',
  white70: 'bg-white/70',
};
const TEXT: Record<TagTone, string> = {
  jade: 'text-jade',
  gold: 'text-gold-deep',
  terracotta: 'text-terracotta',
  soft: 'text-muk-soft',
};

/**
 * size 'sm' = 근거 안의 작은 배지(10pt), 'chip' = 혜택 칩(높이 32 · 14pt).
 * dashed = 추정·낡은 관측(실측과 한눈에 다르게) — 테두리만 점선 60%. 바탕은 surface 로 따로 고른다(웹 칩마다 다르다).
 * weight 기본 bold, faint = 글자 70%(오래된 관측 칩).
 */
export function Tag({
  tone,
  size = 'sm',
  dashed = false,
  surface = 'tone',
  weight = 'bold',
  faint = false,
  children,
  className,
}: {
  tone: TagTone;
  size?: 'sm' | 'chip';
  dashed?: boolean;
  surface?: TagSurface;
  weight?: 'medium' | 'bold';
  faint?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const chip = size === 'chip';
  return (
    <View
      className={cn(
        'self-start border',
        chip ? 'min-h-[32px] flex-row items-center rounded-full px-[12px] py-[4px]' : 'rounded-md px-[8px] py-[2px]',
        dashed ? BORDER_DASHED[tone] : BORDER[tone],
        surface === 'tone' ? SURFACE_TONE[tone] : SURFACE[surface],
        className,
      )}
    >
      <Text
        className={cn(chip ? 'text-[14px]' : 'text-[10px]', TEXT[tone])}
        weight={weight}
        style={faint ? { opacity: 0.7 } : undefined}
      >
        {children}
      </Text>
    </View>
  );
}
