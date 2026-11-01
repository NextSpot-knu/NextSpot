// 계정 권한 컨텍스트 — GET /api/v1/account/me 한 곳에서만 받아 담는다(UX 용 — 보안 경계는 언제나 서버).
//
// 웹 원본: apps/web/lib/account.tsx (기준 커밋 e07ea61)
// 바꾼 것: api-client·supabase 를 앱 것(lib/core)으로. 판정 규칙은 웹 순수 모듈 `@/lib/accountRoles` 를 그대로 쓴다.
// 동작은 같다: 서버에 닿지 못하면 2.5s → 5s → 8s 로 세 번까지 다시 묻는다. 401 은 '아직 로그인 전'(게스트 취급).
// 로그인·로그아웃·USER_UPDATED·TOKEN_REFRESHED 에서 다시 묻되, 직전 성공 5분 안의 같은 사용자 SIGNED_IN 은 건너뛴다.
// 앱만: 앱이 다시 앞으로 오면(AppState 'active') 같은 SIGNED_IN 규칙으로 다시 물을지 정하고, 물을 때는 재시도 횟수를
//       새로 센다(accountForeground.ts — 백그라운드에서는 토큰 갱신이 멈춰 인증 이벤트가 오지 않는다).
import { AppState } from 'react-native';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  parseAccount,
  resolveRefreshFailure,
  shouldRefreshAccountOnAuthEvent,
  type Account,
  type AccountCheck,
  type AccountState,
} from '@/lib/accountRoles';

import { cameToForeground, shouldRefreshAccountOnForeground } from './accountForeground';
import { apiClient, isAuthError } from './apiClient';
import { createPublicClient } from './supabase';

export type { AccountRole, AccountStatus, OwnedFacility, Account } from '@/lib/accountRoles';
export {
  canEnterMerchantConsole,
  canEnterAdminConsole,
  canEnterDevConsole,
  canRequestBusinessVerification,
  canRequestRoleChange,
} from '@/lib/accountRoles';

export interface AccountContextValue {
  account: Account | null;
  /** 'loading' 은 첫 조회 전 — 이때 권한 분기를 확정하면 화면이 깜빡인다. */
  status: 'loading' | 'ready' | 'error';
  /** 마지막 조회가 서버에 닿지 못해(타임아웃·5xx) 실패했는가 — '로그인 필요' 대신 '서버 연결 확인 · 다시 시도'. */
  unreachable: boolean;
  refresh: () => Promise<void>;
}

const AccountContext = createContext<AccountContextValue | null>(null);

/** 서버에 닿지 못했을 때의 자동 재시도 간격(ms). */
export const ACCOUNT_RETRY_DELAYS_MS = [2500, 5000, 8000] as const;

export function AccountProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AccountState>({ account: null, status: 'loading' });
  const genRef = useRef(0);
  const retriesRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const [unreachable, setUnreachable] = useState(false);
  const lastCheckRef = useRef<AccountCheck | null>(null);

  const refresh = useCallback(async function run(): Promise<void> {
    const gen = ++genRef.current;
    try {
      const data = await apiClient.get('/api/v1/account/me');
      if (gen !== genRef.current || !mountedRef.current) return;
      const parsed = parseAccount(data);
      lastCheckRef.current = {
        userId: parsed.id,
        isAnonymous: parsed.isAnonymous,
        pendingVerification: parsed.pendingVerification,
        at: Date.now(),
      };
      retriesRef.current = 0;
      setUnreachable(false);
      setState({ account: parsed, status: 'ready' });
    } catch (err) {
      lastCheckRef.current = null;
      if (gen !== genRef.current || !mountedRef.current) return;
      const authFailure = isAuthError(err);
      if (!authFailure) console.warn('[account] 프로필 조회 실패:', err);
      setUnreachable(!authFailure);
      setState((prev) => resolveRefreshFailure(prev.account, authFailure));

      if (!authFailure && retriesRef.current < ACCOUNT_RETRY_DELAYS_MS.length) {
        const delay = ACCOUNT_RETRY_DELAYS_MS[retriesRef.current];
        retriesRef.current += 1;
        if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          void run();
        }, delay);
      }
    }
  }, []);

  const { account, status } = state;

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const { data: { subscription } } = createPublicClient().auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') lastCheckRef.current = null;
      if (
        (event === 'SIGNED_IN' ||
          event === 'SIGNED_OUT' ||
          event === 'USER_UPDATED' ||
          event === 'TOKEN_REFRESHED') &&
        shouldRefreshAccountOnAuthEvent(event, session?.user, lastCheckRef.current, Date.now())
      ) {
        // supabase-js 콜백 안에서 auth 호출(getSession)을 기다리지 않게 한 틱 미룬다.
        setTimeout(() => { void refresh(); }, 0);
      }
    });
    let appState: string = AppState.currentState;
    const appStateSub = AppState.addEventListener('change', (next) => {
      const prev = appState;
      appState = next;
      if (!cameToForeground(prev, next)) return;
      createPublicClient()
        .auth.getSession()
        .then(({ data: { session } }) => {
          if (!mountedRef.current) return;
          if (!shouldRefreshAccountOnForeground(session?.user, lastCheckRef.current, Date.now())) return;
          // 새로 묻는 것이므로 서버 미도달 재시도도 처음부터(예약된 재시도는 이 조회가 대신한다).
          retriesRef.current = 0;
          if (retryTimerRef.current !== null) {
            clearTimeout(retryTimerRef.current);
            retryTimerRef.current = null;
          }
          void refresh();
        })
        .catch(() => undefined);
    });
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
      subscription?.unsubscribe?.();
      appStateSub.remove();
    };
  }, [refresh]);

  const value = useMemo<AccountContextValue>(
    () => ({ account, status, unreachable, refresh }),
    [account, status, unreachable, refresh],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

/** 프로바이더 밖에서 불려도 화면을 깨뜨리지 않는다. */
export function useAccount(): AccountContextValue {
  const ctx = useContext(AccountContext);
  return ctx ?? { account: null, status: 'error', unreachable: false, refresh: async () => {} };
}
