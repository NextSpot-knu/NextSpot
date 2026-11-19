// confirmDestructive 의 약속 관리 — react-native 를 import 하지 않는 순수 모듈(confirmToastCore.test.ts 가 잠근다).
//
// 확인 토스트 하나는 한 번만 답한다: 행동 = true, 취소 · 밀어 닫기 · 시간 초과 · 같은 id 의 새 확인으로 밀려남 = false.
// sonner-native 0.27 은 행동·취소·onDismiss·onAutoClose 가 한 토스트에서 여러 번 이어 불릴 수 있다(행동 뒤 dismiss →
// onAutoClose). 처음 온 답만 쓰고 나머지는 버린다.

export type ConfirmResolver = (value: boolean) => void;

/** sonner-native ENTERING_ANIMATION_DURATION — 라이브러리 시간 초과는 duration 에 이것을 더해 잰다. */
export const CONFIRM_ENTER_MS = 300;
/** 예비 타이머 여유 — 라이브러리 시간 초과(onAutoClose)가 먼저 오게. */
export const CONFIRM_FALLBACK_SLACK_MS = 500;
/** 화면 읽기 사용자: 시간 제한은 없지만, 이 안에 그려지지 않으면(채널 Toaster 없음) false 로 끝낸다. */
export const CONFIRM_SHOW_DEADLINE_MS = 3000;

export type ConfirmPlan = {
  /** sonner-native 에 줄 duration — 화면 읽기 사용자는 Infinity(시간 제한 없음). */
  toastDuration: number;
  /**
   * JS 예비 타이머(ms). 이름 붙은 채널은 Toaster 가 붙기 전까지 라이브러리 시간 초과가 돌지 않으므로(토스트가 큐에서 기다림),
   * 그려지지 않은 채 이만큼 지나면 false 로 끝내고 토스트를 치운다. 그려지면(onShown) 끈다 — 그 뒤 시간 초과는 라이브러리가
   * 맡고(쌓임을 펼쳐 멈춘 동안은 기다린다), Toaster 해제로 버려지는 것은 onGone 이 맡는다.
   */
  fallbackMs: number;
  /** 그려지면 읽기 화면 초점을 토스트로 옮긴다. */
  focus: boolean;
};

/** 확인 토스트의 시간·초점 결정(WCAG 2.2.1 — 화면 읽기 사용자에게 시간 제한을 두지 않는다). */
export function confirmPlan({ duration, screenReader }: { duration: number; screenReader: boolean }): ConfirmPlan {
  if (screenReader) {
    return { toastDuration: Infinity, fallbackMs: CONFIRM_SHOW_DEADLINE_MS + CONFIRM_ENTER_MS + CONFIRM_FALLBACK_SLACK_MS, focus: true };
  }
  return { toastDuration: duration, fallbackMs: duration + CONFIRM_ENTER_MS + CONFIRM_FALLBACK_SLACK_MS, focus: false };
}

export type ConfirmRegistry = {
  /** id 의 확인을 시작한다. 같은 id 로 아직 답하지 않은 확인이 있으면 그것은 false 로 끝낸다. */
  open: (id: string, resolve: ConfirmResolver) => void;
  /** id 의 확인에 답한다. 이미 답했거나 없는 id 면 아무것도 하지 않는다. 답했으면 true 를 돌려준다. */
  settle: (id: string, value: boolean, resolve?: ConfirmResolver) => boolean;
  /** 답을 기다리는 id 수(테스트용). */
  pending: () => number;
};

export function createConfirmRegistry(): ConfirmRegistry {
  const waiting = new Map<string, ConfirmResolver>();
  return {
    open(id, resolve) {
      const previous = waiting.get(id);
      waiting.set(id, resolve);
      previous?.(false);
    },
    settle(id, value, resolve) {
      const current = waiting.get(id);
      // 같은 id 의 새 확인이 들어온 뒤 옛 토스트의 늦은 콜백(onAutoClose 등)은 새 확인에 답하지 않는다.
      if (!current || (resolve && current !== resolve)) return false;
      waiting.delete(id);
      current(value);
      return true;
    },
    pending: () => waiting.size,
  };
}
