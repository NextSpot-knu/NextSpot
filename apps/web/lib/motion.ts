import type { Transition } from 'framer-motion';

// 관광객 화면의 공통 모션 문법. 짧고 단단한 스프링을 써서 입력과 결과 사이의
// 지연감을 줄이고, 페이지마다 제각각인 easing/duration 값이 생기지 않게 한다.
export const interactionSpring: Transition = {
  type: 'spring',
  stiffness: 460,
  damping: 34,
  mass: 0.72,
};

export const sheetSpring: Transition = {
  type: 'spring',
  stiffness: 380,
  damping: 32,
  mass: 0.82,
};

export const tapMotion = { scale: 0.96 } as const;
export const softTapMotion = { scale: 0.98 } as const;

type HapticKind = 'selection' | 'confirm' | 'success';

/** 지원하는 모바일에서만 짧은 촉각 피드백을 준다. 미지원·권한 제한 환경은 조용히 통과한다. */
export function haptic(kind: HapticKind = 'selection'): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  const pattern = kind === 'success' ? [10, 35, 16] : kind === 'confirm' ? 12 : 7;
  navigator.vibrate(pattern);
}
