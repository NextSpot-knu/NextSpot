// 앱이 다시 앞으로 왔을 때 계정(/account/me)을 다시 물을지 — 순수 판정(테스트: accountForeground.test.ts).
//
// 웹은 탭이 오래 뒤에 있어도 다음 인증 이벤트(SIGNED_IN·TOKEN_REFRESHED)에서 다시 묻는다. 앱은 백그라운드에서 토큰 자동
// 갱신을 멈추므로(lib/core/supabase) 그 이벤트가 늦게 오거나 오지 않는다 — 사이에 웹에서 역할·인증 상태가 바뀌었을 수 있다.
// 그래서 'active' 로 돌아올 때 웹의 SIGNED_IN 규칙(shouldRefreshAccountOnAuthEvent)을 그대로 쓴다: 다른 사용자·익명 여부가
// 바뀌었거나, 인증 심사 중이거나, 직전 성공이 5분보다 오래됐으면 다시 묻는다.
import { shouldRefreshAccountOnAuthEvent, type AccountCheck, type AuthSessionUserLike } from '@/lib/accountRoles';

/** 이전 앱 상태가 'active' 가 아니었고 지금 'active' 인가(앞으로 돌아옴). */
export function cameToForeground(prev: string | null | undefined, next: string): boolean {
  return next === 'active' && prev !== 'active';
}

export function shouldRefreshAccountOnForeground(
  sessionUser: AuthSessionUserLike | null | undefined,
  last: AccountCheck | null,
  now: number,
): boolean {
  return shouldRefreshAccountOnAuthEvent('SIGNED_IN', sessionUser, last, now);
}
