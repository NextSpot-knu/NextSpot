// confirmDestructive 의 약속 관리 — react-native 를 import 하지 않는 순수 모듈(confirmToastCore.test.ts 가 잠근다).
//
// 확인 토스트 하나는 한 번만 답한다: 행동 = true, 취소 · 밀어 닫기 · 시간 초과 · 같은 id 의 새 확인으로 밀려남 = false.
// sonner-native 0.27 은 행동·취소·onDismiss·onAutoClose 가 한 토스트에서 여러 번 이어 불릴 수 있다(행동 뒤 dismiss →
// onAutoClose). 처음 온 답만 쓰고 나머지는 버린다.

export type ConfirmResolver = (value: boolean) => void;

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
