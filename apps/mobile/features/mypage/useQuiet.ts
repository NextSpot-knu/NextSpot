// 조용한 조회 — 마이페이지 카드·배지용. 값이 없거나 실패·401 이면 null 로 두어 카드·배지를 아예 그리지 않는다(가짜 숫자 금지).
// 화면이 다시 앞으로 올 때마다 다시 읽고(하위 화면에서 돌아온 뒤 배지 갱신), 그동안 이전 값을 지우지 않는다.
// 첫 실패는 익명 세션 부트스트랩 경합일 수 있어 2.5초 뒤 한 번만 더(401 은 재시도 없음).
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import { isAuthError } from '~/lib/core/apiClient';

import { SESSION_RACE_RETRY_MS } from './useRemote';

export function useQuiet<T>(fetcher: () => Promise<T>): T | null {
  const [value, setValue] = useState<T | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const run = async (allowRetry: boolean) => {
        try {
          const next = await fetcherRef.current();
          if (alive) setValue(next);
        } catch (err) {
          if (!alive || isAuthError(err)) return;
          if (allowRetry) timer = setTimeout(() => { void run(false); }, SESSION_RACE_RETRY_MS);
        }
      };
      void run(true);
      return () => {
        alive = false;
        if (timer !== null) clearTimeout(timer);
      };
    }, []),
  );
  return value;
}
