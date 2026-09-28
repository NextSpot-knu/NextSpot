/**
 * 탭이 보일 때만 도는 폴러 — 관제 화면의 자동 새로고침용. 순수 로직이며 환경(시계·타이머·가시성)은 주입한다.
 *
 * 왜: 잊힌 관제 탭 하나가 시간당 60~180번의 무거운 관리자 GET 을 보냈다. 그 워커(0.5 CPU 한 대)가
 * 관광객의 20~40초짜리 콜드 경로도 함께 맡는다.
 *
 * 규칙
 * - 호출부가 첫 조회를 이미 했다고 보고, 시작 시각을 마지막 실행 시각으로 둔다.
 * - 틱: 실행 중이면 건너뛴다(겹침 방지). 숨은 탭이면 건너뛴다 — 단 keepWhileHidden() 이 참이면 돈다
 *   (안전 경보의 '알림 받기' 는 숨은 탭에서 도는 폴링 자체가 기능이다). 직전 실행이 간격의 절반보다
 *   가까우면 건너뛴다(탭 복귀로 방금 돌았는데 1초 뒤 틱이 또 도는 것을 막는다).
 * - 탭이 다시 보이면: 마지막 실행이 간격 이상 지났고 실행 중이 아니면 즉시 한 번 돈다.
 * - 실패(reject/throw)는 삼킨다. 오류 백오프는 두지 않는다 — 보이는 화면의 회복이 느려진다.
 */

export interface PollerEnv {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  isHidden(): boolean;
  /** 가시성 변경 구독. 해제 함수를 돌려준다. */
  onVisibilityChange(fn: () => void): () => void;
}

export interface PollerOptions {
  /** 참이면 숨은 탭에서도 계속 돈다. 틱마다 다시 묻는다. */
  keepWhileHidden?: () => boolean;
}

export function browserEnv(): PollerEnv {
  return {
    now: () => Date.now(),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id as number),
    isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    onVisibilityChange: (fn) => {
      document.addEventListener('visibilitychange', fn);
      return () => document.removeEventListener('visibilitychange', fn);
    },
  };
}

export function startVisibilityPoller(
  run: () => unknown,
  intervalMs: number,
  options: PollerOptions = {},
  env: PollerEnv = browserEnv(),
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
