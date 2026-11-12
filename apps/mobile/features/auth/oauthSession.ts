// 소셜 로그인(OAuth) 시작 — 앱에서 signInWithOAuth 를 부르는 **유일한** 곳(socialPolicy.test.ts 가 잠근다).
//
// 웹 원본: apps/web/lib/auth.ts 의 signInOAuth (기준 커밋 0d145a1)
// 순서(계획 §7.2, Supabase 네이티브 딥링크 안내 + PKCE):
//   1. 플랫폼 규칙 확인 — iOS·카카오는 여기서도 막는다(화면이 버튼을 숨기는 것과 별개로 두 겹).
//   2. 받은편지함을 비우고, 게스트 토큰을 잡아 둔다(계정 전환 뒤 서버가 게스트 데이터를 옮긴다).
//   3. signInWithOAuth(redirectTo nextspot://auth/callback, skipBrowserRedirect) → 공급자 주소 + PKCE flowId.
//   4. 진행 중 흐름을 기기에 적는다(pendingFlow — 프로세스가 정리돼도 콜백이 이어받는다).
//   5. WebBrowser.openAuthSessionAsync 로 연다. 결과 url 은 받은편지함에 넣기만 한다 — **여기서 교환하지 않는다.**
//      교환은 콜백 라우트(callbackFlow) 한 곳의 몫이다.
//   6. 안드로이드는 결과가 dismiss 로 먼저 와도 뒤따르는 딥링크를 잠깐 기다린다(WebBrowser 의 AppState 경주).
// 돌려주는 값: 'delivered' 면 호출부가 router.replace('/auth/callback') 한다.
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { captureGuestSession, discardCapturedGuestData } from '~/lib/core/guestMerge';
import { createPublicClient } from '~/lib/core/supabase';

import { resetCallbackProcessor } from './callbackFlow';
import { authCallbackInbox, waitForCallback } from './callbackInbox';
import { clearPendingFlow, writePendingFlow } from './pendingFlow';
import { AUTH_CALLBACK_URL } from './redirect';
import { isSocialLoginAllowed, type OAuthProvider } from './socialPolicy';

/** 안드로이드에서 WebBrowser 가 성공이 아닌 결과로 끝난 뒤 딥링크를 기다리는 시간. */
export const ANDROID_REDIRECT_GRACE_MS = 2500;

export type OAuthSessionResult =
  | { status: 'delivered' }
  | { status: 'cancelled' }
  | { status: 'blocked' }
  | { status: 'error'; error: string };

function store(): Storage | null {
  return (globalThis as { localStorage?: Storage }).localStorage ?? null;
}

let running = false;

/**
 * 소셜 로그인(계정 전환)을 연다. 이 소셜 계정이 처음이면 새 계정이 만들어진다(로그인·가입 통합 — 웹과 같다).
 * @param next 로그인 뒤 목적지(safeAppNext 로 검증한 값) 또는 null.
 * @param retry identity_already_exists 폴백인가(다시 폴백하지 않게 기록한다).
 */
export async function runOAuthSession(
  provider: OAuthProvider,
  next: string | null,
  retry = false,
): Promise<OAuthSessionResult> {
  if (!isSocialLoginAllowed(Platform.OS, provider)) return { status: 'blocked' };
  if (running) return { status: 'error', error: 'oauth session already running' };
  running = true;
  const s = store();
  try {
    authCallbackInbox.clear();
    resetCallbackProcessor();
    const startedAt = Date.now();
    await captureGuestSession();
    const { data, error } = await createPublicClient().auth.signInWithOAuth({
      provider,
      options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true },
    });
    if (error || !data?.url) {
      discardCapturedGuestData();
      return { status: 'error', error: error?.message ?? 'no authorize url' };
    }
    const flowId = (data as { flowId?: string | null }).flowId ?? null;
    writePendingFlow(s, { provider, retry, next, flowId, startedAt });

    let result: WebBrowser.WebBrowserAuthSessionResult;
    try {
      result = await WebBrowser.openAuthSessionAsync(data.url, AUTH_CALLBACK_URL);
    } catch (err) {
      clearPendingFlow(s);
      discardCapturedGuestData();
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
    if (result.type === 'success') authCallbackInbox.deliver(result.url);

    const grace = result.type !== 'success' && Platform.OS === 'android' ? ANDROID_REDIRECT_GRACE_MS : 0;
    const entry = await waitForCallback(authCallbackInbox, startedAt, grace);
    if (entry) return { status: 'delivered' };

    // 사용자가 닫았다 — 흐름을 버린다(게스트 토큰도). 늦게 오는 딥링크는 '흐름 없음' 으로 교환되지 않는다.
    clearPendingFlow(s);
    discardCapturedGuestData();
    return { status: 'cancelled' };
  } catch (err) {
    clearPendingFlow(s);
    discardCapturedGuestData();
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  } finally {
    running = false;
  }
}
