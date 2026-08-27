import type { Session } from '@supabase/supabase-js';
import { createPublicClient } from './supabase';

interface AnonymousAuthClient {
  getSession(): Promise<{ data: { session: Session | null } }>;
  signInAnonymously(): Promise<{
    data: { session: Session | null };
    error: { message: string } | null;
  }>;
}

/**
 * 첫 방문의 익명 로그인과 추천 요청이 경합하지 않도록 앱 전체에서 하나의 Promise를 공유한다.
 * 실패하면 null을 반환해 공개 화면은 계속 동작하되, 존재하지 않는 고정 mock user id는 만들지 않는다.
 */
export function createAnonymousSessionEnsurer(
  getAuth: () => AnonymousAuthClient,
): () => Promise<Session | null> {
  // 익명 세션 "생성 중"인 동안만 공유한다. 완료된 Session 객체를 영구 캐시하면 이메일 로그인이나
  // 로그아웃 뒤에도 과거 uid를 추천 본문에 넣게 되어 현재 JWT uid와 불일치(403)가 발생한다.
  let sessionPromise: Promise<Session | null> | null = null;

  return function ensureSession(): Promise<Session | null> {
    if (sessionPromise) return sessionPromise;

    const pending = (async () => {
      try {
        const auth = getAuth();
        const current = await auth.getSession();
        if (current.data.session) return current.data.session;

        const signedIn = await auth.signInAnonymously();
        if (signedIn.error) {
          console.warn('[auth] 익명 세션을 만들지 못했습니다.', signedIn.error.message);
          return null;
        }
        return signedIn.data.session;
      } catch (error) {
        console.warn('[auth] 익명 세션 준비 중 오류가 발생했습니다.', error);
        return null;
      }
    })();

    sessionPromise = pending;
    void pending.finally(() => {
      // 이 호출이 끝난 뒤에는 다음 호출이 Supabase의 최신 세션을 다시 읽게 한다.
      if (sessionPromise === pending) sessionPromise = null;
    });

    return pending;
  };
}

export const ensureAnonymousSession = createAnonymousSessionEnsurer(
  () => createPublicClient().auth as AnonymousAuthClient,
);
