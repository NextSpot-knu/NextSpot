// 앱 상태(포그라운드·백그라운드)로 '보이는가' 를 판정하는 폴러 환경과 usePolling 훅.
// 웹 원본(기준 커밋 e07ea61): apps/web/lib/visibilityPoller.ts 의 browserEnv(document.visibilityState),
// apps/web/lib/usePolling.ts. 앱은 AppState 가 'active' 가 아니면 숨은 것으로 본다(iOS 'inactive' 는 앱 전환기·
// 알림 센터처럼 화면을 쓰지 못하는 순간이다).
import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { startVisibilityPoller, type PollerEnv } from './poller';

export type { PollerEnv, PollerOptions } from './poller';
export { startVisibilityPoller } from './poller';

export function isForeground(state: AppStateStatus | null | undefined = AppState.currentState): boolean {
  return state === 'active';
}

export function appStateEnv(): PollerEnv {
  return {
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    isHidden: () => !isForeground(AppState.currentState),
    onVisibilityChange: (fn) => {
      const sub = AppState.addEventListener('change', () => fn());
      return () => sub.remove();
    },
  };
}

/**
 * 앱이 앞에 있을 때만 `run` 을 `intervalMs` 마다 부른다. 첫 조회는 호출부가 한다.
 * 최신 `run`·`keepWhileHidden` 은 ref 로 읽으므로 매 렌더 새 함수를 넘겨도 타이머가 다시 걸리지 않는다(웹과 같다).
 */
export function usePolling(
  run: () => unknown,
  intervalMs: number,
  opts?: { keepWhileHidden?: () => boolean },
): void {
  const runRef = useRef(run);
  const keepRef = useRef(opts?.keepWhileHidden);
  useEffect(() => {
    runRef.current = run;
    keepRef.current = opts?.keepWhileHidden;
  });

  useEffect(
    () =>
      startVisibilityPoller(
        () => runRef.current(),
        intervalMs,
        { keepWhileHidden: () => keepRef.current?.() ?? false },
        appStateEnv(),
      ),
    [intervalMs],
  );
}
