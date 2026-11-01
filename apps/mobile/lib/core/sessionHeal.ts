// 익명 세션 자가 회복 스케줄러 — 순수(RN 을 import 하지 않는다. 시계·앱 상태를 주입받는다).
//
// 웹 원본: apps/web/components/shell/SessionBootstrap.tsx 의 armHeal·heal·onVisible (기준 커밋 e07ea61)
// 바꾼 것: document.visibilityState·visibilitychange → 앱 상태(AppState 'active'). 그리고 앱이 앞으로 돌아오면
//          재시도 창이 이미 지났을 때 타이머를 기다리지 않고 바로 묻는다(계획 §7.1 '앱 활성 상태로 재시도').
//
// 규칙: 익명 로그인이 거절되면 다음 창(anonymousSessionCore BACKOFF_MS, 최소 1초)에 맞춰 한 번 더 묻는다. 배경에서는
// 묻지 않고 앞으로 돌아올 때까지 기다린다. 성공하면 supabase-js 가 SIGNED_IN 을 내고 화면들이 다시 불러온다.

export interface HealDeps {
  /** 세션을 보장한다(실패면 null). */
  ensure: () => Promise<unknown | null>;
  /** 다음 시도까지 남은 ms. */
  retryInMs: () => number;
  /** 지금 앱이 앞에 있는가. */
  isActive: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface HealScheduler {
  /** 세션이 없을 때 부른다 — 다음 창에 한 번 묻도록 건다(이미 걸려 있으면 아무것도 안 한다). */
  arm(): void;
  /** 앱이 앞으로 왔을 때 부른다. */
  onActive(): void;
  /** 걸린 타이머가 있거나 앞으로 오기를 기다리는 중인가. */
  pending(): boolean;
  dispose(): void;
}

export const MIN_HEAL_DELAY_MS = 1000;

export function createHealScheduler(deps: HealDeps): HealScheduler {
  let disposed = false;
  let timer: unknown = null;
  let waitingForActive = false;

  const heal = async () => {
    if (disposed) return;
    const session = await deps.ensure();
    if (disposed) return;
    if (!session) arm();
  };

  function arm(): void {
    if (disposed || timer !== null || waitingForActive) return;
    timer = deps.setTimer(() => {
      timer = null;
      if (!deps.isActive()) {
        waitingForActive = true;
        return;
      }
      void heal();
    }, Math.max(MIN_HEAL_DELAY_MS, deps.retryInMs()));
  }

  return {
    arm,
    onActive() {
      if (disposed) return;
      if (waitingForActive) {
        waitingForActive = false;
        void heal();
        return;
      }
      // 배경에 있는 동안 창이 지났으면 타이머를 기다리지 않는다.
      if (timer !== null && deps.retryInMs() === 0) {
        deps.clearTimer(timer);
        timer = null;
        void heal();
      }
    },
    pending: () => timer !== null || waitingForActive,
    dispose() {
      disposed = true;
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
      waitingForActive = false;
    },
  };
}
