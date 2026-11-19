// 콜백이 받은 결과로 다음에 할 일을 정한다 — 순수 모듈(테스트: callbackDecision.test.ts).
//
// 웹 원본: apps/web/app/auth/callback/page.tsx 의 오류 분기(identity_already_exists 자동 재시도) (기준 커밋 0d145a1)
// 바꾼 것:
//   · provider·retry 를 딥링크 쿼리가 아니라 기기에 적어 둔 '진행 중 흐름'에서 읽는다(딥링크는 다른 앱도 보낼 수 있다).
//   · 재시도는 그 플랫폼에서 허용된 공급자일 때만(socialPolicy) — iOS 에서는 어떤 경우에도 OAuth 를 다시 열지 않는다.
//   · 진행 중 흐름이 없거나(앱이 시작하지 않은 딥링크), 결과가 흐름 시작보다 오래됐으면 교환하지 않는다.
import type { AuthCallbackParams } from './redirect';
import { isIdentityLinkingAllowed, isSocialLoginAllowed, type OAuthProvider, type PlatformOS } from './socialPolicy';

export interface PendingFlowLike {
  provider: OAuthProvider;
  /** 이미 identity_already_exists 폴백 로그인인가(웹 retry=1). */
  retry: boolean;
  startedAt: number;
}

export type CallbackAction =
  /** code 를 교환한다. */
  | { kind: 'exchange'; code: string }
  /** 같은 공급자로 로그인(계정 전환)을 한 번 더 연다. */
  | { kind: 'retry_sign_in'; provider: OAuthProvider }
  /** 실패 안내. reason 이 화면 문구를 고른다. */
  | { kind: 'fail'; reason: 'no_pending' | 'stale' | 'already_linked' | 'provider_error' | 'no_code' };

export function decideCallbackAction(input: {
  params: AuthCallbackParams | null;
  receivedAt: number | null;
  pending: PendingFlowLike | null;
  os: PlatformOS;
  /** 계정 연결 폴백을 켤지. 기본은 socialPolicy.isIdentityLinkingAllowed(os)(v1 은 false). 테스트가 규칙을 확인하려고 켠다. */
  identityLinking?: boolean;
}): CallbackAction {
  const { params, receivedAt, pending, os } = input;
  const linking = input.identityLinking ?? isIdentityLinkingAllowed(os);
  if (!pending) return { kind: 'fail', reason: 'no_pending' };
  if (!params || receivedAt === null) return { kind: 'fail', reason: 'no_code' };
  // 흐름을 시작하기 전에 들어와 고여 있던 딥링크는 이 흐름의 결과가 아니다.
  if (receivedAt < pending.startedAt) return { kind: 'fail', reason: 'stale' };

  if (params.error || params.errorCode || params.errorDescription) {
    if (params.errorCode === 'identity_already_exists') {
      // 이 오류는 계정 연결(linkIdentity)에서만 난다. v1 은 연결을 쓰지 않으므로(isIdentityLinkingAllowed false)
      // 이 오류가 왔다면 주입된 링크다 — 브라우저를 저절로 다시 열지 않는다. 연결을 켜는 버전에서 이 분기가 산다.
      if (!pending.retry && linking && isSocialLoginAllowed(os, pending.provider)) {
        return { kind: 'retry_sign_in', provider: pending.provider };
      }
      return { kind: 'fail', reason: 'already_linked' };
    }
    return { kind: 'fail', reason: 'provider_error' };
  }
  if (params.code) return { kind: 'exchange', code: params.code };
  return { kind: 'fail', reason: 'no_code' };
}
