// 로그인 직후 어디로 보낼지 정한다.
//
// 이메일 로그인(`/login`)과 소셜 로그인(`/auth/callback`)이 서로 다른 자리에서 이동을
// 처리하므로, 규칙이 갈라지지 않게 여기 한 곳에 둔다.
//
// 규칙은 세 가지뿐이다:
//   1. `?next=` 가 있으면 무조건 그곳 — 사용자가(또는 권한 화면이) 명시적으로 요청한 목적지다.
//      예: `/merchant` 에서 튕겨 나와 `/login?next=/merchant` 로 온 경우.
//   2. 공모전 심사용 사장님 계정(lib/judgeAccounts.ts)은 사장님 콘솔로 보낸다.
//   3. 없으면 역할을 보고 정한다. **admin 만** 관제 대시보드로 보낸다.
//
// admin 만 보내는 이유: 관리자 계정은 관광객 앱을 쓸 일이 없다(관제 전용 계정).
// 반면 사장님은 관광객 앱도 쓴다 — 계획서 §9-5 가 "역할별 홈 강제 리다이렉트는 하지 않는다"
// 로 확정한 근거가 그것이라, merchant 는 지금처럼 `/main` 으로 둔다.
// 예외는 심사용 사장님 계정 하나다(2026-10-06 PM 결정 4.4a). 심사위원은 기능 5(사장님 콘솔)를 보러
// 그 계정으로 로그인하는데, `/main` 에 떨어지면 콘솔이 없는 것처럼 읽혔다. 다른 사장님은 그대로다.
// developer 도 `/main` 이다. 개발 중 관광객 화면을 가장 많이 보는 계정이라 강제 이동이 방해된다.
//
// 실패하면 조용히 `/main` 이다. 역할 조회가 안 됐다고 로그인 자체를 막을 이유는 없다.

import { apiClient } from '@/lib/api-client';
import { parseAccount, type AccountRole } from '@/lib/accountRoles';
import { JUDGE_ACCOUNTS } from '@/lib/judgeAccounts';
import { MERCHANT_CONSOLE_PATH } from '@/lib/consoleLinks';

export const DEFAULT_LOGIN_DEST = '/main';
export const ADMIN_HOME = '/admin/dashboard';
export const MERCHANT_HOME = MERCHANT_CONSOLE_PATH;

/** 로그인 폼에 친 이메일이 심사용 사장님 계정인가(대소문자·앞뒤 공백 무시). */
function isJudgeMerchantEmail(email: string | null | undefined): boolean {
  return !!email && email.trim().toLowerCase() === JUDGE_ACCOUNTS.merchant;
}

/**
 * 판정 규칙(순수). resolvePostLoginDest 가 역할 조회 결과를 넣어 부른다 — 테스트는 이걸 직접 부른다.
 *
 * @param role 조회한 역할. 조회 전이거나 실패했으면 null.
 */
export function decidePostLoginDest(
  explicitNext: string | null,
  email: string | null | undefined,
  role: AccountRole | null,
  fallback: string = DEFAULT_LOGIN_DEST,
): string {
  if (explicitNext) return explicitNext;
  if (isJudgeMerchantEmail(email)) return MERCHANT_HOME;
  if (role === 'admin') return ADMIN_HOME;
  return fallback;
}

/**
 * 로그인 직후 이동할 경로.
 *
 * @param explicitNext `?next=` 로 들어온 목적지(이미 safeNext 로 검증된 값). 있으면 그대로 쓴다.
 * @param fallback     역할이 특별하지 않을 때의 기본 목적지(기본 `/main`).
 * @param email        이메일 로그인에서 친 주소(소셜 로그인은 넘기지 않는다).
 */
export async function resolvePostLoginDest(
  explicitNext: string | null,
  fallback: string = DEFAULT_LOGIN_DEST,
  email: string | null = null,
): Promise<string> {
  // 명시 목적지·심사용 사장님 계정은 역할과 무관하다 — 조회 없이 정한다(콘솔 관문이 다시 판정한다).
  if (explicitNext || isJudgeMerchantEmail(email)) return decidePostLoginDest(explicitNext, email, null, fallback);
  let role: AccountRole | null = null;
  try {
    role = parseAccount(await apiClient.get('/api/v1/account/me')).role;
  } catch {
    // 세션이 아직 안 잡혔거나 백엔드가 흔들린 경우 — 기본 목적지로 보낸다.
  }
  return decidePostLoginDest(null, email, role, fallback);
}
