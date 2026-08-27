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

export type AccountRole = 'tourist' | 'merchant' | 'admin' | 'developer';

export interface OwnedFacility {
  id: string;
  name: string;
  type: string;
}

export interface Account {
  id: string;
  role: AccountRole;
  isAnonymous: boolean;
  nickname: string | null;
  ownedFacilities: OwnedFacility[];
  pendingVerification: boolean;
}

interface AccountContextValue {
  account: Account | null;
  /** 'loading' 은 첫 조회 전 — 이때 권한 분기를 확정하면 화면이 깜빡인다. */
  status: 'loading' | 'ready' | 'error';
  refresh: () => Promise<void>;
}

const AccountContext = createContext<AccountContextValue | null>(null);

const VALID_ROLES: AccountRole[] = ['tourist', 'merchant', 'admin', 'developer'];

function normalizeRole(value: unknown): AccountRole {
  // 모르는 값은 최소 권한으로 떨어뜨린다(서버와 같은 fail-closed 방향).
  return VALID_ROLES.includes(value as AccountRole) ? (value as AccountRole) : 'tourist';
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  // 겹쳐 나간 조회의 구세대 응답이 최신 상태를 덮지 않게 한다(로그인/로그아웃 연타).
  const genRef = useRef(0);

  const refresh = useCallback(async () => {
    const gen = ++genRef.current;
    try {
      const data = await apiClient.get('/api/v1/account/me');
      if (gen !== genRef.current) return;
      setAccount({
        id: String(data?.id ?? ''),
        role: normalizeRole(data?.role),
        isAnonymous: Boolean(data?.isAnonymous),
        nickname: data?.nickname ?? null,
        ownedFacilities: Array.isArray(data?.ownedFacilities)
          ? data.ownedFacilities.map((f: OwnedFacility) => ({
              id: String(f.id),
              name: String(f.name ?? ''),
              type: String(f.type ?? ''),
            }))
          : [],
        pendingVerification: Boolean(data?.pendingVerification),
      });
      setStatus('ready');
    } catch (err) {
      if (gen !== genRef.current) return;
      // 401(세션 없음)은 장애가 아니라 '아직 로그인 전' 이다 — 게스트로 취급한다.
      if (!isAuthError(err)) console.warn('[account] 프로필 조회 실패:', err);
      setAccount(null);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void refresh();
    // 로그인·로그아웃·토큰 갱신 시 역할이 바뀔 수 있다. SessionBootstrap 의 익명 세션이
    // 뒤늦게 잡히는 경우도 여기서 흡수한다.
    const supabase = createPublicClient();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
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

// ── 권한 판정 헬퍼 ─────────────────────────────────────────────────────────
// 각 화면이 role 문자열을 직접 비교하지 않게 여기 모은다. 규칙이 바뀌면 한 곳만 고친다.

/** 사장님 콘솔에 들어갈 수 있는가. **admin 은 포함하지 않는다** — 관제와 콘솔은 완전히 분리한다. */
export function canEnterMerchantConsole(account: Account | null): boolean {
  return account?.role === 'merchant' || account?.role === 'developer';
}

/** 관리자 대시보드에 들어갈 수 있는가(developer 는 admin 의 상위집합). */
export function canEnterAdminConsole(account: Account | null): boolean {
  return account?.role === 'admin' || account?.role === 'developer';
}

/** 개발자 콘솔(/dev) — 팀 전용. */
export function canEnterDevConsole(account: Account | null): boolean {
  return account?.role === 'developer';
}

/** 사업자 인증을 신청할 수 있는 상태인가(게스트는 먼저 계정을 만들어야 한다). */
export function canRequestBusinessVerification(account: Account | null): boolean {
  return !!account && !account.isAnonymous && account.role === 'tourist';
}
