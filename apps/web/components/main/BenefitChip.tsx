'use client';

import type { ReactNode } from 'react';

// 추천 카드 얼굴의 혜택 칩(계획 B2 5번) — 관광객이 얻는 것(덜 붐빔 · 도착 시 영업 · 할인 · 대기 N분)을
// 카드에서 이름 다음으로 크게(14px · 굵게 · 32px 높이) 말한다. 예전 칩은 10px 라 값보다 점수가 먼저 읽혔다.
// 색은 혼잡 등급과 같은 체계: 혼잡 주칠 · 보통 신라금 · 여유 초록 · 한산 옥색. 야간 색은 globals.css(.benefit-relaxed).

export type BenefitTone = 'jade' | 'relaxed' | 'gold' | 'terracotta' | 'neutral';

const TONE: Record<BenefitTone, string> = {
  jade: 'border-jade/35 bg-jade/10 text-jade',
  relaxed: 'benefit-relaxed',
  gold: 'border-gold/50 bg-gold/15 text-gold-deep',
  terracotta: 'border-terracotta/35 bg-terracotta/10 text-terracotta',
  neutral: 'border-line bg-hanji-deep text-muk',
};

export function BenefitChip({
  tone = 'neutral',
  dashed = false,
  children,
  className = '',
}: {
  tone?: BenefitTone;
  /** 추정(실측 아님)은 점선 테두리 — 등급색만 보고 실측으로 읽지 않게. */
  dashed?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-3 text-[14px] font-bold leading-none xl:text-[15px] ${TONE[tone]} ${dashed ? 'border-dashed' : ''} ${className}`}
    >
      {children}
    </span>
  );
}

/** 혼잡 등급 → 칩 색. */
export function crowdTone(grade: 'busy' | 'moderate' | 'relaxed' | 'quiet'): BenefitTone {
  return ({ busy: 'terracotta', moderate: 'gold', relaxed: 'relaxed', quiet: 'jade' } as const)[grade];
}
