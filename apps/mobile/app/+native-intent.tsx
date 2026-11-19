// 시스템이 앱에 넘긴 딥링크를 라우터가 처리하기 전에 가로챈다(Expo Router +native-intent, 네이티브 전용).
//
// 인증 복귀(nextspot://auth/callback?code=…)만 다룬다(계획 §7.2 — 안드로이드 이중 교환 방지):
//   · 딥링크 원문은 받은편지함(callbackInbox)에 넣는다. code 가 라우터 경로·기록에 남지 않게 쿼리 없는 경로만 돌려준다.
//   · initial=true(이 링크로 앱이 새로 떴다 — 로그인 중 OS 가 프로세스를 정리한 경우): 기기에 진행 중 OAuth 흐름
//     기록(pendingFlow — 동기 localStorage)이 있을 때만 '/auth/callback' 으로 보낸다. 없으면 남이 연 링크라 '/'.
//   · initial=false(앱이 살아 있다): null 을 돌려 라우터가 **이동하지 않게** 한다. 이 링크는 지금 열려 있는
//     openAuthSessionAsync 흐름의 결과이고, 로그인 화면이 받은편지함을 보고 콜백 화면으로 한 번만 보낸다.
//     (설치된 expo-router 57 의 link/linking.js 는 redirectSystemPath 가 빈 값을 주면 listener 를 부르지 않는다 —
//      문서에는 없는 동작이라 SDK 를 올릴 때 다시 확인한다.)
// 이 파일은 앱 상태를 모른다(Expo 문서). 여기서는 교환하지 않는다. 예외를 던지지 않는다.
import { authCallbackInbox } from '~/features/auth/callbackInbox';
import { readPendingFlow } from '~/features/auth/pendingFlow';
import { AUTH_CALLBACK_ROUTE, isAuthCallbackUrl } from '~/features/auth/redirect';

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  try {
    if (!isAuthCallbackUrl(path)) return path;
    if (initial) {
      // 앱이 시작한 OAuth 흐름이 없는데 이 링크로 앱이 떴다 — 다른 앱·웹페이지가 연 링크다. 받지 않고 홈으로.
      const store = (globalThis as { localStorage?: Storage }).localStorage ?? null;
      if (!readPendingFlow(store, Date.now())) return '/';
      authCallbackInbox.deliver(path);
      return AUTH_CALLBACK_ROUTE;
    }
    authCallbackInbox.deliver(path);
    return null;
  } catch {
    return initial ? '/' : null;
  }
}
