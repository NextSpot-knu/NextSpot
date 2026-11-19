// 서버 조회 훅 — 웹 마이페이지 하위 화면들이 각자 쓰던 '조회 · 401 은 안내 · 첫 실패는 2.5초 뒤 1회 재시도 · 다시 시도' 패턴을 하나로.
// 첫 실패는 익명 세션 부트스트랩이 끝나기 전의 경합일 수 있어 한 번만 조용히 다시 묻는다(그동안 로딩 유지 — 무한 재시도 아님).
import { useCallback, useEffect, useRef, useState } from 'react';

import { isAuthError } from '~/lib/core/apiClient';

export type RemoteState = 'loading' | 'ok' | 'failed' | 'unauthenticated';

export const SESSION_RACE_RETRY_MS = 2500;

export function useRemote<T>(fetcher: () => Promise<T>, options: { retryOnce?: boolean } = {}) {
  const { retryOnce = true } = options;
  const [state, setState] = useState<RemoteState>('loading');
  const [data, setData] = useState<T | null>(null);
  const alive = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async (allowRetry: boolean) => {
    try {
      const next = await fetcherRef.current();
      if (!alive.current) return;
      setData(next);
      setState('ok');
    } catch (err) {
      if (!alive.current) return;
      if (isAuthError(err)) {
        setState('unauthenticated'); // 401 은 서버 장애가 아니다 — 다시 시도해도 같은 결과
        return;
      }
      console.warn('[mypage] 조회 실패', err);
      if (allowRetry && retryOnce) {
        setTimeout(() => { if (alive.current) void load(false); }, SESSION_RACE_RETRY_MS);
        return; // 로딩 유지
      }
      setState('failed');
    }
  }, [retryOnce]);

  useEffect(() => {
    alive.current = true;
    void load(true);
    return () => { alive.current = false; };
  }, [load]);

  const reload = useCallback(() => {
    setState('loading');
    void load(false);
  }, [load]);

  return { state, data, setData, reload };
}
