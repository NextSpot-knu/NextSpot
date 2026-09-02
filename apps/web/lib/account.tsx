'use client';

// 계정 권한 컨텍스트 — 프런트 권한 게이팅의 단일 출처.
//
// 배경: 화면들이 각자 `supabase.from('users')` 를 직조회하며 역할을 추측하면, 판정 규칙이
// 여러 곳으로 흩어지고 서로 어긋난다. GET /api/v1/account/me 한 곳에서만 받아 여기 담는다.
//
// ⚠️ 이 값은 **UX 용**이다. 정적 export 라 미들웨어가 없어 라우트 보호를 서버가 대신 해줄 수
//    없지만, 보안 경계는 언제나 백엔드다 — 이 컨텍스트를 브라우저에서 조작해도 API 는
//    users.role + facility_owners 로 매 요청 막는다(app/core/authz.py).
//
// 익명(게스트) 세션도 정상 응답을 받는다: role='tourist', isAnonymous=true.
// 세션 자체가 없거나 백엔드가 죽어 있으면 status='error' 로 두고 화면은 게스트처럼 동작한다
// (무해 폴백 — 콘솔 진입점만 숨겨지고 관광객 기능은 그대로다).

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
import { apiClient, isAuthError } from '@/lib/api-client';
import { createPublicClient } from '@/lib/supabase';
import {
  parseAccount,
  resolveRefreshFailure,
  type Account,
  type AccountState,
} from './accountRoles';

// 역할 판정 규칙은 lib/accountRoles.ts 에 있다(React 없이 테스트하기 위해 분리).
// 기존 import 경로를 깨지 않도록 여기서 그대로 다시 내보낸다.
export type { AccountRole, AccountStatus, OwnedFacility, Account } from './accountRoles';
export {
  canEnterMerchantConsole,
  canEnterAdminConsole,
  canEnterDevConsole,
  canRequestBusinessVerification,
  canRequestRoleChange,
} from './accountRoles';

interface AccountContextValue {
  account: Account | null;
  /** 'loading' 은 첫 조회 전 — 이때 권한 분기를 확정하면 화면이 깜빡인다. */
  status: 'loading' | 'ready' | 'error';
  refresh: () => Promise<void>;
}

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  // account 와 status 를 한 덩어리로 둔다 — 실패 처리에서 둘을 **같이** 정해야 하는데,
  // 따로 두면 이전 account 를 읽으면서 status 를 바꿀 방법이 없다(resolveRefreshFailure).
  const [state, setState] = useState<AccountState>({ account: null, status: 'loading' });
  // 겹쳐 나간 조회의 구세대 응답이 최신 상태를 덮지 않게 한다(로그인/로그아웃 연타).
  const genRef = useRef(0);
  // 재시도는 한 번만. 콜드 스타트를 넘기려는 것이지 계속 두드리려는 게 아니다.
  const retriedRef = useRef(false);

  const refresh = useCallback(async function run(): Promise<void> {
    const gen = ++genRef.current;
    try {
      const data = await apiClient.get('/api/v1/account/me');
      if (gen !== genRef.current) return;
      retriedRef.current = false;
      setState({ account: parseAccount(data), status: 'ready' });
    } catch (err) {
      if (gen !== genRef.current) return;
      const authFailure = isAuthError(err);
      // 401(세션 없음)은 장애가 아니라 '아직 로그인 전' 이다 — 게스트로 취급한다.
      if (!authFailure) console.warn('[account] 프로필 조회 실패:', err);
      // 실패했다고 알던 계정을 지우지 않는다. 이유는 resolveRefreshFailure 주석 참조.
      setState((prev) => resolveRefreshFailure(prev.account, authFailure));

      // 백엔드가 Render 무료 플랜이라 쉬다 깨는 첫 요청이 10초 타임아웃에 걸리곤 한다.
      // 한 번은 다시 물어본다(마이페이지의 다른 로더들과 같은 2.5초 유예 1회 재시도).
      if (!authFailure && !retriedRef.current) {
        retriedRef.current = true;
        setTimeout(() => {
          void run();
        }, 2500);
      }
    }
  }, []);

  const { account, status } = state;

  useEffect(() => {
    void refresh();
    // 로그인·로그아웃·토큰 갱신 시 역할이 바뀔 수 있다. SessionBootstrap 의 익명 세션이
    // 뒤늦게 잡히는 경우도 여기서 흡수한다.
    //
    // TOKEN_REFRESHED 는 주석이 말하는 '토큰 갱신' 인데 정작 목록에 빠져 있었다. 넣어 두면
    // 조회가 실패한 채로 남았을 때 스스로 회복할 기회가 한 번 더 생긴다(위 1회 재시도 다음).
    const supabase = createPublicClient();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (
        event === 'SIGNED_IN' ||
        event === 'SIGNED_OUT' ||
        event === 'USER_UPDATED' ||
        event === 'TOKEN_REFRESHED'
      ) {
        void refresh();
      }
    });
    return () => subscription?.unsubscribe?.();
  }, [refresh]);

  const value = useMemo<AccountContextValue>(
    () => ({ account, status, refresh }),
    [account, status, refresh],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountContextValue {
  const ctx = useContext(AccountContext);
  // 프로바이더 밖에서 불려도 화면을 깨뜨리지 않는다(관광객 경로는 권한과 무관하게 동작해야 한다).
  return ctx ?? { account: null, status: 'error', refresh: async () => {} };
}
