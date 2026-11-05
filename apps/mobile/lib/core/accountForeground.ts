// 앱이 다시 앞으로 왔을 때 계정(/account/me)을 다시 물을지 — 순수 판정(테스트: accountForeground.test.ts).
//
// 웹은 탭이 오래 뒤에 있어도 다음 인증 이벤트(SIGNED_IN·TOKEN_REFRESHED)에서 다시 묻는다. 앱은 백그라운드에서 토큰 자동
// 갱신을 멈추므로(lib/core/supabase) 그 이벤트가 늦게 오거나 오지 않는다 — 사이에 웹에서 역할·인증 상태가 바뀌었을 수 있다.
// 그래서 'active' 로 돌아올 때 웹의 SIGNED_IN 규칙(shouldRefreshAccountOnAuthEvent)을 그대로 쓴다: 다른 사용자·익명 여부가
// 바뀌었거나, 인증 심사 중이거나, 직전 성공이 5분보다 오래됐으면 다시 묻는다.
import { shouldRefreshAccountOnAuthEvent, type AccountCheck, type AuthSessionUserLike } from '@/lib/accountRoles';

/**
 * 백그라운드에서 앞으로 돌아왔는가. prev 는 trackAppState 로 기록한 '마지막으로 머문 상태'다.
 * iOS 알림 센터·제어 센터·전화 수신 배너는 active → inactive → active 로 오가는데, 앱을 떠난 것이 아니므로 다시 묻지 않는다.
 */
export function cameToForeground(prev: string | null | undefined, next: string): boolean {
  return next === 'active' && prev === 'background';
}

/** 다음 비교에 쓸 상태 — 'inactive' 는 지나가는 상태라 기록하지 않는다(background → inactive → active 도 앞으로 온 것). */
export function trackAppState(prev: string | null | undefined, next: string): string | null | undefined {
  return next === 'inactive' ? prev : next;
}

export function shouldRefreshAccountOnForeground(
  sessionUser: AuthSessionUserLike | null | undefined,
  last: AccountCheck | null,
  now: number,
): boolean {
  return shouldRefreshAccountOnAuthEvent('SIGNED_IN', sessionUser, last, now);
}
