// 역할 판정 규칙 — 순수 함수만 모은다.
//
// account.tsx 안에 있던 것을 여기로 뺐다. 그 파일은 React 컨텍스트라 import 만 해도
// React·api-client·supabase 가 딸려 오고, 그래서 **앱 전체 권한 분기의 근거인 이 규칙들에
// 테스트를 붙일 수 없었다**. 여기는 의존성이 없어 tsx 로 바로 돌릴 수 있다
// (lib/oauthFlow.ts 를 auth.ts 에서 빼낸 것과 같은 이유).
//
// ⚠️ 이 판정은 **UX 용**이다. 보안 경계는 언제나 백엔드다 — 브라우저에서 이 값을 조작해도
//    API 는 users.role + facility_owners 로 매 요청 막는다(apps/api/app/core/authz.py).
//    여기 규칙과 authz.py 의 규칙이 어긋나면, 진입은 되는데 모든 요청이 403 나는
//    막다른 화면이 생긴다. 둘을 같이 고쳐야 한다.

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

export const VALID_ROLES: AccountRole[] = ['tourist', 'merchant', 'admin', 'developer'];

/** 모르는 값은 최소 권한으로 떨어뜨린다(서버와 같은 fail-closed 방향). */
export function normalizeRole(value: unknown): AccountRole {
  return VALID_ROLES.includes(value as AccountRole) ? (value as AccountRole) : 'tourist';
}

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
