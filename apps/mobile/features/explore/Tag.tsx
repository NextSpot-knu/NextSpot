// 대안 카드의 작은 알약·칩 — 웹 page.tsx 의 인라인 span 들(border-jade/30 bg-jade/10 text-jade …)을 한 곳에 모았다.
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Text } from '~/components/ui';
import { cn } from '~/components/ui/cn';

export type TagTone = 'jade' | 'gold' | 'terracotta' | 'soft';

const BOX: Record<TagTone, string> = {
  jade: 'border-jade/30 bg-jade/10',
  gold: 'border-gold/30 bg-gold/10',
  terracotta: 'border-terracotta/30 bg-terracotta/10',
  soft: 'border-line bg-hanji-deep',
};
const TEXT: Record<TagTone, string> = {
  jade: 'text-jade',
  gold: 'text-gold-deep',
  terracotta: 'text-terracotta',
  soft: 'text-muk-soft',
};

/** size 'sm' = 근거 안의 작은 배지(10pt), 'chip' = 혜택 칩(높이 32 · 14pt). dashed = 추정·낡은 관측(실측과 한눈에 다르게). */
export function Tag({
  tone,
  size = 'sm',
  dashed = false,
  children,
  className,
}: {
  tone: TagTone;
  size?: 'sm' | 'chip';
  dashed?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const chip = size === 'chip';
  return (
    <View
      className={cn(
        'self-start border',
        chip ? 'min-h-[32px] flex-row items-center rounded-full px-[12px] py-[4px]' : 'rounded-md px-[8px] py-[2px]',
        BOX[tone],
        dashed && 'border-dashed bg-white/70',
        className,
      )}
    >
      <Text className={cn(chip ? 'text-[14px]' : 'text-[10px]', 'font-bold', TEXT[tone])}>{children}</Text>
    </View>
  );
}
