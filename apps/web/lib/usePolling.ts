import { useEffect, useRef } from 'react';
import { startVisibilityPoller } from '@/lib/visibilityPoller';

/**
 * 탭이 보일 때만 `run` 을 `intervalMs` 마다 부른다(lib/visibilityPoller.ts). 첫 조회는 호출부가 한다.
 * 최신 `run`·`keepWhileHidden` 은 ref 로 읽으므로, 매 렌더 새로 만든 함수를 넘겨도 타이머가 다시
 * 걸리지 않는다 — 폴러는 간격이 바뀔 때만 새로 시작한다.
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
      startVisibilityPoller(() => runRef.current(), intervalMs, {
        keepWhileHidden: () => keepRef.current?.() ?? false,
      }),
    [intervalMs],
  );
}
