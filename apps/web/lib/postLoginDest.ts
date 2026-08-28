// 로그인 직후 어디로 보낼지 정한다.
//
// 이메일 로그인(`/login`)과 소셜 로그인(`/auth/callback`)이 서로 다른 자리에서 이동을
// 처리하므로, 규칙이 갈라지지 않게 여기 한 곳에 둔다.
//
// 규칙은 두 가지뿐이다:
//   1. `?next=` 가 있으면 무조건 그곳 — 사용자가(또는 권한 화면이) 명시적으로 요청한 목적지다.
//      예: `/merchant` 에서 튕겨 나와 `/login?next=/merchant` 로 온 경우.
//   2. 없으면 역할을 보고 정한다. **admin 만** 관제 대시보드로 보낸다.
//
// admin 만 보내는 이유: 관리자 계정은 관광객 앱을 쓸 일이 없다(관제 전용 계정).
// 반면 사장님은 관광객 앱도 쓴다 — 계획서 §9-5 가 "역할별 홈 강제 리다이렉트는 하지 않는다"
// 로 확정한 근거가 그것이라, merchant 는 지금처럼 `/main` 으로 둔다.
// developer 도 `/main` 이다. 개발 중 관광객 화면을 가장 많이 보는 계정이라 강제 이동이 방해된다.
//
// 실패하면 조용히 `/main` 이다. 역할 조회가 안 됐다고 로그인 자체를 막을 이유는 없다.

import { apiClient } from '@/lib/api-client';
import { parseAccount } from '@/lib/accountRoles';

export const DEFAULT_LOGIN_DEST = '/main';
export const ADMIN_HOME = '/admin/dashboard';

/**
 * 로그인 직후 이동할 경로.
 *
 * @param explicitNext `?next=` 로 들어온 목적지(이미 safeNext 로 검증된 값). 있으면 그대로 쓴다.
 * @param fallback     역할이 특별하지 않을 때의 기본 목적지(기본 `/main`).
 */
export async function resolvePostLoginDest(
  explicitNext: string | null,
  fallback: string = DEFAULT_LOGIN_DEST,
): Promise<string> {
  if (explicitNext) return explicitNext;
  try {
    const account = parseAccount(await apiClient.get('/api/v1/account/me'));
    if (account.role === 'admin') return ADMIN_HOME;
  } catch {
    // 세션이 아직 안 잡혔거나 백엔드가 흔들린 경우 — 기본 목적지로 보낸다.
  }
  return fallback;
}
