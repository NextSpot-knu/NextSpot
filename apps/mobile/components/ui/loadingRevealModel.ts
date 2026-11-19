// LoadingReveal 의 순수 값 — 웹 components/LoadingReveal.tsx 의 상수·문장 고르기.
export type LoadingRevealVariant = 'waiting' | 'course' | 'shared';

export const STEP_COUNT = 3;
export const STEP_INTERVAL_MS = 1200;

/** 비선형 진행 바 — 웹 ns-progress 28초 키프레임(4%·9%·16%·100%)을 구간 길이(ms)와 도착 너비(%)로. 100% 에 닿지 않는다. */
export const PROGRESS_SEGMENTS: { toPercent: number; durationMs: number }[] = [
  { toPercent: 46, durationMs: 1120 },
  { toPercent: 68, durationMs: 1400 },
  { toPercent: 76, durationMs: 1960 },
  { toPercent: 94, durationMs: 23_520 },
];

/** 다음 단계(마지막 문장에서 멈춘다 — 무한 순환하지 않는다). */
export function nextStep(step: number): number {
  return Math.min(step + 1, STEP_COUNT - 1);
}

/** 단계 문장의 i18n 키. 내부 검증 지역(regionName 있음)의 waiting 첫 문장만 지역 이름 문장으로. */
export function narrationKey(variant: LoadingRevealVariant, step: number, regionName?: string): string {
  if (regionName && variant === 'waiting' && step === 0) return 'region.loadingStep1';
  return `loadingReveal.${variant}.step${step + 1}`;
}
