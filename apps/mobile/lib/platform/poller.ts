// 보일 때만 도는 폴러 — 웹 apps/web/lib/visibilityPoller.ts 의 startVisibilityPoller(기준 커밋 e07ea61)를 옮겨 적었다.
// 웹 파일은 같은 모듈에 browserEnv()(window.·document.)가 있어 check-shared-imports 가 막는다 — 그래서 import 하지
// 않고, 순수 부분만 바꾸지 않고 옮겼다. 환경은 주입한다(앱은 appState.ts 의 appStateEnv()).
//
// 규칙(웹과 같다)
// - 호출부가 첫 조회를 이미 했다고 보고, 시작 시각을 마지막 실행 시각으로 둔다.
// - 틱: 실행 중이면 건너뛴다. 숨었으면 건너뛴다(keepWhileHidden() 이 참이면 돈다). 직전 실행이 간격의 절반보다
//   가까우면 건너뛴다.
// - 다시 보이면: 마지막 실행이 간격 이상 지났고 실행 중이 아니면 즉시 한 번 돈다.
// - 실패는 삼킨다. 오류 백오프는 두지 않는다.

export interface PollerEnv {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  isHidden(): boolean;
  /** 가시성 변경 구독. 해제 함수를 돌려준다. */
  onVisibilityChange(fn: () => void): () => void;
}

export interface PollerOptions {
  /** 참이면 숨었을 때도 계속 돈다. 틱마다 다시 묻는다. */
  keepWhileHidden?: () => boolean;
}

export function startVisibilityPoller(
  run: () => unknown,
  intervalMs: number,
  options: PollerOptions,
  env: PollerEnv,
): () => void {
  let lastStartedAt = env.now();
  let inFlight = false;
  let stopped = false;

  const start = () => {
    inFlight = true;
    lastStartedAt = env.now();
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(run());
    } catch (err) {
      result = Promise.reject(err);
    }
    result
      .catch(() => {
        /* 실패는 다음 틱이 다시 시도한다 */
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const tick = () => {
    if (stopped || inFlight) return;
    if (env.isHidden() && !(options.keepWhileHidden?.() ?? false)) return;
    if (env.now() - lastStartedAt < intervalMs / 2) return;
    start();
  };

  const onVisibility = () => {
    if (stopped || inFlight || env.isHidden()) return;
    if (env.now() - lastStartedAt >= intervalMs) start();
  };

  const timer = env.setInterval(tick, intervalMs);
  const unsubscribe = env.onVisibilityChange(onVisibility);
  return () => {
    stopped = true;
    env.clearInterval(timer);
    unsubscribe();
  };
}
