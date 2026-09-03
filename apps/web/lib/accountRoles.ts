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

/**
 * `GET /api/v1/account/me` 응답을 Account 로 옮긴다.
 *
 * ⚠️ **입력은 raw HTTP 응답이 아니라 `apiClient` 의 출력이다.** 서버는 snake_case 로
 * 내려주지만 `lib/api-client.ts` 의 request() 가 `keysToCamel()` 을 통과시키므로,
 * 여기 도착할 때는 이미 camelCase 다(lib/caseTransform.ts 참고).
 *
 * 서버 응답을 curl 로 찍어 보고 "snake_case 네" 하고 여기를 고치면 **오히려 망가진다** —
 * 실제로 그렇게 고쳤다가 되돌렸다(2026-08-28). 아래 테스트가 raw 응답을 실제 변환기에
 * 통과시킨 뒤 파싱하는 이유가 이것이다: 체인 전체를 잠가야 같은 실수를 다시 안 한다.
 *
 * `data` 가 any 라 컴파일러는 이 어긋남을 잡아 주지 못한다.
 */
export function parseAccount(data: unknown): Account {
  const d = (data ?? {}) as Record<string, unknown>;
  const facilities = Array.isArray(d.ownedFacilities) ? d.ownedFacilities : [];
  return {
    id: String(d.id ?? ''),
    role: normalizeRole(d.role),
    isAnonymous: Boolean(d.isAnonymous),
    nickname: (d.nickname as string | null) ?? null,
    ownedFacilities: facilities.map((raw) => {
      const f = (raw ?? {}) as Record<string, unknown>;
      return { id: String(f.id ?? ''), name: String(f.name ?? ''), type: String(f.type ?? '') };
    }),
    pendingVerification: Boolean(d.pendingVerification),
  };
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

/**
 * 계정 역할 변경을 신청할 수 있는가.
 *
 * `canRequestBusinessVerification` 보다 넓다 — 사장님이 관리자 권한을, 관리자가 사업자
 * 권한을 신청하는 경우가 있어 tourist 로 좁히면 그 사람들에게는 신청 경로가 아예 없다.
 * (기존에는 tourist 에게만 작은 링크 하나가 보였고, 나머지 역할은 문 자체가 없었다.)
 *
 * 제외 대상 둘:
 *   · 게스트 — 승인 대상을 특정할 수 없고 단말을 지우면 권한이 사라진다(서버도 403).
 *   · developer — 신청 대상이 아니다. /dev 콘솔에서 자기 역할을 직접 바꾼다.
 */
export function canRequestRoleChange(account: Account | null): boolean {
  return !!account && !account.isAnonymous && account.role !== 'developer';
}

/**
 * 마이페이지 '역할 변경' 카드의 3상태.
 *   · hidden  — 카드를 아예 그리지 않는다.
 *   · apply   — "신청하기"(아직 낸 신청이 없다).
 *   · pending — "심사중"(낸 신청을 담당자가 보고 있다).
 */
export type RoleRequestEntryState = 'hidden' | 'apply' | 'pending';

/**
 * 역할 변경 카드를 어떤 모습으로 보여 줄지 정한다.
 *
 * 왜 필요했나: `pendingVerification` 은 `/account/me` 가 계속 내려주고 parseAccount 도 읽고
 * 있었는데 **어떤 화면도 쓰지 않았다**. 그래서 신청서를 내고 마이페이지로 돌아온 사용자에게
 * 카드는 여전히 "신청하기" 였고, 자기가 신청했다는 흔적이 앱 어디에도 없었다 — 다시 눌러
 * /account/business 까지 들어가 보기 전에는.
 *
 * `canRequestRoleChange` 를 넓히지 않고 함수를 새로 둔 이유: 그 함수는 '신청 **자격**이
 * 있는가' 하나만 답하고 accountRoles.test.ts 가 그 계약을 잠그고 있다. 자격과 표시 상태는
 * 다른 질문이다 — 심사중인 사람도 자격은 그대로다(재신청이 아니라 상태 확인을 하러 간다).
 *
 * `status === 'loading'` 은 hidden 이다. 첫 조회 전에는 account 가 null 이라 게스트와
 * 구분되지 않는데, 그때 카드를 그리면 조회가 끝나는 순간 사라지거나(게스트) 문구가
 * 신청하기→심사중으로 바뀌며 깜빡인다. 로딩 중에는 아무것도 약속하지 않는 편이 낫다.
 *
 * status === 'error' 를 따로 막지 않는 이유: resolveRefreshFailure 가 일시적 실패에서는
 * 알던 계정을 유지하고 status 를 'ready' 로 되돌린다. 그래서 여기 도달하는 'error' 는
 * account 가 null 인 경우뿐이고, 그건 canRequestRoleChange 가 이미 걸러 낸다.
 */
export function roleRequestEntryState(
  account: Account | null,
  status: AccountStatus,
): RoleRequestEntryState {
  if (status === 'loading') return 'hidden';
  // 자격 판정은 단일 출처를 그대로 쓴다 — 게스트·developer 는 pendingVerification 이 무슨
  // 값이든 hidden 이다(서버가 그런 조합을 내려줄 일은 없지만, 응답이 오염돼도 문이 열리면 안 된다).
  if (!account || !canRequestRoleChange(account)) return 'hidden';
  return account.pendingVerification ? 'pending' : 'apply';
}

/** 계정 컨텍스트의 상태. 'loading' 은 첫 조회 전이다. */
export type AccountStatus = 'loading' | 'ready' | 'error';

export interface AccountState {
  account: Account | null;
  status: AccountStatus;
}

/**
 * 프로필 조회가 실패했을 때 컨텍스트가 취할 상태.
 *
 * 예전에는 **모든** 실패를 `account = null` 로 처리했다. 그런데 null 은 '게스트' 와 같은
 * 값이라, 타임아웃 한 번이 곧 "로그인 안 한 사람" 이 됐다. 그리고 이 값은 루트 레이아웃
 * 프로바이더의 메모리 상태이고 화면 이동으로는 다시 조회하지 않으므로, 한 번 null 이 되면
 * 새로고침 전까지 그대로다 — 마이페이지의 역할 변경 신청 버튼이 "한 번 들어갔다 나오면
 * 사라진다" 던 증상이 이것이다(2026-09-02). 백엔드가 Render 무료 플랜이라 콜드 스타트로
 * 10초 타임아웃이 나는 일이 드물지 않다.
 *
 * 그래서 401 만 '계정이 없다' 로 읽는다. 나머지(타임아웃·503·오프라인)는 '지금 못 물어봤다'
 * 이므로 직전에 알던 계정을 유지한다. 이 값은 어차피 UX 용이고, 진짜 차단은 매 요청마다
 * 백엔드가 한다 — 잠깐 낡은 값으로 버튼을 보여 주는 쪽의 손해가 더 작다.
 */
export function resolveRefreshFailure(
  previous: Account | null,
  isAuthFailure: boolean,
): AccountState {
  if (isAuthFailure) return { account: null, status: 'error' };
  if (previous) return { account: previous, status: 'ready' };
  return { account: null, status: 'error' };
}
