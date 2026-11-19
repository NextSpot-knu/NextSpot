// 앱 안 이벤트 — 웹이 window.dispatchEvent(new CustomEvent(...)) 로 하던 알림의 대역.
//
// RN 에는 window 이벤트가 없다(window 는 있지만 dispatchEvent·CustomEvent 가 없다). 그래서 이름과 detail 타입을
// 한곳에 묶은 작은 이미터를 둔다. 리스너 예외는 다른 리스너·보내는 쪽을 막지 않는다(웹의 try/catch 와 같은 원칙 —
// 알림은 주 기능을 방해하지 않는다).

/** 웹 api-client 의 LlmDebugDetail('nextspot:llm-debug'). */
export type LlmDebugDetail =
  | { feature: 'voice' | 'lab'; status: string }
  | { feature: 'reason'; llmCount: number; templateCount: number };

/** 웹 recommendationOutcomes 의 CrowdAnswerDetail('nextspot:crowd-answer'). */
export interface CrowdAnswerDetail {
  recommendationId: string;
  crowdAnswer: string | null;
}

export interface AppEventMap {
  'llm-debug': LlmDebugDetail;
  'crowd-answer': CrowdAnswerDetail;
}

export type Listener<T> = (detail: T) => void;

export interface TypedEmitter<M> {
  on<K extends keyof M>(name: K, listener: Listener<M[K]>): () => void;
  off<K extends keyof M>(name: K, listener: Listener<M[K]>): void;
  emit<K extends keyof M>(name: K, detail: M[K]): void;
  listenerCount<K extends keyof M>(name: K): number;
}

export function createEmitter<M>(): TypedEmitter<M> {
  const listeners = new Map<keyof M, Set<Listener<never>>>();
  const setFor = (name: keyof M) => {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    return set;
  };
  const emitter: TypedEmitter<M> = {
    on(name, listener) {
      setFor(name).add(listener as Listener<never>);
      // 구조 분해해 써도 끊기게 this 대신 emitter 를 잡는다.
      return () => emitter.off(name, listener);
    },
    off(name, listener) {
      listeners.get(name)?.delete(listener as Listener<never>);
    },
    emit(name, detail) {
      const set = listeners.get(name);
      if (!set) return;
      // 복사본을 돈다 — 리스너가 자기 자신을 끊어도 이번 회차는 끝까지 돈다.
      for (const listener of [...set]) {
        try {
          (listener as Listener<typeof detail>)(detail);
        } catch (err) {
          console.warn(`[events] '${String(name)}' 리스너 오류 — 무시합니다.`, err);
        }
      }
    },
    listenerCount(name) {
      return listeners.get(name)?.size ?? 0;
    },
  };
  return emitter;
}

/** 앱 전역 이벤트 버스. */
export const appEvents: TypedEmitter<AppEventMap> = createEmitter<AppEventMap>();
