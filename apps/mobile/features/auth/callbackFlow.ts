// 콜백 처리기 — 앱 Supabase 클라이언트·저장소에 묶은 하나(모듈 싱글턴). 규칙은 callbackFlowCore.ts.
// exchangeCodeForSession 을 부르는 곳은 앱 전체에서 여기 한 곳뿐이다(socialPolicy.test.ts 가 잠근다).
import { Platform } from 'react-native';

import { discardCapturedGuestData, mergeCapturedGuestData } from '~/lib/core/guestMerge';
import { createPublicClient } from '~/lib/core/supabase';

import { syncProfileFromProvider } from './authService';
import { authCallbackInbox, waitForCallback } from './callbackInbox';
import { createCallbackProcessor, type CallbackResult } from './callbackFlowCore';
import { createCodeExchanger } from './exchangeCore';
import { runOAuthSession } from './oauthSession';
import { clearPendingFlow, readPendingFlow } from './pendingFlow';

export type { CallbackFailure, CallbackResult } from './callbackFlowCore';

function store(): Storage | null {
  return (globalThis as { localStorage?: Storage }).localStorage ?? null;
}

const exchanger = createCodeExchanger(async (code, flowId) => {
  const { error } = await createPublicClient().auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
  return { error };
});

const processor = createCallbackProcessor({
  os: Platform.OS,
  now: () => Date.now(),
  inbox: authCallbackInbox,
  waitForEntry: (since, timeout) => waitForCallback(authCallbackInbox, since, timeout),
  readPending: () => readPendingFlow(store(), Date.now()),
  clearPending: () => clearPendingFlow(store()),
  exchangeOnce: (code, flowId) => exchanger.exchangeOnce(code, flowId),
  retrySignIn: async (provider, next) => {
    // oauthSession ↔ callbackFlow 는 서로를 import 하지만 둘 다 함수 안에서만 부르므로 평가 순서 문제가 없다.
    const r = await runOAuthSession(provider, next, true);
    return r.status === 'delivered';
  },
  mergeGuest: () => mergeCapturedGuestData(),
  discardGuest: () => discardCapturedGuestData(),
  syncProfile: () => syncProfileFromProvider(),
  warn: (message, detail) => console.warn(message, detail),
});

/** 콜백 라우트가 부른다. 여러 번 불려도 처리는 한 번이다. */
export function processAuthCallback(): Promise<CallbackResult> {
  return processor.process();
}

/** 새 OAuth 흐름을 시작할 때 지난 결과 기억을 지운다. */
export function resetCallbackProcessor(): void {
  processor.reset();
}
