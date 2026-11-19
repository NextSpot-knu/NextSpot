// 광원 환산 — 웹 CSS `원(w) + blur(σ)` 를 react-native-svg RadialGradient 로 옮기는 식(검토 R1 '광원 규칙').
// RN 에는 CSS blur 가 없어 가우시안 번짐을 3-스톱 반경 그라데이션으로 근사한다.
//   캔버스 = (size + 4σ) 정사각, 중심은 CSS 원의 중심과 같다.
//   stop 0 = α(1 − e^(−r²/2σ²)), stop r/(r+2σ) = 그 값의 절반, stop 1 = 0.   (r = size / 2)

export interface GlowStop {
  offset: number;
  opacity: number;
}

export function glowCanvas(size: number, blur: number): number {
  return size + 4 * blur;
}

export function glowStops(opacity: number, size: number, blur: number): GlowStop[] {
  const r = size / 2;
  const center = opacity * (1 - Math.exp(-(r * r) / (2 * blur * blur)));
  return [
    { offset: 0, opacity: center },
    { offset: r / (r + 2 * blur), opacity: center / 2 },
    { offset: 1, opacity: 0 },
  ];
}

/** 저장·대안·대기 화면 프리셋(R2) — 웹 페이지 틀의 광원 두 개. 위치는 CSS 원 상자 기준. */
export const GLOW_PRESETS = {
  /** 저장 `saved/page.tsx:541-542` — 300 · blur 100. */
  saved: [
    { color: 'sunset-1', opacity: 0.1, size: 300, blur: 100, position: { top: '25%', left: '25%' } },
    { color: 'gold', opacity: 0.1, size: 300, blur: 100, position: { bottom: '-10%', right: '-10%' } },
  ],
  /** 대안 `explore/recommend/page.tsx:1494-1495` — 600 · blur 120. */
  alternative: [
    { color: 'sunset-1', opacity: 0.1, size: 600, blur: 120, position: { top: '-20%', left: '-10%' } },
    { color: 'gold', opacity: 0.1, size: 600, blur: 120, position: { bottom: '-10%', right: '-10%' } },
  ],
  /** 대기 `waiting/page.tsx:1127-1130`·404 — 520 · blur 120. */
  waiting: [
    { color: 'sunset-1', opacity: 0.1, size: 520, blur: 120, position: { top: '-20%', left: '-10%' } },
    { color: 'gold', opacity: 0.1, size: 520, blur: 120, position: { bottom: '-10%', right: '-10%' } },
  ],
} as const;

export type GlowPresetName = keyof typeof GLOW_PRESETS;
